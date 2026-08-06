using System.Text.Json;

namespace RevivalSide.CombatHost;

internal sealed class CombatEngine
{
    private readonly HostOptions options;

    private static readonly CombatStateIds StateIds = new();
    private const double StatRateScale = 10000.0;
    private static readonly Dictionary<int, TacticRecord[]> TacticUpdateStats = new()
    {
        [0] =
        [
            new("NST_ATTACK_DAMAGE_MODIFY_G2", 400),
            new("NST_DAMAGE_REDUCE_RATE", 400),
            new("NST_COST_RETURN_RATE", 400),
            new("NST_ATTACK_DAMAGE_MODIFY_G2", 200),
            new("NST_DAMAGE_REDUCE_RATE", 200),
            new("NST_COST_RETURN_RATE", 200)
        ],
        [1] =
        [
            new("NST_DAMAGE_REDUCE_RATE", 400),
            new("NST_DAMAGE_REDUCE_RATE", 400),
            new("NST_COST_RETURN_RATE", 400),
            new("NST_DAMAGE_REDUCE_RATE", 200),
            new("NST_DAMAGE_REDUCE_RATE", 200),
            new("NST_COST_RETURN_RATE", 200)
        ]
    };

    public CombatEngine(HostOptions options)
    {
        this.options = options;
    }

    public HostResponse Handle(HostRequest request)
    {
        return request.Command switch
        {
            "warmup" => Warmup(),
            "startBattle" => StartBattle(Read<StartBattleData>(request.Data)),
            "deployStageLineup" => DeployStageLineup(Read<BattleCommandData>(request.Data)),
            "handleDeploy" => HandleDeploy(Read<DeployCommandData>(request.Data)),
            "handlePause" => HandlePause(Read<PauseCommandData>(request.Data)),
            "handleUnitSkill" => HandleUnitSkill(Read<UnitSkillCommandData>(request.Data)),
            "handleShipSkill" => HandleShipSkill(Read<ShipSkillCommandData>(request.Data)),
            "buildSync" => BuildSync(Read<SyncCommandData>(request.Data)),
            "buildTimeline" => BuildTimeline(Read<TimelineCommandData>(request.Data)),
            "buildInitialSync" => BuildInitialSync(Read<BattleCommandData>(request.Data)),
            "buildRespawnAck" => BuildRespawnAck(Read<RespawnAckCommandData>(request.Data)),
            "buildSyntheticSync" => BuildSyntheticSync(Read<SyntheticSyncCommandData>(request.Data)),
            "isFinished" => IsFinished(Read<BattleCommandData>(request.Data)),
            "getResult" => GetResult(Read<BattleCommandData>(request.Data)),
            "validatePacket" => ValidatePacket(Read<PacketValidationData>(request.Data)),
            "inspectGameLoadAck" => InspectGameLoadAck(Read<PacketValidationData>(request.Data)),
            "inspectGameLoadCompleteAck" => InspectGameLoadCompleteAck(Read<PacketValidationData>(request.Data)),
            "inspectGameSync" => InspectGameSync(Read<PacketValidationData>(request.Data)),
            "inspectJoinLobbyAck" => InspectJoinLobbyAck(Read<PacketValidationData>(request.Data)),
            "extractJoinLobbyIntervals" => ExtractJoinLobbyIntervals(Read<PacketValidationData>(request.Data)),
            "extractJoinLobbyProfile" => ExtractJoinLobbyProfile(Read<PacketValidationData>(request.Data)),
            "mergeJoinLobbyAck" => MergeJoinLobbyAck(Read<JoinLobbyMergeData>(request.Data)),
            "normalizeJoinLobbyAck" => NormalizeJoinLobbyAck(Read<JoinLobbyNormalizeData>(request.Data)),
            "exportLuaTable" => ExportLuaTable(Read<GameplayTableExportData>(request.Data)),
            "validateUnitTemplets" => ValidateUnitTemplets(Read<UnitTempletValidationData>(request.Data)),
            _ => new HostResponse { Ok = false, Error = $"unknown command: {request.Command}" }
        };
    }

    private HostResponse Warmup()
    {
        return ManagedCombatBridge.TryWarmup(options, out var error)
            ? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed warmup failed" };
    }

