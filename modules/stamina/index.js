const path = require("path");
const { readGameplayTable, readGameplayTableRecords } = require("../gameplay-jsons");
const {
  buildItemMiscData,
  dateTimeBinaryNow,
  readSignedVarInt,
  toBigInt,
  writeInt64LE,
  writeNullableObject,
  writeSignedVarInt,
} = require("../packet-codec");
const { getMiscItem, setMiscItemBalance } = require("../inventory");

const ROOT_DIR = path.resolve(__dirname, "..", "..");

const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const DATE_TIME_TICK_MASK = 0x3fffffffffffffffn;
const TICKS_PER_MILLISECOND = 10000n;
const TICKS_PER_SECOND = 10000000n;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const CHARGE_ITEM_NOT = 1051;
const PVP_CHARGE_POINT_REFRESH_REQ = 2608;
const PVP_CHARGE_POINT_REFRESH_ACK = 2609;

const ITEM_IDS = Object.freeze({
  ETERNIUM: 2,
  INFORMATION: 3,
  DAILY_TICKET: 4,
  PVP_CHARGE_POINT: 6,
  PVP_PRACTICE_CHARGE_POINT: 9,
  ASYNC_PVP_TICKET: 13,
  SIM_ATTACK_TICKET: 15,
  SIM_DEFENSE_TICKET: 16,
  SIM_AIR_TICKET: 17,
  DIVE_PERMIT: 1065,
});

const DAILY_UTC_HOUR = Number(process.env.CS_STAMINA_DAILY_REFRESH_UTC_HOUR || 4);

let cachedPlayerExpRows = null;
let cachedPvpConst = null;

function createStaminaHandlers() {
  return [
    {
      packetId: PVP_CHARGE_POINT_REFRESH_REQ,
      name: "PVP_CHARGE_POINT_REFRESH_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodePvpChargePointRefreshReq(ctx, packet.payload);
        const now = getNow(ctx);
        const refresh = refreshTimedStamina(user, {
          now,
          itemIds: [req.itemId],
          initializeMissing: true,
        });
        const itemData = getMiscItem(user, req.itemId);
        const lastUpdateDate = getChargeItemLastUpdateDate(user, req.itemId, now);
        console.log(
          `[stamina:PVP_CHARGE_POINT_REFRESH_REQ] ACK packetId=${PVP_CHARGE_POINT_REFRESH_ACK} itemId=${req.itemId} count=${String(
            itemData ? toBigInt(itemData.countFree || 0) + toBigInt(itemData.countPaid || 0) : 0n
          )}`
        );
        send(ctx, socket, packet, PVP_CHARGE_POINT_REFRESH_ACK, buildPvpChargePointRefreshAckPayload(itemData, lastUpdateDate));
        if (refresh.changed) persist(ctx);
        return true;
      },
    },
  ];
}

function ensureStaminaState(user) {
  if (!user || typeof user !== "object") {
    return {
      chargeItems: {},
    };
  }
  user.stamina = user.stamina && typeof user.stamina === "object" && !Array.isArray(user.stamina) ? user.stamina : {};
  user.stamina.chargeItems =
    user.stamina.chargeItems && typeof user.stamina.chargeItems === "object" && !Array.isArray(user.stamina.chargeItems)
      ? user.stamina.chargeItems
      : {};
  return user.stamina;
}

function hasStaminaState(user) {
  if (!user || typeof user !== "object" || !user.stamina) return false;
  const state = ensureStaminaState(user);
  return Object.keys(state.chargeItems || {}).length > 0;
}

