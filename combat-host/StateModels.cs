namespace RevivalSide.CombatHost;

public sealed class StartBattleData
{
    public GameLoadReq Req { get; set; } = new();
    public StageData Stage { get; set; } = new();
    public long GameUID { get; set; }
    public string GameLoadAckPayloadBase64 { get; set; } = "";
}

public sealed class GameLoadReq
{
    public int StageID { get; set; }
    public int DungeonID { get; set; }
    public int GameType { get; set; }
    public long RaidUID { get; set; }
    public int RaidLevel { get; set; }
    public double RaidCurHP { get; set; }
    public double RaidMaxHP { get; set; }
}

public sealed class StageData
{
    public int StageId { get; set; }
    public int DungeonID { get; set; }
    public long RaidUID { get; set; }
    public int RaidLevel { get; set; }
    public int MapID { get; set; }
    public int GameType { get; set; }
    public string MiscMode { get; set; } = "";
    public int PalaceID { get; set; }
    public int FierceBossId { get; set; }
    public int TrimId { get; set; }
    public int TrimLevel { get; set; }
    public int DefenceTempletId { get; set; }
    public int ExploreID { get; set; }
    public int ExploreStageId { get; set; }
    public int PhaseId { get; set; }
    public int PhaseIndex { get; set; }
    public int EventDeckId { get; set; }
    public bool UsesHybridEventDeck { get; set; }
    public bool EventDeckFreeShipSlot { get; set; }
    public List<int> BattleConditionIds { get; set; } = [];
    public int FierceBasePoint { get; set; }
    public int FierceMaxDamagePoint { get; set; }
    public int FierceMaxTimePoint { get; set; }
    public int FiercePenaltyRate { get; set; }
    public List<int> FiercePenaltyIds { get; set; } = [];
    public int GameUnitUIDIndex { get; set; } = 18;
    public double InitialGameTime { get; set; } = 4;
    public double InitialRemainGameTime { get; set; } = 180;
    public double RespawnCostA1 { get; set; } = 10;
    public double RespawnCostB1 { get; set; } = 10;
    public GameStateSync GameState { get; set; } = new();
    public List<UnitState> InitialUnits { get; set; } = [];
    public List<AutoDeployUnit> AutoDeployUnits { get; set; } = [];
    public List<List<int>> DeployableGameUnitUIDGroups { get; set; } = [];
    public List<int> EventDeckFreeUnitSlots { get; set; } = [];
    public PlayerDeckData? PlayerDeck { get; set; }
}

public sealed class PlayerDeckData
{
    public string UserUid { get; set; } = "0";
    public string Nickname { get; set; } = "";
    public int UserLevel { get; set; } = 1;
    public int DeckType { get; set; } = 1;
    public int DeckIndex { get; set; }
    public int LeaderIndex { get; set; } = -1;
    public string LeaderUnitUid { get; set; } = "0";
    public string ShipUid { get; set; } = "0";
    public int ShipUnitId { get; set; }
    public int ShipLevel { get; set; } = 1;
    public int ShipSkinId { get; set; }
    public string OperatorUid { get; set; } = "0";
    public int OperatorId { get; set; }
    public int OperatorLevel { get; set; } = 1;
    public List<PlayerEquipItemData> EquipItems { get; set; } = [];
    public List<PlayerUnitData> Units { get; set; } = [];
}

public sealed class PlayerEquipItemData
{
    public string EquipUid { get; set; } = "0";
    public int ItemEquipId { get; set; }
    public int EnchantLevel { get; set; }
    public int EnchantExp { get; set; }
    public List<PlayerEquipStatData> Stats { get; set; } = [];
    public string OwnerUnitUid { get; set; } = "-1";
    public bool Locked { get; set; }
    public int Precision { get; set; }
    public int Precision2 { get; set; }
    public int SetOptionId { get; set; }
    public int ImprintUnitId { get; set; }
    public List<PlayerPotentialOptionData> PotentialOptions { get; set; } = [];
}

public sealed class PlayerEquipStatData
{
    public string Type { get; set; } = "NST_RANDOM";
    public float Value { get; set; }
    public float LevelValue { get; set; }
}

public sealed class PlayerPotentialOptionData
{
    public int OptionKey { get; set; }
    public string StatType { get; set; } = "NST_RANDOM";
    public List<PlayerPotentialSocketData?> Sockets { get; set; } = [];
    public int PrecisionChangeCount { get; set; }
}

public sealed class PlayerPotentialSocketData
{
    public float StatValue { get; set; }
    public int Precision { get; set; }
}

public sealed class PlayerUnitData
{
    public int SlotIndex { get; set; }
    public string UnitUid { get; set; } = "0";
    public int UnitId { get; set; }
    public int Level { get; set; } = 1;
    public int SkinId { get; set; }
    public int LimitBreakLevel { get; set; }
    public int TacticLevel { get; set; }
    public int TacticGroup { get; set; }
    public List<int> SkillLevels { get; set; } = [];
    public List<string> EquipItemUids { get; set; } = [];
}

