using System.Reflection;
using System.Text;
using System.Text.Json;

namespace RevivalSide.CombatHost;

// Called by the patched combat-host copy of Assembly-CSharp.dll.
//
// The original NKMLua.LoadCommonPathBase falls through into Unity TextAsset /
// AssetBundle APIs. In this standalone host we already have decrypted gameplay
// tables on disk, so the patched method delegates here instead.
public static class ManagedLuaFileLoader
{
    private static readonly object Gate = new();
    private static string gameplayTablesDir = "";
    private static FieldInfo? luaServerField;
    private static FieldInfo? fileNameForDebugField;
    private static MethodInfo? luaDoByteString;
    private static MethodInfo? luaDoTextString;

    public static void Configure(string tablesDir)
    {
        lock (Gate)
        {
            gameplayTablesDir = string.IsNullOrWhiteSpace(tablesDir) ? "" : Path.GetFullPath(tablesDir);
        }
    }

    public static bool LoadCommonPathBase(
        object nkmlua,
        string bundleName,
        string fileName,
        bool bAddCompiledLuaPostFix,
        bool bUseDevScript,
        ref string errorMessage)
    {
        try
        {
            if (TryLoad(nkmlua, bundleName, fileName, out errorMessage))
            {
                return true;
            }

            if (bUseDevScript && TryLoad(nkmlua, bundleName, fileName + "_DEV", out errorMessage))
            {
                return true;
            }

            errorMessage = $"dumped Lua table not found: bundle={bundleName} file={fileName}";
            return false;
        }
        catch (Exception ex)
        {
            errorMessage = ex.ToString();
            return false;
        }
    }

    private static bool TryLoad(object nkmlua, string bundleName, string fileName, out string errorMessage)
    {
        errorMessage = "";
        var candidate = FindLuaFile(bundleName, fileName);
        if (candidate == null)
        {
            return false;
        }

        EnsureReflection(nkmlua);
        fileNameForDebugField?.SetValue(nkmlua, fileName);
        var luaServer = luaServerField?.GetValue(nkmlua);
        if (luaServer == null)
        {
            errorMessage = "NKMLua.m_LuaSvr was not available";
            return false;
        }

        var chunkName = Path.GetFileNameWithoutExtension(candidate);
        if (Path.GetExtension(candidate).Equals(".json", StringComparison.OrdinalIgnoreCase))
        {
            luaDoTextString?.Invoke(luaServer, new object?[] { BuildLuaTextFromJson(File.ReadAllText(candidate), fileName), chunkName });
            return true;
        }

        var bytes = File.ReadAllBytes(candidate);
        if (IsLuaBytecode(bytes))
        {
            luaDoByteString?.Invoke(luaServer, new object?[] { bytes, chunkName, "b" });
            ApplyHostTablePatch(luaServer, fileName, Path.GetFileNameWithoutExtension(fileName));
        }
        else
        {
            luaDoTextString?.Invoke(luaServer, new object?[] { File.ReadAllText(candidate), chunkName });
            ApplyHostTablePatch(luaServer, fileName, Path.GetFileNameWithoutExtension(fileName));
        }

        return true;
    }

    private static void EnsureReflection(object nkmlua)
    {
        if (luaServerField != null) return;
        lock (Gate)
        {
            if (luaServerField != null) return;
            var luaType = nkmlua.GetType();
            luaServerField = luaType.GetField("m_LuaSvr", BindingFlags.NonPublic | BindingFlags.Instance);
            fileNameForDebugField = luaType.GetField("fileNameForDebug", BindingFlags.NonPublic | BindingFlags.Instance);
            var luaServerType = luaServerField?.FieldType;
            if (luaServerType == null) return;
            luaDoByteString = luaServerType.GetMethod(
                "DoString",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                new[] { typeof(byte[]), typeof(string), typeof(string) },
                null);
            luaDoTextString = luaServerType.GetMethod(
                "DoString",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                new[] { typeof(string), typeof(string) },
                null);
        }
    }

