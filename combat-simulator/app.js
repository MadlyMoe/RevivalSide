const els = {
  engineStatus: document.querySelector("#engineStatus"),
  reset: document.querySelector("#resetScenario"),
  run: document.querySelector("#runSimulation"),
  canvas: document.querySelector("#battleCanvas"),
  mode: document.querySelector("#simulationMode"),
  stageSelect: document.querySelector("#stageSelect"),
  stageStatus: document.querySelector("#stageStatus"),
  emptyStage: document.querySelector("#emptyStage"),
  battleTitle: document.querySelector("#battleTitle"),
  time: document.querySelector("#timeReadout"),
  result: document.querySelector("#resultReadout"),
  frame: document.querySelector("#frameReadout"),
  slider: document.querySelector("#frameSlider"),
  cameraSlider: document.querySelector("#cameraSlider"),
  followCamera: document.querySelector("#followCamera"),
  cameraReadout: document.querySelector("#cameraReadout"),
  speed: document.querySelector("#playbackSpeed"),
  play: document.querySelector("#playPause"),
  first: document.querySelector("#firstFrame"),
  previous: document.querySelector("#previousFrame"),
  next: document.querySelector("#nextFrame"),
  last: document.querySelector("#lastFrame"),
  inspector: document.querySelector("#unitInspector"),
  inspectorHead: document.querySelector("#inspectorHead"),
  inspectorDescription: document.querySelector("#inspectorDescription"),
  music: document.querySelector("#stageMusic"),
  toggleMusic: document.querySelector("#toggleMusic"),
  notice: document.querySelector("#notice"),
  clientHud: document.querySelector("#clientHud"),
  clientTimer: document.querySelector("#clientTimer"),
  shipHpLabel: document.querySelector("#shipHpLabel"),
  shipHpFill: document.querySelector("#shipHpFill"),
  shipHpValue: document.querySelector("#shipHpValue"),
  bossHp: document.querySelector("#bossHp"),
  bossHpLabel: document.querySelector("#bossHpLabel"),
  bossHpFill: document.querySelector("#bossHpFill"),
  bossHpValue: document.querySelector("#bossHpValue"),
  ultimateIndicator: document.querySelector("#ultimateIndicator"),
  ultimateState: document.querySelector("#ultimateState"),
  teams: {
    1: {
      search: document.querySelector("#teamASearch"),
      results: document.querySelector("#teamAResults"),
      roster: document.querySelector("#teamARoster"),
      count: document.querySelector("#teamACount"),
    },
    3: {
      search: document.querySelector("#teamBSearch"),
      results: document.querySelector("#teamBResults"),
      roster: document.querySelector("#teamBRoster"),
      count: document.querySelector("#teamBCount"),
    },
  },
};

const state = {
  mode: "live",
  catalog: [],
  stages: [],
  stage: null,
  stageRendered: false,
  stageLoadId: 0,
  units: [],
  simulation: null,
  frameIndex: 0,
  playing: false,
  musicEnabled: false,
  lastAdvance: 0,
  nextEditorId: 1,
  images: new Map(),
};

const ctx = els.canvas.getContext("2d");
let noticeTimer;

initialize().catch((error) => setStatus(error.message, "error"));

async function initialize() {
  bindControls();
  const [unitResponse, stageResponse] = await Promise.all([fetch("/api/units"), fetch("/api/stages")]);
  if (!unitResponse.ok) throw new Error(`Unit tables failed to load (${unitResponse.status})`);
  if (!stageResponse.ok) throw new Error(`Stage tables failed to load (${stageResponse.status})`);
  state.catalog = await unitResponse.json();
  state.stages = (await stageResponse.json()).stages || [];
  renderStageSelect();
  resetScenario();
  await loadSelectedStage();
  setStatus(`${state.catalog.length.toLocaleString()} units loaded`, "ready");
  requestAnimationFrame(playbackLoop);
}

