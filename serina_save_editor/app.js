// RevivalSide/modmenu/app.js

const SERVER_API = "http://127.0.0.1:8088/user-manager/api";
const WIKI_DATA_PATH = "../data";  
const WIKI_SERVER_URL = "";

const state = {
    users: [],
    selectedUid: "",
    mode: "LIBRARY",   
    category: "units", 
    search: "",
    sortBy: "id_asc",
    currentPage: 1,    
    itemsPerPage: 10,  
    db: { idIndex: [], units: [], ships: [], operators: [], trophies: [], gears: [], items: [], skins: [], gearSets: [] },
    dict: { units: new Map(), gears: new Map(), items: new Map(), skins: new Map() },
    myInventory: { units: [], ships: [], operators: [], trophies: [], gears: [], items: [], skins: [] },
    filteredData: [],  
    pending: [],
    inventoryLoadedFor: null,
    tempGearItem: null
};

const POPULAR_SUBSTATS = [
    { type: "NST_SKILL_COOL_TIME_REDUCE_RATE", label: "Skill Haste" },
    { type: "NST_ATTACK_SPEED_RATE", label: "Attack Speed" },
    { type: "NST_MOVE_TYPE_LAND_DAMAGE_RATE", label: "Anti-Ground DMG" },
    { type: "NST_MOVE_TYPE_LAND_DAMAGE_REDUCE_RATE", label: "Anti-Ground RES" },
    { type: "NST_MOVE_TYPE_AIR_DAMAGE_RATE", label: "Anti-Air DMG" },
    { type: "NST_MOVE_TYPE_AIR_DAMAGE_REDUCE_RATE", label: "Anti-Air RES" },
    { type: "NST_CRITICAL_DAMAGE_RATE", label: "Crit DMG" },
    { type: "NST_CRITICAL_DAMAGE_RESIST_RATE", label: "Crit DMG RES" },
    { type: "NST_DAMAGE_REDUCE_RATE", label: "Generic DMG RES" },
    { type: "NST_ROLE_TYPE_STRIKER_DAMAGE_RATE", label: "Anti-Striker DMG" },
    { type: "NST_ROLE_TYPE_DEFFENDER_DAMAGE_RATE", label: "Anti-Defender DMG" },
    { type: "NST_ROLE_TYPE_RANGER_DAMAGE_RATE", label: "Anti-Ranger DMG" },
    { type: "NST_ROLE_TYPE_SNIPER_DAMAGE_RATE", label: "Anti-Sniper DMG" },
    { type: "NST_HP", label: "HP (Flat)" },
    { type: "NST_ATK", label: "ATK (Flat)" },
    { type: "NST_DEF", label: "DEF (Flat)" },
    { type: "NST_CRITICAL", label: "CRIT (Flat)" },
    { type: "NST_HIT", label: "HIT (Accuracy)" },
    { type: "NST_EVADE", label: "EVADE (Evasion)" }
];

function isSingleUseItem(item) {
    return item.rType === "RT_SKIN";
}

function isAlreadyQueued(action, idOrUid) {
    return state.pending.some(p => p.action === action &&
        String(state.mode === "LIBRARY" ? p.item.id : p.item.uid) === String(idOrUid));
}

const els = {
    userSelect: document.getElementById("userSelect"),
    btnRefreshUsers: document.getElementById("btnRefreshUsers"),
    btnShowGuide: document.getElementById("btnShowGuide"),
    searchInput: document.getElementById("searchInput"),
    sortSelect: document.getElementById("sortSelect"),
    perPageSelect: document.getElementById("perPageSelect"),
    btnSelectAll: document.getElementById("btnSelectAll"),
    tabLibrary: document.getElementById("tabLibrary"),
    tabInventory: document.getElementById("tabInventory"),
    categoryTabs: document.getElementById("categoryTabs"),
    tableBody: document.getElementById("tableBody"),
    dataStamp: document.getElementById("dataStamp"),
    btnPrev: document.getElementById("btnPrev"),
    btnNext: document.getElementById("btnNext"),
    pageInfo: document.getElementById("pageInfo"),
    pendingList: document.getElementById("pendingList"),
    pendingCount: document.getElementById("pendingCount"),
    btnCommit: document.getElementById("btnCommit"),
    btnClearPending: document.getElementById("btnClearPending"),
    toastContainer: document.getElementById("toastContainer"),
    sectionTitle: document.getElementById("sectionTitle"),
    resultCount: document.getElementById("resultCount"),
    guideModal: document.getElementById("guideModal"),
    btnCloseGuide: document.getElementById("btnCloseGuide"),
    
    gearModal: document.getElementById("gearModal"),
    gearModalItemName: document.getElementById("gearModalItemName"),
    gearSetSelect: document.getElementById("gearSetSelect"),
    gearSub1Select: document.getElementById("gearSub1Select"),
    gearSub2Select: document.getElementById("gearSub2Select"),
    gearModalQty: document.getElementById("gearModalQty"),
    gearForceOverride: document.getElementById("gearForceOverride"),
    btnConfirmGear: document.getElementById("btnConfirmGear"),
    btnCancelGear: document.getElementById("btnCancelGear")
};

// ==========================================
// UTILS & LOGS
// ==========================================
function debugLog(step, detail = "") {
    const timeNow = performance.now();
    if (state.lastLogTime) {
        const diff = (timeNow - state.lastLogTime).toFixed(2);
        console.log(`%c[DEBUG] ⏱️ ${step}`, 'color: #63b9b1; font-weight: bold;', detail, `(+${diff}ms)`);
    } else {
        console.log(`%c[DEBUG] 🚀 ${step}`, 'color: #dfb05b; font-weight: bold;', detail);
    }
    state.lastLogTime = timeNow;
    if (els.dataStamp) els.dataStamp.textContent = `${step}...`; 
}

