package dev.revivalside.capture.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import java.io.BufferedInputStream
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipInputStream
import kotlin.concurrent.thread

class RevivalSideListenerService : Service() {
    private val running = AtomicBoolean(false)
    private var httpServer: LauncherHttpServer? = null
    private var nodeRuntime: NodeProcessRuntime? = null
    private var logFile: File? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startListener()
            ACTION_STOP -> stopListener()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopListener()
        super.onDestroy()
    }

    private fun startListener() {
        if (!running.compareAndSet(false, true)) {
            publishStatus("Listener is already running")
            return
        }

        val settings = RevivalSideSettingsStore.load(this)
        val root = RevivalSideSettingsStore.appRoot(this)
        val logs = RevivalSideSettingsStore.logsDir(this)
        root.mkdirs()
        RevivalSideSettingsStore.serverDataDir(this).mkdirs()
        logs.mkdirs()
        logFile = File(logs, "android-listener.log")

        try {
            startForeground(NOTIFICATION_ID, buildNotification("Starting listener"))
            appendLog("Starting Android listener gamePort=${settings.gamePort} httpPort=${settings.httpPort}")

            nodeRuntime = NodeProcessRuntime(this, settings, ::appendLog).also { runtime ->
                val started = runtime.start()
                if (!started) {
                    httpServer = LauncherHttpServer(
                        context = this,
                        settings = settings,
                        runtimeState = { nodeRuntime?.describeState() ?: "fallback" },
                        log = ::appendLog,
                    ).also { it.start() }
                    appendLog("Embedded Node listener is not running; Android launcher HTTP APIs remain available.")
                }
            }

            publishStatus("Listener online on 127.0.0.1:${settings.httpPort}")
            updateNotification("Listener online")
        } catch (ex: Exception) {
            appendLog("Listener failed: ${ex.message}")
            publishStatus("Listener failed: ${ex.message}")
            stopListener()
        }
    }

    private fun stopListener() {
        if (!running.getAndSet(false)) return
        appendLog("Stopping Android listener")
        nodeRuntime?.stop()
        nodeRuntime = null
        httpServer?.stop()
        httpServer = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        publishStatus("Listener stopped")
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "RevivalSide Listener", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("RevivalSide Listener")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentIntent(intent)
            .setOngoing(true)
            .build()
    }

    private fun appendLog(message: String) {
        val line = "${Instant.now()} $message\n"
        try {
            logFile?.appendText(line, Charsets.UTF_8)
        } catch (_: Exception) {
        }
        publishStatus(message)
    }

    private fun publishStatus(message: String) {
        sendBroadcast(Intent(ACTION_STATUS).apply {
            setPackage(packageName)
            putExtra(EXTRA_MESSAGE, message)
            putExtra(EXTRA_LOG_PATH, logFile?.absolutePath.orEmpty())
        })
    }

    companion object {
        const val CHANNEL_ID = "revivalside_listener"
        const val NOTIFICATION_ID = 6002
        const val ACTION_START = "dev.revivalside.listener.START"
        const val ACTION_STOP = "dev.revivalside.listener.STOP"
        const val ACTION_STATUS = "dev.revivalside.listener.STATUS"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_LOG_PATH = "logPath"
    }
}