function bindControls() {
  els.run.addEventListener("click", runSimulation);
  els.reset.addEventListener("click", resetScenario);
  els.mode.addEventListener("change", () => {
    state.mode = els.mode.value === "editable" ? "editable" : "live";
    resetScenario();
  });
  els.stageSelect.addEventListener("change", () => {
    invalidateSimulation();
    loadSelectedStage().catch((error) => showNotice(error.message, true));
  });
  els.play.addEventListener("click", () => setPlaying(!state.playing));
  els.first.addEventListener("click", () => showFrame(0));
  els.previous.addEventListener("click", () => showFrame(state.frameIndex - 1));
  els.next.addEventListener("click", () => showFrame(state.frameIndex + 1));
  els.last.addEventListener("click", () => showFrame(frameCount() - 1));
  els.slider.addEventListener("input", () => showFrame(Number(els.slider.value)));
  els.cameraSlider.addEventListener("input", () => {
    window.CombatStageWebGL?.setCameraX(Number(els.cameraSlider.value));
    drawStage();
  });
  els.followCamera.addEventListener("click", () => {
    window.CombatStageWebGL?.setCameraX(null);
    drawStage();
  });
  els.toggleMusic.addEventListener("click", () => {
    state.musicEnabled = !state.musicEnabled;
    els.toggleMusic.textContent = state.musicEnabled ? "Music on" : "Music off";
    syncMusic(true);
  });
  els.speed.addEventListener("change", () => syncMusic(false));
  els.music.addEventListener("loadedmetadata", () => syncMusic(true));
  window.addEventListener("resize", drawStage);
  window.addEventListener("keydown", (event) => {
    if (/input|select|textarea/i.test(event.target.tagName)) return;
    if (event.code === "Space") {
      event.preventDefault();
      setPlaying(!state.playing);
    } else if (event.code === "ArrowLeft") showFrame(state.frameIndex - 1);
    else if (event.code === "ArrowRight") showFrame(state.frameIndex + 1);
  });

  for (const team of [1, 3]) {
    const panel = els.teams[team];
    panel.search.addEventListener("input", () => renderSearch(team));
    panel.search.addEventListener("focus", () => renderSearch(team));
    panel.results.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-index]");
      if (!button) return;
      addUnit(state.catalog[Number(button.dataset.index)], team);
      panel.search.value = "";
      panel.results.hidden = true;
    });
    panel.roster.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-remove]");
      if (!button) return;
      state.units = state.units.filter((unit) => unit.editorId !== button.dataset.remove);
      scenarioChanged();
    });
    panel.roster.addEventListener("input", (event) => {
      const input = event.target.closest("input[data-field]");
      if (!input) return;
      const unit = state.units.find((item) => item.editorId === input.dataset.unit);
      if (!unit) return;
      if (input.dataset.skill != null) unit.skillLevels[Number(input.dataset.skill)] = Number(input.value);
      else unit[input.dataset.field] = Number(input.value);
      invalidateSimulation();
      renderInspector();
    });
  }

  document.addEventListener("click", (event) => {
    for (const team of [1, 3]) {
      const panel = els.teams[team];
      if (!event.target.closest(`[data-team="${team}"]`)) panel.results.hidden = true;
    }
  });
}

function renderStageSelect() {
  els.stageSelect.replaceChildren(...state.stages.map((stage) => {
    const option = document.createElement("option");
    option.value = String(stage.stageId);
    option.textContent = stage.label;
    return option;
  }));
  const preferred = state.stages.find((stage) => stage.stageId === 11211) || state.stages[0];
  if (preferred) els.stageSelect.value = String(preferred.stageId);
  els.stageSelect.disabled = !preferred;
}

async function loadSelectedStage() {
  const loadId = ++state.stageLoadId;
  state.stage = state.stages.find((stage) => stage.stageId === Number(els.stageSelect.value)) || null;
  els.music.pause();
  els.music.src = state.stage && state.stage.musicUrl || "";
  els.music.load();
  state.stageRendered = false;
  drawStage();
  if (!state.stage) {
    els.stageStatus.textContent = "No extracted stage asset";
    return;
  }
  els.stageStatus.textContent = `Loading ${state.stage.mapName}…`;
  try {
    if (!window.CombatStageWebGL) throw new Error("WebGL stage runtime is unavailable");
    const result = await window.CombatStageWebGL.load(state.stage);
    if (loadId !== state.stageLoadId) return;
    state.stageRendered = true;
    els.stageStatus.textContent = `${result.renderer} · ${state.stage.mapName}`;
    drawStage();
  } catch (error) {
    if (loadId !== state.stageLoadId) return;
    els.stageStatus.textContent = "Stage fallback active";
    showNotice(`Stage could not render: ${error.message}`, true);
  }
}

function resetScenario() {
  const usable = state.catalog.filter((unit) => unit.image && unit.hp > 0 && unit.atk > 0 && !unit.monster &&
    (state.mode !== "live" || unit.contractable === true));
  const preferred = ["Hilde", "Yoo Mina", "Seo Yoon", "Joo Shiyoon"]
    .map((name) => usable.find((unit) => unit.name === name))
    .filter(Boolean);
  const picks = [...preferred, ...usable.filter((unit) => !preferred.includes(unit))].slice(0, 4);
  state.units = [];
  state.nextEditorId = 1;
  if (state.mode === "live") {
    picks.forEach((unit) => state.units.push(makeEditableUnit(unit, 1)));
  } else {
    picks.slice(0, 2).forEach((unit) => state.units.push(makeEditableUnit(unit, 1)));
    picks.slice(2, 4).forEach((unit) => state.units.push(makeEditableUnit(unit, 3)));
    if (state.units.filter((unit) => unit.team === 3).length === 0 && picks[0]) {
      state.units.push(makeEditableUnit(picks[0], 3));
    }
  }
  invalidateSimulation();
  renderAll();
}

