package dev.revivalside.capture.android

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipFile

internal data class AndroidClientContract(
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val patchVersion: String,
    val localHttpPort: Int,
    val metadataEntry: String,
    val originalServerInfoBaseUrl: String,
    val patchedServerInfoBaseUrl: String,
    val assetCdnBaseUrl: String,
    val payloadManifestUrl: String,
    val payloadManifestSha256: String,
    val payloadId: String,
    val payloadFileCount: Long,
    val payloadTotalBytes: Long,
) {
    companion object {
        private const val ASSET = "revivalside-android-client-contract.json"

        fun load(context: Context): AndroidClientContract {
            val value = context.assets.open(ASSET).bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
            if (value.getInt("schemaVersion") != 1) throw IllegalStateException("Unsupported Android client contract.")
            return AndroidClientContract(
                packageName = value.getString("packageName"),
                versionName = value.getString("versionName"),
                versionCode = value.getLong("versionCode"),
                patchVersion = value.getString("patchVersion"),
                localHttpPort = value.getInt("localHttpPort"),
                metadataEntry = value.getString("metadataEntry"),
                originalServerInfoBaseUrl = value.getString("originalServerInfoBaseUrl"),
                patchedServerInfoBaseUrl = value.getString("patchedServerInfoBaseUrl"),
                assetCdnBaseUrl = value.getString("assetCdnBaseUrl").trimEnd('/') + "/",
                payloadManifestUrl = value.getString("payloadManifestUrl"),
                payloadManifestSha256 = value.getString("payloadManifestSha256").lowercase(),
                payloadId = value.getString("payloadId"),
                payloadFileCount = value.getLong("payloadFileCount"),
                payloadTotalBytes = value.getLong("payloadTotalBytes"),
            ).also { contract ->
                require(contract.packageName.isNotBlank()) { "Android client package is missing." }
                require(contract.localHttpPort in 1..65535) { "Android client HTTP port is invalid." }
                require(contract.originalServerInfoBaseUrl.length == contract.patchedServerInfoBaseUrl.length) {
                    "Android client endpoint patch must be fixed-width."
                }
                require(contract.assetCdnBaseUrl.startsWith("https://") || contract.assetCdnBaseUrl.startsWith("http://")) {
                    "Android asset CDN URL is invalid."
                }
                require(contract.payloadManifestUrl.startsWith("https://") || contract.payloadManifestUrl.startsWith("http://")) {
                    "Android payload manifest URL is invalid."
                }
                require(contract.payloadManifestSha256.matches(Regex("[a-f0-9]{64}"))) {
                    "Android payload manifest hash is invalid."
                }
                require(contract.payloadId.isNotBlank() && contract.payloadFileCount > 0 && contract.payloadTotalBytes > 0) {
                    "Android payload manifest contract is incomplete."
                }
            }
        }
    }
}

internal data class AndroidClientValidation(val ok: Boolean, val message: String)