function showToast(title, subtitle, type) {
    let imgSrc = "data/images/xiaolinsorry.png"; 
    if (type === "add_ok") imgSrc = "data/images/miya_thumbup.png";
    if (type === "del_ok") imgSrc = "data/images/yumi_donut.png";

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `
        <img src="${imgSrc}" onerror="this.style.display='none';">
        <div class="message">
            ${title}
            <div class="sub-message">${subtitle}</div>
        </div>
    `;
    
    els.toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

function toggleGuideModal(show) {
    if (show) {
        els.guideModal.style.display = "flex";
        setTimeout(() => els.guideModal.style.opacity = "1", 10);
    } else {
        els.guideModal.style.opacity = "0";
        setTimeout(() => els.guideModal.style.display = "none", 300);
    }
}
function toggleGearModal(show) {
    if (show) {
        els.gearModal.style.display = "flex";
        setTimeout(() => els.gearModal.style.opacity = "1", 10);
    } else {
        els.gearModal.style.opacity = "0";
        setTimeout(() => els.gearModal.style.display = "none", 300);
    }
}

els.btnShowGuide.addEventListener("click", () => toggleGuideModal(true));
els.btnCloseGuide.addEventListener("click", () => toggleGuideModal(false));
els.btnCancelGear.addEventListener("click", () => {
    state.editingPendingId = null;
    toggleGearModal(false);
});

// ==========================================
// INDEXED-DB CACHE SYSTEM
// ==========================================
const CacheDB = {
    db: null,
    async init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open("SerinaShopDB", 4); 
            req.onupgradeneeded = (e) => {
                let db = e.target.result;
                if (!db.objectStoreNames.contains("wikiData")) {
                    db.createObjectStore("wikiData");
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            req.onerror = (e) => reject(e);
        });
    },
    async get(key) {
        return new Promise((resolve) => {
            if (!this.db) return resolve(null);
            const tx = this.db.transaction("wikiData", "readonly");
            const store = tx.objectStore("wikiData");
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    },
    async set(key, data) {
        return new Promise((resolve) => {
            if (!this.db) return resolve();
            const tx = this.db.transaction("wikiData", "readwrite");
            const store = tx.objectStore("wikiData");
            store.put(data, key);
            tx.oncomplete = () => resolve();
        });
    }
};

// ==========================================
// 1. LOAD WIKI DATA 
// ==========================================
async function loadWikiDatabase() {
    try {
        let cachedData = null;
        try {
            await CacheDB.init();
            debugLog("Checking local cache...");
            cachedData = await CacheDB.get("parsedWikiDB");
        } catch (e) {
            console.warn("IndexedDB may be blocked (running via file://). Proceeding to fetch data directly.");
        }

        if (cachedData && cachedData.db && cachedData.db.units && cachedData.db.gearSets) {
            debugLog("Loading from IndexedDB Cache (Super Fast)");
            state.db = cachedData.db;
            
            state.db.units.forEach(u => state.dict.units.set(Number(u.id), u));
            state.db.ships.forEach(s => state.dict.units.set(Number(s.id), s));
            state.db.operators.forEach(o => state.dict.units.set(Number(o.id), o));
            state.db.trophies.forEach(t => state.dict.units.set(Number(t.id), t));
            state.db.items.forEach(i => state.dict.items.set(Number(i.id), i));
            state.db.gears.forEach(g => state.dict.gears.set(Number(g.id), g));
            state.db.skins.forEach(s => state.dict.skins.set(Number(s.id), s));
            
            populateGearDropdowns();
            debugLog("Wiki Data Restored from Cache");
            return;
        }

        debugLog(`Cache empty. Fetching JSON from Wiki Server (${WIKI_SERVER_URL})...`);
        const [idIdxRes, unitsRes, itemsRes, gearsRes, skinsRes, gearSetRes] = await Promise.all([
            fetch(`${WIKI_DATA_PATH}/idIndex.json`), fetch(`${WIKI_DATA_PATH}/units.json`), 
            fetch(`${WIKI_DATA_PATH}/items.json`), fetch(`${WIKI_DATA_PATH}/gears.json`), 
            fetch(`${WIKI_DATA_PATH}/skins.json`), fetch(`${WIKI_DATA_PATH}/gearSetBonuses.json`)
        ]);

        const rawIdIndex = await idIdxRes.json();
        const rawUnits = await unitsRes.json();
        let rawItems = await itemsRes.json();
        const rawGears = await gearsRes.json();
        const rawSkins = await skinsRes.json();
        const rawGearSets = await gearSetRes.json();

        debugLog("Filtering Molds & Building Hash Maps...");

        rawItems = rawItems.filter(i => i.category !== "Mold");

        const prepare = (arr, rType) => arr
            .filter(i => i && i.id != null && i.name !== "undefined" && i.name != null)
            .map(i => {
                const searchStr = `${i.name || ""} ${i.strId || ""} ${i.id} ${i.table || ""}`.toLowerCase();
                return { ...i, rType, _searchStr: searchStr };
            });

        state.db.idIndex = prepare(rawIdIndex, "RT_NONE");
        const allUnits = prepare(rawUnits, "RT_UNIT");
        
        state.db.ships = allUnits.filter(u => u.type === "NUT_SHIP").map(u => ({...u, rType: "RT_SHIP"}));
        state.db.operators = allUnits.filter(u => u.type === "NUT_OPERATOR").map(u => ({...u, rType: "RT_OPERATOR"}));
        state.db.trophies = allUnits.filter(u => u.style === "NUST_TRAINER");
        state.db.units = allUnits.filter(u => u.type !== "NUT_SHIP" && u.type !== "NUT_OPERATOR" && u.style !== "NUST_TRAINER");
        
        state.db.items = prepare(rawItems, "RT_MISC");
        state.db.gears = prepare(rawGears, "RT_EQUIP");
        state.db.skins = prepare(rawSkins, "RT_SKIN");
        state.db.gearSets = rawGearSets;

        state.db.units.forEach(u => state.dict.units.set(Number(u.id), u));
        state.db.ships.forEach(s => state.dict.units.set(Number(s.id), s));
        state.db.operators.forEach(o => state.dict.units.set(Number(o.id), o));
        state.db.trophies.forEach(t => state.dict.units.set(Number(t.id), t));
        state.db.items.forEach(i => state.dict.items.set(Number(i.id), i));
        state.db.gears.forEach(g => state.dict.gears.set(Number(g.id), g));
        state.db.skins.forEach(s => state.dict.skins.set(Number(s.id), s));

        try {
            debugLog("Saving parsed data to cache...");
            await CacheDB.set("parsedWikiDB", { db: state.db });
        } catch(e) {
            console.warn("Could not save to cache (file:// mode).");
        }

        populateGearDropdowns();
        debugLog("Wiki Data Loaded Successfully");
    } catch (err) {
        console.error(err);
        debugLog("❌ JSON Load Error", err.message);
        showToast("Database Error", "Ensure Game Server is running to fetch data.", "error");
    }
}

function populateGearDropdowns() {
    els.gearSetSelect.innerHTML = `<option value="0">Default (Native to item)</option>`;
    state.db.gearSets.forEach(set => {
        const opt = document.createElement("option");
        opt.value = set.id;
        opt.textContent = `[${set.parts}P] ${set.name} (${set.effect})`;
        els.gearSetSelect.appendChild(opt);
    });

    const createSubOptions = () => {
        let html = `<option value="">Default (Native to item)</option>`;
        POPULAR_SUBSTATS.forEach(stat => {
            html += `<option value="${stat.type}">${stat.label}</option>`;
        });
        return html;
    };
    
    els.gearSub1Select.innerHTML = createSubOptions();
    els.gearSub2Select.innerHTML = createSubOptions();
}

// ==========================================
// 2. FETCH PLAYER LIST
// ==========================================
async function fetchUsers() {
    try {
        debugLog("Fetching Player List...");
        els.userSelect.innerHTML = `<option value="">Connecting to Server...</option>`;
        
        const res = await fetch(`${SERVER_API}/users`);
        if (!res.ok) throw new Error("Connection refused (Port 8088)");
        const data = await res.json();
        
        state.users = data.users || [];
        els.userSelect.innerHTML = "";
        
        if (state.users.length === 0) {
            els.userSelect.innerHTML = `<option value="">No players found</option>`;
            return;
        }

        state.users.forEach(u => {
            const opt = document.createElement("option");
            opt.value = u.userUid;
            opt.textContent = `${u.nickname} (Lv.${u.level}) ${u.isActive ? "🟢 [Online]" : ""}`;
            els.userSelect.appendChild(opt);
            if (u.isActive) state.selectedUid = u.userUid;
        });

        if (!state.selectedUid) state.selectedUid = state.users[0].userUid;
        els.userSelect.value = state.selectedUid;
        
        debugLog("Player List Loaded");
        
        if (state.mode === "INVENTORY") await loadMyInventory();
        else renderTable();

    } catch (err) {
        debugLog("❌ API Error", err.message);
        els.userSelect.innerHTML = `<option value="">❌ Server Error!</option>`;
        showToast("Connection Failed", "Ensure Game Server is running.", "error");
    }
}

// ==========================================
// 3. FETCH USER INVENTORY
// ==========================================
async function loadMyInventory() {
    if (!state.selectedUid) return;
    try {
        debugLog("Loading Player Inventory", `UID: ${state.selectedUid}`);
        els.tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center;">Analyzing inventory...</td></tr>`;
        
        const res = await fetch(`${SERVER_API}/users/${state.selectedUid}`);
        const data = await res.json();
        const user = data.user;

        state.myInventory = { idIndex: [], units: [], ships: [], operators: [], trophies: [], gears: [], items: [], skins: [] };
        
        const findWikiFast = (dict, id) => dict.get(Number(id)) || null;

        const pushInv = (cat, itemData) => {
            const searchStr = `${itemData.name || ""} ${itemData.strId || ""} ${itemData.id} ${itemData.realId || ""}`.toLowerCase();
            state.myInventory[cat].push({ ...itemData, _searchStr: searchStr });
        };

        if (user.inventory && user.inventory.misc) {
            Object.values(user.inventory.misc).forEach(item => {
                const w = findWikiFast(state.dict.items, item.itemId);
                if (!w || w.category === "Mold") return;
                const count = parseInt(item.countFree || 0) + parseInt(item.countPaid || 0);
                pushInv("items", { ...w, rType: "RT_MISC", uid: item.itemId, realId: item.itemId, countText: `x${count}`, count: count });
            });
        }

        if (user.army && user.army.units) {
            Object.values(user.army.units).forEach(unit => {
                const wUnit = findWikiFast(state.dict.units, unit.unitId) || { name: `Unit (${unit.unitId})` };
                pushInv("units", { ...wUnit, rType: "RT_UNIT", uid: unit.unitUid, realId: unit.unitId, countText: `Lv.${unit.level||1}`, count: unit.level||1 });
            });
        }

        if (user.army && user.army.trophies) {
            Object.values(user.army.trophies).forEach(trophy => {
                const wTrophy = findWikiFast(state.dict.units, trophy.unitId) || { name: `Trophy (${trophy.unitId})` };
                pushInv("trophies", { ...wTrophy, rType: "RT_UNIT", uid: trophy.unitUid, realId: trophy.unitId, countText: `Lv.${trophy.level||1}`, count: trophy.level||1 });
            });
        }
        
        if (user.army && user.army.ships) {
            Object.values(user.army.ships).forEach(ship => {
                const wShip = findWikiFast(state.dict.units, ship.unitId) || { name: `Ship (${ship.unitId})` };
                pushInv("ships", { ...wShip, rType: "RT_SHIP", uid: ship.unitUid, realId: ship.unitId, countText: `Lv.${ship.level||1}`, count: ship.level||1 });
            });
        }
        
        if (user.army && user.army.operators) {
            Object.values(user.army.operators).forEach(op => {
                const opId = op.unitId || op.operatorId || op.id;
                const wOp = findWikiFast(state.dict.units, opId) || { name: `Operator (${opId})` };
                pushInv("operators", { ...wOp, rType: "RT_OPERATOR", uid: op.uid, realId: opId, countText: `Lv.${op.level||1}`, count: op.level||1 });
            });
        }

        if (user.inventory && user.inventory.equips) {
            const equipsArr = Object.entries(user.inventory.equips);
            equipsArr.forEach(([equipKey, eq]) => {
                let eqId, eqUid, enchantLevel;
                if (eq !== null && typeof eq === "object") {
                    eqId = eq.equipId ?? eq.equipID ?? eq.itemId ?? eq.tid ?? eq.cfgId ?? eq.configId ?? eq.no ?? eq.id;
                    eqUid = eq.equipUid ?? eq.uid ?? eq.equipUID ?? equipKey;
                    enchantLevel = eq.enchantLevel ?? eq.enchant ?? eq.level ?? 0;
                } else {
                    eqId = eq;
                    eqUid = equipKey;
                    enchantLevel = 0;
                }
                const wEq = findWikiFast(state.dict.gears, eqId) || { name: `Equip (${eqId ?? "?"})` };
                pushInv("gears", { ...wEq, rType: "RT_EQUIP", uid: eqUid, realId: eqId, countText: `+${enchantLevel}`, count: enchantLevel });
            });
        }

        if (user.inventory && user.inventory.skins) {
            user.inventory.skins.forEach(skinId => {
                const wSkin = findWikiFast(state.dict.skins, skinId) || { name: `Skin (${skinId})` };
                pushInv("skins", { ...wSkin, rType: "RT_SKIN", uid: skinId, realId: skinId, countText: "Owned", count: 1 });
            });
        }

        Object.keys(state.myInventory).forEach(k => state.myInventory[k].reverse());
        state.inventoryLoadedFor = state.selectedUid;
        debugLog("Inventory Mapping Complete");
        renderTable();
    } catch (err) {
        debugLog("❌ Inventory Error", err.message);
        showToast("Load Failed", "Could not analyze player inventory.", "error");
    }
}

// ==========================================
// 4. RENDER TABLE, FILTER & SORT
// ==========================================
function renderTable() {
    debugLog("Rendering Table...");
    let dataSource = [];
    if (state.mode === "LIBRARY") {
        if (els.sectionTitle) els.sectionTitle.textContent = "Shop Library";
        dataSource = state.db[state.category] || [];
    } else {
        if (els.sectionTitle) els.sectionTitle.textContent = "My Inventory";
        dataSource = state.myInventory[state.category] || [];
    }

    const kw = state.search.toLowerCase();
    let filtered = dataSource;
    if (kw) filtered = dataSource.filter(item => item._searchStr && item._searchStr.includes(kw));

    filtered.sort((a, b) => {
        let valA, valB;
        switch(state.sortBy) {
            case "id_asc": return Number(a.id || a.realId || 0) - Number(b.id || b.realId || 0);
            case "id_desc": return Number(b.id || b.realId || 0) - Number(a.id || a.realId || 0);
            case "name_asc": return String(a.name || "").localeCompare(String(b.name || ""));
            case "name_desc": return String(b.name || "").localeCompare(String(a.name || ""));
            case "count_desc": 
                valA = Number(a.count || 0); valB = Number(b.count || 0);
                return valB - valA;
            default: return 0;
        }
    });

    state.filteredData = filtered;

    const totalItems = state.filteredData.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / state.itemsPerPage));
    if (state.currentPage > totalPages) state.currentPage = Math.max(1, totalPages);

    const startIdx = (state.currentPage - 1) * state.itemsPerPage;
    const endIdx = startIdx + state.itemsPerPage;
    const pageData = state.filteredData.slice(startIdx, endIdx);

    if (els.resultCount) els.resultCount.textContent = `Found ${totalItems} items.`;
    els.tableBody.innerHTML = "";

    pageData.forEach(item => {
        const tr = document.createElement("tr");

        let cleanPath = item.image ? (item.image.startsWith('/') ? item.image : `/${item.image}`) : "";
        let imgUrl = cleanPath ? `${WIKI_SERVER_URL}${cleanPath}` : "";
        let displayId = state.mode === "LIBRARY" ? item.id : (item.realId || item.id);
        
        let actionHtml = "";
        if (state.category === "idIndex") {
            actionHtml = `<span style="color:var(--muted); font-size: 12px;">(Read-only)</span>`;
        } else if (state.mode === "LIBRARY") {
            const isSingle = isSingleUseItem(item);
            const isEquip = item.rType === "RT_EQUIP";
            const clickAction = isEquip ? `openGearModal('${item.id}')` : `queueItem('${item.id}')`;
            
            const inputHtml = isEquip ? 
                `<span style="color:var(--teal); font-size:11px; margin-right:5px; font-style:italic;">Customizable</span>` :
                `<input type="number" id="amt_${item.id}" class="input-number" value="1" min="1" ${isSingle ? 'disabled title="Only 1 allowed"' : ''}>`;

            actionHtml = `
                ${inputHtml}
                <button type="button" class="btn-send" onclick="${clickAction}">➕ Queue</button>
            `;
        } else if (state.category === "items") {
            actionHtml = `
                <input type="number" id="qty_${item.uid}" class="input-number" value="${item.count}" min="0">
                <button type="button" class="btn-secondary" onclick="queueEditItem('${item.uid}')" title="Update quantity">💾 Save</button>
                <button type="button" class="btn-delete" onclick="queueItem('${item.uid}')">🗑️</button>
            `;
        } else {
            actionHtml = `
                <span style="font-weight:bold; color:var(--amber); margin-right: 15px;">${item.countText}</span>
                <button type="button" class="btn-delete" onclick="queueItem('${item.uid}')">🗑️ Queue</button>
            `;
        }

        tr.innerHTML = `
            <td style="text-align:center;">
                <div class="item-img-wrapper">
                    ${imgUrl ? `<img src="${imgUrl}" class="item-img" alt="" onerror="this.style.display='none'; this.parentElement.querySelector('.no-img').style.display='flex';">` : ''}
                    <div class="no-img" style="display:${imgUrl ? 'none' : 'flex'};">No Img</div>
                </div>
            </td>
            <td class="mono" style="color:var(--teal); font-weight:bold;">${displayId}</td>
            <td class="info-col">
                <div class="item-meta">
                    <span class="item-name" title="${item.name}">${item.name || "Unknown"}</span>
                    <span class="item-strid" title="${item.strId}">${item.strId || ""}</span>
                </div>
            </td>
            <td class="action-col" style="text-align: right;">
                <div style="display: flex; gap: 5px; justify-content: flex-end; align-items: center; height: 100%;">
                    ${actionHtml}
                </div>
            </td>
        `;
        els.tableBody.appendChild(tr);
    });

    for (let i = pageData.length; i < state.itemsPerPage; i++) {
        const emptyTr = document.createElement("tr");
        emptyTr.innerHTML = `<td colspan="4"></td>`;
        els.tableBody.appendChild(emptyTr);
    }

    if (els.pageInfo) els.pageInfo.textContent = `Page ${state.currentPage} / ${totalPages}`;
    if (els.btnPrev) els.btnPrev.disabled = state.currentPage <= 1;
    if (els.btnNext) els.btnNext.disabled = state.currentPage >= totalPages;

    debugLog("Table Rendered");
}

