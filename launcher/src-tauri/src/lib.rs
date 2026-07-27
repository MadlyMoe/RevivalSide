use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

mod tray;

const EVENT_PREFIX: &str = "@@REVIVALSIDE_EVENT@@";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    state: String,
    pid: Option<u32>,
    details: String,
}

#[derive(Clone)]
struct ServiceProcess {
    pid: u32,
    state: String,
    details: String,
}

struct LauncherState {
    app_root: PathBuf,
    services: Arc<Mutex<HashMap<String, ServiceProcess>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    level: String,
    message: String,
}

fn service_snapshot(services: &Arc<Mutex<HashMap<String, ServiceProcess>>>) -> Value {
    let current = services.lock().unwrap();
    let mut result = serde_json::Map::new();
    for name in ["listener", "wiki", "capture"] {
        let status = current.get(name).map_or(
            ServiceStatus {
                state: "stopped".into(),
                pid: None,
                details: String::new(),
            },
            |service| ServiceStatus {
                state: service.state.clone(),
                pid: Some(service.pid),
                details: service.details.clone(),
            },
        );
        result.insert(name.into(), serde_json::to_value(status).unwrap());
    }
    Value::Object(result)
}

fn emit_log(app: &AppHandle, raw: &str) {
    let (level, message) = if let Some(rest) = raw.strip_prefix("[error] ") {
        ("error", rest)
    } else if let Some(rest) = raw.strip_prefix("[warn] ") {
        ("warn", rest)
    } else if let Some(rest) = raw.strip_prefix("[debug] ") {
        ("debug", rest)
    } else if let Some(rest) = raw.strip_prefix("[info] ") {
        ("info", rest)
    } else {
        ("info", raw)
    };
    let _ = app.emit(
        "launcher-log",
        LogEvent {
            level: level.into(),
            message: message.into(),
        },
    );
}

fn emit_services(app: &AppHandle, services: &Arc<Mutex<HashMap<String, ServiceProcess>>>) {
    let _ = app.emit("launcher-services", service_snapshot(services));
}

fn handle_backend_event(
    app: &AppHandle,
    services: &Arc<Mutex<HashMap<String, ServiceProcess>>>,
    pid: u32,
    value: &Value,
) {
    if value.get("type").and_then(Value::as_str) != Some("service") {
        return;
    }
    let Some(service) = value.get("service").and_then(Value::as_str) else {
        return;
    };
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("running")
        .to_string();
    let details = value
        .get("details")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut current = services.lock().unwrap();
    if current.get(service).is_some_and(|item| item.pid == pid) {
        current.insert(
            service.to_string(),
            ServiceProcess {
                pid,
                state,
                details,
            },
        );
    }
    drop(current);
    emit_services(app, services);
}

fn is_app_root(path: &Path) -> bool {
    path.join("cs-listener.js").is_file() && path.join("package.json").is_file()
}

fn resolve_app_root() -> PathBuf {
    if let Ok(configured) = env::var("REVIVALSIDE_ROOT") {
        let candidate = PathBuf::from(configured);
        if is_app_root(&candidate) {
            return candidate;
        }
    }

    let mut seeds = Vec::new();
    if let Ok(current) = env::current_dir() {
        seeds.push(current);
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            seeds.push(parent.to_path_buf());
        }
    }
    for seed in seeds {
        for ancestor in seed.ancestors() {
            if is_app_root(ancestor) {
                return ancestor.to_path_buf();
            }
            let payload_app = ancestor.join("app");
            if is_app_root(&payload_app) {
                return payload_app;
            }
        }
    }
    env::current_dir().unwrap_or_default()
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_value = env::var_os("PATH")?;
    for directory in env::split_paths(&path_value) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_node(app_root: &Path) -> Result<PathBuf, String> {
    let mut candidates = vec![
        app_root.join("runtime").join("node").join("node.exe"),
        app_root.join("runtime").join("node").join("node"),
    ];
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("RevivalSide")
                .join("runtime")
                .join("node")
                .join("node.exe"),
        );
    }
    if let Some(node) = find_on_path(if cfg!(windows) { "node.exe" } else { "node" }) {
        candidates.push(node);
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "Node.js was not found. Install Node.js or use a packaged RevivalSide runtime.".into())
}

