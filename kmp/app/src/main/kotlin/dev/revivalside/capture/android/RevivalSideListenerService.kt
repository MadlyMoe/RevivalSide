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
import android.system.Os
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipInputStream
import kotlin.concurrent.thread

class RevivalSideListenerService : Service() {
    private val running = AtomicBoolean(false)
    @Volatile private var nodeRuntime: NodeProcessRuntime? = null
    private var logFile: File? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) stopListener() else startListener()
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

        val root = RevivalSideSettingsStore.appRoot(this)
        val logs = RevivalSideSettingsStore.logsDir(this)
        root.mkdirs()
        RevivalSideSettingsStore.serverDataDir(this).mkdirs()
        logs.mkdirs()
        logFile = File(logs, "android-listener.log")

        startForeground(NOTIFICATION_ID, buildNotification("Preparing listener"))
        publishStatus("Preparing packaged listener")
        thread(name = "revivalside-listener-start", isDaemon = true) {
            startListenerRuntime(RevivalSideSettingsStore.load(this))
        }
    }

    private fun startListenerRuntime(settings: RevivalSideSettings) {
        try {
            appendLog("Starting Android listener gamePort=${settings.gamePort} httpPort=${settings.httpPort}")

            val runtime = NodeProcessRuntime(this, settings, ::appendLog, ::handleRuntimeExit)
            if (!runtime.start()) {
                throw IllegalStateException("Embedded listener failed: ${runtime.describeState()}")
            }
            if (!running.get()) {
                runtime.stop()
                return
            }
            nodeRuntime = runtime

            publishStatus("Listener online on 127.0.0.1:${settings.httpPort}")
            updateNotification("Listener online")
        } catch (ex: Exception) {
            appendLog("Listener failed: ${ex.message}")
            publishStatus("Listener failed: ${ex.message}")
            running.set(false)
            nodeRuntime?.stop()
            nodeRuntime = null
            stopForeground(STOP_FOREGROUND_REMOVE)
        }
    }

    private fun stopListener() {
        if (!running.getAndSet(false)) return
        appendLog("Stopping Android listener")
        nodeRuntime?.stop()
        nodeRuntime = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        publishStatus("Listener stopped")
    }

    private fun handleRuntimeExit(state: String) {
        if (!running.getAndSet(false)) return
        appendLog("Listener runtime stopped unexpectedly: $state")
        publishStatus("Listener stopped unexpectedly: $state")
        updateNotification("Listener restarting")
        thread(name = "revivalside-listener-restart", isDaemon = true) {
            Thread.sleep(250)
            android.os.Process.killProcess(android.os.Process.myPid())
        }
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
        if (message.startsWith("Preparing ")) updateNotification(message)
        publishStatus(message)
    }

    private fun publishStatus(message: String) {
        sendBroadcast(Intent(ACTION_STATUS).apply {
            setPackage(packageName)
            putExtra(EXTRA_MESSAGE, message)
            putExtra(EXTRA_LOG_PATH, logFile?.absolutePath.orEmpty())
        }, INTERNAL_BROADCAST_PERMISSION)
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

private data class AndroidCombatHostRuntime(
    val project: File,
    val hostDll: File?,
    val managedDir: File?,
    val gameRoot: File?,
    val dotnetRoot: File?,
    val dotnet: File?,
    val enabled: Boolean,
    val statusMessage: String,
)

private data class AndroidListenerPaths(
    val runtimeRoot: File,
    val gameplayTablesRoot: File,
    val platformRoot: File,
    val sourceContentsVersion: String,
)

private class NodeProcessRuntime(
    private val context: Context,
    private val settings: RevivalSideSettings,
    private val log: (String) -> Unit,
    private val onExit: (String) -> Unit,
) {
    private var process: Process? = null
    private var nativeThread: Thread? = null
    private val running = AtomicBoolean(false)
    private var state: String = "stopped"

    fun start(): Boolean {
        if (!running.compareAndSet(false, true)) return true
        val clientContract = AndroidClientContract.load(context)
        val paths = installPackagedAssets()

        val root = paths.runtimeRoot
        installMutableSeeds(root)
        val preparedGameFlow = CaptureRepository.prepareCapturedGameFlow(context, root)
        log(
            "Prepared PC captured game flow at ${preparedGameFlow.directory.absolutePath}" +
                if (preparedGameFlow.overlaidCapturedAck) " with the latest Android JOIN_LOBBY_ACK at its canonical slot." else ".",
        )
        prepareAndroidPayloadMirror(root, clientContract)
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

        val combatHost = resolveCombatHostRuntime(paths.platformRoot)
        log(combatHost.statusMessage)

        if (settings.nodePath.isBlank() && NodeMobileBridge.isLoaded()) {
            return startNativeNode(paths, entry, combatHost)
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
            val gameplayTablesDir = paths.gameplayTablesRoot
            val androidClientPayloadDir = AndroidPayloadCache.activeRoot(context)
            val androidClientCdnBaseUrl = if (androidClientPayloadDir != null) {
                AndroidPayloadCache.localCdnBaseUrl(settings.httpPort)
            } else {
                settings.assetCdnBaseUrl.ifBlank { clientContract.assetCdnBaseUrl }
            }
            env["CS_PORT"] = settings.gamePort.toString()
            env["CS_HTTP_MIRROR_PORT"] = settings.httpPort.toString()
            env["CS_HTTP_MIRROR_HOST"] = "127.0.0.1"
            env["CS_USER_DB_PATH"] = File(dataDir, "users.json").absolutePath
            env["CS_SERVER_TIME_STATE_PATH"] = File(dataDir, "server-time.json").absolutePath
            env["CS_CAPTURED_FLOW_DIR"] = File(root, "server-data/captured-flows").absolutePath
            env["CS_CAPTURED_TCP_DIR"] = File(root, "server-data/captured-tcp").absolutePath
            env["CS_CAPTURED_GAME_FLOW_DIR"] = File(dataDir, "captured-game-flow").absolutePath
            env["CS_GAMEPLAY_ASSET_SOURCE"] = "installed"
            env["CS_GAMEPLAY_TABLE_SOURCE"] = "installed"
            env.remove("CS_ANDROID_STANDALONE")
            env["CS_GAMEPLAY_TABLES_DIR"] = gameplayTablesDir.absolutePath
            env["CS_FROZEN_SOURCE_CONTENTS_VERSION"] = paths.sourceContentsVersion
            env["CS_HTTP_MIRROR_BASE_URL"] = "http://127.0.0.1:${settings.httpPort}"
            env["CS_ANDROID_CLIENT_CDN_BASE_URL"] = androidClientCdnBaseUrl
            if (androidClientPayloadDir != null) {
                env["CS_ANDROID_CLIENT_PAYLOAD_DIR"] = androidClientPayloadDir.absolutePath
            } else {
                env.remove("CS_ANDROID_CLIENT_PAYLOAD_DIR")
            }
            env["CS_REQUIRE_COMBAT_HOST"] = "1"
            env["CS_EVENT_DATE"] = settings.eventDate
            env["CS_EVENT_MANAGER"] = "auto"
            env["CS_LOGIN_BACKGROUND"] = settings.loginBackground
            env["CS_USE_LOCAL_JOIN_LOBBY_ACK"] = settings.joinLobbyAckMode
            env["CS_USER_MANAGER_ALLOW_REMOTE"] = "0"
            env["CS_VERBOSE_CAPTURE"] = "0"
            env["CS_REPLAY_CAPTURED_CONTENTS_VERSION"] = "0"
            env["CS_REPLAY_CAPTURED_LOGIN_ACK"] = "0"
            env["CS_REPLAY_CAPTURED_GAME_FLOW"] = "0"
            env["CS_SKIP_TUTORIAL_TO_WIN"] = "0"
            env["CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN"] = "0"
            env["CS_PRIVATE_PVP"] = "0"
            env["CS_PVP_PUBLIC_HOST"] = ""
            env["CS_PVP_HOST_URL"] = ""
            env["CS_PVP_RELAY_URL"] = ""
            env["CS_PVP_RELAY_SECRET"] = ""
            env["CS_PVP_RELAY_HOST_ID"] = ""
            env["CS_PVP_RELAY_ROLE"] = "off"
            env["CS_ANDROID_CLIENT_UPDATE_DIR"] = File(paths.platformRoot, "server-data/android-client-update").absolutePath
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
                onExit(state)
            }
        }
    }

    private fun startNativeNode(paths: AndroidListenerPaths, entry: File, combatHost: AndroidCombatHostRuntime): Boolean {
        if (!nativeStarted.compareAndSet(false, true)) {
            state = "native-already-running"
            log("Bundled Node Mobile listener is already running in this app process.")
            return true
        }

        val bootstrap = writeBootstrap(paths, entry, combatHost)
        state = "native-running"
        nativeThread = thread(name = "revivalside-node-mobile", isDaemon = true) {
            val exitCode = runCatching {
                NodeMobileBridge.startNodeWithArguments(arrayOf("node", bootstrap.absolutePath))
            }.getOrElse { error ->
                state = "native-start-failed"
                running.set(false)
                log("Bundled Node Mobile listener crashed: ${error.message}")
                onExit(state)
                return@thread
            }
            state = "native-exited-$exitCode"
            running.set(false)
            log("Bundled Node Mobile listener exited with code $exitCode")
            onExit(state)
        }
        log("Started bundled Node Mobile listener with ${bootstrap.absolutePath}")
        return true
    }

    private fun writeBootstrap(paths: AndroidListenerPaths, entry: File, combatHost: AndroidCombatHostRuntime): File {
        val root = paths.runtimeRoot
        val dataDir = RevivalSideSettingsStore.serverDataDir(context)
        val bootstrap = File(RevivalSideSettingsStore.appRoot(context), "bootstrap/android-node-main.js")
        val combatHostDotnetPath = combatHost.dotnet?.absolutePath.orEmpty()
        val combatHostDotnetRootPath = combatHost.dotnetRoot?.absolutePath.orEmpty()
        val combatManagedDirPath = combatHost.managedDir?.absolutePath.orEmpty()
        val combatGameRootPath = combatHost.gameRoot?.absolutePath.orEmpty()
        val gameplayTablesDirPath = paths.gameplayTablesRoot.absolutePath
        val androidClientUpdateDirPath = File(paths.platformRoot, "server-data/android-client-update").absolutePath
        val nativeLibraryDirPath = context.applicationInfo.nativeLibraryDir.orEmpty()
        val nodeLogPath = File(RevivalSideSettingsStore.logsDir(context), "node-listener.log").absolutePath
        val combatNativeLibraryPath = buildNativeLibraryPath(combatHost)
        val clientContract = AndroidClientContract.load(context)
        val androidClientPayloadDir = AndroidPayloadCache.activeRoot(context)
        val androidClientCdnBaseUrl = if (androidClientPayloadDir != null) {
            AndroidPayloadCache.localCdnBaseUrl(settings.httpPort)
        } else {
            settings.assetCdnBaseUrl.ifBlank { clientContract.assetCdnBaseUrl }
        }
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
                console.log = (...args) => {
                  const message = typeof args[0] === "string" ? args[0] : "";
                  if (message.startsWith("[mirror] HIT ") && message.includes("/patchfiles/")) return;
                  appendNodeLog("log", args);
                  originalConsoleLog(...args);
                };
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
                process.env.CS_ANDROID_CLIENT_CDN_BASE_URL = ${jsString(androidClientCdnBaseUrl)};
                process.env.CS_ANDROID_CLIENT_PAYLOAD_DIR = ${jsString(androidClientPayloadDir?.absolutePath.orEmpty())};
                process.env.CS_REQUIRE_COMBAT_HOST = "1";
                process.env.CS_USER_DB_PATH = ${jsString(File(dataDir, "users.json").absolutePath)};
                process.env.CS_SERVER_TIME_STATE_PATH = ${jsString(File(dataDir, "server-time.json").absolutePath)};
                process.env.CS_CAPTURED_FLOW_DIR = ${jsString(File(root, "server-data/captured-flows").absolutePath)};
                process.env.CS_CAPTURED_TCP_DIR = ${jsString(File(root, "server-data/captured-tcp").absolutePath)};
                process.env.CS_CAPTURED_GAME_FLOW_DIR = ${jsString(File(dataDir, "captured-game-flow").absolutePath)};
                process.env.CS_GAMEPLAY_TABLES_DIR = ${jsString(gameplayTablesDirPath)};
                process.env.CS_GAMEPLAY_ASSET_SOURCE = "installed";
                process.env.CS_GAMEPLAY_TABLE_SOURCE = "installed";
                process.env.CS_FROZEN_SOURCE_CONTENTS_VERSION = ${jsString(paths.sourceContentsVersion)};
                delete process.env.CS_ANDROID_STANDALONE;
                delete process.env.CS_DISABLE_COUNTERSIDE_MANAGED_DIR;
                process.env.CS_COUNTERSIDE_MANAGED_DIR = ${jsString(combatManagedDirPath)};
                process.env.COUNTERSIDE_MANAGED_DIR = ${jsString(combatManagedDirPath)};
                process.env.CS_COUNTERSIDE_DIR = ${jsString(combatGameRootPath)};
                process.env.CS_EVENT_DATE = ${jsString(settings.eventDate)};
                process.env.CS_EVENT_MANAGER = "auto";
                process.env.CS_LOGIN_BACKGROUND = ${jsString(settings.loginBackground)};
                process.env.CS_USE_LOCAL_JOIN_LOBBY_ACK = ${jsString(settings.joinLobbyAckMode)};
                process.env.CS_USER_MANAGER_ALLOW_REMOTE = "0";
                process.env.CS_VERBOSE_CAPTURE = "0";
                process.env.CS_REPLAY_CAPTURED_CONTENTS_VERSION = "0";
                process.env.CS_REPLAY_CAPTURED_LOGIN_ACK = "0";
                process.env.CS_REPLAY_CAPTURED_GAME_FLOW = "0";
                process.env.CS_SKIP_TUTORIAL_TO_WIN = "0";
                process.env.CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN = "0";
                process.env.CS_PRIVATE_PVP = "0";
                process.env.CS_PVP_PUBLIC_HOST = "";
                process.env.CS_PVP_HOST_URL = "";
                process.env.CS_PVP_RELAY_URL = "";
                process.env.CS_PVP_RELAY_SECRET = "";
                process.env.CS_PVP_RELAY_HOST_ID = "";
                process.env.CS_PVP_RELAY_ROLE = "off";
                process.env.CS_ANDROID_CLIENT_UPDATE_DIR = ${jsString(androidClientUpdateDirPath)};
                process.env.CS_CSHARP_COMBAT_HOST = ${jsString(if (combatHost.enabled) "1" else "0")};
                process.env.CS_CSHARP_COMBAT_HOST_PROJECT = ${jsString(combatHost.project.absolutePath)};
                process.env.CS_CSHARP_COMBAT_HOST_DLL = ${jsString(combatHost.hostDll?.absolutePath.orEmpty())};
                process.env.CS_COMBAT_HOST_PATH = ${jsString(combatHost.hostDll?.absolutePath.orEmpty())};
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

    private fun resolveCombatHostRuntime(platformRoot: File): AndroidCombatHostRuntime {
        val project = File(platformRoot, "combat-host/CombatHost.csproj")
        val dotnetRoot = resolveBundledAndroidDotnetRoot(platformRoot)
        val hostDll = dotnetRoot?.let { File(it, "CombatHost.dll") }?.takeIf(::isRunnableCombatHostDll)
        val managedDir = resolveBundledCounterSideManagedDir(platformRoot)
        val gameRoot = managedDir?.let { findCounterSideRootFromManaged(it) }
        val dotnet = findDotnetExecutable()
        val enabled = project.isFile &&
            hostDll?.isFile == true &&
            dotnet != null &&
            managedDir != null
        val statusMessage = when {
            !project.isFile -> "Combat host payload is not bundled under ${File(platformRoot, "combat-host").absolutePath}; managed combat disabled."
            managedDir == null -> "Bundled combat host found, but CounterSide desktop managed assemblies are not bundled; managed combat disabled. Stage Steam Data/Managed with -IncludeSteamManagedCombatHost."
            dotnetRoot == null && settings.dotnetPath.isBlank() -> "Bundled combat host and CounterSide managed assemblies found, but Android dotnet runtime files are not bundled; managed combat disabled. Stage with -IncludeAndroidDotnetRuntime."
            dotnet == null -> "Bundled combat host and CounterSide managed assemblies found, but no Android dotnet launcher was found; managed combat disabled."
            hostDll == null -> "Bundled Android CombatHost runtime is missing; managed combat disabled."
            enabled -> "Bundled combat host enabled host=${hostDll.absolutePath} managed=${managedDir.absolutePath} gameRoot=${gameRoot?.absolutePath.orEmpty()} dotnet=${dotnet.absolutePath} root=${dotnetRoot.absolutePath}"
            else -> "Bundled combat host source found, but launcher-style managed combat could not be enabled."
        }
        return AndroidCombatHostRuntime(
            project = project,
            hostDll = hostDll,
            managedDir = managedDir,
            gameRoot = gameRoot,
            dotnetRoot = dotnetRoot,
            dotnet = dotnet,
            enabled = enabled,
            statusMessage = statusMessage,
        )
    }

    private fun isRunnableCombatHostDll(dll: File): Boolean {
        if (!dll.isFile) return false
        val base = dll.absolutePath.removeSuffix(".dll")
        return File("$base.deps.json").isFile && File("$base.runtimeconfig.json").isFile
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
        env["CS_CSHARP_COMBAT_HOST_DLL"] = combatHost.hostDll?.absolutePath.orEmpty()
        env["CS_COMBAT_HOST_PATH"] = combatHost.hostDll?.absolutePath.orEmpty()
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
            val nativeHost = when (rid) {
                "android-arm64" -> "libhostfxr.so"
                "android-arm" -> "libmonosgen-2.0.so"
                else -> continue
            }
            if (File(runtime, "CombatHost.dll").isFile &&
                File(context.applicationInfo.nativeLibraryDir, nativeHost).isFile
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

    private fun installPackagedAssets(): AndroidListenerPaths {
        if (!assetExists(PAYLOAD_ARCHIVE_ASSET) || !assetExists(GAMEPLAY_TABLES_ARCHIVE_ASSET)) {
            throw IllegalStateException("The unified PC listener payload and gameplay tables are required.")
        }
        val gameplayTablesManifest = readAssetTextOrBlank(GAMEPLAY_TABLES_MANIFEST_ASSET)
        val sourceContentsVersion = extractJsonString(gameplayTablesManifest, "contentsVersion")
        if (!sourceContentsVersion.matches(Regex("\\d{1,4}\\.\\d{1,4}\\.[A-Za-z0-9_-]{1,16}"))) {
            throw IllegalStateException("The gameplay table manifest has no valid PC content version.")
        }
        val paths = AndroidListenerPaths(
            runtimeRoot = installVersionedArchive(
                PAYLOAD_ARCHIVE_ASSET,
                PAYLOAD_MANIFEST_ASSET,
                "runtime",
                "cs-listener.js",
                ::payloadRelativePath,
            ),
            gameplayTablesRoot = File(
                installVersionedArchive(
                    GAMEPLAY_TABLES_ARCHIVE_ASSET,
                    GAMEPLAY_TABLES_MANIFEST_ASSET,
                    "content",
                    "gameplay-tables/StreamingAssets/ab_script/luac/LUA_STAGE_TEMPLET.luac",
                ) { name -> name.replace('\\', '/').trimStart('/').takeIf { it.startsWith("gameplay-tables/") } },
                "gameplay-tables",
            ),
            platformRoot = installVersionedPlatformAssets(),
            sourceContentsVersion = sourceContentsVersion,
        )
        removeLegacyListenerOverlay()
        return paths
    }

    private fun installMutableSeeds(runtimeRoot: File) {
        val source = File(runtimeRoot, "server-data/starter-users.json")
        val destination = File(RevivalSideSettingsStore.serverDataDir(context), "starter-users.json")
        if (!source.isFile) throw IllegalStateException("The shared PC payload is missing server-data/starter-users.json.")
        destination.parentFile?.mkdirs()
        source.copyTo(destination, overwrite = true)
    }

    private fun prepareAndroidPayloadMirror(runtimeRoot: File, contract: AndroidClientContract) {
        val flowRoot = File(runtimeRoot, "server-data/captured-flows")
        val manifestFile = File(flowRoot, "manifest.json")
        if (!manifestFile.isFile) throw IllegalStateException("The PC 0.4.0 HTTP mirror manifest is missing.")

        val payloadRoot = AndroidPayloadCache.activeRoot(context)
        val updateVersion = contract.patchVersion.replace(Regex("\\d+$")) { match ->
            (match.value.toLong() + 1L).toString()
        }
        val marker = File(flowRoot, ".android-payload-mirror")
        val markerValue = listOf(
            contract.payloadManifestSha256,
            updateVersion,
            if (payloadRoot == null) "remote" else "local",
            "encoded-paths-v1",
        ).joinToString(":")
        if (marker.readTextOrBlank() == markerValue) return

        val entries = linkedMapOf<String, JSONObject>()
        val original = JSONArray(manifestFile.readText(Charsets.UTF_8))
        for (index in 0 until original.length()) {
            val entry = original.optJSONObject(index) ?: continue
            val route = entry.optString("path")
            if (route.isNotBlank() && !entry.optBoolean("androidPayload")) entries[route] = entry
        }

        fun addFile(route: String, file: File) {
            if (!file.isFile) throw IllegalStateException("Android payload file is missing: $route")
            val requestRoute = route.replace(" ", "%20")
            entries[requestRoute] = JSONObject()
                .put("method", "GET")
                .put("host", "127.0.0.1")
                .put("path", requestRoute)
                .put("statusCode", 200)
                .put("headers", JSONObject().put("Content-Type", androidPayloadContentType(route)))
                .put("bodyFile", file.relativeTo(flowRoot).path.replace(File.separatorChar, '/'))
                .put("androidPayload", true)
        }

        if (payloadRoot != null) {
            val payloadManifestFile = File(payloadRoot, "payload-manifest.json")
            val payloadManifest = validateAndroidPayloadManifest(contract, payloadManifestFile.readBytes())
            val files = payloadManifest.getJSONArray("files")
            val sourcePrefix = "patchfiles/Android/${contract.patchVersion}/"
            val updatePrefix = "patchfiles/Android/$updateVersion/"
            for (index in 0 until files.length()) {
                val item = files.getJSONObject(index)
                val relative = normalizeAndroidPayloadPath(item.getString("path"))
                val file = File(payloadRoot, relative)
                if (file.length() != item.getLong("size")) {
                    throw IllegalStateException("Android payload file size is invalid: $relative")
                }
                addFile("/$relative", file)
                if (relative.startsWith(sourcePrefix)) {
                    addFile("/${relative.replaceFirst(sourcePrefix, updatePrefix)}", file)
                }
            }
            addFile("/android-client/payload-manifest.json", payloadManifestFile)
        }

        entries["/server_config/live/ServerInfo_V2.json"]?.let { serverInfo ->
            entries["/revivalsideapk/server_config/live/ServerInfo_V2.json"] = JSONObject(serverInfo.toString())
                .put("path", "/revivalsideapk/server_config/live/ServerInfo_V2.json")
                .put("androidPayload", true)
        } ?: throw IllegalStateException("The PC 0.4.0 server configuration response is missing.")

        val output = JSONArray()
        entries.values.forEach(output::put)
        val temporary = File(flowRoot, "manifest.json.tmp")
        temporary.writeText(output.toString(), Charsets.UTF_8)
        temporary.copyTo(manifestFile, overwrite = true)
        temporary.delete()
        marker.writeText(markerValue, Charsets.UTF_8)
        log("Android payload mirror ready: ${entries.size} routes (${contract.patchVersion} -> $updateVersion).")
    }

    private fun androidPayloadContentType(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "json" -> "application/json"
        "xml" -> "application/xml"
        "txt" -> "text/plain"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        else -> "application/octet-stream"
    }

    private fun File.readTextOrBlank(): String = runCatching { readText(Charsets.UTF_8).trim() }.getOrDefault("")

    private fun removeLegacyListenerOverlay() {
        val root = RevivalSideSettingsStore.appRoot(context)
        for (relative in listOf(
            ".cache", ".env.example", ".revivalside-android-payload.json",
            ".revivalside-android-gameplay-tables.json", "CONTRIBUTING.md", "README.md",
            "android-node-main.js", "combat-handler", "combat-host", "combat-managed", "combat-runtime",
            "combat-simulator", "cs-listener.js", "gameplay-jsons", "gameplay-tables", "modules",
            "package-lock.json", "package.json", "packet-handlers", "packet-schema.json", "server",
            "SpineViewer", "stages", "tools", "wiki",
        )) {
            File(root, relative).deleteRecursively()
        }
    }

    private fun installVersionedArchive(
        assetName: String,
        manifestAsset: String,
        storageName: String,
        defaultRequiredFile: String,
        entryPath: (String) -> String?,
    ): File {
        val manifestText = readAssetTextOrBlank(manifestAsset)
        val payloadId = extractJsonString(manifestText, "payloadId")
        val archiveSha256 = extractJsonString(manifestText, "archiveSha256")
        val requiredFile = extractJsonString(manifestText, "requiredFile").ifBlank { defaultRequiredFile }
        val parent = File(RevivalSideSettingsStore.appRoot(context), storageName).apply { mkdirs() }
        val target = File(parent, versionKey(archiveSha256.ifBlank { payloadId }))
        val marker = File(target, INSTALL_MARKER_NAME)
        if (payloadMarkerMatches(marker, payloadId, archiveSha256) && File(target, requiredFile).isFile) {
            cleanupOldVersions(parent, target)
            return target
        }

        val staging = File(parent, "${target.name}.installing")
        staging.deleteRecursively()
        staging.mkdirs()
        var extractedFiles = 0
        var extractedBytes = 0L
        log("Preparing $assetName")
        ZipInputStream(BufferedInputStream(context.assets.open(assetName))).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                try {
                    val relative = entryPath(entry.name) ?: continue
                    val destination = safePayloadDestination(staging, relative) ?: continue
                    if (entry.isDirectory) {
                        destination.mkdirs()
                    } else {
                        destination.parentFile?.mkdirs()
                        destination.outputStream().use { extractedBytes += zip.copyTo(it) }
                        extractedFiles += 1
                        if (extractedFiles % ARCHIVE_PROGRESS_FILE_INTERVAL == 0) {
                            log("Preparing $assetName files=$extractedFiles bytes=$extractedBytes")
                        }
                    }
                } finally {
                    zip.closeEntry()
                }
            }
        }
        if (!File(staging, requiredFile).isFile) {
            staging.deleteRecursively()
            throw IllegalStateException("$assetName did not contain $requiredFile.")
        }
        writeInstallMarker(File(staging, INSTALL_MARKER_NAME), payloadId, archiveSha256)
        target.deleteRecursively()
        if (!staging.renameTo(target)) throw IllegalStateException("Could not activate $assetName at ${target.absolutePath}.")
        cleanupOldVersions(parent, target)
        log("Installed $assetName files=$extractedFiles bytes=$extractedBytes id=$payloadId.")
        return target
    }

    private fun installVersionedPlatformAssets(): File {
        val manifestText = readAssetTextOrBlank(PLATFORM_MANIFEST_ASSET)
        val platformId = extractJsonString(manifestText, "platformId")
        val treeSha256 = extractJsonString(manifestText, "treeSha256")
        val requiredFile = extractJsonString(manifestText, "requiredFile")
            .ifBlank { "combat-managed/Data/Managed/Assembly-CSharp.dll" }
        if (platformId.isBlank() || treeSha256.isBlank()) {
            throw IllegalStateException("Android platform manifest is missing or invalid.")
        }
        val parent = File(RevivalSideSettingsStore.appRoot(context), "platform").apply { mkdirs() }
        val target = File(parent, versionKey(treeSha256))
        val marker = File(target, INSTALL_MARKER_NAME)
        if (payloadMarkerMatches(marker, platformId, treeSha256) && File(target, requiredFile).isFile) {
            prepareDeviceCombatRuntime(target)
            cleanupOldVersions(parent, target)
            return target
        }
        val staging = File(parent, "${target.name}.installing")
        staging.deleteRecursively()
        copyAssetTree(PLATFORM_ASSET_ROOT, staging)
        installAndroidLuaCache(staging)
        prepareDeviceCombatRuntime(staging)
        if (!File(staging, requiredFile).isFile) {
            staging.deleteRecursively()
            throw IllegalStateException("Android platform assets did not contain $requiredFile.")
        }
        writeInstallMarker(File(staging, INSTALL_MARKER_NAME), platformId, treeSha256)
        target.deleteRecursively()
        if (!staging.renameTo(target)) throw IllegalStateException("Could not activate Android platform assets.")
        cleanupOldVersions(parent, target)
        log("Installed Android platform assets id=$platformId.")
        return target
    }

    private fun installAndroidLuaCache(platformRoot: File) {
        val updateRoot = File(platformRoot, "server-data/android-client-update")
        val manifest = File(updateRoot, "lua-cache-manifest.json")
        if (!manifest.isFile) return
        if (!assetExists(ANDROID_LUA_CACHE_ARCHIVE_ASSET)) {
            throw IllegalStateException("Android Lua cache manifest is present but its archive is missing.")
        }
        val destinationRoot = File(updateRoot, "lua-cache")
        destinationRoot.deleteRecursively()
        destinationRoot.mkdirs()
        var extractedFiles = 0
        ZipInputStream(BufferedInputStream(context.assets.open(ANDROID_LUA_CACHE_ARCHIVE_ASSET))).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                try {
                    val destination = safePayloadDestination(destinationRoot, entry.name) ?: continue
                    if (entry.isDirectory) {
                        destination.mkdirs()
                    } else {
                        destination.parentFile?.mkdirs()
                        destination.outputStream().use { zip.copyTo(it) }
                        extractedFiles += 1
                    }
                } finally {
                    zip.closeEntry()
                }
            }
        }
        if (extractedFiles == 0 || File(destinationRoot, "AB_SCRIPT").listFiles().isNullOrEmpty()) {
            destinationRoot.deleteRecursively()
            throw IllegalStateException("Android Lua cache archive is empty or missing AB_SCRIPT.")
        }
        log("Installed Android Lua cache files=$extractedFiles.")
    }

    private fun prepareDeviceCombatRuntime(root: File) {
        val activeAbi = Build.SUPPORTED_ABIS.orEmpty().firstOrNull { androidRuntimeIdentifier(it) != null }
            ?: throw IllegalStateException("This device ABI is not supported by the packaged combat runtime.")
        val activeRid = androidRuntimeIdentifier(activeAbi)
            ?: throw IllegalStateException("This device ABI is not supported by the packaged combat runtime.")
        val runtimeRoot = File(root, "combat-runtime")
        val activeRuntime = File(runtimeRoot, activeRid)
        val commonRuntime = File(runtimeRoot, "common")
        commonRuntime.listFiles()?.filter { it.isFile }?.forEach { common ->
            val destination = File(activeRuntime, common.name)
            if (!destination.exists()) common.copyTo(destination, overwrite = false)
        }
        runtimeRoot.listFiles()?.filter { it.isDirectory && it != activeRuntime }?.forEach { it.deleteRecursively() }

        val nativeManifest = File(activeRuntime, "native-libraries.txt")
        val nativeNames = nativeManifest.takeIf { it.isFile }
            ?.readLines(Charsets.UTF_8)
            ?.map(String::trim)
            ?.filter(String::isNotEmpty)
            .orEmpty()
        if (nativeNames.isEmpty()) {
            throw IllegalStateException("$activeRid combat runtime has no native library manifest.")
        }
        val nativeLibraryDir = File(context.applicationInfo.nativeLibraryDir)
        nativeNames.forEach { name ->
            if (name.contains('/') || name.contains('\\') || !name.endsWith(".so")) {
                throw IllegalStateException("Invalid native combat library name: $name")
            }
            val source = File(nativeLibraryDir, name)
            if (!source.isFile) {
                throw IllegalStateException("Packaged native combat library is missing: $name")
            }
            val destination = File(activeRuntime, name)
            destination.delete()
            Os.symlink(source.absolutePath, destination.absolutePath)
        }

        val pluginRoot = File(root, "combat-managed/Data/Plugins")
        pluginRoot.listFiles()?.filter { it.isDirectory && it.name != activeAbi }?.forEach { it.deleteRecursively() }
        log("Selected $activeRid combat runtime; linked ${nativeNames.size} packaged native libraries and removed other ABIs from the installed cache.")
    }

    private fun writeInstallMarker(marker: File, payloadId: String, sha256: String) {
        marker.writeText(
            "{\"payloadId\":\"${escapeJson(payloadId)}\",\"sha256\":\"${escapeJson(sha256)}\",\"installedAt\":\"${Instant.now()}\"}\n",
            Charsets.UTF_8,
        )
    }

    private fun cleanupOldVersions(parent: File, active: File) {
        parent.listFiles()?.filter { it != active }?.forEach { it.deleteRecursively() }
    }

    private fun versionKey(value: String): String {
        return value.lowercase().replace(Regex("[^a-z0-9._-]"), "-").trim('-').take(64)
            .ifBlank { throw IllegalStateException("Packaged asset version is missing.") }
    }

    private fun copyAssetTree(assetPath: String, destination: File) {
        val children = context.assets.list(assetPath)?.toList().orEmpty()
        if (children.isEmpty()) {
            context.assets.open(assetPath).use { input ->
                destination.parentFile?.mkdirs()
                destination.outputStream().use { output -> input.copyTo(output) }
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

    private fun extractJsonString(json: String, key: String): String {
        if (json.isBlank()) return ""
        val pattern = Regex("\"" + Regex.escape(key) + "\"\\s*:\\s*\"([^\"]*)\"")
        return pattern.find(json)?.groupValues?.getOrNull(1).orEmpty()
    }

    companion object {
        private val nativeStarted = AtomicBoolean(false)
        private const val PAYLOAD_ARCHIVE_ASSET = "revivalside-payload.zip"
        private const val PAYLOAD_MANIFEST_ASSET = "revivalside-payload-manifest.json"
        private const val GAMEPLAY_TABLES_ARCHIVE_ASSET = "revivalside-gameplay-tables.zip"
        private const val GAMEPLAY_TABLES_MANIFEST_ASSET = "revivalside-gameplay-tables-manifest.json"
        private const val ANDROID_LUA_CACHE_ARCHIVE_ASSET = "revivalside-android-lua-cache.zip"
        private const val PLATFORM_ASSET_ROOT = "revivalside-listener"
        private const val PLATFORM_MANIFEST_ASSET = "revivalside-platform-manifest.json"
        private const val INSTALL_MARKER_NAME = ".installed.json"
        private const val ARCHIVE_PROGRESS_FILE_INTERVAL = 250
    }
}

private fun escapeJson(value: String): String {
    return value
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
}

private fun jsString(value: String): String = "\"" + escapeJson(value) + "\""