// ==========================================
// 5. GEAR CUSTOMIZATION MODAL
// ==========================================
window.openGearModal = function(itemId, pendingIdKey = null) {
    const item = state.db.gears.find(i => String(i.id) === String(itemId));
    if (!item) return;

    state.tempGearItem = item;
    state.editingPendingId = pendingIdKey; 
    
    els.gearModalItemName.textContent = `[${item.id}] ${item.name || item.strId}`;
    
    els.gearSetSelect.value = "0";
    els.gearSub1Select.value = "";
    els.gearSub2Select.value = "";
    els.gearForceOverride.checked = true;
    if (els.gearModalQty) els.gearModalQty.value = "1";

    if (pendingIdKey) {
        const pItem = state.pending.find(p => p.idKey === pendingIdKey);
        if (pItem) {
            if (els.gearModalQty) els.gearModalQty.value = pItem.count;
            if (pItem.gearOptions) {
                if (pItem.gearOptions.setOptionId) els.gearSetSelect.value = pItem.gearOptions.setOptionId;
                if (pItem.gearOptions.customSubstats) {
                    pItem.gearOptions.customSubstats.forEach(sub => {
                        if (sub.slot === 1) els.gearSub1Select.value = sub.type;
                        if (sub.slot === 2) els.gearSub2Select.value = sub.type;
                    });
                }
                els.gearForceOverride.checked = !!pItem.gearOptions.overrideUnsupportedSetBonus;
            }
        }
        els.btnConfirmGear.textContent = "💾 Save Changes";
    } else {
        els.btnConfirmGear.textContent = "➕ Add to Queue";
    }

    toggleGearModal(true);
}

