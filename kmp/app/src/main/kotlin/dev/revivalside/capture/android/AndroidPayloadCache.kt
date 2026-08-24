package dev.revivalside.capture.android

import android.content.Context
import android.net.Uri
import android.os.StatFs
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.zip.ZipInputStream

internal data class AndroidPayloadImportProgress(
    val files: Long,
    val totalFiles: Long,
    val bytes: Long,
    val totalBytes: Long,
    val currentPath: String,
)

internal object AndroidPayloadCache {
    private const val CACHE_DIR = "android-client-payload"
    private const val MARKER = ".revivalside-payload.json"
    private const val ROOT_MANIFEST = "payload-manifest.json"
    private const val MIRROR_MANIFEST = "android-client/payload-manifest.json"
    private const val MAX_MANIFEST_BYTES = 16 * 1024 * 1024
    private const val COPY_BUFFER_BYTES = 1024 * 1024
    private const val STORAGE_HEADROOM_BYTES = 2L * 1024L * 1024L * 1024L
    private const val PROGRESS_INTERVAL_MS = 250L

    fun localCdnPort(httpPort: Int): Int = httpPort

    fun nodeMirrorPort(httpPort: Int): Int = if (httpPort < 65535) httpPort + 1 else httpPort - 1

    fun localCdnOrigin(httpPort: Int): String = "http://127.0.0.1:${localCdnPort(httpPort)}"

    fun localCdnBaseUrl(httpPort: Int): String = "http://127.0.0.1:${localCdnPort(httpPort)}/patchfiles/"

    fun activeRoot(context: Context): File? {
        val contract = runCatching { AndroidClientContract.load(context) }.getOrNull() ?: return null
        val root = payloadRoot(context, contract)
        val marker = runCatching { JSONObject(File(root, MARKER).readText(Charsets.UTF_8)) }.getOrNull() ?: return null
        if (marker.optInt("schemaVersion") != 1 ||
            marker.optString("manifestSha256") != contract.payloadManifestSha256 ||
            marker.optString("payloadId") != contract.payloadId ||
            marker.optLong("fileCount") != contract.payloadFileCount ||
            marker.optLong("totalBytes") != contract.payloadTotalBytes
        ) return null

        val manifestFile = File(root, ROOT_MANIFEST)
        val liveVersion = File(root, "patchfiles/Android/liveVersion.json")
        if (!manifestFile.isFile || manifestFile.length() !in 1..MAX_MANIFEST_BYTES.toLong() || !liveVersion.isFile) return null
        return runCatching {
            validateAndroidPayloadManifest(contract, manifestFile.readBytes())
            root
        }.getOrNull()
    }

    fun validate(context: Context): AndroidClientValidation {
        val contract = runCatching { AndroidClientContract.load(context) }
            .getOrElse { return AndroidClientValidation(false, "Client contract failed: ${it.message}") }
        return if (activeRoot(context) != null) {
            AndroidClientValidation(true, "Imported payload ${contract.payloadId} / ${contract.patchVersion} ready")
        } else {
            AndroidClientValidation(false, "Import the matching RevivalSide Android payload ZIP first.")
        }
    }

