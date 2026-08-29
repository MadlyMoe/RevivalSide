package dev.revivalside.capture.android

import android.content.Context
import java.io.File
import java.net.URI

internal data class RevivalSideSettings(
    val targetPackage: String = DEFAULT_COUNTERSIDE_PACKAGE,
    val gamePort: Int = DEFAULT_GAME_PORT,
    val httpPort: Int = DEFAULT_HTTP_PORT,
    val assetCdnBaseUrl: String = "",
    val redirectPorts: Set<Int> = setOf(DEFAULT_GAME_PORT),
    val eventDate: String = DEFAULT_EVENT_DATE,
    val loginBackground: String = DEFAULT_LOGIN_BACKGROUND,
    val joinLobbyAckMode: String = DEFAULT_JOIN_LOBBY_ACK_MODE,
    val nodePath: String = "",
    val dotnetPath: String = "",
) {
    val redirectPortsText: String
        get() = redirectPorts.sorted().joinToString(",")
}

internal object RevivalSideSettingsStore {
    private const val PREFS = "revivalside_android"
    private const val KEY_TARGET_PACKAGE = "target_package"
    private const val KEY_GAME_PORT = "game_port"
    private const val KEY_HTTP_PORT = "http_port"
    private const val KEY_ASSET_CDN_BASE_URL = "asset_cdn_base_url"
    private const val KEY_REDIRECT_PORTS = "redirect_ports"
    private const val KEY_EVENT_DATE = "event_date"
    private const val KEY_LOGIN_BACKGROUND = "login_background"
    private const val KEY_JOIN_LOBBY_ACK_MODE = "join_lobby_ack_mode"
    private const val KEY_NODE_PATH = "node_path"
    private const val KEY_DOTNET_PATH = "dotnet_path"
    private const val LEGACY_ADB_ASSET_CDN_BASE_URL = "http://127.0.0.1:18088/patchfiles/"
    private const val LEGACY_SHARED_ASSET_CDN_BASE_URL = "http://127.0.0.1:8088/patchfiles/"

    fun load(context: Context): RevivalSideSettings {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val gamePort = prefs.getInt(KEY_GAME_PORT, DEFAULT_GAME_PORT).coercePort(DEFAULT_GAME_PORT)
        val contractCdn = runCatching { AndroidClientContract.load(context).assetCdnBaseUrl }.getOrDefault("")
        val savedCdn = prefs.getString(KEY_ASSET_CDN_BASE_URL, "")?.trim().orEmpty()
        return RevivalSideSettings(
            targetPackage = prefs.getString(KEY_TARGET_PACKAGE, DEFAULT_COUNTERSIDE_PACKAGE)
                ?.ifBlank { DEFAULT_COUNTERSIDE_PACKAGE }
                ?: DEFAULT_COUNTERSIDE_PACKAGE,
            gamePort = gamePort,
            httpPort = prefs.getInt(KEY_HTTP_PORT, DEFAULT_HTTP_PORT).coercePort(DEFAULT_HTTP_PORT),
            assetCdnBaseUrl = if (savedCdn == LEGACY_ADB_ASSET_CDN_BASE_URL ||
                savedCdn == LEGACY_SHARED_ASSET_CDN_BASE_URL ||
                runCatching { URI(savedCdn).host in setOf("127.0.0.1", "localhost") }.getOrDefault(false)
            ) {
                contractCdn
            } else {
                savedCdn.ifBlank { contractCdn }
            },
            redirectPorts = parsePorts(prefs.getString(KEY_REDIRECT_PORTS, "") ?: "", setOf(gamePort)),
            eventDate = prefs.getString(KEY_EVENT_DATE, DEFAULT_EVENT_DATE)?.trim() ?: DEFAULT_EVENT_DATE,
            loginBackground = normalizeLoginBackground(
                prefs.getString(KEY_LOGIN_BACKGROUND, DEFAULT_LOGIN_BACKGROUND),
            ),
            joinLobbyAckMode = normalizeJoinLobbyAckMode(
                prefs.getString(KEY_JOIN_LOBBY_ACK_MODE, DEFAULT_JOIN_LOBBY_ACK_MODE),
            ),
            nodePath = prefs.getString(KEY_NODE_PATH, "")?.trim().orEmpty(),
            dotnetPath = prefs.getString(KEY_DOTNET_PATH, "")?.trim().orEmpty(),
        )
    }