els.btnConfirmGear.addEventListener("click", () => {
    if (!state.tempGearItem) {
        toggleGearModal(false);
        return;
    }

    const item = state.tempGearItem;
    const gearOptions = {};
    const setId = Number(els.gearSetSelect.value);
    if (setId > 0) gearOptions.setOptionId = setId;

    const sub1 = els.gearSub1Select.value;
    const sub2 = els.gearSub2Select.value;
    
    const customSubstats = [];
    if (sub1) customSubstats.push({ slot: 1, type: sub1, valueKind: "max" });
    if (sub2) customSubstats.push({ slot: 2, type: sub2, valueKind: "max" });
    
    if (customSubstats.length > 0) gearOptions.customSubstats = customSubstats;

    if (els.gearForceOverride.checked) {
        gearOptions.overrideUnsupportedSetBonus = true;
        gearOptions.overrideUnsupportedSubstats = true;
    }

    let count = 1;
    if (els.gearModalQty) count = parseInt(els.gearModalQty.value) || 1;

    if (state.editingPendingId) {
        const pItem = state.pending.find(p => p.idKey === state.editingPendingId);
        if (pItem) {
            pItem.count = Math.max(1, count);
            pItem.gearOptions = Object.keys(gearOptions).length > 0 ? gearOptions : null;
        }
    } else {
        state.pending.push({
            idKey: Math.random().toString(36).substr(2, 9), 
            item: item,
            action: "ADD",
            count: Math.max(1, count),
            gearOptions: Object.keys(gearOptions).length > 0 ? gearOptions : null
        });
    }

    state.editingPendingId = null; 
    toggleGearModal(false);
    renderPending();
});