private class LauncherHttpServer(
    private val context: Context,
    private val settings: RevivalSideSettings,
    private val runtimeState: () -> String,
    private val log: (String) -> Unit,
) {
    private val running = AtomicBoolean(false)
    private var server: ServerSocket? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), settings.httpPort))
        server = socket
        thread(name = "revivalside-http", isDaemon = true) {
            log("Launcher HTTP API listening on 127.0.0.1:${settings.httpPort}")
            while (running.get()) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    break
                }
                thread(name = "revivalside-http-client", isDaemon = true) {
                    handleClient(client)
                }
            }
        }
    }

    fun stop() {
        running.set(false)
        try {
            server?.close()
        } catch (_: Exception) {
        }
        server = null
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            val input = client.getInputStream().bufferedReader(Charsets.UTF_8)
            val requestLine = input.readLine() ?: return
            val parts = requestLine.split(' ')
            if (parts.size < 2) {
                writeResponse(client, 400, "text/plain; charset=utf-8", "Bad request\n")
                return
            }

            var contentLength = 0
            while (true) {
                val line = input.readLine() ?: return
                if (line.isEmpty()) break
                val separator = line.indexOf(':')
                if (separator > 0 && line.substring(0, separator).equals("content-length", ignoreCase = true)) {
                    contentLength = line.substring(separator + 1).trim().toIntOrNull() ?: 0
                }
            }
            val body = if (contentLength > 0) {
                CharArray(contentLength).also { input.read(it) }.concatToString()
            } else {
                ""
            }

            val method = parts[0]
            val path = runCatching { URI(parts[1]).path }.getOrDefault(parts[1])
            when {
                method == "GET" && path == "/launcher/api/health" -> writeJson(client, healthJson())
                method == "POST" && path == "/launcher/api/server-time/clear" -> {
                    ServerTimeStore.clear(context)
                    writeJson(client, ServerTimeStore.readOrDefault(context))
                }
                path == "/launcher/api/server-time" -> handleServerTime(client, method, body)
                method == "GET" && (path == "/user-manager" || path == "/user-manager/") -> {
                    writeResponse(client, 200, "text/html; charset=utf-8", userManagerHtml())
                }
                method == "POST" && path == "/user-manager/api/reload" -> writeJson(client, """{"ok":true,"android":true}""")
                method == "GET" && path == "/android/api/status" -> writeJson(client, healthJson())
                else -> writeJson(client, """{"error":"Unknown Android launcher route."}""", 404)
            }
        }
    }

    private fun handleServerTime(client: Socket, method: String, body: String) {
        when (method) {
            "GET" -> writeJson(client, ServerTimeStore.readOrDefault(context))
            "POST" -> {
                ServerTimeStore.write(context, body.ifBlank { "{}" })
                writeJson(client, ServerTimeStore.readOrDefault(context))
            }
            else -> {
                if (method == "DELETE") {
                    ServerTimeStore.clear(context)
                    writeJson(client, ServerTimeStore.readOrDefault(context))
                } else {
                    writeJson(client, """{"error":"Method not allowed."}""", 405)
                }
            }
        }
    }

    private fun healthJson(): String {
        return """
            {
              "ok": true,
              "android": true,
              "gamePort": ${settings.gamePort},
              "httpPort": ${settings.httpPort},
              "redirectPorts": "${escapeJson(settings.redirectPortsText)}",
              "targetPackage": "${escapeJson(settings.targetPackage)}",
              "joinLobbyAckMode": "${escapeJson(settings.joinLobbyAckMode)}",
              "runtime": "${escapeJson(runtimeState())}"
            }
        """.trimIndent()
    }

    private fun userManagerHtml(): String {
        return """
            <!doctype html>
            <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <title>RevivalSide Android</title>
              <style>
                body { font-family: sans-serif; margin: 24px; color: #172033; background: #f6f8fa; }
                code, pre { background: white; border: 1px solid #d7dde5; border-radius: 6px; padding: 8px; display: block; overflow: auto; }
                .muted { color: #64748b; }
              </style>
            </head>
            <body>
              <h1>RevivalSide Android</h1>
              <p class="muted">Launcher control API is running on this phone.</p>
              <pre>${escapeHtml(healthJson())}</pre>
            </body>
            </html>
        """.trimIndent()
    }

    private fun writeJson(socket: Socket, json: String, status: Int = 200) {
        writeResponse(socket, status, "application/json; charset=utf-8", json.trim() + "\n")
    }

    private fun writeResponse(socket: Socket, status: Int, contentType: String, body: String) {
        val reason = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            else -> "Error"
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        val header = "HTTP/1.1 $status $reason\r\n" +
            "Content-Type: $contentType\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n" +
            "\r\n"
        val output = socket.getOutputStream()
        output.write(header.toByteArray(Charsets.UTF_8))
        output.write(bytes)
        output.flush()
    }
}

private object ServerTimeStore {
    fun readOrDefault(context: Context): String {
        val file = stateFile(context)
        if (file.isFile) {
            val text = runCatching { file.readText(Charsets.UTF_8) }.getOrDefault("")
            if (text.isNotBlank()) return text
        }
        return """
            {
              "manualTime": null,
              "clockDate": null,
              "serverNow": "${Instant.now()}",
              "source": "android-clock"
            }
        """.trimIndent()
    }

    fun write(context: Context, body: String) {
        val file = stateFile(context)
        file.parentFile?.mkdirs()
        file.writeText(body.trim().ifBlank { "{}" } + "\n", Charsets.UTF_8)
    }

    fun clear(context: Context) {
        runCatching { stateFile(context).delete() }
    }

    private fun stateFile(context: Context): File {
        return File(RevivalSideSettingsStore.serverDataDir(context), "server-time.json")
    }
}

private data class AndroidCombatHostRuntime(
    val project: File,
    val hostCacheDll: File?,
    val managedDir: File?,
    val gameRoot: File?,
    val dotnetRoot: File?,
    val dotnet: File?,
    val enabled: Boolean,
    val statusMessage: String,
)

