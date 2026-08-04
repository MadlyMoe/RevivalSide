const PAGE_SIZE = 250;
const SEARCH_DELAY_MS = 150;

const sections = {
  units: {
    title: "Units",
    rows: "units",
    idKey: "id",
    columns: [
      ["image", "Image", "image"],
      ["id", "Unit ID", "mono"],
      ["name", "Name"],
      ["strId", "String ID", "mono"],
      ["grade", "Grade"],
      ["style", "Style"],
      ["role", "Role"],
      ["type", "Type"],
      ["cost", "Cost"],
      ["hp", "HP"],
      ["atk", "ATK"],
      ["def", "DEF"],
      ["sourceTable", "Source"],
    ],
    filters: ["grade", "style", "role", "type", "contractable"],
    sort: ["id", "name", "grade", "style", "role"],
  },
  gears: {
    title: "Gears",
    rows: "gears",
    idKey: "id",
    columns: [
      ["image", "Image", "image"],
      ["id", "Gear ID", "mono"],
      ["name", "Name"],
      ["strId", "String ID", "mono"],
      ["tier", "Tier"],
      ["grade", "Grade"],
      ["position", "Slot"],
      ["style", "Style"],
      ["mainStatType", "Main Stat", "mono"],
      ["mainStatTypeId", "Stat ID", "mono"],
      ["mainValue", "Main"],
      ["mainLevelValue", "Level"],
      ["statGroup1", "Sub Group 1", "mono"],
      ["statGroup2", "Sub Group 2", "mono"],
      ["setGroup", "Set Group"],
    ],
    filters: ["tier", "grade", "position", "style", "mainStatType"],
    sort: ["id", "name", "tier", "position", "mainStatType"],
  },
  gearStats: {
    title: "Gear Stats",
    rows: "gearStats",
    idKey: "id",
    columns: [
      ["kind", "Kind"],
      ["groupId", "Group", "mono"],
      ["optionKey", "Option", "mono"],
      ["slot", "Slot"],
      ["statDisplay", "Stat", "wide"],
      ["valueSummary", "Values", "wide"],
      ["socketSummary", "Sockets", "wide"],
      ["gearScope", "Gear Scope", "wide"],
      ["gearCount", "Gears"],
      ["gearExamples", "Example Gears", "examples"],
      ["sourceTable", "Source"],
    ],
    filters: ["kind", "statCategory", "statType", "slot", "position", "tier", "grade"],
    sort: ["kind", "statTypeId", "statType", "groupId", "optionKey", "gearCount"],
  },
  gearSetBonuses: {
    title: "Gear Set Bonuses",
    rows: "gearSetBonuses",
    idKey: "id",
    columns: [
      ["id", "Set ID", "mono"],
      ["name", "Name"],
      ["strId", "String ID", "mono"],
      ["parts", "Parts"],
      ["statType", "Stats", "mono"],
      ["effect", "Effect"],
      ["icon", "Icon", "mono"],
    ],
    filters: ["parts", "statType"],
    sort: ["id", "name", "parts", "statType"],
  },
  items: {
    title: "Items",
    rows: "items",
    idKey: "id",
    columns: [
      ["image", "Image", "image"],
      ["id", "Item ID", "mono"],
      ["category", "Category"],
      ["name", "Name"],
      ["strId", "String ID", "mono"],
      ["type", "Type"],
      ["grade", "Grade"],
      ["rewardGroupId", "Reward Group", "mono"],
      ["relatedId", "Related ID", "mono"],
      ["icon", "Icon", "mono"],
      ["sourceTable", "Source"],
    ],
    filters: ["category", "type", "grade", "sourceTable"],
    sort: ["id", "category", "name", "type"],
  },
  skins: {
    title: "Skins",
    rows: "skins",
    idKey: "id",
    columns: [
      ["image", "Image", "image"],
      ["id", "Skin ID", "mono"],
      ["name", "Name"],
      ["strId", "String ID", "mono"],
      ["unitId", "Unit ID", "mono"],
      ["unitName", "Unit"],
      ["grade", "Grade"],
      ["limited", "Limited"],
      ["collab", "Collab"],
      ["cubism", "Cubism"],
      ["icon", "Icon", "mono"],
    ],
    filters: ["grade", "limited", "collab", "cubism"],
    sort: ["id", "name", "unitId", "grade"],
  },
  contracts: {
    title: "Contracts",
    rows: "contracts",
    idKey: "id",
    columns: [
      ["image", "Image", "image"],
      ["id", "ID", "mono"],
      ["category", "Category"],
      ["name", "Name"],
      ["strId", "String ID", "mono"],
      ["type", "Type"],
      ["poolId", "Pool", "mono"],
      ["randomGradeId", "Grade Table", "mono"],
      ["banner", "Banner"],
      ["sourceTable", "Source"],
    ],
    filters: ["category", "type", "sourceTable"],
    sort: ["id", "category", "name", "type"],
  },
  idIndex: {
    title: "ID Index",
    rows: "idIndex",
    idKey: "id",
    columns: [
      ["image", "Image", "image"],
      ["id", "ID", "mono"],
      ["idField", "Field", "mono"],
      ["table", "Table"],
      ["name", "Name"],
      ["strId", "String ID", "mono"],
      ["type", "Type"],
      ["source", "Source"],
    ],
    filters: ["table", "idField", "type"],
    sort: ["table", "id", "idField", "name"],
  },
};