function addUnit(table, team) {
  if (!table) return;
  if (state.mode === "live" && team === 3) return;
  const limit = state.mode === "live" ? 8 : 12;
  if (state.units.filter((unit) => unit.team === team).length >= limit) {
    showNotice(`A team can contain at most ${limit} units.`, true);
    return;
  }
  state.units.push(makeEditableUnit(table, team));
  scenarioChanged();
}

function makeEditableUnit(table, team) {
  const role = String(table.role || "");
  const positionIndex = state.units.filter((unit) => unit.team === team).length;
  return {
    editorId: `editor-${state.nextEditorId++}`,
    unitId: Number(table.id || 0),
    strId: String(table.strId || ""),
    name: String(table.name || table.strId || `Unit ${table.id}`),
    image: String(table.image || ""),
    assetName: assetName(table.image),
    sourceTable: String(table.sourceTable || ""),
    tableHp: Number(table.hp || 0),
    tableAtk: Number(table.atk || 0),
    tableDef: Number(table.def || 0),
    grade: String(table.grade || ""),
    role,
    cost: Number(table.cost || 0),
    level: 110,
    team,
    hp: Math.max(1, Number(table.hp || 1000)),
    damage: Math.max(1, Number(table.atk || 100)),
    range: rangeForRole(role),
    speed: role.includes("TOWER") ? 0 : 55,
    cooldown: role.includes("SNIPER") ? 1.6 : role.includes("DEFENDER") ? 1.35 : 1.1,
    damageReduceRate: 0,
    tacticLevel: 0,
    tacticGroup: 0,
    skinId: 0,
    limitBreakLevel: 5,
    skillLevels: [5, 5, 5, 5, 5],
    seed: 51 + state.nextEditorId,
    x: team === 1 ? 170 + positionIndex * 45 : 1330 - positionIndex * 45,
    z: (positionIndex - 2) * 58,
  };
}

function rangeForRole(role) {
  if (role.includes("SNIPER")) return 360;
  if (role.includes("RANGER") || role.includes("SUPPORTER")) return 250;
  if (role.includes("SIEGE") || role.includes("TOWER")) return 330;
  return 110;
}

function scenarioChanged() {
  invalidateSimulation();
  renderAll();
}

function invalidateSimulation() {
  state.simulation = null;
  state.frameIndex = 0;
  setPlaying(false);
  els.battleTitle.textContent = "Scenario changed";
  els.result.textContent = "Run required";
  els.emptyStage.hidden = state.units.length > 0;
  els.clientHud.hidden = true;
  window.CombatStageWebGL?.setCameraX(null);
  updateTimeline();
  drawStage();
}

