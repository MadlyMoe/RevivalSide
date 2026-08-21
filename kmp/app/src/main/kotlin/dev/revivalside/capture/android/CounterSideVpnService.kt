package dev.revivalside.capture.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import dev.revivalside.capture.protocol.CapturedCounterSideFrame
import dev.revivalside.capture.protocol.CounterSideFrameScanner
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.random.Random

class CounterSideVpnService : VpnService() {
    private val running = AtomicBoolean(false)
    private val joinLobbyCaptured = AtomicBoolean(false)
    private val officialLoginCaptureLock = Any()
    private val officialLoginFrames = linkedMapOf<Int, CapturedCounterSideFrame>()
    private val sessions = ConcurrentHashMap<TcpKey, TcpSession>()
    private var vpnInterface: ParcelFileDescriptor? = null
    private var worker: Thread? = null
    private var output: FileOutputStream? = null
    private val outputLock = Any()
    private var vpnMode: String = MODE_CAPTURE
    private var listenerPort: Int = DEFAULT_GAME_PORT
    private var httpMirrorPort: Int = DEFAULT_HTTP_PORT
    private var redirectPorts: Set<Int> = setOf(DEFAULT_GAME_PORT)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startCapture(intent)
            ACTION_STOP -> stopCapture()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopCapture()
        super.onDestroy()
    }

    private fun startCapture(intent: Intent) {
        if (!running.compareAndSet(false, true)) {
            publishStatus("Restarting VPN")
            stopCapture()
            if (!running.compareAndSet(false, true)) {
                publishStatus("Failed: VPN is still stopping")
                return
            }
        }

        try {
            val targetPackage = intent.getStringExtra(EXTRA_TARGET_PACKAGE).orEmpty()
            vpnMode = intent.getStringExtra(EXTRA_MODE)?.takeIf { it == MODE_LISTENER } ?: MODE_CAPTURE
            listenerPort = intent.getIntExtra(EXTRA_LISTENER_PORT, DEFAULT_GAME_PORT).coercePort(DEFAULT_GAME_PORT)
            httpMirrorPort = intent.getIntExtra(EXTRA_HTTP_PORT, DEFAULT_HTTP_PORT).coercePort(DEFAULT_HTTP_PORT)
            redirectPorts = RevivalSideSettingsStore.parsePorts(
                intent.getStringExtra(EXTRA_REDIRECT_PORTS).orEmpty(),
                setOf(listenerPort),
            )
            joinLobbyCaptured.set(false)
            synchronized(officialLoginCaptureLock) {
                officialLoginFrames.clear()
            }

            val modeText = if (vpnMode == MODE_LISTENER) "Redirecting CounterSide traffic" else "Capturing CounterSide traffic"
            startForeground(NOTIFICATION_ID, buildNotification(modeText))
            val builder = Builder()
                .setSession(if (vpnMode == MODE_LISTENER) "RevivalSide Redirect" else "RevivalSide Capture")
                .setMtu(1500)
                .addAddress("10.79.0.2", 32)
                .addDnsServer("1.1.1.1")
            val routeLabels = configureRoutes(builder)

            val scopedTarget = tryAddTargetApplication(builder, targetPackage)

            vpnInterface = builder.establish() ?: error("Android did not establish the VPN interface.")
            output = FileOutputStream(vpnInterface!!.fileDescriptor)
            worker = thread(name = "revivalside-vpn", isDaemon = true) {
                runPacketLoop(vpnInterface!!)
            }
            if (vpnMode == MODE_LISTENER) {
                publishStatus(
                    "Redirecting ${scopedTarget.ifBlank { "all routed apps" }} routes $routeLabels game=${redirectPorts.sorted()}->$listenerPort http=80->$httpMirrorPort",
                )
            } else {
                publishStatus("Recording ${scopedTarget.ifBlank { "all routed apps" }}")
            }
        } catch (ex: Exception) {
            publishStatus("Failed: ${ex.message}")
            stopCapture()
        }
    }

    private fun stopCapture() {
        if (!running.getAndSet(false)) return
        sessions.values.forEach { it.close() }
        sessions.clear()
        try {
            vpnInterface?.close()
        } catch (_: Exception) {
        }
        vpnInterface = null
        output = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        publishStatus("Stopped")
    }

    private fun runPacketLoop(descriptor: ParcelFileDescriptor) {
        val input = FileInputStream(descriptor.fileDescriptor)
        val packet = ByteArray(32767)
        while (running.get()) {
            val length = try {
                input.read(packet)
            } catch (_: Exception) {
                break
            }
            if (length <= 0) continue
            try {
                handlePacket(packet, length)
            } catch (ex: Exception) {
                publishStatus("Packet skipped: ${ex.message}")
            }
        }
        running.set(false)
    }

    private fun handlePacket(packet: ByteArray, length: Int) {
        val ip = parseIpv4(packet, length) ?: return
        when (ip.protocol) {
            6 -> handleTcp(packet, ip)
            17 -> handleUdp(packet, ip)
        }
    }

    private fun handleTcp(packet: ByteArray, ip: Ipv4Packet) {
        val tcp = parseTcp(packet, ip) ?: return
        val key = TcpKey(ip.source, tcp.sourcePort, ip.destination, tcp.destinationPort)

        if ((tcp.flags and TcpFlags.RST) != 0) {
            sessions.remove(key)?.close()
            return
        }

        if ((tcp.flags and TcpFlags.SYN) != 0 && !sessions.containsKey(key)) {
            openTcpSession(key, tcp)
            return
        }

        val session = sessions[key] ?: return
        if (tcp.payloadLength > 0) {
            val payload = packet.copyOfRange(tcp.payloadOffset, tcp.payloadOffset + tcp.payloadLength)
            session.writeFromClient(tcp.sequence, payload)
            writePacket(session.buildAck())
            if (vpnMode == MODE_LISTENER && redirectPorts.contains(key.remotePort)) {
                Log.i(TAG, "client ${payload.size} bytes -> ${key.remoteLabel}")
            }
        }

        if ((tcp.flags and TcpFlags.FIN) != 0) {
            session.clientNext = incrementSequence(tcp.sequence, tcp.payloadLength + 1)
            writePacket(session.buildAck())
            writePacket(session.buildFin())
            sessions.remove(key)?.close()
        }
    }

    private fun openTcpSession(key: TcpKey, tcp: TcpPacket) {
        val socket = Socket()
        protect(socket)
        try {
            val endpoint = resolveTcpEndpoint(key)
            socket.tcpNoDelay = true
            socket.connect(endpoint, CONNECT_TIMEOUT_MS)
            val session = TcpSession(
                key = key,
                socket = socket,
                serverNext = Random.nextLong().toUInt32(),
                clientNext = incrementSequence(tcp.sequence, 1),
                scanner = CounterSideFrameScanner(),
            )
            sessions[key] = session
            writePacket(session.buildSynAck())
            session.serverNext = incrementSequence(session.serverNext, 1)
            startServerReader(session)
            if (vpnMode == MODE_LISTENER && endpoint.address.isLoopbackAddress) {
                Log.i(TAG, "redirected ${key.remoteLabel} to ${endpoint.hostString}:${endpoint.port}")
                publishStatus("Redirected ${key.remoteLabel} to ${endpoint.hostString}:${endpoint.port}")
            }
        } catch (ex: Exception) {
            try {
                socket.close()
            } catch (_: Exception) {
            }
            writePacket(
                buildTcpIpv4Packet(
                    sourceIp = key.remoteIp,
                    destinationIp = key.localIp,
                    sourcePort = key.remotePort,
                    destinationPort = key.localPort,
                    sequence = 0,
                    acknowledgment = incrementSequence(tcp.sequence, 1),
                    flags = TcpFlags.RST or TcpFlags.ACK,
                ),
            )
            Log.w(TAG, "connect failed ${key.remoteLabel}: ${ex.message}")
            publishStatus("Connect failed ${key.remoteLabel}: ${ex.message}")
        }
    }

    private fun resolveTcpEndpoint(key: TcpKey): InetSocketAddress {
        if (vpnMode == MODE_LISTENER && shouldRedirectToHttpMirror(key)) {
            return InetSocketAddress(InetAddress.getByName("127.0.0.1"), httpMirrorPort)
        }
        if (vpnMode == MODE_LISTENER && redirectPorts.contains(key.remotePort)) {
            return InetSocketAddress(InetAddress.getByName("127.0.0.1"), listenerPort)
        }
        return InetSocketAddress(intToAddress(key.remoteIp), key.remotePort)
    }

    private fun shouldRedirectToHttpMirror(key: TcpKey): Boolean {
        return key.remotePort in HTTP_MIRROR_REMOTE_PORTS
    }

    private fun configureRoutes(builder: Builder): List<String> {
        if (vpnMode != MODE_LISTENER) {
            builder.addRoute("0.0.0.0", 0)
            return listOf("0.0.0.0/0")
        }

        val routes = resolveListenerRoutes()
        for (address in routes) {
            builder.addRoute(address.hostAddress, 32)
        }
        return routes.map { "${it.hostAddress}/32" }
    }

    private fun resolveListenerRoutes(): List<Inet4Address> {
        val ordered = linkedMapOf<String, Inet4Address>()
        for (host in LISTENER_ROUTE_HOSTS) {
            val addresses = runCatching { InetAddress.getAllByName(host).toList() }.getOrDefault(emptyList())
            for (address in addresses) {
                if (address is Inet4Address) ordered[address.hostAddress] = address
            }
        }
        for (fallback in LISTENER_ROUTE_FALLBACK_IPV4) {
            val address = runCatching { InetAddress.getByName(fallback) }.getOrNull()
            if (address is Inet4Address) ordered[address.hostAddress] = address
        }
        return ordered.values.toList()
    }

    private fun startServerReader(session: TcpSession) {
        thread(name = "revivalside-tcp-${session.key.remotePort}", isDaemon = true) {
            val buffer = ByteArray(32 * 1024)
            try {
                val input = session.socket.getInputStream()
                while (running.get() && !session.closed.get()) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    inspectServerPayload(session, buffer, read)
                    forwardServerPayload(session, buffer, read)
                }
                if (!session.closed.get()) {
                    writePacket(session.buildFin())
                }
            } catch (_: Exception) {
            } finally {
                sessions.remove(session.key)
                session.close()
            }
        }
    }

    private fun forwardServerPayload(session: TcpSession, buffer: ByteArray, length: Int) {
        if (vpnMode == MODE_LISTENER && redirectPorts.contains(session.key.remotePort)) {
            Log.i(TAG, "server $length bytes <- ${session.key.remoteLabel}")
        }
        var offset = 0
        while (offset < length) {
            val size = minOf(TCP_MSS, length - offset)
            val payload = buffer.copyOfRange(offset, offset + size)
            writePacket(session.buildServerData(payload))
            session.serverNext = incrementSequence(session.serverNext, size)
            offset += size
        }
    }

    private fun inspectServerPayload(session: TcpSession, bytes: ByteArray, length: Int) {
        val frames = session.scanner.push(bytes, length)
        if (frames.isEmpty()) return

        if (vpnMode == MODE_CAPTURE) {
            inspectOfficialLoginPackets(session, frames)
        }

        if (joinLobbyCaptured.get()) return
        val lobbyAck = frames.firstOrNull { it.packetId == JOIN_LOBBY_ACK } ?: return
        if (!joinLobbyCaptured.compareAndSet(false, true)) return
        val export = CaptureRepository.saveJoinLobbyAck(this, lobbyAck, session.key.remoteLabel)
        publishStatus("Captured JOIN_LOBBY_ACK", export)
    }

    private fun inspectOfficialLoginPackets(session: TcpSession, frames: List<CapturedCounterSideFrame>) {
        val interesting = frames.filter {
            it.packetId == LOGIN_ACK || it.packetId == GAMEBASE_LOGIN_ACK || it.packetId == CONTENTS_VERSION_ACK
        }
        if (interesting.isEmpty()) return

        var export: java.io.File? = null
        var summary = ""
        synchronized(officialLoginCaptureLock) {
            var changed = false
            for (frame in interesting) {
                if (!officialLoginFrames.containsKey(frame.packetId)) {
                    officialLoginFrames[frame.packetId] = frame
                    changed = true
                }
            }
            if (changed) {
                export = CaptureRepository.saveOfficialLoginPackets(this, officialLoginFrames.values, session.key.remoteLabel)
                summary = officialLoginFrames.keys.sorted().joinToString(",")
            }
        }
        if (export != null) {
            publishStatus("Captured official login packets [$summary]", export)
        }
    }

    private fun handleUdp(packet: ByteArray, ip: Ipv4Packet) {
        val udp = parseUdp(packet, ip) ?: return
        val payload = packet.copyOfRange(udp.payloadOffset, udp.payloadOffset + udp.payloadLength)
        thread(name = "revivalside-udp", isDaemon = true) {
            try {
                DatagramSocket().use { socket ->
                    protect(socket)
                    socket.soTimeout = UDP_TIMEOUT_MS
                    val request = DatagramPacket(payload, payload.size, intToAddress(ip.destination), udp.destinationPort)
                    socket.send(request)
                    val responseBuffer = ByteArray(4096)
                    val response = DatagramPacket(responseBuffer, responseBuffer.size)
                    socket.receive(response)
                    val responsePayload = response.data.copyOfRange(0, response.length)
                    writePacket(
                        buildUdpIpv4Packet(
                            sourceIp = ip.destination,
                            destinationIp = ip.source,
                            sourcePort = udp.destinationPort,
                            destinationPort = udp.sourcePort,
                            payload = responsePayload,
                        ),
                    )
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun writePacket(packet: ByteArray) {
        synchronized(outputLock) {
            try {
                output?.write(packet)
            } catch (_: Exception) {
            }
        }
    }

    private fun buildNotification(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "RevivalSide Capture", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("RevivalSide Capture")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(intent)
            .setOngoing(true)
            .build()
    }

    private fun publishStatus(message: String, export: java.io.File? = null) {
        Log.i(TAG, message)
        sendBroadcast(Intent(ACTION_STATUS).apply {
            setPackage(packageName)
            putExtra(EXTRA_MESSAGE, message)
            if (export != null) putExtra(EXTRA_EXPORT_PATH, export.absolutePath)
        }, INTERNAL_BROADCAST_PERMISSION)
    }

    private fun tryAddTargetApplication(builder: Builder, targetPackage: String): String {
        if (targetPackage.isBlank()) {
            builder.addDisallowedApplication(packageName)
            return ""
        }
        return try {
            builder.addAllowedApplication(targetPackage)
            targetPackage
        } catch (_: PackageManager.NameNotFoundException) {
            builder.addDisallowedApplication(packageName)
            publishStatus("Target package is not visible; recording all routed apps")
            ""
        }
    }

    companion object {
        const val LOGIN_ACK = 203
        const val JOIN_LOBBY_ACK = 205
        const val CONTENTS_VERSION_ACK = 217
        const val GAMEBASE_LOGIN_ACK = 230
        const val CHANNEL_ID = "revivalside_capture"
        const val NOTIFICATION_ID = 6001
        const val CONNECT_TIMEOUT_MS = 10_000
        const val UDP_TIMEOUT_MS = 5_000
        const val TCP_MSS = 1200
        const val ACTION_START = "dev.revivalside.capture.START"
        const val ACTION_STOP = "dev.revivalside.capture.STOP"
        const val ACTION_STATUS = "dev.revivalside.capture.STATUS"
        const val EXTRA_TARGET_PACKAGE = "targetPackage"
        const val EXTRA_MODE = "mode"
        const val EXTRA_LISTENER_PORT = "listenerPort"
        const val EXTRA_HTTP_PORT = "httpPort"
        const val EXTRA_REDIRECT_PORTS = "redirectPorts"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_EXPORT_PATH = "exportPath"
        const val MODE_CAPTURE = "capture"
        const val MODE_LISTENER = "listener"
        const val TAG = "RevivalSideVpn"
        val HTTP_MIRROR_REMOTE_PORTS = setOf(80)
        val LISTENER_ROUTE_HOSTS = listOf(
            "ctsglobal-login.sbside.com",
            "ctskorea-login.sbside.com",
            "ctsglobal-cdndown.sbside.com",
        )
        val LISTENER_ROUTE_FALLBACK_IPV4 = listOf(
            "172.65.251.9",
            "172.65.237.240",
            "104.18.22.191",
            "104.18.23.191",
        )
    }
}

private data class TcpKey(
    val localIp: Int,
    val localPort: Int,
    val remoteIp: Int,
    val remotePort: Int,
) {
    val remoteLabel: String get() = "${intToAddress(remoteIp).hostAddress}:$remotePort"
}

private class TcpSession(
    val key: TcpKey,
    val socket: Socket,
    var serverNext: Long,
    var clientNext: Long,
    val scanner: CounterSideFrameScanner,
) {
    val closed = AtomicBoolean(false)

    fun writeFromClient(sequence: Long, payload: ByteArray) {
        if (sequence != clientNext) return
        socket.getOutputStream().write(payload)
        socket.getOutputStream().flush()
        clientNext = incrementSequence(clientNext, payload.size)
    }

    fun buildSynAck(): ByteArray = buildTcpIpv4Packet(
        sourceIp = key.remoteIp,
        destinationIp = key.localIp,
        sourcePort = key.remotePort,
        destinationPort = key.localPort,
        sequence = serverNext,
        acknowledgment = clientNext,
        flags = TcpFlags.SYN or TcpFlags.ACK,
    )

    fun buildAck(): ByteArray = buildTcpIpv4Packet(
        sourceIp = key.remoteIp,
        destinationIp = key.localIp,
        sourcePort = key.remotePort,
        destinationPort = key.localPort,
        sequence = serverNext,
        acknowledgment = clientNext,
        flags = TcpFlags.ACK,
    )

    fun buildServerData(payload: ByteArray): ByteArray = buildTcpIpv4Packet(
        sourceIp = key.remoteIp,
        destinationIp = key.localIp,
        sourcePort = key.remotePort,
        destinationPort = key.localPort,
        sequence = serverNext,
        acknowledgment = clientNext,
        flags = TcpFlags.PSH or TcpFlags.ACK,
        payload = payload,
    )

    fun buildFin(): ByteArray = buildTcpIpv4Packet(
        sourceIp = key.remoteIp,
        destinationIp = key.localIp,
        sourcePort = key.remotePort,
        destinationPort = key.localPort,
        sequence = serverNext,
        acknowledgment = clientNext,
        flags = TcpFlags.FIN or TcpFlags.ACK,
    )

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            socket.close()
        } catch (_: Exception) {
        }
    }
}

private fun intToAddress(value: Int): InetAddress {
    return InetAddress.getByAddress(
        byteArrayOf(
            ((value ushr 24) and 0xff).toByte(),
            ((value ushr 16) and 0xff).toByte(),
            ((value ushr 8) and 0xff).toByte(),
            (value and 0xff).toByte(),
        ),
    )
}

private fun Long.toUInt32(): Long = this and 0xffffffffL

private fun Int.coercePort(fallback: Int): Int = if (this in 1..65535) this else fallback
