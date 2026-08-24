const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const JOIN_LOBBY_ACK_PACKET_ID = 205;
const OFFICIAL_LOCAL_STATE_SCHEMA_VERSION = 4;
const DEFAULT_NEXT_USER_UID = "1000000001";
const DEFAULT_NEXT_FRIEND_CODE = "10000001";
const CRYPTO_MASKS = Object.freeze([
  14170986657190717782n,
  15546886188969944187n,
  15913139373130964729n,
  3486779174683840252n,
]);

function createOfficialProfileImporter(options = {}) {
  const config = {
    rootDir: path.resolve(options.rootDir || path.join(__dirname, "..", "..")),
    captureDir: path.resolve(options.captureDir || path.join(__dirname, "..", "..", "server-data", "captured-game-flow")),
    userDb: options.userDb,
    combatHandler: options.combatHandler,
    ensureUserDefaults: options.ensureUserDefaults || ((user) => user),
    makeAccessToken: options.makeAccessToken || (() => crypto.randomBytes(16).toString("hex")),
    makeToken: options.makeToken || ((prefix) => `${prefix}_${crypto.randomBytes(24).toString("hex")}`),
  };

  function listSources() {
    const manifestPath = path.join(config.captureDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return (manifest.server || [])
      .map((entry, index) => buildSource(entry, index + 1))
      .filter(Boolean)
      .sort((left, right) => right.index - left.index);
  }

  function importLatest(options = {}) {
    const sources = listSources();
    if (!sources.length) {
      throw new Error(`No JOIN_LOBBY_ACK payloads found in ${config.captureDir}.`);
    }
    return importSource({ ...options, sourceId: options.sourceId || sources[0].id });
  }

  function importSource(options = {}) {
    const source = resolveSource(options);
    const capturedPayload = fs.readFileSync(source.payloadPath);
    const payloadSha256 = sha256(capturedPayload);
    const decodedPayload = decodeCapturedPayload(capturedPayload, source.compressed);
    const extracted = extractProfile(decodedPayload);
    const profile = buildSwitchableProfile(extracted.profile, {
      source,
      payloadSha256,
      packetType: extracted.packetType,
      summary: extracted.summary,
      preserveOfficialUid: options.preserveOfficialUid === true,
      preserveOfficialFriendCode: options.preserveOfficialFriendCode === true,
      switchActive: options.switchActive === true,
      updateExisting: options.updateExisting !== false,
      nicknameSuffix: options.nicknameSuffix,
    });

    return {
      user: profile,
      source: summarizeSource(source),
      payloadSha256,
      packetType: extracted.packetType,
      summary: extracted.summary,
      counts: buildCounts(profile),
      switched: options.switchActive === true,
    };
  }

  function buildSource(entry, index) {
    if (!entry || Number(entry.packetId) !== JOIN_LOBBY_ACK_PACKET_ID || !entry.payloadFile) return null;
    const payloadPath = path.resolve(config.captureDir, entry.payloadFile);
    if (!isInside(config.captureDir, payloadPath) || !fs.existsSync(payloadPath)) return null;
    return {
      id: `server:${index}`,
      index,
      packetId: Number(entry.packetId),
      payloadFile: entry.payloadFile,
      payloadPath,
      payloadSize: Number(entry.payloadSize || fs.statSync(payloadPath).size || 0),
      compressed: entry.compressed === true,
      sha256: String(entry.sha256 || ""),
      stream: entry.stream,
      frame: entry.frame,
      time: entry.time,
    };
  }

  function resolveSource(options) {
    if (options.payloadPath) {
      const payloadPath = path.resolve(String(options.payloadPath));
      if (!isInside(config.captureDir, payloadPath)) {
        throw new Error("JOIN_LOBBY_ACK payload path must stay inside the captured-game-flow directory.");
      }
      if (!fs.existsSync(payloadPath)) throw new Error(`JOIN_LOBBY_ACK payload not found: ${payloadPath}`);
      return {
        id: `file:${path.basename(payloadPath)}`,
        index: 0,
        packetId: JOIN_LOBBY_ACK_PACKET_ID,
        payloadFile: path.relative(config.captureDir, payloadPath),
        payloadPath,
        payloadSize: fs.statSync(payloadPath).size,
        compressed: options.compressed === true,
      };
    }

    const sources = listSources();
    const sourceId = String(options.sourceId || "").trim();
    const source = sourceId ? sources.find((item) => item.id === sourceId) : sources[0];
    if (!source) {
      throw new Error(sourceId ? `JOIN_LOBBY_ACK source ${sourceId} was not found.` : "No JOIN_LOBBY_ACK source was found.");
    }
    return source;
  }

  function extractProfile(payload) {
    if (!config.combatHandler || typeof config.combatHandler.extractJoinLobbyProfile !== "function") {
      throw new Error("Official profile import requires the C# combat host profile extractor.");
    }
    const result = config.combatHandler.extractJoinLobbyProfile(payload);
    if (!result || !result.ok || !result.profile) {
      throw new Error(result && result.error ? result.error : "JOIN_LOBBY_ACK profile extraction failed.");
    }
    return result;
  }

  function buildSwitchableProfile(extracted, options) {
    const userDb = ensureUserDb(config.userDb);
    const now = new Date().toISOString();
    const officialUid = nonEmpty(extracted.userUid);
    const targetUid = chooseLocalUserUid(userDb, extracted, options);
    const existing = userDb.users[targetUid] || null;
    const targetFriendCode = chooseLocalFriendCode(userDb, targetUid, extracted.friendCode, options);
    const profile = deepClone(extracted);
    const originalNickname = nonEmpty(profile.nickname) || "OfficialProfile";

    profile.userUid = targetUid;
    profile.friendCode = targetFriendCode;
    profile.nickname = nonEmpty(options.nicknameSuffix) ? `${originalNickname} ${options.nicknameSuffix}` : originalNickname;
    profile.createdAt = existing && existing.createdAt ? existing.createdAt : now;
    profile.importedAt = now;
    profile.lastLoginAt = "";
    profile.lastJoinAt = "";
    profile.accessToken = existing && existing.accessToken ? existing.accessToken : config.makeAccessToken();
    profile.reconnectKey = existing && existing.reconnectKey ? existing.reconnectKey : config.makeToken("rck");
    profile.lastTokenIssuedAt = existing && existing.lastTokenIssuedAt ? existing.lastTokenIssuedAt : now;
    profile.officialImport = {
      ...(profile.officialImport && typeof profile.officialImport === "object" ? profile.officialImport : {}),
      importedAt: now,
      source: "join_lobby_ack",
      sourceId: options.source.id,
      sourcePayloadFile: options.source.payloadFile,
      sourcePacketSha256: options.payloadSha256,
      packetType: options.packetType || "",
      summary: options.summary || "",
      officialUserUid: officialUid,
      officialFriendCode: nonEmpty(extracted.friendCode),
      localUserUid: targetUid,
      localFriendCode: targetFriendCode,
    };
    applyOfficialSnapshotToLocalProfile(profile);
    profile.importedOfficialProfile = true;

    retargetUnitOwnership(profile, targetUid);
    config.ensureUserDefaults(profile);
    retargetUnitOwnership(profile, targetUid);

    userDb.users[targetUid] = profile;
    if (options.switchActive) userDb.activeUserUid = targetUid;
    bumpNextNumericId(userDb, "nextUserUid", targetUid);
    bumpNextNumericId(userDb, "nextFriendCode", targetFriendCode);
    return profile;
  }

  function chooseLocalUserUid(userDb, extracted, options) {
    const officialUid = nonEmpty(extracted.userUid);
    if (options.updateExisting && officialUid) {
      const existingImported = Object.values(userDb.users || {}).find(
        (user) =>
          user &&
          user.officialImport &&
          String(user.officialImport.officialUserUid || "") === officialUid
      );
      if (existingImported && existingImported.userUid) return String(existingImported.userUid);
    }

    if (options.preserveOfficialUid && officialUid) {
      const existing = userDb.users[officialUid];
      if (!existing || isSameOfficialImport(existing, officialUid)) return officialUid;
    }

    return allocateNumericId(userDb, "nextUserUid", DEFAULT_NEXT_USER_UID, (candidate) => userDb.users[String(candidate)]);
  }

  function chooseLocalFriendCode(userDb, targetUid, officialFriendCode, options) {
    const preferred = nonEmpty(officialFriendCode);
    if (options.preserveOfficialFriendCode && preferred) {
      const conflict = Object.values(userDb.users || {}).find(
        (user) => user && String(user.userUid || "") !== targetUid && String(user.friendCode || "") === preferred
      );
      if (!conflict) return preferred;
    }
    const existing = userDb.users[targetUid];
    if (existing && existing.friendCode) return String(existing.friendCode);
    return allocateNumericId(userDb, "nextFriendCode", DEFAULT_NEXT_FRIEND_CODE, (candidate) =>
      Object.values(userDb.users || {}).some((user) => user && String(user.friendCode || "") === String(candidate))
    );
  }

  return {
    listSources,
    importLatest,
    importSource,
  };
}

function summarizeSource(source) {
  return {
    id: source.id,
    index: source.index,
    packetId: source.packetId,
    payloadFile: source.payloadFile,
    payloadSize: source.payloadSize,
    compressed: source.compressed === true,
    sha256: source.sha256 || "",
    stream: source.stream,
    frame: source.frame,
    time: source.time,
  };
}

function ensureUserDb(userDb) {
  if (!userDb || typeof userDb !== "object") throw new Error("User database is unavailable.");
  userDb.users = userDb.users && typeof userDb.users === "object" ? userDb.users : {};
  userDb.nextUserUid = String(userDb.nextUserUid || DEFAULT_NEXT_USER_UID);
  userDb.nextFriendCode = String(userDb.nextFriendCode || DEFAULT_NEXT_FRIEND_CODE);
  return userDb;
}

function isSameOfficialImport(user, officialUid) {
  return Boolean(
    user &&
      user.officialImport &&
      String(user.officialImport.officialUserUid || "") === String(officialUid || "")
  );
}

function retargetUnitOwnership(profile, userUid) {
  const army = profile.army && typeof profile.army === "object" ? profile.army : null;
  if (!army) return;
  for (const bucket of ["units", "ships", "trophies"]) {
    for (const unit of Object.values((army[bucket] && typeof army[bucket] === "object" ? army[bucket] : {}) || {})) {
      if (unit && typeof unit === "object") unit.userUid = userUid;
    }
  }
}

function applyOfficialSnapshotToLocalProfile(profile, options = {}) {
  if (!profile || typeof profile !== "object") return { changed: false, importedSystems: {} };
  const snapshot = firstObject(profile.officialSnapshot, profile.officialJoinLobbySnapshot, profile.officialPacketSnapshot);
  if (!snapshot) return { changed: false, importedSystems: {} };

  const officialImport = ensureObject(profile, "officialImport");
  if (
    options.migrateExisting === true &&
    Number(officialImport.localStateSchemaVersion || 0) >= OFFICIAL_LOCAL_STATE_SCHEMA_VERSION
  ) {
    return { changed: false, importedSystems: officialImport.importedSystems || {} };
  }

  const packet = firstObject(readAny(snapshot, ["packet", "Packet"]), snapshot);
  const userData = firstObject(readAny(snapshot, ["userData", "UserData"]), readAny(packet, ["userData", "UserData"]));
  const systems = {
    birthDayData: firstPresent(
      readAny(userData, ["m_BirthDayData", "birthDayData", "birthdayData", "BirthDayData"]),
      readAny(packet, ["m_BirthDayData", "birthDayData", "birthdayData", "BirthDayData"])
    ),
    backgroundInfo: firstPresent(
      readAny(snapshot, ["backGroundInfo", "backgroundInfo"]),
      readAny(userData, ["backGroundInfo", "backgroundInfo"]),
      readAny(packet, ["backGroundInfo", "backgroundInfo"])
    ),
    jukeboxData: firstPresent(
      readAny(userData, ["m_JukeboxData", "jukeboxData", "JukeboxData"]),
      readAny(packet, ["m_JukeboxData", "jukeboxData", "JukeboxData"])
    ),
    worldMapData: firstPresent(
      readAny(userData, ["m_WorldmapData", "m_WorldMapData", "worldMapData", "worldmapData", "WorldmapData"]),
      readAny(packet, ["m_WorldmapData", "m_WorldMapData", "worldMapData", "worldmapData", "WorldmapData"])
    ),
    diveGameData: firstPresent(
      readAny(userData, ["m_DiveGameData", "diveGameData", "DiveGameData"]),
      readAny(packet, ["m_DiveGameData", "diveGameData", "DiveGameData"])
    ),
    diveClearData: firstPresent(
      readAny(userData, ["m_DiveClearData", "diveClearData", "DiveClearData"]),
      readAny(packet, ["m_DiveClearData", "diveClearData", "DiveClearData"])
    ),
    diveHistoryData: firstPresent(
      readAny(userData, ["m_DiveHistoryData", "diveHistoryData", "DiveHistoryData"]),
      readAny(packet, ["m_DiveHistoryData", "diveHistoryData", "DiveHistoryData"])
    ),
    missionData: firstPresent(
      readAny(userData, ["m_MissionData", "missionData", "MissionData"]),
      readAny(packet, ["m_MissionData", "missionData", "MissionData"])
    ),
    armyData: firstPresent(
      readAny(userData, ["m_ArmyData", "armyData", "ArmyData"]),
      readAny(packet, ["m_ArmyData", "armyData", "ArmyData"])
    ),
    inventoryData: firstPresent(
      readAny(userData, ["m_InventoryData", "inventoryData", "InventoryData"]),
      readAny(packet, ["m_InventoryData", "inventoryData", "InventoryData"])
    ),
    shopData: firstPresent(
      readAny(userData, ["m_ShopData", "shopData", "ShopData"]),
      readAny(packet, ["m_ShopData", "shopData", "ShopData"])
    ),
    totalPaidAmount: firstPresent(
      readAny(packet, ["totalPaidAmount", "TotalPaidAmount"]),
      readAny(userData, ["totalPaidAmount", "TotalPaidAmount"])
    ),
    counterCaseData: firstPresent(
      readAny(userData, ["m_dicNKMCounterCaseData", "counterCaseData", "CounterCaseData"]),
      readAny(packet, ["m_dicNKMCounterCaseData", "counterCaseData", "CounterCaseData"])
    ),
    craftData: firstPresent(
      readAny(userData, ["m_CraftData", "craftData", "CraftData"]),
      readAny(packet, ["m_CraftData", "craftData", "CraftData"])
    ),
    attendanceData: firstPresent(
      readAny(userData, ["m_AttendanceData", "attendanceData", "AttendanceData"]),
      readAny(packet, ["m_AttendanceData", "attendanceData", "AttendanceData"])
    ),
    shadowPalaceData: firstPresent(
      readAny(userData, ["m_ShadowPalace", "shadowPalace", "ShadowPalace"]),
      readAny(packet, ["m_ShadowPalace", "shadowPalace", "ShadowPalace"])
    ),
    episodeCompleteData: firstPresent(
      readAny(userData, ["m_dicEpisodeCompleteData", "episodeCompleteData", "EpisodeCompleteData"]),
      readAny(packet, ["m_dicEpisodeCompleteData", "episodeCompleteData", "EpisodeCompleteData"])
    ),
    completedUnitMissions: firstPresent(
      readAny(packet, ["completedUnitMissions", "CompletedUnitMissions"]),
      readAny(snapshot, ["completedUnitMissions", "CompletedUnitMissions"])
    ),
    rewardEnableUnitMissions: firstPresent(
      readAny(packet, ["rewardEnableUnitMissions", "RewardEnableUnitMissions"]),
      readAny(snapshot, ["rewardEnableUnitMissions", "RewardEnableUnitMissions"])
    ),
    officeState: firstPresent(
      readAny(snapshot, ["officeState", "OfficeState"]),
      readAny(packet, ["officeState", "OfficeState"]),
      readAny(userData, ["officeState", "OfficeState", "m_OfficeState"])
    ),
    contractState: firstPresent(
      readAny(packet, ["contractState", "ContractState"]),
      readAny(snapshot, ["contractState", "ContractState"])
    ),
    contractBonusState: firstPresent(
      readAny(packet, ["contractBonusState", "ContractBonusState"]),
      readAny(snapshot, ["contractBonusState", "ContractBonusState"])
    ),
    selectableContractState: firstPresent(
      readAny(packet, ["selectableContractState", "SelectableContractState"]),
      readAny(snapshot, ["selectableContractState", "SelectableContractState"])
    ),
    customPickupContracts: firstPresent(
      readAny(packet, ["customPickupContracts", "CustomPickupContracts"]),
      readAny(snapshot, ["customPickupContracts", "CustomPickupContracts"])
    ),
  };

  const importedSystems = {};
  officialImport.rawSnapshotIncluded = true;
  officialImport.rawSnapshotSchemaVersion = Number(readAny(snapshot, ["schemaVersion", "SchemaVersion"]) || 1) || 1;
  officialImport.rawSnapshotCapturedAt = nonEmpty(readAny(snapshot, ["capturedAt", "CapturedAt"])) || officialImport.capturedAt || "";

  const officialLevel = finiteInt(readAny(userData, ["m_UserLevel", "userLevel", "level"]), 0);
  if (officialLevel > 0) {
    profile.level = officialLevel;
    profile.exp = String(Math.max(0, finiteInt(readAny(userData, ["m_lUserLevelEXP", "userLevelExp", "exp"]), 0)));
    profile.totalExp = "0";
    importedSystems.accountProgress = true;
  }

  const birthDayData = normalizeImportedBirthDayData(systems.birthDayData);
  if (birthDayData) {
    profile.birthDayData = birthDayData;
    importedSystems.birthday = true;
  }

  const backgroundInfo = normalizeImportedBackgroundInfo(systems.backgroundInfo);
  const jukeboxBgmIds = normalizeImportedJukeboxData(systems.jukeboxData);
  if (backgroundInfo || jukeboxBgmIds) {
    const lobbyState = ensureObject(profile, "lobbyCustomization");
    if (backgroundInfo) lobbyState.backgroundInfo = backgroundInfo;
    if (jukeboxBgmIds) lobbyState.jukeboxBgmIds = jukeboxBgmIds;
    lobbyState.officialImported = true;
    importedSystems.lobby = true;
  }

  if (systems.worldMapData || systems.diveGameData || systems.diveClearData || systems.diveHistoryData) {
    const worldMap = ensureObject(profile, "worldMap");
    worldMap.officialImported = true;
    if (systems.worldMapData) {
      worldMap.officialWorldMapData = systems.worldMapData;
      const importedWorldMap = normalizeImportedWorldMapData(systems.worldMapData);
      if (importedWorldMap) {
        worldMap.cities = importedWorldMap.cities;
        worldMap.collectLastResetDate = importedWorldMap.collectLastResetDate;
      }
      importedSystems.worldMap = true;
    }
    if (systems.diveGameData) {
      worldMap.dive = worldMap.dive && typeof worldMap.dive === "object" ? worldMap.dive : {};
      worldMap.dive.officialGameData = systems.diveGameData;
      worldMap.dive.officialImported = true;
      importedSystems.dive = true;
    }
    const diveClearStages = collectPositiveInts(systems.diveClearData, { idFields: ["stageID", "stageId", "m_StageID", "diveStageID", "diveStageId"] });
    if (diveClearStages.length) {
      worldMap.diveClearStages = mergePositiveInts(worldMap.diveClearStages, diveClearStages);
      importedSystems.dive = true;
    }
    const diveHistoryStages = collectPositiveInts(systems.diveHistoryData, { idFields: ["stageID", "stageId", "m_StageID", "diveStageID", "diveStageId"] });
    if (diveHistoryStages.length) {
      worldMap.diveHistoryStages = mergePositiveInts(worldMap.diveHistoryStages, diveHistoryStages);
      importedSystems.dive = true;
    }
  }

  if (systems.officeState) {
    profile.hasOffice = true;
    const office = ensureObject(profile, "office");
    office.officialImported = true;
    office.officialState = systems.officeState;
    const importedOffice = normalizeImportedOfficeState(systems.officeState);
    if (importedOffice) {
      office.openedSectionIds = importedOffice.openedSectionIds;
      office.rooms = importedOffice.rooms;
      office.interiors = importedOffice.interiors;
      office.postState = importedOffice.postState;
      office.presets = importedOffice.presets;
    }
    importedSystems.dorm = true;
    importedSystems.office = true;
  }

  const contractStates = normalizeImportedContractStates(systems.contractState);
  const contractBonusStates = normalizeImportedContractBonusStates(systems.contractBonusState);
  const selectableContractState = normalizeImportedSelectableContractState(systems.selectableContractState);
  const customPickupContracts = normalizeImportedCustomPickupContracts(systems.customPickupContracts);
  if (
    Object.keys(contractStates).length ||
    Object.keys(contractBonusStates).length ||
    selectableContractState ||
    Object.keys(customPickupContracts).length
  ) {
    if (Object.keys(contractStates).length) {
      profile.contractStates = contractStates;
    }
    if (Object.keys(contractBonusStates).length) {
      profile.contractBonusStates = contractBonusStates;
    }
    if (selectableContractState) {
      profile.selectableContractState = selectableContractState;
    }
    if (Object.keys(customPickupContracts).length) {
      profile.customPickupContracts = customPickupContracts;
    }
    importedSystems.contracts = true;
    importedSystems.recruitment = true;
  }

  const collectionState = normalizeImportedCollectionState(systems);
  if (collectionState) {
    const collection = ensureObject(profile, "collection");
    collection.units = mergePositiveInts(collection.units, collectionState.illustratedUnitIds);
    collection.unitMissionsClaimed = {
      ...(collection.unitMissionsClaimed && typeof collection.unitMissionsClaimed === "object"
        ? collection.unitMissionsClaimed
        : {}),
      ...collectionState.completedUnitMissions,
    };
    collection.teamRewards = {
      ...(collection.teamRewards && typeof collection.teamRewards === "object" ? collection.teamRewards : {}),
      ...collectionState.teamRewards,
    };
    collection.miscRewards = {
      ...(collection.miscRewards && typeof collection.miscRewards === "object" ? collection.miscRewards : {}),
      ...collectionState.miscRewards,
    };
    collection.episodeRewards = {
      ...(collection.episodeRewards && typeof collection.episodeRewards === "object" ? collection.episodeRewards : {}),
      ...collectionState.episodeRewards,
    };
    importedSystems.collection = true;
    importedSystems.unitMissions = true;
  }

  const importedShop = normalizeImportedShopData(systems.shopData);
  if (importedShop) {
    profile.shopPurchaseHistory = mergeShopPurchaseHistories(importedShop.histories, profile.shopPurchaseHistory);
    if (importedShop.randomShop) profile.randomShop = importedShop.randomShop;
    if (importedShop.subscriptions) profile.shopSubscriptions = importedShop.subscriptions;
    importedSystems.shop = true;
    importedSystems.packages = true;
  }
  const importedConsumerPackages = normalizeImportedConsumerPackages(systems.consumerPackages);
  if (Object.keys(importedConsumerPackages).length) {
    profile.consumerPackages = {
      ...importedConsumerPackages,
      ...(profile.consumerPackages && typeof profile.consumerPackages === "object" && !Array.isArray(profile.consumerPackages)
        ? profile.consumerPackages
        : {}),
    };
    importedSystems.packages = true;
  }
  const importedTotalPaidAmount = finiteNumber(systems.totalPaidAmount, 0);
  if (importedTotalPaidAmount > 0) profile.shopTotalPaidAmount = importedTotalPaidAmount;

  const importedCounterCases = normalizeImportedCounterCases(systems.counterCaseData);
  if (Object.keys(importedCounterCases).length) {
    const simulation = ensureObject(profile, "simulation");
    simulation.counterCases = {
      ...importedCounterCases,
      ...(simulation.counterCases && typeof simulation.counterCases === "object" ? simulation.counterCases : {}),
    };
    simulation.simulatedPvpHistory = Array.isArray(simulation.simulatedPvpHistory) ? simulation.simulatedPvpHistory : [];
    importedSystems.counterCases = true;
  }

  const importedCraft = normalizeImportedCraftData(systems.craftData);
  if (importedCraft) {
    profile.craft = importedCraft;
    importedSystems.craft = true;
  }

  const importedAttendance = normalizeImportedAttendanceData(systems.attendanceData);
  if (importedAttendance) {
    profile.attendance = importedAttendance;
    importedSystems.attendance = true;
  }

  const importedShadowPalace = normalizeImportedShadowPalaceData(systems.shadowPalaceData);
  if (importedShadowPalace) {
    const miscStages = ensureObject(profile, "miscStages");
    miscStages.shadow = importedShadowPalace;
    importedSystems.shadowPalace = true;
  }

  if (systems.missionData) {
    const officialProgress = ensureObject(profile, "officialProgress");
    officialProgress.missionData = systems.missionData;
    importedSystems.missions = true;
    const missionSnapshots = extractMissionSnapshots(systems.missionData);
    if (missionSnapshots.length) {
      profile.completedMissions = profile.completedMissions && typeof profile.completedMissions === "object" ? profile.completedMissions : {};
      for (const [key, mission] of Object.entries(profile.completedMissions)) {
        if (mission && mission.source === "official-join-lobby") delete profile.completedMissions[key];
      }
      for (const mission of missionSnapshots) {
        const key = mission.missionID === mission.groupId ? String(mission.missionID) : `${mission.missionID}:${mission.groupId}`;
        profile.completedMissions[key] = {
          ...(profile.completedMissions[key] || {}),
          ...mission,
        };
      }
      officialProgress.importedMissionCount = missionSnapshots.length;
    }
    const completedMissionIds = collectPositiveInts(readAny(systems.missionData, ["completeFlag", "completeFlags", "m_CompleteFlag", "m_completeFlag"]));
    if (completedMissionIds.length) {
      profile.completedMissions = profile.completedMissions && typeof profile.completedMissions === "object" ? profile.completedMissions : {};
      for (const missionID of completedMissionIds) {
        const key = `${missionID}:${missionID}`;
        profile.completedMissions[key] = {
          ...(profile.completedMissions[key] || {}),
          missionID,
          groupId: (profile.completedMissions[key] && profile.completedMissions[key].groupId) || missionID,
          times: Math.max(1, Number(profile.completedMissions[key] && profile.completedMissions[key].times) || 1),
          targetTimes: Math.max(1, Number(profile.completedMissions[key] && profile.completedMissions[key].targetTimes) || 1),
          rewardReady: true,
          isComplete: true,
          rewardClaimed: true,
          source: "official-join-lobby",
        };
      }
      officialProgress.importedCompletedMissionFlagCount = completedMissionIds.length;
    }
    const achievePoint = findNumericFieldDeep(systems.missionData, ["achievePoint", "m_AchievePoint", "achievementPoint", "m_AchievementPoint"]);
    if (achievePoint != null) {
      profile.achievePoint = String(achievePoint);
      importedSystems.achievements = true;
    }
  }

  const officialProgress = ensureObject(profile, "officialProgress");
  officialProgress.schemaVersion = 1;
  officialProgress.importedSystems = {
    ...(officialProgress.importedSystems && typeof officialProgress.importedSystems === "object" ? officialProgress.importedSystems : {}),
    ...importedSystems,
  };
  officialProgress.snapshotPacketType = nonEmpty(readAny(snapshot, ["packetType", "PacketType"])) || officialImport.packetType || "";
  officialImport.importedSystems = officialProgress.importedSystems;
  officialImport.localStateSchemaVersion = OFFICIAL_LOCAL_STATE_SCHEMA_VERSION;
  officialImport.localStateHydratedAt = new Date().toISOString();
  return { changed: true, importedSystems: officialProgress.importedSystems };
}

function normalizeImportedWorldMapData(source) {
  const data = firstObject(source);
  if (!data) return null;
  const cityMap = firstObject(readAny(data, ["worldMapCityDataMap", "WorldMapCityDataMap", "cities", "Cities"]));
  const cities = {};
  for (const [key, value] of Object.entries(cityMap || {})) {
    const city = firstObject(value);
    if (!city) continue;
    const cityID = firstPositiveInt(readAny(city, ["cityID", "cityId", "CityID", "m_CityID"])) || firstPositiveInt(key);
    if (!cityID) continue;
    const mission = firstObject(readAny(city, ["worldMapMission", "WorldMapMission", "mission", "Mission"])) || {};
    const eventGroup = firstObject(readAny(city, ["worldMapEventGroup", "WorldMapEventGroup", "eventGroup", "EventGroup"])) || {};
    const buildingMap = firstObject(
      readAny(city, ["worldMapCityBuildingDataMap", "WorldMapCityBuildingDataMap", "buildings", "Buildings"])
    );
    const buildings = {};
    for (const [buildingKey, buildingValue] of Object.entries(buildingMap || {})) {
      const building = firstObject(buildingValue);
      if (!building) continue;
      const id = firstPositiveInt(readAny(building, ["id", "ID", "buildingID", "BuildingID"])) || firstPositiveInt(buildingKey);
      if (!id) continue;
      buildings[String(id)] = {
        buildUID: nonEmpty(readAny(building, ["buildUID", "buildUid", "uid", "UID"])) || "0",
        id,
        level: Math.max(1, finiteInt(firstPresent(readAny(building, ["level", "Level"]), 1), 1)),
      };
    }
    cities[String(cityID)] = {
      cityID,
      leaderUnitUID: nonEmpty(readAny(city, ["leaderUnitUID", "leaderUnitUid", "leaderUID", "LeaderUnitUID"])) || "0",
      exp: Math.max(0, finiteInt(firstPresent(readAny(city, ["exp", "Exp"]), 0), 0)),
      level: Math.max(1, finiteInt(firstPresent(readAny(city, ["level", "Level"]), 1), 1)),
      mission: {
        currentMissionID:
          firstPositiveInt(readAny(mission, ["currentMissionID", "currentMissionId", "CurrentMissionID"])) || 0,
        completeTime: normalizeImportedDateTimeTicks(readAny(mission, ["completeTime", "CompleteTime"])),
        startDate: normalizeImportedDateTimeBinary(readAny(mission, ["startDate", "StartDate"])),
        stMissionIDList: collectPositiveInts(
          readAny(mission, ["stMissionIDList", "stMissionIdList", "missionIDList", "MissionIDList"])
        ),
        officialImported: true,
      },
      eventGroup: {
        worldmapEventID:
          firstPositiveInt(readAny(eventGroup, ["worldmapEventID", "worldMapEventID", "WorldmapEventID"])) || 0,
        eventGroupEndDate: normalizeImportedDateTimeBinary(
          readAny(eventGroup, ["eventGroupEndDate", "EventGroupEndDate"])
        ),
        eventUid: nonEmpty(readAny(eventGroup, ["eventUid", "eventUID", "EventUid", "EventUID"])) || "0",
      },
      buildings,
    };
  }
  return {
    cities,
    collectLastResetDate: normalizeImportedDateTimeBinary(
      readAny(data, ["collectLastResetDate", "CollectLastResetDate"])
    ),
  };
}

function normalizeImportedCollectionState(systems) {
  const army = firstObject(systems && systems.armyData) || {};
  const inventory = firstObject(systems && systems.inventoryData) || {};
  const illustratedUnitIds = collectPositiveInts(
    readAny(army, ["m_illustrateUnit", "illustrateUnit", "illustratedUnitIds", "IllustratedUnitIds"])
  );
  const teamRewards = {};
  const teamMap = firstObject(readAny(army, ["m_dicTeamCollectionData", "teamCollectionData", "TeamCollectionData"]));
  for (const [key, value] of Object.entries(teamMap || {})) {
    const item = firstObject(value) || {};
    const teamID = firstPositiveInt(readAny(item, ["m_TeamID", "teamID", "teamId", "TeamID"])) || firstPositiveInt(key);
    const reward = firstPresent(readAny(item, ["m_bReward", "reward", "Reward"]), false) === true;
    if (teamID && reward) teamRewards[String(teamID)] = { teamID, claimedAt: "official-import" };
  }
  const miscRewards = {};
  const miscMap = firstObject(readAny(inventory, ["m_dicMiscCollectionData", "miscCollectionData", "MiscCollectionData"]));
  for (const [key, value] of Object.entries(miscMap || {})) {
    const item = firstObject(value) || {};
    const miscId = firstPositiveInt(readAny(item, ["miscId", "miscID", "m_MiscID", "MiscID"])) || firstPositiveInt(key);
    const reward = firstPresent(readAny(item, ["reward", "m_bReward", "Reward"]), false) === true;
    if (miscId && reward) miscRewards[String(miscId)] = { miscId, claimedAt: "official-import" };
  }
  const completedUnitMissions = {};
  for (const value of firstArrayLike(systems && systems.completedUnitMissions)) {
    const item = firstObject(value);
    if (!item) continue;
    const unitId = firstPositiveInt(readAny(item, ["unitId", "unitID", "UnitId", "UnitID"]));
    const missionId = firstPositiveInt(readAny(item, ["missionId", "missionID", "MissionId", "MissionID"]));
    const stepId = firstPositiveInt(readAny(item, ["stepId", "stepID", "StepId", "StepID"]));
    if (!unitId || !missionId || !stepId) continue;
    completedUnitMissions[`${unitId}:${missionId}:${stepId}`] = {
      unitId,
      missionId,
      stepId,
      claimedAt: "official-import",
    };
  }
  const episodeRewards = {};
  const episodeMap = firstObject(systems && systems.episodeCompleteData);
  for (const value of Object.values(episodeMap || {})) {
    const item = firstObject(value);
    if (!item) continue;
    const episodeID = firstPositiveInt(readAny(item, ["m_EpisodeID", "episodeID", "episodeId", "EpisodeID"]));
    if (!episodeID) continue;
    const rawDifficulty = firstPresent(
      readAny(item, ["m_EpisodeDifficulty", "episodeDifficulty", "difficulty", "EpisodeDifficulty"]),
      0
    );
    const difficulty = String(rawDifficulty || "").toUpperCase() === "HARD" || Number(rawDifficulty) === 1 ? 1 : 0;
    const flags = readAny(item, ["m_bRewards", "rewards", "rewardFlags", "RewardFlags"]);
    episodeRewards[`${episodeID}:${difficulty}`] = [0, 1, 2].map((index) => Boolean(Array.isArray(flags) && flags[index]));
  }
  if (
    !illustratedUnitIds.length &&
    !Object.keys(teamRewards).length &&
    !Object.keys(miscRewards).length &&
    !Object.keys(completedUnitMissions).length &&
    !Object.keys(episodeRewards).length
  ) {
    return null;
  }
  return { illustratedUnitIds, teamRewards, miscRewards, completedUnitMissions, episodeRewards };
}

function normalizeImportedShopData(source) {
  const data = firstObject(source);
  if (!data) return null;
  const histories = {};
  const historyMap = firstObject(readAny(data, ["histories", "Histories", "purchaseHistories", "PurchaseHistories"]));
  for (const [key, value] of Object.entries(historyMap || {})) {
    const item = firstObject(value);
    if (!item) continue;
    const shopId = firstPositiveInt(readAny(item, ["shopId", "shopID", "ShopId", "ShopID"])) || firstPositiveInt(key);
    if (!shopId) continue;
    histories[String(shopId)] = {
      shopId,
      purchaseCount: Math.max(0, finiteInt(firstPresent(readAny(item, ["purchaseCount", "PurchaseCount"]), 0), 0)),
      purchaseTotalCount: Math.max(
        0,
        finiteInt(firstPresent(readAny(item, ["purchaseTotalCount", "PurchaseTotalCount"]), 0), 0)
      ),
      nextResetDate: normalizeImportedDateTimeTicks(readAny(item, ["nextResetDate", "NextResetDate"])),
    };
  }
  const random = firstObject(readAny(data, ["randomShop", "RandomShop", "randomData", "RandomData"]));
  let randomShop = null;
  if (random) {
    const slots = {};
    const datas = firstObject(readAny(random, ["datas", "Datas", "slots", "Slots"]));
    for (const [key, value] of Object.entries(datas || {})) {
      const item = firstObject(value);
      const index = firstPositiveInt(key);
      if (!item || !index) continue;
      slots[String(index)] = {
        itemId: firstPositiveInt(readAny(item, ["itemId", "itemID", "ItemId", "ItemID"])) || 0,
        itemType: nonEmpty(readAny(item, ["itemType", "ItemType"])) || "RT_MISC",
        itemCount: Math.max(1, finiteInt(firstPresent(readAny(item, ["itemCount", "ItemCount"]), 1), 1)),
        priceItemId: firstPositiveInt(readAny(item, ["priceItemId", "priceItemID", "PriceItemId", "PriceItemID"])) || 0,
        price: Math.max(0, finiteInt(firstPresent(readAny(item, ["price", "Price"]), 0), 0)),
        isBuy: Boolean(firstPresent(readAny(item, ["isBuy", "IsBuy"]), false)),
        discountRatio: Math.max(0, finiteInt(firstPresent(readAny(item, ["discountRatio", "DiscountRatio"]), 0), 0)),
      };
    }
    randomShop = {
      version: 1,
      generation: 0,
      refreshCount: Math.max(0, finiteInt(firstPresent(readAny(random, ["refreshCount", "RefreshCount"]), 0), 0)),
      refreshDay: "",
      nextRefreshDate: normalizeImportedDateTimeTicks(readAny(random, ["nextRefreshDate", "NextRefreshDate"])),
      slots,
    };
  }
  const subscriptions = firstObject(readAny(data, ["subscriptions", "Subscriptions"])) || {};
  return { histories, randomShop, subscriptions };
}

function normalizeImportedConsumerPackages(source) {
  const output = {};
  for (const value of Array.isArray(source) ? source : []) {
    const data = firstObject(value);
    if (!data) continue;
    const productId = firstPositiveInt(readAny(data, ["productId", "productID", "ProductId", "ProductID"]));
    if (!productId) continue;
    output[String(productId)] = {
      productId,
      rewardedLevel: Math.max(0, finiteInt(firstPresent(readAny(data, ["rewardedLevel", "RewardedLevel"]), 0), 0)),
      spendCount: String(Math.max(0, finiteNumber(firstPresent(readAny(data, ["spendCount", "SpendCount"]), 0), 0))),
      pendingUpdate: false,
    };
  }
  return output;
}

function mergeShopPurchaseHistories(imported, local) {
  const result = { ...(imported && typeof imported === "object" ? imported : {}) };
  for (const [key, value] of Object.entries(local && typeof local === "object" ? local : {})) {
    const current = result[key];
    if (!current) {
      result[key] = value;
      continue;
    }
    result[key] = {
      ...current,
      ...value,
      shopId: Number(value.shopId || current.shopId || key),
      purchaseCount: Math.max(Number(current.purchaseCount || 0), Number(value.purchaseCount || 0)),
      purchaseTotalCount: Math.max(Number(current.purchaseTotalCount || 0), Number(value.purchaseTotalCount || 0)),
      nextResetDate: String(value.nextResetDate || current.nextResetDate || "0"),
    };
  }
  return result;
}

function normalizeImportedOfficeState(source) {
  const data = firstObject(source);
  if (!data) return null;
  const rooms = firstArrayLike(readAny(data, ["rooms", "Rooms"]))
    .map(normalizeImportedOfficeRoom)
    .filter(Boolean);
  const interiors = firstArrayLike(readAny(data, ["interiors", "Interiors"]))
    .map((value) => {
      const item = firstObject(value);
      const itemId = firstPositiveInt(readAny(item, ["itemId", "ItemId", "itemID", "ItemID"]));
      if (!itemId) return null;
      return {
        itemId,
        count: nonEmpty(firstPresent(readAny(item, ["count", "Count"]), "0")) || "0",
      };
    })
    .filter(Boolean);
  const post = firstObject(readAny(data, ["postState", "PostState"])) || {};
  const presets = firstArrayLike(readAny(data, ["presets", "Presets"]))
    .map(normalizeImportedOfficePreset)
    .filter(Boolean);
  return {
    openedSectionIds: collectPositiveInts(readAny(data, ["openedSectionIds", "OpenedSectionIds"])),
    rooms,
    interiors,
    postState: {
      broadcastExecution: Boolean(readAny(post, ["broadcastExecution", "BroadcastExecution"])),
      sendCount: Math.max(0, finiteInt(firstPresent(readAny(post, ["sendCount", "SendCount"]), 0), 0)),
      recvCount: Math.max(0, finiteInt(firstPresent(readAny(post, ["recvCount", "RecvCount"]), 0), 0)),
      nextResetDate: normalizeImportedDateTimeBinary(readAny(post, ["nextResetDate", "NextResetDate"])),
    },
    presets,
  };
}

function normalizeImportedOfficeRoom(source) {
  const data = firstObject(source);
  const id = firstPositiveInt(readAny(data, ["id", "Id", "roomId", "RoomId"]));
  if (!data || !id) return null;
  return {
    id,
    name: nonEmpty(readAny(data, ["name", "Name"])),
    grade: normalizeOfficeGrade(readAny(data, ["grade", "Grade"])),
    interiorScore: Math.max(0, finiteInt(firstPresent(readAny(data, ["interiorScore", "InteriorScore"]), 0), 0)),
    furnitures: firstArrayLike(readAny(data, ["furnitures", "Furnitures"]))
      .map(normalizeImportedOfficeFurniture)
      .filter(Boolean),
    unitUids: firstArrayLike(readAny(data, ["unitUids", "UnitUids", "unitUIDs", "UnitUIDs"]))
      .map(nonEmpty)
      .filter((value) => /^\d+$/.test(value) && BigInt(value) > 0n),
    floorInteriorId: firstPositiveInt(readAny(data, ["floorInteriorId", "FloorInteriorId"])) || 0,
    wallInteriorId: firstPositiveInt(readAny(data, ["wallInteriorId", "WallInteriorId"])) || 0,
    backgroundId: firstPositiveInt(readAny(data, ["backgroundId", "BackgroundId"])) || 0,
  };
}

function normalizeImportedOfficePreset(source) {
  const data = firstObject(source);
  if (!data) return null;
  const rawPresetId = finiteInt(firstPresent(readAny(data, ["presetId", "PresetId"]), -1), -1);
  if (rawPresetId < 0) return null;
  return {
    presetId: rawPresetId,
    name: nonEmpty(readAny(data, ["name", "Name"])),
    furnitures: firstArrayLike(readAny(data, ["furnitures", "Furnitures"]))
      .map(normalizeImportedOfficeFurniture)
      .filter(Boolean),
    floorInteriorId: firstPositiveInt(readAny(data, ["floorInteriorId", "FloorInteriorId"])) || 0,
    wallInteriorId: firstPositiveInt(readAny(data, ["wallInteriorId", "WallInteriorId"])) || 0,
    backgroundId: firstPositiveInt(readAny(data, ["backgroundId", "BackgroundId"])) || 0,
  };
}

function normalizeImportedOfficeFurniture(source) {
  const data = firstObject(source);
  const uid = nonEmpty(readAny(data, ["uid", "Uid", "furnitureUid", "FurnitureUid"]));
  const itemId = firstPositiveInt(readAny(data, ["itemId", "ItemId", "itemID", "ItemID"]));
  if (!data || !/^\d+$/.test(uid) || BigInt(uid) <= 0n || !itemId) return null;
  return {
    uid,
    itemId,
    planeType: normalizeOfficePlaneType(readAny(data, ["planeType", "PlaneType"])),
    positionX: finiteInt(firstPresent(readAny(data, ["positionX", "PositionX"]), 0), 0),
    positionY: finiteInt(firstPresent(readAny(data, ["positionY", "PositionY"]), 0), 0),
    inverted: Boolean(readAny(data, ["inverted", "Inverted"])),
  };
}

function normalizeOfficeGrade(value) {
  const named = { GRADEF: 0, GRADED: 1, GRADEC: 2, GRADEB: 3, GRADEA: 4, GRADES: 5 };
  const key = nonEmpty(value).toUpperCase();
  return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : clamp(finiteInt(value, 0), 0, 5);
}

function normalizeOfficePlaneType(value) {
  const named = { FLOOR: 0, TILE: 1, LEFTWALL: 10, RIGHTWALL: 11 };
  const key = nonEmpty(value).replace(/[_\s-]/g, "").toUpperCase();
  return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : clamp(finiteInt(value, 0), 0, 11);
}

function normalizeImportedCounterCases(source) {
  const result = {};
  const map = firstObject(source);
  for (const [key, value] of Object.entries(map || {})) {
    const item = firstObject(value);
    if (!item) continue;
    const dungeonID = firstPositiveInt(readAny(item, ["m_DungeonID", "dungeonID", "dungeonId", "DungeonID"])) || firstPositiveInt(key);
    if (!dungeonID) continue;
    result[String(dungeonID)] = {
      dungeonID,
      unlocked: firstPresent(readAny(item, ["m_Unlocked", "unlocked", "Unlocked"]), true) !== false,
      unlockedAt: "official-import",
    };
  }
  return result;
}

function normalizeImportedCraftData(source) {
  const data = firstObject(source);
  if (!data) return null;
  const molds = {};
  const moldMap = firstObject(readAny(data, ["m_dicMoldItem", "molds", "Molds"]));
  for (const [key, value] of Object.entries(moldMap || {})) {
    const item = firstObject(value);
    if (!item) continue;
    const moldId = firstPositiveInt(readAny(item, ["m_MoldID", "moldId", "moldID", "MoldID"])) || firstPositiveInt(key);
    if (!moldId) continue;
    molds[String(moldId)] = {
      moldId,
      count: nonEmpty(firstPresent(readAny(item, ["m_Count", "count", "Count"]), "0")) || "0",
    };
  }
  const slots = {};
  const slotMap = firstObject(readAny(data, ["m_dicSlot", "slots", "Slots"]));
  for (const [key, value] of Object.entries(slotMap || {})) {
    const item = firstObject(value);
    if (!item) continue;
    const index = firstPositiveInt(readAny(item, ["index", "Index", "slotIndex", "SlotIndex"])) || firstPositiveInt(key);
    if (!index) continue;
    slots[String(index)] = {
      index,
      moldId: firstPositiveInt(readAny(item, ["moldId", "moldID", "MoldID"])) || 0,
      count: Math.max(0, finiteInt(firstPresent(readAny(item, ["count", "Count"]), 0), 0)),
      completeDate: normalizeImportedDateTimeTicks(readAny(item, ["completeDate", "CompleteDate"])),
    };
  }
  return { molds, slots };
}

function normalizeImportedAttendanceData(source) {
  const data = firstObject(source);
  if (!data) return null;
  const tabs = {};
  for (const value of firstArrayLike(readAny(data, ["attList", "AttList", "attendanceList", "AttendanceList"]))) {
    const item = firstObject(value);
    if (!item) continue;
    const idx = firstPositiveInt(readAny(item, ["idx", "Idx", "index", "Index"]));
    if (!idx) continue;
    tabs[String(idx)] = {
      idx,
      count: Math.max(0, finiteInt(firstPresent(readAny(item, ["count", "Count"]), 0), 0)),
      eventEndDate: normalizeImportedDateTimeTicks(readAny(item, ["eventEndDate", "EventEndDate"])),
      lastClaimDate: "",
      lastClaimedAt: "",
    };
  }
  return {
    schemaVersion: 1,
    tabs,
    rotationIndex: 0,
    activeTabIdx: 0,
    lastRewardDate: "",
    lastPromptDate: "",
    promptTrackingInitialized: true,
    lastPromptedAt: "",
    lastUpdateDate: normalizeImportedDateTimeBinary(readAny(data, ["lastUpdateDate", "LastUpdateDate"])),
  };
}

function normalizeImportedShadowPalaceData(source) {
  const data = firstObject(source);
  if (!data) return null;
  const palaces = {};
  for (const value of firstArrayLike(readAny(data, ["palaceDataList", "PalaceDataList"]))) {
    const item = firstObject(value);
    if (!item) continue;
    const palaceId = firstPositiveInt(readAny(item, ["palaceId", "palaceID", "PalaceId", "PalaceID"]));
    if (!palaceId) continue;
    palaces[String(palaceId)] = {
      palaceId,
      currentDungeonId:
        firstPositiveInt(readAny(item, ["currentDungeonId", "currentDungeonID", "CurrentDungeonId", "CurrentDungeonID"])) || 0,
      dungeonDataList: firstArrayLike(readAny(item, ["dungeonDataList", "DungeonDataList"]))
        .map((value) => {
          const dungeon = firstObject(value);
          const dungeonId = firstPositiveInt(readAny(dungeon, ["dungeonId", "dungeonID", "DungeonId", "DungeonID"]));
          if (!dungeonId) return null;
          return {
            dungeonId,
            recentTime: Math.max(0, finiteNumber(firstPresent(readAny(dungeon, ["recentTime", "RecentTime"]), 0), 0)),
            bestTime: Math.max(0, finiteNumber(firstPresent(readAny(dungeon, ["bestTime", "BestTime"]), 0), 0)),
          };
        })
        .filter(Boolean),
    };
  }
  return {
    currentPalaceId: firstPositiveInt(readAny(data, ["currentPalaceId", "currentPalaceID", "CurrentPalaceId"])) || 0,
    life: Math.max(0, finiteInt(firstPresent(readAny(data, ["life", "Life"]), 0), 0)),
    palaces,
    rewardMultiply: Math.max(1, finiteInt(firstPresent(readAny(data, ["rewardMultiply", "RewardMultiply"]), 1), 1)),
  };
}

function normalizeImportedContractStates(source) {
  const output = {};
  for (const item of firstArrayLike(source)) {
    const data = firstObject(item);
    if (!data) continue;
    const contractId = firstPositiveInt(readAny(data, ["contractId", "ContractId", "m_ContractID", "ContractID"]));
    if (!contractId) continue;
    output[String(contractId)] = {
      contractId,
      remainFreeChance: finiteInt(firstPresent(readAny(data, ["remainFreeChance", "RemainFreeChance"]), 0), 0),
      nextResetDate: normalizeImportedDateTimeBinary(readAny(data, ["nextResetDate", "NextResetDate"])),
      isActive: firstPresent(readAny(data, ["isActive", "IsActive"]), true) !== false,
      totalUseCount: finiteInt(firstPresent(readAny(data, ["totalUseCount", "TotalUseCount"]), 0), 0),
      dailyUseCount: finiteInt(firstPresent(readAny(data, ["dailyUseCount", "DailyUseCount"]), 0), 0),
      bonusCandidate: collectPositiveInts(readAny(data, ["bonusCandidate", "BonusCandidate"])),
    };
  }
  return output;
}

function normalizeImportedContractBonusStates(source) {
  const output = {};
  for (const item of firstArrayLike(source)) {
    const data = firstObject(item);
    if (!data) continue;
    const bonusGroupId = firstPositiveInt(readAny(data, ["bonusGroupId", "BonusGroupId", "m_BonusGroupID", "BonusGroupID"]));
    if (!bonusGroupId) continue;
    output[String(bonusGroupId)] = {
      bonusGroupId,
      useCount: finiteInt(firstPresent(readAny(data, ["useCount", "UseCount"]), 0), 0),
      resetCount: finiteInt(firstPresent(readAny(data, ["resetCount", "ResetCount"]), 0), 0),
    };
  }
  return output;
}

function normalizeImportedSelectableContractState(source) {
  const data = firstObject(source);
  if (!data) return null;
  const contractId = firstPositiveInt(readAny(data, ["contractId", "ContractId", "m_ContractID", "ContractID"]));
  const unitIdList = collectPositiveInts(readAny(data, ["unitIdList", "UnitIdList", "unitIDList", "UnitIDList"])).slice(0, 10);
  const unitPoolChangeCount = finiteInt(firstPresent(readAny(data, ["unitPoolChangeCount", "UnitPoolChangeCount"]), 0), 0);
  const isActive = firstPresent(readAny(data, ["isActive", "IsActive"]), true) !== false;
  if (!contractId && !unitIdList.length && unitPoolChangeCount <= 0 && isActive) return null;
  return {
    contractId: contractId || 0,
    unitIdList,
    unitPoolChangeCount,
    isActive,
  };
}

function normalizeImportedCustomPickupContracts(source) {
  const output = {};
  for (const item of firstArrayLike(source)) {
    const data = firstObject(item);
    if (!data) continue;
    const customPickupId = firstPositiveInt(readAny(data, ["customPickupId", "CustomPickupId", "m_CustomPickupID", "CustomPickupID"]));
    if (!customPickupId) continue;
    output[String(customPickupId)] = {
      customPickupId,
      totalUseCount: finiteInt(firstPresent(readAny(data, ["totalUseCount", "TotalUseCount"]), 0), 0),
      customPickupTargetUnitId:
        firstPositiveInt(readAny(data, ["customPickupTargetUnitId", "CustomPickupTargetUnitId", "targetUnitId", "TargetUnitId"])) || 0,
      currentSelectCount: finiteInt(firstPresent(readAny(data, ["currentSelectCount", "CurrentSelectCount"]), 0), 0),
    };
  }
  return output;
}

function normalizeImportedDateTimeBinary(value) {
  if (value == null || value === "") return "0";
  const text = String(value);
  if (/^\d+$/.test(text)) return text;
  const ticks = dateTimeTicksFromText(text);
  return ticks > 0n ? String((ticks & 0x3fffffffffffffffn) | 0x4000000000000000n) : "0";
}

function normalizeImportedDateTimeTicks(value) {
  if (value == null || value === "") return "0";
  const text = String(value);
  if (/^\d+$/.test(text)) return String(BigInt(text) & 0x3fffffffffffffffn);
  const ticks = dateTimeTicksFromText(text);
  return ticks > 0n ? String(ticks) : "0";
}

function dateTimeTicksFromText(value) {
  const text = String(value || "").trim();
  if (!text) return 0n;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text}Z`;
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) return 0n;
  return 621355968000000000n + BigInt(Math.trunc(millis)) * 10000n;
}

function normalizeImportedBirthDayData(source) {
  const data = firstObject(source);
  if (!data) return null;
  const directBirthDay = firstObject(readAny(data, ["birthDay", "BirthDay", "birthday", "Birthday", "m_BirthDay"]), data);
  const month = firstPositiveInt(readAny(directBirthDay, ["month", "Month", "m_Month", "m_iMonth"]));
  const day = firstPositiveInt(readAny(directBirthDay, ["day", "Day", "m_Day", "m_iDay"]));
  if (!month || !day) {
    const nested = findBirthDayPair(data);
    if (!nested) return null;
    return {
      birthDay: { month: clamp(nested.month, 1, 12), day: clamp(nested.day, 1, maxBirthdayDay(nested.month)) },
      years: Math.max(0, Number(findNumericFieldDeep(data, ["years", "Years", "m_Years"]) || 0) || 0),
    };
  }
  return {
    birthDay: { month: clamp(month, 1, 12), day: clamp(day, 1, maxBirthdayDay(month)) },
    years: Math.max(0, Number(firstPresent(readAny(data, ["years", "Years", "m_Years"]), 0)) || 0),
  };
}

function normalizeImportedBackgroundInfo(source) {
  const data = firstObject(source);
  if (!data) return null;
  const backgroundItemId = firstPositiveInt(readAny(data, ["backgroundItemId", "backgroundID", "backgroundId", "m_BackgroundItemId"])) || 0;
  const backgroundBgmId = firstPositiveInt(readAny(data, ["backgroundBgmId", "bgmId", "m_BackgroundBgmId"])) || 0;
  const rawUnits = firstArrayLike(readAny(data, ["unitInfoList", "UnitInfoList", "m_UnitInfoList", "units", "Units"]));
  const unitInfoList = rawUnits.slice(0, 12).map(normalizeImportedBackgroundUnit).filter(Boolean);
  if (!backgroundItemId && !backgroundBgmId && !unitInfoList.length) return null;
  return { backgroundItemId, backgroundBgmId, unitInfoList };
}

function normalizeImportedBackgroundUnit(source) {
  const data = firstObject(source);
  if (!data) return null;
  const unitUid = nonEmpty(
    firstPresent(readAny(data, ["unitUid", "unitUID", "uid", "UID", "m_UnitUID", "m_unitUID"]), "0")
  );
  const hasValue =
    unitUid !== "0" ||
    firstPresent(
      readAny(data, ["unitType", "m_UnitType"]),
      readAny(data, ["unitSize", "m_UnitSize"]),
      readAny(data, ["unitPosX", "m_UnitPosX"]),
      readAny(data, ["unitPosY", "m_UnitPosY"])
    ) != null;
  if (!hasValue) return null;
  return {
    unitUid,
    unitType: finiteInt(firstPresent(readAny(data, ["unitType", "m_UnitType"]), 2), 2),
    unitSize: finiteNumber(firstPresent(readAny(data, ["unitSize", "m_UnitSize"]), 1), 1),
    unitFace: finiteInt(firstPresent(readAny(data, ["unitFace", "m_UnitFace"]), 0), 0),
    unitPosX: finiteNumber(firstPresent(readAny(data, ["unitPosX", "posX", "x", "m_UnitPosX"]), 0), 0),
    unitPosY: finiteNumber(firstPresent(readAny(data, ["unitPosY", "posY", "y", "m_UnitPosY"]), 0), 0),
    backImage: firstPresent(readAny(data, ["backImage", "m_BackImage"]), true) !== false,
    skinOption: finiteInt(firstPresent(readAny(data, ["skinOption", "m_SkinOption"]), 0), 0),
    rotation: finiteNumber(firstPresent(readAny(data, ["rotation", "m_Rotation"]), 0), 0),
    flip: Boolean(firstPresent(readAny(data, ["flip", "m_Flip"]), false)),
    animTime: finiteNumber(firstPresent(readAny(data, ["animTime", "m_AnimTime"]), -1), -1),
  };
}

function normalizeImportedJukeboxData(source) {
  if (source == null) return null;
  const entries = {};
  collectJukeboxEntries(source, entries, 0, new Set());
  return Object.keys(entries).length ? entries : null;
}

function collectJukeboxEntries(value, entries, depth, seen) {
  if (value == null || depth > 6) return;
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectJukeboxEntries(item, entries, depth + 1, seen);
    return;
  }
  const type = firstPositiveInt(readAny(value, ["bgmType", "BgmType", "type", "Type", "m_BgmType"]));
  const id = firstPositiveInt(readAny(value, ["bgmId", "BgmId", "id", "ID", "m_BgmID", "m_BgmId"]));
  if (type != null && id != null) entries[String(type)] = id;
  for (const [key, item] of Object.entries(value)) {
    if (/^\d+$/.test(key) && firstPositiveInt(item)) entries[String(Number(key))] = firstPositiveInt(item);
    else if (/bgm|jukebox/i.test(key) || typeof item === "object") collectJukeboxEntries(item, entries, depth + 1, seen);
  }
}

function extractMissionSnapshots(source) {
  const directMap = firstObject(readAny(source, ["dicMissions", "DicMissions", "m_dicMissions", "missions", "Missions"]));
  if (directMap) {
    const output = [];
    for (const [key, value] of Object.entries(directMap)) {
      const data = firstObject(value);
      if (!data) continue;
      const missionID = firstPositiveInt(
        readAny(data, ["missionID", "missionId", "mission_id", "MissionID", "m_MissionID", "id", "ID"])
      );
      const groupId =
        firstPositiveInt(
          readAny(data, ["groupId", "group_id", "missionGroupId", "MissionGroupID", "m_GroupID", "m_MissionGroupID"])
        ) ||
        firstPositiveInt(key) ||
        missionID;
      if (!missionID || !groupId) continue;
      const times = Math.max(
        0,
        Number(firstPresent(readAny(data, ["times", "targetTimes", "target_times", "count", "m_Times"]), 0)) || 0
      );
      const complete = Boolean(
        firstPresent(
          readAny(data, ["rewardClaimed", "isComplete", "is_complete", "complete", "completed", "m_bComplete", "m_bRewardComplete"]),
          false
        )
      );
      output.push({
        missionID,
        groupId,
        tabId: firstPositiveInt(readAny(data, ["tabId", "tab_id", "missionTabId", "MissionTabID", "m_MissionTabID"])) || 1,
        times,
        targetTimes: Math.max(1, Number(firstPresent(readAny(data, ["targetTimes", "target_times", "m_TargetTimes"]), times || 1)) || 1),
        rewardReady: complete,
        isComplete: complete,
        rewardClaimed: complete,
        lastUpdateDate: normalizeImportedDateTimeTicks(
          readAny(data, ["lastUpdateDate", "last_update_date", "m_LastUpdateDate"])
        ),
        endDate: normalizeImportedDateTimeTicks(readAny(data, ["endDate", "end_date", "m_EndDate"])),
        source: "official-join-lobby",
      });
    }
    return output;
  }

  const output = new Map();
  const stack = [{ value: source, depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (value == null || depth > 8) continue;
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);

    const keys = Object.keys(value);
    const hasMissionKey = keys.some((key) => /mission/i.test(key));
    const missionID = firstPositiveInt(readAny(value, ["missionID", "missionId", "mission_id", "MissionID", "m_MissionID", "id", "ID"]));
    if (hasMissionKey && missionID) {
      const groupId =
        firstPositiveInt(readAny(value, ["groupId", "group_id", "missionGroupId", "MissionGroupID", "m_GroupID", "m_MissionGroupID"])) ||
        missionID;
      const times = Math.max(0, Number(firstPresent(readAny(value, ["times", "targetTimes", "target_times", "count", "m_Times"]), 1)) || 1);
      const complete = Boolean(
        firstPresent(
          readAny(value, ["rewardClaimed", "isComplete", "is_complete", "complete", "completed", "m_bComplete", "m_bRewardComplete"]),
          false
        )
      );
      output.set(`${missionID}:${groupId}`, {
        missionID,
        groupId,
        tabId: firstPositiveInt(readAny(value, ["tabId", "tab_id", "missionTabId", "MissionTabID", "m_MissionTabID"])) || 1,
        times,
        targetTimes: Math.max(1, Number(firstPresent(readAny(value, ["targetTimes", "target_times", "m_TargetTimes"]), times || 1)) || 1),
        rewardReady: complete,
        isComplete: complete,
        rewardClaimed: complete,
        lastUpdateDate: nonEmpty(readAny(value, ["lastUpdateDate", "last_update_date", "m_LastUpdateDate"])) || undefined,
        endDate: nonEmpty(readAny(value, ["endDate", "end_date", "m_EndDate"])) || undefined,
        source: "official-join-lobby",
      });
    }

    for (const item of arrayLikeValues(value)) {
      if (item && typeof item === "object") stack.push({ value: item, depth: depth + 1 });
    }
  }
  return Array.from(output.values());
}

function collectPositiveInts(source, options = {}) {
  const output = [];
  const seenValues = new Set();
  const seenObjects = new Set();
  const idFields = Array.isArray(options.idFields) ? options.idFields : [];
  const stack = [{ value: source, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (value == null || depth > 6) continue;
    if (typeof value !== "object") {
      const numeric = firstPositiveInt(value);
      if (numeric && !seenValues.has(numeric)) {
        seenValues.add(numeric);
        output.push(numeric);
      }
      continue;
    }
    if (seenObjects.has(value)) continue;
    seenObjects.add(value);
    for (const fieldName of idFields) {
      const numeric = firstPositiveInt(readAny(value, [fieldName]));
      if (numeric && !seenValues.has(numeric)) {
        seenValues.add(numeric);
        output.push(numeric);
      }
    }
    for (const item of arrayLikeValues(value)) stack.push({ value: item, depth: depth + 1 });
  }
  return output;
}

function mergePositiveInts(left, right) {
  const output = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    const numeric = firstPositiveInt(value);
    if (!numeric || seen.has(numeric)) continue;
    seen.add(numeric);
    output.push(numeric);
  }
  return output;
}

function findBirthDayPair(source) {
  const stack = [{ value: source, depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) continue;
    seen.add(value);
    const month = firstPositiveInt(readAny(value, ["month", "Month", "m_Month", "m_iMonth"]));
    const day = firstPositiveInt(readAny(value, ["day", "Day", "m_Day", "m_iDay"]));
    if (month && day) return { month, day };
    for (const item of arrayLikeValues(value)) stack.push({ value: item, depth: depth + 1 });
  }
  return null;
}

function findNumericFieldDeep(source, names) {
  const stack = [{ value: source, depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) continue;
    seen.add(value);
    const direct = firstPresent(...names.map((name) => readAny(value, [name])));
    const numeric = direct == null ? null : nonNegativeNumber(direct);
    if (numeric != null) return numeric;
    for (const item of arrayLikeValues(value)) stack.push({ value: item, depth: depth + 1 });
  }
  return null;
}

function readAny(source, names) {
  if (!source || typeof source !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
    const camel = name.charAt(0).toLowerCase() + name.slice(1);
    if (Object.prototype.hasOwnProperty.call(source, camel)) return source[camel];
    const pascal = name.charAt(0).toUpperCase() + name.slice(1);
    if (Object.prototype.hasOwnProperty.call(source, pascal)) return source[pascal];
  }
  return undefined;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object") return value;
  }
  return null;
}

function firstArrayLike(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value).filter((item) => item && typeof item === "object");
  return [];
}

function arrayLikeValues(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value;
  return Object.entries(value)
    .filter(([key]) => key !== "$type" && key !== "$summary" && key !== "$truncated" && key !== "$circular")
    .map(([, item]) => item);
}

function ensureObject(target, key) {
  target[key] = target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
  return target[key];
}

function firstPositiveInt(value) {
  const numeric = nonNegativeNumber(value);
  if (numeric == null) return null;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : null;
}

function nonNegativeNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const numeric = Number(String(value).replace(/n$/, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

function finiteInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  const numeric = finiteInt(value, min);
  return Math.max(min, Math.min(max, numeric));
}

function maxBirthdayDay(month) {
  if (month === 2) return 29;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function buildCounts(profile) {
  return {
    miscItems: countObject(profile.inventory && profile.inventory.misc),
    equips: countObject(profile.inventory && profile.inventory.equips),
    skins: Array.isArray(profile.inventory && profile.inventory.skins) ? profile.inventory.skins.length : 0,
    units: countObject(profile.army && profile.army.units),
    ships: countObject(profile.army && profile.army.ships),
    trophies: countObject(profile.army && profile.army.trophies),
    operators: countObject(profile.army && profile.army.operators),
    stages: countObject(profile.stagePlayData),
    dungeons: countObject(profile.dungeonClear),
    missions: countObject(profile.completedMissions),
    contractStates: countObject(profile.contractStates),
    contractBonusStates: countObject(profile.contractBonusStates),
    customPickupContracts: countObject(profile.customPickupContracts),
    selectableContractState:
      profile.selectableContractState && typeof profile.selectableContractState === "object" ? 1 : 0,
    officialSnapshot: profile.officialSnapshot && typeof profile.officialSnapshot === "object" ? 1 : 0,
  };
}

function countObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function allocateNumericId(db, field, fallback, exists) {
  let current = safeBigInt(db[field], fallback);
  while (exists(current)) current += 1n;
  db[field] = String(current + 1n);
  return String(current);
}

function bumpNextNumericId(db, field, value) {
  if (!value || !/^\d+$/.test(String(value))) return;
  const current = safeBigInt(db[field], field === "nextFriendCode" ? DEFAULT_NEXT_FRIEND_CODE : DEFAULT_NEXT_USER_UID);
  const next = BigInt(String(value)) + 1n;
  if (next > current) db[field] = String(next);
}

function safeBigInt(value, fallback) {
  try {
    return BigInt(String(value || fallback));
  } catch (_) {
    return BigInt(fallback);
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function decodeCapturedPayload(payload, compressed) {
  if (compressed) return lz4StreamDecompress(payload);
  return decryptCopy(payload);
}

function lz4StreamDecompress(payload) {
  let offset = 0;
  const chunks = [];
  while (offset < payload.length) {
    const flags = readVarInt(payload, offset);
    offset = flags.offset;
    const outputLength = readVarInt(payload, offset);
    offset = outputLength.offset;
    const compressed = (flags.value & 1) !== 0;
    let inputLength = outputLength.value;
    if (compressed) {
      const rawInputLength = readVarInt(payload, offset);
      offset = rawInputLength.offset;
      inputLength = rawInputLength.value;
    }
    const block = payload.subarray(offset, offset + inputLength);
    offset += inputLength;
    chunks.push(compressed ? lz4BlockDecode(block, outputLength.value) : Buffer.from(block));
  }
  return Buffer.concat(chunks);
}

function lz4BlockDecode(input, outputLength) {
  const output = Buffer.alloc(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < input.length) {
    const token = input[inputOffset++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        literalLength += value;
      } while (value === 255);
    }

    input.copy(output, outputOffset, inputOffset, inputOffset + literalLength);
    inputOffset += literalLength;
    outputOffset += literalLength;
    if (inputOffset >= input.length) break;

    const matchOffset = input[inputOffset] | (input[inputOffset + 1] << 8);
    inputOffset += 2;
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        matchLength += value;
      } while (value === 255);
    }
    matchLength += 4;

    for (let index = 0; index < matchLength; index += 1) {
      output[outputOffset + index] = output[outputOffset - matchOffset + index];
    }
    outputOffset += matchLength;
  }

  if (outputOffset !== outputLength) {
    throw new Error(`lz4 output length mismatch: expected ${outputLength}, decoded ${outputOffset}`);
  }
  return output;
}

function decryptCopy(payload) {
  const copy = Buffer.from(payload);
  encryptPayload(copy);
  return copy;
}

function encryptPayload(buffer) {
  let offset = 0;
  let maskIndex = 0;
  while (offset < buffer.length) {
    const mask = CRYPTO_MASKS[maskIndex];
    if (buffer.length - offset >= 8) {
      const value = buffer.readBigUInt64LE(offset) ^ mask;
      buffer.writeBigUInt64LE(value, offset);
      offset += 8;
    } else {
      const key = Number(mask & 0xffn);
      while (offset < buffer.length) {
        buffer[offset] ^= key;
        offset += 1;
      }
    }
    maskIndex = (maskIndex + 1) % CRYPTO_MASKS.length;
  }
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let current = offset;
  while (current < buffer.length) {
    const byte = buffer[current++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: current };
    shift += 7;
  }
  throw new Error("unterminated varint");
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function nonEmpty(value) {
  return value == null ? "" : String(value).trim();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

module.exports = {
  createOfficialProfileImporter,
  applyOfficialSnapshotToLocalProfile,
  JOIN_LOBBY_ACK_PACKET_ID,
  OFFICIAL_LOCAL_STATE_SCHEMA_VERSION,
};