async function runSimulation() {
  const valid = state.mode === "live"
    ? state.units.some((unit) => unit.team === 1)
    : [1, 3].every((team) => state.units.some((unit) => unit.team === team));
  if (!valid) {
    showNotice(state.mode === "live" ? "Add at least one Team A unit." : "Add at least one unit to each team.", true);
    return;
  }
  setPlaying(false);
  els.run.disabled = true;
  setStatus(state.mode === "live" ? "CounterSide is running the stage" : "CombatHost is simulating", "running");
  els.battleTitle.textContent = "Running simulation";
  try {
    const response = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: state.mode,
        units: state.units,
        delta: state.mode === "live" ? 1 / 30 : 0.1,
        duration: 180,
        stage: state.stage && { stageId: state.stage.stageId, dungeonId: state.stage.dungeonId, mapId: state.stage.mapId },
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Simulation failed (${response.status})`);
    if (window.CombatStageWebGL) await Promise.all([
      window.CombatStageWebGL.prepareUnits(result.unitAssets || {}),
      window.CombatStageWebGL.prepareEffects(result.effectAssets || {}),
    ]);
    state.simulation = result;
    state.frameIndex = 0;
    els.battleTitle.textContent = result.result.finished
      ? `${teamName(result.result.winner)} wins`
      : "Stage reached the capture limit";
    els.result.textContent = `${result.frames.length.toLocaleString()} frames`;
    els.emptyStage.hidden = true;
    updateTimeline();
    renderRoster(3);
    renderInspector();
    drawStage();
    setStatus(result.engine, "ready");
    showNotice(`Generated ${result.frames.length.toLocaleString()} playable frames.`);
  } catch (error) {
    els.battleTitle.textContent = "Simulation failed";
    setStatus(error.message, "error");
    showNotice(error.message, true);
  } finally {
    els.run.disabled = false;
  }
}

function renderAll() {
  renderRoster(1);
  renderRoster(3);
  renderInspector();
  updateTimeline();
  drawStage();
}

function renderRoster(team) {
  const panel = els.teams[team];
  const runtimeEnemyMode = state.mode === "live" && team === 3;
  panel.search.closest("label").hidden = runtimeEnemyMode;
  panel.results.hidden = true;
  if (runtimeEnemyMode) {
    const units = currentFrame() ? currentFrame().units.filter((unit) => unit.team === 3) : [];
    panel.count.textContent = `${units.length} live`;
    panel.roster.replaceChildren(...units.map(runtimeUnitCard));
    if (!units.length) {
      const note = document.createElement("p");
      note.className = "inspector-empty";
      note.textContent = "Stage-controlled enemies appear here after the live engine runs.";
      panel.roster.append(note);
    }
    return;
  }
  const units = state.units.filter((unit) => unit.team === team);
  panel.count.textContent = `${units.length} unit${units.length === 1 ? "" : "s"}`;
  panel.roster.replaceChildren(...units.map(unitCard));
}

function unitCard(unit) {
  const card = document.createElement("article");
  card.className = "unit-card";
  const head = document.createElement("div");
  head.className = "unit-card-head";
  head.append(imageElement(unit.image, unit.name));
  const title = document.createElement("div");
  title.className = "unit-card-title";
  const strong = document.createElement("strong");
  strong.textContent = unit.name;
  const small = document.createElement("small");
  small.textContent = `${unit.unitId} · ${shortRole(unit.role)}`;
  title.append(strong, small);
  const remove = document.createElement("button");
  remove.className = "remove-unit";
  remove.type = "button";
  remove.dataset.remove = unit.editorId;
  remove.setAttribute("aria-label", `Remove ${unit.name}`);
  remove.textContent = "×";
  head.append(title, remove);
  card.append(head);

  const fields = document.createElement("div");
  fields.className = "unit-fields";
  const editableFields = state.mode === "live"
    ? [["Level", "level", 1], ["Skin ID", "skinId", 1], ["Limit break", "limitBreakLevel", 1], ["Tactic", "tacticLevel", 1]]
    : [["HP", "hp", 1], ["Damage", "damage", 1], ["Range", "range", 1],
      ["Speed", "speed", 1], ["Cooldown", "cooldown", 0.05], ["Start X", "x", 1]];
  for (const [label, field, step] of editableFields) {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.step = String(step);
    input.value = String(unit[field]);
    input.dataset.field = field;
    input.dataset.unit = unit.editorId;
    wrapper.append(input);
    fields.append(wrapper);
  }
  if (state.mode === "live") {
    unit.skillLevels.forEach((level, index) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = `Skill ${index + 1}`;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "10";
      input.step = "1";
      input.value = String(level);
      input.dataset.skill = String(index);
      input.dataset.field = "skillLevels";
      input.dataset.unit = unit.editorId;
      wrapper.append(input);
      fields.append(wrapper);
    });
  }
  card.append(fields);
  return card;
}

function runtimeUnitCard(unit) {
  const config = unitConfig(unit);
  const card = document.createElement("article");
  card.className = "unit-card runtime-card";
  const head = document.createElement("div");
  head.className = "unit-card-head";
  head.style.gridTemplateColumns = "38px minmax(0, 1fr)";
  head.append(imageElement(config && config.image, config && config.name || ""));
  const title = document.createElement("div");
  title.className = "unit-card-title";
  const strong = document.createElement("strong");
  strong.textContent = config && config.name || `Unit ${unit.unitId}`;
  const small = document.createElement("small");
  small.textContent = `${unit.unitId} · ${stateLabel(unit)} · ${Math.ceil(unit.hp).toLocaleString()} HP`;
  title.append(strong, small);
  head.append(title);
  card.append(head);
  return card;
}

function renderSearch(team) {
  const panel = els.teams[team];
  const query = panel.search.value.trim().toLowerCase();
  const matches = state.catalog
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.image && unit.hp > 0 &&
      (state.mode !== "live" || (unit.contractable === true && !unit.monster)) &&
      (!query || searchable(unit).includes(query)))
    .slice(0, 12);
  panel.results.replaceChildren(...matches.map(({ unit, index }) => searchResult(unit, index)));
  panel.results.hidden = matches.length === 0;
}

function searchResult(unit, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "search-result";
  button.dataset.index = String(index);
  button.append(imageElement(unit.image, ""));
  const text = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = unit.name || unit.strId;
  const small = document.createElement("small");
  small.textContent = `${unit.id} · ${assetName(unit.image)}`;
  text.append(strong, small);
  button.append(text);
  return button;
}

function renderInspector() {
  const frame = currentFrame();
  if (state.mode === "live") {
    setInspectorHeaders(["Team", "Unit", "Spine bundle", "Unit UID", "Level", "Scale / Size", "HP / Max", "State", "Animation", "Anim time", "Ultimate", "Target", "X", "Z"]);
    els.inspectorDescription.textContent = frame
      ? "Runtime values, targets, animation clocks, and asset bundles from this exact NKCGameServerLocal frame."
      : "Deck levels and skills feed the real engine; the stage supplies enemies, rules, and derived combat stats.";
    const units = frame ? frame.units : state.units;
    if (!units.length) return renderEmptyInspector("Add a Team A unit to configure the live stage.", 14);
    els.inspector.replaceChildren(...units.map((unit) => {
      const runtime = Boolean(frame);
      const config = runtime ? unitConfig(unit) : unit;
      const row = document.createElement("tr");
      row.append(
        teamCell(unit.team),
        unitNameCell(config, unit.unitId),
        codeCell(runtime ? unit.spriteBundleName : unit.assetName),
        codeCell(runtime ? unit.unitUid : "pending"),
        textCell(unit.level),
        rawCell(runtime ? `${Number(unit.spriteScale || 1).toFixed(2)}x, ${Number(unit.unitSizeX || 0).toFixed(0)} x ${Number(unit.unitSizeY || 0).toFixed(0)}` : "engine templet"),
        rawCell(runtime ? `${Math.ceil(unit.hp).toLocaleString()} / ${Math.ceil(unit.maxHp).toLocaleString()}` : "derived by engine"),
        codeCell(runtime ? `${unit.isSummon ? "SUMMON · " : ""}${unit.stateName} (${unit.stateType})` : `Tactic ${unit.tacticLevel}`),
        codeCell(runtime ? unit.animation : `Skills ${unit.skillLevels.join("/")}`),
        rawCell(runtime ? `${Number(unit.animationTime || 0).toFixed(3)} / ${Number(unit.animationTimeMax || 0).toFixed(3)}` : "—"),
        rawCell(runtime ? ultimateText(unit) : "engine state"),
        textCell(runtime ? unit.targetUid : 0),
        textCell(runtime ? unit.x : ""),
        textCell(runtime ? unit.z : ""),
      );
      return row;
    }));
    return;
  }

  setInspectorHeaders(["Team", "Unit", "Asset", "Source table", "Table HP", "Table ATK", "Table DEF", "Cost", "Sim HP", "Damage", "Range", "Speed", "Cooldown"]);
  els.inspectorDescription.textContent = "Table values are preserved beside the direct overrides sent to the editable CombatHost sandbox.";
  if (!state.units.length) return renderEmptyInspector("Add a unit to inspect its asset and table values.", 13);
  els.inspector.replaceChildren(...state.units.map((unit) => {
    const row = document.createElement("tr");
    row.append(
      teamCell(unit.team),
      unitNameCell(unit, unit.unitId),
      codeCell(unit.assetName, unit.image),
      codeCell(unit.sourceTable),
      textCell(unit.tableHp), textCell(unit.tableAtk), textCell(unit.tableDef), textCell(unit.cost),
      textCell(unit.hp), textCell(unit.damage), textCell(unit.range), textCell(unit.speed), textCell(unit.cooldown),
    );
    return row;
  }));
}

function setInspectorHeaders(labels) {
  els.inspectorHead.replaceChildren(...labels.map((label) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    return cell;
  }));
}

function renderEmptyInspector(message, columns) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = columns;
  cell.className = "inspector-empty";
  cell.textContent = message;
  row.append(cell);
  els.inspector.replaceChildren(row);
}

function teamCell(teamValue) {
  const cell = document.createElement("td");
  const tag = document.createElement("span");
  tag.className = `team-tag ${Number(teamValue) === 1 ? "a" : "b"}`;
  tag.textContent = Number(teamValue) === 1 ? "A" : "B";
  cell.append(tag);
  return cell;
}

function unitNameCell(config, unitId) {
  const cell = document.createElement("td");
  const wrap = document.createElement("span");
  wrap.className = "inspector-unit";
  wrap.append(imageElement(config && config.image, ""), document.createTextNode(`${config && config.name || "Unit"} (${unitId})`));
  cell.append(wrap);
  return cell;
}

function codeCell(value, title = value) {
  const cell = document.createElement("td");
  const code = document.createElement("code");
  code.textContent = value || "—";
  code.title = title || "";
  cell.append(code);
  return cell;
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "—" : Number(value).toLocaleString();
  return cell;
}

function rawCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "—" : String(value);
  return cell;
}

function imageElement(source, alt) {
  const image = document.createElement("img");
  image.src = source || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E";
  image.alt = alt;
  image.loading = "lazy";
  return image;
}

function playbackLoop(timestamp) {
  if (state.playing && state.simulation) {
    const interval = state.simulation.delta * 1000 / Number(els.speed.value || 1);
    if (!state.lastAdvance || timestamp - state.lastAdvance >= interval) {
      state.lastAdvance = timestamp;
      if (state.frameIndex >= frameCount() - 1) setPlaying(false);
      else showFrame(state.frameIndex + 1, false);
    }
  }
  requestAnimationFrame(playbackLoop);
}

function setPlaying(playing) {
  state.playing = Boolean(playing && state.simulation && state.frameIndex < frameCount() - 1);
  state.lastAdvance = 0;
  els.play.textContent = state.playing ? "Pause" : "Play";
  els.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  syncMusic(false);
}

function showFrame(index, pause = true) {
  if (!state.simulation) return;
  if (pause) setPlaying(false);
  state.frameIndex = Math.max(0, Math.min(frameCount() - 1, Number(index) || 0));
  updateTimeline();
  if (state.mode === "live") {
    renderRoster(3);
    renderInspector();
  }
  if (pause) syncMusic(true);
  drawStage();
}

function syncMusic(seek) {
  els.music.playbackRate = Math.max(0.25, Math.min(4, Number(els.speed.value || 1)));
  if (seek && Number.isFinite(els.music.duration) && els.music.duration > 0) {
    const frame = currentFrame();
    els.music.currentTime = (Number(frame && (frame.playTime || frame.gameTime) || 0) % els.music.duration);
  }
  if (!state.musicEnabled || !state.playing || !els.music.src) {
    els.music.pause();
    return;
  }
  els.music.play().catch(() => showNotice("Browser blocked stage music; click Music on again.", true));
}

function updateTimeline() {
  const count = frameCount();
  const available = count > 0;
  els.slider.max = String(Math.max(0, count - 1));
  els.slider.value = String(Math.min(state.frameIndex, Math.max(0, count - 1)));
  els.frame.textContent = `Frame ${available ? state.frameIndex + 1 : 0} / ${count}`;
  els.first.disabled = !available || state.frameIndex === 0;
  els.previous.disabled = !available || state.frameIndex === 0;
  els.next.disabled = !available || state.frameIndex >= count - 1;
  els.last.disabled = !available || state.frameIndex >= count - 1;
  els.play.disabled = !available;
  els.slider.disabled = !available;
  const frame = currentFrame();
  els.time.textContent = formatTime(frame ? frame.gameTime : 0);
}

function drawStage() {
  const rect = els.canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width || 900);
  const height = Math.max(1, rect.height || 506.25);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (els.canvas.width !== Math.round(width * dpr) || els.canvas.height !== Math.round(height * dpr)) {
    els.canvas.width = Math.round(width * dpr);
    els.canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  drawArena(width, height);

  const frame = currentFrame();
  if (!frame) {
    window.CombatSimulatorCurrentFrame = null;
    window.CombatStageWebGL?.render(null);
    els.clientHud.hidden = true;
    syncCameraControls(null);
    drawScenarioPreview(width, height);
    return;
  }
  window.CombatSimulatorCurrentFrame = frame;
  const renderedSpines = window.CombatStageWebGL?.render(frame) || new Set();
  syncCameraControls(frame);
  syncClientHud(frame);
  const unitsById = new Map(frame.units.map((unit) => [unit.id, unit]));
  for (const unit of frame.units) {
    const target = unitsById.get(unit.targetUid || unit.targetId);
    if (target && /ATTACK|SKILL/i.test(`${unit.stateType} ${unit.skillType}`)) drawAttackLine(unit, target, width, height);
  }
  for (const effect of frame.effects || []) drawEffect(effect, width, height);
  for (const unit of frame.units) drawUnit(unit, unitConfig(unit), width, height, renderedSpines.has(String(unit.id)));
  els.time.textContent = formatTime(frame.gameTime);
  if (frame.finished) els.result.textContent = `${teamName(frame.winTeam)} victory`;
}

function syncCameraControls(frame) {
  const camera = window.CombatStageWebGL?.camera(frame);
  if (!camera) {
    els.cameraSlider.disabled = true;
    return;
  }
  els.cameraSlider.min = String(camera.min);
  els.cameraSlider.max = String(camera.max);
  els.cameraSlider.value = String(camera.value);
  els.cameraSlider.disabled = camera.max <= camera.min;
  els.followCamera.classList.toggle("active", camera.follow);
  els.followCamera.textContent = camera.follow ? "Following" : "Follow";
  els.cameraReadout.value = Math.round(camera.value);
}

function syncClientHud(frame) {
  els.clientHud.hidden = state.mode !== "live" || !frame;
  if (els.clientHud.hidden) return;
  const ship = frame.units.find((unit) => Number(unit.gameUnitUid || unit.id) === Number(frame.mainUnitUidA)) ||
    frame.units.find((unit) => Number(unit.team) === 1 && /SHIP/i.test(unit.unitType || ""));
  const boss = frame.units.find((unit) => Number(unit.gameUnitUid || unit.id) === Number(frame.mainUnitUidB)) ||
    frame.units.filter((unit) => Number(unit.team) === 3).sort((a, b) => Number(b.maxHp || 0) - Number(a.maxHp || 0))[0];
  setMainHp(ship, els.shipHpLabel, els.shipHpFill, els.shipHpValue, "SHIP");
  setMainHp(boss, els.bossHpLabel, els.bossHpFill, els.bossHpValue, "BOSS");
  els.bossHp.hidden = !boss;
  els.clientTimer.textContent = formatClientTime(frame.remainGameTime);

  els.ultimateIndicator.hidden = !frame.autoUltimateEnabled;
  els.ultimateIndicator.classList.remove("ready");
  els.ultimateState.textContent = "AUTO ULTIMATE ON";
}

function setMainHp(unit, label, fill, value, fallback) {
  const max = Math.max(0, Number(unit && unit.maxHp || 0));
  const hp = Math.max(0, Number(unit && unit.hp || 0));
  const config = unitConfig(unit);
  label.textContent = config && config.name || fallback;
  fill.style.width = `${max ? Math.min(100, hp / max * 100) : 0}%`;
  value.textContent = `${Math.ceil(hp).toLocaleString()} / ${Math.ceil(max).toLocaleString()}`;
}

function drawArena(width, height) {
  if (!state.stageRendered) {
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "#0d2335");
    gradient.addColorStop(0.48, "#111820");
    gradient.addColorStop(0.52, "#111820");
    gradient.addColorStop(1, "#32151e");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.strokeStyle = "rgba(125, 158, 188, 0.12)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= 1500; x += 150) {
    const px = x / 1500 * width;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, height); ctx.stroke();
  }
  for (let y = 55; y < height; y += 55) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  ctx.fillStyle = "rgba(71, 185, 255, 0.07)";
  ctx.fillRect(0, 0, width * 0.13, height);
  ctx.fillStyle = "rgba(255, 101, 122, 0.07)";
  ctx.fillRect(width * 0.87, 0, width * 0.13, height);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.setLineDash([5, 8]);
  ctx.beginPath(); ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "700 10px Segoe UI";
  ctx.fillText("TEAM A", 15, 21);
  ctx.textAlign = "right";
  ctx.fillText("TEAM B", width - 15, 21);
  ctx.textAlign = "left";
}

function drawScenarioPreview(width, height) {
  for (const unit of state.units) {
    drawUnit({ sourceId: unit.editorId, team: unit.team, hp: unit.hp, maxHp: unit.hp, x: unit.x, z: unit.z, stateId: 12, playState: 1 }, unit, width, height);
  }
}

function drawAttackLine(unit, target, width, height) {
  const from = canvasPoint(unit, width, height);
  const to = canvasPoint(target, width, height);
  ctx.strokeStyle = unit.team === 1 ? "rgba(89, 197, 255, .48)" : "rgba(255, 103, 125, .48)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
}

function drawEffect(effect, width, height) {
  const point = canvasPoint(effect, width, height);
  const progress = Number(effect.animationTime || 0) / Math.max(0.001, Number(effect.animationTimeMax || 1));
  const radius = 8 + Math.sin(Math.min(1, progress) * Math.PI) * 18;
  ctx.save();
  ctx.strokeStyle = Number(effect.team) === 1 ? "rgba(103, 205, 255, .7)" : "rgba(255, 120, 134, .7)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawUnit(unit, config, width, height, spineRendered = false) {
  const point = canvasPoint(unit, width, height);
  const radius = Math.max(22, Math.min(31, width / 32));
  const color = unit.team === 1 ? "#47b9ff" : "#ff657a";
  ctx.save();
  if (!spineRendered) {
    if (unit.playState === 2 || unit.hp <= 0) ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius + 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(4, 7, 11, .88)";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = /ATTACK|SKILL/i.test(`${unit.stateType} ${unit.skillType}`) ? 4 : 2;
    ctx.stroke();

    const image = cachedImage(config && config.image);
    ctx.save();
    ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.clip();
    if (image && image.complete && image.naturalWidth) {
      ctx.drawImage(image, point.x - radius, point.y - radius, radius * 2, radius * 2);
    } else {
      ctx.fillStyle = unit.team === 1 ? "#173c56" : "#54212b";
      ctx.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
      ctx.fillStyle = "white";
      ctx.font = "700 12px Segoe UI";
      ctx.textAlign = "center";
      ctx.fillText(initials(config && config.name), point.x, point.y + 4);
    }
    ctx.restore();
  }

  const hpRatio = Math.max(0, Math.min(1, Number(unit.hp || 0) / Math.max(1, Number(unit.maxHp || 1))));
  const barWidth = spineRendered ? 74 : radius * 2.1;
  const gaugePoint = unit.gaugeOffsetY != null && window.CombatStageWebGL?.projectGauge(unit, currentFrame());
  const barX = gaugePoint ? gaugePoint.x : point.x;
  const barY = gaugePoint ? gaugePoint.y : spineRendered ? point.y - 78 : point.y - radius - 13;
  ctx.fillStyle = "rgba(0,0,0,.72)";
  ctx.fillRect(barX - barWidth / 2, barY, barWidth, 6);
  ctx.fillStyle = hpRatio > 0.5 ? "#65d59a" : hpRatio > 0.2 ? "#f4c66a" : "#ff657a";
  ctx.fillRect(barX - barWidth / 2 + 1, barY + 1, (barWidth - 2) * hpRatio, 4);
  drawHyperGauge(unit, barX, barY - 8, barWidth);
  ctx.fillStyle = "#edf4fb";
  ctx.font = "600 10px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(shortName(config && config.name), point.x, point.y + (spineRendered ? 20 : radius + 15));
  ctx.fillStyle = "rgba(237,244,251,.58)";
  ctx.font = "700 8px Segoe UI";
  ctx.fillText(stateLabel(unit), point.x, point.y + (spineRendered ? 32 : radius + 27));
  ctx.restore();
  ctx.textAlign = "left";
}

function drawHyperGauge(unit, x, y, width) {
  const max = Number(unit.hyperSkillCooldownMax || 0);
  if (!unit.hasHyperSkill || max <= 0) return;
  const progress = Math.max(0, Math.min(1, 1 - Number(unit.hyperSkillCooldown || 0) / max));
  const background = cachedImage("/stage-asset/Data/StreamingAssets/ab_unit_game_nkm_unit_sprite/Sprite/AB_UNIT_GAME_NKM_UNIT_GAGE_SKILL_BG.png");
  const bar = cachedImage("/stage-asset/Data/StreamingAssets/ab_unit_game_nkm_unit_sprite/Sprite/AB_UNIT_GAME_NKM_UNIT_HYPER_SKILL_BAR.png");
  const height = Math.max(4, width * 6 / 117);
  ctx.save();
  if (unit.hyperSkillReady) {
    ctx.shadowColor = "#b32cff";
    ctx.shadowBlur = 6 + Math.sin(performance.now() / 130) * 2;
  }
  if (background?.complete && background.naturalWidth) ctx.drawImage(background, x - width / 2, y, width, height);
  else { ctx.fillStyle = "#111"; ctx.fillRect(x - width / 2, y, width, height); }
  ctx.beginPath();
  ctx.rect(x - width / 2, y, width * progress, height);
  ctx.clip();
  if (bar?.complete && bar.naturalWidth) ctx.drawImage(bar, x - width / 2, y, width, height);
  else { ctx.fillStyle = "#9900ff"; ctx.fillRect(x - width / 2, y, width, height); }
  ctx.restore();
}

function canvasPoint(unit, width, height) {
  const projected = window.CombatStageWebGL && window.CombatStageWebGL.project(unit, currentFrame());
  if (projected) return projected;
  const bounds = state.stage && state.stage.bounds || { minX: -300, maxX: 1500, minZ: -270, maxZ: -110 };
  const xRange = Math.max(1, Number(bounds.maxX) - Number(bounds.minX));
  const zRange = Math.max(1, Number(bounds.maxZ) - Number(bounds.minZ));
  const normalizedZ = (Number(unit.z || 0) - Number(bounds.minZ)) / zRange;
  return {
    x: Math.max(-100, Math.min(width + 100, (Number(unit.x || 0) - Number(bounds.minX)) / xRange * width)),
    y: height * (0.78 - normalizedZ * 0.24) - Math.max(0, Number(unit.jumpY || 0)) * 0.35,
  };
}

function cachedImage(source) {
  if (!source) return null;
  if (!state.images.has(source)) {
    const image = new Image();
    image.onload = drawStage;
    image.src = source;
    state.images.set(source, image);
  }
  return state.images.get(source);
}

function currentFrame() {
  return state.simulation && state.simulation.frames[state.frameIndex];
}

function frameCount() {
  return state.simulation ? state.simulation.frames.length : 0;
}

function unitConfig(unit) {
  return state.units.find((candidate) => candidate.editorId === String(unit && unit.sourceId)) ||
    state.catalog.find((candidate) => Number(candidate.id) === Number(unit && unit.unitId));
}

function searchable(unit) {
  return `${unit.name || ""} ${unit.id || ""} ${unit.strId || ""} ${unit.image || ""}`.toLowerCase();
}

function assetName(source) {
  if (!source) return "";
  try { return decodeURIComponent(String(source).split("/").pop().replace(/\.png$/i, "")); }
  catch { return String(source).split("/").pop(); }
}

function stateLabel(unit) {
  if (unit.playState === 2 || unit.hp <= 0 || /DIE|DEAD/i.test(`${unit.stateType}`)) return "DOWN";
  return `${unit.isSummon ? "SUMMON · " : ""}${String(unit.animation || unit.stateName || "IDLE").replace(/^USN_/, "")}`;
}

function ultimateText(unit) {
  if (!unit.hasHyperSkill) return "—";
  if (unit.hyperSkillReady) return "READY";
  return `${Number(unit.hyperSkillCooldown || 0).toFixed(2)} / ${Number(unit.hyperSkillCooldownMax || 0).toFixed(2)}s`;
}

function initials(name) {
  return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function shortName(name) {
  const value = String(name || "Unit");
  return value.length > 18 ? `${value.slice(0, 17)}…` : value;
}

function shortRole(role) {
  return String(role || "UNIT").replace(/^NURT_/, "");
}

function teamName(team) {
  return team === 1 ? "Team A" : team === 3 ? "Team B" : "No team";
}

function formatTime(value) {
  const total = Math.max(0, Number(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function formatClientTime(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function setStatus(message, type) {
  els.engineStatus.textContent = message;
  els.engineStatus.className = `status-pill ${type || ""}`;
}

function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  els.notice.textContent = message;
  els.notice.className = `notice show${error ? " error" : ""}`;
  noticeTimer = setTimeout(() => { els.notice.className = "notice"; }, 3200);
}
