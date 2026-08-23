package dev.revivalside.capture.android

import org.json.JSONObject
import org.json.JSONArray
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Streams the imported Android payload without routing large files through the PC listener's
 * captured-response mirror. The client-facing update version is an alias of the verified payload
 * version, so no second 12,000-route manifest or whole-file buffering is needed.
 */
internal class AndroidPayloadHttpServer(
    private val payloadRoot: File,
    private val contract: AndroidClientContract,
    private val port: Int,
    private val gamePort: Int,
    private val log: (String) -> Unit,
) {
    private val running = AtomicBoolean(false)
    private val workers = Executors.newFixedThreadPool(WORKER_COUNT) { runnable ->
        Thread(runnable, "revivalside-payload-http").apply { isDaemon = true }
    }
    private var socket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val advertisedVersion = contract.patchVersion.replace(Regex("\\d+$")) { match ->
        (match.value.toLong() + 1L).toString()
    }
    private val liveVersion = (JSONObject()
        .put("versionList", org.json.JSONArray().put(JSONObject().put("version", advertisedVersion)))
        .toString() + "\n").toByteArray(Charsets.UTF_8)
    private val patchInfo = patchedPatchInfo()
    private val serverInfo = buildServerInfo()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        val server = ServerSocket().apply {
            reuseAddress = true
            receiveBufferSize = SOCKET_BUFFER_BYTES
            bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), SOCKET_BACKLOG)
        }
        socket = server
        acceptThread = thread(name = "revivalside-payload-accept", isDaemon = true) {
            while (running.get()) {
                val client = try {
                    server.accept()
                } catch (_: Exception) {
                    if (!running.get()) break
                    continue
                }
                workers.execute { handle(client) }
            }
        }
        log("Android payload streamer online on 127.0.0.1:$port (${contract.patchVersion} -> $advertisedVersion).")
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        runCatching { socket?.close() }
        socket = null
        workers.shutdownNow()
        workers.awaitTermination(1, TimeUnit.SECONDS)
        acceptThread = null
    }

    private fun handle(client: Socket) {
        client.use { connection ->
            connection.tcpNoDelay = true
            connection.soTimeout = SOCKET_TIMEOUT_MS
            connection.receiveBufferSize = SOCKET_BUFFER_BYTES
            connection.sendBufferSize = SOCKET_BUFFER_BYTES
            val input = BufferedInputStream(connection.getInputStream(), HEADER_BUFFER_BYTES)
            val output = BufferedOutputStream(connection.getOutputStream(), SOCKET_BUFFER_BYTES)
            var requestCount = 0
            while (running.get() && requestCount++ < MAX_REQUESTS_PER_CONNECTION) {
                try {
                val requestLine = readLine(input, MAX_HEADER_BYTES) ?: return
                val requestParts = requestLine.split(' ', limit = 3)
                if (requestParts.size != 3) return respondText(output, 400, "Bad Request")
                val method = requestParts[0].uppercase(Locale.ROOT)
                if (method != "GET" && method != "HEAD") return respondText(output, 405, "Method Not Allowed")

                val headers = linkedMapOf<String, String>()
                var headerBytes = requestLine.length
                while (true) {
                    val line = readLine(input, MAX_HEADER_BYTES - headerBytes) ?: return
                    headerBytes += line.length
                    if (line.isEmpty()) break
                    val separator = line.indexOf(':')
                    if (separator > 0) {
                        headers[line.substring(0, separator).trim().lowercase(Locale.ROOT)] =
                            line.substring(separator + 1).trim()
                    }
                }
                val keepAlive = headers["connection"]?.equals("close", ignoreCase = true) != true &&
                    (requestParts[2].equals("HTTP/1.1", ignoreCase = true) ||
                        headers["connection"]?.equals("keep-alive", ignoreCase = true) == true)

                val resource = resolve(requestParts[1]) ?: return respondText(output, 404, "Not Found")
                val range = parseRange(headers["range"], resource.size)
                if (range == INVALID_RANGE) {
                    respond(
                        output,
                        416,
                        mapOf(
                            "Content-Range" to "bytes */${resource.size}",
                            "Connection" to "close",
                        ),
                    )
                    return
                }
                val start = range?.first ?: 0L
                val end = range?.last ?: (resource.size - 1L)
                val length = if (resource.size == 0L) 0L else end - start + 1L
                val etag = resource.etag
                if (range == null && headers["if-none-match"] == etag) {
                    respond(output, 304, connectionHeaders(keepAlive))
                    if (!keepAlive) return
                    continue
                }
                val responseHeaders = linkedMapOf(
                    "Content-Type" to resource.contentType,
                    "Content-Length" to length.toString(),
                    "Accept-Ranges" to "bytes",
                    "Cache-Control" to "public, max-age=31536000, immutable",
                    "ETag" to etag,
                )
                responseHeaders.putAll(connectionHeaders(keepAlive))
                if (range != null) responseHeaders["Content-Range"] = "bytes $start-$end/${resource.size}"
                respond(output, if (range == null) 200 else 206, responseHeaders)
                if (method != "HEAD" && length != 0L) resource.write(output, start, length)
                output.flush()
                if (!keepAlive) return
                } catch (_: Exception) {
                    // Client-side cancellation is expected while Counter:Side retries parallel downloads.
                    return
                }
            }
        }
    }

    private fun resolve(rawTarget: String): Resource? {
        val decoded = runCatching { URI("http://127.0.0.1$rawTarget").path }.getOrNull() ?: return null
        val path = when {
            decoded.startsWith("/android-patchfiles/") -> "/patchfiles/${decoded.removePrefix("/android-patchfiles/")}"
            decoded.startsWith("/revivalsideapk/") -> decoded.removePrefix("/revivalsideapk")
            else -> decoded
        }
        if (path == "/server_config/live/ServerInfo_V2.json") {
            return Resource.Bytes(serverInfo, "application/json; charset=utf-8")
        }
        if (path == "/patchfiles/Android/liveVersion.json") return Resource.Bytes(liveVersion, "application/json; charset=utf-8")
        if (path == "/patchfiles/Android/$advertisedVersion/PatchInfo.json") {
            return Resource.Bytes(patchInfo, "application/octet-stream")
        }

        val sourcePath = if (path.startsWith("/patchfiles/Android/$advertisedVersion/")) {
            path.replaceFirst(
                "/patchfiles/Android/$advertisedVersion/",
                "/patchfiles/Android/${contract.patchVersion}/",
            )
        } else {
            path
        }
        if (sourcePath != "/android-client/payload-manifest.json" && !sourcePath.startsWith("/patchfiles/")) return null
        val relative = sourcePath.removePrefix("/")
        val file = safeFile(relative) ?: return null
        if (!file.isFile) return null
        return Resource.Disk(file, contentType(relative))
    }

    private fun safeFile(relativePath: String): File? {
        val normalized = runCatching { normalizeAndroidPayloadPath(relativePath) }.getOrNull() ?: return null
        val root = payloadRoot.canonicalFile
        val file = File(root, normalized.replace('/', File.separatorChar)).canonicalFile
        return file.takeIf { it.path.startsWith(root.path + File.separator) }
    }

    private fun patchedPatchInfo(): ByteArray {
        val file = File(payloadRoot, "patchfiles/Android/${contract.patchVersion}/PatchInfo.json")
        check(file.isFile) { "Imported Android PatchInfo is missing." }
        val body = file.readBytes()
        val before = contract.patchVersion.toByteArray(StandardCharsets.US_ASCII)
        val after = advertisedVersion.toByteArray(StandardCharsets.US_ASCII)
        check(before.size == after.size) { "Android update version width changed." }
        val offset = body.indexOf(before)
        check(offset >= 0) { "Imported Android PatchInfo has the wrong version." }
        after.copyInto(body, offset)
        return body
    }

    private fun buildServerInfo(): ByteArray {
        fun tags(vararg values: String) = JSONArray().apply { values.forEach(::put) }
        fun server(defaultTags: JSONArray) = JSONObject()
            .put("ip", "127.0.0.1")
            .put("port", gamePort)
            .put("defaultTagSet", defaultTags)
            .put("Maintenance", JSONObject()
                .put("Interval", 0)
                .put("Use", false)
                .put("Description", JSONObject().put("DEFAULT", "RevivalSide is available.")))
        val config = JSONObject()
            .put("server", JSONObject()
                .put("Korea", server(tags(
                    "KOR", "LANGUAGE_KOR", "VOICE_KOR", "VOICE_JPN", "CHECK_MAINTENANCE", "MULTITASK_DOWNLOAD",
                )))
                .put("Global", server(tags(
                    "GLOBAL", "LANGUAGE_KOR", "LANGUAGE_ENG", "LANGUAGE_DEU", "LANGUAGE_FRA", "LANGUAGE_JPN",
                    "LANGUAGE_TRADITIONAL_CHN", "VOICE_KOR", "VOICE_JPN", "CHECK_MAINTENANCE", "MULTITASK_DOWNLOAD",
                ))))
            .put("type", "LIVE")
            .put("cdn", "http://127.0.0.1:$port/patchfiles/")
            .put("versionJson", "/liveVersion.json")
            .put("DownloadTimeout", 300000)
        return (config.toString() + "\n").toByteArray(Charsets.UTF_8)
    }

    private fun contentType(path: String): String = when {
        path.endsWith(".json", ignoreCase = true) -> "application/json; charset=utf-8"
        path.endsWith(".apk", ignoreCase = true) -> "application/vnd.android.package-archive"
        else -> "application/octet-stream"
    }

    private fun connectionHeaders(keepAlive: Boolean): Map<String, String> = if (keepAlive) {
        mapOf("Connection" to "keep-alive", "Keep-Alive" to "timeout=30, max=$MAX_REQUESTS_PER_CONNECTION")
    } else {
        mapOf("Connection" to "close")
    }

    private fun respondText(output: BufferedOutputStream, status: Int, message: String) {
        val body = "$message\n".toByteArray(Charsets.UTF_8)
        respond(
            output,
            status,
            mapOf(
                "Content-Type" to "text/plain; charset=utf-8",
                "Content-Length" to body.size.toString(),
                "Connection" to "close",
            ),
        )
        output.write(body)
        output.flush()
    }

    private fun respond(output: BufferedOutputStream, status: Int, headers: Map<String, String>) {
        val reason = when (status) {
            200 -> "OK"
            206 -> "Partial Content"
            304 -> "Not Modified"
            400 -> "Bad Request"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            416 -> "Range Not Satisfiable"
            else -> "Error"
        }
        output.write("HTTP/1.1 $status $reason\r\n".toByteArray(StandardCharsets.US_ASCII))
        headers.forEach { (name, value) ->
            output.write("$name: $value\r\n".toByteArray(StandardCharsets.US_ASCII))
        }
        output.write("\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.flush()
    }

    private fun readLine(input: BufferedInputStream, remaining: Int): String? {
        if (remaining <= 0) return null
        val bytes = ArrayList<Byte>(128)
        while (bytes.size < remaining) {
            val value = input.read()
            if (value < 0) return if (bytes.isEmpty()) null else String(bytes.toByteArray(), StandardCharsets.US_ASCII)
            if (value == '\n'.code) break
            if (value != '\r'.code) bytes.add(value.toByte())
        }
        return String(bytes.toByteArray(), StandardCharsets.US_ASCII)
    }

    private fun parseRange(value: String?, size: Long): LongRange? {
        if (value == null) return null
        if (size <= 0L) return INVALID_RANGE
        val match = RANGE_PATTERN.matchEntire(value.trim()) ?: return INVALID_RANGE
        val startText = match.groupValues[1]
        val endText = match.groupValues[2]
        if (startText.isEmpty()) {
            val suffix = endText.toLongOrNull() ?: return INVALID_RANGE
            if (suffix <= 0L) return INVALID_RANGE
            return maxOf(0L, size - suffix)..(size - 1L)
        }
        val start = startText.toLongOrNull() ?: return INVALID_RANGE
        val end = if (endText.isEmpty()) size - 1L else endText.toLongOrNull() ?: return INVALID_RANGE
        if (start < 0L || start >= size || end < start) return INVALID_RANGE
        return start..minOf(end, size - 1L)
    }

    private sealed class Resource {
        abstract val size: Long
        abstract val contentType: String
        abstract val etag: String
        abstract fun write(output: BufferedOutputStream, start: Long, length: Long)

        class Bytes(private val bytes: ByteArray, override val contentType: String) : Resource() {
            override val size: Long = bytes.size.toLong()
            override val etag: String = "\"${sha256(bytes)}\""
            override fun write(output: BufferedOutputStream, start: Long, length: Long) {
                output.write(bytes, start.toInt(), length.toInt())
            }
        }

        class Disk(private val file: File, override val contentType: String) : Resource() {
            override val size: Long = file.length()
            override val etag: String = "\"${size.toString(16)}-${file.lastModified().toString(16)}\""
            override fun write(output: BufferedOutputStream, start: Long, length: Long) {
                RandomAccessFile(file, "r").use { input ->
                    input.seek(start)
                    val buffer = ByteArray(COPY_BUFFER_BYTES)
                    var remaining = length
                    while (remaining > 0L) {
                        val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                        if (count < 0) error("Payload file ended early: ${file.name}")
                        output.write(buffer, 0, count)
                        remaining -= count.toLong()
                    }
                }
            }
        }
    }

    companion object {
        // The frozen Android client creates exactly 16 parallel UnityWebRequest workers.
        private const val WORKER_COUNT = 16
        private const val SOCKET_BACKLOG = 256
        private const val SOCKET_TIMEOUT_MS = 30_000
        private const val SOCKET_BUFFER_BYTES = 1024 * 1024
        private const val HEADER_BUFFER_BYTES = 32 * 1024
        private const val MAX_HEADER_BYTES = 64 * 1024
        private const val MAX_REQUESTS_PER_CONNECTION = 4096
        private const val COPY_BUFFER_BYTES = 1024 * 1024
        private val RANGE_PATTERN = Regex("bytes=(\\d*)-(\\d*)")
        private val INVALID_RANGE = Long.MIN_VALUE..Long.MIN_VALUE

        private fun ByteArray.indexOf(needle: ByteArray): Int {
            if (needle.isEmpty() || needle.size > size) return -1
            for (offset in 0..size - needle.size) {
                var match = true
                for (index in needle.indices) {
                    if (this[offset + index] != needle[index]) {
                        match = false
                        break
                    }
                }
                if (match) return offset
            }
            return -1
        }

        private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