    private HostResponse ValidatePacket(PacketValidationData data)
    {
        return ManagedCombatBridge.TryValidatePacket(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed packet validation failed" };
    }

    private HostResponse InspectGameLoadAck(PacketValidationData data)
    {
        return ManagedCombatBridge.TryInspectGameLoadAck(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed GAME_LOAD_ACK inspection failed" };
    }

    private HostResponse InspectGameLoadCompleteAck(PacketValidationData data)
    {
        return ManagedCombatBridge.TryInspectGameLoadCompleteAck(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed GAME_LOAD_COMPLETE_ACK inspection failed" };
    }

    private HostResponse InspectGameSync(PacketValidationData data)
    {
        return ManagedCombatBridge.TryInspectGameSync(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed GAME_SYNC inspection failed" };
    }

    private HostResponse InspectJoinLobbyAck(PacketValidationData data)
    {
        return ManagedCombatBridge.TryInspectJoinLobbyAck(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed JOIN_LOBBY_ACK inspection failed" };
    }

    private HostResponse ExtractJoinLobbyIntervals(PacketValidationData data)
    {
        return ManagedCombatBridge.TryExtractJoinLobbyIntervals(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed JOIN_LOBBY_ACK interval extraction failed" };
    }

    private HostResponse ExtractJoinLobbyProfile(PacketValidationData data)
    {
        return ManagedCombatBridge.TryExtractJoinLobbyProfile(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed JOIN_LOBBY_ACK profile extraction failed" };
    }

    private HostResponse MergeJoinLobbyAck(JoinLobbyMergeData data)
    {
        return ManagedCombatBridge.TryMergeJoinLobbyAck(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed lobby merge failed" };
    }

    private HostResponse NormalizeJoinLobbyAck(JoinLobbyNormalizeData data)
    {
        return ManagedCombatBridge.TryNormalizeJoinLobbyAck(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed lobby normalize failed" };
    }

    private HostResponse ExportLuaTable(GameplayTableExportData data)
    {
        return ManagedCombatBridge.TryExportLuaTable(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed Lua table export failed" };
    }

    private HostResponse ValidateUnitTemplets(UnitTempletValidationData data)
    {
        return ManagedCombatBridge.TryValidateUnitTemplets(options, data, out var response, out var error)
            ? response ?? new HostResponse { Ok = true }
            : new HostResponse { Ok = false, Error = error ?? "managed unit templet validation failed" };
    }

    private HostResponse StartBattle(StartBattleData data)
    {
        var stage = data.Stage ?? new StageData();
        var req = data.Req ?? new GameLoadReq();
        var groups = stage.DeployableGameUnitUIDGroups.Count > 0
            ? stage.DeployableGameUnitUIDGroups
            : [[5, 6]];
        var assigned = groups.SelectMany(group => group).Distinct().ToList();
        var gameUID = data.GameUID != 0 ? data.GameUID : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 10000;

        var dynamicGame = new DynamicGameState
        {
            StageID = stage.StageId != 0 ? stage.StageId : req.StageID,
            DungeonID = stage.DungeonID != 0 ? stage.DungeonID : req.DungeonID,
            RaidUID = stage.RaidUID != 0 ? stage.RaidUID : req.RaidUID,
            RaidLevel = stage.RaidLevel != 0 ? stage.RaidLevel : req.RaidLevel,
            MapID = stage.MapID != 0 ? stage.MapID : MapIdForStageDungeon(stage.StageId != 0 ? stage.StageId : req.StageID, stage.DungeonID != 0 ? stage.DungeonID : req.DungeonID),
            GameType = stage.GameType != 0 ? stage.GameType : req.GameType,
            DiveStageID = stage.DiveStageID != 0 ? stage.DiveStageID : req.DiveStageID,
            MiscMode = stage.MiscMode ?? "",
            PalaceID = stage.PalaceID,
            FierceBossId = stage.FierceBossId,
            TrimId = stage.TrimId,
            TrimLevel = stage.TrimLevel,
            DefenceTempletId = stage.DefenceTempletId,
            ExploreID = stage.ExploreID,
            ExploreStageId = stage.ExploreStageId,
            PhaseId = stage.PhaseId,
            PhaseIndex = stage.PhaseIndex,
            BattleConditionIds = stage.BattleConditionIds.Where(id => id > 0).Distinct().ToList(),
            FierceBasePoint = Math.Max(0, stage.FierceBasePoint),
            FierceMaxDamagePoint = Math.Max(0, stage.FierceMaxDamagePoint),
            FierceMaxTimePoint = Math.Max(0, stage.FierceMaxTimePoint),
            FiercePenaltyRate = Math.Max(0, stage.FiercePenaltyRate),
            FiercePenaltyIds = stage.FiercePenaltyIds.Where(id => id > 0).Distinct().ToList(),
            GameUID = gameUID,
            GameUnitUIDIndex = stage.GameUnitUIDIndex != 0 ? stage.GameUnitUIDIndex : 18,
            DeployableGameUnitUIDGroups = groups.Select(group => group.ToList()).ToList(),
            AssignedGameUnitUIDs = assigned,
            Tutorial = IsTutorialStage(stage.StageId != 0 ? stage.StageId : req.StageID),
            UnitPools = BuildUnitPools(stage),
            UsedPooledGameUnitUIDs = stage.InitialUnits.Select(unit => unit.GameUnitUID).Where(uid => uid > 0).ToHashSet()
        };

        var battleState = new BattleState
        {
            StageId = dynamicGame.StageID,
            GameUID = gameUID,
            Units = stage.InitialUnits.Select(CloneUnit).ToList(),
            StartTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            GameTime = stage.InitialGameTime != 0 ? stage.InitialGameTime : 4,
            AbsoluteGameTime = stage.InitialGameTime != 0 ? stage.InitialGameTime : 4,
            RemainGameTime = stage.InitialRemainGameTime != 0 ? stage.InitialRemainGameTime : 180,
            RespawnCostA1 = stage.RespawnCostA1 == 0 ? 10 : stage.RespawnCostA1,
            RespawnCostB1 = stage.RespawnCostB1 == 0 ? 10 : stage.RespawnCostB1,
            GameState = stage.GameState ?? new GameStateSync(),
            AutoDeployUnits = stage.AutoDeployUnits.Select(CloneAutoDeploy).ToList(),
            DeployedUnitUIDs = [],
            PendingDieUnitUIDs = [],
            PendingDeckSyncs = [],
            PendingGameStates = [],
            PendingDungeonEvents = [],
            RemovedUnitUIDs = []
        };

        foreach (var unit in battleState.Units)
        {
            NormalizeUnit(unit);
            HydrateStats(unit);
            EnsureBattleRecord(battleState, unit);
        }

        ManagedCombatBridge.TryStart(options, data, dynamicGame, battleState, out var managedGameLoadAck, out var managedError);
        if (dynamicGame.ManagedCombat)
        {
            // Managed combat is the preferred path when the installed
            // CounterSide assemblies can hydrate NKCGameServerLocal from the
            // captured 804. The lightweight state remains as a fallback and as
            // metadata for the Node side.
        }

        return new HostResponse
        {
            Ok = true,
            Error = managedError,
            DynamicGame = dynamicGame,
            BattleState = battleState,
            PayloadBase64 = dynamicGame.ManagedCombat ? managedGameLoadAck?.PayloadBase64 : null
        };
    }

    private HostResponse DeployStageLineup(BattleCommandData data)
    {
        var dynamicGame = data.DynamicGame ?? new DynamicGameState();
        var battleState = data.BattleState ?? new BattleState();
        var deployed = new List<UnitState>();
        foreach (var unit in battleState.AutoDeployUnits)
        {
            if (string.IsNullOrWhiteSpace(unit.UnitUID) || battleState.DeployedUnitUIDs.Contains(unit.UnitUID))
            {
                continue;
            }
            battleState.DeployedUnitUIDs.Add(unit.UnitUID);
            foreach (var gameUnitUID in unit.GameUnitUIDs)
            {
                var runtime = new UnitState
                {
                    SourceUnitUID = unit.UnitUID,
                    GameUnitUID = gameUnitUID,
                    Team = 1,
                    Hp = unit.Hp,
                    MaxHp = unit.Hp,
                    X = unit.X,
                    Z = unit.Z,
                    SavedPosX = unit.X,
                    Right = unit.Right,
                    PlayState = unit.PlayState,
                    Respawn = true,
                    StateId = unit.StateId,
                    StateChangeCount = unit.StateChangeCount,
                    Seed = unit.Seed == 0 ? 51 : unit.Seed
                };
                NormalizeUnit(runtime);
                HydrateStats(runtime);
                EnsureBattleRecord(battleState, runtime);
                battleState.Units.Add(runtime);
                dynamicGame.UsedPooledGameUnitUIDs.Add(gameUnitUID);
                deployed.Add(runtime);
            }
        }

        return new HostResponse
        {
            Ok = true,
            DynamicGame = dynamicGame,
            BattleState = battleState,
            Deployed = new HostDeployResult { Handled = true, Mode = "battleState", Spawned = deployed }
        };
    }

    private HostResponse HandleDeploy(DeployCommandData data)
    {
        if (ManagedCombatBridge.TryHandleDeploy(data, out var managedResponse, out var managedError))
        {
            return managedResponse!;
        }
        if (data.DynamicGame?.ManagedCombat == true)
        {
            return managedResponse ?? new HostResponse { Ok = false, Error = managedError ?? "managed deploy failed" };
        }

        if (data.BattleState == null || data.DynamicGame == null || data.Req == null)
        {
            return new HostResponse { Ok = true, Deployed = new HostDeployResult { Handled = false } };
        }

        var battleState = data.BattleState;
        var dynamicGame = data.DynamicGame;
        NormalizeCollections(battleState, dynamicGame);
        var unit = DeployRuntimeBattleUnit(dynamicGame, battleState, data.Req);
        var ackPayload = PacketBuilder.BuildRespawnAck(data.Req.UnitUID, data.Req.AssistUnit);
        var packets = new List<HostPacket>
        {
            new()
            {
                PacketId = 817,
                Label = "csharp-combat-respawn",
                PayloadBase64 = Convert.ToBase64String(ackPayload)
            }
        };

        if (unit != null)
        {
            var syncPayload = BuildSyncPayload(battleState, 0, skipSimulation: true);
            packets.Add(new HostPacket
            {
                PacketId = 822,
                Label = "csharp-combat-deploy-sync",
                PayloadBase64 = Convert.ToBase64String(syncPayload)
            });
        }

        return new HostResponse
        {
            Ok = true,
            DynamicGame = dynamicGame,
            BattleState = battleState,
            Packets = packets,
            Deployed = new HostDeployResult { Handled = true, Mode = "battleState", Unit = unit }
        };
    }

    private HostResponse HandlePause(PauseCommandData data)
    {
        if (ManagedCombatBridge.TryHandlePause(data, out var managedResponse, out var managedError))
        {
            return managedResponse ?? new HostResponse { Ok = false, Error = managedError ?? "managed pause failed" };
        }

        return new HostResponse { Ok = false, Error = managedError ?? "managed pause unavailable" };
    }

    private HostResponse HandleUnitSkill(UnitSkillCommandData data)
    {
        if (ManagedCombatBridge.TryHandleUnitSkill(data, out var managedResponse, out var managedError))
        {
            return managedResponse ?? new HostResponse { Ok = false, Error = managedError ?? "managed unit skill failed" };
        }

        return new HostResponse { Ok = false, Error = managedError ?? "managed unit skill unavailable" };
    }

    private HostResponse HandleShipSkill(ShipSkillCommandData data)
    {
        if (ManagedCombatBridge.TryHandleShipSkill(data, out var managedResponse, out var managedError))
        {
            return managedResponse ?? new HostResponse { Ok = false, Error = managedError ?? "managed ship skill failed" };
        }

        return new HostResponse { Ok = false, Error = managedError ?? "managed ship skill unavailable" };
    }

    private HostResponse BuildSync(SyncCommandData data)
    {
        if (ManagedCombatBridge.TryBuildSync(data, out var managedResponse, out var managedError))
        {
            return managedResponse!;
        }
        if (data.DynamicGame?.ManagedCombat == true)
        {
            return managedResponse ?? new HostResponse { Ok = false, Error = managedError ?? "managed sync failed" };
        }

        if (data.BattleState == null)
        {
            return new HostResponse { Ok = false, Error = "battleState required" };
        }

        var payload = BuildSyncPayload(data.BattleState, data.Delta ?? options.SyncIntervalSeconds, data.SkipSimulation);
        return new HostResponse
        {
            Ok = true,
            BattleState = data.BattleState,
            PayloadBase64 = Convert.ToBase64String(payload)
        };
    }

    private HostResponse BuildTimeline(TimelineCommandData data)
    {
        return ManagedCombatBridge.TryBuildTimeline(data, out var response, out var error)
            ? response!
            : response ?? new HostResponse { Ok = false, Error = error ?? "managed timeline unavailable" };
    }

    private HostResponse BuildInitialSync(BattleCommandData data)
    {
        if (ManagedCombatBridge.TryBuildInitialSync(data.DynamicGame, data.BattleState, out var managedResponse, out var managedError))
        {
            return managedResponse!;
        }
        if (data.DynamicGame?.ManagedCombat == true)
        {
            return managedResponse ?? new HostResponse { Ok = false, Error = managedError ?? "managed initial sync failed" };
        }

        var battleState = data.BattleState;
        if (battleState == null)
        {
            return new HostResponse
            {
                Ok = true,
                PayloadBase64 = Convert.ToBase64String(PacketBuilder.BuildSyntheticGameSync(4))
            };
        }

        var payload = PacketBuilder.BuildGameSync(battleState);
        return new HostResponse
        {
            Ok = true,
            BattleState = battleState,
            PayloadBase64 = Convert.ToBase64String(payload)
        };
    }

    private HostResponse BuildRespawnAck(RespawnAckCommandData data)
    {
        return new HostResponse
        {
            Ok = true,
            PayloadBase64 = Convert.ToBase64String(PacketBuilder.BuildRespawnAck(data.UnitUID, data.AssistUnit))
        };
    }

    private static HostResponse BuildSyntheticSync(SyntheticSyncCommandData data)
    {
        return new HostResponse
        {
            Ok = true,
            PayloadBase64 = Convert.ToBase64String(PacketBuilder.BuildSyntheticGameSync(data.GameTime))
        };
    }

    private static HostResponse IsFinished(BattleCommandData data)
    {
        var state = data.BattleState;
        return new HostResponse
        {
            Ok = true,
            Result = new HostResult
            {
                Finished = state?.Finished == true,
                Win = state?.Win == true,
                GameTime = state?.GameTime ?? 0
            }
        };
    }

    private static HostResponse GetResult(BattleCommandData data)
    {
        var state = data.BattleState;
        return new HostResponse
        {
            Ok = true,
            Result = new HostResult
            {
                Finished = state?.Finished == true,
                Win = state?.Win == true,
                GameTime = state?.GameTime ?? 0
            },
            BattleState = state
        };
    }

    private byte[] BuildSyncPayload(BattleState battleState, double delta, bool skipSimulation)
    {
        NormalizeCollections(battleState, null);
        var dt = Clamp(delta, 0, 1);
        battleState.GameTime += dt;
        battleState.AbsoluteGameTime = (battleState.AbsoluteGameTime == 0 ? battleState.GameTime : battleState.AbsoluteGameTime) + dt;
        battleState.RemainGameTime = Math.Max(0, (battleState.RemainGameTime == 0 ? 180 : battleState.RemainGameTime) - dt);
        if (!skipSimulation)
        {
            Tick(battleState, dt);
        }
        return PacketBuilder.BuildGameSync(battleState);
    }

    private UnitState? DeployRuntimeBattleUnit(DynamicGameState dynamicGame, BattleState battleState, RespawnReq req)
    {
        var pooled = ConsumePooledGameUnitUID(dynamicGame, battleState, req.UnitUID);
        if (pooled == null) return null;
        var (gameUnitUID, pool) = pooled.Value;
        var hp = Math.Max(1, req.Hp > 0 ? req.Hp : options.DefaultDeployedUnitHp);
        var x = Clamp(req.RespawnPosX, -3000, 3000);
        var unit = new UnitState
        {
            SourceUnitUID = req.UnitUID,
            UnitID = pool?.UnitID > 0 ? pool.UnitID : req.UnitID,
            UnitStrID = req.UnitStrID,
            GameUnitUID = gameUnitUID,
            Team = 1,
            Hp = hp,
            MaxHp = hp,
            X = x,
            Z = 0,
            SavedPosX = x,
            Right = true,
            PlayState = 1,
            Respawn = true,
            StateId = StateIds.Idle,
            StateChangeCount = 1,
            TargetUID = 0,
            SubTargetUID = 0,
            Seed = 51 + gameUnitUID % 40,
            TacticLevel = pool?.TacticLevel ?? 0,
            TacticGroup = pool?.TacticGroup ?? 0,
            Cost = pool?.Cost ?? 0
        };
        NormalizeUnit(unit);
        HydrateStats(unit);
        EnsureBattleRecord(battleState, unit);
        battleState.Units.Add(unit);
        battleState.GameTime = Math.Max(battleState.GameTime, req.GameTime);
        battleState.AbsoluteGameTime = Math.Max(battleState.AbsoluteGameTime, battleState.GameTime);
        battleState.PendingDeckSyncs.Add(new DeckSync
        {
            Team = 1,
            UnitDeckIndex = NextDeckSyncIndex(battleState),
            UnitDeckUID = req.UnitUID,
            DeckUsedAddUnitUID = req.UnitUID
        });
        return unit;
    }

    private (int GameUnitUID, UnitPool? Pool)? ConsumePooledGameUnitUID(DynamicGameState dynamicGame, BattleState battleState, string unitUID)
    {
        var used = dynamicGame.UsedPooledGameUnitUIDs.ToHashSet();
        foreach (var unit in battleState.Units)
        {
            if (unit.GameUnitUID > 0) used.Add(unit.GameUnitUID);
        }

        var key = unitUID ?? "";
        var preferred = dynamicGame.UnitPools.Ordered.Where(pool => pool.UnitUID == key).ToList();
        var candidates = preferred.Count > 0 ? preferred : dynamicGame.UnitPools.Ordered;
        foreach (var pool in candidates)
        {
            foreach (var uid in pool.GameUnitUIDs)
            {
                if (uid <= 0 || used.Contains(uid)) continue;
                dynamicGame.UsedPooledGameUnitUIDs.Add(uid);
                return (uid, pool);
            }
        }

        foreach (var uid in dynamicGame.UnitPools.UnassignedGameUnitUIDs)
        {
            if (uid <= 0 || used.Contains(uid)) continue;
            dynamicGame.UsedPooledGameUnitUIDs.Add(uid);
            return (uid, null);
        }
        return null;
    }

    private static int NextDeckSyncIndex(BattleState battleState)
    {
        var count = battleState.DeployCount;
        battleState.DeployCount = count + 1;
        return count % 4;
    }

    private UnitPools BuildUnitPools(StageData stage)
    {
        var pools = new UnitPools();
        if (stage.PlayerDeck?.Units.Count > 0)
        {
            for (var index = 0; index < stage.PlayerDeck.Units.Count; index++)
            {
                var unit = stage.PlayerDeck.Units[index];
                if (string.IsNullOrWhiteSpace(unit.UnitUid)) continue;
                var groupIndex = unit.SlotIndex >= 0 && unit.SlotIndex < stage.DeployableGameUnitUIDGroups.Count
                    ? unit.SlotIndex
                    : index;
                var group = groupIndex < stage.DeployableGameUnitUIDGroups.Count
                    ? stage.DeployableGameUnitUIDGroups[groupIndex]
                    : [];
                if (group.Count == 0) continue;
                pools.Ordered.Add(new UnitPool
                {
                    UnitUID = unit.UnitUid,
                    UnitID = unit.UnitId,
                    TacticLevel = Math.Clamp(unit.TacticLevel, 0, 6),
                    TacticGroup = unit.TacticGroup,
                    GameUnitUIDs = group.Distinct().ToList()
                });
            }
        }
        foreach (var auto in stage.AutoDeployUnits)
        {
            if (string.IsNullOrWhiteSpace(auto.UnitUID) || auto.GameUnitUIDs.Count == 0) continue;
            pools.Ordered.Add(new UnitPool
            {
                UnitUID = auto.UnitUID,
                GameUnitUIDs = auto.GameUnitUIDs.Distinct().ToList()
            });
        }

        var fallbackUIDs = new HashSet<int>();
        foreach (var group in stage.DeployableGameUnitUIDGroups)
        {
            foreach (var uid in group)
            {
                if (uid > 4) fallbackUIDs.Add(uid);
            }
        }
        foreach (var pool in pools.Ordered)
        {
            foreach (var uid in pool.GameUnitUIDs)
            {
                if (uid > 4) fallbackUIDs.Add(uid);
            }
        }
        pools.UnassignedGameUnitUIDs = fallbackUIDs.Order().ToList();
        return pools;
    }

    private static bool IsTutorialStage(int stageId)
    {
        return stageId is 11211 or 11212 or 11213 or 11214;
    }

    private static int MapIdForStageDungeon(int stageId, int dungeonId)
    {
        return (stageId, dungeonId) switch
        {
            (11212, _) or (_, 1005) => 1065,
            (11213, _) or (_, 1006) => 1065,
            (11214, _) or (_, 1007) => 1066,
            (11222, _) or (11223, _) or (11224, _) or (11225, _) or
            (11231, _) or (11232, _) or (11233, _) or (11234, _) or
            (_, 1001211) or (_, 1001221) or (_, 1001231) or (_, 1001241) or
            (_, 1001311) or (_, 1001321) or (_, 1001332) or (_, 1001341) => 1010,
            (11241, _) or (11242, _) or (11243, _) or (11244, _) or
            (_, 1001411) or (_, 1001421) or (_, 1001431) or (_, 1001441) => 1036,
            (11235, _) or (11245, _) or (_, 10104) or (_, 10105) => 0,
            _ => 1064
        };
    }

    private void Tick(BattleState battleState, double delta)
    {
        if (battleState.Finished || battleState.Units.Count == 0) return;
        var dt = Clamp(delta <= 0 ? options.SyncIntervalSeconds : delta, 0.05, 1);
        battleState.Units = battleState.Units.Where(unit => unit != null).ToList();
        foreach (var unit in battleState.Units)
        {
            NormalizeUnit(unit);
            HydrateStats(unit);
        }

        var liveUnits = battleState.Units.Where(IsLive).ToList();
        foreach (var unit in liveUnits)
        {
            AddBattleRecordPlayTime(battleState, unit, dt);
        }
        if (liveUnits.Select(unit => unit.Team).Distinct().Count() < 2)
        {
            foreach (var unit in liveUnits)
            {
                unit.TargetUID = 0;
                unit.SpeedX = 0;
                SetUnitState(unit, StateIds.Idle);
            }
            CleanupDeadUnits(battleState);
            SettleOutcome(battleState);
            return;
        }

        foreach (var unit in liveUnits.OrderBy(unit => unit.GameUnitUID).ToList())
        {
            if (!IsLive(unit)) continue;
            var target = FindNearestEnemy(unit, battleState.Units);
            if (target == null)
            {
                unit.TargetUID = 0;
                unit.SpeedX = 0;
                SetUnitState(unit, StateIds.Idle);
                continue;
            }

            var stats = GetStats(unit);
            var direction = target.X >= unit.X ? 1 : -1;
            var distance = Math.Abs(target.X - unit.X);
            unit.TargetUID = target.GameUnitUID;
            unit.Right = direction > 0;
            unit.AttackTimer = Math.Max(0, unit.AttackTimer - dt);

            if (distance > stats.AttackRange && stats.MoveSpeed > 0)
            {
                var step = Math.Min(stats.MoveSpeed * dt, Math.Max(0, distance - stats.AttackRange));
                unit.X += direction * step;
                unit.SpeedX = Math.Abs(stats.MoveSpeed);
                unit.SavedPosX = unit.X;
                SetUnitState(unit, StateIds.Move);
                continue;
            }

            unit.SpeedX = 0;
            unit.SavedPosX = unit.X;
            SetUnitState(unit, StateIds.Attack);
            if (unit.AttackTimer <= 0)
            {
                unit.AttackTimer = stats.AttackCooldown;
                var beforeHp = Math.Max(0, target.Hp);
                var damage = ApplyDamageReduction(target, stats.Damage);
                var appliedDamage = Math.Min(beforeHp, damage);
                target.Hp = Math.Max(0, beforeHp - damage);
                target.TargetUID = unit.GameUnitUID;
                RecordBattleDamage(battleState, unit, target, appliedDamage);
                if (target.Hp <= 0) MarkDead(target, battleState, unit);
            }
        }

        CleanupDeadUnits(battleState);
        SettleOutcome(battleState);
    }

    private void NormalizeUnit(UnitState unit)
    {
        unit.Team = unit.Team == 0 ? (unit.Right ? 1 : 3) : unit.Team;
        unit.Hp = Math.Max(0, unit.Hp);
        unit.MaxHp = Math.Max(1, unit.MaxHp > 0 ? unit.MaxHp : Math.Max(unit.Hp, 1));
        unit.SavedPosX = unit.SavedPosX == 0 ? unit.X : unit.SavedPosX;
        unit.PlayState = unit.Hp <= 0 ? 2 : unit.PlayState == 0 ? 1 : unit.PlayState;
        unit.StateId = unit.StateId == 0 ? StateIds.Idle : unit.StateId;
        unit.StateChangeCount = unit.StateChangeCount == 0 ? 1 : unit.StateChangeCount;
        unit.Seed = unit.Seed == 0 ? 51 : unit.Seed;
        unit.UnitLevel = unit.UnitLevel <= 0 ? 1 : unit.UnitLevel;
    }

    private void HydrateStats(UnitState unit)
    {
        if (unit.AttackDamage <= 0) unit.AttackDamage = IsStatic(unit) ? options.StaticUnitDamage : options.DefaultUnitDamage;
        if (unit.AttackRange <= 0) unit.AttackRange = IsStatic(unit) ? options.StaticUnitAttackRange : options.DefaultUnitAttackRange;
        if (unit.MoveSpeed <= 0) unit.MoveSpeed = IsStatic(unit) ? 0 : options.DefaultUnitMoveSpeed;
        if (unit.AttackCooldown <= 0) unit.AttackCooldown = IsStatic(unit) ? options.StaticUnitAttackCooldown : options.DefaultUnitAttackCooldown;
        ApplyTacticUpdateStats(unit);
    }

    private UnitStats GetStats(UnitState unit)
    {
        HydrateStats(unit);
        return new UnitStats(
            Clamp(unit.AttackDamage, 1, 1000000),
            Clamp(unit.AttackRange, 1, 6000),
            Clamp(unit.MoveSpeed, 0, 1000),
            Clamp(unit.AttackCooldown, 0.2, 30),
            Clamp(unit.DamageReduceRate, 0, 9000),
            Clamp(unit.CostReturnRate, 0, StatRateScale));
    }

    private static void ApplyTacticUpdateStats(UnitState unit)
    {
        var tacticLevel = Math.Clamp(unit.TacticLevel, 0, 6);
        if (tacticLevel <= 0) return;
        var records = TacticUpdateStats.TryGetValue(unit.TacticGroup, out var groupRecords)
            ? groupRecords
            : TacticUpdateStats[0];
        double damageModifyRate = 0;
        double damageReduceRate = 0;
        double costReturnRate = 0;
        for (var index = 0; index < Math.Min(tacticLevel, records.Length); index++)
        {
            var record = records[index];
            switch (record.StatType)
            {
                case "NST_ATTACK_DAMAGE_MODIFY_G2":
                    damageModifyRate += record.StatValue;
                    break;
                case "NST_DAMAGE_REDUCE_RATE":
                    damageReduceRate += record.StatValue;
                    break;
                case "NST_COST_RETURN_RATE":
                    costReturnRate += record.StatValue;
                    break;
            }
        }

        if (!unit.TacticStatsApplied)
        {
            if (damageModifyRate > 0) unit.AttackDamage *= 1 + damageModifyRate / StatRateScale;
            unit.TacticStatsApplied = true;
        }
        unit.DamageReduceRate = Math.Max(unit.DamageReduceRate, damageReduceRate);
        unit.CostReturnRate = Math.Max(unit.CostReturnRate, costReturnRate);
    }

    private static double ApplyDamageReduction(UnitState target, double damage)
    {
        ApplyTacticUpdateStats(target);
        var rate = Clamp(target.DamageReduceRate, 0, 9000);
        return Math.Max(1, damage * (1 - rate / StatRateScale));
    }

    private static void ApplyCostReturn(UnitState unit, BattleState battleState)
    {
        if (unit.CostReturnApplied) return;
        ApplyTacticUpdateStats(unit);
        unit.CostReturnApplied = true;
        var rate = Clamp(unit.CostReturnRate, 0, StatRateScale);
        if (rate <= 0 || unit.Cost <= 0) return;
        var refund = unit.Cost * (rate / StatRateScale);
        if (unit.Team == 1)
        {
            battleState.RespawnCostA1 = Clamp(battleState.RespawnCostA1 + refund, 0, 10);
        }
        else
        {
            battleState.RespawnCostB1 = Clamp(battleState.RespawnCostB1 + refund, 0, 10);
        }
    }

    private static bool IsLive(UnitState unit)
    {
        return unit.PlayState != 0 && unit.PlayState != 2 && unit.Hp > 0;
    }

    private static UnitState? FindNearestEnemy(UnitState unit, IEnumerable<UnitState> units)
    {
        UnitState? best = null;
        var bestDistance = double.PositiveInfinity;
        foreach (var other in units)
        {
            if (!IsLive(other) || other.GameUnitUID == unit.GameUnitUID || other.Team == unit.Team) continue;
            var distance = Math.Abs(other.X - unit.X);
            if (distance < bestDistance)
            {
                best = other;
                bestDistance = distance;
            }
        }
        return best;
    }

    private static void MarkDead(UnitState unit, BattleState battleState, UnitState? attacker)
    {
        if (unit.PlayState is 0 or 2) return;
        unit.Hp = 0;
        unit.SpeedX = 0;
        unit.SpeedY = 0;
        unit.SpeedZ = 0;
        unit.TargetUID = attacker?.GameUnitUID ?? unit.TargetUID;
        unit.Respawn = false;
        unit.DeadTicks = 0;
        unit.PendingRemove = true;
        unit.PlayState = 2;
        SetUnitState(unit, StateIds.Dead);
        ApplyCostReturn(unit, battleState);
        RecordBattleDeath(battleState, unit, attacker);
    }

    private static void CleanupDeadUnits(BattleState battleState)
    {
        var kept = new List<UnitState>();
        foreach (var unit in battleState.Units)
        {
            if (unit.Hp <= 0 || unit.PlayState == 2)
            {
                if (unit.PlayState != 2) MarkDead(unit, battleState, null);
                unit.DeadTicks += 1;
                unit.SpeedX = 0;
                unit.Respawn = false;
                unit.Hp = 0;
                if (unit.DeadTicks >= 2)
                {
                    if (!battleState.RemovedUnitUIDs.Contains(unit.GameUnitUID))
                    {
                        battleState.RemovedUnitUIDs.Add(unit.GameUnitUID);
                        battleState.PendingDieUnitUIDs.Add(unit.GameUnitUID);
                    }
                    continue;
                }
            }
            kept.Add(unit);
        }
        battleState.Units = kept;
    }

    private static void SettleOutcome(BattleState battleState)
    {
        if (battleState.Finished) return;
        var live = battleState.Units.Where(IsLive).ToList();
        var livePlayers = live.Where(unit => unit.Team == 1).ToList();
        var liveEnemies = live.Where(unit => unit.Team != 1).ToList();
        if (liveEnemies.Count == 0)
        {
            FinishBattle(battleState, true);
        }
        else if (battleState.GameTime > 0 && livePlayers.Count == 0 && liveEnemies.Count > 0)
        {
            FinishBattle(battleState, false);
        }
        else if (battleState.RemainGameTime <= 0)
        {
            FinishBattle(battleState, false);
        }
    }

    private static void FinishBattle(BattleState battleState, bool win)
    {
        battleState.Finished = true;
        battleState.Win = win;
        battleState.GameState = new GameStateSync
        {
            State = 4,
            WinTeam = win ? 1 : 3,
            WaveId = battleState.GameState?.WaveId > 0 ? battleState.GameState.WaveId : 1
        };
        battleState.PendingGameStates.Add(battleState.GameState);
    }

    private static bool IsStatic(UnitState unit)
    {
        var role = unit.Role?.ToLowerInvariant() ?? "";
        return role is "ship" or "core" || unit.GameUnitUID <= 4;
    }

    private static void SetUnitState(UnitState unit, int stateId)
    {
        if (unit.StateId == stateId) return;
        unit.StateId = stateId;
        unit.StateChangeCount = ClampSByte(unit.StateChangeCount + 1);
    }

    private static int ClampSByte(int value)
    {
        if (value > 120) return -120;
        return value < -120 ? 0 : value;
    }

    private static double Clamp(double value, double min, double max)
    {
        return Math.Min(max, Math.Max(min, double.IsFinite(value) ? value : 0));
    }

    private static UnitState CloneUnit(UnitState unit)
    {
        return new UnitState
        {
            SourceUnitUID = unit.SourceUnitUID,
            UnitID = unit.UnitID,
            UnitStrID = unit.UnitStrID,
            GameUnitUID = unit.GameUnitUID,
            Team = unit.Team,
            Hp = unit.Hp,
            MaxHp = unit.MaxHp,
            X = unit.X,
            Z = unit.Z,
            JumpY = unit.JumpY,
            SavedPosX = unit.SavedPosX,
            SavedPosY = unit.SavedPosY,
            Right = unit.Right,
            PlayState = unit.PlayState,
            Respawn = unit.Respawn,
            StateId = unit.StateId,
            StateChangeCount = unit.StateChangeCount,
            SpeedX = unit.SpeedX,
            SpeedY = unit.SpeedY,
            SpeedZ = unit.SpeedZ,
            TargetUID = unit.TargetUID,
            SubTargetUID = unit.SubTargetUID,
            Seed = unit.Seed,
            AttackTimer = unit.AttackTimer,
            AttackDamage = unit.AttackDamage,
            AttackRange = unit.AttackRange,
            MoveSpeed = unit.MoveSpeed,
            AttackCooldown = unit.AttackCooldown,
            TacticLevel = unit.TacticLevel,
            TacticGroup = unit.TacticGroup,
            DamageReduceRate = unit.DamageReduceRate,
            CostReturnRate = unit.CostReturnRate,
            Cost = unit.Cost,
            CostReturnApplied = unit.CostReturnApplied,
            TacticStatsApplied = unit.TacticStatsApplied,
            DeadTicks = unit.DeadTicks,
            PendingRemove = unit.PendingRemove,
            DeathRecorded = unit.DeathRecorded,
            Role = unit.Role,
            ChangeUnitName = unit.ChangeUnitName,
            UnitLevel = unit.UnitLevel,
            IsSummonee = unit.IsSummonee,
            IsAssistUnit = unit.IsAssistUnit,
            IsLeader = unit.IsLeader,
            DamageSpeedXNegative = unit.DamageSpeedXNegative
        };
    }

    private static BattleUnitRecord? EnsureBattleRecord(BattleState battleState, UnitState unit)
    {
        if (unit.GameUnitUID <= 0) return null;
        if (!battleState.UnitRecords.TryGetValue(unit.GameUnitUID, out var record))
        {
            record = new BattleUnitRecord { GameUnitUID = unit.GameUnitUID };
            battleState.UnitRecords[unit.GameUnitUID] = record;
        }

        record.SourceUnitUID = string.IsNullOrWhiteSpace(record.SourceUnitUID) ? unit.SourceUnitUID : record.SourceUnitUID;
        record.Role = string.IsNullOrWhiteSpace(record.Role) ? unit.Role : record.Role;
        record.UnitId = record.UnitId > 0 ? record.UnitId : unit.UnitID;
        record.ChangeUnitName = string.IsNullOrWhiteSpace(record.ChangeUnitName) ? unit.ChangeUnitName : record.ChangeUnitName;
        record.UnitLevel = Math.Max(1, Math.Max(record.UnitLevel, unit.UnitLevel));
        record.IsSummonee = record.IsSummonee || unit.IsSummonee;
        record.IsAssistUnit = record.IsAssistUnit || unit.IsAssistUnit;
        record.IsLeader = record.IsLeader || unit.IsLeader;
        record.TeamType = NormalizeTeamType(record.TeamType != 0 ? record.TeamType : unit.Team);
        record.RecordSummonCount = Math.Max(1, record.RecordSummonCount);
        return record;
    }

    private static void RecordBattleDamage(BattleState battleState, UnitState attacker, UnitState target, double damage)
    {
        var appliedDamage = Math.Max(0, damage);
        if (appliedDamage <= 0) return;
        var attackerRecord = EnsureBattleRecord(battleState, attacker);
        var targetRecord = EnsureBattleRecord(battleState, target);
        if (attackerRecord != null) attackerRecord.RecordGiveDamage += appliedDamage;
        if (targetRecord != null) targetRecord.RecordTakeDamage += appliedDamage;
    }

    private static void AddBattleRecordPlayTime(BattleState battleState, UnitState unit, double delta)
    {
        var record = EnsureBattleRecord(battleState, unit);
        if (record == null) return;
        record.Playtime += Math.Max(0, delta);
    }

    private static void RecordBattleDeath(BattleState battleState, UnitState unit, UnitState? attacker)
    {
        if (unit.DeathRecorded) return;
        var record = EnsureBattleRecord(battleState, unit);
        if (record != null) record.RecordDieCount += 1;
        var attackerRecord = attacker == null ? null : EnsureBattleRecord(battleState, attacker);
        if (attacker != null && attackerRecord != null && attacker.GameUnitUID != unit.GameUnitUID) attackerRecord.RecordKillCount += 1;
        unit.DeathRecorded = true;
    }

    private static int NormalizeTeamType(int team)
    {
        return team switch
        {
            2 => 1,
            4 => 3,
            > 0 => team,
            _ => 1
        };
    }

    private static AutoDeployUnit CloneAutoDeploy(AutoDeployUnit unit)
    {
        return new AutoDeployUnit
        {
            UnitUID = unit.UnitUID,
            AssistUnit = unit.AssistUnit,
            GameUnitUIDs = unit.GameUnitUIDs.ToList(),
            X = unit.X,
            Z = unit.Z,
            Hp = unit.Hp,
            Right = unit.Right,
            PlayState = unit.PlayState,
            StateId = unit.StateId,
            StateChangeCount = unit.StateChangeCount,
            Seed = unit.Seed
        };
    }

    private static void NormalizeCollections(BattleState battleState, DynamicGameState? dynamicGame)
    {
        battleState.Units ??= [];
        battleState.PendingDieUnitUIDs ??= [];
        battleState.PendingDeckSyncs ??= [];
        battleState.PendingGameStates ??= [];
        battleState.PendingDungeonEvents ??= [];
        battleState.RemovedUnitUIDs ??= [];
        battleState.DeployedUnitUIDs ??= [];
        if (dynamicGame != null)
        {
            dynamicGame.UnitPools ??= new UnitPools();
            dynamicGame.UnitPools.Ordered ??= [];
            dynamicGame.UnitPools.UnassignedGameUnitUIDs ??= [];
            dynamicGame.UsedPooledGameUnitUIDs ??= [];
        }
    }

    private static T Read<T>(JsonElement data) where T : new()
    {
        if (data.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            return new T();
        }
        return data.Deserialize<T>(Json.Options) ?? new T();
    }

    private sealed record CombatStateIds(int Idle = 12, int Move = 13, int Attack = 45, int Dead = 18);

    private sealed record UnitStats(
        double Damage,
        double AttackRange,
        double MoveSpeed,
        double AttackCooldown,
        double DamageReduceRate,
        double CostReturnRate);

    private sealed record TacticRecord(string StatType, double StatValue);
}

internal class BattleCommandData
{
    public DynamicGameState? DynamicGame { get; set; }
    public BattleState? BattleState { get; set; }
}

internal sealed class DeployCommandData : BattleCommandData
{
    public RespawnReq? Req { get; set; }
}

internal sealed class PauseCommandData : BattleCommandData
{
    public PauseReq? Req { get; set; }
}

internal sealed class UnitSkillCommandData : BattleCommandData
{
    public UnitSkillReq? Req { get; set; }
}

internal sealed class ShipSkillCommandData : BattleCommandData
{
    public ShipSkillReq? Req { get; set; }
}

internal sealed class SyncCommandData : BattleCommandData
{
    public double? Delta { get; set; }
    public bool SkipSimulation { get; set; }
}

internal sealed class TimelineCommandData : BattleCommandData
{
    public double? Delta { get; set; }
    public int MaxFrames { get; set; } = 300;
    public int StartIndex { get; set; }
}

internal sealed class RespawnAckCommandData
{
    public string UnitUID { get; set; } = "";
    public bool AssistUnit { get; set; }
}

internal sealed class SyntheticSyncCommandData
{
    public double GameTime { get; set; }
}
