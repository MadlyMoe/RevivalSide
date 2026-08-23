package dev.revivalside.capture.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.Environment
import android.provider.MediaStore
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalTime
import java.time.format.DateTimeFormatter

class MainActivity : Activity() {
    private lateinit var packageInput: EditText
    private lateinit var gamePortInput: EditText
    private lateinit var httpPortInput: EditText
    private lateinit var assetCdnInput: EditText
    private lateinit var redirectPortsInput: EditText
    private lateinit var eventDateInput: EditText
    private lateinit var loginBackgroundInput: EditText
    private lateinit var joinLobbyAckInput: EditText
    private lateinit var nodePathInput: EditText
    private lateinit var dotnetPathInput: EditText
    private lateinit var listenerStatusText: TextView
    private lateinit var vpnStatusText: TextView
    private lateinit var exportText: TextView
    private lateinit var logText: TextView
    private lateinit var startButton: Button
    private lateinit var userManagerOpenButton: Button
    private lateinit var downloadProfileButton: Button
    private lateinit var payloadImportButton: Button
    private lateinit var clientStatusText: TextView
    private lateinit var payloadStatusText: TextView
    private lateinit var payloadProgress: ProgressBar
    private val timeFormat = DateTimeFormatter.ofPattern("HH:mm:ss")
    private val handler = Handler(Looper.getMainLooper())
    private var pendingVpnMode = CounterSideVpnService.MODE_CAPTURE
    private var launchAfterStart = false
    private var launchAfterCapture = false
    private var listenerReadyForLaunch = false
    private var vpnReadyForLaunch = false
    private var startFlowToken = 0
    private var listenerProgressAtMs = 0L
    private var clientDetectionToken = 0
    private var clientMode = AndroidClientMode.UNSUPPORTED
    private var primaryOperationRunning = false
    private var payloadImportBusy = false
    private var automaticProfileImportRunning = false
    private var activityResumed = false
    private var pendingProfileTarget: ProfileExportTarget? = null

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val message = intent.getStringExtra(CounterSideVpnService.EXTRA_MESSAGE)
                ?: intent.getStringExtra(RevivalSideListenerService.EXTRA_MESSAGE)
                ?: return
            when (intent.action) {
                CounterSideVpnService.ACTION_STATUS -> {
                    vpnStatusText.text = message
                    appendLog("VPN: $message")
                    if (message.startsWith("Redirecting") || message.contains("already", ignoreCase = true)) {
                        vpnReadyForLaunch = true
                        tryLaunchAfterStart()
                    }
                    if (launchAfterCapture && message.startsWith("Recording")) {
                        launchAfterCapture = false
                        appendLog("Launching CounterSide for JOIN_LOBBY_ACK capture")
                        launchCounterSide()
                    } else if (launchAfterCapture && message.startsWith("Failed")) {
                        launchAfterCapture = false
                        setPrimaryOperationRunning(false)
                    }
                    val exportPath = intent.getStringExtra(CounterSideVpnService.EXTRA_EXPORT_PATH)
                    if (!exportPath.isNullOrBlank()) {
                        exportText.text = exportPath
                        if (activityResumed) maybeImportCapturedProfile()
                    }
                    if (message == "Stopped" && !launchAfterCapture && !launchAfterStart) setPrimaryOperationRunning(false)
                }
                RevivalSideListenerService.ACTION_STATUS -> {
                    listenerStatusText.text = message
                    appendLog("Listener: $message")
                    if (isListenerStartupProgress(message)) listenerProgressAtMs = SystemClock.elapsedRealtime()
                    if (message.startsWith("Listener online") && clientMode == AndroidClientMode.PATCHED) {
                        setPrimaryOperationRunning(true)
                    }
                    if (message == "Stopped" && clientMode == AndroidClientMode.PATCHED && !automaticProfileImportRunning) {
                        setPrimaryOperationRunning(false)
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        window.decorView.isFocusableInTouchMode = true
        window.decorView.requestFocus()
        requestNotificationPermissionIfNeeded()
        registerStatusReceiver()
        appendLog("Ready")
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
        refreshInstalledClientMode()
        handler.post { maybeImportCapturedProfile() }
    }

    override fun onPause() {
        activityResumed = false
        super.onPause()
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(statusReceiver) }
        super.onDestroy()
    }

    @Deprecated("VPN permission result uses the platform callback for this no-dependency app.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PAYLOAD_ZIP_REQUEST) {
            if (resultCode == RESULT_OK && data?.data != null) {
                val uri = data.data!!
                runCatching {
                    contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                importPayloadZip(uri)
            } else {
                setPayloadImportBusy(false)
                appendLog("Payload ZIP selection cancelled")
            }
        } else if (requestCode == PROFILE_JSON_REQUEST) {
            val target = pendingProfileTarget
            pendingProfileTarget = null
            if (resultCode == RESULT_OK && data?.data != null && target != null) {
                setDownloadProfileBusy(true)
                Thread {
                    val result = runCatching { streamActiveProfileTo(data.data!!, target) }
                    runOnUiThread {
                        setDownloadProfileBusy(false)
                        result.onSuccess {
                            appendLog("Active profile saved to Downloads")
                        }.onFailure {
                            appendLog("Active profile download failed: ${it.message}")
                        }
                    }
                }.start()
            } else {
                setDownloadProfileBusy(false)
                appendLog("Active profile download cancelled")
            }
        } else if (requestCode == VPN_REQUEST && resultCode == RESULT_OK) {
            startVpnService(pendingVpnMode)
        } else if (requestCode == VPN_REQUEST && launchAfterStart) {
            failStartOperation("VPN permission was not granted")
        } else if (requestCode == VPN_REQUEST && launchAfterCapture) {
            launchAfterCapture = false
            setPrimaryOperationRunning(false)
            appendLog("Official server capture needs VPN permission")
        }
    }

    private fun buildUi(): View {
        val settings = RevivalSideSettingsStore.load(this)
        val root = FrameLayout(this).apply {
            background = verticalGradient(0xff101827.toInt(), 0xff322334.toInt())
            isFocusableInTouchMode = true
            descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(22), dp(22), dp(174))
        }

        content.addView(TextView(this).apply {
            text = "RevivalSide"
            textSize = 38f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xffffffff.toInt())
        })
        content.addView(TextView(this).apply {
            text = "Android listener"
            textSize = 16f
            setTextColor(0xffcbd5e1.toInt())
            setPadding(0, dp(1), 0, dp(18))
        })