function refreshTimedStamina(user, options = {}) {
  const now = normalizeDateTimeTicks(options.now || dateTimeBinaryNow());
  const selectedItemIds = new Set(
    (Array.isArray(options.itemIds) && options.itemIds.length > 0 ? options.itemIds : getTimedStaminaRoutes(user).map((route) => route.itemId))
      .map((itemId) => Number(itemId))
      .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
  );
  const routes = getTimedStaminaRoutes(user).filter((route) => selectedItemIds.has(route.itemId));
  const updates = [];
  let changed = false;

  for (const route of routes) {
    const before = getMiscItem(user, route.itemId);
    const beforeTotal = getItemTotal(before);
    const state = getChargeItemState(user, route.itemId);
    const hadLastUpdate = state.lastUpdateDate != null && state.lastUpdateDate !== "";
    const lastUpdateDate = normalizeDateTimeTicks(state.lastUpdateDate || now);
    const result =
      route.kind === "daily"
        ? refreshDailyRoute(user, route, before, beforeTotal, lastUpdateDate, now, {
            initializeMissing: options.initializeMissing !== false || !hadLastUpdate,
          })
        : refreshIntervalRoute(user, route, before, beforeTotal, lastUpdateDate, now, {
            initializeMissing: options.initializeMissing !== false || !hadLastUpdate,
          });

    state.lastUpdateDate = String(result.lastUpdateDate);
    state.lastUpdateIso = new Date(ticksToUnixMs(result.lastUpdateDate)).toISOString();
    state.kind = route.kind;
    state.max = route.max;
    state.amount = route.amount;
    state.intervalSeconds = route.intervalSeconds || 0;
    state.refreshHourUtc = route.refreshHourUtc == null ? null : route.refreshHourUtc;

    if (result.changed) {
      changed = true;
      const itemData = getMiscItem(user, route.itemId);
      updates.push({
        itemId: route.itemId,
        itemData,
        lastUpdateDate: result.lastUpdateDate,
      });
    }
  }

  return { changed, updates };
}

function buildChargeItemNotPayload(update = {}) {
  const itemData = update.itemData || null;
  return Buffer.concat([
    writeInt64LE(normalizeDateTimeTicks(update.lastUpdateDate || dateTimeBinaryNow())),
    itemData ? writeNullableObject(buildItemMiscData(itemData)) : writeNullableObject(buildItemMiscData({ itemId: 0 })),
  ]);
}

function getChargeItemNotifications(user, options = {}) {
  const now = normalizeDateTimeTicks(options.now || dateTimeBinaryNow());
  const selectedItemIds = new Set(
    (Array.isArray(options.itemIds) && options.itemIds.length > 0 ? options.itemIds : getTimedStaminaRoutes(user).map((route) => route.itemId))
      .map((itemId) => Number(itemId))
      .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
  );
  return getTimedStaminaRoutes(user)
    .filter((route) => selectedItemIds.has(route.itemId))
    .map((route) => {
      const itemData = getMiscItem(user, route.itemId);
      if (!itemData) return null;
      return {
        itemId: route.itemId,
        itemData,
        lastUpdateDate: getChargeItemLastUpdateDate(user, route.itemId, now),
      };
    })
    .filter(Boolean);
}

function buildPvpChargePointRefreshAckPayload(itemData, chargeTime) {
  return Buffer.concat([
    writeSignedVarInt(0),
    itemData ? writeNullableObject(buildItemMiscData(itemData)) : writeNullableObject(buildItemMiscData({ itemId: 0 })),
    writeInt64LE(normalizeDateTimeTicks(chargeTime || dateTimeBinaryNow())),
  ]);
}

function getChargeItemLastUpdateDate(user, itemId, fallback = dateTimeBinaryNow()) {
  const state = getChargeItemState(user, itemId);
  return normalizeDateTimeTicks(state.lastUpdateDate || fallback);
}