const state = {
  data: {},
  meta: null,
  loads: {},
  section: "units",
  search: "",
  filters: {},
  sort: "id",
  shown: PAGE_SIZE,
};

let searchTimer = 0;

const elements = {
  dataStamp: document.getElementById("dataStamp"),
  searchInput: document.getElementById("searchInput"),
  themeToggle: document.getElementById("themeToggle"),
  sectionTabs: document.getElementById("sectionTabs"),
  filters: document.getElementById("filters"),
  clearFilters: document.getElementById("clearFilters"),
  summaryRow: document.getElementById("summaryRow"),
  sectionTitle: document.getElementById("sectionTitle"),
  resultCount: document.getElementById("resultCount"),
  sortSelect: document.getElementById("sortSelect"),
  downloadJson: document.getElementById("downloadJson"),
  tableHead: document.getElementById("tableHead"),
  tableBody: document.getElementById("tableBody"),
  loadMore: document.getElementById("loadMore"),
};

init().catch(showError);

async function init() {
  const response = await fetch("data/assets.json");
  if (!response.ok) throw new Error(`Wiki metadata failed to load (${response.status})`);
  state.meta = await response.json();
  await loadSection(state.section);
  elements.dataStamp.textContent = `Generated ${formatDate(state.meta.generatedAt)}`;
  syncThemeButton();
  renderTabs();
  renderSummary();
  bindEvents();
  render();
}

async function loadSection(section) {
  const rowsKey = sections[section].rows;
  if (state.data[rowsKey]) return;
  if (!state.loads[rowsKey]) {
    const file = state.meta.sections && state.meta.sections[rowsKey];
    if (!file) throw new Error(`Wiki section is missing: ${rowsKey}`);
    state.loads[rowsKey] = fetch(`data/${file}`).then(async (response) => {
      if (!response.ok) throw new Error(`${sections[section].title} failed to load (${response.status})`);
      return response.json();
    });
  }
  try {
    state.data[rowsKey] = await state.loads[rowsKey];
  } finally {
    delete state.loads[rowsKey];
  }
}

function showError(error) {
  console.error(error);
  elements.dataStamp.textContent = "Wiki data failed to load";
  elements.resultCount.textContent = error && error.message ? error.message : String(error);
}

