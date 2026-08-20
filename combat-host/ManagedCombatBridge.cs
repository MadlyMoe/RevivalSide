using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace RevivalSide.CombatHost;

// Reflection bridge into the installed CounterSide Managed assemblies.
//
// The Node listener still owns sockets and packet order. This bridge owns the
// real in-process NKCGameServerLocal instance when the installed client DLLs are
// available, and drains the packets that the local server enqueues for the
// Unity client path.
internal static class ManagedCombatBridge
{
    private const int GameLoadAck = 804;
    private const int GameLoadCompleteAck = 808;
    private const int GameEnd = 811;
    private const int GamePauseAck = 813;
    private const int GameRespawnAck = 817;
    private const int GameShipSkillAck = 819;
    private const int GameSync = 822;
    private const int GameUseUnitSkillAck = 830;
    private const int JoinLobbyAck = 205;
    private const float ManagedFrameDelta = 0.033333335f;
    private const int ManagedMaxCatchUpFrames = 3;
    private const int ManagedActionPrimeFrames = 1;
    private const int QuietGameSyncPayloadBytes = 64;
    private const float ClientSyncLeadSeconds = 0.4f;

    private static readonly Dictionary<string, ManagedCombatSession> Sessions = new();
    private static readonly string[] LocalJoinLobbyFields =
    [
        "errorCode",
        "friendCode",
        "lobbyData",
        "gameData",
        "warfareGameData",
        "utcTime",
        "utcOffset",
        "lastCreditSupplyTakeTime",
        "lastEterniumSupplyTakeTime",
        "totalPaidAmount",
        "pvpPointChargeTime",
        "contractState",
        "contractBonusState",
        "selectableContractState",
        "stagePlayDataList",
        "reconnectKey",
        "backGroundInfo",
        "officeState",
        "unlockedStageIds",
        "phaseClearDataList",
        "phaseModeState",
        "completedUnitMissions",
        "rewardEnableUnitMissions",
        "userProfileData",
        "lastPlayInfo",
        "customPickupContracts"
    ];
    private static readonly HashSet<string> OfficialContractJoinLobbyFields = new(StringComparer.Ordinal)
    {
        "contractState",
        "contractBonusState",
        "selectableContractState",
        "customPickupContracts"
    };
    private static readonly string[] LocalJoinLobbyUserDataFields =
    [
        "m_UserUID",
        "m_FriendCode",
        "m_UserNickName",
        "m_UserLevel",
        "m_lUserLevelEXP",
        "m_eAuthLevel",
        "m_NKMUserDateData",
        "m_InventoryData",
        "m_ArmyData",
        "m_UserOption",
        "m_dicNKMDungeonClearData",
        "m_WorldmapData",
        "m_dicNKMWarfareClearData",
        "m_MissionData",
        "m_ShopData",
        "m_dicNKMCounterCaseData",
        "m_dicEpisodeCompleteData",
        "m_DiveGameData",
        "m_DiveClearData",
        "m_DiveHistoryData",
        "m_companyBuffDataList",
        "backGroundInfo",
        "m_BirthDayData",
        "m_JukeboxData"
    ];
    private static void CopyField(ManagedRuntime runtime, object source, object target, string fieldName)
    {
        runtime.SetField(target, fieldName, runtime.GetField(source, fieldName));
    }

    private static void MergeJoinLobbyUserData(ManagedRuntime runtime, object localPacket, object officialPacket)
    {
        var localUserData = runtime.GetField(localPacket, "userData");
        if (localUserData == null) return;

        var officialUserData = runtime.GetField(officialPacket, "userData");
        if (officialUserData == null)
        {
            runtime.SetField(officialPacket, "userData", localUserData);
            return;
        }

        foreach (var fieldName in LocalJoinLobbyUserDataFields)
        {
            CopyField(runtime, localUserData, officialUserData, fieldName);
        }
    }

    private static void MergeIntervalData(
        ManagedRuntime runtime,
        object localPacket,
        object officialPacket,
        IEnumerable<string>? mergeStrKeys = null)
    {
        var localIntervalData = runtime.GetField(localPacket, "intervalData");
        if (localIntervalData == null) return;

        var officialIntervalData = runtime.GetField(officialPacket, "intervalData");
        if (officialIntervalData == null)
        {
            runtime.SetField(officialPacket, "intervalData", localIntervalData);
            return;
        }

        if (officialIntervalData is not IList officialList || localIntervalData is not IEnumerable localEnumerable)
        {
            runtime.SetField(officialPacket, "intervalData", localIntervalData);
            return;
        }

        var includeKeys = new HashSet<string>(
            (mergeStrKeys ?? Array.Empty<string>())
                .Where(key => !string.IsNullOrWhiteSpace(key))
                .Select(key => key.Trim()),
            StringComparer.OrdinalIgnoreCase);
        var indexByStrKey = new Dictionary<string, int>(StringComparer.Ordinal);
        var usedKeys = new HashSet<int>();
        for (var index = 0; index < officialList.Count; index += 1)
        {
            var item = officialList[index];
            var strKey = Convert.ToString(item == null ? null : runtime.GetField(item, "strKey"), CultureInfo.InvariantCulture);
            if (!string.IsNullOrWhiteSpace(strKey) && !indexByStrKey.ContainsKey(strKey))
            {
                indexByStrKey[strKey] = index;
            }

            if (TryGetIntField(runtime, item, "key", out var officialKey))
            {
                usedKeys.Add(officialKey);
            }
        }

        var nextSyntheticKey = 2_000_000_000;
        foreach (var localItem in localEnumerable)
        {
            var strKey = Convert.ToString(runtime.GetField(localItem, "strKey"), CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(strKey)) continue;
            if (includeKeys.Count > 0 && !includeKeys.Contains(strKey)) continue;
            if (indexByStrKey.TryGetValue(strKey, out var existingIndex))
            {
                if (!IsFallbackIntervalTiming(runtime, localItem))
                {
                    CopyIntervalTiming(runtime, localItem, officialList[existingIndex]);
                }
                continue;
            }

            if (!TryGetIntField(runtime, localItem, "key", out var localKey) || usedKeys.Contains(localKey))
            {
                while (usedKeys.Contains(nextSyntheticKey)) nextSyntheticKey -= 1;
                localKey = nextSyntheticKey;
                runtime.SetField(localItem, "key", localKey);
                nextSyntheticKey -= 1;
            }

            usedKeys.Add(localKey);
            indexByStrKey[strKey] = officialList.Count;
            officialList.Add(localItem);
        }
    }

    private static void DeactivateIntervalsByStrKey(
        ManagedRuntime runtime,
        object packet,
        IEnumerable<string>? strKeys,
        IEnumerable<string>? preserveStrKeys,
        bool filterInactiveEventIntervals)
    {
        var removeKeys = new HashSet<string>(
            (strKeys ?? Array.Empty<string>())
                .Where(key => !string.IsNullOrWhiteSpace(key))
                .Select(key => key.Trim()),
            StringComparer.OrdinalIgnoreCase);
        var preserveKeys = new HashSet<string>(
            (preserveStrKeys ?? Array.Empty<string>())
                .Where(key => !string.IsNullOrWhiteSpace(key))
                .Select(key => key.Trim()),
            StringComparer.OrdinalIgnoreCase);
        if (removeKeys.Count == 0 && !filterInactiveEventIntervals) return;

        var intervalData = runtime.GetField(packet, "intervalData");
        if (intervalData is not IList list) return;

        for (var index = list.Count - 1; index >= 0; index -= 1)
        {
            var item = list[index];
            var strKey = Convert.ToString(item == null ? null : runtime.GetField(item, "strKey"), CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(strKey) || preserveKeys.Contains(strKey)) continue;
            if (removeKeys.Contains(strKey) || (filterInactiveEventIntervals && IsEventManagedIntervalKey(strKey)))
            {
                DeactivateIntervalTiming(runtime, item);
            }
        }
    }