// ==========================================
// 6. PENDING QUEUE SYSTEM
// ==========================================
window.queueItem = function(idOrUid) {
    if (state.category === "idIndex") return;

    const action = state.mode === "LIBRARY" ? "ADD" : "DEL";
    const sourceData = state.mode === "LIBRARY" ? state.db[state.category] : state.myInventory[state.category];
    const item = sourceData.find(i => String(state.mode === "LIBRARY" ? i.id : i.uid) === String(idOrUid));
    
    if (!item) return;

    if (item.rType !== "RT_EQUIP" && isAlreadyQueued(action, idOrUid)) {
        showToast("Already Queued!", `"${item.name || "This item"}" is already in the queue.`, "error");
        return;
    }

    let count = 1;
    if (action === "ADD") {
        const input = document.getElementById(`amt_${item.id}`);
        if (input) count = parseInt(input.value) || 1;
        if (isSingleUseItem(item)) count = 1;
    }

    state.pending.push({
        idKey: Math.random().toString(36).substr(2, 9), 
        item: item,
        action: action,
        count: count
    });

    renderPending();
}

window.queueEditItem = function(uid) {
    if (state.mode !== "INVENTORY" || state.category !== "items") return;

    const item = state.myInventory.items.find(i => String(i.uid) === String(uid));
    if (!item) return;

    const input = document.getElementById(`qty_${uid}`);
    const newCount = input ? parseInt(input.value) : NaN;
    if (isNaN(newCount) || newCount < 0) {
        showToast("Invalid Quantity", "Please enter a valid quantity (>= 0).", "error");
        return;
    }
    if (newCount === item.count) {
        showToast("No Change", "Quantity remains unchanged.", "error");
        return;
    }

    state.pending = state.pending.filter(p => !(p.action === "EDIT" && String(p.item.uid) === String(uid)));

    state.pending.push({
        idKey: Math.random().toString(36).substr(2, 9),
        item: item,
        action: "EDIT",
        count: item.count,
        newCount: newCount
    });

    renderPending();
    showToast("Queued Edit", `${item.name || "Item"}: ${item.count} → ${newCount}`, "add_ok");
}