internal fun validateAndroidPayloadManifest(
    contract: AndroidClientContract,
    manifestBytes: ByteArray,
): JSONObject {
    val manifestHash = MessageDigest.getInstance("SHA-256")
        .digest(manifestBytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    check(manifestHash == contract.payloadManifestSha256) {
        "Payload manifest hash does not match this RevivalSide build."
    }

    val manifest = JSONObject(manifestBytes.toString(Charsets.UTF_8))
    check(manifest.optInt("schemaVersion") == 1) { "Payload manifest schema is unsupported." }
    check(manifest.optString("id") == contract.payloadId) { "Payload ID does not match this RevivalSide build." }
    check(manifest.optString("packageName") == contract.packageName) { "Payload package does not match Counter:Side." }
    check(manifest.optString("versionName") == contract.versionName) { "Payload client version name is mismatched." }
    check(manifest.optLong("versionCode") == contract.versionCode) { "Payload client version code is mismatched." }
    check(manifest.optString("patchVersion") == contract.patchVersion) { "Payload content version is mismatched." }
    check(manifest.optLong("fileCount") == contract.payloadFileCount) { "Payload file count is mismatched." }
    check(manifest.optLong("totalBytes") == contract.payloadTotalBytes) { "Payload byte count is mismatched." }

    val files = manifest.getJSONArray("files")
    check(files.length().toLong() == contract.payloadFileCount) { "Payload files array is incomplete." }
    val paths = HashSet<String>(files.length())
    var totalBytes = 0L
    for (index in 0 until files.length()) {
        val entry = files.getJSONObject(index)
        val path = normalizeAndroidPayloadPath(entry.getString("path"))
        val size = entry.getLong("size")
        val sha256 = entry.getString("sha256").lowercase()
        check(size >= 0L && sha256.matches(Regex("[a-f0-9]{64}")) && paths.add(path)) {
            "Payload manifest has an invalid or duplicate entry: $path"
        }
        totalBytes = Math.addExact(totalBytes, size)
    }
    check(totalBytes == contract.payloadTotalBytes) { "Payload file sizes do not match the declared total." }
    return manifest
}

internal fun normalizeAndroidPayloadPath(value: String): String {
    val path = value.replace('\\', '/')
    check(path.isNotBlank() && !path.startsWith('/') && path.split('/').none { it.isBlank() || it == "." || it == ".." }) {
        "Unsafe Android payload path: $value"
    }
    return path
}

internal fun validateInstalledAndroidClient(
    context: Context,
    targetPackage: String,
    httpPort: Int,
): AndroidClientValidation {
    val contract = runCatching { AndroidClientContract.load(context) }
        .getOrElse { return AndroidClientValidation(false, "Client contract failed: ${it.message}") }
    if (targetPackage != contract.packageName) {
        return AndroidClientValidation(false, "Expected ${contract.packageName}, not $targetPackage.")
    }
    if (httpPort != contract.localHttpPort) {
        return AndroidClientValidation(false, "HTTP port must be ${contract.localHttpPort} for the patched client.")
    }

    val packageInfo = try {
        context.packageManager.getPackageInfo(targetPackage, 0)
    } catch (_: PackageManager.NameNotFoundException) {
        return AndroidClientValidation(false, "Counter:Side is not installed.")
    }
    val installedVersionCode = if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else {
        @Suppress("DEPRECATION")
        packageInfo.versionCode.toLong()
    }
    if (installedVersionCode != contract.versionCode || packageInfo.versionName != contract.versionName) {
        return AndroidClientValidation(
            false,
            "Counter:Side ${packageInfo.versionName} ($installedVersionCode) does not match ${contract.versionName} (${contract.versionCode}).",
        )
    }

    val sourceApk = packageInfo.applicationInfo?.sourceDir?.let(::File)
        ?: return AndroidClientValidation(false, "Counter:Side base APK was not found.")
    return runCatching {
        ZipFile(sourceApk).use { apk ->
            val entry = apk.getEntry(contract.metadataEntry)
                ?: return@use AndroidClientValidation(false, "Counter:Side IL2CPP metadata is missing.")
            apk.getInputStream(entry).use { input ->
                if (input.containsBytes(contract.patchedServerInfoBaseUrl.toByteArray(Charsets.UTF_8))) {
                    AndroidClientValidation(true, "Patched client ${contract.versionName} / ${contract.patchVersion} ready")
                } else {
                    AndroidClientValidation(false, "Official client detected. Install the RevivalSide-patched Counter:Side APK set first.")
                }
            }
        }
    }.getOrElse { AndroidClientValidation(false, "Could not inspect Counter:Side: ${it.message}") }
}

internal fun validateAndroidPayloadHost(
    context: Context,
    assetCdnBaseUrl: String,
): AndroidClientValidation {
    val contract = runCatching { AndroidClientContract.load(context) }
        .getOrElse { return AndroidClientValidation(false, "Client contract failed: ${it.message}") }
    val cdnBaseUrl = assetCdnBaseUrl.trim().trimEnd('/') + "/"
    if (!cdnBaseUrl.startsWith("https://") && !cdnBaseUrl.startsWith("http://")) {
        return AndroidClientValidation(false, "Android asset CDN URL is invalid.")
    }
    return runCatching {
        val manifestBytes = readHttpBytes(contract.payloadManifestUrl, "payload manifest", MAX_PAYLOAD_MANIFEST_BYTES)
        validateAndroidPayloadManifest(contract, manifestBytes)

        val liveVersionBytes = readHttpBytes(
            "${cdnBaseUrl}Android/liveVersion.json",
            "Android live version",
            MAX_LIVE_VERSION_BYTES,
        )
        val versions = JSONObject(liveVersionBytes.toString(Charsets.UTF_8)).getJSONArray("versionList")
        check((0 until versions.length()).any { versions.optJSONObject(it)?.optString("version") == contract.patchVersion }) {
            "Android CDN does not advertise ${contract.patchVersion}."
        }
        AndroidClientValidation(true, "Payload host ${contract.payloadId} / ${contract.patchVersion} ready")
    }.getOrElse { AndroidClientValidation(false, "Android payload host failed: ${it.message}") }
}

private fun readHttpBytes(url: String, label: String, maxBytes: Int): ByteArray {
    val connection = URL(url).openConnection() as HttpURLConnection
    return try {
        connection.connectTimeout = PAYLOAD_CONNECT_TIMEOUT_MS
        connection.readTimeout = PAYLOAD_READ_TIMEOUT_MS
        connection.requestMethod = "GET"
        connection.useCaches = false
        val status = connection.responseCode
        if (status !in 200..299) throw IllegalStateException("$label returned HTTP $status.")
        val declaredLength = connection.contentLengthLong
        if (declaredLength > maxBytes) throw IllegalStateException("$label is larger than $maxBytes bytes.")
        val initialSize = declaredLength.coerceAtLeast(4096L).coerceAtMost(maxBytes.toLong()).toInt()
        val output = ByteArrayOutputStream(initialSize)
        val buffer = ByteArray(32 * 1024)
        connection.inputStream.use { input ->
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > maxBytes) throw IllegalStateException("$label exceeded $maxBytes bytes.")
                output.write(buffer, 0, count)
            }
        }
        output.toByteArray()
    } finally {
        connection.disconnect()
    }
}

private const val PAYLOAD_CONNECT_TIMEOUT_MS = 5000
private const val PAYLOAD_READ_TIMEOUT_MS = 15000
private const val MAX_PAYLOAD_MANIFEST_BYTES = 16 * 1024 * 1024
private const val MAX_LIVE_VERSION_BYTES = 1024 * 1024

private fun InputStream.containsBytes(needle: ByteArray): Boolean {
    if (needle.isEmpty()) return true
    val failure = IntArray(needle.size)
    var prefix = 0
    for (index in 1 until needle.size) {
        while (prefix > 0 && needle[index] != needle[prefix]) prefix = failure[prefix - 1]
        if (needle[index] == needle[prefix]) prefix += 1
        failure[index] = prefix
    }
    val input = BufferedInputStream(this)
    var matched = 0
    while (true) {
        val value = input.read()
        if (value < 0) return false
        val byte = value.toByte()
        while (matched > 0 && byte != needle[matched]) matched = failure[matched - 1]
        if (byte == needle[matched]) matched += 1
        if (matched == needle.size) return true
    }
}