public sealed class DynamicGameState
{
    public int StageID { get; set; }
    public int DungeonID { get; set; }
    public long RaidUID { get; set; }
    public int RaidLevel { get; set; }
    public int MapID { get; set; }
    public int GameType { get; set; }
    public string MiscMode { get; set; } = "";
    public int PalaceID { get; set; }
    public int FierceBossId { get; set; }
    public int TrimId { get; set; }
    public int TrimLevel { get; set; }
    public int DefenceTempletId { get; set; }
    public int ExploreID { get; set; }
    public int ExploreStageId { get; set; }
    public int PhaseId { get; set; }
    public int PhaseIndex { get; set; }
    public List<int> BattleConditionIds { get; set; } = [];
    public int FierceBasePoint { get; set; }
    public int FierceMaxDamagePoint { get; set; }
    public int FierceMaxTimePoint { get; set; }
    public int FiercePenaltyRate { get; set; }
    public List<int> FiercePenaltyIds { get; set; } = [];
    public long GameUID { get; set; }
    public int GameUnitUIDIndex { get; set; } = 18;
    public List<List<int>> DeployableGameUnitUIDGroups { get; set; } = [];
    public List<int> AssignedGameUnitUIDs { get; set; } = [];
    public bool InitialUnitsSent { get; set; }
    public bool Tutorial { get; set; }
    public bool ManagedCombat { get; set; }
    public string ManagedSessionId { get; set; } = "";
    public int? GameSpeedType { get; set; }
    public int? AutoSkillType { get; set; }
    public bool? AutoRespawnEnabled { get; set; }
    public UnitPools UnitPools { get; set; } = new();
    public HashSet<int> UsedPooledGameUnitUIDs { get; set; } = [];
}

public sealed class UnitPools
{
    public List<UnitPool> Ordered { get; set; } = [];
    public List<int> UnassignedGameUnitUIDs { get; set; } = [];
}

public sealed class UnitPool
{
    public string UnitUID { get; set; } = "";
    public int UnitID { get; set; }
    public int TacticLevel { get; set; }
    public int TacticGroup { get; set; }
    public double Cost { get; set; }
    public List<int> GameUnitUIDs { get; set; } = [];
}

public sealed class BattleState
{
    public int StageId { get; set; }
    public long GameUID { get; set; }
    public List<UnitState> Units { get; set; } = [];
    public long StartTime { get; set; }
    public double GameTime { get; set; }
    public double AbsoluteGameTime { get; set; }
    public double RemainGameTime { get; set; } = 180;
    public double RespawnCostA1 { get; set; } = 10;
    public double RespawnCostB1 { get; set; } = 10;
    public GameStateSync GameState { get; set; } = new();
    public List<AutoDeployUnit> AutoDeployUnits { get; set; } = [];
    public HashSet<string> DeployedUnitUIDs { get; set; } = [];
    public List<int> PendingDieUnitUIDs { get; set; } = [];
    public List<DeckSync> PendingDeckSyncs { get; set; } = [];
    public List<GameStateSync> PendingGameStates { get; set; } = [];
    public List<DungeonEventSync> PendingDungeonEvents { get; set; } = [];
    public HashSet<int> RemovedUnitUIDs { get; set; } = [];
    public Dictionary<int, BattleUnitRecord> UnitRecords { get; set; } = [];
    public int DeployCount { get; set; }
    public bool Finished { get; set; }
    public bool Win { get; set; }
    public double RaidBossInitHp { get; set; }
    public double RaidBossCurHp { get; set; }
    public double RaidBossMaxHp { get; set; }
    public double RaidBossDamage { get; set; }
    public double RaidBossDamageRatio { get; set; }
    public bool RaidBossKilled { get; set; }
    public double BossHpPercent { get; set; } = 100;
    public double BossDamageRatio { get; set; }
    public bool BossKilled { get; set; }
    public int? GameSpeedType { get; set; }
    public int? AutoSkillType { get; set; }
    public bool? AutoRespawnEnabled { get; set; }
}

public sealed class AutoDeployUnit
{
    public string UnitUID { get; set; } = "";
    public bool AssistUnit { get; set; }
    public List<int> GameUnitUIDs { get; set; } = [];
    public double X { get; set; }
    public double Z { get; set; }
    public double Hp { get; set; } = 1989;
    public bool Right { get; set; } = true;
    public int PlayState { get; set; } = 1;
    public int StateId { get; set; } = 13;
    public int StateChangeCount { get; set; } = 1;
    public int Seed { get; set; } = 51;
}

public sealed class RespawnReq
{
    public string UnitUID { get; set; } = "";
    public int UnitID { get; set; }
    public string UnitStrID { get; set; } = "";
    public bool AssistUnit { get; set; }
    public double RespawnPosX { get; set; }
    public double GameTime { get; set; }
    public double Hp { get; set; }
}

public sealed class PauseReq
{
    public bool IsPause { get; set; }
    public bool IsPauseEvent { get; set; }
}