fn configure_hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn backend_command(app_root: &Path) -> Result<Command, String> {
    let backend = app_root
        .join("tools")
        .join("revivalside-launcher-backend.js");
    if !backend.is_file() {
        return Err(format!(
            "RevivalSide launcher backend was not found: {}",
            backend.display()
        ));
    }
    let mut command = Command::new(resolve_node(app_root)?);
    command
        .arg(backend)
        .current_dir(app_root)
        .env("REVIVALSIDE_ROOT", app_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden(&mut command);
    Ok(command)
}

fn run_action_sync(
    app: AppHandle,
    app_root: PathBuf,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    const ACTIONS: &[&str] = &[
        "snapshot",
        "save-settings",
        "set-client",
        "detect-client",
        "freeze-client",
        "launch-client",
        "verify-assets",
        "build-cache",
        "set-server-time",
        "clear-server-time",
        "extract-cross-save",
        "refresh-wiki-cache",
        "refresh-cutscene-cache",
    ];
    if !ACTIONS.contains(&action.as_str()) {
        return Err(format!("Unsupported launcher action: {action}"));
    }

    let mut command = backend_command(&app_root)?;
    command.arg(&action);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| error.to_string())?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read launcher backend output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read launcher backend errors.".to_string())?;
    let output_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let output_copy = output_lines.clone();
    let app_for_stdout = app.clone();
    let stdout_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(event) = line.strip_prefix(EVENT_PREFIX) {
                if let Ok(value) = serde_json::from_str::<Value>(event) {
                    let _ = app_for_stdout.emit("launcher-event", value);
                }
            } else if !line.trim().is_empty() {
                output_copy.lock().unwrap().push(line);
            }
        }
    });
    let app_for_stderr = app.clone();
    let stderr_thread = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            emit_log(&app_for_stderr, &line);
        }
    });
    let status = child.wait().map_err(|error| error.to_string())?;
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    let lines = output_lines.lock().unwrap();
    let value = lines
        .iter()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .unwrap_or_else(|| json!({ "ok": false, "error": "Launcher backend returned no result." }));
    if !status.success() || value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Launcher backend action failed.")
            .to_string());
    }
    Ok(value)
}

#[tauri::command]
async fn launcher_snapshot(
    app: AppHandle,
    state: State<'_, LauncherState>,
) -> Result<Value, String> {
    let app_root = state.app_root.clone();
    let services = state.services.clone();
    let mut value = tauri::async_runtime::spawn_blocking(move || {
        run_action_sync(app, app_root, "snapshot".into(), json!({}))
    })
    .await
    .map_err(|error| error.to_string())??;
    value["services"] = service_snapshot(&services);
    Ok(value)
}