function bindEvents() {
  elements.searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.search = elements.searchInput.value.trim().toLowerCase();
      state.shown = PAGE_SIZE;
      renderRows();
    }, SEARCH_DELAY_MS);
  });

  elements.themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
  });

  elements.clearFilters.addEventListener("click", () => {
    window.clearTimeout(searchTimer);
    state.filters = {};
    state.search = "";
    elements.searchInput.value = "";
    state.shown = PAGE_SIZE;
    renderFilters();
    renderRows();
  });

  elements.sortSelect.addEventListener("change", () => {
    state.sort = elements.sortSelect.value;
    state.shown = PAGE_SIZE;
    renderRows();
  });

  elements.loadMore.addEventListener("click", () => {
    state.shown += PAGE_SIZE;
    renderRows();
  });

  elements.tableBody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-value]");
    if (!button) return;
    copyText(button.dataset.copyValue, button);
  });

  elements.downloadJson.addEventListener("click", () => {
    const schema = sections[state.section];
    const rows = filteredRows(schema).map((row) => {
      const { _search, ...clean } = row;
      return clean;
    });
    const blob = new Blob([`${JSON.stringify(rows, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `revivalside-${state.section}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function setTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  try {
    localStorage.setItem("revivalside-wiki-theme", normalized);
  } catch {
    // Local storage can be unavailable in strict browser profiles.
  }
  syncThemeButton();
}

function syncThemeButton() {
  if (!elements.themeToggle) return;
  const dark = document.documentElement.dataset.theme === "dark";
  elements.themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  elements.themeToggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
}

function renderTabs() {
  elements.sectionTabs.innerHTML = "";
  for (const [key, schema] of Object.entries(sections)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = key === state.section ? "active" : "";
    button.disabled = Boolean(state.loads[schema.rows]);
    const count = state.meta.counts[schema.rows] || 0;
    button.innerHTML = `<span>${escapeHtml(schema.title)}</span><small>${formatNumber(count)}</small>`;
    button.addEventListener("click", async () => {
      state.section = key;
      state.filters = {};
      state.sort = sections[key].sort[0];
      state.shown = PAGE_SIZE;
      const loading = loadSection(key);
      renderTabs();
      renderLoading(schema);
      try {
        await loading;
        renderTabs();
        if (state.section === key) render();
      } catch (error) {
        renderTabs();
        if (state.section === key) showError(error);
      }
    });
    elements.sectionTabs.appendChild(button);
  }
}

function renderSummary() {
  const cards = Object.values(sections).map((schema) => [schema.title, state.meta.counts[schema.rows] || 0]);
  elements.summaryRow.innerHTML = cards
    .map(([label, value]) => `<div class="summary-card"><strong>${formatNumber(value)}</strong><span>${label}</span></div>`)
    .join("");
}

function renderLoading(schema) {
  elements.sectionTitle.textContent = schema.title;
  elements.resultCount.textContent = "Loading...";
  elements.sortSelect.disabled = true;
  elements.downloadJson.disabled = true;
  elements.filters.innerHTML = "";
  elements.tableHead.innerHTML = "";
  elements.tableBody.innerHTML = "";
  elements.loadMore.classList.add("hidden");
}

function render() {
  const schema = sections[state.section];
  state.sort = schema.sort.includes(state.sort) ? state.sort : schema.sort[0];
  elements.sectionTitle.textContent = schema.title;
  elements.sortSelect.disabled = false;
  elements.downloadJson.disabled = false;
  renderSort(schema);
  renderFilters();
  renderHead(schema);
  renderRows();
}

function renderSort(schema) {
  elements.sortSelect.innerHTML = schema.sort
    .map((key) => `<option value="${escapeHtml(key)}"${key === state.sort ? " selected" : ""}>${escapeHtml(labelFor(key))}</option>`)
    .join("");
}

function renderFilters() {
  const schema = sections[state.section];
  elements.filters.innerHTML = "";
  for (const key of schema.filters) {
    const values = uniqueValues(state.data[schema.rows], key);
    const label = document.createElement("label");
    const current = state.filters[key] || "";
    label.innerHTML = `${escapeHtml(labelFor(key))}<select data-filter="${escapeHtml(key)}"><option value="">All</option>${values
      .map((value) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(value)}</option>`)
      .join("")}</select>`;
    label.querySelector("select").addEventListener("change", (event) => {
      const value = event.target.value;
      if (value) state.filters[key] = value;
      else delete state.filters[key];
      state.shown = PAGE_SIZE;
      renderRows();
    });
    elements.filters.appendChild(label);
  }
}

function renderHead(schema) {
  elements.tableHead.innerHTML = `<tr>${schema.columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr>`;
}

function renderRows() {
  const schema = sections[state.section];
  const rows = filteredRows(schema);
  const visible = rows.slice(0, state.shown);
  elements.resultCount.textContent = `${formatNumber(rows.length)} results, showing ${formatNumber(visible.length)}`;
  elements.tableBody.innerHTML = visible.map((row) => renderRow(row, schema)).join("");
  elements.loadMore.classList.toggle("hidden", visible.length >= rows.length);
}

function renderRow(row, schema) {
  return `<tr>${schema.columns
    .map(([key, , className]) => `<td class="${className || ""}">${formatCell(row[key], className, key)}</td>`)
    .join("")}</tr>`;
}

function filteredRows(schema) {
  const rows = state.data[schema.rows] || [];
  const search = state.search;
  const filters = state.filters;
  return rows
    .filter((row) => {
      for (const [key, value] of Object.entries(filters)) {
        if (String(row[key] == null ? "" : row[key]) !== value) return false;
      }
      if (!search) return true;
      return searchable(row).includes(search);
    })
    .sort((a, b) => compareValues(a[state.sort], b[state.sort]));
}

function searchable(row) {
  if (!row._search) {
    row._search = Object.values(row)
      .filter((value) => value != null && typeof value !== "object")
      .join(" ")
      .toLowerCase();
  }
  return row._search;
}

function uniqueValues(rows, key) {
  return Array.from(new Set((rows || []).map((row) => row[key]).filter((value) => value != null && value !== "")))
    .map(String)
    .sort(compareValues);
}

function compareValues(a, b) {
  const leftNumber = Number(a);
  const rightNumber = Number(b);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(a == null ? "" : a).localeCompare(String(b == null ? "" : b), undefined, { numeric: true });
}

function labelFor(key) {
  return String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function formatCell(value, className = "", key = "") {
  if (className === "image") return formatImage(value);
  if (key === "id") return formatCopyableId(value);
  if (value == null || value === "") return `<span class="muted">-</span>`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return escapeHtml(formatNumber(value));
  return escapeHtml(value);
}

function formatCopyableId(value) {
  if (value == null || value === "") return `<span class="muted">-</span>`;
  const raw = String(value);
  const label = typeof value === "number" ? formatNumber(value) : raw;
  return `<span class="copy-id"><span>${escapeHtml(label)}</span><button type="button" class="copy-button" data-copy-value="${escapeHtml(raw)}" title="Copy ID" aria-label="Copy ID"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v9A2.5 2.5 0 0 1 16.5 19h-6A2.5 2.5 0 0 1 8 16.5v-9Zm2.5-.8c-.44 0-.8.36-.8.8v9c0 .44.36.8.8.8h6c.44 0 .8-.36.8-.8v-9c0-.44-.36-.8-.8-.8h-6ZM5 4.5A2.5 2.5 0 0 1 7.5 2H15v1.7H7.5c-.44 0-.8.36-.8.8V14H5V4.5Z"></path></svg></button></span>`;
}

function formatImage(value) {
  if (!value) return `<span class="muted">-</span>`;
  return `<img class="thumb" src="${escapeHtml(value)}" loading="lazy" alt="">`;
}

async function copyText(value, button) {
  const text = String(value == null ? "" : value);
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      copyTextFallback(text);
    }
    flashCopyButton(button, "copied");
  } catch {
    flashCopyButton(button, "failed");
  }
}

function copyTextFallback(text) {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function flashCopyButton(button, stateName) {
  button.dataset.copyState = stateName;
  const title = stateName === "copied" ? "Copied" : "Copy failed";
  button.title = title;
  button.setAttribute("aria-label", title);
  window.setTimeout(() => {
    button.dataset.copyState = "";
    button.title = "Copy ID";
    button.setAttribute("aria-label", "Copy ID");
  }, 1100);
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value == null ? "" : value);
  return number.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