public sealed class UnitSkillReq
{
    public int GameUnitUID { get; set; }
}

public sealed class ShipSkillReq
{
    public int GameUnitUID { get; set; }
    public int ShipSkillID { get; set; }
    public double SkillPosX { get; set; }
}

public sealed class UnitState
{
    public string SourceUnitUID { get; set; } = "";
    public int UnitID { get; set; }
    public string UnitStrID { get; set; } = "";
    public string ChangeUnitName { get; set; } = "";
    public int UnitLevel { get; set; } = 1;
    public bool IsSummonee { get; set; }
    public bool IsAssistUnit { get; set; }
    public bool IsLeader { get; set; }
    public int GameUnitUID { get; set; }
    public int Team { get; set; }
    public double Hp { get; set; }
    public double MaxHp { get; set; }
    public double X { get; set; }
    public double Z { get; set; }
    public double JumpY { get; set; }
    public double SavedPosX { get; set; }
    public double SavedPosY { get; set; }
    public bool Right { get; set; } = true;
    public int PlayState { get; set; } = 1;
    public bool Respawn { get; set; }
    public int StateId { get; set; } = 12;
    public int StateChangeCount { get; set; } = 1;
    public double SpeedX { get; set; }
    public double SpeedY { get; set; }
    public double SpeedZ { get; set; }
    public int TargetUID { get; set; }
    public int SubTargetUID { get; set; }
    public int Seed { get; set; } = 51;
    public double AttackTimer { get; set; }
    public double AttackDamage { get; set; }
    public double AttackRange { get; set; }
    public double MoveSpeed { get; set; }
    public double AttackCooldown { get; set; }
    public int TacticLevel { get; set; }
    public int TacticGroup { get; set; }
    public double DamageReduceRate { get; set; }
    public double CostReturnRate { get; set; }
    public double Cost { get; set; }
    public bool CostReturnApplied { get; set; }
    public bool TacticStatsApplied { get; set; }
    public int DeadTicks { get; set; }
    public bool PendingRemove { get; set; }
    public bool DeathRecorded { get; set; }
    public string Role { get; set; } = "";
    public bool DamageSpeedXNegative { get; set; }
}

public sealed class BattleUnitRecord
{
    public int GameUnitUID { get; set; }
    public string SourceUnitUID { get; set; } = "";
    public string Role { get; set; } = "";
    public int UnitId { get; set; }
    public string ChangeUnitName { get; set; } = "";
    public int UnitLevel { get; set; } = 1;
    public bool IsSummonee { get; set; }
    public bool IsAssistUnit { get; set; }
    public bool IsLeader { get; set; }
    public int TeamType { get; set; } = 1;
    public double RecordGiveDamage { get; set; }
    public double RecordTakeDamage { get; set; }
    public double RecordHeal { get; set; }
    public int RecordSummonCount { get; set; } = 1;
    public int RecordDieCount { get; set; }
    public int RecordKillCount { get; set; }
    public double Playtime { get; set; }
}

public sealed class BattleSimState
{
    public int Tick { get; set; }
    public double GameTime { get; set; }
    public double AbsoluteGameTime { get; set; }
    public double RemainGameTime { get; set; } = 180;
    public int PlayerUnitCount { get; set; }
    public int SpawnGroupIndex { get; set; }
    public List<List<int>> SpawnGroups { get; set; } = [];
    public double RespawnCostA1 { get; set; } = 10;
    public double RespawnCostB1 { get; set; } = 10;
    public double UsedRespawnCostA1 { get; set; }
    public double UsedRespawnCostB1 { get; set; }
    public List<DeckSync> PendingDeckSyncs { get; set; } = [];
    public List<List<int>> PendingDieUnitUIDs { get; set; } = [];
    public List<GameStateSync> PendingGameStates { get; set; } = [];
    public bool Finished { get; set; }
    public bool FinishSent { get; set; }
    public bool Win { get; set; }
    public double TargetHp { get; set; } = 2800;
    public int TargetUID { get; set; } = 2;
    public double TargetX { get; set; } = 1180;
    public List<UnitState> Units { get; set; } = [];
}

public sealed class DeckSync
{
    public int Team { get; set; } = 1;
    public int UnitDeckIndex { get; set; } = -1;
    public string UnitDeckUID { get; set; } = "-1";
    public string DeckUsedAddUnitUID { get; set; } = "-1";
    public int DeckUsedRemoveIndex { get; set; } = -1;
    public string DeckTombAddUnitUID { get; set; } = "-1";
    public int AutoRespawnIndex { get; set; } = -1;
    public string NextDeckUnitUID { get; set; } = "-1";
}

public sealed class GameStateSync
{
    public int State { get; set; } = 3;
    public int WinTeam { get; set; }
    public int WaveId { get; set; } = 1;
}

public sealed class DungeonEventSync
{
    public int ActionType { get; set; }
    public int EventId { get; set; }
    public int ActionValue { get; set; }
    public string ActionString { get; set; } = "";
    public bool Pause { get; set; }
    public int Team { get; set; }
}