function getTimedStaminaRoutes(user) {
  const pvpConst = getPvpConst();
  const userExp = getPlayerExpRow(Number((user && user.level) || 1));
  const rechargeSeconds = Number(process.env.CS_STAMINA_ETERNIUM_INTERVAL_SECONDS || 300);
  const eterniumAmount = Math.max(1, Number(process.env.CS_STAMINA_ETERNIUM_AMOUNT || (userExp && userExp.m_RechargeEternium) || 75));
  const eterniumMax = Math.max(1, Number(process.env.CS_STAMINA_ETERNIUM_MAX || (userExp && userExp.m_Eternium_MaxCap_Level) || 5000));
  const asyncInterval = Math.max(1, Number(process.env.CS_STAMINA_ASYNC_PVP_INTERVAL_SECONDS || pvpConst.AsyncTicketChargeInterval || 7200));
  const asyncAmount = Math.max(1, Number(process.env.CS_STAMINA_ASYNC_PVP_AMOUNT || pvpConst.AsyncTicketChargeCount || 1));
  const asyncMax = Math.max(1, Number(process.env.CS_STAMINA_ASYNC_PVP_MAX || pvpConst.AsyncTicketMaxCount || 6));
  const pvpIntervalSeconds = Math.max(
    1,
    Number(process.env.CS_STAMINA_PVP_POINT_INTERVAL_SECONDS || Math.floor(Number(pvpConst.ChargePointRefreshIntervalTicks || 216000000000) / 10000000))
  );
  const pvpAmount = Math.max(1, Number(process.env.CS_STAMINA_PVP_POINT_AMOUNT || pvpConst.ChargePointCount || 225));
  const pvpMax = Math.max(1, Number(process.env.CS_STAMINA_PVP_POINT_MAX || pvpConst.ChargePointMax || 900));
  const pvpPracticeMax = Math.max(1, Number(process.env.CS_STAMINA_PVP_PRACTICE_POINT_MAX || pvpConst.ChargePointMaxCountForPractice || 100));
  const dailyTicketAmount = Math.max(1, Number(process.env.CS_STAMINA_DAILY_TICKET_AMOUNT || 2));
  const dailyTicketMax = Math.max(1, Number(process.env.CS_STAMINA_DAILY_TICKET_MAX || 2));
  const simulationTicketAmount = Math.max(1, Number(process.env.CS_STAMINA_SIMULATION_DAILY_AMOUNT || 2));
  const simulationTicketMax = Math.max(1, Number(process.env.CS_STAMINA_SIMULATION_MAX || 2));
  const divePermitAmount = Math.max(1, Number(process.env.CS_STAMINA_DIVE_DAILY_AMOUNT || 2));
  const divePermitMax = Math.max(1, Number(process.env.CS_STAMINA_DIVE_MAX || 10));

  return [
    {
      itemId: ITEM_IDS.ETERNIUM,
      name: "eternium",
      kind: "interval",
      intervalSeconds: rechargeSeconds,
      amount: eterniumAmount,
      max: eterniumMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.ASYNC_PVP_TICKET,
      name: "async-pvp-ticket",
      kind: "interval",
      intervalSeconds: asyncInterval,
      amount: asyncAmount,
      max: asyncMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.DAILY_TICKET,
      name: "daily-ticket",
      kind: "daily",
      refreshHourUtc: DAILY_UTC_HOUR,
      amount: dailyTicketAmount,
      max: dailyTicketMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.PVP_CHARGE_POINT,
      name: "pvp-charge-point",
      kind: "interval",
      intervalSeconds: pvpIntervalSeconds,
      amount: pvpAmount,
      max: pvpMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.PVP_PRACTICE_CHARGE_POINT,
      name: "pvp-practice-charge-point",
      kind: "daily",
      refreshHourUtc: DAILY_UTC_HOUR,
      amount: pvpPracticeMax,
      max: pvpPracticeMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.SIM_ATTACK_TICKET,
      name: "simulation-attack-ticket",
      kind: "daily",
      refreshHourUtc: DAILY_UTC_HOUR,
      amount: simulationTicketAmount,
      max: simulationTicketMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.SIM_DEFENSE_TICKET,
      name: "simulation-defense-ticket",
      kind: "daily",
      refreshHourUtc: DAILY_UTC_HOUR,
      amount: simulationTicketAmount,
      max: simulationTicketMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.SIM_AIR_TICKET,
      name: "simulation-air-ticket",
      kind: "daily",
      refreshHourUtc: DAILY_UTC_HOUR,
      amount: simulationTicketAmount,
      max: simulationTicketMax,
      freeOnly: true,
    },
    {
      itemId: ITEM_IDS.DIVE_PERMIT,
      name: "dive-permit",
      kind: "daily",
      refreshHourUtc: DAILY_UTC_HOUR,
      amount: divePermitAmount,
      max: divePermitMax,
      freeOnly: true,
    },
  ];
}