        val statusPanel = panel().apply {
            addView(eyebrow("Status"))
            listenerStatusText = statusText("Idle")
            addView(listenerStatusText)
            vpnStatusText = statusText("VPN idle")
            addView(vpnStatusText)
            clientStatusText = mutedText("Detecting installed Counter:Side...", 13f)
            addView(clientStatusText, fillWrap().apply { topMargin = dp(4) })
            addView(chipRow(
                chip("Target", settings.targetPackage.substringAfterLast('.')),
                chip("Port", settings.gamePort.toString()),
            ))
            addView(userManagerButton(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)).apply {
                topMargin = dp(12)
            })
            addView(createDownloadProfileButton(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)).apply {
                topMargin = dp(8)
            })
            payloadStatusText = mutedText(
                if (AndroidPayloadCache.activeRoot(this@MainActivity) != null) "Android payload cache ready" else "Android payload ZIP not imported",
                13f,
            )
            addView(payloadStatusText, fillWrap().apply { topMargin = dp(12) })
            payloadProgress = ProgressBar(
                this@MainActivity,
                null,
                android.R.attr.progressBarStyleHorizontal,
            ).apply {
                max = 1000
                progress = 0
                visibility = View.GONE
            }
            addView(payloadProgress, fillWrap().apply { topMargin = dp(6) })
            addView(createPayloadImportButton(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)).apply {
                topMargin = dp(8)
            })
            addView(createDownloadPatchedApkButton(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)).apply {
                topMargin = dp(8)
            })
        }
        content.addView(statusPanel, fillWrapWithBottom(dp(14)))

        val configPanel = panel().apply {
            addView(eyebrow("Connection"))
            packageInput = singleLineInput(settings.targetPackage)
            addView(label("CounterSide package"))
            addView(packageInput, fillWrap())

            val portRow = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.START
            }
            gamePortInput = numberInput(settings.gamePort.toString())
            httpPortInput = numberInput(settings.httpPort.toString())
            portRow.addView(fieldColumn("Game", gamePortInput), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            portRow.addView(fieldColumn("HTTP", httpPortInput), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(portRow)

            assetCdnInput = singleLineInput(settings.assetCdnBaseUrl)
            addView(label("Android asset CDN"))
            addView(assetCdnInput, fillWrap())

            redirectPortsInput = singleLineInput(settings.redirectPortsText)
            addView(label("VPN ports"))
            addView(redirectPortsInput, fillWrap())

            eventDateInput = singleLineInput(settings.eventDate)
            addView(label("Event date (YYYY-MM-DD, blank = live clock)"))
            addView(eventDateInput, fillWrap())

            loginBackgroundInput = singleLineInput(settings.loginBackground)
            addView(label("Login background (auto or ID)"))
            addView(loginBackgroundInput, fillWrap())

            joinLobbyAckInput = singleLineInput(settings.joinLobbyAckMode)
            addView(label("JOIN_LOBBY_ACK"))
            addView(joinLobbyAckInput, fillWrap())

            nodePathInput = singleLineInput(settings.nodePath)
            dotnetPathInput = singleLineInput(settings.dotnetPath)
            addView(label("Node path"))
            addView(nodePathInput, fillWrap())
            addView(label("Dotnet path"))
            addView(dotnetPathInput, fillWrap())
        }
        content.addView(configPanel, fillWrapWithBottom(dp(14)))

        val logPanel = panel().apply {
            addView(eyebrow("Activity"))
            logText = TextView(this@MainActivity).apply {
                textSize = 12f
                setTextColor(0xffdbeafe.toInt())
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = rounded(0xaa06090d.toInt(), dp(10), 0x335f7ea0)
                typeface = Typeface.MONOSPACE
            }
            addView(logText, fillWrap())
        }
        content.addView(logPanel, fillWrapWithBottom(dp(14)))

        val exportPanel = panel().apply {
            addView(eyebrow("Latest Export"))
            exportText = mutedText(CaptureRepository.latestExport(this@MainActivity)?.absolutePath ?: "No export yet", 13f)
            addView(exportText)
            addView(Button(this@MainActivity).apply {
                text = "EXPORT SAVE + LOGS"
                setOnClickListener { exportSaveAndLogs() }
            }, fillWrap().apply { topMargin = dp(10) })
        }
        content.addView(exportPanel, fillWrap())

        val scroll = ScrollView(this).apply {
            isFillViewport = false
            addView(content)
        }
        root.addView(scroll, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(bottomBar(), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        return root
    }

    private fun bottomBar(): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(14), dp(18), dp(18))
            background = verticalGradient(0xee070b12.toInt(), 0xff0b1020.toInt())

            addView(LinearLayout(this@MainActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                orientation = LinearLayout.VERTICAL
                addView(TextView(this@MainActivity).apply {
                    text = "Ready"
                    textSize = 13f
                    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                    setTextColor(0xffffffff.toInt())
                })
                addView(mutedText("Official profile extraction or patched RevivalSide", 12f))
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(10)
            })

            startButton = Button(this@MainActivity).apply {
                text = "DETECTING GAME"
                textSize = 16f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xff06111f.toInt())
                background = rounded(0xfff8fafc.toInt(), dp(10), 0xffffffff.toInt())
                setPadding(dp(10), 0, dp(10), 0)
                minHeight = dp(58)
                isEnabled = false
                setOnClickListener { onPrimaryButtonPressed() }
            }
            addView(startButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(62)))
        }
    }

    private fun onPrimaryButtonPressed() {
        if (primaryOperationRunning) {
            stopOperation()
            return
        }
        when (clientMode) {
            AndroidClientMode.OFFICIAL -> startJoinLobbyAckCapture()
            AndroidClientMode.PATCHED -> startOperation()
            else -> refreshInstalledClientMode()
        }
    }

    private fun startOperation() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        stopVpnService()
        setUserManagerButtonBusy(false)
        setPrimaryOperationRunning(true)
        launchAfterStart = true
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        appendLog("Validating patched Counter:Side client")
        Thread {
            val clientValidation = validateInstalledAndroidClient(applicationContext, settings.targetPackage, settings.httpPort)
            val validation = if (clientValidation.ok) {
                val importedPayload = AndroidPayloadCache.validate(applicationContext)
                val payloadValidation = if (importedPayload.ok || settings.assetCdnBaseUrl.startsWith("http://127.0.0.1:${settings.httpPort}/")) {
                    importedPayload
                } else {
                    validateAndroidPayloadHost(applicationContext, settings.assetCdnBaseUrl)
                }
                if (payloadValidation.ok) payloadValidation.copy(message = "${clientValidation.message}; ${payloadValidation.message}") else payloadValidation
            } else {
                clientValidation
            }
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (!validation.ok) {
                    failStartOperation(validation.message)
                    return@runOnUiThread
                }
                appendLog(validation.message)
                vpnReadyForLaunch = true
                startListener(settings)
                waitForListenerHealth(settings, token, attempt = 0)
            }
        }.start()
    }

    private fun openPayloadZipPicker() {
        startFlowToken += 1
        launchAfterStart = false
        launchAfterCapture = false
        setPrimaryOperationRunning(false)
        stopVpnService()
        stopListener()
        setPayloadImportBusy(true)
        appendLog("Select the downloaded RevivalSide Android payload ZIP")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        runCatching { startActivityForResult(intent, PAYLOAD_ZIP_REQUEST) }
            .onFailure {
                setPayloadImportBusy(false)
                appendLog("Could not open the Android file picker: ${it.message}")
            }
    }

    private fun importPayloadZip(uri: Uri) {
        setPayloadImportBusy(true)
        payloadStatusText.text = "Checking payload manifest..."
        payloadProgress.progress = 0
        payloadProgress.visibility = View.VISIBLE
        Thread {
            val result = AndroidPayloadCache.importZip(applicationContext, uri) { current ->
                runOnUiThread {
                    val ratio = if (current.totalBytes > 0L) current.bytes.toDouble() / current.totalBytes else 0.0
                    payloadProgress.progress = (ratio * payloadProgress.max).toInt().coerceIn(0, payloadProgress.max)
                    payloadStatusText.text = "Importing ${current.files}/${current.totalFiles} (${(ratio * 100).toInt()}%) • ${current.currentPath.substringAfterLast('/')}"
                }
            }
            runOnUiThread {
                setPayloadImportBusy(false)
                if (result.ok) {
                    payloadProgress.progress = payloadProgress.max
                    payloadStatusText.text = "Android payload cache ready"
                    assetCdnInput.setText(AndroidPayloadCache.localCdnBaseUrl(RevivalSideSettingsStore.parsePort(httpPortInput.text.toString(), DEFAULT_HTTP_PORT)))
                    saveSettingsFromInputs()
                    appendLog(result.message)
                } else {
                    payloadProgress.visibility = View.GONE
                    payloadStatusText.text = result.message
                    appendLog(result.message)
                }
            }
        }.start()
    }

    private fun startJoinLobbyAckCapture() {
        saveSettingsFromInputs()
        ++startFlowToken
        launchAfterStart = false
        launchAfterCapture = true
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        setUserManagerButtonBusy(false)
        setPrimaryOperationRunning(true)
        appendLog("Starting official JOIN_LOBBY_ACK capture")
        stopVpnService()
        stopListener()
        beginVpnFlow(CounterSideVpnService.MODE_CAPTURE)
    }

    private fun stopOperation() {
        startFlowToken += 1
        launchAfterStart = false
        launchAfterCapture = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        automaticProfileImportRunning = false
        setUserManagerButtonBusy(false)
        setDownloadProfileBusy(false)
        setPrimaryOperationRunning(false)
        appendLog("Stop requested")
        stopVpnService()
        stopListener()
    }

    private fun tryLaunchAfterStart() {
        if (!launchAfterStart || !listenerReadyForLaunch || !vpnReadyForLaunch) return
        launchAfterStart = false
        appendLog("Launching CounterSide")
        launchCounterSide()
    }

    private fun failStartOperation(message: String) {
        launchAfterStart = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        appendLog(message)
        setPrimaryOperationRunning(false)
    }

    private fun waitForListenerHealth(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        if (attempt == 0) {
            listenerStatusText.text = "Waiting for listener health"
            appendLog("Waiting for listener health on 127.0.0.1:${listenerApiPort(settings)}")
        }
        Thread {
            val health = readListenerHealth(settings)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (health.ready) {
                    listenerStatusText.text = "Listener ready"
                    appendLog("Listener health ready")
                    switchToRevivalSideAndWarmup(settings, token)
                    return@runOnUiThread
                }
                if (health.fatalMessage.isNotBlank()) {
                    failStartOperation(health.fatalMessage)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    failStartOperation("Listener health timed out")
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for listener health (${attempt}s)")
                }
                handler.postDelayed({
                    waitForListenerHealth(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun switchToRevivalSideAndWarmup(settings: RevivalSideSettings, token: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        listenerStatusText.text = "Selecting RevivalSide server"
        Thread {
            val result = requestServerInfoMode(settings, SERVER_MODE_REVIVALSIDE)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (!result.ok) {
                    failStartOperation("Could not select RevivalSide server${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                    return@runOnUiThread
                }
                appendLog("Server switched to RevivalSide")
                waitForListenerWarmup(settings, token)
            }
        }.start()
    }

    private fun waitForListenerWarmup(settings: RevivalSideSettings, token: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        listenerStatusText.text = "Warming lobby data"
        appendLog("Warming lobby data before launch")
        Thread {
            val result = requestListenerWarmup(settings)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (result.ok) {
                    listenerReadyForLaunch = true
                    listenerStatusText.text = "Listener ready"
                    appendLog("Lobby warmup ready${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                    tryLaunchAfterStart()
                } else {
                    failStartOperation("Lobby warmup failed${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                }
            }
        }.start()
    }

    private fun maybeImportCapturedProfile() {
        if (!activityResumed || automaticProfileImportRunning || !CaptureRepository.hasPendingProfileImport(this)) return
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        launchAfterStart = false
        launchAfterCapture = false
        automaticProfileImportRunning = true
        listenerProgressAtMs = SystemClock.elapsedRealtime()
        appendLog("Importing captured profile into User Manager")
        Thread {
            val extracted = runCatching {
                CaptureRepository.extractLatestJoinLobbyAckToCapturedGameFlow(applicationContext)
            }
            runOnUiThread {
                if (token != startFlowToken) {
                    automaticProfileImportRunning = false
                    return@runOnUiThread
                }
                extracted.onSuccess { result ->
                    exportText.text = result.targetDir.absolutePath
                    appendLog("Prepared captured profile files=${result.copiedFiles} bytes=${result.copiedBytes}")
                    startListener(settings)
                    waitForListenerHealthForImport(settings, token, attempt = 0)
                }.onFailure { error ->
                    automaticProfileImportRunning = false
                    appendLog("Captured profile preparation failed: ${error.message}")
                }
            }
        }.start()
    }

    private fun waitForListenerHealthForImport(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (token != startFlowToken) return
        if (attempt == 0) {
            listenerStatusText.text = "Waiting for listener import API"
            appendLog("Waiting for listener import API on 127.0.0.1:${listenerApiPort(settings)}")
        }
        Thread {
            val ready = isListenerHealthReady(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (ready) {
                    listenerStatusText.text = "Listener ready"
                    importLatestOfficialProfile(settings, token)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    appendLog("Listener import API timed out")
                    automaticProfileImportRunning = false
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for listener import API (${attempt}s)")
                }
                handler.postDelayed({
                    waitForListenerHealthForImport(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun importLatestOfficialProfile(settings: RevivalSideSettings, token: Int) {
        if (token != startFlowToken) return
        appendLog("Importing copied JOIN_LOBBY_ACK profile")
        Thread {
            val result = requestOfficialProfileImport(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (result.ok) {
                    CaptureRepository.markLatestProfileImported(applicationContext)
                    appendLog("Imported profile${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                } else {
                    appendLog("Official profile import failed${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                }
                automaticProfileImportRunning = false
            }
        }.start()
    }

    private fun isListenerHealthReady(settings: RevivalSideSettings): Boolean {
        return readListenerHealth(settings).ready
    }

    private fun readListenerHealth(settings: RevivalSideSettings): ListenerHealth {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${listenerApiPort(settings)}/launcher/api/health").openConnection() as HttpURLConnection).apply {
                connectTimeout = 1000
                readTimeout = 1000
                requestMethod = "GET"
                useCaches = false
            }
            if (connection.responseCode !in 200..299) return ListenerHealth(false)
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val compact = body.filterNot { it.isWhitespace() }
            val correctPort = compact.contains("\"port\":${settings.gamePort}")
            if (correctPort && compact.contains("\"ok\":true")) {
                ListenerHealth(true)
            } else if (correctPort && compact.contains("\"combatHost\":{\"enabled\":") && compact.contains("\"ready\":false")) {
                ListenerHealth(false, extractJsonString(compact, "error").ifBlank { "Managed combat host did not start; game launch was blocked." })
            } else {
                ListenerHealth(false)
            }
        } catch (_: Exception) {
            ListenerHealth(false)
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestListenerWarmup(settings: RevivalSideSettings): WarmupResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${listenerApiPort(settings)}/launcher/api/warmup").openConnection() as HttpURLConnection).apply {
                connectTimeout = LISTENER_WARMUP_CONNECT_TIMEOUT_MS
                readTimeout = LISTENER_WARMUP_READ_TIMEOUT_MS
                requestMethod = "POST"
                useCaches = false
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val compact = body.filterNot { it.isWhitespace() }
            if (status in 200..299 && compact.contains("\"ok\":true")) {
                WarmupResult(true, extractWarmupSummary(compact))
            } else {
                WarmupResult(false, "HTTP $status")
            }
        } catch (error: Exception) {
            WarmupResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestServerInfoMode(settings: RevivalSideSettings, mode: String): ServerInfoModeResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${listenerApiPort(settings)}/launcher/api/server-info-mode?mode=$mode").openConnection() as HttpURLConnection).apply {
                connectTimeout = 1000
                readTimeout = 2000
                requestMethod = "POST"
                useCaches = false
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val compact = response.filterNot { it.isWhitespace() }
            if (status in 200..299 && compact.contains("\"ok\":true") && compact.contains("\"serverInfoMode\":\"$mode\"")) {
                ServerInfoModeResult(true)
            } else if (status == 404 && mode == SERVER_MODE_REVIVALSIDE) {
                ServerInfoModeResult(true, "PC 0.4.0 default")
            } else {
                ServerInfoModeResult(false, extractJsonString(compact, "error").ifBlank { "HTTP $status" })
            }
        } catch (error: Exception) {
            ServerInfoModeResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestOfficialProfileImport(settings: RevivalSideSettings): ImportResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${listenerApiPort(settings)}/launcher/api/official-profile/import-latest").openConnection() as HttpURLConnection).apply {
                connectTimeout = LISTENER_WARMUP_CONNECT_TIMEOUT_MS
                readTimeout = LISTENER_WARMUP_READ_TIMEOUT_MS
                requestMethod = "POST"
                doOutput = true
                useCaches = false
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            val body = """{"switchActive":true}""".toByteArray(Charsets.UTF_8)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val compact = response.filterNot { it.isWhitespace() }
            if (status in 200..299 && compact.contains("\"ok\":true")) {
                ImportResult(true, extractImportSummary(compact))
            } else {
                ImportResult(false, extractJsonString(compact, "error").ifBlank { "HTTP $status" })
            }
        } catch (error: Exception) {
            ImportResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun extractWarmupSummary(compactJson: String): String {
        val warmed = Regex("\"warmed\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        val duration = Regex("\"durationMs\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        return listOfNotNull(
            warmed?.let { "$it profile(s)" },
            duration?.let { "${it}ms" },
        ).joinToString(" ")
    }

    private fun extractImportSummary(compactJson: String): String {
        val nickname = extractJsonString(compactJson, "nickname")
        val userUid = extractJsonString(compactJson, "userUid")
        val units = Regex("\"units\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        return listOfNotNull(
            nickname.takeIf { it.isNotBlank() },
            userUid.takeIf { it.isNotBlank() }?.let { "uid=$it" },
            units?.let { "units=$it" },
        ).joinToString(" ")
    }

    private fun extractJsonString(compactJson: String, key: String): String {
        return Regex("\"${Regex.escape(key)}\":\"((?:\\\\.|[^\"])*)\"")
            .find(compactJson)
            ?.groupValues
            ?.getOrNull(1)
            ?.replace("\\\"", "\"")
            ?.replace("\\\\", "\\")
            .orEmpty()
    }

    private fun startListener(settings: RevivalSideSettings = saveSettingsFromInputs()) {
        listenerProgressAtMs = SystemClock.elapsedRealtime()
        val service = Intent(this, RevivalSideListenerService::class.java).apply {
            action = RevivalSideListenerService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        appendLog("Starting listener on 127.0.0.1:${settings.httpPort}")
    }

    private fun listenerHealthTimedOut(): Boolean {
        return SystemClock.elapsedRealtime() - listenerProgressAtMs >= LISTENER_HEALTH_TIMEOUT_MS
    }

    private fun isListenerStartupProgress(message: String): Boolean {
        return message.startsWith("Preparing ") ||
            message.startsWith("Installed ") ||
            message.startsWith("Starting Android listener") ||
            message.startsWith("Bundled combat host") ||
            message.startsWith("Started embedded ") ||
            message.startsWith("Started bundled ")
    }

    private fun stopListener() {
        startService(Intent(this, RevivalSideListenerService::class.java).apply {
            action = RevivalSideListenerService.ACTION_STOP
        })
        appendLog("Stopping listener")
    }

    private fun beginVpnFlow(mode: String) {
        saveSettingsFromInputs()
        pendingVpnMode = mode
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, VPN_REQUEST)
        } else {
            startVpnService(mode)
        }
    }

    private fun startVpnService(mode: String) {
        val settings = saveSettingsFromInputs()
        val service = Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_START
            putExtra(CounterSideVpnService.EXTRA_TARGET_PACKAGE, settings.targetPackage)
            putExtra(CounterSideVpnService.EXTRA_MODE, mode)
            putExtra(CounterSideVpnService.EXTRA_LISTENER_PORT, settings.gamePort)
            putExtra(CounterSideVpnService.EXTRA_HTTP_PORT, settings.httpPort)
            putExtra(CounterSideVpnService.EXTRA_REDIRECT_PORTS, settings.redirectPortsText)
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        appendLog(if (mode == CounterSideVpnService.MODE_LISTENER) "Starting VPN redirect" else "Starting official login capture")
    }

    private fun stopVpnService() {
        startService(Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_STOP
        })
        appendLog("Stopping VPN")
    }

    private fun refreshInstalledClientMode() {
        if (!::packageInput.isInitialized) return
        val targetPackage = packageInput.text.toString().trim().ifBlank { DEFAULT_COUNTERSIDE_PACKAGE }
        val token = ++clientDetectionToken
        if (!primaryOperationRunning) {
            startButton.isEnabled = false
            startButton.text = "DETECTING GAME"
        }
        Thread {
            val detection = detectInstalledAndroidClient(applicationContext, targetPackage)
            runOnUiThread {
                if (token != clientDetectionToken) return@runOnUiThread
                clientMode = detection.mode
                clientStatusText.text = detection.message
                appendLog(detection.message)
                if (clientMode == AndroidClientMode.PATCHED && isListenerServiceRunning()) {
                    primaryOperationRunning = true
                }
                refreshLauncherControls()
            }
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun isListenerServiceRunning(): Boolean =
        getSystemService(ActivityManager::class.java)
            .getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == RevivalSideListenerService::class.java.name }

    private fun setPrimaryOperationRunning(running: Boolean) {
        primaryOperationRunning = running
        refreshLauncherControls()
    }

    private fun refreshLauncherControls() {
        if (::startButton.isInitialized) {
            startButton.text = when {
                primaryOperationRunning -> "STOP"
                clientMode == AndroidClientMode.OFFICIAL -> "EXTRACT GAME PROFILE"
                clientMode == AndroidClientMode.PATCHED -> "START"
                clientMode == AndroidClientMode.MISSING -> "COUNTER:SIDE NOT INSTALLED"
                else -> "UNSUPPORTED GAME VERSION"
            }
            startButton.isEnabled = primaryOperationRunning ||
                (!payloadImportBusy && (clientMode == AndroidClientMode.OFFICIAL || clientMode == AndroidClientMode.PATCHED))
        }
        if (::payloadImportButton.isInitialized) {
            val enabled = clientMode == AndroidClientMode.PATCHED && !payloadImportBusy
            payloadImportButton.isEnabled = enabled
            payloadImportButton.alpha = if (enabled) 1f else 0.45f
            payloadImportButton.text = if (payloadImportBusy) "IMPORTING..." else "IMPORT PAYLOAD ZIP"
        }
    }

    private fun openUserManager() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        val url = userManagerUrl(settings)
        launchAfterStart = false
        launchAfterCapture = false
        setUserManagerButtonBusy(true)
        appendLog("Opening user manager")
        startListener(settings)
        waitForUserManager(settings, token, url, attempt = 0)
    }

    private fun waitForUserManager(settings: RevivalSideSettings, token: Int, url: String, attempt: Int) {
        if (token != startFlowToken) return
        if (attempt == 0) listenerStatusText.text = "Opening user manager"
        Thread {
            val ready = isListenerHealthReady(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (ready) {
                    listenerStatusText.text = "Listener ready"
                    appendLog("User manager ready")
                    setUserManagerButtonBusy(false)
                    openUrl(url)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    appendLog("User manager timed out")
                    setUserManagerButtonBusy(false)
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for user manager (${attempt}s)")
                }
                handler.postDelayed({
                    waitForUserManager(settings, token, url, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun downloadActiveProfile() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        launchAfterStart = false
        launchAfterCapture = false
        listenerProgressAtMs = SystemClock.elapsedRealtime()
        setDownloadProfileBusy(true)
        appendLog("Preparing active User Manager profile download")
        startListener(settings)
        waitForActiveProfileDownload(settings, token, attempt = 0)
    }

    private fun waitForActiveProfileDownload(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (token != startFlowToken) return
        Thread {
            val ready = isListenerHealthReady(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (ready) {
                    fetchActiveProfile(settings, token)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    appendLog("Active profile download timed out")
                    setDownloadProfileBusy(false)
                    return@runOnUiThread
                }
                handler.postDelayed({
                    waitForActiveProfileDownload(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun fetchActiveProfile(settings: RevivalSideSettings, token: Int) {
        Thread {
            val result = requestActiveProfileTarget(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                setDownloadProfileBusy(false)
                if (!result.ok || result.target == null) {
                    appendLog("Active profile download failed: ${result.summary}")
                    return@runOnUiThread
                }
                val target = result.target
                setDownloadProfileBusy(true)
                Thread {
                    val saved = runCatching { saveActiveProfileToDownloads(target) }
                    runOnUiThread {
                        setDownloadProfileBusy(false)
                        saved.onSuccess {
                            appendLog("Active profile saved to Downloads: ${target.fileName}")
                        }.onFailure {
                            appendLog("Active profile download failed: ${it.message}")
                        }
                    }
                }
            }
        }.start()
    }

    private fun requestActiveProfileTarget(settings: RevivalSideSettings): ProfileExportResult {
        return runCatching {
            val users = requestJson("http://127.0.0.1:${listenerApiPort(settings)}/user-manager/api/users")
            val activeUid = users.optJSONObject("meta")?.optString("activeUserUid").orEmpty()
            check(activeUid.isNotBlank()) { "User Manager has no active profile." }
            val activeUser = users.optJSONArray("users")?.let { summaries ->
                (0 until summaries.length())
                    .mapNotNull { summaries.optJSONObject(it) }
                    .firstOrNull { it.optString("userUid") == activeUid }
            }
            val nickname = activeUser?.optString("nickname").orEmpty()
            val fileName = "users-${sanitizeFileNamePart(nickname.ifBlank { activeUid })}-$activeUid.json"
            ProfileExportResult(
                ok = true,
                target = ProfileExportTarget(
                    fileName = fileName,
                    url = "http://127.0.0.1:${listenerApiPort(settings)}/user-manager/api/users/${Uri.encode(activeUid)}/export-json",
                ),
            )
        }.getOrElse { ProfileExportResult(false, summary = it.message.orEmpty()) }
    }

    private fun streamActiveProfileTo(uri: Uri, target: ProfileExportTarget) {
        val output = contentResolver.openOutputStream(uri, "w")
            ?: error("Android could not open the selected destination.")
        output.use { streamActiveProfileTo(it, target) }
    }

    private fun streamActiveProfileTo(output: java.io.OutputStream, target: ProfileExportTarget) {
        val connection = URL(target.url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 2000
            connection.readTimeout = LISTENER_WARMUP_READ_TIMEOUT_MS
            connection.requestMethod = "GET"
            connection.useCaches = false
            val status = connection.responseCode
            if (status !in 200..299) {
                val message = connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                val detail = runCatching { JSONObject(message).optString("error") }.getOrDefault("")
                error(detail.ifBlank { "HTTP $status" })
            }
            BufferedOutputStream(output, 1024 * 1024).use { bufferedOutput ->
                connection.inputStream.use { response ->
                    copyDbObjectFromExport(response, bufferedOutput)
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun saveActiveProfileToDownloads(target: ProfileExportTarget): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, target.fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Android could not create the Downloads file.")
            try {
                streamActiveProfileTo(uri, target)
                contentResolver.update(
                    uri,
                    ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                    null,
                    null,
                )
                return target.fileName
            } catch (error: Throwable) {
                contentResolver.delete(uri, null, null)
                throw error
            }
        }

        val directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        if (!directory.exists()) directory.mkdirs()
        val file = java.io.File(directory, target.fileName)
        java.io.FileOutputStream(file).use { streamActiveProfileTo(it, target) }
        return file.absolutePath
    }

    /** Streams only the wrapper's db object; never materializes the profile in the Android heap. */
    private fun copyDbObjectFromExport(source: java.io.InputStream, destination: java.io.OutputStream) {
        val input = BufferedInputStream(source, 1024 * 1024)
        expectJsonByte(input, '{'.code)
        while (true) {
            skipJsonWhitespace(input)
            input.mark(1)
            val marker = input.read()
            if (marker == '}'.code) error("Profile export did not contain a db object.")
            if (marker >= 0) input.reset()
            val key = readJsonString(input)
            skipJsonWhitespace(input)
            expectJsonByte(input, ':'.code)
            skipJsonWhitespace(input)
            if (key == "db") {
                expectJsonByte(input, '{'.code)
                destination.write('{'.code)
                copyBalancedJsonObject(input, destination)
                destination.write('\n'.code)
                return
            }
            skipJsonValue(input)
            skipJsonWhitespace(input)
            val separator = input.read()
            if (separator == '}'.code) error("Profile export did not contain a db object.")
            if (separator != ','.code) error("Malformed profile export envelope.")
        }
    }

    private fun copyBalancedJsonObject(input: BufferedInputStream, output: java.io.OutputStream) {
        var depth = 1
        var inString = false
        var escaped = false
        while (depth > 0) {
            val value = input.read()
            if (value < 0) error("Profile export ended before the db object was complete.")
            output.write(value)
            if (inString) {
                if (escaped) escaped = false
                else if (value == '\\'.code) escaped = true
                else if (value == '"'.code) inString = false
            } else {
                when (value) {
                    '"'.code -> inString = true
                    '{'.code -> depth += 1
                    '}'.code -> depth -= 1
                }
            }
        }
    }

    private fun readJsonString(input: BufferedInputStream): String {
        expectJsonByte(input, '"'.code)
        val value = StringBuilder()
        var escaped = false
        while (true) {
            val next = input.read()
            if (next < 0) error("Malformed profile export envelope.")
            if (escaped) {
                value.append(next.toChar())
                escaped = false
            } else if (next == '\\'.code) {
                escaped = true
            } else if (next == '"'.code) {
                return value.toString()
            } else {
                value.append(next.toChar())
            }
        }
    }

    private fun skipJsonValue(input: BufferedInputStream) {
        val first = input.read()
        if (first < 0) error("Malformed profile export envelope.")
        when (first) {
            '"'.code -> {
                var escaped = false
                while (true) {
                    val next = input.read()
                    if (next < 0) error("Malformed profile export envelope.")
                    if (escaped) escaped = false
                    else if (next == '\\'.code) escaped = true
                    else if (next == '"'.code) break
                }
            }
            '{'.code, '['.code -> {
                val open = first
                val close = if (open == '{'.code) '}'.code else ']'.code
                var depth = 1
                var inString = false
                var escaped = false
                while (depth > 0) {
                    val next = input.read()
                    if (next < 0) error("Malformed profile export envelope.")
                    if (inString) {
                        if (escaped) escaped = false
                        else if (next == '\\'.code) escaped = true
                        else if (next == '"'.code) inString = false
                    } else when (next) {
                        '"'.code -> inString = true
                        open -> depth += 1
                        close -> depth -= 1
                    }
                }
            }
            else -> while (true) {
                val next = input.read()
                if (next < 0 || next == ','.code || next == '}'.code) return
            }
        }
    }

    private fun skipJsonWhitespace(input: BufferedInputStream) {
        input.mark(1)
        while (true) {
            val next = input.read()
            if (next < 0 || !next.toChar().isWhitespace()) {
                if (next >= 0) input.reset()
                return
            }
            input.mark(1)
        }
    }

    private fun expectJsonByte(input: BufferedInputStream, expected: Int) {
        if (input.read() != expected) error("Malformed profile export envelope.")
    }

    private fun sanitizeFileNamePart(value: String): String = value
        .replace(Regex("[^A-Za-z0-9._-]+"), "_")
        .trim('_')
        .ifBlank { "profile" }

    private fun requestJson(url: String): JSONObject {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 2000
            connection.readTimeout = 15000
            connection.requestMethod = "GET"
            connection.useCaches = false
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val message = runCatching { JSONObject(body).optString("error") }.getOrDefault("")
                error(message.ifBlank { "HTTP $status" })
            }
            JSONObject(body)
        } finally {
            connection.disconnect()
        }
    }

    private fun launchCounterSide() {
        val settings = saveSettingsFromInputs()
        val launch = packageManager.getLaunchIntentForPackage(settings.targetPackage)
            ?: Intent(Intent.ACTION_MAIN).apply {
                setClassName(settings.targetPackage, "${settings.targetPackage}.CustomActivity")
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
        launch.addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        runCatching {
            startActivity(launch)
        }.onSuccess {
            appendLog("CounterSide launch intent sent")
        }.onFailure {
            appendLog("CounterSide launch failed: ${it.message}")
        }
    }

    private fun shareLatestExport() {
        val file = CaptureRepository.latestExport(this)
        if (file == null) {
            appendLog("No export is available yet")
            return
        }
        val uri = Uri.Builder()
            .scheme("content")
            .authority("dev.revivalside.officialprofilecapture.exports")
            .appendPath(file.name)
            .build()
        val share = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(share, "Share RevivalSide capture bundle"))
    }

    private fun exportSaveAndLogs() {
        appendLog("Exporting save and diagnostic logs")
        Thread {
            val result = runCatching { CaptureRepository.saveDiagnostics(applicationContext) }
            runOnUiThread {
                result.onSuccess { file ->
                    exportText.text = file.absolutePath
                    appendLog("Save and logs exported: ${file.name}")
                    shareLatestExport()
                }.onFailure { error ->
                    appendLog("Save/log export failed: ${error.message}")
                }
            }
        }.start()
    }

    private fun userManagerUrl(settings: RevivalSideSettings): String {
        return "http://127.0.0.1:${listenerApiPort(settings)}/user-manager"
    }

    private fun listenerApiPort(settings: RevivalSideSettings): Int =
        if (AndroidPayloadCache.activeRoot(applicationContext) != null) {
            AndroidPayloadCache.nodeMirrorPort(settings.httpPort)
        } else {
            settings.httpPort
        }

    private fun openUrl(url: String) {
        val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        runCatching {
            startActivity(browserIntent)
            appendLog("Browser open intent sent")
        }.onFailure {
            appendLog("Could not open $url: ${it.message}")
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private fun registerStatusReceiver() {
        val filter = IntentFilter().apply {
            addAction(CounterSideVpnService.ACTION_STATUS)
            addAction(RevivalSideListenerService.ACTION_STATUS)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(statusReceiver, filter, INTERNAL_BROADCAST_PERMISSION, null)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 45)
        }
    }

    private fun saveSettingsFromInputs(): RevivalSideSettings {
        val gamePort = RevivalSideSettingsStore.parsePort(gamePortInput.text.toString(), DEFAULT_GAME_PORT)
        val settings = RevivalSideSettings(
            targetPackage = packageInput.text.toString().trim().ifBlank { DEFAULT_COUNTERSIDE_PACKAGE },
            gamePort = gamePort,
            httpPort = RevivalSideSettingsStore.parsePort(httpPortInput.text.toString(), DEFAULT_HTTP_PORT),
            assetCdnBaseUrl = RevivalSideSettingsStore.normalizeAssetCdnUrl(assetCdnInput.text.toString()),
            redirectPorts = RevivalSideSettingsStore.parsePorts(redirectPortsInput.text.toString(), setOf(gamePort)),
            eventDate = eventDateInput.text.toString().trim(),
            loginBackground = RevivalSideSettingsStore.normalizeLoginBackground(loginBackgroundInput.text.toString()),
            joinLobbyAckMode = RevivalSideSettingsStore.normalizeJoinLobbyAckMode(joinLobbyAckInput.text.toString()),
            nodePath = nodePathInput.text.toString().trim(),
            dotnetPath = dotnetPathInput.text.toString().trim(),
        )
        RevivalSideSettingsStore.save(this, settings)
        return settings
    }

    private fun appendLog(message: String) {
        if (!::logText.isInitialized) return
        val line = "[${LocalTime.now().format(timeFormat)}] $message"
        logText.text = if (logText.text.isNullOrBlank()) line else "${logText.text}\n$line"
    }

    private fun panel(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(16))
            background = rounded(0xd90a0f19.toInt(), dp(12), 0x335f7ea0)
        }
    }

    private fun eyebrow(text: String): TextView {
        return TextView(this).apply {
            this.text = text.uppercase()
            textSize = 11f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xff93c5fd.toInt())
            setPadding(0, 0, 0, dp(8))
        }
    }

    private fun chipRow(vararg chips: View): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START
            setPadding(0, dp(4), 0, 0)
            chips.forEachIndexed { index, chip ->
                if (index > 0) addView(Space(this@MainActivity), LinearLayout.LayoutParams(dp(8), 1))
                addView(chip, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            }
        }
    }

    private fun chip(title: String, value: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(0x66182739, dp(10), 0x246ea8fe)
            addView(TextView(this@MainActivity).apply {
                text = title.uppercase()
                textSize = 10f
                setTextColor(0xff94a3b8.toInt())
            })
            addView(TextView(this@MainActivity).apply {
                text = value
                textSize = 14f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xfff8fafc.toInt())
                maxLines = 2
            })
        }
    }

    private fun userManagerButton(): Button {
        return Button(this).apply {
            text = "USER MANAGER"
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xfff8fafc.toInt())
            background = rounded(0xff102033.toInt(), dp(10), 0xff38bdf8.toInt())
            setPadding(dp(14), 0, dp(14), 0)
            minHeight = dp(54)
            setOnClickListener { openUserManager() }
        }.also {
            userManagerOpenButton = it
        }
    }

    private fun createDownloadProfileButton(): Button {
        return Button(this).apply {
            text = "DOWNLOAD ACTIVE PROFILE"
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xffdbeafe.toInt())
            background = rounded(0xff111827.toInt(), dp(10), 0xff60a5fa.toInt())
            setPadding(dp(14), 0, dp(14), 0)
            minHeight = dp(54)
            setOnClickListener { downloadActiveProfile() }
        }.also {
            downloadProfileButton = it
        }
    }

    private fun createPayloadImportButton(): Button {
        return Button(this).apply {
            text = "IMPORT PAYLOAD ZIP"
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xffd1fae5.toInt())
            background = rounded(0xff071a14.toInt(), dp(10), 0xff34d399.toInt())
            setPadding(dp(14), 0, dp(14), 0)
            minHeight = dp(54)
            setOnClickListener { openPayloadZipPicker() }
        }.also {
            payloadImportButton = it
        }
    }

    private fun createDownloadPatchedApkButton(): Button {
        return Button(this).apply {
            text = "DOWNLOAD PATCHED APK"
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xffffedd5.toInt())
            background = rounded(0xff241207.toInt(), dp(10), 0xfffb923c.toInt())
            setPadding(dp(14), 0, dp(14), 0)
            minHeight = dp(54)
            setOnClickListener { openUrl(PATCHED_APK_URL) }
        }
    }

    private fun setPayloadImportBusy(busy: Boolean) {
        payloadImportBusy = busy
        refreshLauncherControls()
    }

    private fun setUserManagerButtonBusy(busy: Boolean) {
        if (!::userManagerOpenButton.isInitialized) return
        userManagerOpenButton.isEnabled = !busy
        userManagerOpenButton.alpha = if (busy) 0.72f else 1f
        userManagerOpenButton.text = if (busy) "OPENING..." else "USER MANAGER"
    }

    private fun setDownloadProfileBusy(busy: Boolean) {
        if (!::downloadProfileButton.isInitialized) return
        downloadProfileButton.isEnabled = !busy
        downloadProfileButton.alpha = if (busy) 0.72f else 1f
        downloadProfileButton.text = if (busy) "PREPARING..." else "DOWNLOAD ACTIVE PROFILE"
    }

    private fun mutedText(text: String, size: Float): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(0xffcbd5e1.toInt())
            setPadding(0, dp(2), 0, 0)
        }
    }

    private fun label(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 12f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xff94a3b8.toInt())
            setPadding(0, dp(10), 0, dp(3))
        }
    }

    private fun statusText(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 20f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xfff8fafc.toInt())
            setPadding(0, dp(1), 0, dp(6))
        }
    }

    private fun singleLineInput(value: String): EditText {
        return EditText(this).apply {
            setSingleLine(true)
            setText(value)
            textSize = 15f
            setTextColor(0xfff8fafc.toInt())
            setHintTextColor(0xff64748b.toInt())
            setPadding(dp(12), 0, dp(12), 0)
            minHeight = dp(48)
            background = rounded(0x6606090d, dp(9), 0x3364748b)
        }
    }

    private fun numberInput(value: String): EditText {
        return singleLineInput(value).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
        }
    }

    private fun fieldColumn(title: String, input: EditText): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, dp(10), 0)
            addView(label(title))
            addView(input, fillWrap())
        }
    }

    private fun fillWrap(): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    private fun fillWrapWithBottom(bottom: Int): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = bottom
        }
    }

    private fun rounded(color: Int, radius: Int, strokeColor: Int = 0): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius.toFloat()
            if (strokeColor != 0) setStroke(dp(1), strokeColor)
        }
    }

    private fun verticalGradient(top: Int, bottom: Int): GradientDrawable {
        return GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(top, bottom))
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val VPN_REQUEST = 100
        const val PAYLOAD_ZIP_REQUEST = 101
        const val PROFILE_JSON_REQUEST = 102
        const val LISTENER_HEALTH_TIMEOUT_MS = 240000L
        const val LISTENER_HEALTH_INTERVAL_MS = 1000L
        const val LISTENER_WARMUP_CONNECT_TIMEOUT_MS = 2000
        const val LISTENER_WARMUP_READ_TIMEOUT_MS = 240000
        const val SERVER_MODE_REVIVALSIDE = "revivalside"
        const val PATCHED_APK_URL = "https://discord.gg/revivalside"
    }

    private data class WarmupResult(val ok: Boolean, val summary: String = "")
    private data class ListenerHealth(val ready: Boolean, val fatalMessage: String = "")
    private data class ServerInfoModeResult(val ok: Boolean, val summary: String = "")

    private data class ImportResult(val ok: Boolean, val summary: String = "")
    private data class ProfileExportResult(
        val ok: Boolean,
        val target: ProfileExportTarget? = null,
        val summary: String = "",
    )
    private data class ProfileExportTarget(val fileName: String, val url: String)
}