    fun importZip(
        context: Context,
        uri: Uri,
        progress: (AndroidPayloadImportProgress) -> Unit,
    ): AndroidClientValidation {
        val contract = runCatching { AndroidClientContract.load(context) }
            .getOrElse { return AndroidClientValidation(false, "Client contract failed: ${it.message}") }
        val target = payloadRoot(context, contract)
        val cacheRoot = target.parentFile ?: return AndroidClientValidation(false, "Payload cache path is invalid.")
        val staging = File(cacheRoot, ".importing-${contract.payloadManifestSha256}")

        return runCatching {
            cacheRoot.mkdirs()
            check(cacheRoot.isDirectory) { "Could not create the private payload cache." }
            if (activeRoot(context) != null) {
                return@runCatching AndroidClientValidation(true, "Matching payload ${contract.payloadId} is already imported.")
            }
            staging.deleteRecursively()
            check(staging.mkdirs()) { "Could not create the payload staging directory." }

            context.contentResolver.openInputStream(uri)?.buffered(COPY_BUFFER_BYTES)?.use { source ->
                ZipInputStream(source).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null && entry.isDirectory) {
                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                    check(entry != null && normalizeAndroidPayloadPath(entry.name) == ROOT_MANIFEST) {
                        "This is not the original RevivalSide payload ZIP (payload-manifest.json must be first)."
                    }
                    val manifestBytes = readLimited(zip, MAX_MANIFEST_BYTES)
                    val manifest = validateAndroidPayloadManifest(contract, manifestBytes)
                    val expected = HashMap<String, ExpectedFile>(manifest.getJSONArray("files").length())
                    val files = manifest.getJSONArray("files")
                    for (index in 0 until files.length()) {
                        val item = files.getJSONObject(index)
                        val path = normalizeAndroidPayloadPath(item.getString("path"))
                        expected[path] = ExpectedFile(item.getLong("size"), item.getString("sha256").lowercase())
                    }

                    removeStaleCaches(cacheRoot, staging)
                    val available = StatFs(cacheRoot.absolutePath).availableBytes
                    val required = Math.addExact(
                        Math.multiplyExact(contract.payloadTotalBytes, 2L),
                        STORAGE_HEADROOM_BYTES,
                    )
                    check(available >= required) {
                        "Not enough free storage. Payload extraction plus Counter:Side installation needs " +
                            "${formatBytes(required)}, but ${formatBytes(available)} is available."
                    }
                    File(staging, ROOT_MANIFEST).writeBytes(manifestBytes)
                    zip.closeEntry()

                    val seen = HashSet<String>(expected.size)
                    var copiedFiles = 0L
                    var copiedBytes = 0L
                    var lastProgressAt = 0L
                    entry = zip.nextEntry
                    while (entry != null) {
                        if (!entry.isDirectory) {
                            val path = normalizeAndroidPayloadPath(entry.name)
                            if (path == ROOT_MANIFEST || path == MIRROR_MANIFEST) {
                                val duplicate = readLimited(zip, MAX_MANIFEST_BYTES)
                                check(duplicate.contentEquals(manifestBytes)) { "Payload manifest copies do not match." }
                            } else {
                                val expectedFile = expected[path] ?: error("Unexpected payload file: $path")
                                check(seen.add(path)) { "Duplicate payload file: $path" }
                                val output = safeFile(staging, path)
                                output.parentFile?.mkdirs()
                                val digest = MessageDigest.getInstance("SHA-256")
                                var size = 0L
                                FileOutputStream(output).buffered(COPY_BUFFER_BYTES).use { destination ->
                                    val buffer = ByteArray(COPY_BUFFER_BYTES)
                                    while (true) {
                                        val count = zip.read(buffer)
                                        if (count < 0) break
                                        size = Math.addExact(size, count.toLong())
                                        check(size <= expectedFile.size) { "Payload file is larger than declared: $path" }
                                        destination.write(buffer, 0, count)
                                        digest.update(buffer, 0, count)
                                    }
                                }
                                val sha256 = digest.digest().toHex()
                                check(size == expectedFile.size && sha256 == expectedFile.sha256) {
                                    "Payload file failed verification: $path"
                                }
                                copiedFiles += 1
                                copiedBytes = Math.addExact(copiedBytes, size)
                                val now = android.os.SystemClock.elapsedRealtime()
                                if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || copiedFiles == contract.payloadFileCount) {
                                    progress(AndroidPayloadImportProgress(copiedFiles, contract.payloadFileCount, copiedBytes, contract.payloadTotalBytes, path))
                                    lastProgressAt = now
                                }
                            }
                        }
                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                    check(seen.size.toLong() == contract.payloadFileCount && copiedBytes == contract.payloadTotalBytes) {
                        "Payload ZIP is incomplete (${seen.size}/${contract.payloadFileCount} files)."
                    }
                }
            } ?: error("Android could not open the selected ZIP.")

            File(staging, MARKER).writeText(
                JSONObject()
                    .put("schemaVersion", 1)
                    .put("manifestSha256", contract.payloadManifestSha256)
                    .put("payloadId", contract.payloadId)
                    .put("fileCount", contract.payloadFileCount)
                    .put("totalBytes", contract.payloadTotalBytes)
                    .toString() + "\n",
                Charsets.UTF_8,
            )
            if (target.exists()) target.deleteRecursively()
            check(staging.renameTo(target)) { "Could not activate the verified payload cache." }
            check(activeRoot(context) != null) { "Imported payload activation failed verification." }
            AndroidClientValidation(true, "Imported ${contract.payloadId}: ${contract.payloadFileCount} files, ${formatBytes(contract.payloadTotalBytes)}")
        }.getOrElse { error ->
            staging.deleteRecursively()
            AndroidClientValidation(false, "Payload import failed: ${error.message}")
        }
    }

    private fun payloadRoot(context: Context, contract: AndroidClientContract): File {
        return File(File(RevivalSideSettingsStore.appRoot(context), CACHE_DIR), contract.payloadManifestSha256)
    }

    private fun removeStaleCaches(cacheRoot: File, staging: File) {
        cacheRoot.listFiles()?.forEach { child ->
            if (child != staging) child.deleteRecursively()
        }
    }

    private fun safeFile(root: File, relativePath: String): File {
        val normalized = normalizeAndroidPayloadPath(relativePath)
        return File(root, normalized.replace('/', File.separatorChar))
    }

    private fun readLimited(zip: ZipInputStream, limit: Int): ByteArray {
        val output = ByteArrayOutputStream(64 * 1024)
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = zip.read(buffer)
            if (count < 0) break
            check(output.size() + count <= limit) { "Payload manifest exceeds $limit bytes." }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun formatBytes(bytes: Long): String = "%.1f GB".format(java.util.Locale.US, bytes / 1_073_741_824.0)

    private data class ExpectedFile(val size: Long, val sha256: String)
}