#[tauri::command]
async fn run_launcher_action(
    app: AppHandle,
    state: State<'_, LauncherState>,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    if action == "launch-client" {
        let current = state.services.lock().unwrap();
        if current.get("listener").is_none_or(|service| service.state != "running") {
            return Err("Start the RevivalSide listener before launching the frozen client.".into());
        }
    }
    let app_root = state.app_root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_action_sync(app, app_root, action, payload.unwrap_or_else(|| json!({})))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn spawn_service_monitor(
    app: AppHandle,
    services: Arc<Mutex<HashMap<String, ServiceProcess>>>,
    service: String,
    mut child: Child,
) -> Result<u32, String> {
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read service output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read service errors.".to_string())?;

    let app_for_stdout = app.clone();
    let services_for_stdout = services.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(event) = line.strip_prefix(EVENT_PREFIX) {
                if let Ok(value) = serde_json::from_str::<Value>(event) {
                    handle_backend_event(&app_for_stdout, &services_for_stdout, pid, &value);
                    let _ = app_for_stdout.emit("launcher-event", value);
                }
            } else if !line.trim().is_empty() {
                emit_log(&app_for_stdout, &line);
            }
        }
    });
    let app_for_stderr = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            emit_log(&app_for_stderr, &line);
        }
    });

    let app_for_exit = app.clone();
    let services_for_exit = services.clone();
    let service_for_exit = service.clone();
    thread::spawn(move || {
        let status = child.wait();
        let mut current = services_for_exit.lock().unwrap();
        let was_current = current
            .get(&service_for_exit)
            .is_some_and(|item| item.pid == pid);
        let was_stopping = current
            .get(&service_for_exit)
            .is_some_and(|item| item.state == "stopping");
        if was_current {
            current.remove(&service_for_exit);
        }
        drop(current);
        if was_current {
            emit_services(&app_for_exit, &services_for_exit);
            let unexpected = !was_stopping;
            let _ = app_for_exit.emit(
                "launcher-service-stopped",
                json!({
                    "service": service_for_exit,
                    "unexpected": unexpected,
                    "code": status.ok().and_then(|value| value.code()),
                }),
            );
        }
    });
    Ok(pid)
}

#[tauri::command]
async fn start_launcher_service(
    app: AppHandle,
    state: State<'_, LauncherState>,
    service: String,
) -> Result<Value, String> {
    if !["listener", "wiki", "capture"].contains(&service.as_str()) {
        return Err(format!("Unsupported launcher service: {service}"));
    }
    {
        let current = state.services.lock().unwrap();
        if let Some(existing) = current.get(&service) {
            return Ok(json!({ "state": existing.state, "pid": existing.pid }));
        }
    }

    let mut command = backend_command(&state.app_root)?;
    command.arg("service").arg(&service);
    let child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    state.services.lock().unwrap().insert(
        service.clone(),
        ServiceProcess {
            pid,
            state: "starting".into(),
            details: String::new(),
        },
    );
    emit_services(&app, &state.services);
    spawn_service_monitor(app, state.services.clone(), service, child)?;
    Ok(json!({ "state": "starting", "pid": pid }))
}

#[cfg(windows)]
fn stop_process_tree(pid: u32) -> Result<(), String> {
    let mut command = Command::new("taskkill.exe");
    command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    configure_hidden(&mut command);
    let status = command.status().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill failed for PID {pid} with {status}"))
    }
}

#[cfg(not(windows))]
fn stop_process_tree(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("kill failed for PID {pid}")) }
}

#[tauri::command]
fn stop_launcher_service(
    app: AppHandle,
    state: State<'_, LauncherState>,
    service: String,
) -> Result<(), String> {
    let pid = {
        let mut current = state.services.lock().unwrap();
        let Some(process) = current.get_mut(&service) else {
            return Ok(());
        };
        process.state = "stopping".into();
        process.pid
    };
    emit_services(&app, &state.services);
    stop_process_tree(pid)
}

fn stop_all_services(state: &LauncherState) {
    let pids: Vec<u32> = state
        .services
        .lock()
        .unwrap()
        .values()
        .map(|service| service.pid)
        .collect();
    for pid in pids {
        let _ = stop_process_tree(pid);
    }
}

#[tauri::command]
fn close_window(app: AppHandle, behavior: String, state: State<'_, LauncherState>) {
    match behavior.as_str() {
        "tray" | "tray_on_start" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        _ => {
            stop_all_services(&state);
            app.exit(0);
        }
    }
}

#[tauri::command]
fn quit_launcher(app: AppHandle, state: State<'_, LauncherState>) {
    stop_all_services(&state);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = LauncherState {
        app_root: resolve_app_root(),
        services: Arc::new(Mutex::new(HashMap::new())),
    };
    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            tray::setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launcher_snapshot,
            run_launcher_action,
            start_launcher_service,
            stop_launcher_service,
            close_window,
            quit_launcher,
        ])
        .build(tauri::generate_context!())
        .expect("error while building RevivalSide launcher")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<LauncherState>();
                stop_all_services(&state);
            }
        });
}