    private static void DeactivateIntervalTiming(ManagedRuntime runtime, object? target)
    {
        if (target == null) return;
        runtime.SetField(target, "startDate", new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        runtime.SetField(target, "endDate", new DateTime(2000, 1, 2, 0, 0, 0, DateTimeKind.Utc));
        runtime.SetField(target, "repeatStartDate", 0);
        runtime.SetField(target, "repeatEndDate", 0);
    }

    private static bool IsEventManagedIntervalKey(string strKey)
    {
        var key = strKey.Trim();
        return key.StartsWith("DATE_COMMON_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_COMMON_EPISODE_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_COMMON_MISSION_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_COMMON_SHOP_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLBOAL_EVENT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_CLASSIFIED_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_KOR_CLASSIFIED_", StringComparison.OrdinalIgnoreCase) ||
            key.Equals("DATE_KOR_CONTRACT_OLD_VERSION", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_FIRST_CONTRACT_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_CUSTOM_PICKUP_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_PICUP_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("DATE_GLOBAL_PICKUP_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("SHOP_CASH_PACKAGE_", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("SHOP_TAB_PACKAGE_", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("_EVENT_PASS_", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsFallbackIntervalTiming(ManagedRuntime runtime, object? target)
    {
        if (!TryGetDateTimeField(runtime, target, "startDate", out var startDate)) return false;
        if (!TryGetDateTimeField(runtime, target, "endDate", out var endDate)) return false;
        return IsUtcMidnightDate(startDate, 2000, 1, 1) && IsUtcMidnightDate(endDate, 2000, 1, 2);
    }

    private static bool TryGetDateTimeField(ManagedRuntime runtime, object? target, string fieldName, out DateTime value)
    {
        value = default;
        if (target == null) return false;
        var rawValue = runtime.GetField(target, fieldName);
        if (rawValue == null) return false;
        if (rawValue is DateTime dateTime)
        {
            value = dateTime;
            return true;
        }

        try
        {
            value = Convert.ToDateTime(rawValue, CultureInfo.InvariantCulture);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsUtcMidnightDate(DateTime value, int year, int month, int day)
    {
        return value.Year == year &&
            value.Month == month &&
            value.Day == day &&
            value.Hour == 0 &&
            value.Minute == 0 &&
            value.Second == 0;
    }

    private static bool TryGetIntField(ManagedRuntime runtime, object? target, string fieldName, out int value)
    {
        value = 0;
        if (target == null) return false;
        var rawValue = runtime.GetField(target, fieldName);
        if (rawValue == null) return false;
        try
        {
            value = Convert.ToInt32(rawValue, CultureInfo.InvariantCulture);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void CopyIntervalTiming(ManagedRuntime runtime, object source, object? target)
    {
        if (target == null) return;
        CopyField(runtime, source, target, "startDate");
        CopyField(runtime, source, target, "endDate");
        CopyField(runtime, source, target, "repeatStartDate");
        CopyField(runtime, source, target, "repeatEndDate");
    }

    private static void EnsureUniqueIntervalKeys(ManagedRuntime runtime, object packet)
    {
        var intervalData = runtime.GetField(packet, "intervalData");
        if (intervalData is not IEnumerable enumerable) return;

        var usedKeys = new HashSet<int>();
        var nextSyntheticKey = 2_000_000_000;
        foreach (var item in enumerable)
        {
            if (!TryGetIntField(runtime, item, "key", out var key) || key == 0 || usedKeys.Contains(key))
            {
                while (usedKeys.Contains(nextSyntheticKey)) nextSyntheticKey -= 1;
                key = nextSyntheticKey;
                runtime.SetField(item, "key", key);
                nextSyntheticKey -= 1;
            }

            usedKeys.Add(key);
        }
    }

    public static bool TryWarmup(HostOptions options, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables(options.ContentsTags);
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            return false;
        }
    }

    public static bool TryExportLuaTable(
        HostOptions options,
        GameplayTableExportData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            response = new HostResponse
            {
                Ok = true,
                TableJson = runtime.ExportLuaTableJson(data)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            return false;
        }
    }

    public static bool TryValidateUnitTemplets(
        HostOptions options,
        UnitTempletValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null) return false;
        try
        {
            runtime.InitializeClientTables(options.ContentsTags);
            var unitIds = (data.UnitIds ?? []).Where(id => id > 0).Distinct().OrderBy(id => id).ToArray();
            var missing = runtime.FindMissingUnitTemplets(unitIds);
            if (missing.Count > 0)
            {
                error = $"combat host did not load usable mod unit battle templates: {string.Join(",", missing)}";
                return false;
            }
            response = new HostResponse { Ok = true, Summary = $"recognized unit IDs: {string.Join(",", unitIds)}" };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            return false;
        }
    }

    public static bool TryValidatePacket(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId, payload);
            var serialized = runtime.SerializePacket(packet, data.PacketId, "validate");
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = Convert.FromBase64String(serialized.PayloadBase64).Length,
                PayloadBase64 = data.PacketId is 4101 or 4132 ? serialized.PayloadBase64 : null,
                Summary = data.PacketId is 4101 or 4132 ? runtime.DescribePrivatePvpLobby(packet) : null
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectGameLoadAck(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables(options.ContentsTags);
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? GameLoadAck : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeGameLoadAck(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectGameSync(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables(options.ContentsTags);
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? GameSync : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeGameSync(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectGameLoadCompleteAck(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables(options.ContentsTags);
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? GameLoadCompleteAck : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeGameLoadCompleteAck(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryInspectJoinLobbyAck(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? JoinLobbyAck : data.PacketId, payload);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = runtime.DescribeJoinLobbyAck(packet)
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryExtractJoinLobbyIntervals(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? JoinLobbyAck : data.PacketId, payload);
            var intervals = runtime.ExportJoinLobbyIntervals(packet);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = $"intervals={intervals.Count}",
                Intervals = intervals
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryExtractJoinLobbyProfile(
        HostOptions options,
        PacketValidationData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var payload = Convert.FromBase64String(data.PayloadBase64 ?? "");
            var packet = runtime.DeserializePacket(data.PacketId == 0 ? JoinLobbyAck : data.PacketId, payload);
            var profile = runtime.ExportJoinLobbyProfile(packet);
            response = new HostResponse
            {
                Ok = true,
                PacketType = packet.GetType().FullName,
                SerializedPayloadSize = payload.Length,
                Summary = $"uid={profile.UserUid} nickname={profile.Nickname} units={profile.Army.Units.Count} ships={profile.Army.Ships.Count} operators={profile.Army.Operators.Count} equips={profile.Inventory.Equips.Count} misc={profile.Inventory.Misc.Count}",
                OfficialProfile = profile
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryMergeJoinLobbyAck(
        HostOptions options,
        JoinLobbyMergeData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var official = runtime.DeserializePacket(JoinLobbyAck, Convert.FromBase64String(data.OfficialPayloadBase64 ?? ""));
            var local = runtime.DeserializePacket(JoinLobbyAck, Convert.FromBase64String(data.LocalPayloadBase64 ?? ""));

            foreach (var fieldName in LocalJoinLobbyFields)
            {
                if (data.PreserveOfficialContractData && OfficialContractJoinLobbyFields.Contains(fieldName)) continue;
                CopyField(runtime, local, official, fieldName);
            }
            if (data.PreserveOfficialContractData && data.OverlayLocalContractData)
            {
                OverlayLocalContractData(runtime, official, local);
            }
            if (data.ReplaceIntervalData)
            {
                CopyField(runtime, local, official, "intervalData");
            }
            else if (data.CopyIntervalData)
            {
                DeactivateIntervalsByStrKey(
                    runtime,
                    official,
                    data.ExcludeIntervalStrKeys,
                    data.PreserveIntervalStrKeys,
                    data.FilterInactiveEventIntervals);
                MergeIntervalData(runtime, local, official, data.MergeIntervalStrKeys);
            }
            EnsureUniqueIntervalKeys(runtime, official);
            MergeJoinLobbyUserData(runtime, local, official);

            var serialized = runtime.SerializePacket(official, JoinLobbyAck, "merged-join-lobby");
            response = new HostResponse
            {
                Ok = true,
                PacketType = official.GetType().FullName,
                PayloadBase64 = serialized.PayloadBase64,
                SerializedPayloadSize = Convert.FromBase64String(serialized.PayloadBase64).Length
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    private static void OverlayLocalContractData(ManagedRuntime runtime, object officialPacket, object localPacket)
    {
        // Keep the official JOIN_LOBBY_ACK field layout intact, but let local
        // recruit counters replace matching official objects after pulls.
        MergeObjectListByIntKey(runtime, officialPacket, localPacket, "contractState", "contractId", item => HasLocalContractProgress(runtime, item));
        MergeObjectListByIntKey(runtime, officialPacket, localPacket, "contractBonusState", "bonusGroupId", item => HasLocalContractBonusProgress(runtime, item));
        MergeObjectListByIntKey(runtime, officialPacket, localPacket, "customPickupContracts", "customPickupId", item => HasLocalCustomPickupProgress(runtime, item));

        var selectable = runtime.GetField(localPacket, "selectableContractState");
        if (HasMeaningfulSelectableContractState(runtime, selectable))
        {
            runtime.SetField(officialPacket, "selectableContractState", selectable);
        }
    }

    private static void MergeObjectListByIntKey(
        ManagedRuntime runtime,
        object officialPacket,
        object localPacket,
        string fieldName,
        string keyFieldName,
        Func<object, bool>? shouldMerge = null)
    {
        var localValue = runtime.GetField(localPacket, fieldName);
        if (localValue is not IEnumerable localEnumerable) return;

        var officialValue = runtime.GetField(officialPacket, fieldName);
        if (officialValue is not IList officialList)
        {
            runtime.SetField(officialPacket, fieldName, FilterObjectList(localValue, shouldMerge));
            return;
        }

        var indexByKey = new Dictionary<int, int>();
        for (var index = 0; index < officialList.Count; index += 1)
        {
            var key = ReadIntField(runtime, officialList[index], keyFieldName);
            if (key > 0 && !indexByKey.ContainsKey(key)) indexByKey[key] = index;
        }

        foreach (var localItem in localEnumerable)
        {
            if (shouldMerge != null && !shouldMerge(localItem)) continue;
            var key = ReadIntField(runtime, localItem, keyFieldName);
            if (key <= 0) continue;
            if (indexByKey.TryGetValue(key, out var existingIndex))
            {
                officialList[existingIndex] = localItem;
            }
            else
            {
                indexByKey[key] = officialList.Count;
                officialList.Add(localItem);
            }
        }
    }

    private static object FilterObjectList(object localValue, Func<object, bool>? shouldMerge)
    {
        if (shouldMerge == null || localValue is not IList source) return localValue;
        var destination = (IList)Activator.CreateInstance(localValue.GetType())!;
        foreach (var item in source)
        {
            if (item != null && shouldMerge(item)) destination.Add(item);
        }
        return destination;
    }

    private static bool HasLocalContractProgress(ManagedRuntime runtime, object? state)
    {
        if (state == null) return false;
        if (ReadIntField(runtime, state, "contractId") <= 0) return false;
        return ReadIntField(runtime, state, "totalUseCount") > 0 ||
            ReadIntField(runtime, state, "dailyUseCount") > 0;
    }

    private static bool HasLocalContractBonusProgress(ManagedRuntime runtime, object? state)
    {
        if (state == null) return false;
        if (ReadIntField(runtime, state, "bonusGroupId") <= 0) return false;
        return ReadIntField(runtime, state, "useCount") > 0 ||
            ReadIntField(runtime, state, "resetCount") > 0;
    }

    private static bool HasLocalCustomPickupProgress(ManagedRuntime runtime, object? state)
    {
        if (state == null) return false;
        if (ReadIntField(runtime, state, "customPickupId") <= 0) return false;
        return ReadIntField(runtime, state, "totalUseCount") > 0 ||
            ReadIntField(runtime, state, "customPickupTargetUnitId") > 0 ||
            ReadIntField(runtime, state, "currentSelectCount") > 0;
    }

    private static bool HasMeaningfulSelectableContractState(ManagedRuntime runtime, object? state)
    {
        if (state == null) return false;
        if (ReadIntField(runtime, state, "contractId") <= 0) return false;
        if (ReadIntField(runtime, state, "unitPoolChangeCount") > 0) return true;
        if (runtime.GetField(state, "unitIdList") is IList units && units.Count > 0) return true;
        var isActiveValue = runtime.GetField(state, "isActive");
        return isActiveValue is bool isActive && !isActive;
    }

    private static int ReadIntField(ManagedRuntime runtime, object? item, string fieldName)
    {
        if (item == null) return 0;
        try
        {
            return Convert.ToInt32(runtime.GetField(item, fieldName) ?? 0, CultureInfo.InvariantCulture);
        }
        catch
        {
            return 0;
        }
    }

    public static bool TryNormalizeJoinLobbyAck(
        HostOptions options,
        JoinLobbyNormalizeData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            error = "managed dir required";
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            var local = runtime.DeserializePacket(JoinLobbyAck, Convert.FromBase64String(data.LocalPayloadBase64 ?? ""));
            var normalized = runtime.Create("ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK");
            runtime.SetField(normalized, "userData", runtime.Create("NKM.NKMUserData"));

            foreach (var fieldName in LocalJoinLobbyFields)
            {
                CopyField(runtime, local, normalized, fieldName);
            }
            CopyField(runtime, local, normalized, "intervalData");
            EnsureUniqueIntervalKeys(runtime, normalized);
            MergeJoinLobbyUserData(runtime, local, normalized);

            var serialized = runtime.SerializePacket(normalized, JoinLobbyAck, "normalized-join-lobby");
            response = new HostResponse
            {
                Ok = true,
                PacketType = normalized.GetType().FullName,
                PayloadBase64 = serialized.PayloadBase64,
                SerializedPayloadSize = Convert.FromBase64String(serialized.PayloadBase64).Length
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryStart(
        HostOptions options,
        StartBattleData data,
        DynamicGameState dynamicGame,
        BattleState? battleState,
        out HostPacket? gameLoadAck,
        out string? error)
    {
        gameLoadAck = null;
        error = null;
        if (string.IsNullOrWhiteSpace(options.ManagedDir))
        {
            return false;
        }

        var runtime = ManagedRuntime.TryLoad(options.ManagedDir, options.GameplayTablesDir, out error);
        if (runtime == null)
        {
            return false;
        }

        try
        {
            runtime.InitializeClientTables(options.ContentsTags);
            object? gameData = null;
            if (!string.IsNullOrWhiteSpace(data.GameLoadAckPayloadBase64))
            {
                var gameLoadAckTemplate = runtime.DeserializePacket(GameLoadAck, Convert.FromBase64String(data.GameLoadAckPayloadBase64));
                gameData = runtime.GetField(gameLoadAckTemplate, "gameData");
            }
            else
            {
                gameData = runtime.BuildGameData(data, dynamicGame);
            }
            if (gameData == null)
            {
                error = "managed GAME_LOAD_ACK contained null gameData";
                return false;
            }

            var server = runtime.Create("NKC.NKCGameServerLocal");
            runtime.Invoke(server, "EndGame");
            runtime.Invoke(server, "Init");
            runtime.SetField(gameData, "m_GameUID", dynamicGame.GameUID);
            if (dynamicGame.RaidUID > 0)
            {
                runtime.SetField(gameData, "m_RaidUID", dynamicGame.RaidUID);
            }
            runtime.ApplyRaidDifficulty(gameData, dynamicGame);
            if (dynamicGame.DungeonID > 0)
            {
                runtime.SetField(gameData, "m_DungeonID", dynamicGame.DungeonID);
            }
            if (dynamicGame.MapID > 0)
            {
                runtime.SetField(gameData, "m_MapID", dynamicGame.MapID);
            }
            runtime.ApplyGameType(gameData, dynamicGame);
            runtime.ApplyBattleConditionIds(gameData, dynamicGame.BattleConditionIds);
            var eventDeckId = data.Stage?.EventDeckId ?? dynamicGame.DungeonID;
            var usesEventDeck = ShouldApplyEventDeck(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId);
            var usesTutorialEventDeck = ShouldApplyTutorialEventDeckTeamA(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId);
            if (usesEventDeck)
            {
                runtime.ApplyEventDeckTeamA(gameData, eventDeckId);
                runtime.ApplyPlayerDeckFreeSlotsTeamA(
                    gameData,
                    data.Stage?.PlayerDeck,
                    data.Stage?.EventDeckFreeUnitSlots,
                    data.Stage?.EventDeckFreeShipSlot == true,
                    eventDeckId);
            }
            else if (usesTutorialEventDeck)
            {
                runtime.ApplyTutorialEventDeckTeamA(gameData, eventDeckId);
            }
            runtime.PrepareGameDataForLocalServer(gameData);
            runtime.ApplyGameType(gameData, dynamicGame);
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            if (!runtime.TryApplyDungeonGameTeamData(gameData, runtimeData, out error))
            {
                return false;
            }
            runtime.ApplyPlayerIdentityRuntimeData(runtimeData, data.Stage?.PlayerDeck);
            runtime.ApplyPlayerIdentityRuntimeDataB(runtimeData, data.Stage?.PlayerDeckB);
            runtime.PrepareGameDataForLocalServer(gameData);
            if (!usesEventDeck && !usesTutorialEventDeck)
            {
                runtime.ApplyPlayerDeckTeamA(gameData, data.Stage?.PlayerDeck, dynamicGame.StageID, dynamicGame.DungeonID);
            }
            runtime.ApplyPlayerDeckTeamB(gameData, data.Stage?.PlayerDeckB, dynamicGame.StageID, dynamicGame.DungeonID);
            runtime.RefreshTutorialTeamADeck(gameData, dynamicGame.StageID, dynamicGame.DungeonID);
            runtime.ApplyPlayerIdentityTeamA(gameData, data.Stage?.PlayerDeck);
            runtime.ApplyPlayerIdentityTeamB(gameData, data.Stage?.PlayerDeckB);
            runtime.ApplyGameType(gameData, dynamicGame);
            runtime.ApplyTeamAStartingRespawnCost(gameData, runtimeData);
            runtime.ApplyTeamBStartingRespawnCost(gameData, runtimeData);
            runtime.Invoke(server, "SetGameData", gameData);
            if (runtimeData != null)
            {
                runtime.ApplyPlayerIdentityRuntimeData(runtimeData, data.Stage?.PlayerDeck);
                runtime.ApplyPlayerIdentityRuntimeDataB(runtimeData, data.Stage?.PlayerDeckB);
                runtime.ApplyTeamAStartingRespawnCost(gameData, runtimeData);
                runtime.ApplyTeamBStartingRespawnCost(gameData, runtimeData);
                runtime.Invoke(server, "SetGameRuntimeData", runtimeData);
            }
            if (usesTutorialEventDeck)
            {
                runtime.SuppressPlayerDynamicRespawns(server, gameData);
            }
            runtime.ApplyPlayerIdentityTeamA(gameData, data.Stage?.PlayerDeck);
            runtime.ApplyPlayerIdentityTeamB(gameData, data.Stage?.PlayerDeckB);
            runtime.ClearTeamAUnitOwnersForGameLoadAck(gameData, data.Stage?.PlayerDeck);
            runtime.ClearTeamBUnitOwnersForGameLoadAck(gameData, data.Stage?.PlayerDeckB);
            runtime.ApplyGameType(gameData, dynamicGame);
            runtime.ApplyBattleConditionIds(gameData, dynamicGame.BattleConditionIds);
            // The Unity client builds its unit pool from GAME_LOAD_ACK. Send the
            // same gameData that NKCGameServerLocal just mutated so runtime
            // gameUnitUIDs resolve to the same unit/team on both sides.
            gameLoadAck = runtime.BuildGameLoadAck(gameData);
            var setupPackets = runtime.DrainClientPackets($"managed-setup-{dynamicGame.GameUID}");

            var sessionId = dynamicGame.GameUID.ToString(CultureInfo.InvariantCulture);
            var session = new ManagedCombatSession(sessionId, runtime, server, setupPackets, dynamicGame);
            session.RememberBattleState(battleState);
            session.CaptureRaidBossState(dynamicGame, battleState);
            
            // Set initial raid boss HP if this is a raid with saved progress
            var req = data.Req;
            if (req != null && req.RaidUID > 0 && req.RaidMaxHP > 0 && req.RaidCurHP < req.RaidMaxHP)
            {
                session.SetInitialRaidBossHP(req.RaidCurHP, req.RaidMaxHP);
            }
            
            Sessions[sessionId] = session;
            dynamicGame.ManagedSessionId = sessionId;
            dynamicGame.ManagedCombat = true;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            return false;
        }
    }

    public static bool TryDispose(DynamicGameState? dynamicGame, out string? error)
    {
        error = null;
        if (dynamicGame == null || string.IsNullOrWhiteSpace(dynamicGame.ManagedSessionId)) return true;
        if (!Sessions.Remove(dynamicGame.ManagedSessionId, out var session)) return true;
        try
        {
            session.Dispose();
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            return false;
        }
    }

    private static bool ShouldApplyEventDeck(int stageId, int dungeonId, int eventDeckId)
    {
        if (eventDeckId <= 0) return false;
        // Tutorial loads are now built from local tables in BuildGameData.
        // Keep normal event-deck rebuilding out of tutorial so the specialized
        // tutorial hydrator can own Team A consistently.
        return !IsTutorialStage(stageId) && !IsTutorialDungeon(dungeonId);
    }

    private static bool ShouldApplyTutorialEventDeckTeamA(int stageId, int dungeonId, int eventDeckId)
    {
        if (eventDeckId < 1004 || eventDeckId > 1007) return false;
        return IsTutorialStage(stageId) || IsTutorialDungeon(dungeonId);
    }

    private static bool IsTutorialStage(int stageId)
    {
        return stageId is 11211 or 11212 or 11213 or 11214;
    }

    private static bool IsTutorialDungeon(int dungeonId)
    {
        return dungeonId is 1004 or 1005 or 1006 or 1007;
    }

    public static bool TryBuildInitialSync(
        DynamicGameState? dynamicGame,
        BattleState? battleState,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(dynamicGame, out var session, out error))
        {
            return false;
        }

        try
        {
            session.RememberBattleState(battleState);
            var packets = new List<HostPacket>();
            session.ApplyRuntimeControls(dynamicGame);
            if (!session.Started)
            {
                packets.Add(session.BuildLoadCompleteAck());
                session.Start();
                packets.AddRange(session.DrainQueuedPackets("managed-game-start"));
                packets.AddRange(session.DrainSetupPackets());
                
                // Patch raid boss HP after units have spawned
                if (dynamicGame != null && dynamicGame.RaidUID > 0)
                {
                    session.PatchRaidBossUnitHP();
                }
            }

            // Tutorial phases carry dungeon events and UI triggers in the sync
            // stream. Drain only one local-server frame here so phase 2+ scripts
            // see the same steady cadence they get during the battle loop.
            packets.AddRange(session.UpdateAndDrain(ManagedFrameDelta, 1));
            session.CaptureRaidBossState(dynamicGame, battleState);
            var sync = LastPayload(packets, GameSync);
            response = new HostResponse
            {
                Ok = true,
                BattleState = battleState,
                Packets = packets,
                PayloadBase64 = sync
            };
            return sync != null || packets.Count > 0;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandleDeploy(
        DeployCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "deploy request required";
            return false;
        }

        try
        {
            session.RememberBattleState(data.BattleState);
            session.ApplyRuntimeControls(data.DynamicGame);
            session.EnsureStarted();
            var packets = session.HandleDeploy(data.Req, data.TeamType);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets,
                Deployed = new HostDeployResult
                {
                    Handled = true,
                    Mode = "managed-local-server"
                }
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandlePause(
        PauseCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "pause request required";
            return false;
        }

        try
        {
            session.RememberBattleState(data.BattleState);
            session.EnsureStarted();
            var packets = session.HandlePause(data.Req);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandleUnitSkill(
        UnitSkillCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "unit skill request required";
            return false;
        }

        try
        {
            session.RememberBattleState(data.BattleState);
            session.EnsureStarted();
            var packets = session.HandleUnitSkill(data.Req, data.TeamType);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryHandleShipSkill(
        ShipSkillCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        if (data.Req == null)
        {
            error = "ship skill request required";
            return false;
        }

        try
        {
            session.RememberBattleState(data.BattleState);
            session.EnsureStarted();
            var packets = session.HandleShipSkill(data.Req, data.TeamType);
            response = new HostResponse
            {
                Ok = true,
                DynamicGame = data.DynamicGame,
                BattleState = data.BattleState,
                Packets = packets
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryBuildSync(
        SyncCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        try
        {
            session.RememberBattleState(data.BattleState);
            session.ApplyRuntimeControls(data.DynamicGame);
            session.EnsureStarted();
            // Keep managed sync frame-based, but do not let reflection/packet
            // serialization stalls make the server simulation run slower than
            // the client. If the listener falls behind, catch up with a small
            // number of normal 33 ms frames and drain after each frame so
            // tutorial events and damage packets stay in their original order.
            var requestedDelta = (float)Math.Max(data.Delta ?? ManagedFrameDelta, 0.001);
            var frames = Math.Clamp((int)Math.Ceiling(requestedDelta / ManagedFrameDelta), 1, ManagedMaxCatchUpFrames);
            var delta = Math.Min(requestedDelta, ManagedFrameDelta * frames);
            var packets = session.UpdateAndDrain(delta, frames);
            session.CaptureRaidBossState(data.DynamicGame, data.BattleState);
            var sync = LastPayload(packets, GameSync);

            response = new HostResponse
            {
                Ok = true,
                BattleState = data.BattleState,
                Packets = packets,
                PayloadBase64 = sync,
                Summary = session.DescribeCombatSnapshot()
            };
            // NKCGameServerLocal does not emit a GAME_SYNC every host tick. An
            // empty drain means "no client packet this frame", not a combat-host
            // failure; the Node listener will simply skip sending for that tick.
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    public static bool TryBuildTimeline(
        TimelineCommandData data,
        out HostResponse? response,
        out string? error)
    {
        response = null;
        if (!TryGetSession(data.DynamicGame, out var session, out error))
        {
            return false;
        }

        try
        {
            session.RememberBattleState(data.BattleState);
            session.ApplyRuntimeControls(data.DynamicGame);
            session.EnsureStarted();
            var delta = (float)Math.Clamp(data.Delta ?? ManagedFrameDelta, 1.0 / 120.0, 0.1);
            var frameCount = Math.Clamp(data.MaxFrames, 1, 600);
            var frames = new List<CombatFrameSnapshot>(frameCount);
            for (var index = 0; index < frameCount; index += 1)
            {
                session.UpdateAndDrain(delta, 1);
                var frame = session.CaptureCombatFrame(data.StartIndex + index);
                frames.Add(frame);
                if (frame.Finished) break;
            }

            var last = frames[^1];
            response = new HostResponse
            {
                Ok = true,
                BattleState = data.BattleState,
                Timeline = new CombatTimelineChunk
                {
                    Delta = delta,
                    Finished = last.Finished,
                    WinTeam = last.WinTeam,
                    Frames = frames,
                    Records = last.Finished ? session.CaptureBattleRecords() : []
                }
            };
            return true;
        }
        catch (Exception ex)
        {
            error = ex.ToString();
            response = new HostResponse { Ok = false, Error = error };
            return false;
        }
    }

    private static string? LastPayload(IEnumerable<HostPacket> packets, int packetId)
    {
        return packets.LastOrDefault(packet => packet.PacketId == packetId)?.PayloadBase64;
    }

    private static bool TryGetSession(DynamicGameState? dynamicGame, out ManagedCombatSession session, out string? error)
    {
        session = null!;
        error = null;
        if (dynamicGame == null || !dynamicGame.ManagedCombat || string.IsNullOrWhiteSpace(dynamicGame.ManagedSessionId))
        {
            return false;
        }

        if (Sessions.TryGetValue(dynamicGame.ManagedSessionId, out session!))
        {
            return true;
        }

        error = $"managed combat session not found: {dynamicGame.ManagedSessionId}";
        return false;
    }

    private sealed class ManagedCombatSession
    {
        private readonly string sessionId;
        private readonly ManagedRuntime runtime;
        private readonly object server;
        private readonly List<HostPacket> setupPackets;
        private readonly MethodInfo forceSyncDataPackFlushThisFrame;
        private readonly MethodInfo syncDataPackFlush;
        private bool finishStateFlushedWithGameEnd;
        private float initialRemainGameTime = -1f;
        private float playStartClientGameTime = -1f;
        private DynamicGameState? latestDynamicGame;
        private BattleState? latestBattleState;
        private List<BattleUnitRecord>? latestGameEndBattleRecords;
        private bool? latestGameEndBattleWin;
        private int latestGameEndBattleWinTeam;
        private float latestGameEndBattlePlayTime = -1f;
        private int latestGameEndFiercePoint = -1;
        private int latestGameEndFiercePenaltyPoint = -1;
        private readonly Dictionary<int, VisualEffectClock> visualEffectClocks = [];
        private readonly List<ActiveClientEffect> activeClientEffects = [];
        private int nextClientEffectUid = -1;

        public ManagedCombatSession(string sessionId, ManagedRuntime runtime, object server, List<HostPacket> setupPackets, DynamicGameState? dynamicGame)
        {
            this.sessionId = sessionId;
            this.runtime = runtime;
            this.server = server;
            this.setupPackets = setupPackets;
            latestDynamicGame = dynamicGame;
            forceSyncDataPackFlushThisFrame = runtime.GetMethod(server.GetType(), "ForceSyncDataPackFlushThisFrame");
            syncDataPackFlush = runtime.GetMethod(server.GetType(), "SyncDataPackFlush");
        }

        public bool Started { get; private set; }

        public void RememberBattleState(BattleState? battleState)
        {
            if (battleState != null)
            {
                latestBattleState = battleState;
            }
        }

        private void RememberDynamicGame(DynamicGameState? dynamicGame)
        {
            if (dynamicGame != null)
            {
                latestDynamicGame = dynamicGame;
            }
        }

        public void ApplyRuntimeControls(DynamicGameState? dynamicGame)
        {
            RememberDynamicGame(dynamicGame);
            if (dynamicGame == null) return;
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            if (runtimeData == null) return;

            if (dynamicGame.GameSpeedType.HasValue)
            {
                runtime.SetField(runtimeData, "m_NKM_GAME_SPEED_TYPE", ClampControlEnum(dynamicGame.GameSpeedType.Value, 0, 5));
            }

            var runtimeTeamA = runtime.GetField(runtimeData, "m_NKMGameRuntimeTeamDataA");
            if (runtimeTeamA == null) return;
            if (dynamicGame.AutoSkillType.HasValue)
            {
                runtime.SetField(runtimeTeamA, "m_NKM_GAME_AUTO_SKILL_TYPE", ClampControlEnum(dynamicGame.AutoSkillType.Value, 0, 1));
            }
            if (dynamicGame.AutoRespawnEnabled.HasValue)
            {
                runtime.SetField(runtimeTeamA, "m_bAutoRespawn", dynamicGame.AutoRespawnEnabled.Value);
            }
            var runtimeTeamB = runtime.GetField(runtimeData, "m_NKMGameRuntimeTeamDataB");
            if (runtimeTeamB != null)
            {
                if (dynamicGame.AutoSkillTypeB.HasValue)
                {
                    runtime.SetField(runtimeTeamB, "m_NKM_GAME_AUTO_SKILL_TYPE", ClampControlEnum(dynamicGame.AutoSkillTypeB.Value, 0, 1));
                }
                if (dynamicGame.AutoRespawnEnabledB.HasValue)
                {
                    runtime.SetField(runtimeTeamB, "m_bAutoRespawn", dynamicGame.AutoRespawnEnabledB.Value);
                }
            }
        }

        private static int ClampControlEnum(int value, int min, int max)
        {
            return Math.Max(min, Math.Min(max, value));
        }

        public HostPacket BuildLoadCompleteAck()
        {
            var packet = runtime.Create("ClientPacket.Game.NKMPacket_GAME_LOAD_COMPLETE_ACK");
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            initialRemainGameTime = ReadFloat(runtime.GetField(runtimeData!, "m_fRemainGameTime"), -1f);
            runtime.SetField(packet, "gameRuntimeData", runtimeData);
            runtime.SetField(packet, "rewardMultiply", 1);
            return runtime.SerializePacket(packet, GameLoadCompleteAck, "managed-load-complete");
        }

        public void Start()
        {
            if (Started) return;
            runtime.Invoke(server, "StartGame", false);
            Started = true;
        }

        public void Dispose()
        {
            runtime.Invoke(server, "EndGame");
        }

        public List<HostPacket> DrainSetupPackets()
        {
            if (setupPackets.Count == 0) return [];
            var output = setupPackets.ToList();
            setupPackets.Clear();
            return output;
        }

        public List<HostPacket> DrainQueuedPackets(string label)
        {
            return DrainCombatPackets(label);
        }

        public void EnsureStarted()
        {
            if (!Started)
            {
                Start();
            }
        }

        public List<HostPacket> HandleDeploy(RespawnReq req, int teamTypeValue)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_RESPAWN_REQ");
            var requestedUnitUid = ParseLong(req.UnitUID);
            runtime.SetField(request, "unitUID", requestedUnitUid);
            runtime.SetField(request, "assistUnit", req.AssistUnit);
            runtime.SetField(request, "respawnPosX", (float)req.RespawnPosX);
            runtime.SetField(request, "gameTime", (float)req.GameTime);

            var respawnUnitUid = requestedUnitUid;
            var method = runtime.GetMethod(
                server.GetType(),
                "OnRecv",
                runtime.GetType("ClientPacket.Game.NKMPacket_GAME_RESPAWN_REQ"),
                runtime.GetType("NKM.NKM_TEAM_TYPE"),
                typeof(long).MakeByRefType());
            var teamType = runtime.GetType("NKM.NKM_TEAM_TYPE");
            var args = new object[] { request, Enum.ToObject(teamType, NormalizePlayerTeamType(teamTypeValue)), respawnUnitUid };
            var errorCode = method.Invoke(server, args);
            respawnUnitUid = Convert.ToInt64(args[2], CultureInfo.InvariantCulture);
            if (respawnUnitUid <= 0) respawnUnitUid = requestedUnitUid;

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_RESPAWN_ACK");
            runtime.SetField(ack, "errorCode", errorCode);
            runtime.SetField(ack, "unitUID", respawnUnitUid);
            runtime.SetField(ack, "assistUnit", req.AssistUnit);

            var packets = new List<HostPacket>
            {
                runtime.SerializePacket(ack, GameRespawnAck, "managed-respawn")
            };
            // Run one frame after the command so the ACK is not held behind a
            // hidden warm-up loop. The regular 33ms battle pump carries follow-up
            // movement/attack syncs.
            packets.AddRange(UpdateAndDrainUntilResponsive(ManagedActionPrimeFrames));
            return packets;
        }

        public List<HostPacket> HandlePause(PauseReq req)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_PAUSE_REQ");
            runtime.SetField(request, "isPause", req.IsPause);
            runtime.SetField(request, "isPauseEvent", req.IsPauseEvent);

            var method = runtime.GetMethod(server.GetType(), "OnRecv", runtime.GetType("ClientPacket.Game.NKMPacket_GAME_PAUSE_REQ"));
            var errorCode = method.Invoke(server, [request]);

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_PAUSE_ACK");
            runtime.SetField(ack, "errorCode", errorCode);
            runtime.SetField(ack, "isPause", req.IsPause);
            runtime.SetField(ack, "isPauseEvent", req.IsPauseEvent);

            return [runtime.SerializePacket(ack, GamePauseAck, "managed-pause")];
        }

        public List<HostPacket> HandleUnitSkill(UnitSkillReq req, int teamTypeValue)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_USE_UNIT_SKILL_REQ");
            runtime.SetField(request, "gameUnitUID", req.GameUnitUID);

            var teamType = runtime.GetType("NKM.NKM_TEAM_TYPE");
            var userDataType = runtime.GetType("NKM.NKMUserData");
            var method = runtime.GetMethod(
                server.GetType(),
                "OnRecv",
                runtime.GetType("ClientPacket.Game.NKMPacket_GAME_USE_UNIT_SKILL_REQ"),
                teamType,
                typeof(byte).MakeByRefType(),
                userDataType);
            var skillStateId = (byte)0;
            var args = new object?[] { request, Enum.ToObject(teamType, NormalizePlayerTeamType(teamTypeValue)), skillStateId, null };
            var errorCode = method.Invoke(server, args);
            skillStateId = Convert.ToByte(args[2], CultureInfo.InvariantCulture);

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_USE_UNIT_SKILL_ACK");
            runtime.SetField(ack, "errorCode", errorCode);
            runtime.SetField(ack, "gameUnitUID", req.GameUnitUID);
            runtime.SetField(ack, "skillStateID", (sbyte)skillStateId);

            var packets = new List<HostPacket>
            {
                runtime.SerializePacket(ack, GameUseUnitSkillAck, "managed-unit-skill")
            };
            packets.AddRange(UpdateAndDrainUntilResponsive(ManagedActionPrimeFrames));
            return packets;
        }

        public List<HostPacket> HandleShipSkill(ShipSkillReq req, int teamTypeValue)
        {
            var request = runtime.Create("ClientPacket.Game.NKMPacket_GAME_SHIP_SKILL_REQ");
            runtime.SetField(request, "gameUnitUID", req.GameUnitUID);
            runtime.SetField(request, "shipSkillID", req.ShipSkillID);
            runtime.SetField(request, "skillPosX", req.SkillPosX);

            var ack = runtime.Create("ClientPacket.Game.NKMPacket_GAME_SHIP_SKILL_ACK");
            runtime.SetField(ack, "gameUnitUID", req.GameUnitUID);
            runtime.SetField(ack, "shipSkillID", req.ShipSkillID);
            runtime.SetField(ack, "skillPosX", req.SkillPosX);

            var method = runtime.GetMethod(
                server.GetType(),
                "OnRecv",
                runtime.GetType("ClientPacket.Game.NKMPacket_GAME_SHIP_SKILL_REQ"),
                runtime.GetType("NKM.NKM_TEAM_TYPE"));
            var teamType = runtime.GetType("NKM.NKM_TEAM_TYPE");
            var errorCode = method.Invoke(server, [request, Enum.ToObject(teamType, NormalizePlayerTeamType(teamTypeValue))]);
            runtime.SetField(ack, "errorCode", errorCode);

            var packets = new List<HostPacket>
            {
                runtime.SerializePacket(ack, GameShipSkillAck, "managed-ship-skill")
            };
            packets.AddRange(UpdateAndDrainUntilResponsive(ManagedActionPrimeFrames));
            return packets;
        }

        private static int NormalizePlayerTeamType(int value)
        {
            return value == 3 ? 3 : 1;
        }

        private List<HostPacket> UpdateAndDrainUntilResponsive(int maxFrames)
        {
            var result = new List<HostPacket>();
            HostPacket? lastQuietSync = null;
            var frames = Math.Max(1, maxFrames);
            for (var index = 0; index < frames; index += 1)
            {
                var packets = UpdateAndDrain(ManagedFrameDelta, 1);
                foreach (var packet in packets)
                {
                    if (IsQuietGameSync(packet))
                    {
                        lastQuietSync = packet;
                        continue;
                    }

                    result.Add(packet);
                }

                if (result.Any(packet => packet.PacketId == GameSync))
                {
                    return result;
                }
            }

            if (!result.Any(packet => packet.PacketId == GameSync) && lastQuietSync != null)
            {
                result.Add(lastQuietSync);
            }

            return result;
        }

        private static bool IsQuietGameSync(HostPacket packet)
        {
            if (packet.PacketId != GameSync || string.IsNullOrWhiteSpace(packet.PayloadBase64)) return false;
            try
            {
                return Convert.FromBase64String(packet.PayloadBase64).Length <= QuietGameSyncPayloadBytes;
            }
            catch
            {
                return false;
            }
        }

        public List<HostPacket> UpdateAndDrain(float delta, int frames = 1)
        {
            var frameCount = Math.Max(1, frames);
            var frameDelta = delta / frameCount;
            var output = new List<HostPacket>();
            for (var index = 0; index < frameCount; index += 1)
            {
                runtime.Invoke(server, "Update", ScaleFrameDeltaForRuntimeSpeed(frameDelta));
                var framePackets = DrainCombatPackets($"managed-session-{sessionId}");
                if (!framePackets.Any(packet => packet.PacketId == GameSync) && IsRuntimeInPlayState())
                {
                    framePackets.AddRange(FlushSyncDataPackAndDrain());
                }
                if (!finishStateFlushedWithGameEnd && framePackets.Any(packet => packet.PacketId == GameEnd))
                {
                    finishStateFlushedWithGameEnd = true;
                    output.AddRange(FlushFinishStateSync());
                }
                output.AddRange(NormalizeTimerSyncs(framePackets));
            }
            return output;
        }

        private List<HostPacket> FlushSyncDataPackAndDrain()
        {
            forceSyncDataPackFlushThisFrame.Invoke(server, []);
            syncDataPackFlush.Invoke(server, []);
            return DrainCombatPackets($"managed-forced-sync-{sessionId}");
        }

        public string DescribeCombatSnapshot()
        {
            try
            {
                var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
                var gameData = runtime.Invoke(server, "GetGameData");
                if (runtimeData == null || gameData == null) return "runtime=null";
                return string.Join(" ", new[]
                {
                    $"state={runtime.GetField(runtimeData, "m_NKM_GAME_STATE")}",
                    $"time={ReadFloat(runtime.GetField(runtimeData, "m_GameTime"), 0f).ToString("0.###", CultureInfo.InvariantCulture)}",
                    $"play={ReadFloat(runtime.Invoke(runtimeData, "GetGamePlayTime"), 0f).ToString("0.###", CultureInfo.InvariantCulture)}",
                    $"live={DescribeUnitDictionary(runtime.GetField(server, "m_dicNKMUnit"))}",
                    $"pool={DescribeUnitDictionary(runtime.GetField(server, "m_dicNKMUnitPool"))}",
                    $"pending={DescribePendingRespawns()}",
                    $"teamAEvents={DescribeEventUnits(runtime.GetField(gameData, "m_NKMGameTeamDataA"))}",
                    $"teamBEvents={DescribeEventUnits(runtime.GetField(gameData, "m_NKMGameTeamDataB"))}",
                    $"damage={DescribeDamageTakenMap()}"
                });
            }
            catch (Exception ex)
            {
                return $"snapshotError={ex.GetType().Name}";
            }
        }

        public CombatFrameSnapshot CaptureCombatFrame(int index)
        {
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            if (runtimeData == null) throw new InvalidOperationException("managed combat runtime is unavailable");
            var gameData = runtime.Invoke(server, "GetGameData");
            var state = Convert.ToString(runtime.GetField(runtimeData, "m_NKM_GAME_STATE"), CultureInfo.InvariantCulture) ?? "";
            var teamA = runtime.GetField(runtimeData, "m_NKMGameRuntimeTeamDataA");
            var teamB = runtime.GetField(runtimeData, "m_NKMGameRuntimeTeamDataB");
            var frame = new CombatFrameSnapshot
            {
                Index = index,
                GameState = state,
                GameTime = ReadFloat(runtime.GetField(runtimeData, "m_GameTime"), 0f),
                PlayTime = ReadFloat(runtime.Invoke(runtimeData, "GetGamePlayTime"), 0f),
                RemainGameTime = ReadFloat(runtime.GetField(runtimeData, "m_fRemainGameTime"), 0f),
                WaveId = ReadInt(runtime.GetField(runtimeData, "m_WaveID"), 0),
                WinTeam = ReadInt(runtime.GetField(runtimeData, "m_WinTeam"), 0),
                Finished = string.Equals(state, "NGS_FINISH", StringComparison.Ordinal) ||
                    string.Equals(state, "NGS_END", StringComparison.Ordinal) ||
                    ReadBool(runtime.GetField(runtimeData, "m_bGameEnded"), false),
                RespawnCostA = ReadFloat(runtime.GetField(teamA!, "m_fRespawnCost"), 0f),
                RespawnCostB = ReadFloat(runtime.GetField(teamB!, "m_fRespawnCost"), 0f),
                AutoUltimateEnabled = string.Equals(
                    Convert.ToString(runtime.GetField(teamA!, "m_NKM_GAME_AUTO_SKILL_TYPE"), CultureInfo.InvariantCulture),
                    "NGST_AUTO",
                    StringComparison.Ordinal),
                MainUnitUidA = ReadMainUnitUid(gameData, "m_NKMGameTeamDataA"),
                MainUnitUidB = ReadMainUnitUid(gameData, "m_NKMGameTeamDataB"),
                Units = CaptureCombatUnits(),
                Effects = []
            };
            frame.Effects.AddRange(CaptureCombatEffects());
            frame.Effects.AddRange(CaptureClientEventEffects((float)frame.GameTime));
            return frame;
        }

        private int ReadMainUnitUid(object? gameData, string teamField)
        {
            var team = gameData == null ? null : runtime.GetField(gameData, teamField);
            var mainUnit = team == null ? null : runtime.GetField(team, "m_MainShip");
            if (mainUnit == null || runtime.GetField(mainUnit, "m_listGameUnitUID") is not IEnumerable gameUnitUids) return 0;
            return gameUnitUids.Cast<object?>().Select(value => ReadInt(value, 0)).FirstOrDefault(value => value > 0);
        }

        public List<BattleUnitRecord> CaptureBattleRecords()
        {
            if (latestGameEndBattleRecords is { Count: > 0 } records)
            {
                return records.Select(CopyBattleRecord).ToList();
            }

            var gameRecord = runtime.GetField(server, "m_GameRecord");
            gameRecord = BuildManagedGameRecordFromManagedState(gameRecord) ?? gameRecord;
            return ExportManagedGameRecordRecords(gameRecord);
        }

        private List<CombatUnitSnapshot> CaptureCombatUnits()
        {
            var output = new List<CombatUnitSnapshot>();
            if (runtime.GetField(server, "m_dicNKMUnit") is not IDictionary units) return output;
            foreach (DictionaryEntry entry in units)
            {
                try
                {
                    if (entry.Value == null) continue;
                    var unit = entry.Value;
                    var unitData = runtime.Invoke(unit, "GetUnitData");
                    var unitDataGame = runtime.Invoke(unit, "GetUnitDataGame");
                    var sync = runtime.Invoke(unit, "GetUnitSyncData");
                    var state = runtime.Invoke(unit, "GetUnitStateNow");
                    var frame = runtime.Invoke(unit, "GetUnitFrameData");
                    var templet = runtime.Invoke(unit, "GetUnitTemplet");
                    var templetBase = runtime.Invoke(unit, "GetUnitTempletBase");
                    var team = runtime.Invoke(unit, "GetTeam");
                    var skillData = runtime.Invoke(unit, "GetFastestCoolTimeSkillData");
                    var hyperData = runtime.Invoke(unit, "GetFastestCoolTimeHyperSkillData");
                    var skillStateName = Convert.ToString(skillData == null ? null : runtime.GetField(skillData, "m_StateName"), CultureInfo.InvariantCulture) ?? "";
                    var hyperStateName = Convert.ToString(hyperData == null ? null : runtime.GetField(hyperData, "m_StateName"), CultureInfo.InvariantCulture) ?? "";
                    var hyperState = hyperStateName.Length == 0 ? null : runtime.Invoke(unit, "GetUnitState", hyperStateName, true);
                    var hasHyperSkill = hyperState != null && unitData != null && ReadBool(runtime.Invoke(
                        unitData,
                        "IsUnitSkillUnlockedByType",
                        runtime.GetField(hyperState, "m_NKM_SKILL_TYPE")), false);
                    var hyperSkillCooldown = hyperStateName.Length == 0 ? 0f : ReadFloat(runtime.Invoke(unit, "GetStateCoolTime", hyperStateName), 0f);
                    var hyperSkillCooldownMax = hyperStateName.Length == 0 ? 0f : ReadFloat(runtime.Invoke(unit, "GetStateMaxCoolTime", hyperStateName), 0f);
                    output.Add(new CombatUnitSnapshot
                    {
                        GameUnitUid = ReadInt(runtime.Invoke(unit, "GetUnitGameUID"), ReadInt(entry.Key, 0)),
                        UnitUid = Convert.ToString(runtime.GetField(unitData!, "m_UnitUID"), CultureInfo.InvariantCulture) ?? "0",
                        UnitId = ReadInt(runtime.GetField(unitData!, "m_UnitID"), 0),
                        SkinId = ReadInt(runtime.GetField(unitData!, "m_SkinID"), 0),
                        Level = ReadInt(runtime.GetField(unitData!, "m_UnitLevel"), 1),
                        Team = ReadInt(team, 0),
                        TeamName = Convert.ToString(team, CultureInfo.InvariantCulture) ?? "",
                        Hp = ReadFloat(runtime.Invoke(unit, "GetHP"), 0f),
                        MaxHp = ReadFloat(runtime.Invoke(unit, "GetMaxHP"), 0f),
                        X = ReadFloat(runtime.GetField(sync!, "m_PosX"), 0f),
                        Z = ReadFloat(runtime.GetField(sync!, "m_PosZ"), 0f),
                        JumpY = ReadFloat(runtime.GetField(sync!, "m_JumpYPos"), 0f),
                        Right = ReadBool(runtime.GetField(sync!, "m_bRight"), false),
                        PlayState = Convert.ToString(runtime.GetField(sync!, "m_NKM_UNIT_PLAY_STATE"), CultureInfo.InvariantCulture) ?? "",
                        TargetUid = ReadInt(runtime.GetField(sync!, "m_TargetUID"), 0),
                        SubTargetUid = ReadInt(runtime.GetField(sync!, "m_SubTargetUID"), 0),
                        StateId = ReadInt(runtime.GetField(sync!, "m_StateID"), 0),
                        StateChangeCount = ReadInt(runtime.GetField(sync!, "m_StateChangeCount"), 0),
                        StateName = Convert.ToString(runtime.GetField(state!, "m_StateName"), CultureInfo.InvariantCulture) ?? "",
                        StateType = Convert.ToString(runtime.GetField(state!, "m_NKM_UNIT_STATE_TYPE"), CultureInfo.InvariantCulture) ?? "",
                        SkillType = Convert.ToString(runtime.GetField(state!, "m_NKM_SKILL_TYPE"), CultureInfo.InvariantCulture) ?? "",
                        Animation = Convert.ToString(runtime.GetField(state!, "m_AnimName"), CultureInfo.InvariantCulture) ?? "",
                        StateTime = ReadFloat(runtime.GetField(frame!, "m_fStateTime"), 0f),
                        AnimationTime = ReadFloat(runtime.GetField(frame!, "m_fAnimTime"), 0f),
                        AnimationTimeMax = ReadFloat(runtime.GetField(frame!, "m_fAnimTimeMax"), 0f),
                        AnimationLoop = ReadBool(runtime.GetField(state!, "m_bAnimLoop"), false),
                        SkillCooldown = skillStateName.Length == 0 ? 0f : ReadFloat(runtime.Invoke(unit, "GetStateCoolTime", skillStateName), 0f),
                        HyperSkillCooldown = hyperSkillCooldown,
                        HyperSkillCooldownMax = hyperSkillCooldownMax,
                        HasHyperSkill = hasHyperSkill,
                        HyperSkillReady = hasHyperSkill && hyperSkillCooldown <= 0.0001f,
                        SpriteScale = Math.Max(0.01f, ReadFloat(runtime.GetField(templet!, "m_SpriteScale"), 1f)),
                        SpriteOffsetX = ReadFloat(runtime.GetField(templet!, "m_SpriteOffsetX"), 0f),
                        SpriteOffsetY = ReadFloat(runtime.GetField(templet!, "m_SpriteOffsetY"), 0f),
                        UnitSizeX = ReadFloat(runtime.GetField(templet!, "m_UnitSizeX"), 0f),
                        UnitSizeY = ReadFloat(runtime.GetField(templet!, "m_UnitSizeY"), 0f),
                        GaugeOffsetX = ReadFloat(runtime.GetField(templet!, "m_fGageOffsetX"), 0f),
                        GaugeOffsetY = ReadFloat(runtime.GetField(templet!, "m_fGageOffsetY"), 0f),
                        IsSummon = ReadBool(unitDataGame == null ? null : runtime.GetField(unitDataGame, "m_bSummonUnit"), false),
                        UnitType = Convert.ToString(runtime.GetField(templetBase!, "m_NKM_UNIT_TYPE"), CultureInfo.InvariantCulture) ?? "",
                        SpriteBundleName = Convert.ToString(runtime.GetField(templetBase!, "m_SpriteBundleName"), CultureInfo.InvariantCulture) ?? "",
                        SpriteName = Convert.ToString(runtime.GetField(templetBase!, "m_SpriteName"), CultureInfo.InvariantCulture) ?? ""
                    });
                }
                catch
                {
                    // A single malformed summon must not invalidate the frame.
                }
            }
            return output.OrderBy(unit => unit.GameUnitUid).ToList();
        }

        private List<CombatEffectSnapshot> CaptureCombatEffects()
        {
            var output = new List<CombatEffectSnapshot>();
            try
            {
                var manager = runtime.Invoke(server, "GetDEManager");
                if (manager == null || runtime.GetField(manager, "m_dicNKMDamageEffect") is not IDictionary effects) return output;
                foreach (DictionaryEntry entry in effects)
                {
                    try
                    {
                        if (entry.Value == null) continue;
                        var effect = entry.Value;
                        var data = runtime.Invoke(effect, "GetDEData");
                        var templet = runtime.Invoke(effect, "GetTemplet");
                        var state = runtime.GetField(effect, "m_EffectStateNow");
                        var effectName = Convert.ToString(runtime.Invoke(templet!, "GetMainEffectName", ReadInt(runtime.Invoke(data!, "GetMasterSkinID"), 0)), CultureInfo.InvariantCulture)
                            ?? Convert.ToString(runtime.GetField(templet!, "m_MainEffectName"), CultureInfo.InvariantCulture)
                            ?? "";
                        output.Add(new CombatEffectSnapshot
                        {
                            EffectUid = ReadInt(runtime.Invoke(effect, "GetDEUID"), ReadInt(entry.Key, 0)),
                            EffectId = 0,
                            EffectStrId = Convert.ToString(runtime.GetField(templet!, "m_DamageEffectID"), CultureInfo.InvariantCulture) ?? "",
                            MasterUnitUid = ReadInt(runtime.GetField(data!, "m_MasterGameUnitUID"), 0),
                            TargetUnitUid = ReadInt(runtime.GetField(data!, "m_TargetGameUnitUID"), 0),
                            Team = ReadInt(runtime.GetField(data!, "m_NKM_TEAM_TYPE"), 0),
                            X = ReadFloat(runtime.GetField(data!, "m_PosX"), 0f),
                            Z = ReadFloat(runtime.GetField(data!, "m_PosZ"), 0f),
                            JumpY = ReadFloat(runtime.GetField(data!, "m_JumpYPos"), 0f),
                            Right = ReadBool(runtime.GetField(data!, "m_bRight"), false),
                            StateName = Convert.ToString(runtime.GetField(state!, "m_StateName"), CultureInfo.InvariantCulture) ?? "",
                            Animation = Convert.ToString(runtime.GetField(state!, "m_AnimName"), CultureInfo.InvariantCulture) ?? "",
                            AnimationTime = ReadFloat(runtime.GetField(data!, "m_fAnimTime"), 0f),
                            AnimationTimeMax = ReadFloat(runtime.GetField(data!, "m_fAnimTimeMax"), 0f),
                            AnimationLoop = ReadBool(runtime.GetField(state!, "m_bAnimLoop"), false),
                            ScaleFactor = ReadFloat(runtime.GetField(templet!, "m_fScaleFactor"), 1f),
                            UseZScale = ReadBool(runtime.GetField(data!, "m_bUseZScale"), false),
                            Rotation = ReadFloat(runtime.GetField(data!, "m_fAddRotate"), 0f),
                            EffectBundleName = effectName,
                            MainEffectName = effectName
                        });
                    }
                    catch
                    {
                        // Effects are optional render metadata; keep the combat frame.
                    }
                }
            }
            catch
            {
                // Older managed clients may not expose the damage-effect manager.
            }
            return output.OrderBy(effect => effect.EffectUid).ToList();
        }

        private List<CombatEffectSnapshot> CaptureClientEventEffects(float gameTime)
        {
            var stateChanges = new Dictionary<int, int>();
            if (runtime.GetField(server, "m_dicNKMUnit") is IDictionary units)
            {
                foreach (DictionaryEntry entry in units)
                {
                    try
                    {
                        if (entry.Value == null) continue;
                        var unit = entry.Value;
                        var unitUid = ReadInt(runtime.Invoke(unit, "GetUnitGameUID"), ReadInt(entry.Key, 0));
                        var unitData = runtime.Invoke(unit, "GetUnitData");
                        var sync = runtime.Invoke(unit, "GetUnitSyncData");
                        var state = runtime.Invoke(unit, "GetUnitStateNow");
                        var frame = runtime.Invoke(unit, "GetUnitFrameData");
                        var stateChange = ReadInt(runtime.GetField(sync!, "m_StateChangeCount"), 0);
                        var stateTime = ReadFloat(runtime.GetField(frame!, "m_fStateTime"), 0f);
                        var animationTime = ReadFloat(runtime.GetField(frame!, "m_fAnimTime"), 0f);
                        stateChanges[unitUid] = stateChange;
                        var previous = visualEffectClocks.GetValueOrDefault(unitUid);
                        var sameState = previous != null && previous.StateChange == stateChange;
                        if (runtime.GetField(state!, "m_listNKMEventEffect") is IEnumerable events)
                        {
                            foreach (var eventEffect in events.Cast<object>())
                            {
                                var useAnimationTime = ReadBool(runtime.GetField(eventEffect, "m_bAnimTime"), false);
                                var now = useAnimationTime ? animationTime : stateTime;
                                var before = sameState ? (useAnimationTime ? previous!.AnimationTime : previous!.StateTime) : -0.001f;
                                if (now < before) before = -0.001f;
                                var eventTime = ReadFloat(runtime.GetField(eventEffect, "m_fEventTime"), 0f);
                                if (eventTime <= before + 0.0001f || eventTime > now + 0.0001f) continue;
                                var effectName = Convert.ToString(runtime.Invoke(eventEffect, "GetEffectName", unitData!), CultureInfo.InvariantCulture)
                                    ?? Convert.ToString(runtime.GetField(eventEffect, "m_EffectName"), CultureInfo.InvariantCulture)
                                    ?? "";
                                if (effectName.Length == 0) continue;
                                var right = ReadBool(runtime.GetField(sync!, "m_bRight"), false);
                                var forceRight = ReadBool(runtime.GetField(eventEffect, "m_bForceRight"), false);
                                if (forceRight) right = true;
                                var fixedPosition = ReadBool(runtime.GetField(eventEffect, "m_bFixedPos"), false);
                                var offsetX = ReadFloat(runtime.GetField(eventEffect, "m_OffsetX"), 0f);
                                var offsetY = ReadFloat(runtime.GetField(eventEffect, "m_OffsetY"), 0f);
                                var offsetZ = ReadFloat(runtime.GetField(eventEffect, "m_OffsetZ"), 0f);
                                var useOffsetZtoY = ReadBool(runtime.GetField(eventEffect, "m_bUseOffsetZtoY"), false);
                                var unitX = ReadFloat(runtime.GetField(sync!, "m_PosX"), 0f);
                                var unitZ = ReadFloat(runtime.GetField(sync!, "m_PosZ"), 0f);
                                var jumpY = ReadFloat(runtime.GetField(sync!, "m_JumpYPos"), 0f);
                                var hold = ReadBool(runtime.GetField(eventEffect, "m_bHold"), false);
                                var stopOnStateChange = hold || ReadBool(runtime.GetField(eventEffect, "m_bStateEndStop"), false);
                                var startTime = gameTime + Math.Max(0f, ReadFloat(runtime.GetField(eventEffect, "m_fReserveTime"), 0f));
                                var snapshot = new CombatEffectSnapshot
                                {
                                    EffectUid = nextClientEffectUid--,
                                    EffectStrId = effectName,
                                    MasterUnitUid = unitUid,
                                    TargetUnitUid = ReadInt(runtime.GetField(sync!, "m_TargetUID"), 0),
                                    Team = ReadInt(runtime.Invoke(unit, "GetTeam"), 0),
                                    X = fixedPosition ? offsetX : unitX + (right ? offsetX : -offsetX),
                                    Z = fixedPosition ? offsetZ : unitZ + (useOffsetZtoY ? 0f : offsetZ),
                                    JumpY = fixedPosition ? offsetY - offsetZ : jumpY + offsetY + (useOffsetZtoY ? offsetZ : 0f),
                                    Right = right,
                                    StateName = Convert.ToString(runtime.GetField(state!, "m_StateName"), CultureInfo.InvariantCulture) ?? "",
                                    Animation = Convert.ToString(runtime.GetField(eventEffect, "m_AnimName"), CultureInfo.InvariantCulture) ?? "",
                                    AnimationTimeMax = stopOnStateChange ? 10f : 1.5f,
                                    ScaleFactor = Math.Max(0.01f, ReadFloat(runtime.GetField(eventEffect, "m_fScaleFactor"), 1f)),
                                    UseZScale = ReadBool(runtime.GetField(eventEffect, "m_bUseZScale"), false),
                                    Rotation = ReadFloat(runtime.GetField(eventEffect, "m_fAddRotate"), 0f),
                                    OffsetX = offsetX,
                                    OffsetY = offsetY,
                                    OffsetZ = offsetZ,
                                    UseOffsetZtoY = useOffsetZtoY,
                                    FixedPosition = fixedPosition,
                                    FollowMaster = !fixedPosition && stopOnStateChange,
                                    ForceRight = forceRight,
                                    LandConnect = ReadBool(runtime.GetField(eventEffect, "m_bLandConnect"), false),
                                    UseBoneRotate = ReadBool(runtime.GetField(eventEffect, "m_bUseBoneRotate"), false),
                                    ClientEvent = true,
                                    ParentType = Convert.ToString(runtime.GetField(eventEffect, "m_ParentType"), CultureInfo.InvariantCulture) ?? "",
                                    BoneName = Convert.ToString(runtime.GetField(eventEffect, "m_BoneName"), CultureInfo.InvariantCulture) ?? "",
                                    EffectBundleName = effectName,
                                    MainEffectName = effectName
                                };
                                activeClientEffects.Add(new ActiveClientEffect(snapshot, startTime, startTime + snapshot.AnimationTimeMax, unitUid, stateChange, stopOnStateChange));
                            }
                        }
                        visualEffectClocks[unitUid] = new VisualEffectClock(stateChange, stateTime, animationTime);
                    }
                    catch
                    {
                        // Client-only visuals must not interrupt the authoritative simulation.
                    }
                }
            }

            activeClientEffects.RemoveAll(active => gameTime > active.EndTime ||
                active.StopOnStateChange && stateChanges.GetValueOrDefault(active.OwnerUid, -1) != active.OwnerStateChange);
            return activeClientEffects
                .Where(active => gameTime >= active.StartTime)
                .Select(active => CopyEffect(active.Effect, gameTime - active.StartTime))
                .ToList();
        }

        private static CombatEffectSnapshot CopyEffect(CombatEffectSnapshot source, float animationTime)
        {
            return new CombatEffectSnapshot
            {
                EffectUid = source.EffectUid, EffectId = source.EffectId, EffectStrId = source.EffectStrId,
                MasterUnitUid = source.MasterUnitUid, TargetUnitUid = source.TargetUnitUid, Team = source.Team,
                X = source.X, Z = source.Z, JumpY = source.JumpY, Right = source.Right,
                StateName = source.StateName, Animation = source.Animation, AnimationTime = animationTime,
                AnimationTimeMax = source.AnimationTimeMax, AnimationLoop = source.AnimationLoop,
                ScaleFactor = source.ScaleFactor, UseZScale = source.UseZScale, Rotation = source.Rotation,
                OffsetX = source.OffsetX, OffsetY = source.OffsetY, OffsetZ = source.OffsetZ,
                UseOffsetZtoY = source.UseOffsetZtoY, FixedPosition = source.FixedPosition,
                FollowMaster = source.FollowMaster, ForceRight = source.ForceRight,
                LandConnect = source.LandConnect, UseBoneRotate = source.UseBoneRotate,
                ClientEvent = source.ClientEvent, ParentType = source.ParentType, BoneName = source.BoneName,
                EffectBundleName = source.EffectBundleName, MainEffectName = source.MainEffectName
            };
        }

        private sealed record VisualEffectClock(int StateChange, float StateTime, float AnimationTime);
        private sealed record ActiveClientEffect(CombatEffectSnapshot Effect, float StartTime, double EndTime, int OwnerUid, int OwnerStateChange, bool StopOnStateChange);

        private string DescribeUnitDictionary(object? dictionary)
        {
            if (dictionary is not IDictionary units) return "0[]";
            var values = new List<string>();
            foreach (DictionaryEntry entry in units)
            {
                var unit = entry.Value;
                if (unit == null) continue;
                var unitData = runtime.Invoke(unit, "GetUnitData");
                var unitDataGame = runtime.Invoke(unit, "GetUnitDataGame");
                var gameUnitUid = ReadShort(runtime.Invoke(unit, "GetUnitGameUID"), ReadShort(entry.Key, 0));
                var unitId = ReadInt(unitData == null ? null : runtime.GetField(unitData, "m_UnitID"), 0);
                var team = Convert.ToString(runtime.Invoke(unit, "GetTeam"), CultureInfo.InvariantCulture) ?? "";
                var hp = ReadFloat(runtime.Invoke(unit, "GetHP"), 0f);
                var maxHp = ReadFloat(runtime.Invoke(unit, "GetMaxHP"), 0f);
                var syncData = runtime.Invoke(unit, "GetUnitSyncData");
                var playState = Convert.ToString(syncData == null ? null : runtime.GetField(syncData, "m_NKM_UNIT_PLAY_STATE"), CultureInfo.InvariantCulture) ?? "";
                var summon = ReadBool(unitDataGame == null ? null : runtime.GetField(unitDataGame, "m_bSummonUnit"), false)
                    || ReadBool(unitData == null ? null : runtime.GetField(unitData, "m_bSummonUnit"), false);
                values.Add($"{gameUnitUid}:{unitId}:{team}:hp={hp:0}/{maxHp:0}:state={playState}:summon={summon}");
            }
            return $"{units.Count}[{string.Join(";", values.Take(16))}]";
        }

        private string DescribePendingRespawns()
        {
            if (runtime.GetField(server, "m_listNKMGameUnitRespawnData") is not IEnumerable respawns) return "0[]";
            var values = new List<string>();
            foreach (var respawn in respawns.Cast<object>())
            {
                values.Add(string.Join(":",
                    Convert.ToString(runtime.GetField(respawn, "m_UnitUID"), CultureInfo.InvariantCulture),
                    Convert.ToString(runtime.GetField(respawn, "m_fRespawnCoolTime"), CultureInfo.InvariantCulture),
                    Convert.ToString(runtime.GetField(respawn, "m_fRespawnPosX"), CultureInfo.InvariantCulture)));
            }
            return $"{values.Count}[{string.Join(";", values.Take(16))}]";
        }

        private string DescribeShortList(object? items)
        {
            if (items is not IEnumerable enumerable) return "";
            return string.Join(",", enumerable.Cast<object>().Take(16).Select(item => Convert.ToString(item, CultureInfo.InvariantCulture)));
        }

        private string DescribeEventUnits(object? teamData)
        {
            if (teamData == null || runtime.GetField(teamData, "m_listEvevtUnitData") is not IEnumerable units) return "0[]";
            var values = new List<string>();
            foreach (var unitData in units.Cast<object>())
            {
                var templet = runtime.GetField(unitData, "m_DungeonRespawnUnitTemplet");
                var timing = templet == null ? null : runtime.GetField(templet, "m_NKMDungeonEventTiming");
                values.Add(string.Join(":",
                    Convert.ToString(runtime.GetField(unitData, "m_UnitUID"), CultureInfo.InvariantCulture),
                    Convert.ToString(runtime.GetField(unitData, "m_UnitID"), CultureInfo.InvariantCulture),
                    $"uids=[{DescribeShortList(runtime.GetField(unitData, "m_listGameUnitUID"))}]",
                    $"templet={Convert.ToString(runtime.GetField(unitData, "m_DungeonRespawnUnitTempletUID"), CultureInfo.InvariantCulture)}",
                    $"has={templet != null}",
                    $"last={Convert.ToString(runtime.GetField(unitData, "m_fLastRespawnTime"), CultureInfo.InvariantCulture)}",
                    $"start={Convert.ToString(runtime.GetField(timing!, "m_fEventTimeStart"), CultureInfo.InvariantCulture)}",
                    $"gap={Convert.ToString(runtime.GetField(timing!, "m_fEventTimeGap"), CultureInfo.InvariantCulture)}"));
            }
            return $"{values.Count}[{string.Join(";", values.Take(16))}]";
        }

        private string DescribeDamageTakenMap()
        {
            if (runtime.GetField(server, "m_dicDamageTakenByUnit") is not IDictionary damageMap) return "0[]";
            var values = new List<string>();
            foreach (DictionaryEntry defender in damageMap)
            {
                if (defender.Value is not IDictionary attackers) continue;
                foreach (DictionaryEntry attacker in attackers)
                {
                    values.Add($"{Convert.ToString(defender.Key, CultureInfo.InvariantCulture)}<-{Convert.ToString(attacker.Key, CultureInfo.InvariantCulture)}:{Convert.ToString(attacker.Value, CultureInfo.InvariantCulture)}");
                }
            }
            return $"{values.Count}[{string.Join(";", values.Take(16))}]";
        }

        private List<HostPacket> NormalizeTimerSyncs(List<HostPacket> packets)
        {
            if (initialRemainGameTime <= 0 && !IsFierceGame(latestDynamicGame))
            {
                return packets;
            }

            var output = new List<HostPacket>(packets.Count);
            foreach (var packet in packets)
            {
                output.Add(packet.PacketId == GameSync ? NormalizeTimerSync(packet) : packet);
            }
            return output;
        }

        private HostPacket NormalizeTimerSync(HostPacket packet)
        {
            if (string.IsNullOrWhiteSpace(packet.PayloadBase64)) return packet;

            try
            {
                var managedPacket = runtime.DeserializePacket(GameSync, Convert.FromBase64String(packet.PayloadBase64));
                var pack = runtime.GetField(managedPacket, "gameSyncDataPack");
                var syncItems = pack == null ? null : runtime.GetField(pack, "m_listGameSyncData");
                if (syncItems is not IEnumerable enumerable) return packet;

                var syncBases = enumerable.Cast<object>().ToList();
                var normalizeTimer = initialRemainGameTime > 0;
                var firstPlayPacket = false;
                if (normalizeTimer && playStartClientGameTime < 0f)
                {
                    foreach (var syncBase in syncBases)
                    {
                        if (!SyncBaseStartsPlay(syncBase)) continue;
                        var baseGameTime = Math.Max(0f, ReadFloat(runtime.GetField(syncBase, "m_fGameTime"), 0f));
                        playStartClientGameTime = baseGameTime + ClientSyncLeadSeconds;
                        firstPlayPacket = true;
                        break;
                    }
                }

                var changed = false;
                foreach (var syncBase in syncBases)
                {
                    if (!normalizeTimer) continue;
                    var baseGameTime = Math.Max(0f, ReadFloat(runtime.GetField(syncBase, "m_fGameTime"), 0f));
                    var clientGameTime = baseGameTime + ClientSyncLeadSeconds;
                    var currentRemain = ReadFloat(runtime.GetField(syncBase, "m_fRemainGameTime"), initialRemainGameTime);
                    var playElapsed = playStartClientGameTime < 0 || firstPlayPacket
                        ? 0f
                        : Math.Max(0f, clientGameTime - playStartClientGameTime);
                    var normalizedRemain = Math.Max(0f, initialRemainGameTime - playElapsed);
                    if (Math.Abs(normalizedRemain - currentRemain) > 0.001f)
                    {
                        runtime.SetField(syncBase, "m_fRemainGameTime", normalizedRemain);
                        changed = true;
                    }
                }
                changed |= TryApplyFierceScoreSync(syncBases);

                return changed ? runtime.SerializePacket(managedPacket, GameSync, packet.Label ?? "managed-timer-sync") : packet;
            }
            catch
            {
                return packet;
            }
        }

        private bool TryApplyFierceScoreSync(IEnumerable<object> syncBases)
        {
            var dynamicGame = latestDynamicGame;
            if (!IsFierceGame(dynamicGame)) return false;

            var score = CalculateCurrentFiercePoint(dynamicGame!, includeTime: false);
            if (score.Point < 0) return false;

            SetManagedFiercePoint(score.Point, score.PenaltyPoint);
            var changed = false;
            foreach (var syncBase in syncBases)
            {
                var gamePoint = runtime.GetField(syncBase, "m_NKMGameSyncData_GamePoint");
                if (gamePoint == null)
                {
                    gamePoint = runtime.Create("NKM.NKMGameSyncData_GamePoint");
                    runtime.SetField(syncBase, "m_NKMGameSyncData_GamePoint", gamePoint);
                    changed = true;
                }

                var currentPoint = ReadInt(runtime.GetField(gamePoint, "m_fGamePoint"), int.MinValue);
                if (currentPoint == score.Point) continue;
                runtime.SetField(gamePoint, "m_fGamePoint", score.Point);
                changed = true;
            }

            return changed;
        }

        private (int Point, int PenaltyPoint) CalculateCurrentFiercePoint(DynamicGameState dynamicGame, bool includeTime)
        {
            if (!IsFierceGame(dynamicGame)) return (-1, 0);
            if (latestBattleState != null)
            {
                CaptureRaidBossState(dynamicGame, latestBattleState);
            }

            var damageRatio = latestBattleState == null
                ? 0.0
                : Math.Clamp(
                    latestBattleState.BossDamageRatio > 0 ? latestBattleState.BossDamageRatio : latestBattleState.RaidBossDamageRatio,
                    0.0,
                    1.0);
            var killed = latestBattleState?.BossKilled == true || latestBattleState?.RaidBossKilled == true;
            var basePoint = Math.Max(0, dynamicGame.FierceBasePoint);
            var damagePoint = (int)Math.Round(Math.Max(0, dynamicGame.FierceMaxDamagePoint) * damageRatio);
            var timePoint = 0;
            if (includeTime && killed && dynamicGame.FierceMaxTimePoint > 0)
            {
                var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
                var remainTime = ReadFloat(runtimeData == null ? null : runtime.GetField(runtimeData, "m_fRemainGameTime"), 0f);
                var maxTime = Math.Max(1f, initialRemainGameTime > 0 ? initialRemainGameTime : remainTime);
                timePoint = (int)Math.Round(Math.Max(0, dynamicGame.FierceMaxTimePoint) * Math.Clamp(remainTime / maxTime, 0f, 1f));
            }

            var rawPoint = basePoint + damagePoint + timePoint;
            var penaltyPoint = (int)Math.Round(rawPoint * Math.Max(0, dynamicGame.FiercePenaltyRate) / 10000.0);
            return (Math.Max(0, rawPoint + penaltyPoint), Math.Max(0, penaltyPoint));
        }

        private void SetManagedFiercePoint(int point, int penaltyPoint)
        {
            try
            {
                var gameRecord = runtime.GetField(server, "m_GameRecord");
                if (gameRecord == null) return;
                runtime.Invoke(gameRecord, "SetTotalFiercePoint", (float)Math.Max(0, point), (float)Math.Max(0, penaltyPoint));
            }
            catch
            {
                try
                {
                    var gameRecord = runtime.GetField(server, "m_GameRecord");
                    if (gameRecord == null) return;
                    runtime.SetField(gameRecord, "totalFiercePoint", (float)Math.Max(0, point));
                    runtime.SetField(gameRecord, "fiercePenaltyPoint", (float)Math.Max(0, penaltyPoint));
                }
                catch
                {
                    // If the installed client shape differs, keep the sync packet patch above authoritative.
                }
            }
        }

        private bool SyncBaseStartsPlay(object syncBase)
        {
            try
            {
                if (runtime.GetField(syncBase, "m_NKMGameSyncData_GameState") is not IEnumerable gameStates)
                {
                    return false;
                }

                return gameStates.Cast<object>().Any(gameState =>
                    string.Equals(
                        Convert.ToString(runtime.GetField(gameState, "m_NKM_GAME_STATE"), CultureInfo.InvariantCulture),
                        "NGS_PLAY",
                        StringComparison.Ordinal));
            }
            catch
            {
                return false;
            }
        }

        private static bool IsFierceGame(DynamicGameState? dynamicGame)
        {
            return dynamicGame != null &&
                (dynamicGame.GameType == 14 ||
                 dynamicGame.FierceBossId > 0 ||
                 string.Equals(dynamicGame.MiscMode, "fierce", StringComparison.OrdinalIgnoreCase));
        }

        private bool IsRuntimeInPlayState()
        {
            try
            {
                var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
                var state = Convert.ToString(runtime.GetField(runtimeData!, "m_NKM_GAME_STATE"), CultureInfo.InvariantCulture) ?? "";
                return string.Equals(state, "NGS_PLAY", StringComparison.Ordinal);
            }
            catch
            {
                return false;
            }
        }

        private static float ReadFloat(object? value, float fallback)
        {
            try
            {
                return Convert.ToSingle(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        public void CaptureRaidBossState(DynamicGameState? dynamicGame, BattleState? battleState)
        {
            RememberDynamicGame(dynamicGame);
            if (dynamicGame == null || battleState == null) return;
            var tracksBoss = dynamicGame.RaidUID > 0 || IsFierceGame(dynamicGame);
            if (!tracksBoss) return;
            var snapshot = ReadTeamBossSnapshot(teamA: false, battleState);
            if (snapshot.MaxHp <= 0) return;

            if (battleState.RaidBossInitHp <= 0)
            {
                battleState.RaidBossInitHp = snapshot.MaxHp;
            }

            var initHp = Math.Max(1, battleState.RaidBossInitHp);
            var currentHp = Math.Clamp(snapshot.CurHp, 0, initHp);
            
            var damage = Math.Clamp(initHp - currentHp, 0, initHp);
            battleState.RaidBossCurHp = currentHp;
            battleState.RaidBossMaxHp = snapshot.MaxHp;
            battleState.RaidBossDamage = damage;
            battleState.RaidBossDamageRatio = damage / initHp;
            battleState.RaidBossKilled = currentHp <= 0;
            battleState.BossHpPercent = Math.Clamp(currentHp / initHp * 100.0, 0.0, 100.0);
            battleState.BossDamageRatio = Math.Clamp(damage / initHp, 0.0, 1.0);
            battleState.BossKilled = currentHp <= 0;
        }

        public void SetInitialRaidBossHP(double curHp, double maxHp)
        {
            if (maxHp <= 0)
            {
                return;
            }
            
            // Clamp curHp
            var clampedCurHp = Math.Max(0, Math.Min(curHp, maxHp));
            
            // Set in latest battle state so combat engine can use it
            if (latestBattleState == null)
            {
                latestBattleState = new BattleState();
            }
            
            latestBattleState.RaidBossInitHp = maxHp;
            latestBattleState.RaidBossMaxHp = maxHp;
            latestBattleState.RaidBossCurHp = clampedCurHp;
        }

        public void PatchRaidBossUnitHP()
        {
            if (latestBattleState == null)
            {
                return;
            }
            
            if (latestBattleState.RaidBossCurHp <= 0 || latestBattleState.RaidBossCurHp >= latestBattleState.RaidBossMaxHp)
            {
                return; // No patching needed for full HP or invalid state
            }
            
            try
            {
                // Use existing method to find the boss unit
                var bossUnit = FindTeamBossUnit(teamA: false, includePool: true);
                if (bossUnit == null)
                {
                    return;
                }
                
                // Patch the HP!
                var targetHp = (float)latestBattleState.RaidBossCurHp;
                runtime.Invoke(bossUnit, "SetHP", targetHp);
            }
            catch
            {
                // Silently fail - consistent with other methods in this class
            }
        }

        private (float CurHp, float MaxHp) ReadTeamBossSnapshot(bool teamA, BattleState battleState)
        {
            try
            {
                var unit = FindTeamBossUnit(teamA, includePool: true);
                if (unit == null)
                {
                    var fallbackMax = (float)Math.Max(0, battleState.RaidBossMaxHp > 0 ? battleState.RaidBossMaxHp : battleState.RaidBossInitHp);
                    return fallbackMax > 0 ? (0f, fallbackMax) : (0f, 0f);
                }

                var currentHp = ReadFloat(runtime.Invoke(unit, "GetHP"), 0f);
                var maxHp = ReadFloat(runtime.Invoke(unit, "GetMaxHP"), 0f);
                return (Math.Max(0f, currentHp), Math.Max(0f, maxHp));
            }
            catch
            {
                return (0f, 0f);
            }
        }

        private object? FindTeamBossUnit(bool teamA, bool includePool)
        {
            var gameData = runtime.Invoke(server, "GetGameData");
            if (gameData == null) return null;
            var teamData = runtime.GetField(gameData, teamA ? "m_NKMGameTeamDataA" : "m_NKMGameTeamDataB");
            var mainShip = teamData == null ? null : runtime.GetField(teamData, "m_MainShip");
            var gameUnitUids = mainShip == null ? null : runtime.GetField(mainShip, "m_listGameUnitUID");
            if (gameUnitUids is not IEnumerable enumerable) return null;

            foreach (var value in enumerable)
            {
                var gameUnitUid = Convert.ToInt16(value, CultureInfo.InvariantCulture);
                var unit = runtime.Invoke(server, "GetUnit", gameUnitUid, true, includePool);
                if (unit != null) return unit;
            }

            return null;
        }

        private float ScaleFrameDeltaForRuntimeSpeed(float frameDelta)
        {
            try
            {
                var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
                var speedType = Convert.ToInt32(runtime.GetField(runtimeData!, "m_NKM_GAME_SPEED_TYPE") ?? 0, CultureInfo.InvariantCulture);
                return frameDelta * SpeedScaleForType(speedType);
            }
            catch
            {
                return frameDelta;
            }
        }

        private static float SpeedScaleForType(int speedType)
        {
            return speedType switch
            {
                0 => 1.1f,
                1 => 1.5f,
                2 => 2.2f,
                3 => 0.6f,
                4 => 11f,
                5 => 80f,
                _ => 1f
            };
        }

        private List<HostPacket> FlushFinishStateSync()
        {
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            if (runtimeData == null) return [];

            var gameStateType = runtime.GetType("NKM.NKM_GAME_STATE");
            var teamType = runtime.GetType("NKM.NKM_TEAM_TYPE");
            var finishState = Enum.Parse(gameStateType, "NGS_FINISH");
            var winTeam = runtime.GetField(runtimeData, "m_WinTeam") ?? Enum.Parse(teamType, "NTT_A1");
            var waveId = Convert.ToInt32(runtime.GetField(runtimeData, "m_WaveID") ?? 0, CultureInfo.InvariantCulture);

            // GAME_END_NOT carries result data, but the client plays victory and
            // outro from NGS_FINISH. Make that state sync precede 811 in the same
            // burst so the result packet cannot strand the client in NGS_PLAY.
            runtime.GetMethod(server.GetType(), "SyncGameStateChange", gameStateType, teamType, typeof(int)).Invoke(server, [finishState, winTeam, waveId]);
            runtime.GetMethod(server.GetType(), "ForceSyncDataPackFlushThisFrame").Invoke(server, []);
            runtime.GetMethod(server.GetType(), "SyncDataPackFlush").Invoke(server, []);
            return DrainCombatPackets($"managed-finish-state-{sessionId}");
        }

        private List<HostPacket> DrainCombatPackets(string label)
        {
            latestGameEndBattleRecords = null;
            latestGameEndBattleWin = null;
            latestGameEndBattleWinTeam = 0;
            latestGameEndBattlePlayTime = -1f;
            latestGameEndFiercePoint = -1;
            latestGameEndFiercePenaltyPoint = -1;
            var packets = runtime.DrainClientPackets(label, PatchManagedGameEndPacket);
            foreach (var packet in packets)
            {
                if (packet.PacketId != GameEnd) continue;
                if (latestGameEndBattleWin.HasValue)
                {
                    packet.BattleWin = latestGameEndBattleWin.Value;
                }
                if (latestGameEndBattleWinTeam > 0)
                {
                    packet.BattleWinTeam = latestGameEndBattleWinTeam;
                }
                if (latestGameEndBattlePlayTime >= 0f)
                {
                    packet.BattlePlayTime = latestGameEndBattlePlayTime;
                }
                if (latestGameEndFiercePoint >= 0)
                {
                    packet.FiercePoint = latestGameEndFiercePoint;
                    packet.FiercePenaltyPoint = Math.Max(0, latestGameEndFiercePenaltyPoint);
                }
                if (latestGameEndBattleRecords is { Count: > 0 } records)
                {
                    packet.BattleRecords = records.Select(CopyBattleRecord).ToList();
                    packet.Label = string.IsNullOrWhiteSpace(packet.Label)
                        ? $"managed-game-end records={packet.BattleRecords.Count}"
                        : $"{packet.Label} records={packet.BattleRecords.Count}";
                }
            }

            return packets;
        }

        private void PatchManagedGameEndPacket(int packetId, object packet)
        {
            if (packetId != GameEnd) return;
            var gameRecord = runtime.GetField(server, "m_GameRecord");
            gameRecord = BuildManagedGameRecordFromManagedState(gameRecord) ?? gameRecord;
            if (!HasUsableGameRecordRows(gameRecord))
            {
                gameRecord = BuildManagedGameRecordFromBattleState();
            }
            if (gameRecord != null)
            {
                runtime.SetField(packet, "gameRecord", gameRecord);
                latestGameEndBattleRecords = ExportManagedGameRecordRecords(gameRecord);
            }

            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            var winTeam = runtimeData == null ? null : runtime.GetField(runtimeData, "m_WinTeam");
            latestGameEndBattleWin = ResolveManagedBattleWin(winTeam);
            latestGameEndBattleWinTeam = ReadInt(winTeam, 0);
            var playTime = ReadFloat(runtimeData == null ? null : runtime.GetField(runtimeData, "m_GameTime"), -1f);
            if (playTime >= 0f)
            {
                runtime.SetField(packet, "totalPlayTime", playTime);
                latestGameEndBattlePlayTime = playTime;
            }
            var dynamicGame = latestDynamicGame;
            if (IsFierceGame(dynamicGame))
            {
                var fierce = CalculateCurrentFiercePoint(dynamicGame!, includeTime: true);
                if (fierce.Point >= 0)
                {
                    SetManagedFiercePoint(fierce.Point, fierce.PenaltyPoint);
                    latestGameEndFiercePoint = fierce.Point;
                    latestGameEndFiercePenaltyPoint = fierce.PenaltyPoint;
                }
            }
        }

        private bool HasUsableGameRecordRows(object? gameRecord)
        {
            if (gameRecord == null) return false;
            if (runtime.GetField(gameRecord, "unitRecords") is not IDictionary records || records.Count == 0) return false;
            foreach (DictionaryEntry entry in records)
            {
                if (ReadInt(runtime.GetField(entry.Value!, "unitId"), 0) > 0)
                {
                    return true;
                }
            }
            return false;
        }

        private static bool? ResolveManagedBattleWin(object? winTeam)
        {
            if (winTeam == null) return null;
            var text = Convert.ToString(winTeam, CultureInfo.InvariantCulture) ?? "";
            if (text.IndexOf("NTT_A", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (text.IndexOf("NTT_B", StringComparison.OrdinalIgnoreCase) >= 0) return false;

            var rawTeam = ReadInt(winTeam, 0);
            if (rawTeam <= 0) return null;
            return IsRecordTeamA(rawTeam);
        }

        private List<BattleUnitRecord> ExportManagedGameRecordRecords(object? gameRecord)
        {
            var output = new List<BattleUnitRecord>();
            if (gameRecord == null || runtime.GetField(gameRecord, "unitRecords") is not IDictionary records) return output;

            foreach (DictionaryEntry entry in records)
            {
                var record = entry.Value;
                if (record == null) continue;
                var gameUnitUid = ReadInt(entry.Key, 0);
                if (gameUnitUid <= 0) continue;

                var unitId = ReadInt(runtime.GetField(record, "unitId"), 0);
                if (unitId <= 0) continue;

                output.Add(new BattleUnitRecord
                {
                    GameUnitUID = gameUnitUid,
                    UnitId = unitId,
                    ChangeUnitName = Convert.ToString(runtime.GetField(record, "changeUnitName"), CultureInfo.InvariantCulture) ?? "",
                    UnitLevel = Math.Max(1, ReadInt(runtime.GetField(record, "unitLevel"), 1)),
                    IsSummonee = ReadBool(runtime.GetField(record, "isSummonee"), false),
                    IsAssistUnit = ReadBool(runtime.GetField(record, "isAssistUnit"), false),
                    IsLeader = ReadBool(runtime.GetField(record, "isLeader"), false),
                    TeamType = NormalizeRecordTeamType(ReadInt(runtime.GetField(record, "teamType"), 1)),
                    RecordGiveDamage = Math.Max(0f, ReadFloat(runtime.GetField(record, "recordGiveDamage"), 0f)),
                    RecordTakeDamage = Math.Max(0f, ReadFloat(runtime.GetField(record, "recordTakeDamage"), 0f)),
                    RecordHeal = Math.Max(0f, ReadFloat(runtime.GetField(record, "recordHeal"), 0f)),
                    RecordSummonCount = Math.Max(1, ReadInt(runtime.GetField(record, "recordSummonCount"), 0)),
                    RecordDieCount = Math.Max(0, ReadInt(runtime.GetField(record, "recordDieCount"), 0)),
                    RecordKillCount = Math.Max(0, ReadInt(runtime.GetField(record, "recordKillCount"), 0)),
                    Playtime = Math.Max(1, ReadInt(runtime.GetField(record, "playtime"), 1))
                });
            }

            return output
                .OrderBy(record => record.GameUnitUID)
                .ToList();
        }

        private object? BuildManagedGameRecordFromManagedState(object? existingGameRecord)
        {
            var gameRecord = existingGameRecord ?? runtime.Create("NKM.NKMGameRecord");
            if (runtime.GetField(gameRecord, "unitRecords") is not IDictionary managedRecords) return null;

            var units = CollectManagedUnitsByGameUid();
            var runtimeData = runtime.Invoke(server, "GetGameRuntimeData");
            var playTime = Math.Max(1, (int)Math.Ceiling(ReadFloat(runtimeData == null ? null : runtime.GetField(runtimeData, "m_GameTime"), 1f)));
            UpsertManagedTeamDataRecords(managedRecords, playTime);
            foreach (var unitEntry in units)
            {
                UpsertManagedGameRecordUnit(managedRecords, unitEntry.Key, unitEntry.Value, playTime);
            }

            if (managedRecords.Count == 0)
            {
                return null;
            }

            if (!ManagedRecordsHaveDamage(managedRecords))
            {
                ApplyManagedDamageTakenMap(managedRecords);
            }

            ApplyManagedHpDelta(records: managedRecords, units);
            ApplyManagedMissingDamageAttribution(
                records: managedRecords,
                liveUnits: CollectManagedLiveUnitsByGameUid(),
                allUnits: units);

            UpdateManagedGameRecordTotals(gameRecord, managedRecords);
            return gameRecord;
        }

        private SortedDictionary<short, object> CollectManagedUnitsByGameUid()
        {
            var units = new SortedDictionary<short, object>();
            CollectManagedUnitsByGameUid(units, "m_dicNKMUnitPool");
            CollectManagedUnitsByGameUid(units, "m_dicNKMUnit");
            return units;
        }

        private SortedDictionary<short, object> CollectManagedLiveUnitsByGameUid()
        {
            var units = new SortedDictionary<short, object>();
            CollectManagedUnitsByGameUid(units, "m_dicNKMUnit");
            return units;
        }

        private void CollectManagedUnitsByGameUid(SortedDictionary<short, object> units, string fieldName)
        {
            if (runtime.GetField(server, fieldName) is not IDictionary dictionary) return;
            foreach (DictionaryEntry entry in dictionary)
            {
                var unit = entry.Value;
                if (unit == null) continue;
                var gameUnitUid = ReadShort(runtime.Invoke(unit, "GetUnitGameUID"), ReadShort(entry.Key, 0));
                if (gameUnitUid <= 0) continue;

                var unitData = runtime.Invoke(unit, "GetUnitData");
                if (ReadInt(unitData == null ? null : runtime.GetField(unitData, "m_UnitID"), 0) <= 0) continue;
                units[gameUnitUid] = unit;
            }
        }

        private void UpsertManagedTeamDataRecords(IDictionary managedRecords, int playTime)
        {
            var gameData = runtime.Invoke(server, "GetGameData");
            if (gameData == null) return;
            UpsertManagedTeamDataRecords(managedRecords, runtime.GetField(gameData, "m_NKMGameTeamDataA"), playTime);
            UpsertManagedTeamDataRecords(managedRecords, runtime.GetField(gameData, "m_NKMGameTeamDataB"), playTime);
        }

        private void UpsertManagedTeamDataRecords(IDictionary managedRecords, object? teamData, int playTime)
        {
            if (teamData == null) return;
            var teamType = NormalizeRecordTeamType(ReadInt(runtime.GetField(teamData, "m_eNKM_TEAM_TYPE"), 1));
            var leaderUnitUid = ReadLong(runtime.GetField(teamData, "m_LeaderUnitUID"), 0L);
            UpsertManagedUnitDataRecords(
                managedRecords,
                runtime.GetField(teamData, "m_MainShip"),
                teamData,
                teamType,
                isAssistUnit: false,
                leaderUnitUid,
                playTime);

            UpsertManagedUnitDataListRecords(managedRecords, runtime.GetField(teamData, "m_listUnitData"), teamData, teamType, isAssistUnit: false, leaderUnitUid, playTime);
            UpsertManagedUnitDataListRecords(managedRecords, runtime.GetField(teamData, "m_listAssistUnitData"), teamData, teamType, isAssistUnit: true, leaderUnitUid, playTime);
            UpsertManagedUnitDataListRecords(managedRecords, runtime.GetField(teamData, "m_listEvevtUnitData"), teamData, teamType, isAssistUnit: false, leaderUnitUid, playTime);
            UpsertManagedUnitDataListRecords(managedRecords, runtime.GetField(teamData, "m_listEnvUnitData"), teamData, teamType, isAssistUnit: false, leaderUnitUid, playTime);
            UpsertManagedDynamicRespawnUnitDataListRecords(managedRecords, runtime.GetField(teamData, "m_listDynamicRespawnUnitData"), teamData, teamType, leaderUnitUid, playTime);
        }

        private void UpsertManagedUnitDataListRecords(
            IDictionary managedRecords,
            object? unitList,
            object teamData,
            int teamType,
            bool isAssistUnit,
            long leaderUnitUid,
            int playTime)
        {
            if (unitList is not IEnumerable units) return;
            foreach (var unitData in units)
            {
                UpsertManagedUnitDataRecords(managedRecords, unitData, teamData, teamType, isAssistUnit, leaderUnitUid, playTime);
            }
        }

        private void UpsertManagedDynamicRespawnUnitDataListRecords(
            IDictionary managedRecords,
            object? dynamicUnitList,
            object teamData,
            int teamType,
            long leaderUnitUid,
            int playTime)
        {
            if (dynamicUnitList is not IEnumerable dynamicUnits) return;
            foreach (var dynamicUnit in dynamicUnits)
            {
                if (dynamicUnit == null) continue;
                var unitData = runtime.GetField(dynamicUnit, "m_NKMUnitData") ?? dynamicUnit;
                UpsertManagedUnitDataRecords(managedRecords, unitData, teamData, teamType, isAssistUnit: false, leaderUnitUid, playTime);
            }
        }

        private void UpsertManagedUnitDataRecords(
            IDictionary managedRecords,
            object? unitData,
            object teamData,
            int teamType,
            bool isAssistUnit,
            long leaderUnitUid,
            int playTime)
        {
            if (unitData == null) return;
            if (runtime.GetField(unitData, "m_listGameUnitUID") is not IEnumerable gameUnitUids) return;
            foreach (var value in gameUnitUids)
            {
                var gameUnitUid = ReadShort(value, 0);
                if (gameUnitUid <= 0) continue;
                UpsertManagedGameRecordUnitData(managedRecords, gameUnitUid, unitData, teamData, teamType, isAssistUnit, leaderUnitUid, playTime);
            }
        }

        private object? UpsertManagedGameRecordUnitData(
            IDictionary managedRecords,
            short gameUnitUid,
            object unitData,
            object teamData,
            int teamType,
            bool isAssistUnit,
            long leaderUnitUid,
            int playTime)
        {
            var unitId = ReadInt(runtime.GetField(unitData, "m_UnitID"), 0);
            if (unitId <= 0) return null;

            var unitUid = ReadLong(runtime.GetField(unitData, "m_UnitUID"), 0L);
            var record = managedRecords.Contains(gameUnitUid) ? managedRecords[gameUnitUid] : null;
            record ??= runtime.Create("ClientPacket.Common.NKMGameRecordUnitData");

            runtime.SetField(record, "unitId", unitId);
            runtime.SetField(record, "changeUnitName", GetManagedChangeUnitName(unitData));
            runtime.SetField(record, "unitLevel", Math.Max(1, ReadInt(runtime.GetField(unitData, "m_UnitLevel"), 1)));
            runtime.SetField(record, "isSummonee", ReadBool(runtime.GetField(unitData, "m_bSummonUnit"), false));
            runtime.SetField(record, "isAssistUnit", isAssistUnit || IsManagedAssistUnit(teamData, unitUid));
            runtime.SetField(record, "isLeader", unitUid > 0 && leaderUnitUid == unitUid);
            runtime.SetField(record, "teamType", teamType);
            runtime.SetField(record, "recordGiveDamage", Math.Max(0f, ReadFloat(runtime.GetField(record, "recordGiveDamage"), 0f)));
            runtime.SetField(record, "recordTakeDamage", Math.Max(0f, ReadFloat(runtime.GetField(record, "recordTakeDamage"), 0f)));
            runtime.SetField(record, "recordHeal", Math.Max(0f, ReadFloat(runtime.GetField(record, "recordHeal"), 0f)));
            runtime.SetField(record, "recordSummonCount", Math.Max(1, ReadInt(runtime.GetField(record, "recordSummonCount"), 0)));
            runtime.SetField(record, "recordDieCount", Math.Max(0, ReadInt(runtime.GetField(record, "recordDieCount"), 0)));
            runtime.SetField(record, "recordKillCount", Math.Max(0, ReadInt(runtime.GetField(record, "recordKillCount"), 0)));
            runtime.SetField(record, "playtime", Math.Max(playTime, ReadInt(runtime.GetField(record, "playtime"), 0)));

            managedRecords[gameUnitUid] = record;
            return record;
        }

        private object? UpsertManagedGameRecordUnit(IDictionary managedRecords, short gameUnitUid, object unit, int playTime)
        {
            var unitData = runtime.Invoke(unit, "GetUnitData");
            if (unitData == null) return null;
            var unitId = ReadInt(runtime.GetField(unitData, "m_UnitID"), 0);
            if (unitId <= 0) return null;

            var unitDataGame = runtime.Invoke(unit, "GetUnitDataGame");
            var teamData = runtime.Invoke(unit, "GetTeamData");
            var unitUid = ReadLong(runtime.GetField(unitData, "m_UnitUID"), 0L);
            var record = managedRecords.Contains(gameUnitUid) ? managedRecords[gameUnitUid] : null;
            record ??= runtime.Create("ClientPacket.Common.NKMGameRecordUnitData");

            runtime.SetField(record, "unitId", unitId);
            runtime.SetField(record, "changeUnitName", GetManagedChangeUnitName(unitData));
            runtime.SetField(record, "unitLevel", Math.Max(1, ReadInt(runtime.GetField(unitData, "m_UnitLevel"), 1)));
            runtime.SetField(record, "isSummonee", IsManagedSummonedUnit(unitData, unitDataGame));
            runtime.SetField(record, "isAssistUnit", IsManagedAssistUnit(teamData, unitUid));
            runtime.SetField(record, "isLeader", teamData != null && unitUid > 0 && ReadLong(runtime.GetField(teamData, "m_LeaderUnitUID"), 0L) == unitUid);
            runtime.SetField(record, "teamType", NormalizeRecordTeamType(ReadInt(runtime.Invoke(unit, "GetTeam"), 1)));
            runtime.SetField(record, "recordGiveDamage", Math.Max(0f, ReadFloat(runtime.GetField(record, "recordGiveDamage"), 0f)));
            runtime.SetField(record, "recordTakeDamage", Math.Max(0f, ReadFloat(runtime.GetField(record, "recordTakeDamage"), 0f)));
            runtime.SetField(record, "recordHeal", Math.Max(0f, ReadFloat(runtime.GetField(record, "recordHeal"), 0f)));
            runtime.SetField(record, "recordSummonCount", Math.Max(1, ReadInt(runtime.GetField(record, "recordSummonCount"), 0)));
            runtime.SetField(record, "recordDieCount", Math.Max(0, ReadInt(runtime.GetField(record, "recordDieCount"), 0)));
            runtime.SetField(record, "recordKillCount", Math.Max(0, ReadInt(runtime.GetField(record, "recordKillCount"), 0)));
            runtime.SetField(record, "playtime", Math.Max(playTime, ReadInt(runtime.GetField(record, "playtime"), 0)));

            managedRecords[gameUnitUid] = record;
            return record;
        }

        private string GetManagedChangeUnitName(object unitData)
        {
            var respawnTemplet = runtime.GetField(unitData, "m_DungeonRespawnUnitTemplet");
            var changeName = Convert.ToString(respawnTemplet == null ? null : runtime.GetField(respawnTemplet, "m_ChangeUnitName"), CultureInfo.InvariantCulture);
            return changeName ?? "";
        }

        private bool IsManagedSummonedUnit(object unitData, object? unitDataGame)
        {
            return ReadShort(unitDataGame == null ? null : runtime.GetField(unitDataGame, "m_MasterGameUnitUID"), 0) != 0
                || ReadBool(unitDataGame == null ? null : runtime.GetField(unitDataGame, "m_bSummonUnit"), false)
                || ReadBool(runtime.GetField(unitData, "m_bSummonUnit"), false);
        }

        private bool IsManagedAssistUnit(object? teamData, long unitUid)
        {
            if (teamData == null || unitUid <= 0) return false;
            try
            {
                return ReadBool(runtime.Invoke(teamData, "IsAssistUnit", unitUid), false);
            }
            catch
            {
                return false;
            }
        }

        private void ApplyManagedDamageTakenMap(IDictionary managedRecords)
        {
            if (runtime.GetField(server, "m_dicDamageTakenByUnit") is not IDictionary damageTakenByUnit) return;
            foreach (DictionaryEntry defenderEntry in damageTakenByUnit)
            {
                var defenderGameUid = ReadShort(defenderEntry.Key, 0);
                if (defenderGameUid <= 0 || defenderEntry.Value is not IDictionary attackerDamage) continue;

                foreach (DictionaryEntry attackerEntry in attackerDamage)
                {
                    var attackerGameUid = ReadShort(attackerEntry.Key, 0);
                    var damage = Math.Max(0f, ReadFloat(attackerEntry.Value, 0f));
                    if (attackerGameUid <= 0 || damage <= 0f) continue;
                    AddManagedRecordFloat(managedRecords, attackerGameUid, "recordGiveDamage", damage);
                    AddManagedRecordFloat(managedRecords, defenderGameUid, "recordTakeDamage", damage);
                }
            }
        }

        private void ApplyManagedHpDelta(IDictionary records, SortedDictionary<short, object> units)
        {
            foreach (var unitEntry in units)
            {
                if (!records.Contains(unitEntry.Key)) continue;
                var currentHp = Math.Max(0f, ReadFloat(runtime.Invoke(unitEntry.Value, "GetHP"), 0f));
                var maxHp = Math.Max(0f, ReadFloat(runtime.Invoke(unitEntry.Value, "GetMaxHP"), 0f));
                var damageTaken = Math.Max(0f, maxHp - currentHp);
                if (damageTaken <= 0f) continue;
                EnsureManagedRecordFloatAtLeast(records, unitEntry.Key, "recordTakeDamage", damageTaken);
            }
        }

        private void AddManagedRecordFloat(IDictionary records, short gameUnitUid, string fieldName, float value)
        {
            if (!records.Contains(gameUnitUid) || value <= 0f) return;
            var record = records[gameUnitUid];
            if (record == null) return;
            runtime.SetField(record, fieldName, ReadFloat(runtime.GetField(record, fieldName), 0f) + value);
        }

        private void EnsureManagedRecordFloatAtLeast(IDictionary records, short gameUnitUid, string fieldName, float value)
        {
            if (!records.Contains(gameUnitUid) || value <= 0f) return;
            var record = records[gameUnitUid];
            if (record == null) return;
            var current = ReadFloat(runtime.GetField(record, fieldName), 0f);
            if (current >= value) return;
            runtime.SetField(record, fieldName, value);
        }

        private void ApplyManagedMissingDamageAttribution(
            IDictionary records,
            SortedDictionary<short, object> liveUnits,
            SortedDictionary<short, object> allUnits)
        {
            ApplyManagedMissingDamageAttribution(records, liveUnits, allUnits, defenderTeamA: true);
            ApplyManagedMissingDamageAttribution(records, liveUnits, allUnits, defenderTeamA: false);
        }

        private void ApplyManagedMissingDamageAttribution(
            IDictionary records,
            SortedDictionary<short, object> liveUnits,
            SortedDictionary<short, object> allUnits,
            bool defenderTeamA)
        {
            var attackerTeamA = !defenderTeamA;
            var damageTaken = SumManagedRecordFloatByTeam(records, defenderTeamA, "recordTakeDamage");
            var damageGiven = SumManagedRecordFloatByTeam(records, attackerTeamA, "recordGiveDamage");
            var missingDamage = damageTaken - damageGiven;
            if (missingDamage <= 0.5f) return;

            var attackers = CollectManagedDamageAttributionAttackers(records, liveUnits, attackerTeamA, preferredOnly: true);
            if (attackers.Count == 0)
            {
                attackers = CollectManagedDamageAttributionAttackers(records, allUnits, attackerTeamA, preferredOnly: true);
            }
            if (attackers.Count == 0)
            {
                attackers = CollectManagedDamageAttributionAttackers(records, liveUnits, attackerTeamA, preferredOnly: false);
            }
            if (attackers.Count == 0)
            {
                attackers = CollectManagedDamageAttributionAttackers(records, allUnits, attackerTeamA, preferredOnly: false);
            }
            if (attackers.Count == 0) return;

            var share = missingDamage / attackers.Count;
            var assigned = 0f;
            for (var index = 0; index < attackers.Count; index += 1)
            {
                var damage = index == attackers.Count - 1 ? missingDamage - assigned : share;
                assigned += damage;
                AddManagedRecordFloat(records, attackers[index], "recordGiveDamage", damage);
            }
        }

        private float SumManagedRecordFloatByTeam(IDictionary records, bool teamA, string fieldName)
        {
            var total = 0f;
            foreach (DictionaryEntry entry in records)
            {
                var record = entry.Value;
                if (record == null) continue;
                if (IsRecordTeamA(ReadInt(runtime.GetField(record, "teamType"), 1)) != teamA) continue;
                total += Math.Max(0f, ReadFloat(runtime.GetField(record, fieldName), 0f));
            }

            return total;
        }

        private List<short> CollectManagedDamageAttributionAttackers(
            IDictionary records,
            SortedDictionary<short, object> candidateUnits,
            bool teamA,
            bool preferredOnly)
        {
            if (candidateUnits.Count == 0) return [];

            var mainShipGameUnitUids = CollectManagedMainShipGameUnitUids(teamA);
            var attackers = new List<short>();
            foreach (var unitEntry in candidateUnits)
            {
                if (!records.Contains(unitEntry.Key)) continue;
                var record = records[unitEntry.Key];
                if (record == null) continue;
                if (IsRecordTeamA(ReadInt(runtime.GetField(record, "teamType"), 1)) != teamA) continue;
                if (!IsManagedUnitEligibleForDamageAttribution(unitEntry.Value)) continue;
                if (preferredOnly && !IsPreferredManagedDamageAttributionUnit(unitEntry.Key, unitEntry.Value, record, mainShipGameUnitUids)) continue;
                attackers.Add(unitEntry.Key);
            }

            return attackers.Distinct().OrderBy(gameUnitUid => gameUnitUid).ToList();
        }

        private HashSet<short> CollectManagedMainShipGameUnitUids(bool teamA)
        {
            var output = new HashSet<short>();
            var gameData = runtime.Invoke(server, "GetGameData");
            var teamData = gameData == null ? null : runtime.GetField(gameData, teamA ? "m_NKMGameTeamDataA" : "m_NKMGameTeamDataB");
            var mainShip = teamData == null ? null : runtime.GetField(teamData, "m_MainShip");
            if (mainShip == null || runtime.GetField(mainShip, "m_listGameUnitUID") is not IEnumerable gameUnitUids) return output;

            foreach (var value in gameUnitUids)
            {
                var gameUnitUid = ReadShort(value, 0);
                if (gameUnitUid > 0) output.Add(gameUnitUid);
            }

            return output;
        }

        private bool IsManagedUnitEligibleForDamageAttribution(object unit)
        {
            try
            {
                if (ReadFloat(runtime.Invoke(unit, "GetHP"), 0f) <= 0f) return false;
                var syncData = runtime.Invoke(unit, "GetUnitSyncData");
                var playState = Convert.ToString(syncData == null ? null : runtime.GetField(syncData, "m_NKM_UNIT_PLAY_STATE"), CultureInfo.InvariantCulture) ?? "";
                return playState.IndexOf("DIE", StringComparison.OrdinalIgnoreCase) < 0;
            }
            catch
            {
                return true;
            }
        }

        private bool IsPreferredManagedDamageAttributionUnit(
            short gameUnitUid,
            object unit,
            object record,
            HashSet<short> mainShipGameUnitUids)
        {
            if (!mainShipGameUnitUids.Contains(gameUnitUid)) return true;
            if (ReadBool(runtime.GetField(record, "isSummonee"), false)) return true;

            var unitData = runtime.Invoke(unit, "GetUnitData");
            var unitDataGame = runtime.Invoke(unit, "GetUnitDataGame");
            return unitData != null && IsManagedSummonedUnit(unitData, unitDataGame);
        }

        private bool ManagedRecordsHaveDamage(IDictionary records)
        {
            foreach (DictionaryEntry entry in records)
            {
                var record = entry.Value;
                if (record == null) continue;
                if (ReadFloat(runtime.GetField(record, "recordGiveDamage"), 0f) > 0f
                    || ReadFloat(runtime.GetField(record, "recordTakeDamage"), 0f) > 0f
                    || ReadFloat(runtime.GetField(record, "recordHeal"), 0f) > 0f)
                {
                    return true;
                }
            }

            return false;
        }

        private void UpdateManagedGameRecordTotals(object gameRecord, IDictionary records)
        {
            var totalDamageA = 0f;
            var totalDamageB = 0f;
            var totalDieCountA = 0;
            var totalDieCountB = 0;
            foreach (DictionaryEntry entry in records)
            {
                var record = entry.Value;
                if (record == null) continue;
                var teamType = NormalizeRecordTeamType(ReadInt(runtime.GetField(record, "teamType"), 1));
                var giveDamage = Math.Max(0f, ReadFloat(runtime.GetField(record, "recordGiveDamage"), 0f));
                var dieCount = Math.Max(0, ReadInt(runtime.GetField(record, "recordDieCount"), 0));
                if (IsRecordTeamA(teamType))
                {
                    totalDamageA += giveDamage;
                    totalDieCountA += dieCount;
                }
                else
                {
                    totalDamageB += giveDamage;
                    totalDieCountB += dieCount;
                }
            }

            runtime.SetField(gameRecord, "totalDamageA", totalDamageA);
            runtime.SetField(gameRecord, "totalDamageB", totalDamageB);
            runtime.SetField(gameRecord, "totalDieCountA", totalDieCountA);
            runtime.SetField(gameRecord, "totalDieCountB", totalDieCountB);
        }

        private object? BuildManagedGameRecordFromBattleState()
        {
            if (latestBattleState == null) return null;
            var records = CollectBattleStateRecords();
            if (records.Count == 0) return null;

            var gameRecord = runtime.Create("NKM.NKMGameRecord");
            if (runtime.GetField(gameRecord, "unitRecords") is not IDictionary managedRecords) return null;
            foreach (var record in records)
            {
                var managedRecord = runtime.Create("ClientPacket.Common.NKMGameRecordUnitData");
                runtime.SetField(managedRecord, "unitId", record.UnitId);
                runtime.SetField(managedRecord, "changeUnitName", record.ChangeUnitName ?? "");
                runtime.SetField(managedRecord, "unitLevel", Math.Max(1, record.UnitLevel));
                runtime.SetField(managedRecord, "isSummonee", record.IsSummonee);
                runtime.SetField(managedRecord, "isAssistUnit", record.IsAssistUnit);
                runtime.SetField(managedRecord, "isLeader", record.IsLeader);
                runtime.SetField(managedRecord, "teamType", NormalizeRecordTeamType(record.TeamType));
                runtime.SetField(managedRecord, "recordGiveDamage", (float)Math.Max(0, record.RecordGiveDamage));
                runtime.SetField(managedRecord, "recordTakeDamage", (float)Math.Max(0, record.RecordTakeDamage));
                runtime.SetField(managedRecord, "recordHeal", (float)Math.Max(0, record.RecordHeal));
                runtime.SetField(managedRecord, "recordSummonCount", Math.Max(1, record.RecordSummonCount));
                runtime.SetField(managedRecord, "recordDieCount", Math.Max(0, record.RecordDieCount));
                runtime.SetField(managedRecord, "recordKillCount", Math.Max(0, record.RecordKillCount));
                runtime.SetField(managedRecord, "playtime", Math.Max(1, (int)Math.Round(record.Playtime)));
                managedRecords[(short)record.GameUnitUID] = managedRecord;
            }

            runtime.SetField(gameRecord, "totalDamageA", (float)records.Where(record => IsRecordTeamA(record.TeamType)).Sum(record => Math.Max(0, record.RecordGiveDamage)));
            runtime.SetField(gameRecord, "totalDamageB", (float)records.Where(record => !IsRecordTeamA(record.TeamType)).Sum(record => Math.Max(0, record.RecordGiveDamage)));
            runtime.SetField(gameRecord, "totalDieCountA", records.Where(record => IsRecordTeamA(record.TeamType)).Sum(record => Math.Max(0, record.RecordDieCount)));
            runtime.SetField(gameRecord, "totalDieCountB", records.Where(record => !IsRecordTeamA(record.TeamType)).Sum(record => Math.Max(0, record.RecordDieCount)));
            return gameRecord;
        }

        private List<BattleUnitRecord> CollectBattleStateRecords()
        {
            var byGameUnitUid = new Dictionary<int, BattleUnitRecord>();
            if (latestBattleState == null) return [];

            foreach (var record in latestBattleState.UnitRecords.Values)
            {
                if (record.GameUnitUID <= 0) continue;
                byGameUnitUid[record.GameUnitUID] = CopyBattleRecord(record);
            }

            foreach (var unit in latestBattleState.Units)
            {
                if (unit.GameUnitUID <= 0) continue;
                if (!byGameUnitUid.TryGetValue(unit.GameUnitUID, out var record))
                {
                    record = new BattleUnitRecord
                    {
                        GameUnitUID = unit.GameUnitUID,
                        RecordSummonCount = 1,
                        Playtime = Math.Max(1, latestBattleState.GameTime)
                    };
                    byGameUnitUid[unit.GameUnitUID] = record;
                }

                record.SourceUnitUID = string.IsNullOrWhiteSpace(record.SourceUnitUID) ? unit.SourceUnitUID : record.SourceUnitUID;
                record.Role = string.IsNullOrWhiteSpace(record.Role) ? unit.Role : record.Role;
                record.UnitId = record.UnitId > 0 ? record.UnitId : unit.UnitID;
                record.ChangeUnitName = string.IsNullOrWhiteSpace(record.ChangeUnitName) ? unit.ChangeUnitName : record.ChangeUnitName;
                record.UnitLevel = Math.Max(1, Math.Max(record.UnitLevel, unit.UnitLevel));
                record.IsSummonee = record.IsSummonee || unit.IsSummonee;
                record.IsAssistUnit = record.IsAssistUnit || unit.IsAssistUnit;
                record.IsLeader = record.IsLeader || unit.IsLeader;
                record.TeamType = NormalizeRecordTeamType(record.TeamType != 0 ? record.TeamType : unit.Team);
                record.RecordSummonCount = Math.Max(1, record.RecordSummonCount);
                record.Playtime = Math.Max(1, record.Playtime);
            }

            return byGameUnitUid.Values
                .Where(record => record.GameUnitUID > 0 && record.UnitId > 0)
                .OrderBy(record => record.GameUnitUID)
                .ToList();
        }

        private static BattleUnitRecord CopyBattleRecord(BattleUnitRecord source)
        {
            return new BattleUnitRecord
            {
                GameUnitUID = source.GameUnitUID,
                SourceUnitUID = source.SourceUnitUID,
                Role = source.Role,
                UnitId = source.UnitId,
                ChangeUnitName = source.ChangeUnitName,
                UnitLevel = source.UnitLevel,
                IsSummonee = source.IsSummonee,
                IsAssistUnit = source.IsAssistUnit,
                IsLeader = source.IsLeader,
                TeamType = source.TeamType,
                RecordGiveDamage = source.RecordGiveDamage,
                RecordTakeDamage = source.RecordTakeDamage,
                RecordHeal = source.RecordHeal,
                RecordSummonCount = source.RecordSummonCount,
                RecordDieCount = source.RecordDieCount,
                RecordKillCount = source.RecordKillCount,
                Playtime = source.Playtime
            };
        }

        private static int NormalizeRecordTeamType(int teamType)
        {
            return teamType switch
            {
                2 => 1,
                4 => 3,
                > 0 => teamType,
                _ => 1
            };
        }

        private static bool IsRecordTeamA(int teamType)
        {
            return NormalizeRecordTeamType(teamType) is 1 or 2;
        }

        private static int ReadInt(object? value, int fallback)
        {
            if (value == null) return fallback;
            try
            {
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        private static short ReadShort(object? value, short fallback)
        {
            if (value == null) return fallback;
            try
            {
                return Convert.ToInt16(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        private static long ReadLong(object? value, long fallback)
        {
            if (value == null) return fallback;
            try
            {
                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        private static bool ReadBool(object? value, bool fallback)
        {
            if (value == null) return fallback;
            try
            {
                return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }
    }

    private sealed class ManagedRuntime
    {
        private static readonly object Gate = new();
        private static ManagedRuntime? current;
        private static string currentRuntimeKey = "";
        private static readonly JsonSerializerOptions LuaTableJsonOptions = new(Json.Options)
        {
            PropertyNamingPolicy = null,
            DictionaryKeyPolicy = null
        };

        private readonly Assembly assembly;
        private readonly string managedDir;
        private readonly IReadOnlyList<string> nativeSearchDirs;
        private readonly object packetController;
        private readonly Type serializableType;
        private readonly MethodInfo packetCreate;
        private readonly MethodInfo packetGetId;
        private readonly MethodInfo packetReaderGetWithoutNullBit;
        private readonly ConstructorInfo packetReaderCtor;
        private readonly MethodInfo packetWriterToBufferWithoutNullBit;
        private readonly MethodInfo zeroCopyCalcTotalSize;
        private readonly MethodInfo zeroCopyGetView;
        private readonly FieldInfo messageQueueField;
        private readonly FieldInfo messageEventField;
        private readonly FieldInfo messageIdField;
        private readonly FieldInfo messageParamField;
        private bool clientTablesInitialized;
        private bool eventDeckTablesInitialized;

        private ManagedRuntime(string managedDir, string gameplayTablesDir)
        {
            this.managedDir = managedDir;
            AppDomain.CurrentDomain.AssemblyResolve += (_, args) => ResolveManagedAssembly(managedDir, args);
            ManagedLuaFileLoader.Configure(gameplayTablesDir);
            assembly = Assembly.LoadFrom(ManagedAssemblyPatcher.GetAssemblyPath(managedDir, gameplayTablesDir));
            nativeSearchDirs = BuildNativeSearchDirs(managedDir);
            PrimeNativeSearchPath(nativeSearchDirs);
            NativeLibrary.SetDllImportResolver(assembly, ResolveNativeLibrary);
            serializableType = GetType("Cs.Protocol.ISerializable");

            var packetControllerType = GetType("Cs.Protocol.PacketController");
            packetController = packetControllerType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
            packetControllerType.GetMethod("Initialize", BindingFlags.Public | BindingFlags.Instance)!.Invoke(packetController, null);
            packetCreate = packetControllerType.GetMethod("Create", BindingFlags.Public | BindingFlags.Instance, null, [typeof(ushort)], null)!;
            packetGetId = packetControllerType.GetMethod("GetId", BindingFlags.Public | BindingFlags.Instance, null, [serializableType], null)!;

            var packetReaderType = GetType("Cs.Protocol.PacketReader");
            packetReaderCtor = packetReaderType.GetConstructor([typeof(byte[])])!;
            packetReaderGetWithoutNullBit = packetReaderType.GetMethod("GetWithoutNullBit", BindingFlags.Public | BindingFlags.Instance, null, [serializableType], null)!;

            var packetWriterType = GetType("Cs.Protocol.PacketWriter");
            packetWriterToBufferWithoutNullBit = packetWriterType.GetMethod(
                "ToBufferWithoutNullBit",
                BindingFlags.Public | BindingFlags.Static,
                null,
                [serializableType],
                null)!;

            var zeroCopyType = GetType("Cs.Engine.Network.Buffer.ZeroCopyBuffer");
            zeroCopyCalcTotalSize = zeroCopyType.GetMethod("CalcTotalSize", BindingFlags.Public | BindingFlags.Instance)!;
            zeroCopyGetView = zeroCopyType.GetMethod("GetView", BindingFlags.NonPublic | BindingFlags.Instance)!;

            var messageType = GetType("NKC.NKCMessage");
            messageQueueField = messageType.GetField("m_linklistNKMMessageData", BindingFlags.NonPublic | BindingFlags.Static)!;
            var messageDataType = GetType("NKC.NKCMessageData");
            messageEventField = messageDataType.GetField("m_NKC_EVENT_MESSAGE", BindingFlags.Public | BindingFlags.Instance)!;
            messageIdField = messageDataType.GetField("m_MsgID2", BindingFlags.Public | BindingFlags.Instance)!;
            messageParamField = messageDataType.GetField("m_Param1", BindingFlags.Public | BindingFlags.Instance)!;
        }

        public static ManagedRuntime? TryLoad(string managedDir, string gameplayTablesDir, out string? error)
        {
            error = null;
            try
            {
                var fullPath = Path.GetFullPath(managedDir);
                var tablesPath = string.IsNullOrWhiteSpace(gameplayTablesDir) ? "" : Path.GetFullPath(gameplayTablesDir);
                var assemblyPath = Path.Combine(fullPath, "Assembly-CSharp.dll");
                if (!File.Exists(assemblyPath))
                {
                    error = $"missing Assembly-CSharp.dll in {fullPath}";
                    return null;
                }

                lock (Gate)
                {
                    var runtimeKey = fullPath + "|" + tablesPath;
                    if (current != null && string.Equals(currentRuntimeKey, runtimeKey, StringComparison.OrdinalIgnoreCase))
                    {
                        return current;
                    }

                    current = new ManagedRuntime(fullPath, tablesPath);
                    currentRuntimeKey = runtimeKey;
                    return current;
                }
            }
            catch (Exception ex)
            {
                error = ex.ToString();
                return null;
            }
        }

        public object Create(string typeName) => Activator.CreateInstance(GetType(typeName))!;

        public string ExportLuaTableJson(GameplayTableExportData data)
        {
            var directory = NormalizeLuaBundleDirectory(data.Directory);
            var fileBaseName = NormalizeLuaFileBaseName(data.FileName);
            if (string.IsNullOrWhiteSpace(directory)) throw new ArgumentException("table directory is required", nameof(data));
            if (string.IsNullOrWhiteSpace(fileBaseName)) throw new ArgumentException("table file name is required", nameof(data));

            var nkmlua = Create("NKM.NKMLua");
            try
            {
                var luaType = nkmlua.GetType();
                var loadCommonPathBase = luaType.GetMethod(
                    "LoadCommonPathBase",
                    BindingFlags.Public | BindingFlags.Instance,
                    null,
                    [typeof(string), typeof(string), typeof(bool), typeof(bool), typeof(string).MakeByRefType()],
                    null)
                    ?? throw new MissingMethodException(luaType.FullName, "LoadCommonPathBase");
                var luaServerField = FindField(luaType, "m_LuaSvr")
                    ?? throw new MissingFieldException(luaType.FullName, "m_LuaSvr");
                var luaServer = luaServerField.GetValue(nkmlua)
                    ?? throw new InvalidOperationException("NKMLua.m_LuaSvr was not available");
                var beforeKeys = GetLuaGlobalKeySet(luaServer);
                var errorMessage = "";
                object?[] loadArgs = [directory.ToUpperInvariant(), fileBaseName, false, false, errorMessage];
                var loaded = Convert.ToBoolean(loadCommonPathBase.Invoke(nkmlua, loadArgs), CultureInfo.InvariantCulture);
                if (!loaded)
                {
                    throw new InvalidOperationException(Convert.ToString(loadArgs[4], CultureInfo.InvariantCulture) ?? "Lua table load failed");
                }

                var globals = GetLuaGlobalDictionary(luaServer);
                var selected = SelectExportLuaRoot(luaServer, globals, beforeKeys, data.RootName, fileBaseName);
                var root = ConvertLuaValue(luaServer, selected.Table, new HashSet<int>(), 0);
                var records = BuildLuaTableRecords(root);
                var exportedGlobals = BuildExportedLuaGlobals(luaServer, globals, beforeKeys);
                var envelope = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["source"] = "managed-luac",
                    ["directory"] = directory.ToLowerInvariant(),
                    ["fileName"] = data.FileName,
                    ["rootName"] = selected.RootName,
                    ["globalCount"] = exportedGlobals.Count,
                    ["globals"] = exportedGlobals,
                    ["recordCount"] = records.Count,
                    ["records"] = records,
                    ["root"] = root
                };
                return JsonSerializer.Serialize(envelope, LuaTableJsonOptions);
            }
            finally
            {
                if (nkmlua is IDisposable disposable)
                {
                    disposable.Dispose();
                }
            }
        }

        public List<int> FindMissingUnitTemplets(IEnumerable<int> unitIds)
        {
            var manager = GetType("NKM.NKMUnitManager");
            var getBase = manager.GetMethod("GetUnitTempletBase", BindingFlags.Public | BindingFlags.Static, null, [typeof(int)], null)
                ?? throw new MissingMethodException(manager.FullName, "GetUnitTempletBase(int)");
            var getBattle = manager.GetMethod("GetUnitTemplet", BindingFlags.Public | BindingFlags.Static, null, [typeof(int)], null)
                ?? throw new MissingMethodException(manager.FullName, "GetUnitTemplet(int)");
            return unitIds.Where(id =>
            {
                var battle = getBattle.Invoke(null, [id]);
                return getBase.Invoke(null, [id]) == null
                    || battle == null
                    || CountCollection(GetField(battle, "m_dicNKMUnitState")) == 0;
            }).ToList();
        }

        private static Dictionary<string, object?> BuildExportedLuaGlobals(object luaServer, IDictionary globals, HashSet<string> beforeKeys)
        {
            var exported = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var entry in EnumerateLuaDictionaryEntries(globals))
            {
                var key = LuaKeyToString(entry.Key);
                if (string.IsNullOrWhiteSpace(key) || beforeKeys.Contains(key)) continue;
                exported[key] = ConvertLuaValue(luaServer, entry.Value, new HashSet<int>(), 0);
            }
            return exported;
        }

        public void InitializeClientTables(IReadOnlyList<string>? contentsTags)
        {
            if (clientTablesInitialized) return;
            var tags = (contentsTags ?? [])
                .Select(tag => (tag ?? "").Trim())
                .Where(tag => tag.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(tag => tag, StringComparer.OrdinalIgnoreCase)
                .ToList();
            GetType("NKC.NKCContentsVersionManager")
                .GetMethod("SetTagList", BindingFlags.Public | BindingFlags.Static, null, [typeof(IReadOnlyList<string>)], null)!
                .Invoke(null, [tags]);
            var nkcMainType = GetType("NKC.NKCMain");
            nkcMainType.GetMethod("NKCInit", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null);
            LoadOptionalStaticTable("NKM.NKMBattleConditionManager", "LoadFromLua");
            LoadOptionalStaticTable("NKM.NKMTacticUpdateTemplet", "LoadFromLua");
            clientTablesInitialized = true;
        }

        private void LoadOptionalStaticTable(string typeName, string methodName)
        {
            try
            {
                GetType(typeName)
                    .GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static, null, Type.EmptyTypes, null)
                    ?.Invoke(null, null);
            }
            catch
            {
                // Optional combat support tables should not block startup; the
                // managed bridge can still fall back if a table is unavailable.
            }
        }

        private static string NormalizeLuaBundleDirectory(string value)
        {
            var normalized = (value ?? "").Replace('\\', '/').Trim('/');
            if (string.IsNullOrWhiteSpace(normalized)) return "";
            var parts = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return "";
            if (parts[^1].Equals("luac", StringComparison.OrdinalIgnoreCase) && parts.Length > 1)
            {
                return parts[^2];
            }
            return parts[^1];
        }

        private static string NormalizeLuaFileBaseName(string value)
        {
            var normalized = (value ?? "").Replace('\\', '/').Trim();
            var fileName = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? "";
            while (true)
            {
                var extension = Path.GetExtension(fileName);
                if (!extension.Equals(".json", StringComparison.OrdinalIgnoreCase)
                    && !extension.Equals(".luac", StringComparison.OrdinalIgnoreCase)
                    && !extension.Equals(".lua", StringComparison.OrdinalIgnoreCase)
                    && !extension.Equals(".bytes", StringComparison.OrdinalIgnoreCase))
                {
                    return fileName;
                }
                fileName = Path.GetFileNameWithoutExtension(fileName);
            }
        }

        private static HashSet<string> GetLuaGlobalKeySet(object luaServer)
        {
            return EnumerateLuaDictionaryEntries(GetLuaGlobalDictionary(luaServer))
                .Select(entry => LuaKeyToString(entry.Key))
                .Where(key => !string.IsNullOrWhiteSpace(key))
                .ToHashSet(StringComparer.Ordinal);
        }

        private static IDictionary GetLuaGlobalDictionary(object luaServer)
        {
            var globalTable = TryGetLuaTableByName(luaServer, "_G")
                ?? throw new InvalidOperationException("Lua global table was not available");
            return GetLuaTableDictionary(luaServer, globalTable);
        }

        private static object? TryGetLuaTableByName(object luaServer, string rootName)
        {
            if (string.IsNullOrWhiteSpace(rootName)) return null;
            try
            {
                var method = luaServer.GetType().GetMethod(
                    "GetTable",
                    BindingFlags.Public | BindingFlags.Instance,
                    null,
                    [typeof(string)],
                    null)
                    ?? throw new MissingMethodException(luaServer.GetType().FullName, "GetTable");
                var value = method.Invoke(luaServer, [rootName]);
                return IsLuaTable(value) ? value : null;
            }
            catch
            {
                return null;
            }
        }

        private static IDictionary GetLuaTableDictionary(object luaServer, object table)
        {
            var method = luaServer.GetType().GetMethod(
                "GetTableDict",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                [table.GetType()],
                null)
                ?? throw new MissingMethodException(luaServer.GetType().FullName, "GetTableDict");
            var value = method.Invoke(luaServer, [table]);
            return value as IDictionary ?? throw new InvalidOperationException("Lua table dictionary was not available");
        }

        private static IEnumerable<(object? Key, object? Value)> EnumerateLuaDictionaryEntries(IDictionary dictionary)
        {
            foreach (var item in dictionary)
            {
                if (item is DictionaryEntry entry)
                {
                    yield return (entry.Key, entry.Value);
                    continue;
                }

                var itemType = item?.GetType();
                var keyProperty = itemType?.GetProperty("Key", BindingFlags.Public | BindingFlags.Instance);
                var valueProperty = itemType?.GetProperty("Value", BindingFlags.Public | BindingFlags.Instance);
                if (keyProperty != null && valueProperty != null)
                {
                    yield return (keyProperty.GetValue(item), valueProperty.GetValue(item));
                }
            }
        }

        private static (string RootName, object Table) SelectExportLuaRoot(
            object luaServer,
            IDictionary globals,
            HashSet<string> beforeKeys,
            string explicitRootName,
            string fileBaseName)
        {
            if (!string.IsNullOrWhiteSpace(explicitRootName))
            {
                var explicitRoot = TryGetLuaTableByName(luaServer, explicitRootName.Trim());
                if (explicitRoot != null) return (explicitRootName.Trim(), explicitRoot);
            }

            var candidates = new List<(string RootName, object Table, int Count, int Score)>();
            foreach (var entry in EnumerateLuaDictionaryEntries(globals))
            {
                var key = LuaKeyToString(entry.Key);
                if (string.IsNullOrWhiteSpace(key) || !IsLuaTable(entry.Value)) continue;
                var isNew = !beforeKeys.Contains(key);
                if (!isNew && !IsLikelyRootName(key, fileBaseName)) continue;
                var count = SafeLuaTableCount(luaServer, entry.Value!);
                var score = count + (isNew ? 1_000_000 : 0) + (IsLikelyRootName(key, fileBaseName) ? 100_000 : 0);
                candidates.Add((key, entry.Value!, count, score));
            }

            if (candidates.Count > 0)
            {
                var selected = candidates
                    .OrderByDescending(candidate => candidate.Score)
                    .ThenByDescending(candidate => candidate.Count)
                    .ThenBy(candidate => candidate.RootName, StringComparer.Ordinal)
                    .First();
                return (selected.RootName, selected.Table);
            }

            foreach (var name in BuildDerivedRootNameCandidates(fileBaseName))
            {
                var table = TryGetLuaTableByName(luaServer, name);
                if (table != null) return (name, table);
            }

            throw new InvalidOperationException($"Lua table root could not be determined for {fileBaseName}");
        }

        private static IEnumerable<string> BuildDerivedRootNameCandidates(string fileBaseName)
        {
            var names = new[]
            {
                fileBaseName,
                StripLuaPrefix(fileBaseName)
            };
            return names
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Distinct(StringComparer.Ordinal);
        }

        private static bool IsLikelyRootName(string rootName, string fileBaseName)
        {
            var normalizedRoot = NormalizeRootNameToken(rootName);
            var normalizedFile = NormalizeRootNameToken(fileBaseName);
            var normalizedFileWithoutPrefix = NormalizeRootNameToken(StripLuaPrefix(fileBaseName));
            return normalizedRoot == normalizedFile || normalizedRoot == normalizedFileWithoutPrefix;
        }

        private static string StripLuaPrefix(string value)
        {
            return value.StartsWith("LUA_", StringComparison.OrdinalIgnoreCase) ? value[4..] : value;
        }

        private static string NormalizeRootNameToken(string value)
        {
            return new string((value ?? "")
                .Where(char.IsLetterOrDigit)
                .Select(char.ToUpperInvariant)
                .ToArray());
        }

        private static int SafeLuaTableCount(object luaServer, object table)
        {
            try
            {
                return GetLuaTableDictionary(luaServer, table).Count;
            }
            catch
            {
                return 0;
            }
        }

        private static object? ConvertLuaValue(object luaServer, object? value, HashSet<int> visitedTables, int depth)
        {
            if (value == null || depth > 64) return null;
            if (IsLuaTable(value)) return ConvertLuaTable(luaServer, value, visitedTables, depth + 1);
            if (value is string or bool) return value;
            if (value is byte or sbyte or short or ushort or int or uint or long or ulong) return value;
            if (value is float single) return float.IsFinite(single) ? single : null;
            if (value is double number) return double.IsFinite(number) ? number : null;
            if (value is decimal decimalValue) return decimalValue;
            if (value.GetType().IsEnum) return value.ToString();
            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static object? ConvertLuaTable(object luaServer, object table, HashSet<int> visitedTables, int depth)
        {
            var tableReference = table.GetHashCode();
            if (!visitedTables.Add(tableReference)) return null;
            try
            {
                var entries = EnumerateLuaDictionaryEntries(GetLuaTableDictionary(luaServer, table))
                    .Select(entry => (
                        KeyText: LuaKeyToString(entry.Key),
                        Index: TryGetPositiveIntegerKey(entry.Key),
                        Value: entry.Value))
                    .Where(entry => !string.IsNullOrWhiteSpace(entry.KeyText))
                    .ToList();
                if (entries.Count == 0) return new Dictionary<string, object?>(StringComparer.Ordinal);

                var indexedEntries = entries.Where(entry => entry.Index.HasValue).ToList();
                if (indexedEntries.Count == entries.Count)
                {
                    var ordered = indexedEntries.OrderBy(entry => entry.Index!.Value).ToList();
                    var contiguous = ordered[0].Index == 1 && ordered.Select((entry, index) => entry.Index == index + 1).All(match => match);
                    if (contiguous)
                    {
                        return ordered
                            .Select(entry => ConvertLuaValue(luaServer, entry.Value, visitedTables, depth + 1))
                            .ToList();
                    }
                }

                var output = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var entry in entries
                    .OrderBy(entry => entry.Index.HasValue ? 0 : 1)
                    .ThenBy(entry => entry.Index ?? int.MaxValue)
                    .ThenBy(entry => entry.KeyText, StringComparer.Ordinal))
                {
                    output[entry.KeyText] = ConvertLuaValue(luaServer, entry.Value, visitedTables, depth + 1);
                }
                return output;
            }
            finally
            {
                visitedTables.Remove(tableReference);
            }
        }

        private static List<object?> BuildLuaTableRecords(object? root)
        {
            if (root is List<object?> list) return list;
            if (root is Dictionary<string, object?> dictionary)
            {
                var records = new List<object?>();
                foreach (var entry in dictionary)
                {
                    if (entry.Value is Dictionary<string, object?> row)
                    {
                        if (row.ContainsKey("__key"))
                        {
                            records.Add(new Dictionary<string, object?>(row, StringComparer.Ordinal));
                        }
                        else
                        {
                            var withKey = new Dictionary<string, object?>(StringComparer.Ordinal)
                            {
                                ["__key"] = entry.Key
                            };
                            foreach (var field in row)
                            {
                                withKey[field.Key] = field.Value;
                            }
                            records.Add(withKey);
                        }
                    }
                    else if (entry.Value is List<object?> values)
                    {
                        records.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
                        {
                            ["__key"] = entry.Key,
                            ["values"] = values
                        });
                    }
                    else
                    {
                        records.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
                        {
                            ["__key"] = entry.Key,
                            ["value"] = entry.Value
                        });
                    }
                }
                return records;
            }
            return [];
        }

        private static int? TryGetPositiveIntegerKey(object? key)
        {
            if (key == null || key is string) return null;
            try
            {
                var value = Convert.ToDouble(key, CultureInfo.InvariantCulture);
                if (!double.IsFinite(value)) return null;
                var rounded = Math.Round(value);
                if (Math.Abs(value - rounded) > 0.0000001 || rounded < 1 || rounded > int.MaxValue) return null;
                return (int)rounded;
            }
            catch
            {
                return null;
            }
        }

        private static string LuaKeyToString(object? key)
        {
            if (key == null) return "";
            var positiveInteger = TryGetPositiveIntegerKey(key);
            if (positiveInteger.HasValue) return positiveInteger.Value.ToString(CultureInfo.InvariantCulture);
            return Convert.ToString(key, CultureInfo.InvariantCulture) ?? "";
        }

        private static bool IsLuaTable(object? value)
        {
            if (value == null) return false;
            var type = value.GetType();
            return string.Equals(type.FullName, "NLua.LuaTable", StringComparison.Ordinal)
                || string.Equals(type.Name, "LuaTable", StringComparison.Ordinal);
        }

        public void PrepareGameDataForLocalServer(object gameData)
        {
            // Captured GAME_LOAD_ACK payloads already contain gameUnitUID lists
            // because they were built by the official server. NKCGameServerLocal
            // expects raw deck/team data and assigns those runtime IDs itself.
            SetField(gameData, "m_GameUnitUIDIndex", (short)0);
            foreach (var teamField in new[] { "m_NKMGameTeamDataA", "m_NKMGameTeamDataB" })
            {
                var team = GetField(gameData, teamField);
                if (team != null)
                {
                    ClearTeamRuntimeUnitIds(team);
                }
            }
        }

        public void ApplyGameType(object gameData, DynamicGameState dynamicGame)
        {
            // Captured 804 starts as a tutorial payload. Pin the type each time
            // NKCGameServerLocal mutates gameData so normal and special PvE
            // stages do not inherit stale tutorial result flow.
            var gameTypeName = ResolveGameTypeName(dynamicGame);
            SetField(gameData, "m_NKM_GAME_TYPE", Enum.Parse(GetType("NKM.NKM_GAME_TYPE"), gameTypeName));
        }

        public void ApplyBattleConditionIds(object gameData, IEnumerable<int>? battleConditionIds)
        {
            var dictionary = GetField(gameData, "m_BattleConditionIDs");
            if (dictionary is not IDictionary battleConditions) return;

            battleConditions.Clear();
            foreach (var battleConditionId in (battleConditionIds ?? Enumerable.Empty<int>()).Where(id => id > 0).Distinct())
            {
                battleConditions[battleConditionId] = 1;
            }
        }

        private static string ResolveGameTypeName(DynamicGameState dynamicGame)
        {
            if (IsTutorialDungeon(dynamicGame.DungeonID)) return "NGT_TUTORIAL";
            return dynamicGame.GameType switch
            {
                8 => "NGT_RAID",
                9 => "NGT_CUTSCENE",
                12 => "NGT_RAID_SOLO",
                13 => "NGT_SHADOW_PALACE",
                14 => "NGT_FIERCE",
                15 => "NGT_PHASE",
                18 => "NGT_PVP_PRIVATE",
                23 => "NGT_TRIM",
                26 => "NGT_PVE_DEFENCE",
                29 => "NGT_EXPLORE",
                _ => "NGT_DUNGEON"
            };
        }

        private static bool IsTutorialDungeon(int dungeonId)
        {
            return dungeonId is 1004 or 1005 or 1006 or 1007;
        }

        public void ApplyTutorialEventDeckTeamA(object gameData, int eventDeckId)
        {
            // Later tutorial phases use event decks 1005..1007. The regular
            // MakeEventDeckShipData path can fail when local ship level-break
            // tables are incomplete, so hydrate Team A with the event-deck NPC
            // units directly and keep/replace the ship only when that is safe.
            if (eventDeckId < 1004 || eventDeckId > 1007) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var dungeonManagerType = GetType("NKM.NKMDungeonManager");
            var eventDeckTemplet = GetEventDeckTemplet(dungeonManagerType, eventDeckId);
            if (eventDeckTemplet == null) return;

            ApplyEventDeckShip(teamA, dungeonManagerType, eventDeckTemplet);
            ApplyEventDeckUnits(teamA, dungeonManagerType, eventDeckTemplet);
            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void RefreshTutorialTeamADeck(object gameData, int stageId, int dungeonId)
        {
            if (!IsTutorialDungeon(dungeonId) && stageId is not (11211 or 11212 or 11213 or 11214)) return;
            if (stageId == 11211 || dungeonId == 1004) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;
            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void ApplyEventDeckTeamA(object gameData, int eventDeckId)
        {
            if (eventDeckId <= 0) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var dungeonManagerType = GetType("NKM.NKMDungeonManager");
            var eventDeckTemplet = GetEventDeckTemplet(dungeonManagerType, eventDeckId);
            if (eventDeckTemplet == null) return;

            ApplyEventDeckShip(teamA, dungeonManagerType, eventDeckTemplet);
            ApplyEventDeckUnits(teamA, dungeonManagerType, eventDeckTemplet);
            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void ApplyPlayerDeckTeamA(object gameData, PlayerDeckData? playerDeck, int stageId, int dungeonId)
        {
            ApplyPlayerDeck(gameData, playerDeck, stageId, dungeonId, "m_NKMGameTeamDataA", "NTT_A1", true);
        }

        public void ApplyPlayerDeckTeamB(object gameData, PlayerDeckData? playerDeck, int stageId, int dungeonId)
        {
            ApplyPlayerDeck(gameData, playerDeck, stageId, dungeonId, "m_NKMGameTeamDataB", "NTT_B1", false);
        }

        private void ApplyPlayerDeck(
            object gameData,
            PlayerDeckData? playerDeck,
            int stageId,
            int dungeonId,
            string teamField,
            string teamTypeName,
            bool excludeTutorial)
        {
            if (playerDeck == null || playerDeck.Units.Count == 0) return;
            if (excludeTutorial && (IsTutorialDungeon(dungeonId) || stageId is 11211 or 11212 or 11213 or 11214)) return;

            var teamA = GetField(gameData, teamField);
            if (teamA == null) return;

            var userUid = ParseLong(playerDeck.UserUid);
            SetField(teamA, "m_eNKM_TEAM_TYPE", Enum.Parse(GetType("NKM.NKM_TEAM_TYPE"), teamTypeName));
            SetField(teamA, "m_user_uid", userUid);
            SetField(teamA, "m_UserLevel", Math.Max(1, playerDeck.UserLevel));
            SetField(teamA, "m_UserNickname", playerDeck.Nickname ?? "");

            if (playerDeck.ShipUnitId > 0)
            {
                var shipUid = ParseLong(playerDeck.ShipUid);
                if (shipUid <= 0) shipUid = userUid > 0 ? userUid + 1 : 1;
                SetField(teamA, "m_MainShip", CreateBasicUnit(
                    playerDeck.ShipUnitId,
                    shipUid,
                    Math.Max(1, playerDeck.ShipLevel),
                    playerDeck.ShipSkinId,
                    0,
                    0,
                    userUid,
                    null,
                    null));
            }

            ClearCollectionField(teamA, "m_listUnitData");
            ClearCollectionField(teamA, "m_listAssistUnitData");
            ClearCollectionField(teamA, "m_listEvevtUnitData");
            ClearCollectionField(teamA, "m_listOperatorUnitData");
            ClearCollectionField(teamA, "m_listDynamicRespawnUnitData");
            ClearCollectionField(teamA, "m_ItemEquipData");
            PopulatePlayerDeckEquipItems(teamA, playerDeck);
            var validEquipItemUids = GetPlayerDeckEquipUidSet(playerDeck);

            var unitList = GetField(teamA, "m_listUnitData");
            long firstUnitUid = 0;
            foreach (var unitData in playerDeck.Units.OrderBy(unit => unit.SlotIndex))
            {
                var unitUid = ParseLong(unitData.UnitUid);
                if (unitData.UnitId <= 0 || unitUid <= 0) continue;
                var unit = CreateBasicUnit(
                    unitData.UnitId,
                    unitUid,
                    Math.Max(1, unitData.Level),
                    unitData.SkinId,
                    unitData.TacticLevel,
                    unitData.LimitBreakLevel,
                    userUid,
                    unitData.SkillLevels,
                    GetValidUnitEquipItemUids(unitData, validEquipItemUids));
                AddCollectionItem(unitList, unit);
                if (firstUnitUid <= 0) firstUnitUid = unitUid;
            }

            var leaderUid = ParseLong(playerDeck.LeaderUnitUid);
            if (leaderUid <= 0) leaderUid = firstUnitUid;
            if (leaderUid > 0) SetField(teamA, "m_LeaderUnitUID", leaderUid);

            RefreshTeamDeck(gameData, teamA, resetDeck: true);
        }

        public void ApplyPlayerDeckFreeSlotsTeamA(
            object gameData,
            PlayerDeckData? playerDeck,
            IEnumerable<int>? freeSlots,
            bool usePlayerShip,
            int eventDeckId = 0)
        {
            var slotSet = freeSlots?
                .Where(slot => slot >= 0 && slot < 8)
                .Distinct()
                .Order()
                .ToList();
            if (playerDeck == null || playerDeck.Units.Count == 0 || slotSet == null || slotSet.Count == 0) return;

            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA == null) return;

            var userUid = ParseLong(playerDeck.UserUid);
            SetField(teamA, "m_eNKM_TEAM_TYPE", Enum.Parse(GetType("NKM.NKM_TEAM_TYPE"), "NTT_A1"));
            SetField(teamA, "m_user_uid", userUid);
            SetField(teamA, "m_UserLevel", Math.Max(1, playerDeck.UserLevel));
            SetField(teamA, "m_UserNickname", playerDeck.Nickname ?? "");

            if (usePlayerShip && playerDeck.ShipUnitId > 0)
            {
                var shipUid = ParseLong(playerDeck.ShipUid);
                if (shipUid <= 0) shipUid = userUid > 0 ? userUid + 1 : 1;
                SetField(teamA, "m_MainShip", CreateBasicUnit(
                    playerDeck.ShipUnitId,
                    shipUid,
                    Math.Max(1, playerDeck.ShipLevel),
                    playerDeck.ShipSkinId,
                    0,
                    0,
                    userUid,
                    null,
                    null));
            }

            var unitList = GetField(teamA, "m_listUnitData");
            if (unitList == null) return;
            PopulatePlayerDeckEquipItems(teamA, playerDeck);
            var validEquipItemUids = GetPlayerDeckEquipUidSet(playerDeck);
            var eventDeckSlotPositions = GetEventDeckGeneratedUnitPositions(eventDeckId);

            var usedPlayerUnitUids = new HashSet<long>();
            if (unitList is IEnumerable existingUnits)
            {
                foreach (var existingUnit in existingUnits)
                {
                    if (existingUnit == null) continue;
                    var unitUid = Convert.ToInt64(GetField(existingUnit, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
                    if (unitUid > 0) usedPlayerUnitUids.Add(unitUid);
                }
            }

            var orderedPlayerUnits = playerDeck.Units.OrderBy(unit => unit.SlotIndex).ToList();
            long firstAddedUnitUid = 0;
            foreach (var slotIndex in slotSet)
            {
                var unitData = orderedPlayerUnits.FirstOrDefault(unit => unit.SlotIndex == slotIndex && IsUsable(unit));
                if (unitData == null) continue;

                var unitUid = ParseLong(unitData.UnitUid);
                var unit = CreateBasicUnit(
                    unitData.UnitId,
                    unitUid,
                    Math.Max(1, unitData.Level),
                    unitData.SkinId,
                    unitData.TacticLevel,
                    unitData.LimitBreakLevel,
                    userUid,
                    unitData.SkillLevels,
                    GetValidUnitEquipItemUids(unitData, validEquipItemUids));
                if (!eventDeckSlotPositions.TryGetValue(slotIndex, out var existingUnitIndex) ||
                    !TrySetCollectionItem(unitList, existingUnitIndex, unit))
                {
                    AddCollectionItem(unitList, unit);
                }
                usedPlayerUnitUids.Add(unitUid);
                if (firstAddedUnitUid <= 0) firstAddedUnitUid = unitUid;
            }

            var existingLeaderUid = Convert.ToInt64(GetField(teamA, "m_LeaderUnitUID") ?? 0, CultureInfo.InvariantCulture);
            var playerLeaderUid = ParseLong(playerDeck.LeaderUnitUid);
            if (playerLeaderUid > 0 && usedPlayerUnitUids.Contains(playerLeaderUid))
            {
                SetField(teamA, "m_LeaderUnitUID", playerLeaderUid);
            }
            else
            {
                var eventDeckLeaderUid = GetEventDeckLeaderUnitUid(unitList, eventDeckSlotPositions, playerDeck.LeaderIndex);
                if (eventDeckLeaderUid > 0)
                {
                    SetField(teamA, "m_LeaderUnitUID", eventDeckLeaderUid);
                }
                else if (existingLeaderUid <= 0 && firstAddedUnitUid > 0)
                {
                    SetField(teamA, "m_LeaderUnitUID", firstAddedUnitUid);
                }
            }

            RefreshTeamDeck(gameData, teamA, resetDeck: true);

            bool IsUsable(PlayerUnitData unitData)
            {
                var unitUid = ParseLong(unitData.UnitUid);
                return unitData.UnitId > 0 && unitUid > 0 && !usedPlayerUnitUids.Contains(unitUid);
            }
        }

        private Dictionary<int, int> GetEventDeckGeneratedUnitPositions(int eventDeckId)
        {
            var positions = new Dictionary<int, int>();
            if (eventDeckId <= 0) return positions;

            var dungeonManagerType = GetType("NKM.NKMDungeonManager");
            var eventDeckTemplet = GetEventDeckTemplet(dungeonManagerType, eventDeckId);
            if (eventDeckTemplet == null) return positions;

            var getUnitSlot = eventDeckTemplet.GetType().GetMethod(
                "GetUnitSlot",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                [typeof(int)],
                null);
            if (getUnitSlot == null) return positions;

            var generatedIndex = 0;
            for (var slotIndex = 0; slotIndex < 8; slotIndex++)
            {
                var slot = getUnitSlot.Invoke(eventDeckTemplet, [slotIndex]);
                if (slot == null) continue;
                var slotType = GetField(slot, "m_eType")?.ToString() ?? "";
                if (!EventDeckSlotCreatesPresetUnit(slotType)) continue;
                positions[slotIndex] = generatedIndex;
                generatedIndex++;
            }
            return positions;
        }

        private long GetEventDeckLeaderUnitUid(object unitList, Dictionary<int, int> eventDeckSlotPositions, int leaderIndex)
        {
            if (leaderIndex < 0 || !eventDeckSlotPositions.TryGetValue(leaderIndex, out var listIndex)) return 0;
            if (listIndex < 0) return 0;

            if (unitList is IList list)
            {
                if (listIndex >= list.Count) return 0;
                var unit = list[listIndex];
                return unit == null ? 0 : Convert.ToInt64(GetField(unit, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
            }

            if (unitList is not IEnumerable units) return 0;
            var index = 0;
            foreach (var unit in units)
            {
                if (index == listIndex) return Convert.ToInt64(GetField(unit, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
                index++;
            }
            return 0;
        }

        private static bool EventDeckSlotCreatesPresetUnit(string slotType)
        {
            return slotType is "ST_GUEST" or "ST_NPC" or "ST_RANDOM";
        }

        private static bool EventDeckSlotCanSynthesizeUnit(string slotType)
        {
            return slotType is "ST_FIXED" or "ST_GUEST" or "ST_NPC";
        }

        private static bool TrySetCollectionItem(object collection, int index, object value)
        {
            if (index < 0) return false;
            if (collection is IList list)
            {
                if (index >= list.Count) return false;
                list[index] = value;
                return true;
            }

            var countProperty = collection.GetType().GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
            var count = Convert.ToInt32(countProperty?.GetValue(collection) ?? 0, CultureInfo.InvariantCulture);
            if (index >= count) return false;

            var itemProperty = collection.GetType().GetProperty("Item", BindingFlags.Public | BindingFlags.Instance);
            if (itemProperty == null) return false;
            itemProperty.SetValue(collection, value, [index]);
            return true;
        }

        public void ApplyPlayerIdentityTeamA(object gameData, PlayerDeckData? playerDeck)
        {
            ApplyPlayerIdentityTeam(gameData, playerDeck, "m_NKMGameTeamDataA", "NTT_A1");
        }

        public void ApplyPlayerIdentityTeamB(object gameData, PlayerDeckData? playerDeck)
        {
            ApplyPlayerIdentityTeam(gameData, playerDeck, "m_NKMGameTeamDataB", "NTT_B1");
        }

        private void ApplyPlayerIdentityTeam(object gameData, PlayerDeckData? playerDeck, string teamField, string teamTypeName)
        {
            if (playerDeck == null) return;
            var userUid = ParseLong(playerDeck.UserUid);
            if (userUid <= 0) return;

            var teamA = GetField(gameData, teamField);
            if (teamA == null) return;

            SetField(teamA, "m_eNKM_TEAM_TYPE", Enum.Parse(GetType("NKM.NKM_TEAM_TYPE"), teamTypeName));
            SetField(teamA, "m_user_uid", userUid);
            SetField(teamA, "m_UserLevel", Math.Max(1, playerDeck.UserLevel));
            SetField(teamA, "m_UserNickname", playerDeck.Nickname ?? "");
        }

        public void ApplyPlayerIdentityRuntimeData(object? runtimeData, PlayerDeckData? playerDeck)
        {
            ApplyPlayerIdentityRuntimeTeam(runtimeData, playerDeck, "m_NKMGameRuntimeTeamDataA");
        }

        public void ApplyPlayerIdentityRuntimeDataB(object? runtimeData, PlayerDeckData? playerDeck)
        {
            ApplyPlayerIdentityRuntimeTeam(runtimeData, playerDeck, "m_NKMGameRuntimeTeamDataB");
        }

        private void ApplyPlayerIdentityRuntimeTeam(object? runtimeData, PlayerDeckData? playerDeck, string runtimeTeamField)
        {
            if (runtimeData == null || playerDeck == null) return;
            var userUid = ParseLong(playerDeck.UserUid);
            if (userUid <= 0) return;

            SetField(runtimeData, "m_NKM_GAME_SPEED_TYPE", 0);
            var runtimeTeamA = GetField(runtimeData, runtimeTeamField);
            if (runtimeTeamA == null) return;
            SetField(runtimeTeamA, "m_UserUID", userUid);
            SetField(runtimeTeamA, "m_bAutoRespawn", false);
            SetField(runtimeTeamA, "m_NKM_GAME_AUTO_SKILL_TYPE", 1);
        }

        public void ApplyTeamAStartingRespawnCost(object gameData, object? runtimeData)
        {
            ApplyTeamStartingRespawnCost(gameData, runtimeData, "m_NKMGameRuntimeTeamDataA", "m_NKMGameTeamDataA");
        }

        public void ApplyTeamBStartingRespawnCost(object gameData, object? runtimeData)
        {
            ApplyTeamStartingRespawnCost(gameData, runtimeData, "m_NKMGameRuntimeTeamDataB", "m_NKMGameTeamDataB");
        }

        private void ApplyTeamStartingRespawnCost(object gameData, object? runtimeData, string runtimeTeamField, string gameTeamField)
        {
            if (runtimeData == null) return;
            var runtimeTeamA = GetField(runtimeData, runtimeTeamField);
            if (runtimeTeamA == null) return;

            var startCost = CalculateStartingRespawnCost(gameData, gameTeamField);
            if (startCost.HasValue)
            {
                SetField(runtimeTeamA, "m_fRespawnCost", startCost.Value);
            }
        }

        private float? CalculateStartingRespawnCost(object gameData, string gameTeamField)
        {
            var teamSupply = Convert.ToInt32(GetField(gameData, "m_TeamASupply") ?? 0, CultureInfo.InvariantCulture);
            if (teamSupply <= 0) return 0f;

            var teamA = GetField(gameData, gameTeamField);
            if (teamA == null) return null;

            var ship = GetField(teamA, "m_MainShip");
            if (ship == null) return 4f;

            var starGrade = ReadShipStarGrade(ship);
            return Math.Clamp(4f + Math.Max(0, starGrade), 0f, 10f);
        }

        private static int ReadShipStarGrade(object ship)
        {
            try
            {
                var getStarGrade = ship.GetType().GetMethod(
                    "GetStarGrade",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null,
                    Type.EmptyTypes,
                    null);
                if (getStarGrade != null)
                {
                    return Convert.ToInt32(getStarGrade.Invoke(ship, null), CultureInfo.InvariantCulture);
                }
            }
            catch
            {
            }

            try
            {
                var getUnitTemplet = ship.GetType().GetMethod(
                    "GetUnitTemplet",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null,
                    Type.EmptyTypes,
                    null);
                var unitTemplet = getUnitTemplet?.Invoke(ship, null);
                var templetBase = unitTemplet == null ? null : GetFieldValue(unitTemplet, "m_UnitTempletBase");
                return Convert.ToInt32(GetFieldValue(templetBase, "m_StarGradeMax") ?? 0, CultureInfo.InvariantCulture);
            }
            catch
            {
                return 0;
            }
        }

        private static object? GetFieldValue(object? target, string fieldName)
        {
            if (target == null) return null;
            return FindField(target.GetType(), fieldName)?.GetValue(target);
        }

        public void ClearTeamAUnitOwnersForGameLoadAck(object gameData, PlayerDeckData? playerDeck)
        {
            ClearTeamUnitOwnersForGameLoadAck(gameData, playerDeck, "m_NKMGameTeamDataA");
        }

        public void ClearTeamBUnitOwnersForGameLoadAck(object gameData, PlayerDeckData? playerDeck)
        {
            ClearTeamUnitOwnersForGameLoadAck(gameData, playerDeck, "m_NKMGameTeamDataB");
        }

        private void ClearTeamUnitOwnersForGameLoadAck(object gameData, PlayerDeckData? playerDeck, string teamField)
        {
            var teamA = GetField(gameData, teamField);
            if (teamA == null) return;

            var playerUnitUids = GetPlayerDeckUnitUids(playerDeck);
            ClearUnitOwner(GetField(teamA, "m_MainShip"), playerUnitUids);
            foreach (var listField in new[] { "m_listUnitData", "m_listAssistUnitData", "m_listEvevtUnitData", "m_listEnvUnitData", "m_listOperatorUnitData" })
            {
                if (GetField(teamA, listField) is not IEnumerable units) continue;
                foreach (var unit in units)
                {
                    ClearUnitOwner(unit, playerUnitUids);
                }
            }
        }

        private static HashSet<long> GetPlayerDeckUnitUids(PlayerDeckData? playerDeck)
        {
            var unitUids = new HashSet<long>();
            if (playerDeck == null) return unitUids;

            foreach (var unit in playerDeck.Units)
            {
                var unitUid = ParseLong(unit.UnitUid);
                if (unitUid > 0) unitUids.Add(unitUid);
            }

            var shipUid = ParseLong(playerDeck.ShipUid);
            if (shipUid > 0) unitUids.Add(shipUid);

            var operatorUid = ParseLong(playerDeck.OperatorUid);
            if (operatorUid > 0) unitUids.Add(operatorUid);

            return unitUids;
        }

        private void ClearUnitOwner(object? unitData, HashSet<long> preservedUnitUids)
        {
            if (unitData == null) return;
            var unitUid = Convert.ToInt64(GetField(unitData, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
            if (unitUid > 0 && preservedUnitUids.Contains(unitUid)) return;
            SetField(unitData, "m_UserUID", 0L);
        }

        public object BuildGameData(StartBattleData data, DynamicGameState dynamicGame)
        {
            var gameData = Create("NKM.NKMGameData");
            SetField(gameData, "m_GameUID", dynamicGame.GameUID);
            SetField(gameData, "m_GameUnitUIDIndex", (short)0);
            SetField(gameData, "m_bLocal", false);
            SetField(gameData, "m_DungeonID", dynamicGame.DungeonID);
            if (dynamicGame.RaidUID > 0)
            {
                SetField(gameData, "m_RaidUID", dynamicGame.RaidUID);
            }
            ApplyRaidDifficulty(gameData, dynamicGame);
            SetField(gameData, "m_MapID", dynamicGame.MapID);
            SetField(gameData, "m_TeamASupply", (byte)2);
            SetField(gameData, "m_bBossDungeon", false);
            ApplyGameType(gameData, dynamicGame);
            ApplyBattleConditionIds(gameData, dynamicGame.BattleConditionIds);

            var eventDeckId = data.Stage?.EventDeckId ?? dynamicGame.DungeonID;
            if (ShouldApplyTutorialEventDeckTeamA(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId))
            {
                ApplyTutorialEventDeckTeamA(gameData, eventDeckId);
            }
            else if (ShouldApplyEventDeck(dynamicGame.StageID, dynamicGame.DungeonID, eventDeckId))
            {
                ApplyEventDeckTeamA(gameData, eventDeckId);
                ApplyPlayerDeckFreeSlotsTeamA(
                    gameData,
                    data.Stage?.PlayerDeck,
                    data.Stage?.EventDeckFreeUnitSlots,
                    data.Stage?.EventDeckFreeShipSlot == true,
                    eventDeckId);
            }
            else
            {
                ApplyPlayerDeckTeamA(gameData, data.Stage?.PlayerDeck, dynamicGame.StageID, dynamicGame.DungeonID);
            }
            ApplyPlayerDeckTeamB(gameData, data.Stage?.PlayerDeckB, dynamicGame.StageID, dynamicGame.DungeonID);

            return gameData;
        }

        private object? GetEventDeckTemplet(Type dungeonManagerType, int eventDeckId)
        {
            EnsureEventDeckTablesLoaded(dungeonManagerType);
            var getEventDeck = dungeonManagerType.GetMethod(
                "GetEventDeckTemplet",
                BindingFlags.Public | BindingFlags.Static,
                null,
                [typeof(int)],
                null);
            return getEventDeck?.Invoke(null, [eventDeckId]);
        }

        private void EnsureEventDeckTablesLoaded(Type dungeonManagerType)
        {
            if (eventDeckTablesInitialized) return;
            dungeonManagerType
                .GetMethod("LoadFromLUA_EventDeckInfo", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null)
                ?.Invoke(null, null);
            eventDeckTablesInitialized = true;
        }

        private void ApplyEventDeckShip(object teamA, Type dungeonManagerType, object eventDeckTemplet)
        {
            object? shipSlot = null;
            int unitId = 0;
            int level = 1;
            int skinId = 0;
            int tacticLevel = 0;
            long npcUid = 0;
            try
            {
                shipSlot = GetField(eventDeckTemplet, "ShipSlot");
                if (shipSlot == null) return;

                unitId = Convert.ToInt32(GetField(shipSlot, "m_ID") ?? 0, CultureInfo.InvariantCulture);
                if (unitId <= 0) return;

                level = Convert.ToInt32(GetField(shipSlot, "m_Level") ?? 1, CultureInfo.InvariantCulture);
                skinId = Convert.ToInt32(GetField(shipSlot, "m_SkinID") ?? 0, CultureInfo.InvariantCulture);
                tacticLevel = Convert.ToInt32(GetField(shipSlot, "m_TacticLevel") ?? 0, CultureInfo.InvariantCulture);
                npcUid = Convert.ToInt64(
                    GetType("NKM.NpcUid").GetMethod("Get", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null),
                    CultureInfo.InvariantCulture);

                var makeUnitDataFromId = dungeonManagerType.GetMethod(
                    "MakeUnitDataFromID",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    [typeof(int), typeof(long), typeof(int), typeof(int), typeof(int), typeof(int), typeof(int), typeof(int)],
                    null);
                var ship = makeUnitDataFromId?.Invoke(null, [unitId, npcUid, level, -1, skinId, tacticLevel, -1, -1])
                    ?? CreateBasicTutorialUnit(unitId, npcUid, level, skinId, tacticLevel);
                if (ship != null)
                {
                    SetField(teamA, "m_MainShip", ship);
                }
            }
            catch
            {
                if (unitId <= 0 || npcUid <= 0) return;
                // If local ship limit-break tables are incomplete, build just
                // the serialized unit shell the client needs for game load.
                var ship = CreateBasicTutorialUnit(unitId, npcUid, level, skinId, tacticLevel);
                SetField(teamA, "m_MainShip", ship);
            }
        }

        private object CreateBasicTutorialUnit(int unitId, long unitUid, int level, int skinId, int tacticLevel)
        {
            return CreateBasicUnit(unitId, unitUid, level, skinId, tacticLevel, 0, 0, null, null);
        }

        private object CreateBasicUnit(
            int unitId,
            long unitUid,
            int level,
            int skinId,
            int tacticLevel,
            int limitBreakLevel,
            long userUid,
            IEnumerable<int>? skillLevels,
            IEnumerable<long>? equipItemUids)
        {
            var unit = Create("NKM.NKMUnitData");
            if (userUid > 0) SetField(unit, "m_UserUID", userUid);
            SetField(unit, "m_UnitID", unitId);
            SetField(unit, "m_UnitUID", unitUid);
            SetField(unit, "m_UnitLevel", level);
            SetField(unit, "m_SkinID", skinId);
            SetField(unit, "m_LimitBreakLevel", Math.Max(0, limitBreakLevel));
            SetField(unit, "m_bLock", false);
            SetField(unit, "tacticLevel", tacticLevel);
            FindMethodByName(unit.GetType(), "FillSkillLevelByUnitID")?.Invoke(unit, [unitId]);

            if (skillLevels != null)
            {
                var skills = skillLevels.Take(5).Select(value => Math.Max(0, value)).ToArray();
                if (skills.Length < 5) skills = skills.Concat(Enumerable.Repeat(1, 5 - skills.Length)).ToArray();
                SetField(unit, "m_aUnitSkillLevel", skills);
            }

            if (equipItemUids != null)
            {
                SetField(unit, "m_EquipItemList", NormalizeEquipItemUidArray(equipItemUids));
            }
            return unit;
        }

        private void PopulatePlayerDeckEquipItems(object teamA, PlayerDeckData playerDeck)
        {
            var dictionary = GetField(teamA, "m_ItemEquipData");
            if (dictionary == null) return;

            foreach (var equipData in playerDeck.EquipItems ?? Enumerable.Empty<PlayerEquipItemData>())
            {
                var equipUid = ParseLong(equipData.EquipUid);
                if (equipUid <= 0 || equipData.ItemEquipId <= 0) continue;
                SetDictionaryItem(dictionary, equipUid, CreateEquipItem(equipData));
            }
        }

        private object CreateEquipItem(PlayerEquipItemData data)
        {
            var equip = Create("NKM.NKMEquipItemData");
            SetField(equip, "m_ItemUid", ParseLong(data.EquipUid));
            SetField(equip, "m_ItemEquipID", data.ItemEquipId);
            SetField(equip, "m_EnchantLevel", Math.Max(0, data.EnchantLevel));
            SetField(equip, "m_EnchantExp", Math.Max(0, data.EnchantExp));
            SetField(equip, "m_OwnerUnitUID", ParseLong(data.OwnerUnitUid));
            SetField(equip, "m_bLock", data.Locked);
            SetField(equip, "m_Precision", data.Precision);
            SetField(equip, "m_Precision2", data.Precision2);
            SetField(equip, "m_SetOptionId", data.SetOptionId);
            SetField(equip, "m_ImprintUnitId", data.ImprintUnitId);

            ClearCollectionField(equip, "m_Stat");
            var stats = GetField(equip, "m_Stat");
            foreach (var statData in data.Stats ?? Enumerable.Empty<PlayerEquipStatData>())
            {
                AddCollectionItem(stats, CreateEquipItemStat(statData));
            }

            ClearCollectionField(equip, "potentialOptions");
            var potentialOptions = GetField(equip, "potentialOptions");
            foreach (var optionData in data.PotentialOptions ?? Enumerable.Empty<PlayerPotentialOptionData>())
            {
                AddCollectionItem(potentialOptions, CreatePotentialOption(optionData));
            }

            return equip;
        }

        private object CreateEquipItemStat(PlayerEquipStatData data)
        {
            var stat = Create("NKM.EQUIP_ITEM_STAT");
            SetField(stat, "type", ParseStatType(data.Type));
            SetField(stat, "stat_value", data.Value);
            SetField(stat, "stat_level_value", data.LevelValue);
            return stat;
        }

        private object CreatePotentialOption(PlayerPotentialOptionData data)
        {
            var option = Create("NKM.NKMPotentialOption");
            SetField(option, "optionKey", data.OptionKey);
            SetField(option, "statType", ParseStatType(data.StatType));
            SetField(option, "precisionChangeCount", Math.Max(0, data.PrecisionChangeCount));

            if (GetField(option, "sockets") is Array sockets)
            {
                var socketDataList = data.Sockets ?? [];
                var socketCount = Math.Min(sockets.Length, socketDataList.Count);
                for (var index = 0; index < socketCount; index += 1)
                {
                    var socketData = socketDataList[index];
                    sockets.SetValue(socketData == null ? null : CreatePotentialSocket(socketData), index);
                }
            }

            return option;
        }

        private object CreatePotentialSocket(PlayerPotentialSocketData data)
        {
            var socket = Create("NKM.NKMPotentialOption+SocketData");
            SetField(socket, "statValue", data.StatValue);
            SetField(socket, "precision", data.Precision);
            return socket;
        }

        private object ParseStatType(string? value)
        {
            var statType = GetType("NKM.NKM_STAT_TYPE");
            var text = string.IsNullOrWhiteSpace(value) ? "NST_RANDOM" : value.Trim();
            return Enum.TryParse(statType, text, false, out var parsed)
                ? parsed!
                : Enum.Parse(statType, "NST_RANDOM");
        }

        private static HashSet<long> GetPlayerDeckEquipUidSet(PlayerDeckData playerDeck)
        {
            return (playerDeck.EquipItems ?? [])
                .Select(item => ParseLong(item.EquipUid))
                .Where(uid => uid > 0)
                .ToHashSet();
        }

        private static IEnumerable<long> GetValidUnitEquipItemUids(PlayerUnitData unitData, HashSet<long> validEquipItemUids)
        {
            return NormalizeEquipItemUidArray(
                unitData.EquipItemUids
                    .Select(ParseLong)
                    .Select(uid => uid > 0 && validEquipItemUids.Contains(uid) ? uid : 0L));
        }

        private static long[] NormalizeEquipItemUidArray(IEnumerable<long>? equipItemUids)
        {
            var normalized = new long[4];
            if (equipItemUids == null) return normalized;

            var index = 0;
            foreach (var equipUid in equipItemUids)
            {
                if (index >= normalized.Length) break;
                normalized[index] = Math.Max(0L, equipUid);
                index += 1;
            }

            return normalized;
        }

        private void ApplyEventDeckUnits(object teamA, Type dungeonManagerType, object eventDeckTemplet)
        {
            var armyData = Create("NKM.NKMArmyData");
            var eventDeckData = Create("NKM.NKMEventDeckData");
            var inventoryData = Create("NKM.NKMInventoryData");
            var teamType = GetType("NKM.NKM_TEAM_TYPE");
            var teamA1 = Enum.Parse(teamType, "NTT_A1");

            var makeUnits = dungeonManagerType.GetMethod(
                "MakeEventDeckUnitDataList",
                BindingFlags.Public | BindingFlags.Static,
                null,
                [
                    GetType("NKM.NKMArmyData"),
                    eventDeckTemplet.GetType(),
                    GetType("NKM.NKMDeckCondition"),
                    eventDeckData.GetType(),
                    inventoryData.GetType(),
                    teamType,
                    typeof(bool)
                ],
                null);
            var gameUnitDataList = makeUnits?.Invoke(null, [armyData, eventDeckTemplet, null, eventDeckData, inventoryData, teamA1, false]);
            var unitList = GetField(teamA, "m_listUnitData");
            unitList?.GetType().GetMethod("Clear", BindingFlags.Public | BindingFlags.Instance)?.Invoke(unitList, null);

            long firstUnitUid = 0;
            var addedUnits = 0;
            if (gameUnitDataList is IEnumerable units)
            {
                var add = unitList?.GetType().GetMethod("Add", BindingFlags.Public | BindingFlags.Instance);
                foreach (var gameUnitData in units)
                {
                    var unit = GetField(gameUnitData, "unit");
                    if (unit == null) continue;
                    add?.Invoke(unitList, [unit]);
                    addedUnits++;
                    if (firstUnitUid == 0)
                    {
                        firstUnitUid = Convert.ToInt64(GetField(unit, "m_UnitUID"), CultureInfo.InvariantCulture);
                    }
                }
            }

            if (addedUnits == 0)
            {
                firstUnitUid = AddFallbackEventDeckUnits(unitList, eventDeckTemplet);
            }

            if (firstUnitUid > 0)
            {
                SetField(teamA, "m_LeaderUnitUID", firstUnitUid);
            }
        }

        private long AddFallbackEventDeckUnits(object? unitList, object eventDeckTemplet)
        {
            if (unitList == null) return 0;
            var getUnitSlot = eventDeckTemplet.GetType().GetMethod(
                "GetUnitSlot",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                [typeof(int)],
                null);
            if (getUnitSlot == null) return 0;

            long firstUnitUid = 0;
            for (var slotIndex = 0; slotIndex < 8; slotIndex++)
            {
                var slot = getUnitSlot.Invoke(eventDeckTemplet, [slotIndex]);
                if (slot == null) continue;
                var slotType = GetField(slot, "m_eType")?.ToString() ?? "";
                if (!EventDeckSlotCanSynthesizeUnit(slotType)) continue;

                var unitId = Convert.ToInt32(GetField(slot, "m_ID") ?? 0, CultureInfo.InvariantCulture);
                if (unitId <= 0) continue;

                var level = Math.Max(1, Convert.ToInt32(GetField(slot, "m_Level") ?? 1, CultureInfo.InvariantCulture));
                var skinId = Convert.ToInt32(GetField(slot, "m_SkinID") ?? 0, CultureInfo.InvariantCulture);
                var tacticLevel = Math.Max(0, Convert.ToInt32(GetField(slot, "m_TacticLevel") ?? 0, CultureInfo.InvariantCulture));
                var npcUid = Convert.ToInt64(
                    GetType("NKM.NpcUid").GetMethod("Get", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null),
                    CultureInfo.InvariantCulture);
                if (npcUid <= 0) continue;

                var unit = CreateBasicTutorialUnit(unitId, npcUid, level, skinId, tacticLevel);
                AddCollectionItem(unitList, unit);
                if (firstUnitUid <= 0) firstUnitUid = npcUid;
            }
            return firstUnitUid;
        }

        private void RefreshTeamDeck(object gameData, object teamData, bool resetDeck)
        {
            EnsureLeaderUnitUid(teamData);
            if (resetDeck)
            {
                var deckData = GetField(teamData, "m_DeckData");
                deckData?.GetType()
                    .GetMethod("Init", BindingFlags.Public | BindingFlags.Instance)
                    ?.Invoke(deckData, null);
            }

            var shuffle = gameData.GetType().GetMethod(
                "DoNotShuffleDeck",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                [teamData.GetType()],
                null);
            shuffle?.Invoke(gameData, [teamData]);

            try
            {
                gameData.GetType()
                    .GetMethod("InitRespawnLimitCount", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null)
                    ?.Invoke(gameData, null);
            }
            catch
            {
                // Respawn limits are optional per-unit bookkeeping. If a locally
                // synthesized roster entry cannot resolve that table, keep the
                // GAME_LOAD_ACK usable instead of falling back to a stale capture.
            }
        }

        private void EnsureLeaderUnitUid(object teamData)
        {
            var leader = Convert.ToInt64(GetField(teamData, "m_LeaderUnitUID") ?? 0, CultureInfo.InvariantCulture);
            if (leader > 0) return;

            var firstUnitUid = GetFirstUnitUid(teamData);
            if (firstUnitUid > 0)
            {
                SetField(teamData, "m_LeaderUnitUID", firstUnitUid);
            }
        }

        private long GetFirstUnitUid(object teamData)
        {
            if (GetField(teamData, "m_listUnitData") is not IEnumerable units) return 0;
            foreach (var unit in units)
            {
                if (unit == null) continue;
                var unitUid = Convert.ToInt64(GetField(unit, "m_UnitUID") ?? 0, CultureInfo.InvariantCulture);
                if (unitUid > 0) return unitUid;
            }
            return 0;
        }

        public void SuppressPlayerDynamicRespawns(object server, object gameData)
        {
            // Tutorial event decks can carry preloaded summon pools that
            // materialize as setup artifacts in the local bridge. Normal
            // combat must keep these pools: NKMEventRespawn uses them for
            // skill/passive summons such as Karin's summon and Kyle's wall.
            var teamA = GetField(gameData, "m_NKMGameTeamDataA");
            if (teamA != null)
            {
                ClearCollectionField(teamA, "m_listDynamicRespawnUnitData");
            }

            ClearPlayerUnitDynamicRespawnPools(server, "m_dicNKMUnitPool");
            ClearPlayerUnitDynamicRespawnPools(server, "m_dicNKMUnit");
        }

        public bool TryApplyDungeonGameTeamData(object gameData, object? runtimeData, out string? error)
        {
            error = null;
            if (runtimeData == null)
            {
                error = "missing NKMGameRuntimeData";
                return false;
            }

            try
            {
                var dungeonId = Convert.ToInt32(GetField(gameData, "m_DungeonID"), CultureInfo.InvariantCulture);
                if (dungeonId <= 0)
                {
                    return true;
                }

                var dungeonManagerType = GetType("NKM.NKMDungeonManager");
                var method = dungeonManagerType.GetMethod(
                    "MakeGameTeamData",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    [gameData.GetType(), runtimeData.GetType()],
                    null);
                if (method == null)
                {
                    error = "NKMDungeonManager.MakeGameTeamData not found";
                    return false;
                }

                var ok = Convert.ToBoolean(method.Invoke(null, [gameData, runtimeData]), CultureInfo.InvariantCulture);
                if (!ok)
                {
                    error = $"NKMDungeonManager.MakeGameTeamData returned false for dungeonID={dungeonId}";
                }
                return ok;
            }
            catch (Exception ex)
            {
                error = ex.ToString();
                return false;
            }
        }

        private void ClearTeamRuntimeUnitIds(object teamData)
        {
            ClearUnitRuntimeIds(GetField(teamData, "m_MainShip"));
            foreach (var listField in new[]
            {
                "m_listUnitData",
                "m_listAssistUnitData",
                "m_listEvevtUnitData",
                "m_listEnvUnitData",
                "m_listOperatorUnitData"
            })
            {
                if (GetField(teamData, listField) is not IEnumerable units) continue;
                foreach (var unit in units)
                {
                    ClearUnitRuntimeIds(unit);
                }
            }

            if (GetField(teamData, "m_listDynamicRespawnUnitData") is not IEnumerable dynamicUnits) return;
            foreach (var dynamicUnit in dynamicUnits)
            {
                if (dynamicUnit == null) continue;
                ClearUnitRuntimeIds(GetField(dynamicUnit, "m_NKMUnitData") ?? dynamicUnit);
            }
        }

        private void ClearUnitRuntimeIds(object? unitData)
        {
            if (unitData == null) return;
            ClearCollectionField(unitData, "m_listGameUnitUID");
            ClearCollectionField(unitData, "m_listNearTargetRange");
        }

        private void ClearCollectionField(object target, string fieldName)
        {
            var collection = GetField(target, fieldName);
            collection?.GetType().GetMethod("Clear", BindingFlags.Public | BindingFlags.Instance)?.Invoke(collection, null);
        }

        private static void AddCollectionItem(object? collection, object item)
        {
            collection?.GetType().GetMethod("Add", BindingFlags.Public | BindingFlags.Instance)?.Invoke(collection, [item]);
        }

        private static void SetDictionaryItem(object? dictionary, object key, object value)
        {
            if (dictionary is IDictionary values)
            {
                values[key] = value;
                return;
            }

            dictionary?.GetType()
                .GetProperty("Item", BindingFlags.Public | BindingFlags.Instance)
                ?.SetValue(dictionary, value, [key]);
        }

        private static long ParseLong(string? value)
        {
            return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
        }

        private void ClearPlayerUnitDynamicRespawnPools(object server, string unitDictionaryFieldName)
        {
            if (GetField(server, unitDictionaryFieldName) is not IDictionary units) return;

            foreach (DictionaryEntry entry in units)
            {
                var unit = entry.Value;
                if (unit == null || !IsPlayerTeamUnit(unit)) continue;
                ClearCollectionField(unit, "m_dicDynamicRespawnPool");
                ClearCollectionField(unit, "m_dicUnitChangeRespawnPool");
            }
        }

        private static bool IsPlayerTeamUnit(object unit)
        {
            var method = unit.GetType().GetMethod("IsATeam", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            return method != null && Convert.ToBoolean(method.Invoke(unit, null), CultureInfo.InvariantCulture);
        }

        public Type GetType(string typeName)
        {
            return assembly.GetType(typeName, throwOnError: true)!;
        }

        public MethodInfo GetMethod(Type owner, string name, params Type[] parameterTypes)
        {
            var method = FindMethod(owner, name, parameterTypes);
            if (method == null)
            {
                throw new MissingMethodException(owner.FullName, name);
            }
            return method;
        }

        public object? Invoke(object target, string methodName, params object?[] args)
        {
            var parameterTypes = args.Select(arg => arg?.GetType() ?? typeof(object)).ToArray();
            var method = FindMethod(target.GetType(), methodName, parameterTypes) ?? FindMethodByName(target.GetType(), methodName);
            if (method == null)
            {
                throw new MissingMethodException(target.GetType().FullName, methodName);
            }
            return method.Invoke(target, args);
        }

        public object DeserializePacket(int packetId, byte[] payload)
        {
            var packet = packetCreate.Invoke(packetController, [Convert.ToUInt16(packetId)])!;
            var reader = packetReaderCtor.Invoke([payload]);
            try
            {
                packetReaderGetWithoutNullBit.Invoke(reader, [packet]);
                return packet;
            }
            finally
            {
                (reader as IDisposable)?.Dispose();
            }
        }

        public HostPacket SerializePacket(object packet, int fallbackPacketId, string label)
        {
            var id = Convert.ToInt32(packetGetId.Invoke(packetController, [packet]), CultureInfo.InvariantCulture);
            if (id <= 0 || id == ushort.MaxValue) id = fallbackPacketId;
            var zeroCopy = packetWriterToBufferWithoutNullBit.Invoke(null, [packet])!;
            var base64 = ZeroCopyToBase64(zeroCopy);
            return new HostPacket
            {
                PacketId = id,
                Label = label,
                PayloadBase64 = base64
            };
        }

        public HostPacket BuildGameLoadAck(object gameData)
        {
            var packet = Create("ClientPacket.Game.NKMPacket_GAME_LOAD_ACK");
            SetField(packet, "errorCode", 0);
            SetField(packet, "gameData", gameData);
            return SerializePacket(packet, GameLoadAck, "managed-game-load");
        }

        public string DescribeGameLoadAck(object packet)
        {
            var gameData = GetField(packet, "gameData");
            if (gameData == null) return "gameData=null";

            var lines = new List<string>
            {
                $"errorCode={GetField(packet, "errorCode")}",
                $"gameUID={GetField(gameData, "m_GameUID")} gameUnitUIDIndex={GetField(gameData, "m_GameUnitUIDIndex")} local={GetField(gameData, "m_bLocal")}",
                $"gameType={GetField(gameData, "m_NKM_GAME_TYPE")} dungeonID={GetField(gameData, "m_DungeonID")} raidUID={GetField(gameData, "m_RaidUID")} mapID={GetField(gameData, "m_MapID")} teamASupply={GetField(gameData, "m_TeamASupply")} teamBLevelFix={GetField(gameData, "m_TeamBLevelFix")} doubleCostTime={GetField(gameData, "m_fDoubleCostTime")}",
                $"teamA={DescribeTeam(GetField(gameData, "m_NKMGameTeamDataA"))}",
                $"teamB={DescribeTeam(GetField(gameData, "m_NKMGameTeamDataB"))}"
            };
            return string.Join(Environment.NewLine, lines);
        }

        public void ApplyRaidDifficulty(object gameData, DynamicGameState dynamicGame)
        {
            if (dynamicGame.RaidUID <= 0 || dynamicGame.RaidLevel <= 0) return;
            var gameType = dynamicGame.GameType;
            if (gameType != 8 && gameType != 12) return;
            SetField(gameData, "m_TeamBLevelFix", dynamicGame.RaidLevel);
            SetField(gameData, "m_TeamBLevelAdd", 0);
        }

        public string DescribeGameSync(object packet)
        {
            var pack = GetField(packet, "gameSyncDataPack");
            var syncItems = pack == null ? null : GetField(pack, "m_listGameSyncData");
            var lines = new List<string>
            {
                $"packetGameTime={GetField(packet, "gameTime")} absolute={GetField(packet, "absoluteGameTime")} simulation={GetField(packet, "simulationGame")}",
                $"baseCount={CountCollection(syncItems)}"
            };

            if (syncItems is IEnumerable enumerable)
            {
                var index = 0;
                foreach (var syncBase in enumerable.Cast<object>())
                {
                    lines.Add($"base[{index}] {DescribeSyncBase(syncBase)}");
                    index += 1;
                    if (index >= 8) break;
                }
            }

            return string.Join(Environment.NewLine, lines);
        }

        public string DescribeGameLoadCompleteAck(object packet)
        {
            var runtimeData = GetField(packet, "gameRuntimeData");
            return string.Join(Environment.NewLine, new[]
            {
                $"errorCode={GetField(packet, "errorCode")} isIntrude={GetField(packet, "isIntrude")} rewardMultiply={GetField(packet, "rewardMultiply")}",
                DescribeRuntimeData(runtimeData)
            });
        }

        public string DescribePrivatePvpLobby(object packet)
        {
            var lobby = GetField(packet, "lobbyState") ?? GetField(packet, "lobbyData");
            return $"state={GetField(lobby!, "lobbyState")} observerMode={GetField(lobby!, "isObserverMode")} config={DescribeObjectFields(GetField(lobby!, "config"))} users={DescribePrivatePvpUsers(GetField(lobby!, "users"))} observers={DescribePrivatePvpUsers(GetField(lobby!, "observers"))} code={GetField(lobby!, "lobbyCode")}";
        }

        private string DescribePrivatePvpUsers(object? value)
        {
            if (value is not IEnumerable users) return "0[]";
            var entries = users.Cast<object?>().Select(user =>
            {
                if (user == null) return "null";
                var profile = GetField(GetField(user, "profileData")!, "commonProfile");
                return $"uid={GetField(profile!, "userUid")},friend={GetField(profile!, "friendCode")},ready={GetField(user, "isReady")},host={GetField(user, "isHost")},state={GetField(user, "playerState")}";
            }).ToList();
            return $"{entries.Count}[{string.Join(";", entries)}]";
        }

        public string DescribeJoinLobbyAck(object packet)
        {
            var lines = new List<string>
            {
                $"packet={packet.GetType().FullName}",
                $"errorCode={GetField(packet, "errorCode")} friendCode={GetField(packet, "friendCode")} reconnectKey={GetField(packet, "reconnectKey")}",
                $"topLevel={DescribeObjectFields(packet, "userData")}",
                $"userData={DescribeObjectFields(GetField(packet, "userData"))}"
            };

            var userData = GetField(packet, "userData");
            if (userData != null)
            {
                lines.Add($"inventory={DescribeObjectFields(GetField(userData, "m_InventoryData"))}");
                lines.Add($"army={DescribeObjectFields(GetField(userData, "m_ArmyData"))}");
                lines.Add($"mission={DescribeObjectFields(GetField(userData, "m_MissionData"))}");
                lines.Add($"shop={DescribeObjectFields(GetField(userData, "m_ShopData"))}");
            }

            lines.Add($"intervalSample={DescribeIntervals(GetField(packet, "intervalData"), 16)}");
            return string.Join(Environment.NewLine, lines);
        }

        public OfficialProfileSnapshot ExportJoinLobbyProfile(object packet)
        {
            var userData = Field(packet, "userData");
            var userProfile = Field(packet, "userProfileData");
            var commonProfile = Field(userProfile, "commonProfile");
            var profile = new OfficialProfileSnapshot
            {
                UserUid = ToLongString(Prefer(Field(userData, "m_UserUID"), Field(commonProfile, "userUid"))),
                FriendCode = ToLongString(Prefer(Field(userData, "m_FriendCode"), Field(packet, "friendCode"), Field(commonProfile, "friendCode"))),
                Nickname = ToText(Prefer(Field(userData, "m_UserNickName"), Field(commonProfile, "nickname"), "OfficialProfile")),
                Level = Math.Max(1, ToInt(Prefer(Field(userData, "m_UserLevel"), Field(commonProfile, "level"), 1), 1)),
                Exp = ToLongString(Field(userData, "m_lUserLevelEXP")),
                AuthLevel = Math.Max(1, ToInt(Field(userData, "m_eAuthLevel"), 1)),
                FriendIntro = ToText(Field(userProfile, "friendIntro")),
                MainUnitId = ToInt(Field(commonProfile, "mainUnitId")),
                MainUnitSkinId = ToInt(Field(commonProfile, "mainUnitSkinId")),
                MainUnitTacticLevel = ToInt(Field(commonProfile, "mainUnitTacticLevel")),
                FrameId = ToInt(Field(commonProfile, "frameId")),
                SelfiFrameId = ToInt(Field(userProfile, "selfiFrameId")),
                TitleId = ToInt(Field(commonProfile, "titleId")),
                UnlockedStageIds = ExportIntList(Field(packet, "unlockedStageIds")),
                ProfileEmblems = ExportProfileEmblems(Field(userProfile, "emblems")),
                Inventory = ExportInventory(Field(userData, "m_InventoryData")),
                Army = ExportArmy(Field(userData, "m_ArmyData")),
                StagePlayData = ExportStagePlayData(Field(packet, "stagePlayDataList")),
                DungeonClear = ExportDungeonClear(Field(userData, "m_dicNKMDungeonClearData")),
                OfficialSnapshot = ExportJoinLobbySnapshot(packet),
            };

            profile.OfficialImport["packetType"] = packet.GetType().FullName ?? "";
            profile.OfficialImport["capturedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            profile.OfficialImport["source"] = "join_lobby_ack";
            return profile;
        }

        private Dictionary<string, object?> ExportJoinLobbySnapshot(object packet)
        {
            var capturedAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            var snapshot = new Dictionary<string, object?>
            {
                ["schemaVersion"] = 1,
                ["packetType"] = packet.GetType().FullName ?? "",
                ["capturedAt"] = capturedAt,
            };

            var packetContext = new ManagedJsonExportContext();
            snapshot["packet"] = ExportManagedJsonValue(packet, packetContext, 0);

            // Duplicate the high-value roots at predictable names so the Node importer
            // does not need to know every official packet nesting variant.
            var userData = Field(packet, "userData");
            var userDataContext = new ManagedJsonExportContext();
            snapshot["userData"] = ExportManagedJsonValue(userData, userDataContext, 0);

            var profileContext = new ManagedJsonExportContext();
            snapshot["userProfileData"] = ExportManagedJsonValue(Field(packet, "userProfileData"), profileContext, 0);

            var officeContext = new ManagedJsonExportContext();
            snapshot["officeState"] = ExportManagedJsonValue(Field(packet, "officeState"), officeContext, 0);

            var lobbyContext = new ManagedJsonExportContext();
            snapshot["backGroundInfo"] = ExportManagedJsonValue(Prefer(Field(userData, "backGroundInfo"), Field(packet, "backGroundInfo")), lobbyContext, 0);

            var intervalContext = new ManagedJsonExportContext(maxDepth: 6);
            snapshot["intervalData"] = ExportManagedJsonValue(Field(packet, "intervalData"), intervalContext, 0);

            return snapshot;
        }

        private static object? ExportManagedJsonValue(object? value, ManagedJsonExportContext context, int depth)
        {
            if (value == null) return null;
            if (value is string text) return text;
            if (value is char character) return character.ToString();
            if (value is bool) return value;
            if (value is byte or sbyte or short or ushort or int or uint or float or double or decimal) return value;
            if (value is long or ulong) return Convert.ToString(value, CultureInfo.InvariantCulture);
            if (value is DateTime dateTime) return dateTime == DateTime.MinValue ? "0" : dateTime.ToString("O", CultureInfo.InvariantCulture);
            if (value is DateTimeOffset dateTimeOffset) return dateTimeOffset.ToString("O", CultureInfo.InvariantCulture);
            if (value is TimeSpan timeSpan) return timeSpan.ToString("c", CultureInfo.InvariantCulture);
            if (value is Guid guid) return guid.ToString("D", CultureInfo.InvariantCulture);
            if (value is byte[] bytes) return Convert.ToBase64String(bytes);

            var type = value.GetType();
            if (type.IsEnum) return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            if (depth >= context.MaxDepth)
            {
                return new Dictionary<string, object?>
                {
                    ["$type"] = type.FullName ?? type.Name,
                    ["$summary"] = SummarizeValue(value),
                    ["$truncated"] = "maxDepth"
                };
            }

            var shouldTrackReference = !type.IsValueType;
            if (shouldTrackReference && !context.Visiting.Add(value))
            {
                return new Dictionary<string, object?>
                {
                    ["$type"] = type.FullName ?? type.Name,
                    ["$summary"] = SummarizeValue(value),
                    ["$circular"] = true
                };
            }

            try
            {
                if (value is IDictionary dictionary)
                {
                    var output = new Dictionary<string, object?>(StringComparer.Ordinal);
                    var index = 0;
                    foreach (DictionaryEntry entry in dictionary)
                    {
                        if (index >= context.MaxCollectionItems)
                        {
                            output["$truncated"] = dictionary.Count > context.MaxCollectionItems
                                ? $"items:{dictionary.Count - context.MaxCollectionItems}"
                                : "items";
                            break;
                        }

                        var key = Convert.ToString(entry.Key, CultureInfo.InvariantCulture);
                        if (string.IsNullOrEmpty(key)) key = $"item{index.ToString(CultureInfo.InvariantCulture)}";
                        output[key] = ExportManagedJsonValue(entry.Value, context, depth + 1);
                        index += 1;
                    }
                    return output;
                }

                if (value is IEnumerable enumerable && value is not string)
                {
                    var output = new List<object?>();
                    var index = 0;
                    foreach (var item in enumerable)
                    {
                        if (index >= context.MaxCollectionItems)
                        {
                            output.Add(new Dictionary<string, object?>
                            {
                                ["$truncated"] = "items",
                                ["$summary"] = SummarizeValue(value)
                            });
                            break;
                        }

                        output.Add(ExportManagedJsonValue(item, context, depth + 1));
                        index += 1;
                    }
                    return output;
                }

                var fields = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["$type"] = type.FullName ?? type.Name
                };
                var fieldCount = 0;
                foreach (var field in GetAllInstanceFields(type))
                {
                    if (fieldCount >= context.MaxObjectFields)
                    {
                        fields["$truncated"] = "fields";
                        break;
                    }

                    try
                    {
                        fields[field.Name] = ExportManagedJsonValue(field.GetValue(value), context, depth + 1);
                    }
                    catch (Exception ex)
                    {
                        fields[field.Name] = new Dictionary<string, object?>
                        {
                            ["$error"] = ex.GetType().Name
                        };
                    }

                    fieldCount += 1;
                }

                return fields;
            }
            finally
            {
                if (shouldTrackReference) context.Visiting.Remove(value);
            }
        }

        private sealed class ManagedJsonExportContext
        {
            public ManagedJsonExportContext(int maxDepth = 16, int maxCollectionItems = 50000, int maxObjectFields = 512)
            {
                MaxDepth = maxDepth;
                MaxCollectionItems = maxCollectionItems;
                MaxObjectFields = maxObjectFields;
            }

            public int MaxDepth { get; }
            public int MaxCollectionItems { get; }
            public int MaxObjectFields { get; }
            public HashSet<object> Visiting { get; } = new(new ReferenceEqualityComparer());
        }

        private sealed class ReferenceEqualityComparer : IEqualityComparer<object>
        {
            public new bool Equals(object? left, object? right) => ReferenceEquals(left, right);

            public int GetHashCode(object value) => RuntimeHelpers.GetHashCode(value);
        }

        private OfficialInventorySnapshot ExportInventory(object? inventory)
        {
            var output = new OfficialInventorySnapshot();
            foreach (var item in DictionaryValues(Field(inventory, "m_ItemMiscData")))
            {
                var itemId = ToInt(Field(item, "m_ItemMiscID"));
                if (itemId <= 0) itemId = ToInt(Field(item, "ItemID"));
                if (itemId <= 0) continue;
                output.Misc[itemId.ToString(CultureInfo.InvariantCulture)] = new OfficialMiscItemSnapshot
                {
                    ItemId = itemId,
                    CountFree = ToLongString(Field(item, "m_CountFree")),
                    CountPaid = ToLongString(Field(item, "m_CountPaid")),
                    BonusRatio = ToInt(Field(item, "BonusRatio")),
                    RegDate = DateBinaryString(Field(item, "m_RegDate")),
                };
            }

            foreach (var equip in DictionaryValues(Field(inventory, "m_ItemEquipData")))
            {
                var converted = ExportEquip(equip);
                if (converted.EquipUid == "0") continue;
                output.Equips[converted.EquipUid] = converted;
            }

            output.Skins = ExportIntList(Field(inventory, "m_ItemSkinData"));
            return output;
        }

        private OfficialArmySnapshot ExportArmy(object? army)
        {
            var output = new OfficialArmySnapshot();
            foreach (var unit in DictionaryValues(Field(army, "m_dicMyUnit")))
            {
                var converted = ExportUnit(unit);
                if (converted.UnitUid != "0") output.Units[converted.UnitUid] = converted;
            }
            foreach (var unit in DictionaryValues(Field(army, "m_dicMyShip")))
            {
                var converted = ExportUnit(unit);
                if (converted.UnitUid != "0") output.Ships[converted.UnitUid] = converted;
            }
            foreach (var unit in DictionaryValues(Field(army, "m_dicMyTrophy")))
            {
                var converted = ExportUnit(unit);
                if (converted.UnitUid != "0") output.Trophies[converted.UnitUid] = converted;
            }
            foreach (var item in DictionaryValues(Field(army, "m_dicMyOperator")))
            {
                var converted = ExportOperator(item);
                if (converted.Uid != "0") output.Operators[converted.Uid] = converted;
            }

            foreach (var deckSet in EnumerateObjects(Field(army, "deckSets")))
            {
                var deckType = ToInt(Field(deckSet, "type"));
                var decks = new List<OfficialDeckSnapshot>();
                foreach (var deck in EnumerateObjects(Field(deckSet, "decks")))
                {
                    decks.Add(ExportDeck(deck, deckType));
                }
                output.DeckSets[deckType.ToString(CultureInfo.InvariantCulture)] = decks;
            }

            return output;
        }

        private OfficialUnitSnapshot ExportUnit(object unit)
        {
            return new OfficialUnitSnapshot
            {
                UnitUid = ToLongString(Field(unit, "m_UnitUID")),
                UserUid = ToLongString(Field(unit, "m_UserUID")),
                UnitId = ToInt(Field(unit, "m_UnitID")),
                Level = Math.Max(1, ToInt(Field(unit, "m_UnitLevel"), 1)),
                Exp = ToInt(Field(unit, "m_iUnitLevelEXP")),
                SkinId = ToInt(Field(unit, "m_SkinID")),
                Injury = ToFloat(Field(unit, "m_fInjury")),
                LimitBreakLevel = ToInt(Field(unit, "m_LimitBreakLevel")),
                Locked = ToBool(Field(unit, "m_bLock")),
                SummonUnit = ToBool(Field(unit, "m_bSummonUnit")),
                StatExp = ExportIntList(Field(unit, "m_listStatEXP")),
                SkillLevels = ExportIntList(Field(unit, "m_aUnitSkillLevel")),
                EquipItemUids = ExportLongStringList(Field(unit, "m_EquipItemList")),
                Loyalty = ToInt(Field(unit, "loyalty")),
                IsPermanentContract = ToBool(Field(unit, "isPermanentContract")),
                IsSeized = ToBool(Field(unit, "isSeized")),
                FromContract = ToBool(Field(unit, "fromContract"), true),
                OfficeRoomId = ToInt(Field(unit, "officeRoomId")),
                RegDate = DateBinaryString(Field(unit, "m_regDate")),
                OfficeGrade = ToInt(Field(unit, "officeGrade")),
                OfficeGaugeStartTime = DateBinaryString(Field(unit, "officeGaugeStartTime")),
                DungeonRespawnUnitTempletUid = ToLongString(Field(unit, "m_DungeonRespawnUnitTempletUID")),
                IsFavorite = ToBool(Field(unit, "isFavorite")),
                ShipCommandModules = ExportShipCommandModules(Field(unit, "ShipCommandModule")),
                TacticLevel = ToInt(Field(unit, "tacticLevel")),
                ReactorLevel = ToInt(Field(unit, "reactorLevel")),
            };
        }

        private OfficialOperatorSnapshot ExportOperator(object item)
        {
            return new OfficialOperatorSnapshot
            {
                Uid = ToLongString(Field(item, "uid")),
                Id = ToInt(Field(item, "id")),
                Level = Math.Max(1, ToInt(Field(item, "level"), 1)),
                Exp = ToInt(Field(item, "exp")),
                Locked = ToBool(Field(item, "bLock")),
                MainSkill = ExportOperatorSkill(Field(item, "mainSkill")),
                SubSkill = ExportOperatorSkill(Field(item, "subSkill")),
                FromContract = ToBool(Field(item, "fromContract"), true),
            };
        }

        private OfficialOperatorSkillSnapshot ExportOperatorSkill(object? skill)
        {
            return new OfficialOperatorSkillSnapshot
            {
                Id = ToInt(Field(skill, "id")),
                Level = Math.Max(1, ToInt(Field(skill, "level"), 1)),
                Exp = ToInt(Field(skill, "exp")),
            };
        }

        private OfficialDeckSnapshot ExportDeck(object deck, int deckType)
        {
            return new OfficialDeckSnapshot
            {
                DeckType = deckType,
                Name = ToText(Field(deck, "m_DeckName")),
                ShipUid = ToLongString(Field(deck, "m_ShipUID")),
                OperatorUid = ToLongString(Field(deck, "m_OperatorUID")),
                UnitUids = ExportLongStringList(Field(deck, "m_listDeckUnitUID")),
                LeaderIndex = ToInt(Field(deck, "m_LeaderIndex"), -1),
                State = ToInt(Field(deck, "m_DeckState")),
            };
        }

        private OfficialEquipItemSnapshot ExportEquip(object item)
        {
            return new OfficialEquipItemSnapshot
            {
                EquipUid = ToLongString(Field(item, "m_ItemUid")),
                ItemEquipId = ToInt(Field(item, "m_ItemEquipID")),
                EnchantLevel = ToInt(Field(item, "m_EnchantLevel")),
                EnchantExp = ToInt(Field(item, "m_EnchantExp")),
                Stats = EnumerateObjects(Field(item, "m_Stat")).Select(ExportEquipStat).ToList(),
                OwnerUnitUid = ToLongString(Field(item, "m_OwnerUnitUID")),
                Locked = ToBool(Field(item, "m_bLock")),
                Precision = ToInt(Field(item, "m_Precision")),
                Precision2 = ToInt(Field(item, "m_Precision2")),
                SetOptionId = ToInt(Field(item, "m_SetOptionId")),
                ImprintUnitId = ToInt(Field(item, "m_ImprintUnitId")),
                PotentialOptions = EnumerateObjects(Field(item, "potentialOptions")).Select(ExportPotentialOption).ToList(),
            };
        }

        private OfficialEquipStatSnapshot ExportEquipStat(object item)
        {
            return new OfficialEquipStatSnapshot
            {
                Type = ToEnumText(Field(item, "type"), "NST_RANDOM"),
                Value = ToFloat(Field(item, "stat_value")),
                LevelValue = ToFloat(Field(item, "stat_level_value")),
            };
        }

        private OfficialPotentialOptionSnapshot ExportPotentialOption(object item)
        {
            return new OfficialPotentialOptionSnapshot
            {
                OptionKey = ToInt(Field(item, "optionKey")),
                StatType = ToEnumText(Field(item, "statType"), "NST_RANDOM"),
                Sockets = EnumerateObjectsAllowNull(Field(item, "sockets")).Select(socket => socket == null ? null : ExportPotentialSocket(socket)).ToList(),
                PrecisionChangeCount = ToInt(Field(item, "precisionChangeCount")),
            };
        }

        private OfficialPotentialSocketSnapshot ExportPotentialSocket(object item)
        {
            return new OfficialPotentialSocketSnapshot
            {
                StatValue = ToFloat(Field(item, "statValue")),
                Precision = ToInt(Field(item, "precision")),
            };
        }

        private List<OfficialShipCommandModuleSnapshot> ExportShipCommandModules(object? modules)
        {
            return EnumerateObjects(modules)
                .Select(module => new OfficialShipCommandModuleSnapshot
                {
                    Slots = EnumerateObjects(Field(module, "slots")).Select(ExportShipCommandSlot).ToList()
                })
                .ToList();
        }

        private OfficialShipCommandSlotSnapshot ExportShipCommandSlot(object slot)
        {
            return new OfficialShipCommandSlotSnapshot
            {
                TargetStyleType = ExportIntList(Field(slot, "targetStyleType")),
                TargetRoleType = ExportIntList(Field(slot, "targetRoleType")),
                StatType = ToEnumText(Field(slot, "statType"), "NST_RANDOM"),
                StatValue = ToFloat(Field(slot, "statValue")),
                IsLock = ToBool(Field(slot, "isLock")),
            };
        }

        private List<OfficialProfileEmblem> ExportProfileEmblems(object? emblems)
        {
            return EnumerateObjects(emblems)
                .Select(item => new OfficialProfileEmblem
                {
                    Id = ToInt(Field(item, "id")),
                    Count = ToLongString(Field(item, "count")),
                })
                .Where(item => item.Id > 0)
                .ToList();
        }

        private Dictionary<string, OfficialStagePlaySnapshot> ExportStagePlayData(object? stagePlayData)
        {
            var output = new Dictionary<string, OfficialStagePlaySnapshot>();
            foreach (var item in EnumerateObjects(stagePlayData))
            {
                var stageId = ToInt(Field(item, "stageId"));
                if (stageId <= 0) continue;
                output[stageId.ToString(CultureInfo.InvariantCulture)] = new OfficialStagePlaySnapshot
                {
                    StageId = stageId,
                    PlayCount = ToLongString(Field(item, "playCount")),
                    RestoreCount = ToLongString(Field(item, "restoreCount")),
                    BestKillCount = ToLongString(Field(item, "bestKillCount")),
                    NextResetDate = DateBinaryString(Field(item, "nextResetDate")),
                    BestClearTimeSec = ToInt(Field(item, "bestClearTimeSec")),
                    TotalPlayCount = ToLongString(Field(item, "totalPlayCount")),
                };
            }
            return output;
        }

        private Dictionary<string, OfficialDungeonClearSnapshot> ExportDungeonClear(object? dungeonClear)
        {
            var output = new Dictionary<string, OfficialDungeonClearSnapshot>();
            foreach (var item in DictionaryValues(dungeonClear))
            {
                var dungeonId = ToInt(Field(item, "dungeonId"));
                if (dungeonId <= 0) continue;
                output[dungeonId.ToString(CultureInfo.InvariantCulture)] = new OfficialDungeonClearSnapshot
                {
                    DungeonId = dungeonId,
                    MissionResult1 = ToBool(Field(item, "missionResult1")),
                    MissionResult2 = ToBool(Field(item, "missionResult2")),
                    MissionRewardResult = ToBool(Field(item, "missionRewardResult")),
                    OnetimeRewardResults = EnumerateObjects(Field(item, "onetimeRewardResults")).Select(value => ToBool(value)).ToList(),
                    UnitExp = ToInt(Field(item, "unitExp")),
                };
            }
            return output;
        }

        public List<IntervalExportRow> ExportJoinLobbyIntervals(object packet)
        {
            var output = new List<IntervalExportRow>();
            if (GetField(packet, "intervalData") is not IEnumerable enumerable) return output;

            var seenStrKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var interval in enumerable.Cast<object>())
            {
                var strKey = Convert.ToString(GetField(interval, "strKey"), CultureInfo.InvariantCulture) ?? "";
                if (string.IsNullOrWhiteSpace(strKey) || !seenStrKeys.Add(strKey)) continue;
                output.Add(new IntervalExportRow
                {
                    Key = Convert.ToInt32(GetField(interval, "key") ?? 0, CultureInfo.InvariantCulture),
                    StrKey = strKey,
                    StartDate = FormatTableDate(GetField(interval, "startDate")),
                    EndDate = FormatTableDate(GetField(interval, "endDate")),
                    RepeatStartDate = Convert.ToInt32(GetField(interval, "repeatStartDate") ?? 0, CultureInfo.InvariantCulture),
                    RepeatEndDate = Convert.ToInt32(GetField(interval, "repeatEndDate") ?? 0, CultureInfo.InvariantCulture),
                });
            }

            return output
                .OrderBy(interval => interval.Key)
                .ThenBy(interval => interval.StrKey, StringComparer.Ordinal)
                .ToList();
        }

        private static string FormatTableDate(object? value)
        {
            if (value is DateTime dateTime && dateTime != DateTime.MinValue)
            {
                return dateTime.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            }

            var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            if (DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed) && parsed != DateTime.MinValue)
            {
                return parsed.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            }

            return "";
        }

        private object? Field(object? target, string fieldName)
        {
            return target == null ? null : GetField(target, fieldName);
        }

        private static object? Prefer(params object?[] values)
        {
            foreach (var value in values)
            {
                if (IsMeaningful(value)) return value;
            }
            return values.FirstOrDefault(value => value != null);
        }

        private static bool IsMeaningful(object? value)
        {
            if (value == null) return false;
            if (value is string text) return !string.IsNullOrWhiteSpace(text);
            if (value is bool) return true;
            if (value.GetType().IsEnum) return Convert.ToInt32(value, CultureInfo.InvariantCulture) != 0;
            try
            {
                if (value is byte or sbyte or short or ushort or int or uint or long or ulong)
                {
                    return Convert.ToInt64(value, CultureInfo.InvariantCulture) != 0L;
                }
            }
            catch
            {
                return true;
            }
            return true;
        }

        private static IEnumerable<object> DictionaryValues(object? source)
        {
            if (source is not IDictionary dictionary) yield break;
            foreach (DictionaryEntry entry in dictionary)
            {
                if (entry.Value != null) yield return entry.Value;
            }
        }

        private static IEnumerable<object> EnumerateObjects(object? source)
        {
            if (source == null || source is string) yield break;
            if (source is IEnumerable enumerable)
            {
                foreach (var item in enumerable)
                {
                    if (item != null) yield return item;
                }
            }
        }

        private static IEnumerable<object?> EnumerateObjectsAllowNull(object? source)
        {
            if (source == null || source is string) yield break;
            if (source is IEnumerable enumerable)
            {
                foreach (var item in enumerable) yield return item;
            }
        }

        private static List<int> ExportIntList(object? source)
        {
            return EnumerateObjects(source).Select(value => ToInt(value)).ToList();
        }

        private static List<string> ExportLongStringList(object? source)
        {
            return EnumerateObjects(source).Select(value => ToLongString(value)).ToList();
        }

        private static string ToText(object? value, string fallback = "")
        {
            return value == null ? fallback : Convert.ToString(value, CultureInfo.InvariantCulture) ?? fallback;
        }

        private static string ToLongString(object? value, string fallback = "0")
        {
            try
            {
                if (value == null) return fallback;
                if (value.GetType().IsEnum) return Convert.ToInt64(value).ToString(CultureInfo.InvariantCulture);
                return Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            }
            catch
            {
                var text = Convert.ToString(value, CultureInfo.InvariantCulture);
                return string.IsNullOrWhiteSpace(text) ? fallback : text;
            }
        }

        private static int ToInt(object? value, int fallback = 0)
        {
            try
            {
                if (value == null) return fallback;
                if (value.GetType().IsEnum) return Convert.ToInt32(value);
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        private static float ToFloat(object? value, float fallback = 0f)
        {
            try
            {
                if (value == null) return fallback;
                return Convert.ToSingle(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        private static bool ToBool(object? value, bool fallback = false)
        {
            try
            {
                if (value == null) return fallback;
                if (value.GetType().IsEnum) return Convert.ToInt64(value) != 0L;
                return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        private static string DateBinaryString(object? value)
        {
            if (value is DateTime dateTime && dateTime != DateTime.MinValue)
            {
                return dateTime.ToBinary().ToString(CultureInfo.InvariantCulture);
            }
            return ToLongString(value);
        }

        private static string ToEnumText(object? value, string fallback = "")
        {
            var text = ToText(value, fallback);
            return string.IsNullOrWhiteSpace(text) ? fallback : text;
        }

        private string DescribeRuntimeData(object? runtimeData)
        {
            if (runtimeData == null) return "runtime=null";
            return string.Join(" ", new[]
            {
                $"runtimeGameTime={GetField(runtimeData, "m_GameTime")}",
                $"state={GetField(runtimeData, "m_NKM_GAME_STATE")}",
                $"wave={GetField(runtimeData, "m_WaveID")}",
                $"remain={GetField(runtimeData, "m_fRemainGameTime")}",
                $"win={GetField(runtimeData, "m_WinTeam")}",
                $"ended={GetField(runtimeData, "m_bGameEnded")}",
                $"teamA={DescribeRuntimeTeam(GetField(runtimeData, "m_NKMGameRuntimeTeamDataA"))}",
                $"teamB={DescribeRuntimeTeam(GetField(runtimeData, "m_NKMGameRuntimeTeamDataB"))}",
                $"events={CountCollection(GetField(runtimeData, "m_lstPermanentDungeonEvent"))}"
            });
        }

        private string DescribeRuntimeTeam(object? team)
        {
            if (team == null) return "null";
            return $"user={GetField(team, "m_UserUID")} cost={GetField(team, "m_fRespawnCost")} assist={GetField(team, "m_fRespawnCostAssist")} used={GetField(team, "m_fUsedRespawnCost")} count={GetField(team, "m_respawn_count")} auto={GetField(team, "m_NKM_GAME_AUTO_SKILL_TYPE")} aiDisable={GetField(team, "m_bAIDisable")}";
        }

        private string DescribeSyncBase(object? syncBase)
        {
            if (syncBase == null) return "null";
            return string.Join(" ", new[]
            {
                $"gameTime={GetField(syncBase, "m_fGameTime")}",
                $"remain={GetField(syncBase, "m_fRemainGameTime")}",
                $"costA={GetField(syncBase, "m_fRespawnCostA1")}",
                $"costB={GetField(syncBase, "m_fRespawnCostB1")}",
                $"speed={GetField(syncBase, "m_NKM_GAME_SPEED_TYPE")}",
                $"autoA={GetField(syncBase, "m_NKM_GAME_AUTO_SKILL_TYPE_A")}",
                $"units={DescribeSyncUnits(GetField(syncBase, "m_NKMGameSyncData_Unit"))}",
                $"simple={DescribeSimpleSyncUnits(GetField(syncBase, "m_NKMGameSyncDataSimple_Unit"))}",
                $"deck={DescribeDeckSyncs(GetField(syncBase, "m_NKMGameSyncData_Deck"))}",
                $"state={DescribeGameStateSyncs(GetField(syncBase, "m_NKMGameSyncData_GameState"))}",
                $"events={CountCollection(GetField(syncBase, "m_NKMGameSyncData_DungeonEvent"))}",
                $"die={CountCollection(GetField(syncBase, "m_NKMGameSyncData_DieUnit"))}",
                $"shipSkill={CountCollection(GetField(syncBase, "m_NKMGameSyncData_ShipSkill"))}"
            });
        }

        private string DescribeSyncUnits(object? units)
        {
            if (units is not IEnumerable enumerable) return "0[]";
            var values = new List<string>();
            foreach (var item in enumerable.Cast<object>().Take(12))
            {
                var unitSync = GetField(item, "m_NKMGameUnitSyncData");
                if (unitSync == null)
                {
                    values.Add("null");
                    continue;
                }

                values.Add(string.Join(":",
                    Convert.ToString(GetField(unitSync, "m_GameUnitUID"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_NKM_UNIT_PLAY_STATE"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_bRespawnThisFrame"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_PosX"), CultureInfo.InvariantCulture),
                    Convert.ToString(GetField(unitSync, "m_StateID"), CultureInfo.InvariantCulture)));
            }
            return $"{CountCollection(units)}[{string.Join(",", values)}]";
        }

        private string DescribeSimpleSyncUnits(object? units)
        {
            if (units is not IEnumerable enumerable) return "0[]";
            var values = enumerable
                .Cast<object>()
                .Take(12)
                .Select(item => Convert.ToString(GetField(item, "m_GameUnitUID"), CultureInfo.InvariantCulture))
                .ToList();
            return $"{CountCollection(units)}[{string.Join(",", values)}]";
        }

        private string DescribeDeckSyncs(object? deckSyncs)
        {
            if (deckSyncs is not IEnumerable enumerable) return "0[]";
            var values = enumerable.Cast<object>().Take(12).Select(item => string.Join(":",
                Convert.ToString(GetField(item, "m_NKM_TEAM_TYPE"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_UnitDeckIndex"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_UnitDeckUID"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_NextDeckUnitUID"), CultureInfo.InvariantCulture))).ToList();
            return $"{CountCollection(deckSyncs)}[{string.Join(",", values)}]";
        }

        private string DescribeGameStateSyncs(object? gameStates)
        {
            if (gameStates is not IEnumerable enumerable) return "0[]";
            var values = enumerable.Cast<object>().Take(12).Select(item => string.Join(":",
                Convert.ToString(GetField(item, "m_NKM_GAME_STATE"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_WinTeam"), CultureInfo.InvariantCulture),
                Convert.ToString(GetField(item, "m_WaveID"), CultureInfo.InvariantCulture))).ToList();
            return $"{CountCollection(gameStates)}[{string.Join(",", values)}]";
        }

        private string DescribeTeam(object? team)
        {
            if (team == null) return "null";

            return string.Join(" ", new[]
            {
                $"type={GetField(team, "m_eNKM_TEAM_TYPE")}",
                $"user={GetField(team, "m_user_uid")}",
                $"leader={GetField(team, "m_LeaderUnitUID")}",
                $"ship={DescribeUnit(GetField(team, "m_MainShip"))}",
                $"units={DescribeUnitList(GetField(team, "m_listUnitData"))}",
                $"events={DescribeUnitList(GetField(team, "m_listEvevtUnitData"))}",
                $"dynamic={CountCollection(GetField(team, "m_listDynamicRespawnUnitData"))}",
                $"env={CountCollection(GetField(team, "m_listEnvUnitData"))}",
                $"deck={DescribeDeck(GetField(team, "m_DeckData"))}"
            });
        }

        private string DescribeDeck(object? deck)
        {
            if (deck == null) return "null";
            try
            {
                var count = Convert.ToInt32(FindMethodByName(deck.GetType(), "GetListUnitDeckCount")?.Invoke(deck, null) ?? 0, CultureInfo.InvariantCulture);
                var values = new List<string>();
                var get = FindMethodByName(deck.GetType(), "GetListUnitDeck");
                for (var index = 0; index < count; index += 1)
                {
                    values.Add(Convert.ToInt64(get?.Invoke(deck, [index]) ?? 0L, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                }

                var used = Convert.ToInt32(FindMethodByName(deck.GetType(), "GetListUnitDeckUsedCount")?.Invoke(deck, null) ?? 0, CultureInfo.InvariantCulture);
                var tomb = Convert.ToInt32(FindMethodByName(deck.GetType(), "GetListUnitDeckTombCount")?.Invoke(deck, null) ?? 0, CultureInfo.InvariantCulture);
                return $"[{string.Join(",", values)}] used={used} tomb={tomb}";
            }
            catch (Exception ex)
            {
                return $"error:{ex.GetType().Name}";
            }
        }

        private string DescribeUnit(object? unit)
        {
            if (unit == null) return "null";
            return $"{GetField(unit, "m_UnitID")}:{GetField(unit, "m_UnitUID")} user={GetField(unit, "m_UserUID")} lv={GetField(unit, "m_UnitLevel")} gameUIDs=[{DescribeScalarList(GetField(unit, "m_listGameUnitUID"))}]";
        }

        private string DescribeUnitList(object? units)
        {
            if (units is not IEnumerable enumerable) return "0[]";
            var values = enumerable.Cast<object>().Take(12).Select(DescribeUnit).ToList();
            return $"{CountCollection(units)}[{string.Join(";", values)}]";
        }

        private static string DescribeScalarList(object? values)
        {
            if (values is not IEnumerable enumerable) return "";
            return string.Join(",", enumerable.Cast<object>().Take(12).Select(value => Convert.ToString(value, CultureInfo.InvariantCulture)));
        }

        private static int CountCollection(object? collection)
        {
            if (collection == null) return 0;
            if (collection is ICollection nonGeneric) return nonGeneric.Count;
            var countProperty = collection.GetType().GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
            if (countProperty != null)
            {
                return Convert.ToInt32(countProperty.GetValue(collection), CultureInfo.InvariantCulture);
            }
            return collection is IEnumerable enumerable ? enumerable.Cast<object>().Count() : 0;
        }

        private string DescribeObjectFields(object? target, params string[] excludeFields)
        {
            if (target == null) return "null";
            var exclude = new HashSet<string>(excludeFields ?? [], StringComparer.Ordinal);
            var fields = GetAllInstanceFields(target.GetType())
                .Where(field => !exclude.Contains(field.Name))
                .Select(field => $"{field.Name}={SummarizeValue(field.GetValue(target))}");
            return string.Join(" ", fields);
        }

        private static IEnumerable<FieldInfo> GetAllInstanceFields(Type type)
        {
            for (var current = type; current != null && current != typeof(object); current = current.BaseType)
            {
                foreach (var field in current.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                {
                    yield return field;
                }
            }
        }

        private static string SummarizeValue(object? value)
        {
            if (value == null) return "null";
            if (value is string text) return text.Length > 40 ? $"\"{text[..40]}...\"({text.Length})" : $"\"{text}\"";
            if (value is DateTime date) return date.ToString("O", CultureInfo.InvariantCulture);
            if (value is bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal || value.GetType().IsEnum)
            {
                return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            }
            if (value is IDictionary dictionary) return $"{value.GetType().Name}[{dictionary.Count}]";
            if (value is ICollection collection) return $"{value.GetType().Name}[{collection.Count}]";
            if (value is IEnumerable enumerable) return $"{value.GetType().Name}[{enumerable.Cast<object>().Count()}]";
            return value.GetType().Name;
        }

        private string DescribeIntervals(object? intervalData, int limit)
        {
            if (intervalData is not IEnumerable enumerable) return "0[]";
            var intervals = enumerable.Cast<object>().ToList();
            var values = intervals.Take(Math.Max(0, limit)).Select(interval =>
                $"{GetField(interval, "strKey")}:{GetField(interval, "startDate")}->{GetField(interval, "endDate")}");
            var strKeys = intervals
                .Select(interval => Convert.ToString(GetField(interval, "strKey"), CultureInfo.InvariantCulture) ?? "")
                .Where(strKey => !string.IsNullOrWhiteSpace(strKey))
                .ToList();
            var duplicateStrKeySummary = strKeys
                .GroupBy(strKey => strKey, StringComparer.Ordinal)
                .Where(group => group.Count() > 1)
                .Take(12)
                .Select(group => $"{group.Key}x{group.Count()}");
            var duplicateKeySummary = intervals
                .Select(interval => new
                {
                    Key = Convert.ToString(GetField(interval, "key"), CultureInfo.InvariantCulture) ?? "",
                    StrKey = Convert.ToString(GetField(interval, "strKey"), CultureInfo.InvariantCulture) ?? ""
                })
                .Where(interval => !string.IsNullOrWhiteSpace(interval.Key))
                .GroupBy(interval => interval.Key, StringComparer.Ordinal)
                .Where(group => group.Count() > 1)
                .Take(12)
                .Select(group => $"{group.Key}x{group.Count()}:{string.Join("/", group.Take(4).Select(interval => interval.StrKey))}");
            var probes = new[]
            {
                "DATE_COMMON_EPISODE_EVENT_ADMIN",
                "DATE_COMMON_EPISODE_EVENT_ADMIN_02",
                "DATE_COMMON_MISSION_EVENT_XMAS",
                "DATE_COMMON_EPISODE_EVENT_SHADE_01",
                "DATE_COMMON_EPISODE_EVENT_SUMMER2021_01"
            };
            var probeSummary = probes.Select(probe => $"{probe}={strKeys.Contains(probe)}");
            var focusedMatches = strKeys
                .Where(strKey =>
                    strKey.Contains("EPISODE_EVENT_ADMIN", StringComparison.Ordinal) ||
                    strKey.Contains("MISSION_EVENT_XMAS", StringComparison.Ordinal) ||
                    strKey.Contains("EPISODE_EVENT_SHADE", StringComparison.Ordinal) ||
                    strKey.Contains("EPISODE_EVENT_SUMMER2021", StringComparison.Ordinal))
                .Take(20);
            return $"{intervals.Count}[{string.Join(", ", values)}] duplicateKeys=[{string.Join(", ", duplicateKeySummary)}] duplicateStrKeys=[{string.Join(", ", duplicateStrKeySummary)}] probes=[{string.Join(", ", probeSummary)}] focused=[{string.Join(", ", focusedMatches)}]";
        }

        private string ZeroCopyToBase64(object zeroCopy)
        {
            var totalSize = Convert.ToInt32(zeroCopyCalcTotalSize.Invoke(zeroCopy, null), CultureInfo.InvariantCulture);
            if (totalSize <= 0) return "";

            var output = new byte[totalSize];
            var offset = 0;
            foreach (var segment in (IEnumerable)zeroCopyGetView.Invoke(zeroCopy, null)!)
            {
                var segmentType = segment.GetType();
                var data = (byte[])segmentType.GetProperty("Data", BindingFlags.Public | BindingFlags.Instance)!.GetValue(segment)!;
                var length = Convert.ToInt32(segmentType.GetProperty("Offset", BindingFlags.Public | BindingFlags.Instance)!.GetValue(segment), CultureInfo.InvariantCulture);
                Buffer.BlockCopy(data, 0, output, offset, length);
                offset += length;
            }

            return Convert.ToBase64String(output);
        }

        public List<HostPacket> DrainClientPackets(string label, Action<int, object>? beforeSerialize = null)
        {
            var output = new List<HostPacket>();
            var queue = messageQueueField.GetValue(null);
            if (queue == null) return output;

            foreach (var message in ((IEnumerable)queue).Cast<object>().ToList())
            {
                var eventName = messageEventField.GetValue(message)?.ToString() ?? "";
                if (!string.Equals(eventName, "NEM_NKCPACKET_SEND_TO_CLIENT", StringComparison.Ordinal))
                {
                    continue;
                }

                var packet = messageParamField.GetValue(message);
                if (packet == null) continue;
                var packetId = Convert.ToInt32(messageIdField.GetValue(message), CultureInfo.InvariantCulture);
                beforeSerialize?.Invoke(packetId, packet);
                output.Add(SerializePacket(packet, packetId, label));
            }

            ClearClientQueue();
            return output;
        }

        public void ClearClientQueue()
        {
            var queue = messageQueueField.GetValue(null);
            queue?.GetType().GetMethod("Clear", BindingFlags.Public | BindingFlags.Instance)?.Invoke(queue, null);
        }

        public object? GetField(object target, string fieldName)
        {
            return FindField(target.GetType(), fieldName)?.GetValue(target);
        }

        public void SetField(object target, string fieldName, object? value)
        {
            var field = FindField(target.GetType(), fieldName)
                ?? throw new MissingFieldException(target.GetType().FullName, fieldName);
            field.SetValue(target, ConvertForField(value, field.FieldType));
        }

        private static FieldInfo? FindField(Type type, string fieldName)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                var field = current.GetField(fieldName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (field != null) return field;
            }

            return null;
        }

        private static MethodInfo? FindMethod(Type type, string methodName, params Type[] parameterTypes)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                var method = current.GetMethod(methodName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, parameterTypes, null);
                if (method != null) return method;
            }

            return null;
        }

        private static MethodInfo? FindMethodByName(Type type, string methodName)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                var method = current
                    .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .FirstOrDefault(candidate => string.Equals(candidate.Name, methodName, StringComparison.Ordinal));
                if (method != null) return method;
            }

            return null;
        }

        private static object? ConvertForField(object? value, Type fieldType)
        {
            if (value == null) return null;
            var targetType = Nullable.GetUnderlyingType(fieldType) ?? fieldType;
            if (targetType.IsEnum)
            {
                return value.GetType().IsEnum ? value : Enum.ToObject(targetType, value);
            }
            if (targetType == typeof(float)) return Convert.ToSingle(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(double)) return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(sbyte)) return Convert.ToSByte(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(short)) return Convert.ToInt16(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(int)) return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(long)) return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            if (targetType == typeof(bool)) return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
            return value;
        }

        private static Assembly? ResolveManagedAssembly(string managedDir, ResolveEventArgs args)
        {
            var simpleName = new AssemblyName(args.Name).Name;
            if (string.IsNullOrWhiteSpace(simpleName))
            {
                return null;
            }

            var alreadyLoaded = AppDomain.CurrentDomain.GetAssemblies()
                .FirstOrDefault(asm => string.Equals(asm.GetName().Name, simpleName, StringComparison.OrdinalIgnoreCase));
            if (alreadyLoaded != null)
            {
                return alreadyLoaded;
            }

            var candidate = Path.Combine(managedDir, simpleName + ".dll");
            if (!File.Exists(candidate))
            {
                return null;
            }

            return Assembly.LoadFrom(candidate);
        }

        private IntPtr ResolveNativeLibrary(string libraryName, Assembly sourceAssembly, DllImportSearchPath? searchPath)
        {
            var fileNames = NativeLibraryFileNames(libraryName);
            foreach (var directory in nativeSearchDirs)
            {
                foreach (var fileName in fileNames)
                {
                    var candidate = Path.Combine(directory, fileName);
                    if (File.Exists(candidate) && NativeLibrary.TryLoad(candidate, out var handle))
                    {
                        return handle;
                    }
                }
            }

            return IntPtr.Zero;
        }

        private static IReadOnlyList<string> BuildNativeSearchDirs(string managedDir)
        {
            var dataDir = Directory.GetParent(managedDir)?.FullName ?? managedDir;
            var gameDir = Directory.GetParent(dataDir)?.FullName ?? dataDir;
            var androidNativeDir = Environment.GetEnvironmentVariable("REVIVALSIDE_NATIVE_LIBRARY_DIR");
            var dotnetNativeDir = Environment.GetEnvironmentVariable("REVIVALSIDE_DOTNET_NATIVE_ROOT");
            return new[]
            {
                androidNativeDir,
                dotnetNativeDir,
                managedDir,
                Path.Combine(dataDir, "Plugins", "arm64-v8a"),
                Path.Combine(dataDir, "Plugins", "armeabi-v7a"),
                Path.Combine(dataDir, "Plugins", "x86_64"),
                Path.Combine(dataDir, "Plugins"),
                Path.Combine(dataDir, "lib", "arm64-v8a"),
                Path.Combine(dataDir, "lib", "armeabi-v7a"),
                Path.Combine(dataDir, "lib", "x86_64"),
                dataDir,
                gameDir
            }
                .Where(path => !string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
                .Select(path => path!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        private static IEnumerable<string> NativeLibraryFileNames(string libraryName)
        {
            yield return libraryName;
            if (!libraryName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            {
                yield return libraryName + ".dll";
            }
            if (!libraryName.EndsWith(".so", StringComparison.OrdinalIgnoreCase))
            {
                yield return libraryName + ".so";
                if (!libraryName.StartsWith("lib", StringComparison.OrdinalIgnoreCase))
                {
                    yield return "lib" + libraryName + ".so";
                }
            }
            if (!libraryName.EndsWith(".dylib", StringComparison.OrdinalIgnoreCase))
            {
                yield return libraryName + ".dylib";
                if (!libraryName.StartsWith("lib", StringComparison.OrdinalIgnoreCase))
                {
                    yield return "lib" + libraryName + ".dylib";
                }
            }
        }

        private static void PrimeNativeSearchPath(IEnumerable<string> nativeSearchDirs)
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                return;
            }

            foreach (var directory in nativeSearchDirs)
            {
                if (File.Exists(Path.Combine(directory, "lua54.dll")))
                {
                    SetDllDirectory(directory);
                    break;
                }
            }
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool SetDllDirectory(string lpPathName);
    }

    private static long ParseLong(string? value)
    {
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }
}