private class NodeProcessRuntime(
    private val context: Context,
    private val settings: RevivalSideSettings,
    private val log: (String) -> Unit,
) {
    private var process: Process? = null
    private var nativeThread: Thread? = null
    private val running = AtomicBoolean(false)
    private var state: String = "stopped"

    fun start(): Boolean {
        if (!running.compareAndSet(false, true)) return true
        copyPackagedListenerAssets()

        val root = RevivalSideSettingsStore.appRoot(context)
        val entry = listOf(
            File(root, "cs-listener.js"),
            File(root, "server/listener.js"),
        ).firstOrNull { it.isFile }
        if (entry == null) {
            state = "missing-listener-payload"
            running.set(false)
            log("RevivalSide listener payload is missing under ${root.absolutePath}.")
            return false
        }

        val combatHost = resolveCombatHostRuntime(root)
        log(combatHost.statusMessage)

        if (settings.nodePath.isBlank() && NodeMobileBridge.isLoaded()) {
            return startNativeNode(root, entry, combatHost)
        }
        if (settings.nodePath.isBlank() && !NodeMobileBridge.isLoaded()) {
            log("Bundled Node Mobile runtime did not load: ${NodeMobileBridge.loadErrorMessage()}")
        }

        val node = findNodeExecutable()
        if (node == null) {
            state = "missing-node-runtime"
            running.set(false)
            log("No Android Node runtime found. Set a node path or package libnode assets before starting game traffic.")
            return false
        }

        return try {
            val pb = ProcessBuilder(node.absolutePath, entry.absolutePath)
                .directory(root)
                .redirectErrorStream(true)
            val env = pb.environment()
            val dataDir = RevivalSideSettingsStore.serverDataDir(context)
            val gameplayTablesDir = File(root, "gameplay-tables")
            env["CS_PORT"] = settings.gamePort.toString()
            env["CS_HTTP_MIRROR_PORT"] = settings.httpPort.toString()
            env["CS_HTTP_MIRROR_HOST"] = "127.0.0.1"
            env["CS_USER_DB_PATH"] = File(dataDir, "users.json").absolutePath
            env["CS_SERVER_TIME_STATE_PATH"] = File(dataDir, "server-time.json").absolutePath
            env["CS_CAPTURED_FLOW_DIR"] = File(dataDir, "captured-flows").absolutePath
            env["CS_CAPTURED_TCP_DIR"] = File(dataDir, "captured-tcp").absolutePath
            env["CS_CAPTURED_GAME_FLOW_DIR"] = File(dataDir, "captured-game-flow").absolutePath
            env.remove("CS_GAMEPLAY_ASSET_SOURCE")
            env.remove("CS_GAMEPLAY_TABLE_SOURCE")
            env.remove("CS_ANDROID_STANDALONE")
            env["CS_GAMEPLAY_TABLES_DIR"] = gameplayTablesDir.absolutePath
            env["CS_HTTP_MIRROR_BASE_URL"] = "http://127.0.0.1:${settings.httpPort}"
            env["CS_USE_LOCAL_JOIN_LOBBY_ACK"] = settings.joinLobbyAckMode
            env["CS_USER_MANAGER_ALLOW_REMOTE"] = "0"
            env["CS_VERBOSE_CAPTURE"] = "0"
            env["CS_REPLAY_CAPTURED_GAME_FLOW"] = "0"
            env["CS_SKIP_TUTORIAL_TO_WIN"] = "0"
            env["CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN"] = "0"
            env["CS_MANAGED_HOST_TICK_INTERVAL_MS"] = env["CS_MANAGED_HOST_TICK_INTERVAL_MS"] ?: ANDROID_MANAGED_HOST_TICK_INTERVAL_MS
            applyCombatHostEnvironment(env, combatHost)
            process = pb.start()
            state = "running"
            log("Started embedded RevivalSide listener with ${node.absolutePath}")
            startLogReader(process!!)
            true
        } catch (ex: Exception) {
            state = "start-failed"
            running.set(false)
            log("Embedded listener failed to start: ${ex.message}")
            false
        }
    }

    fun stop() {
        running.set(false)
        val active = process
        process = null
        runCatching { active?.destroy() }
        if (nativeThread?.isAlive == true || nativeStarted.get()) {
            state = "native-stopping"
            log("Stopping bundled Node Mobile listener by ending the launcher process, matching the desktop launcher process boundary.")
            thread(name = "revivalside-node-stop", isDaemon = true) {
                Thread.sleep(250)
                android.os.Process.killProcess(android.os.Process.myPid())
            }
        } else {
            state = "stopped"
        }
    }

    fun describeState(): String = state

    private fun startLogReader(active: Process) {
        thread(name = "revivalside-node-log", isDaemon = true) {
            active.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                lines.forEach { line ->
                    if (line.isNotBlank()) log("[node] $line")
                }
            }
            val exitCode = runCatching { active.waitFor() }.getOrDefault(-1)
            if (running.get()) {
                state = "exited-$exitCode"
                running.set(false)
                log("Embedded listener exited with code $exitCode")
            }
        }
    }

    private fun startNativeNode(root: File, entry: File, combatHost: AndroidCombatHostRuntime): Boolean {
        if (!nativeStarted.compareAndSet(false, true)) {
            state = "native-already-running"
            log("Bundled Node Mobile listener is already running in this app process.")
            return true
        }

        val bootstrap = writeBootstrap(root, entry, combatHost)
        state = "native-running"
        nativeThread = thread(name = "revivalside-node-mobile", isDaemon = true) {
            val exitCode = runCatching {
                NodeMobileBridge.startNodeWithArguments(arrayOf("node", bootstrap.absolutePath))
            }.getOrElse { error ->
                state = "native-start-failed"
                running.set(false)
                log("Bundled Node Mobile listener crashed: ${error.message}")
                return@thread
            }
            state = "native-exited-$exitCode"
            running.set(false)
            log("Bundled Node Mobile listener exited with code $exitCode")
        }
        log("Started bundled Node Mobile listener with ${bootstrap.absolutePath}")
        return true
    }

    private fun writeBootstrap(root: File, entry: File, combatHost: AndroidCombatHostRuntime): File {
        val dataDir = RevivalSideSettingsStore.serverDataDir(context)
        val bootstrap = File(root, "android-node-main.js")
        val combatHostDotnetPath = combatHost.dotnet?.absolutePath.orEmpty()
        val combatHostDotnetRootPath = combatHost.dotnetRoot?.absolutePath.orEmpty()
        val combatManagedDirPath = combatHost.managedDir?.absolutePath.orEmpty()
        val combatGameRootPath = combatHost.gameRoot?.absolutePath.orEmpty()
        val gameplayTablesDirPath = File(root, "gameplay-tables").absolutePath
        val nativeLibraryDirPath = context.applicationInfo.nativeLibraryDir.orEmpty()
        val nodeLogPath = File(RevivalSideSettingsStore.logsDir(context), "node-listener.log").absolutePath
        val combatNativeLibraryPath = buildNativeLibraryPath(combatHost)
        bootstrap.parentFile?.mkdirs()
        bootstrap.writeText(
            """
                const fs = require("fs");
                const path = require("path");
                process.chdir(${jsString(root.absolutePath)});
                const nodeLogPath = ${jsString(nodeLogPath)};
                fs.mkdirSync(path.dirname(nodeLogPath), { recursive: true });
                function nodeLogValue(value) {
                  if (typeof value === "string") return value;
                  if (value && value.stack) return value.stack;
                  try { return JSON.stringify(value); } catch (_) { return String(value); }
                }
                function appendNodeLog(level, args) {
                  try {
                    fs.appendFileSync(nodeLogPath, new Date().toISOString() + " [" + level + "] " + Array.from(args).map(nodeLogValue).join(" ") + "\n");
                  } catch (_) {}
                }
                const originalConsoleLog = console.log.bind(console);
                const originalConsoleError = console.error.bind(console);
                console.log = (...args) => { appendNodeLog("log", args); originalConsoleLog(...args); };
                console.error = (...args) => { appendNodeLog("error", args); originalConsoleError(...args); };
                process.on("uncaughtException", (error) => {
                  appendNodeLog("uncaught", [error]);
                  throw error;
                });
                process.on("unhandledRejection", (error) => {
                  appendNodeLog("unhandled", [error]);
                });
                process.env.CS_PORT = ${jsString(settings.gamePort.toString())};
                process.env.CS_HTTP_MIRROR_PORT = ${jsString(settings.httpPort.toString())};
                process.env.CS_HTTP_MIRROR_HOST = "127.0.0.1";
                process.env.CS_HTTP_MIRROR_BASE_URL = ${jsString("http://127.0.0.1:${settings.httpPort}")};
                process.env.CS_USER_DB_PATH = ${jsString(File(dataDir, "users.json").absolutePath)};
                process.env.CS_SERVER_TIME_STATE_PATH = ${jsString(File(dataDir, "server-time.json").absolutePath)};
                process.env.CS_CAPTURED_FLOW_DIR = ${jsString(File(dataDir, "captured-flows").absolutePath)};
                process.env.CS_CAPTURED_TCP_DIR = ${jsString(File(dataDir, "captured-tcp").absolutePath)};
                process.env.CS_CAPTURED_GAME_FLOW_DIR = ${jsString(File(dataDir, "captured-game-flow").absolutePath)};
                process.env.CS_GAMEPLAY_TABLES_DIR = ${jsString(gameplayTablesDirPath)};
                delete process.env.CS_GAMEPLAY_ASSET_SOURCE;
                delete process.env.CS_GAMEPLAY_TABLE_SOURCE;
                delete process.env.CS_ANDROID_STANDALONE;
                delete process.env.CS_DISABLE_COUNTERSIDE_MANAGED_DIR;
                process.env.CS_COUNTERSIDE_MANAGED_DIR = ${jsString(combatManagedDirPath)};
                process.env.COUNTERSIDE_MANAGED_DIR = ${jsString(combatManagedDirPath)};
                process.env.CS_COUNTERSIDE_DIR = ${jsString(combatGameRootPath)};
                process.env.CS_USE_LOCAL_JOIN_LOBBY_ACK = ${jsString(settings.joinLobbyAckMode)};
                process.env.CS_USER_MANAGER_ALLOW_REMOTE = "0";
                process.env.CS_VERBOSE_CAPTURE = "0";
                process.env.CS_REPLAY_CAPTURED_GAME_FLOW = "0";
                process.env.CS_SKIP_TUTORIAL_TO_WIN = "0";
                process.env.CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN = "0";
                process.env.CS_MANAGED_HOST_TICK_INTERVAL_MS = process.env.CS_MANAGED_HOST_TICK_INTERVAL_MS || ${jsString(ANDROID_MANAGED_HOST_TICK_INTERVAL_MS)};
                process.env.CS_CSHARP_COMBAT_HOST = ${jsString(if (combatHost.enabled) "1" else "0")};
                process.env.CS_CSHARP_COMBAT_HOST_PROJECT = ${jsString(combatHost.project.absolutePath)};
                delete process.env.CS_CSHARP_COMBAT_HOST_DLL;
                delete process.env.CS_COMBAT_HOST_PATH;
                process.env.CS_DOTNET_PATH = ${jsString(combatHostDotnetPath)};
                process.env.CS_CSHARP_COMBAT_HOST_DOTNET = ${jsString(combatHostDotnetPath)};
                process.env.REVIVALSIDE_DOTNET_ROOT = ${jsString(combatHostDotnetRootPath)};
                process.env.REVIVALSIDE_DOTNET_NATIVE_ROOT = ${jsString(nativeLibraryDirPath)};
                process.env.REVIVALSIDE_NATIVE_LIBRARY_DIR = ${jsString(nativeLibraryDirPath)};
                process.env.DOTNET_ROOT = ${jsString(combatHostDotnetRootPath)};
                process.env.LD_LIBRARY_PATH = ${jsString(combatNativeLibraryPath)};
                require(${jsString(entry.absolutePath)});
            """.trimIndent() + "\n",
            Charsets.UTF_8,
        )
        return bootstrap
    }

    private fun resolveCombatHostRuntime(root: File): AndroidCombatHostRuntime {
        val project = File(root, "combat-host/CombatHost.csproj")
        val dotnetRoot = resolveBundledAndroidDotnetRoot(root)
        val hostCacheDll = ensureCombatHostCacheLayout(root, dotnetRoot)
        val managedDir = resolveBundledCounterSideManagedDir(root)
        val gameRoot = managedDir?.let { findCounterSideRootFromManaged(it) }
        val dotnet = findDotnetExecutable()
        val enabled = project.isFile &&
            hostCacheDll?.isFile == true &&
            dotnet != null &&
            managedDir != null &&
            (settings.dotnetPath.isNotBlank() || dotnetRoot != null)
        val statusMessage = when {
            !project.isFile -> "Combat host payload is not bundled under ${File(root, "combat-host").absolutePath}; managed combat disabled."
            managedDir == null -> "Bundled combat host found, but CounterSide desktop managed assemblies are not bundled; managed combat disabled. Stage Steam Data/Managed with -IncludeSteamManagedCombatHost."
            dotnetRoot == null && settings.dotnetPath.isBlank() -> "Bundled combat host and CounterSide managed assemblies found, but Android dotnet runtime files are not bundled; managed combat disabled. Stage with -IncludeAndroidDotnetRuntime."
            dotnet == null -> "Bundled combat host and CounterSide managed assemblies found, but no Android dotnet launcher was found; managed combat disabled."
            hostCacheDll == null -> "Bundled combat host source found, but launcher-style host-cache runtime is missing; managed combat disabled."
            enabled -> "Bundled combat host enabled via launcher-style host-cache host=${hostCacheDll.absolutePath} managed=${managedDir.absolutePath} gameRoot=${gameRoot?.absolutePath.orEmpty()} dotnet=${dotnet.absolutePath} root=${dotnetRoot?.absolutePath.orEmpty()}"
            else -> "Bundled combat host source found, but launcher-style managed combat could not be enabled."
        }
        return AndroidCombatHostRuntime(
            project = project,
            hostCacheDll = hostCacheDll,
            managedDir = managedDir,
            gameRoot = gameRoot,
            dotnetRoot = dotnetRoot,
            dotnet = dotnet,
            enabled = enabled,
            statusMessage = statusMessage,
        )
    }

    private fun ensureCombatHostCacheLayout(root: File, dotnetRoot: File?): File? {
        val projectDir = File(root, "combat-host")
        val project = File(projectDir, "CombatHost.csproj")
        if (!project.isFile) return findHostCacheDll(projectDir)

        val stamp = computeCombatHostSourceStamp(projectDir) ?: return findHostCacheDll(projectDir)
        val cacheDir = File(projectDir, "bin/host-cache/$stamp")
        val dll = File(cacheDir, "CombatHost.dll")
        if (!isRunnableCombatHostDll(dll) && dotnetRoot != null) {
            runCatching {
                copyAndroidRuntimeToHostCache(dotnetRoot, cacheDir)
            }.onFailure { error ->
                log("Failed to stage launcher-style CombatHost host-cache: ${error.message}")
            }
        }
        return if (isRunnableCombatHostDll(dll)) dll else findHostCacheDll(projectDir)
    }

    private fun copyAndroidRuntimeToHostCache(dotnetRoot: File, cacheDir: File) {
        cacheDir.mkdirs()
        dotnetRoot.listFiles()
            ?.filter { file ->
                file.isFile &&
                    !file.extension.equals("a", ignoreCase = true) &&
                    !file.extension.equals("pdb", ignoreCase = true)
            }
            ?.forEach { file ->
                file.copyTo(File(cacheDir, file.name), overwrite = true)
            }
        if (!isRunnableCombatHostDll(File(cacheDir, "CombatHost.dll"))) {
            throw IllegalStateException("CombatHost.dll, CombatHost.deps.json, or CombatHost.runtimeconfig.json is missing under ${cacheDir.absolutePath}.")
        }
    }

    private fun findHostCacheDll(projectDir: File): File? {
        val cacheRoot = File(projectDir, "bin/host-cache")
        return cacheRoot.listFiles()
            ?.asSequence()
            ?.map { File(it, "CombatHost.dll") }
            ?.filter { isRunnableCombatHostDll(it) }
            ?.maxByOrNull { it.lastModified() }
    }

    private fun isRunnableCombatHostDll(dll: File): Boolean {
        if (!dll.isFile) return false
        val base = dll.absolutePath.removeSuffix(".dll")
        return File("$base.deps.json").isFile && File("$base.runtimeconfig.json").isFile
    }

    private fun computeCombatHostSourceStamp(projectDir: File): String? {
        val files = projectDir.listFiles()
            ?.filter { file ->
                file.isFile &&
                    (file.name.endsWith(".cs", ignoreCase = true) || file.name.endsWith(".csproj", ignoreCase = true))
            }
            ?.sortedBy { it.name }
            ?: return null
        val digest = MessageDigest.getInstance("SHA-1")
        val zero = byteArrayOf(0)
        for (file in files) {
            digest.update(file.name.toByteArray(Charsets.UTF_8))
            digest.update(zero)
            digest.update(file.readBytes())
            digest.update(zero)
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }.take(16)
    }

    private fun findCounterSideRootFromManaged(managedDir: File): File? {
        val dataDir = managedDir.parentFile
        if (dataDir != null && dataDir.name.equals("Data", ignoreCase = true)) {
            return dataDir.parentFile
        }
        return dataDir
    }

    private fun applyCombatHostEnvironment(env: MutableMap<String, String>, combatHost: AndroidCombatHostRuntime) {
        env["CS_CSHARP_COMBAT_HOST"] = if (combatHost.enabled) "1" else "0"
        env["CS_CSHARP_COMBAT_HOST_PROJECT"] = combatHost.project.absolutePath
        env.remove("CS_CSHARP_COMBAT_HOST_DLL")
        env.remove("CS_COMBAT_HOST_PATH")
        val dotnet = combatHost.dotnet
        if (dotnet != null) {
            env["CS_DOTNET_PATH"] = dotnet.absolutePath
            env["CS_CSHARP_COMBAT_HOST_DOTNET"] = dotnet.absolutePath
        } else {
            env.remove("CS_DOTNET_PATH")
            env.remove("CS_CSHARP_COMBAT_HOST_DOTNET")
        }
        val dotnetRoot = combatHost.dotnetRoot
        if (dotnetRoot != null) {
            env["REVIVALSIDE_DOTNET_ROOT"] = dotnetRoot.absolutePath
            env["REVIVALSIDE_DOTNET_NATIVE_ROOT"] = context.applicationInfo.nativeLibraryDir.orEmpty()
            env["REVIVALSIDE_NATIVE_LIBRARY_DIR"] = context.applicationInfo.nativeLibraryDir.orEmpty()
            env["DOTNET_ROOT"] = dotnetRoot.absolutePath
        } else {
            env.remove("REVIVALSIDE_DOTNET_ROOT")
            env.remove("REVIVALSIDE_DOTNET_NATIVE_ROOT")
            env.remove("REVIVALSIDE_NATIVE_LIBRARY_DIR")
            env.remove("DOTNET_ROOT")
        }
        env["LD_LIBRARY_PATH"] = buildNativeLibraryPath(combatHost)
        val managedDir = combatHost.managedDir
        if (managedDir != null) {
            env.remove("CS_DISABLE_COUNTERSIDE_MANAGED_DIR")
            env["CS_COUNTERSIDE_MANAGED_DIR"] = managedDir.absolutePath
            env["COUNTERSIDE_MANAGED_DIR"] = managedDir.absolutePath
            env["CS_COUNTERSIDE_DIR"] = combatHost.gameRoot?.absolutePath ?: managedDir.absolutePath
        } else {
            env.remove("CS_DISABLE_COUNTERSIDE_MANAGED_DIR")
            env["CS_COUNTERSIDE_MANAGED_DIR"] = ""
            env["COUNTERSIDE_MANAGED_DIR"] = ""
            env["CS_COUNTERSIDE_DIR"] = ""
        }
    }

    private fun buildNativeLibraryPath(combatHost: AndroidCombatHostRuntime): String {
        val paths = mutableListOf<String>()
        context.applicationInfo.nativeLibraryDir?.let { paths.add(it) }
        combatHost.dotnetRoot?.absolutePath?.let { paths.add(it) }
        combatHost.managedDir?.let { managed ->
            val dataDir = managed.parentFile
            if (dataDir != null) {
                for (abi in Build.SUPPORTED_ABIS.orEmpty()) {
                    paths.add(File(dataDir, "Plugins/$abi").absolutePath)
                }
                paths.add(File(dataDir, "Plugins").absolutePath)
            }
        }
        val existing = System.getenv("LD_LIBRARY_PATH").orEmpty()
        if (existing.isNotBlank()) paths.add(existing)
        return paths.filter { it.isNotBlank() }.distinct().joinToString(":")
    }

    private fun resolveBundledCounterSideManagedDir(root: File): File? {
        val candidates = listOf(
            File(root, "combat-managed/Data/Managed"),
            File(root, "CounterSide/Data/Managed"),
        )
        return candidates.firstOrNull { File(it, "Assembly-CSharp.dll").isFile }
    }

    private fun resolveBundledAndroidDotnetRoot(root: File): File? {
        for (abi in Build.SUPPORTED_ABIS.orEmpty()) {
            val rid = androidRuntimeIdentifier(abi) ?: continue
            val runtime = File(root, "combat-runtime/$rid")
            if (File(runtime, "CombatHost.dll").isFile &&
                (File(runtime, "libhostfxr.so").isFile || File(runtime, "libmonosgen-2.0.so").isFile)
            ) {
                return runtime
            }
        }
        return null
    }

    private fun androidRuntimeIdentifier(abi: String): String? {
        return when (abi) {
            "arm64-v8a" -> "android-arm64"
            "armeabi-v7a" -> "android-arm"
            "x86_64" -> "android-x64"
            else -> null
        }
    }

    private fun findNodeExecutable(): File? {
        val candidates = buildList {
            if (settings.nodePath.isNotBlank()) add(File(settings.nodePath))
            add(File(context.filesDir, "runtime/node/node"))
            add(File(context.filesDir, "node/node"))
            add(File("/data/local/tmp/node"))
        }
        return candidates.firstOrNull { file ->
            file.isFile && (file.canExecute() || file.setExecutable(true))
        }
    }

    private fun findDotnetExecutable(): File? {
        val candidates = buildList {
            if (settings.dotnetPath.isNotBlank()) add(File(settings.dotnetPath))
            add(File(context.applicationInfo.nativeLibraryDir, "librevivalside_dotnet_host.so"))
            add(File(context.filesDir, "runtime/dotnet/dotnet"))
            add(File(context.filesDir, "dotnet/dotnet"))
            add(File("/data/local/tmp/dotnet/dotnet"))
            add(File("/data/local/tmp/dotnet"))
        }
        return candidates.firstOrNull { file ->
            file.isFile && (file.canExecute() || file.setExecutable(true))
        }
    }

    private fun copyPackagedListenerAssets() {
        val root = RevivalSideSettingsStore.appRoot(context)
        if (assetExists(PAYLOAD_ARCHIVE_ASSET)) {
            installPackagedPayloadArchive(root)
            installGameplayTablesArchive(root)
            if (assetTreeExists("revivalside-listener")) {
                copyAssetTree("revivalside-listener", root)
                log("Applied packaged RevivalSide listener overlay.")
            }
        } else {
            copyAssetTree("revivalside-listener", root)
            installGameplayTablesArchive(root)
        }
    }

    private fun installPackagedPayloadArchive(root: File) {
        val manifestText = readAssetTextOrBlank(PAYLOAD_MANIFEST_ASSET)
        val payloadId = extractJsonString(manifestText, "payloadId")
        val archiveSha256 = extractJsonString(manifestText, "archiveSha256")
        val marker = File(root, PAYLOAD_MARKER_NAME)
        if (payloadMarkerMatches(marker, payloadId, archiveSha256) && hasListenerEntry(root)) {
            log("Packaged RevivalSide payload already installed${if (payloadId.isNotBlank()) " id=$payloadId" else ""}.")
            return
        }

        root.mkdirs()
        var extractedFiles = 0
        var extractedBytes = 0L
        ZipInputStream(BufferedInputStream(context.assets.open(PAYLOAD_ARCHIVE_ASSET))).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                try {
                    val relative = payloadRelativePath(entry.name) ?: continue
                    if (relative.isBlank()) continue
                    val destination = safePayloadDestination(root, relative) ?: continue
                    if (entry.isDirectory) {
                        destination.mkdirs()
                        continue
                    }
                    if (shouldSkipMutablePayloadPath(relative)) continue
                    destination.parentFile?.mkdirs()
                    destination.outputStream().use { output ->
                        extractedBytes += zip.copyTo(output)
                    }
                    extractedFiles += 1
                } finally {
                    zip.closeEntry()
                }
            }
        }

        if (!hasListenerEntry(root)) {
            marker.delete()
            throw IllegalStateException("Packaged RevivalSide payload did not contain a listener entry.")
        }

        marker.writeText(
            """
                {
                  "payloadAsset": "$PAYLOAD_ARCHIVE_ASSET",
                  "payloadId": "${escapeJson(payloadId)}",
                  "archiveSha256": "${escapeJson(archiveSha256)}",
                  "installedAt": "${Instant.now()}"
                }
            """.trimIndent() + "\n",
            Charsets.UTF_8,
        )
        log(
            "Installed packaged RevivalSide payload files=$extractedFiles bytes=$extractedBytes" +
                if (payloadId.isNotBlank()) " id=$payloadId" else "",
        )
    }

    private fun installGameplayTablesArchive(root: File) {
        if (!assetExists(GAMEPLAY_TABLES_ARCHIVE_ASSET)) return

        val manifestText = readAssetTextOrBlank(GAMEPLAY_TABLES_MANIFEST_ASSET)
        val payloadId = extractJsonString(manifestText, "payloadId").ifBlank { "revivalside-gameplay-tables" }
        val archiveSha256 = extractJsonString(manifestText, "archiveSha256")
        val requiredFile = extractJsonString(manifestText, "requiredFile")
            .ifBlank { "gameplay-tables/StreamingAssets/ab_script/luac/LUA_STAGE_TEMPLET.luac" }
        val marker = File(root, GAMEPLAY_TABLES_MARKER_NAME)
        if (payloadMarkerMatches(marker, payloadId, archiveSha256) && File(root, requiredFile).isFile) {
            log("Packaged gameplay tables already installed id=$payloadId.")
            return
        }

        root.mkdirs()
        var extractedFiles = 0
        var extractedBytes = 0L
        ZipInputStream(BufferedInputStream(context.assets.open(GAMEPLAY_TABLES_ARCHIVE_ASSET))).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                try {
                    val normalized = entry.name.replace('\\', '/').trimStart('/')
                    if (normalized.isBlank()) continue
                    if (!normalized.startsWith("gameplay-tables/")) continue
                    val destination = safePayloadDestination(root, normalized) ?: continue
                    if (entry.isDirectory) {
                        destination.mkdirs()
                        continue
                    }
                    destination.parentFile?.mkdirs()
                    destination.outputStream().use { output ->
                        extractedBytes += zip.copyTo(output)
                    }
                    extractedFiles += 1
                } finally {
                    zip.closeEntry()
                }
            }
        }

        if (!File(root, requiredFile).isFile) {
            marker.delete()
            throw IllegalStateException("Packaged gameplay tables did not contain $requiredFile.")
        }

        marker.writeText(
            """
                {
                  "payloadId": "${escapeJson(payloadId)}",
                  "archiveSha256": "${escapeJson(archiveSha256)}",
                  "requiredFile": "${escapeJson(requiredFile)}",
                  "installedAt": "${Instant.now()}"
                }
            """.trimIndent() + "\n",
            Charsets.UTF_8,
        )
        log("Installed packaged gameplay tables files=$extractedFiles bytes=$extractedBytes id=$payloadId.")
    }

    private fun copyAssetTree(assetPath: String, destination: File) {
        val children = runCatching { context.assets.list(assetPath)?.toList().orEmpty() }.getOrDefault(emptyList())
        if (children.isEmpty()) {
            runCatching {
                context.assets.open(assetPath).use { input ->
                    destination.parentFile?.mkdirs()
                    destination.outputStream().use { output -> input.copyTo(output) }
                }
            }
            return
        }
        destination.mkdirs()
        for (child in children) {
            copyAssetTree("$assetPath/$child", File(destination, child))
        }
    }

    private fun assetExists(assetPath: String): Boolean {
        return runCatching {
            context.assets.open(assetPath).use { }
            true
        }.getOrDefault(false)
    }

    private fun assetTreeExists(assetPath: String): Boolean {
        return runCatching {
            !context.assets.list(assetPath).isNullOrEmpty()
        }.getOrDefault(false)
    }

    private fun readAssetTextOrBlank(assetPath: String): String {
        return runCatching {
            context.assets.open(assetPath).bufferedReader(Charsets.UTF_8).use { it.readText() }
        }.getOrDefault("")
    }

    private fun payloadMarkerMatches(marker: File, payloadId: String, archiveSha256: String): Boolean {
        if (!marker.isFile) return false
        val text = runCatching { marker.readText(Charsets.UTF_8) }.getOrDefault("")
        if (payloadId.isNotBlank() && !text.contains(payloadId)) return false
        if (archiveSha256.isNotBlank() && !text.contains(archiveSha256)) return false
        return true
    }

    private fun payloadRelativePath(entryName: String): String? {
        val normalized = entryName.replace('\\', '/').trimStart('/')
        val prefixes = listOf("payload/app/", "app/")
        for (prefix in prefixes) {
            if (normalized.startsWith(prefix)) return normalized.substring(prefix.length)
        }
        return null
    }

    private fun safePayloadDestination(root: File, relative: String): File? {
        val normalized = relative.replace('\\', '/').trimStart('/')
        if (normalized.isBlank() || normalized.startsWith("../") || normalized.contains("/../")) return null
        val rootCanonical = root.canonicalFile
        val destination = File(rootCanonical, normalized).canonicalFile
        val rootPath = rootCanonical.path
        val destinationPath = destination.path
        if (destinationPath != rootPath && !destinationPath.startsWith(rootPath + File.separator)) return null
        return destination
    }

    private fun shouldSkipMutablePayloadPath(relative: String): Boolean {
        val normalized = relative.replace('\\', '/').trimStart('/').lowercase()
        return normalized == ".env" ||
            normalized == "server-data/users.json" ||
            normalized == "server-data/server-time.json" ||
            normalized.startsWith("logs/") ||
            normalized.startsWith("exports/") ||
            normalized.startsWith("captures/") ||
            normalized.startsWith("server-data/users.backups/")
    }

    private fun hasListenerEntry(root: File): Boolean {
        return File(root, "server/listener.js").isFile || File(root, "cs-listener.js").isFile
    }

    private fun extractJsonString(json: String, key: String): String {
        if (json.isBlank()) return ""
        val pattern = Regex("\"" + Regex.escape(key) + "\"\\s*:\\s*\"([^\"]*)\"")
        return pattern.find(json)?.groupValues?.getOrNull(1).orEmpty()
    }

    companion object {
        private val nativeStarted = AtomicBoolean(false)
        private const val PAYLOAD_ARCHIVE_ASSET = "revivalside-payload.zip"
        private const val PAYLOAD_MANIFEST_ASSET = "revivalside-payload-manifest.json"
        private const val PAYLOAD_MARKER_NAME = ".revivalside-android-payload.json"
        private const val GAMEPLAY_TABLES_ARCHIVE_ASSET = "revivalside-gameplay-tables.zip"
        private const val GAMEPLAY_TABLES_MANIFEST_ASSET = "revivalside-gameplay-tables-manifest.json"
        private const val GAMEPLAY_TABLES_MARKER_NAME = ".revivalside-android-gameplay-tables.json"
        private const val ANDROID_MANAGED_HOST_TICK_INTERVAL_MS = "100"
    }
}

private fun escapeJson(value: String): String {
    return value
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
}

private fun escapeHtml(value: String): String {
    return value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
}

private fun jsString(value: String): String = "\"" + escapeJson(value) + "\""