window.updatePendingCount = function(idKey, val) {
    const p = state.pending.find(x => x.idKey === idKey);
    if (!p) return;
    const newCount = parseInt(val);
    if (isNaN(newCount) || newCount < 0) return; 
    
    if (p.action === "EDIT") {
        p.newCount = newCount;
    } else if (p.action === "ADD") {
        p.count = Math.max(1, newCount);
    }
}

window.removePending = function(idKey) {
    state.pending = state.pending.filter(p => p.idKey !== idKey);
    renderPending();
}

function renderPending() {
    if (els.pendingCount) els.pendingCount.textContent = state.pending.length;
    if (!els.pendingList) return;
    
    els.pendingList.innerHTML = "";

    if (state.pending.length === 0) {
        els.pendingList.innerHTML = `<div style="text-align: center; color: var(--muted); padding: 10px;">Queue is empty. Select items from above.</div>`;
        return;
    }

    state.pending.forEach(p => {
        const div = document.createElement("div");
        div.className = "pending-item";
        
        let badge = "";
        let amtHtml = "";
        let gearTag = "";
        let btnEditGear = "";

        const isSingle = isSingleUseItem(p.item);
        const displayId = p.action === "ADD" ? p.item.id : (p.item.realId || p.item.id);

        if (p.action === "ADD") {
            badge = `<span class="badge add">ADD</span>`;
            if (isSingle) {
                amtHtml = `<span style="color:var(--amber); font-weight:bold;">x1</span>`;
            } else {
                amtHtml = `<span style="color:var(--muted); font-size: 11px;">x</span>
                           <input type="number" class="pending-qty-input" value="${p.count}" min="1" 
                           onchange="updatePendingCount('${p.idKey}', this.value)">`;
            }
        } else if (p.action === "EDIT") {
            badge = `<span class="badge edit">EDIT</span>`;
            amtHtml = `<span style="color:var(--muted); font-size: 11px;">${p.count} → </span>
                       <input type="number" class="pending-qty-input" value="${p.newCount}" min="0" 
                       onchange="updatePendingCount('${p.idKey}', this.value)">`;
        } else {
            badge = `<span class="badge del">DEL</span>`;
            amtHtml = `<span style="color:var(--amber); font-weight:bold;">(Delete)</span>`;
        }

        if (p.gearOptions && p.item.rType === "RT_EQUIP") {
            const setName = p.gearOptions.setOptionId 
                ? (state.db.gearSets.find(s => Number(s.id) === Number(p.gearOptions.setOptionId))?.name || "Unknown Set")
                : "Default Set";
            
            let subs = [];
            if (p.gearOptions.customSubstats) {
                p.gearOptions.customSubstats.forEach(sub => {
                    const subLabel = POPULAR_SUBSTATS.find(s => s.type === sub.type)?.label || sub.type;
                    subs.push(`Sub${sub.slot}: ${subLabel}`);
                });
            }
            if (subs.length === 0) subs.push("Default Substats");

            gearTag = `
                <div style="font-size: 11px; color: var(--teal); margin-top: 4px; padding-left: 5px; border-left: 2px solid var(--teal);">
                    <div><b>Set:</b> ${setName}</div>
                    <div style="color: var(--muted);">${subs.join(" | ")}</div>
                </div>
            `;
            
            btnEditGear = `<button type="button" class="btn-icon" style="padding: 2px 6px; font-size: 12px; margin-right: 5px;" onclick="openGearModal('${p.item.id}', '${p.idKey}')" title="Edit Stats">✏️</button>`;
        }

        div.innerHTML = `
            <div style="display:flex; flex-direction:column; overflow:hidden; flex:1;">
                <div style="display:flex; align-items:center;">
                    ${badge}
                    <span style="color:var(--teal); font-weight:bold; margin-right:8px;">[${displayId}]</span>
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:bold;" title="${p.item.name}">${p.item.name || "Unknown"}</span>
                </div>
                ${gearTag}
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                ${btnEditGear}
                ${amtHtml}
                <button type="button" class="btn-remove-pending" onclick="removePending('${p.idKey}')" title="Remove from queue">✖</button>
            </div>
        `;
        els.pendingList.appendChild(div);
    });
}