function refreshIntervalRoute(user, route, before, beforeTotal, lastUpdateDate, now, options = {}) {
  const max = BigInt(Math.max(0, Math.floor(Number(route.max || 0))));
  const amount = BigInt(Math.max(0, Math.floor(Number(route.amount || 0))));
  const intervalTicks = BigInt(Math.max(1, Math.floor(Number(route.intervalSeconds || 1)))) * TICKS_PER_SECOND;
  if (max <= 0n || amount <= 0n) return { changed: false, lastUpdateDate };

  if (beforeTotal >= max) {
    return { changed: false, lastUpdateDate: now };
  }

  if (!before || options.initializeMissing) {
    const item = setRouteBalance(user, route, max);
    return { changed: true, lastUpdateDate: now, item };
  }

  const elapsedTicks = stripDateTimeMask(now) - stripDateTimeMask(lastUpdateDate);
  if (elapsedTicks < intervalTicks) return { changed: false, lastUpdateDate };
  const periods = elapsedTicks / intervalTicks;
  if (periods <= 0n) return { changed: false, lastUpdateDate };
  const nextTotal = beforeTotal + periods * amount > max ? max : beforeTotal + periods * amount;
  const consumedTicks = periods * intervalTicks;
  const nextUpdateDate = addTicks(lastUpdateDate, consumedTicks);
  if (nextTotal <= beforeTotal) return { changed: false, lastUpdateDate: nextUpdateDate };
  const item = setRouteBalance(user, route, nextTotal);
  return { changed: true, lastUpdateDate: nextTotal >= max ? now : nextUpdateDate, item };
}

function refreshDailyRoute(user, route, before, beforeTotal, lastUpdateDate, now, options = {}) {
  const max = BigInt(Math.max(0, Math.floor(Number(route.max || 0))));
  const amount = BigInt(Math.max(0, Math.floor(Number(route.amount || 0))));
  if (max <= 0n || amount <= 0n) return { changed: false, lastUpdateDate };

  const currentBoundaryMs = latestDailyBoundaryMs(ticksToUnixMs(now), route.refreshHourUtc);
  const currentBoundary = unixMsToDateTimeBinary(currentBoundaryMs);
  if (beforeTotal >= max) {
    return { changed: false, lastUpdateDate: currentBoundary };
  }

  if (!before || options.initializeMissing) {
    const item = setRouteBalance(user, route, max);
    return { changed: true, lastUpdateDate: currentBoundary, item };
  }

  const lastBoundaryMs = latestDailyBoundaryMs(ticksToUnixMs(lastUpdateDate), route.refreshHourUtc);
  const periods = Math.max(0, Math.floor((currentBoundaryMs - lastBoundaryMs) / DAY_MS));
  if (periods <= 0) return { changed: false, lastUpdateDate };
  const gained = BigInt(periods) * amount;
  const nextTotal = beforeTotal + gained > max ? max : beforeTotal + gained;
  if (nextTotal <= beforeTotal) return { changed: false, lastUpdateDate: currentBoundary };
  const item = setRouteBalance(user, route, nextTotal);
  return { changed: true, lastUpdateDate: currentBoundary, item };
}

function setRouteBalance(user, route, total) {
  const current = getMiscItem(user, route.itemId);
  const countPaid = route.freeOnly ? 0n : toBigInt(current && current.countPaid ? current.countPaid : 0);
  const paid = countPaid > total ? total : countPaid;
  const free = total - paid;
  return setMiscItemBalance(user, route.itemId, free, paid, {
    bonusRatio: current && current.bonusRatio,
    regDate: current && current.regDate,
  });
}

function getChargeItemState(user, itemId) {
  const state = ensureStaminaState(user);
  const key = String(Number(itemId) || 0);
  state.chargeItems[key] =
    state.chargeItems[key] && typeof state.chargeItems[key] === "object" && !Array.isArray(state.chargeItems[key])
      ? state.chargeItems[key]
      : {};
  return state.chargeItems[key];
}