    fun save(context: Context, settings: RevivalSideSettings) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TARGET_PACKAGE, settings.targetPackage.ifBlank { DEFAULT_COUNTERSIDE_PACKAGE })
            .putInt(KEY_GAME_PORT, settings.gamePort.coercePort(DEFAULT_GAME_PORT))
            .putInt(KEY_HTTP_PORT, settings.httpPort.coercePort(DEFAULT_HTTP_PORT))
            .putString(KEY_ASSET_CDN_BASE_URL, normalizeAssetCdnUrl(settings.assetCdnBaseUrl))
            .putString(KEY_REDIRECT_PORTS, settings.redirectPortsText)
            .putString(KEY_EVENT_DATE, settings.eventDate.trim())
            .putString(KEY_LOGIN_BACKGROUND, normalizeLoginBackground(settings.loginBackground))
            .putString(KEY_JOIN_LOBBY_ACK_MODE, normalizeJoinLobbyAckMode(settings.joinLobbyAckMode))
            .putString(KEY_NODE_PATH, settings.nodePath.trim())
            .putString(KEY_DOTNET_PATH, settings.dotnetPath.trim())
            .apply()
    }

    fun appRoot(context: Context): File = File(context.filesDir, "revivalside")

    fun serverDataDir(context: Context): File = File(appRoot(context), "server-data")

    fun logsDir(context: Context): File = File(appRoot(context), "logs")

    fun parsePorts(text: String, defaultPorts: Set<Int>): Set<Int> {
        val parsed = text.split(',', ';', ' ')
            .mapNotNull { part -> part.trim().toIntOrNull() }
            .filter { it in 1..65535 }
            .toSet()
        return parsed.ifEmpty { defaultPorts }
    }

    fun normalizeJoinLobbyAckMode(value: String?): String {
        return when (value?.trim()?.lowercase()) {
            "0", "false", "off" -> "off"
            "1", "true", "on" -> "on"
            else -> DEFAULT_JOIN_LOBBY_ACK_MODE
        }
    }

    fun normalizeLoginBackground(value: String?): String {
        val background = value.orEmpty().trim()
        return if (background == DEFAULT_LOGIN_BACKGROUND || background.toIntOrNull()?.let { it > 0 } == true) {
            background
        } else {
            DEFAULT_LOGIN_BACKGROUND
        }
    }

    fun normalizeAssetCdnUrl(value: String?): String {
        val normalized = value.orEmpty().trim().trimEnd('/')
        return if (normalized.isBlank()) "" else "$normalized/"
    }

    fun parsePort(value: String, fallback: Int): Int = value.trim().toIntOrNull().coercePort(fallback)

    private fun Int?.coercePort(fallback: Int): Int {
        val value = this ?: fallback
        return if (value in 1..65535) value else fallback
    }
}

internal const val DEFAULT_COUNTERSIDE_PACKAGE = "com.studiobside.CounterSide"
internal const val DEFAULT_GAME_PORT = 22000
internal const val DEFAULT_HTTP_PORT = 8088
internal const val DEFAULT_EVENT_DATE = "2025-04-10"
internal const val DEFAULT_LOGIN_BACKGROUND = "auto"
internal const val DEFAULT_JOIN_LOBBY_ACK_MODE = "auto"
internal const val INTERNAL_BROADCAST_PERMISSION = "dev.revivalside.officialprofilecapture.INTERNAL_STATUS"