    private static string? FindLuaFile(string bundleName, string fileName)
    {
        if (string.IsNullOrWhiteSpace(gameplayTablesDir) || !Directory.Exists(gameplayTablesDir))
        {
            return null;
        }

        var bundle = bundleName.ToLowerInvariant();
        var file = Path.GetFileName(fileName);
        foreach (var sourceRoot in GetTableSourceRoots())
        {
            foreach (var extension in new[] { ".luac", ".lua", ".bytes", ".json" })
            {
                var candidate = Path.Combine(sourceRoot, bundle, "luac", file + extension);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    private static IEnumerable<string> GetTableSourceRoots()
    {
        var modTablesDir = Environment.GetEnvironmentVariable("CS_MOD_TABLES_DIR");
        if (!string.IsNullOrWhiteSpace(modTablesDir))
        {
            foreach (var root in ExpandTableSourceRoot(modTablesDir))
            {
                yield return root;
            }
        }

        foreach (var root in ExpandTableSourceRoot(gameplayTablesDir))
        {
            yield return root;
        }
    }

    private static IEnumerable<string> ExpandTableSourceRoot(string root)
    {
        if (string.IsNullOrWhiteSpace(root)) yield break;
        root = Path.GetFullPath(root);
        var rootName = Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (rootName.Equals("StreamingAssets", StringComparison.OrdinalIgnoreCase)
            || rootName.Equals("Assetbundles", StringComparison.OrdinalIgnoreCase))
        {
            yield return root;
            yield break;
        }

        yield return Path.Combine(root, "Assetbundles");
        yield return Path.Combine(root, "StreamingAssets");
    }

    private static string BuildLuaTextFromJson(string json, string fileName)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var rootName = Path.GetFileNameWithoutExtension(fileName);
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("rootName", out var rootNameElement)
            && rootNameElement.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(rootNameElement.GetString()))
        {
            rootName = rootNameElement.GetString()!;
        }

        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("globals", out var globalsElement)
            && globalsElement.ValueKind == JsonValueKind.Object)
        {
            var globalsBuilder = new StringBuilder(json.Length + 64);
            foreach (var property in globalsElement.EnumerateObject())
            {
                AppendLuaGlobal(globalsBuilder, property.Name);
                globalsBuilder.Append(" = ");
                AppendLuaValue(globalsBuilder, property.Value);
                globalsBuilder.AppendLine();
            }
            AppendHostTablePatch(globalsBuilder, fileName, rootName);
            return globalsBuilder.ToString();
        }

        var tableElement = root;
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("root", out var tableRootElement)
            && (tableRootElement.ValueKind == JsonValueKind.Object || tableRootElement.ValueKind == JsonValueKind.Array))
        {
            tableElement = tableRootElement;
        }
        else if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("records", out var recordsElement)
            && recordsElement.ValueKind == JsonValueKind.Array)
        {
            tableElement = recordsElement;
        }

        var builder = new StringBuilder(json.Length + 64);
        AppendLuaGlobal(builder, rootName);
        builder.Append(" = ");
        AppendLuaValue(builder, tableElement);
        AppendHostTablePatch(builder, fileName, rootName);
        return builder.ToString();
    }

    private static void ApplyHostTablePatch(object luaServer, string fileName, string rootName)
    {
        if (!IsThagirionDollUnitTemplet(fileName))
        {
            return;
        }

        var builder = new StringBuilder(1024);
        AppendHostTablePatch(builder, fileName, rootName);
        if (!string.Equals(rootName, "NKMUnitTemplet", StringComparison.Ordinal))
        {
            AppendThagirionDollAttackPatch(builder, "NKMUnitTemplet");
        }
        luaDoTextString?.Invoke(luaServer, new object?[] { builder.ToString(), $"{rootName}_HostPatch" });
    }

    private static void AppendHostTablePatch(StringBuilder builder, string fileName, string rootName)
    {
        if (!IsThagirionDollUnitTemplet(fileName))
        {
            return;
        }

        AppendThagirionDollAttackPatch(builder, rootName);
    }

    private static void AppendThagirionDollAttackPatch(StringBuilder builder, string rootName)
    {
        builder.AppendLine();
        builder.AppendLine("do");
        builder.Append("  local templet = ");
        AppendLuaGlobal(builder, rootName);
        builder.AppendLine();
        builder.AppendLine("  if templet and templet.m_dicNKMUnitState then");
        builder.AppendLine("    for _, state in pairs(templet.m_dicNKMUnitState) do");
        builder.AppendLine("      if state and state.m_StateName == \"USN_ATTACK1\" then");
        builder.AppendLine("        state.m_listNKMEventAttack = state.m_listNKMEventAttack or {}");
        builder.AppendLine("        if #state.m_listNKMEventAttack == 0 then");
        builder.AppendLine("          state.m_listNKMEventAttack[1] = {");
        builder.AppendLine("            m_bAnimTime = true,");
        builder.AppendLine("            m_fEventTimeMin = 0.7333333333333333,");
        builder.AppendLine("            m_fEventTimeMax = 0.7333333333333333,");
        builder.AppendLine("            m_fRangeMin = -50.0,");
        builder.AppendLine("            m_fRangeMax = 320.0,");
        builder.AppendLine("            m_NKM_DAMAGE_TARGET_TYPE = \"NDTT_ENEMY\",");
        builder.AppendLine("            m_AttackUnitCount = 1,");
        builder.AppendLine("            m_DamageTempletName = \"DT_MOB_NORMAL_COMMON_UNION_GUARDIAN_ATTACK1_END\"");
        builder.AppendLine("          }");
        builder.AppendLine("        end");
        builder.AppendLine("      end");
        builder.AppendLine("    end");
        builder.AppendLine("  end");
        builder.AppendLine("end");
    }

    private static bool IsThagirionDollUnitTemplet(string fileName)
    {
        return string.Equals(
            Path.GetFileNameWithoutExtension(fileName),
            "NKM_MOB_NORMAL_EP15_THAGIRION_DOLLS",
            StringComparison.OrdinalIgnoreCase);
    }

    private static void AppendLuaGlobal(StringBuilder builder, string name)
    {
        if (IsLuaIdentifier(name))
        {
            builder.Append(name);
            return;
        }

        builder.Append("_G[");
        AppendLuaString(builder, name);
        builder.Append(']');
    }

    private static void AppendLuaValue(StringBuilder builder, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                AppendLuaObject(builder, element);
                break;
            case JsonValueKind.Array:
                AppendLuaArray(builder, element);
                break;
            case JsonValueKind.String:
                AppendLuaString(builder, element.GetString() ?? "");
                break;
            case JsonValueKind.Number:
                builder.Append(element.GetRawText());
                break;
            case JsonValueKind.True:
                builder.Append("true");
                break;
            case JsonValueKind.False:
                builder.Append("false");
                break;
            default:
                builder.Append("nil");
                break;
        }
    }

    private static void AppendLuaObject(StringBuilder builder, JsonElement element)
    {
        builder.Append('{');
        var first = true;
        foreach (var property in element.EnumerateObject())
        {
            if (!first) builder.Append(',');
            first = false;
            AppendLuaKey(builder, property.Name);
            builder.Append('=');
            AppendLuaValue(builder, property.Value);
        }
        builder.Append('}');
    }

    private static void AppendLuaArray(StringBuilder builder, JsonElement element)
    {
        builder.Append('{');
        var first = true;
        foreach (var item in element.EnumerateArray())
        {
            if (!first) builder.Append(',');
            first = false;
            AppendLuaValue(builder, item);
        }
        builder.Append('}');
    }

    private static void AppendLuaKey(StringBuilder builder, string key)
    {
        if (IsLuaIdentifier(key))
        {
            builder.Append(key);
            return;
        }

        builder.Append('[');
        AppendLuaString(builder, key);
        builder.Append(']');
    }

    private static void AppendLuaString(StringBuilder builder, string value)
    {
        builder.Append('"');
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '\\':
                    builder.Append(@"\\");
                    break;
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\n':
                    builder.Append(@"\n");
                    break;
                case '\r':
                    builder.Append(@"\r");
                    break;
                case '\t':
                    builder.Append(@"\t");
                    break;
                default:
                    if (char.IsControl(ch))
                    {
                        builder.Append('\\');
                        builder.Append(((int)ch).ToString("D3"));
                    }
                    else
                    {
                        builder.Append(ch);
                    }
                    break;
            }
        }
        builder.Append('"');
    }

    private static bool IsLuaIdentifier(string value)
    {
        if (string.IsNullOrEmpty(value)) return false;
        if (!(IsAsciiLetter(value[0]) || value[0] == '_')) return false;
        for (var i = 1; i < value.Length; i++)
        {
            if (!(IsAsciiLetter(value[i]) || char.IsDigit(value[i]) || value[i] == '_')) return false;
        }
        return true;
    }

    private static bool IsAsciiLetter(char value)
    {
        return value is >= 'A' and <= 'Z' or >= 'a' and <= 'z';
    }

    private static bool IsLuaBytecode(byte[] bytes)
    {
        return bytes.Length >= 4 && bytes[0] == 0x1b && bytes[1] == (byte)'L' && bytes[2] == (byte)'u' && bytes[3] == (byte)'a';
    }
}