if (els.btnSelectAll) {
    els.btnSelectAll.addEventListener("click", () => {
        if (state.category === "idIndex") return showToast("Info", "ID Index is read-only.", "error");

        const startIdx = (state.currentPage - 1) * state.itemsPerPage;
        const endIdx = startIdx + state.itemsPerPage;
        const pageData = state.filteredData.slice(startIdx, endIdx);

        let skipped = 0;
        pageData.forEach(item => {
            const action = state.mode === "LIBRARY" ? "ADD" : "DEL";
            const idOrUid = state.mode === "LIBRARY" ? item.id : item.uid;

            if (state.mode === "LIBRARY" && item.rType === "RT_EQUIP") {
                skipped++; return; 
            }
            if (isAlreadyQueued(action, idOrUid)) { skipped++; return; }

            let count = 1;
            if (action === "ADD") {
                const input = document.getElementById(`amt_${item.id}`);
                if (input) count = parseInt(input.value) || 1;
                if (isSingleUseItem(item)) count = 1;
            }
            state.pending.push({ idKey: Math.random().toString(36).substr(2, 9), item, action, count });
        });
        renderPending();
        if (skipped > 0) showToast("Notice", `${skipped} items skipped (Equipments or already queued).`, "error");
    });
}

if (els.btnClearPending) {
    els.btnClearPending.addEventListener("click", () => {
        state.pending = [];
        renderPending();
    });
}

// ==========================================
// 7. COMMIT CHANGES TO SERVER
// ==========================================
if (els.btnCommit) {
    els.btnCommit.addEventListener("click", async () => {
        if (!state.selectedUid) return showToast("Warning", "Select a player first!", "error");
        if (state.pending.length === 0) return showToast("Warning", "Queue is empty!", "error");

        const adds = state.pending.filter(p => p.action === "ADD");
        const dels = state.pending.filter(p => p.action === "DEL");
        const edits = state.pending.filter(p => p.action === "EDIT");

        if (dels.length > 0 && dels.some(p => p.item.rType === "RT_UNIT" || p.item.rType === "RT_SHIP")) {
            if (!confirm("⚠️ Warning: Deleting a unit/ship that is currently in a Deck will cause game errors. Are you sure you want to delete this?")) return;
        }

        try {
            debugLog("Committing changes to server...");
            const res = await fetch(`${SERVER_API}/users/${state.selectedUid}`);
            const user = (await res.json()).user;
            let changed = false;

            if (adds.length > 0) {
                if (!user.admin) user.admin = {};
                if (!user.admin.posts) user.admin.posts = [];

                const nowMs = Date.now();
                const expireMs = nowMs + (3 * 60 * 1000); 
                const nowTicks = BigInt(nowMs) * 10000n + 621355968000000000n;
                const expireTicks = BigInt(expireMs) * 10000n + 621355968000000000n;
                const sendDateBinary = (nowTicks | 0x4000000000000000n).toString();
                const expirationDateBinary = (expireTicks | 0x4000000000000000n).toString();

                const rewards = adds.map(p => {
                    const r = { rewardType: p.item.rType, id: p.item.id, count: p.count };
                    if (p.gearOptions) r.gearOptions = p.gearOptions;
                    return r;
                });

                user.admin.posts.push({
                    postId: 0, postIndex: Date.now().toString(),
                    title: "📦 Serina Crew Delivery",
                    contents: `You received ${rewards.length} items. Claim quickly, this mail expires in 3 minutes!`,
                    sendDate: sendDateBinary, expirationDate: expirationDateBinary,
                    rewards: rewards, received: false
                });
                changed = true;
            }

            if (dels.length > 0) {
                dels.forEach(p => {
                    const rType = p.item.rType;
                    const uid = p.item.uid;
                    
                    if (rType === "RT_MISC" && user.inventory.misc[uid]) delete user.inventory.misc[uid];
                    else if (rType === "RT_UNIT") {
                        if (user.army.units && user.army.units[uid]) delete user.army.units[uid];
                        if (user.army.trophies && user.army.trophies[uid]) delete user.army.trophies[uid];
                    }
                    else if (rType === "RT_SHIP" && user.army.ships[uid]) delete user.army.ships[uid];
                    else if (rType === "RT_OPERATOR" && user.army.operators[uid]) delete user.army.operators[uid];
                    else if (rType === "RT_EQUIP" && user.inventory.equips[uid]) delete user.inventory.equips[uid];
                    else if (rType === "RT_SKIN" && user.inventory.skins) user.inventory.skins = user.inventory.skins.filter(s => Number(s) !== Number(uid));
                });
                changed = true;
            }

            if (edits.length > 0) {
                edits.forEach(p => {
                    const uid = p.item.uid;
                    const entry = user.inventory && user.inventory.misc ? user.inventory.misc[uid] : null;
                    if (entry) {
                        entry.countFree = p.newCount;
                        entry.countPaid = 0;
                    }
                });
                changed = true;
            }

            if (changed) {
                await fetch(`${SERVER_API}/users/${state.selectedUid}`, {
                    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(user)
                });

                if (adds.length > 0 && dels.length === 0 && edits.length === 0) showToast("Delivery Sent!", "Open Mailbox in-game to claim.", "add_ok");
                else if (dels.length > 0 && adds.length === 0 && edits.length === 0) showToast("Items Refunded!", "Refresh your inventory.", "del_ok");
                else if (edits.length > 0 && adds.length === 0 && dels.length === 0) showToast("Quantity Updated!", "Item quantities updated successfully.", "add_ok");
                else showToast("Success!", "Shop transactions completed.", "add_ok");

                if (dels.length > 0) {
                    dels.forEach(p => {
                        Object.keys(state.myInventory).forEach(cat => {
                            state.myInventory[cat] = state.myInventory[cat].filter(invItem =>
                                !(invItem.rType === p.item.rType && String(invItem.uid) === String(p.item.uid))
                            );
                        });
                    });
                }

                if (edits.length > 0) {
                    edits.forEach(p => {
                        const invItem = state.myInventory.items.find(i => String(i.uid) === String(p.item.uid));
                        if (invItem) {
                            invItem.count = p.newCount;
                            invItem.countText = `x${p.newCount}`;
                        }
                    });
                }

                state.pending = [];
                renderPending();
                if (state.mode === "INVENTORY") renderTable();
            }
        } catch (err) {
            showToast("Transaction Error", err.message, "error");
        }
    });
}