function getItemTotal(item) {
  if (!item) return 0n;
  return toBigInt(item.countFree || 0) + toBigInt(item.countPaid || 0);
}

function decodePvpChargePointRefreshReq(ctx, encryptedPayload) {
  const payload = decrypt(ctx, encryptedPayload);
  try {
    const itemId = readSignedVarInt(payload, 0).value;
    return { itemId: Number(itemId || 0) || ITEM_IDS.PVP_CHARGE_POINT };
  } catch (_) {
    return { itemId: ITEM_IDS.PVP_CHARGE_POINT };
  }
}

function decrypt(ctx, payload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function send(ctx, socket, packet, packetId, payload) {
  if (!ctx || typeof ctx.sendResponse !== "function") return;
  ctx.sendResponse(socket, packet.sequence, packetId, () => ctx.buildEncryptedPacket(packet.sequence, packetId, payload));
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function persist(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function getNow(ctx) {
  return ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
}

function getPlayerExpRow(level) {
  const rows = getPlayerExpRows();
  if (rows.length === 0) return null;
  const numericLevel = Math.max(1, Number(level || 1) || 1);
  return rows.find((row) => Number(row.m_iLevel || 0) === numericLevel) || rows[rows.length - 1] || null;
}

function getPlayerExpRows() {
  if (cachedPlayerExpRows) return cachedPlayerExpRows;
  cachedPlayerExpRows = readGameplayTableRecords("ab_script", "LUA_PLAYER_EXP_TABLE.json", { rootDir: ROOT_DIR, logLabel: "stamina" })
    .filter((row) => Number.isInteger(Number(row && row.m_iLevel)))
    .sort((left, right) => Number(left.m_iLevel || 0) - Number(right.m_iLevel || 0));
  return cachedPlayerExpRows;
}

function getPvpConst() {
  if (cachedPvpConst) return cachedPvpConst;
  const parsed = readGameplayTable("ab_script", "LUA_PVP_CONST.json", { rootDir: ROOT_DIR, logLabel: "stamina" });
  cachedPvpConst = (parsed && parsed.root) || {};
  return cachedPvpConst;
}

function latestDailyBoundaryMs(nowMs, refreshHourUtc) {
  const hour = Math.max(0, Math.min(23, Number(refreshHourUtc == null ? DAILY_UTC_HOUR : refreshHourUtc) || 0));
  const date = new Date(Number(nowMs));
  const boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0, 0, 0);
  return Number(nowMs) >= boundary ? boundary : boundary - DAY_MS;
}

function normalizeDateTimeTicks(value) {
  const ticks = toBigInt(value || 0);
  if (ticks <= 0n) return dateTimeBinaryNow();
  return ticks | DATE_TIME_LOCAL_MASK;
}

function stripDateTimeMask(value) {
  return toBigInt(value || 0) & DATE_TIME_TICK_MASK;
}

function addTicks(dateTime, ticks) {
  return (stripDateTimeMask(dateTime) + BigInt(ticks || 0)) | DATE_TIME_LOCAL_MASK;
}

function ticksToUnixMs(dateTime) {
  const ticks = stripDateTimeMask(dateTime);
  return Number((ticks - TICKS_AT_UNIX_EPOCH) / TICKS_PER_MILLISECOND);
}

function unixMsToDateTimeBinary(ms) {
  return (TICKS_AT_UNIX_EPOCH + BigInt(Math.floor(Number(ms || 0))) * TICKS_PER_MILLISECOND) | DATE_TIME_LOCAL_MASK;
}

module.exports = {
  CHARGE_ITEM_NOT,
  PVP_CHARGE_POINT_REFRESH_REQ,
  PVP_CHARGE_POINT_REFRESH_ACK,
  ITEM_IDS,
  createStaminaHandlers,
  ensureStaminaState,
  hasStaminaState,
  refreshTimedStamina,
  buildChargeItemNotPayload,
  getChargeItemNotifications,
  buildPvpChargePointRefreshAckPayload,
  getChargeItemLastUpdateDate,
  getTimedStaminaRoutes,
  loadStaminaTables: () => {
    getPlayerExpRows();
    getPvpConst();
  },
};