// ==========================================
// NAVIGATION & LISTENERS
// ==========================================
if (els.btnPrev) els.btnPrev.addEventListener("click", () => {
    if (state.currentPage > 1) { state.currentPage--; renderTable(); }
});
if (els.btnNext) els.btnNext.addEventListener("click", () => {
    state.currentPage++; renderTable(); 
});

if (els.perPageSelect) els.perPageSelect.addEventListener("change", (e) => {
    state.itemsPerPage = parseInt(e.target.value);
    state.currentPage = 1;
    renderTable();
});
if (els.sortSelect) els.sortSelect.addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    state.currentPage = 1;
    renderTable();
});

if (els.tabLibrary) els.tabLibrary.addEventListener("click", () => {
    if (state.category === "idIndex") {
        state.category = "units"; 
        Array.from(els.categoryTabs.children).forEach(btn => btn.className = btn.dataset.cat === "units" ? "active" : "");
    }
    state.mode = "LIBRARY"; state.currentPage = 1;
    els.tabLibrary.className = "active"; els.tabInventory.className = "";
    document.querySelector('[data-cat="idIndex"]').style.display = "inline-block";
    renderTable();
});

if (els.tabInventory) els.tabInventory.addEventListener("click", async () => {
    if (state.category === "idIndex") {
        state.category = "units"; 
        Array.from(els.categoryTabs.children).forEach(btn => btn.className = btn.dataset.cat === "units" ? "active" : "");
    }
    state.mode = "INVENTORY"; state.currentPage = 1;
    els.tabLibrary.className = ""; els.tabInventory.className = "active";
    document.querySelector('[data-cat="idIndex"]').style.display = "none";
    if (state.inventoryLoadedFor === state.selectedUid) {
        renderTable();
    } else {
        await loadMyInventory();
    }
});

if (els.categoryTabs) els.categoryTabs.addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    Array.from(els.categoryTabs.children).forEach(btn => btn.className = "");
    e.target.className = "active";
    state.category = e.target.dataset.cat;
    state.currentPage = 1;
    renderTable();
});

let searchTimeout;
if (els.searchInput) els.searchInput.addEventListener("input", (e) => {
    state.search = e.target.value;
    state.currentPage = 1;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(renderTable, 150); 
});

if (els.btnRefreshUsers) els.btnRefreshUsers.addEventListener("click", () => {
    state.inventoryLoadedFor = null;
    fetchUsers();
});
if (els.userSelect) els.userSelect.addEventListener("change", (e) => {
    state.selectedUid = e.target.value;
    state.currentPage = 1;
    state.inventoryLoadedFor = null;
    if (state.mode === "INVENTORY") loadMyInventory();
});

// START APP
async function bootApp() {
    await loadWikiDatabase();
    await fetchUsers();
    
    if (state.mode === "INVENTORY") {
        document.querySelector('[data-cat="idIndex"]').style.display = "none";
    }

    if (!localStorage.getItem("serina_guide_shown_v8")) {
        toggleGuideModal(true);
        localStorage.setItem("serina_guide_shown_v8", "true");
    }
}
bootApp();