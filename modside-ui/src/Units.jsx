import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FiActivity, FiBookOpen, FiCheck, FiCode, FiDownload, FiFilePlus, FiFileText, FiImage, FiSearch,
  FiMic, FiPlus, FiSliders, FiTool, FiTrash2, FiUpload, FiUser, FiZap,
} from "react-icons/fi";
import { useApi } from "./api.jsx";
import { Button, Empty, Field, JsonInput, ListButton, Pane, Status, downloadUrl, parseJson, useDebounced } from "./ui.jsx";

const TABS = [
  ["profile", "Unit", FiUser], ["details", "Details", FiFileText], ["collection", "Collection", FiBookOpen], ["stats", "Stats", FiActivity], ["skills", "Skills", FiZap],
  ["voices", "Voice", FiMic], ["appearance", "Appearance", FiImage], ["advanced", "Advanced", FiCode],
];

const CORE_STATS = [
  ["NST_HP", "Health", 1], ["NST_ATK", "Attack", 1], ["NST_DEF", "Defense", 1],
  ["NST_HIT", "Hit", 1], ["NST_EVADE", "Evasion", 1], ["NST_CRITICAL", "Critical", 1],
];
const RATE_STATS = [
  ["NST_ATTACK_SPEED_RATE", "Attack speed bonus", .01], ["NST_MOVE_SPEED_RATE", "Movement speed bonus", .01],
  ["NST_SKILL_COOL_TIME_REDUCE_RATE", "Skill haste", .01], ["NST_CRITICAL_DAMAGE_RATE", "Critical damage", .01],
  ["NST_DAMAGE_REDUCE_RATE", "Damage reduction", .01], ["NST_HP_REGEN_RATE", "HP regeneration", .01],
];
const ASSET_FIELDS = [
  ["m_SpineIllustName", "Management illustration"], ["m_SpineSDName", "SD illustration"],
  ["m_SpriteBundleName", "Battle model bundle"], ["m_SpriteName", "Battle model prefab"],
  ["m_FaceCardName", "Face card"], ["m_MiniMapFaceName", "Minimap portrait"], ["m_InvenIconName", "Inventory portrait"],
];
const SKILL_TYPES = ["NST_ATTACK", "NST_PASSIVE", "NST_SKILL", "NST_HYPER", "NST_LEADER"];
const RESULT_TEXT_FIELDS = [
  ["m_ResultWinDesc", "Victory"], ["m_ResultWinLifeDesc", "Lifetime victory"], ["m_ResultLoseDesc", "Defeat"],
  ["m_ResultLoseLifeDesc", "Lifetime defeat"], ["m_GetUnitDesc", "Acquisition"], ["m_SuperDesc", "Limit break"],
];
const NEGOTIATION_TEXT_FIELDS = [
  ["m_NegoStanby", "Ready"], ["m_NegoOffered", "Offer received"], ["m_NegoGood", "Good offer"], ["m_NegoBad", "Bad offer"], ["m_NegoFury", "Angry"],
  ["m_NegoThink", "Thinking"], ["m_NegoGreatSuccess", "Great success"], ["m_NegoSuccess", "Success"], ["m_NegoFail", "Failure"], ["m_NegoGreatGreatSuccess", "Perfect success"],
];

const emptyForm = {
  projectId: "", projectName: "", displayName: "", unitId: "", unitStrId: "",
  rarity: "", role: "", sourceType: "", style: "", targetType: "", teamUp: "",
  respawnCost: "", maxStars: "", awakened: false, airUnit: false, contractable: true, monster: false,
  unitTags: "", runtimeTags: "", cloneSkills: false, cloneSkins: true,
  assets: {}, stats: {}, growth: {}, skills: [], voiceGroups: [], skinIds: [], voiceLanguage: "KOR",
  details: { title: "", description: "", teamName: "", voiceActors: {}, skins: [], resultLines: [], negotiationLines: [], reactor: null, associations: [], raw: {} },
  collectionIntro: "", profileBiography: "", profileTeamTitle: "", profileTeamName: "", profileGender: "", profileBirthMonth: "", profileBirthDay: "", profileHeight: "",
  profileSpeciality: "", profileLikes: "", profileDislikes: "", profileCombatLevel: "", profileCommandLevel: "", profileCrf: {},
  advancedBase: "{}", advancedStat: "{}", advancedSkills: "{}", advancedCollection: "{}", advancedProfile: "{}", skinOverrides: "{}", voices: "{}",
};

export function UnitApp() {
  const { basePath, request } = useApi();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const [templateType, setTemplateType] = useState("");
  const [catalog, setCatalog] = useState({ units: [], total: 0, counts: {}, nextUnitId: 0, options: {} });
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [tab, setTab] = useState("profile");
  const [spine, setSpine] = useState({ illustration: [], sd: [], battle: [] });
  const [unity, setUnity] = useState(null);
  const [bundleName, setBundleName] = useState("");
  const [bundleFiles, setBundleFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [createdProject, setCreatedProject] = useState("");
  const [voiceAssets, setVoiceAssets] = useState({ KOR: {}, JPN: {} });
  const [voiceExtraction, setVoiceExtraction] = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState("");
  const voiceAssetCache = useRef(new Map());

  const loadCatalog = useCallback(async () => setCatalog(await request(`unit-maker/units?query=${encodeURIComponent(debounced)}&type=${encodeURIComponent(templateType)}`, { title: debounced || friendly(templateType || "All templates") })), [debounced, request, templateType]);
  const loadProjects = useCallback(async () => setProjects((await request("unit-maker/projects", { title: "Unit mod packs" })).projects || []), [request]);
  useEffect(() => { loadCatalog().catch((value) => setError(value.message)); }, [loadCatalog]);
  useEffect(() => { loadProjects().catch((value) => setError(value.message)); }, [loadProjects]);
  useEffect(() => { request("unity-compiler").then(setUnity).catch((value) => setError(value.message)); }, [request]);

  const extractVoiceAudio = useCallback(async (force = false) => {
    const unitStrId = selected?.base?.m_UnitStrID;
    if (!unitStrId) return;
    const cached = voiceAssetCache.current.get(unitStrId);
    if (cached && !force) { setVoiceAssets(cached.assets); setVoiceExtraction(cached); return; }
    setVoiceExtraction({ loading: true });
    try {
      const value = await request("unit-maker/voices/extract", { method: "POST", body: { unitStrId }, title: `Extracting ${selected.summary?.displayName || unitStrId} voice audio` });
      voiceAssetCache.current.set(unitStrId, value);
      setVoiceAssets(value.assets); setVoiceExtraction(value); setError("");
    } catch (value) { setVoiceExtraction({ error: value.message }); setError(value.message); }
  }, [request, selected]);

  useEffect(() => { if (tab === "voices" && selected) extractVoiceAudio(); }, [extractVoiceAudio, selected, tab]);

  async function selectUnit(strId) {
    try {
      const unit = await request(`unit-maker/unit?id=${encodeURIComponent(strId)}`, { title: strId });
      populateUnit(unit);
    } catch (value) { setError(value.message); }
  }

  async function selectProjectUnit(projectId, strId) {
    try {
      const unit = await request(`unit-maker/project-unit?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(strId)}`, { title: strId });
      setActiveProject(projectId);
      populateUnit(unit);
    } catch (value) { setError(value.message); }
  }

  function populateUnit(unit) {
    const edit = unit.edit;
    const pack = edit?.project || projects.find((project) => project.id === activeProject);
    const base = edit?.base || unit.base;
    const stat = edit?.stat || unit.stat;
    const skillSlots = edit?.skillSlots || unit.skillSlots || [];
    const voiceGroups = edit?.voiceGroups || unit.voiceGroups || [];
    const collection = edit?.collection || unit.collection || {};
    const profile = edit?.profile || unit.profile || {};
    const details = edit?.details || unit.details || emptyForm.details;
    const slug = unit.suggestedUnitStrId.toLowerCase().replace(/^nkm_(?:unit|ship|mob)_/, "").replaceAll("_", "-");
    setSelected(unit);
    setForm({
      ...emptyForm,
      projectId: pack?.id || slug, projectName: pack?.name || unit.suggestedName, displayName: edit?.displayName || unit.suggestedName,
      unitId: String(edit ? base.m_UnitID : unit.nextUnitId), unitStrId: edit ? base.m_UnitStrID : unit.suggestedUnitStrId,
      rarity: base.m_NKM_UNIT_GRADE || "", role: base.m_NKM_UNIT_ROLE_TYPE || "",
      sourceType: base.m_NKM_UNIT_SOURCE_TYPE || "", style: base.m_NKM_UNIT_STYLE_TYPE || "",
      targetType: base.m_NKM_FIND_TARGET_TYPE || "", teamUp: base.m_TeamUp || "",
      respawnCost: String(stat.m_RespawnCost ?? ""), maxStars: String(base.m_StarGradeMax ?? ""),
      awakened: base.m_bAwaken === true, airUnit: base.m_bAirUnit === true, contractable: base.m_bContractable !== false, monster: base.m_bMonster === true,
      unitTags: Array.isArray(base.m_lstUnitTag) ? base.m_lstUnitTag.join(", ") : "",
      runtimeTags: Array.isArray(base.m_hsUnitTag) ? base.m_hsUnitTag.join(", ") : "",
      cloneSkills: edit?.cloneSkills ?? false, cloneSkins: edit?.cloneSkins ?? true, assets: { ...(edit?.assets || unit.assets) },
      stats: { ...(stat.m_StatData?.m_Stat || {}) }, growth: { ...(stat.m_StatData?.m_StatPerLevel || {}) },
      skills: skillSlots.map((skill, index) => ({
        sourceSkill: skill.sourceSkillId || skill.skillId, selectedSkill: skill.skillId, type: skill.type || "", icon: skill.icon || "", customName: skill.customName || "",
        label: skillLabel(index, skill.type), sourceName: skill.name || skillLabel(index, skill.type),
        levels: skill.rows.map((row) => ({
          level: row.m_Level, power: fieldValue(row, "m_fEmpowerFactor"), cooldown: fieldValue(row, "m_fCooltimeSecond"), hits: fieldValue(row, "m_AttackCount"), unlock: fieldValue(row, "m_UnlockReqUpgrade"),
          statType: fieldValue(row, "m_NKM_STAT_TYPE1"), statValue: fieldValue(row, "m_fStatValue1"), sourceDescription: row.sourceDescription || row.description || row.descriptionId || "No localized description", description: edit ? row.description || "" : "",
        })),
      })),
      voiceGroups: voiceGroups.map((group) => ({ ...group, lines: group.lines.map((voice) => typeof voice === "string" ? { source: voice, value: voice, audioFiles: {} } : { ...voice, audioFiles: {} }) })),
      skinIds: edit?.skinIds || unit.skins.map((skin) => skin.m_SkinID),
      collectionIntro: collection.intro || "", profileBiography: profile.biography || "", profileTeamTitle: profile.teamTitle || "", profileTeamName: profile.teamName || "",
      profileGender: profile.gender || "", profileBirthMonth: profile.birthMonth || "", profileBirthDay: profile.birthDay || "", profileHeight: profile.height || "",
      profileSpeciality: profile.speciality || "", profileLikes: profile.likes || "", profileDislikes: profile.dislikes || "", profileCombatLevel: profile.combatLevel || "", profileCommandLevel: profile.commandLevel || "", profileCrf: { ...(profile.crf || {}) },
      details: {
        ...details, voiceActors: { ...(details.voiceActors || {}) }, skins: (details.skins || []).map((item) => ({ ...item })),
        resultLines: (details.resultLines || []).map((item) => ({ ...item, fields: { ...(item.fields || {}) } })), negotiationLines: (details.negotiationLines || []).map((item) => ({ ...item, fields: { ...(item.fields || {}) } })),
        reactor: details.reactor ? { ...details.reactor, levels: (details.reactor.levels || []).map((item) => ({ ...item })) } : null,
        associations: (details.associations || []).map((item) => ({ ...item, ids1: [...(item.ids1 || [])], ids2: [...(item.ids2 || [])] })), raw: { ...(details.raw || {}) },
      },
      advancedBase: "{}", advancedStat: "{}", advancedSkills: "{}", advancedCollection: "{}", advancedProfile: "{}", skinOverrides: "{}", voices: "{}",
    });
    setSpine({ illustration: [], sd: [], battle: [] }); setVoiceAssets({ KOR: {}, JPN: {} }); setVoiceExtraction(null);
    setTab("profile"); setResult(null); setOutput(""); setCreatedProject(edit?.project.id || ""); setError("");
  }

  function changeProject(projectId) {
    setActiveProject(projectId);
    const pack = projects.find((project) => project.id === projectId);
    if (selected && !selected.edit) setForm((current) => ({ ...current, projectId: pack?.id || current.projectId, projectName: pack?.name || current.projectName }));
  }

  function update(name, value) { setForm((current) => ({ ...current, [name]: value })); }
  function updateMap(name, key, value) { setForm((current) => ({ ...current, [name]: { ...current[name], [key]: value } })); }
  function updateSkill(index, changes) { setForm((current) => ({ ...current, skills: current.skills.map((skill, skillIndex) => skillIndex === index ? { ...skill, ...changes } : skill) })); }
  function updateSkillLevel(index, levelIndex, changes) {
    setForm((current) => ({ ...current, skills: current.skills.map((skill, skillIndex) => skillIndex === index ? { ...skill, levels: skill.levels.map((level, rowIndex) => rowIndex === levelIndex ? { ...level, ...changes } : level) } : skill) }));
  }
  function updateVoiceLine(groupIndex, lineIndex, changes) {
    setForm((current) => ({ ...current, voiceGroups: current.voiceGroups.map((group, index) => index === groupIndex ? { ...group, lines: group.lines.map((line, lineAt) => lineAt === lineIndex ? { ...line, ...changes } : line) } : group) }));
  }
  function addVoiceLine(groupIndex) {
    setForm((current) => ({ ...current, voiceGroups: current.voiceGroups.map((group, index) => index === groupIndex ? { ...group, lines: [...group.lines, { source: "", value: nextVoiceLineId(group), audioFiles: {} }] } : group) }));
  }
  function removeVoiceLine(groupIndex, lineIndex) {
    setForm((current) => ({ ...current, voiceGroups: current.voiceGroups.map((group, index) => index === groupIndex ? { ...group, lines: group.lines.filter((line, lineAt) => lineAt !== lineIndex || line.source) } : group) }));
  }

  const buildInput = useCallback(() => {
    const base = {
      m_NKM_UNIT_ROLE_TYPE: form.role, m_NKM_UNIT_SOURCE_TYPE: form.sourceType, m_NKM_UNIT_STYLE_TYPE: form.style,
      m_NKM_FIND_TARGET_TYPE: form.targetType, m_TeamUp: form.teamUp, m_StarGradeMax: numberValue(form.maxStars),
      m_bAwaken: form.awakened, m_bAirUnit: form.airUnit, m_bContractable: form.contractable, m_bMonster: form.monster,
    };
    const stat = {
      m_RespawnCost: numberValue(form.respawnCost),
      m_StatData: { m_Stat: numericMap(form.stats), m_StatPerLevel: numericMap(form.growth) },
    };
    const skillOverrides = Object.fromEntries(form.skills.map((skill) => [skill.sourceSkill, {
      common: compact({ m_NKM_SKILL_TYPE: skill.type, m_UnitSkillIcon: skill.icon }),
      levels: Object.fromEntries(skill.levels.map((level) => [String(level.level), compact({
        m_fEmpowerFactor: numberValue(level.power), m_fCooltimeSecond: numberValue(level.cooldown), m_AttackCount: numberValue(level.hits),
        m_UnlockReqUpgrade: numberValue(level.unlock), m_NKM_STAT_TYPE1: level.statType, m_fStatValue1: numberValue(level.statValue),
      })])),
    }]));
    const skillText = Object.fromEntries(form.skills.map((skill) => [skill.sourceSkill, {
      name: skill.customName.trim(), descriptions: Object.fromEntries(skill.levels.filter((level) => level.description.trim()).map((level) => [String(level.level), level.description.trim()])),
    }]));
    const { voiceMap: visualVoiceMap, voiceAdditions } = voiceChanges(form);
    return {
      projectId: form.projectId.trim(), projectName: form.projectName.trim(), sourceUnitStrId: selected.base.m_UnitStrID,
      displayName: form.displayName.trim(), unitId: Number(form.unitId), unitStrId: form.unitStrId.trim(), rarity: form.rarity,
      unitTags: commaList(form.unitTags), runtimeTags: commaList(form.runtimeTags), cloneSkills: form.cloneSkills, cloneSkins: form.cloneSkins,
      skinIds: form.cloneSkins ? form.skinIds : [], assets: form.assets,
      base: { ...compact(base), ...objectJson(form.advancedBase, "Advanced base overrides") },
      stat: deepMerge(stat, objectJson(form.advancedStat, "Advanced stat overrides")),
      skills: form.skills.map((skill) => skill.selectedSkill),
      skillOverrides: deepMerge(skillOverrides, objectJson(form.advancedSkills, "Advanced skill overrides")), skillText,
      skinOverrides: objectJson(form.skinOverrides, "Skin overrides"),
      collection: { intro: form.collectionIntro.trim(), raw: objectJson(form.advancedCollection, "Advanced collection overrides") },
      profile: {
        biography: form.profileBiography.trim(), teamTitle: form.profileTeamTitle.trim(), teamName: form.profileTeamName.trim(), gender: form.profileGender.trim(),
        birthMonth: form.profileBirthMonth, birthDay: form.profileBirthDay, height: form.profileHeight,
        speciality: form.profileSpeciality.trim(), likes: form.profileLikes.trim(), dislikes: form.profileDislikes.trim(),
        combatLevel: form.profileCombatLevel.trim(), commandLevel: form.profileCommandLevel.trim(), crf: numericMap(form.profileCrf),
        raw: objectJson(form.advancedProfile, "Advanced profile overrides"),
      },
      details: form.details,
      voiceMap: { ...visualVoiceMap, ...objectJson(form.voices, "Additional voice replacements") }, voiceAdditions,
    };
  }, [form, selected]);

  async function create(event) {
    event.preventDefault();
    if (!selected) return setError("Select a source unit first.");
    try {
      const editing = Boolean(selected.edit);
      setOutput(editing ? "Saving the existing unit." : "Creating the unit, related registrations, progression data, and battle template.");
      const value = await request(`unit-maker/${editing ? "update" : "create"}`, { method: "POST", body: buildInput(), title: form.displayName });
      setCreatedProject(value.project.manifest.id);
      setActiveProject(value.project.manifest.id);
      const groups = Object.entries(spine).filter(([, files]) => files.length);
      const spineBundles = [];
      for (const [role, files] of groups) spineBundles.push((await attachSpine(role, files)).bundle);
      setResult({ ...value, spineBundles });
      const voiceBundles = await attachVoiceBundles();
      setResult({ ...value, spineBundles, voiceBundles });
      await loadProjects();
      setOutput(""); setError("");
    } catch (value) { setError(value.message); }
  }

  async function attachSpine(role, files) {
    validateSpine(role, files);
    const sources = [];
    for (const file of files) {
      const target = `unit-spine/${form.unitStrId}/${role}/${file.name}`;
      const value = await request(`mods/${encodeURIComponent(form.projectId)}/asset-source?path=${encodeURIComponent(target)}`, { method: "POST", body: file, json: false, title: file.name });
      sources.push(value.file);
    }
    return request("unit-maker/spine", { method: "POST", body: { projectId: form.projectId, sourceUnitStrId: selected.base.m_UnitStrID, unitStrId: form.unitStrId, role, sources }, title: `${role} Spine bundle` });
  }

  async function attachSelectedSpine() {
    try {
      if (!createdProject) throw new Error("Create the unit mod before attaching Spine assets.");
      const groups = Object.entries(spine).filter(([, files]) => files.length);
      if (!groups.length) throw new Error("Choose at least one complete Spine set.");
      const built = [];
      for (const [role, files] of groups) built.push((await attachSpine(role, files)).bundle);
      setResult((current) => ({ ...current, spineBundles: [...(current?.spineBundles || []), ...built] }));
      setError("");
    } catch (value) { setError(value.message); }
  }

  async function attachVoiceBundles() {
    const available = new Set((voiceExtraction?.bundles || []).map((bundle) => `${bundle.bundleName}:${bundle.language}`));
    const jobs = new Map();
    for (const group of form.voiceGroups) for (const language of ["KOR", "JPN"]) {
      const replacements = group.lines.filter((line) => line.audioFiles?.[language]);
      const renamed = group.lines.some((line) => line.source && line.value.trim() !== line.source);
      if ((!replacements.length && !renamed) || (!replacements.length && !available.has(`${group.sourceBundleName}:${language}`))) continue;
      const key = `${group.sourceBundleName}:${language}`;
      const job = jobs.get(key) || { sourceBundleName: group.sourceBundleName, language, replacements: new Map() };
      for (const line of replacements) job.replacements.set(line.value.trim(), line.audioFiles[language]);
      jobs.set(key, job);
    }
    const { voiceMap } = voiceChanges(form);
    const fullVoiceMap = { ...voiceMap, ...objectJson(form.voices, "Additional voice replacements") };
    const built = [];
    for (const job of jobs.values()) {
      const replacements = [];
      for (const [voiceId, file] of job.replacements) {
        const target = `unit-voice/uploads/${form.unitStrId}/${job.language.toLowerCase()}/${voiceId}.mp3`;
        const uploaded = await request(`mods/${encodeURIComponent(form.projectId)}/asset-source?path=${encodeURIComponent(target)}`, { method: "POST", body: file, json: false, title: file.name });
        replacements.push({ voiceId, source: uploaded.file });
      }
      built.push(await request("unit-maker/voice-bundle", { method: "POST", body: { projectId: form.projectId, sourceUnitStrId: selected.base.m_UnitStrID, unitStrId: form.unitStrId, sourceBundleName: job.sourceBundleName, language: job.language, replacements, voiceMap: fullVoiceMap }, title: `${job.language} voice bundle` }));
    }
    return built;
  }

  async function attachSelectedVoices() {
    try {
      if (!createdProject) throw new Error("Create the unit mod before building voice bundles.");
      const built = await attachVoiceBundles();
      if (!built.length) throw new Error("Choose an MP3 or rename a voice event first.");
      setResult((current) => ({ ...current, voiceBundles: [...(current?.voiceBundles || []), ...built] }));
      setError("");
    } catch (value) { setError(value.message); }
  }

  async function buildBundle() {
    if (!createdProject) return setError("Create the unit mod before building an extra bundle.");
    if (!bundleName.trim()) return setError("Enter a bundle name.");
    if (!bundleFiles.length) return setError("Choose at least one source asset.");
    try {
      const assets = [];
      for (const file of bundleFiles) {
        const name = (file.webkitRelativePath || file.name).replaceAll("\\", "/");
        await request(`mods/${encodeURIComponent(createdProject)}/asset-source?path=${encodeURIComponent(name)}`, { method: "POST", body: file, json: false, title: file.name });
        assets.push(name);
      }
      const value = await request(`mods/${encodeURIComponent(createdProject)}/unity-build`, { method: "POST", body: { bundleName: bundleName.trim(), assets }, title: bundleName.trim() });
      setOutput(`Built ${value.bundle?.name || bundleName.trim()}.`); setError("");
    } catch (value) { setError(value.message); }
  }

  const previewStats = useMemo(() => CORE_STATS.slice(0, 3).map(([key, label]) => [label, form.stats[key] ?? "—"]), [form.stats]);
  const activePack = useMemo(() => projects.find((project) => project.id === activeProject), [activeProject, projects]);

  function startAnotherUnit() {
    setSelected(null); setForm(emptyForm); setResult(null); setOutput(""); setCreatedProject(""); setTab("profile");
  }

  return <section className="panel unit-layout">
    <Pane title="Mod pack and foundation" meta={`${catalog.total.toLocaleString()} CounterSide unit templates`}>
      <div className="unit-pack-picker"><Field label="Add units to"><select value={activeProject} onChange={(event) => changeProject(event.target.value)}><option value="">Create a new mod pack</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} ({project.unitCount} units)</option>)}</select></Field></div>
      {activePack && <section className="unit-pack-units"><header><strong>{activePack.name}</strong><span>{activePack.unitCount} editable units</span></header><div className="scroll-list">{activePack.units.map((unit) => <ListButton key={unit.strId} title={unit.displayName} meta={`${friendly(unit.rarity)} · ${friendly(unit.role)} · ID ${unit.id}`} active={selected?.edit?.base?.m_UnitStrID === unit.strId} onClick={() => selectProjectUnit(activePack.id, unit.strId)} />)}{!activePack.units.length && <Empty>This pack has no Unit:Side units yet.</Empty>}</div></section>}
      <div className="search-row"><FiSearch aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, ID, role, or rarity" /></div>
      <div className="unit-type-tabs"><button type="button" className={!templateType ? "active" : ""} onClick={() => setTemplateType("")}>All <span>{catalog.total}</span></button>{(catalog.options.unitTypes || []).map((type) => <button type="button" key={type} className={templateType === type ? "active" : ""} onClick={() => setTemplateType(type)}>{templateTypeLabel(type)} <span>{catalog.counts[type] || 0}</span></button>)}</div>
      <p className="unit-source-note">Every CounterSide employee, NPC, enemy, and boss template is available. Enemy and boss sources are converted into squad-usable units when cloned.</p>
      <div className="scroll-list">{catalog.units.map((unit) => <ListButton key={unit.strId} leading={<UnitAvatar unit={unit} basePath={basePath} />} title={unit.displayName || humanize(unit.strId)} meta={`${templateTypeLabel(unit.sourceCategory === "ENEMY" ? "ENEMY" : unit.unitType)} · ${rarityLabel(unit)} · ${friendly(unit.role)} · ID ${unit.id}`} active={selected?.base.m_UnitStrID === unit.strId} onClick={() => selectUnit(unit.strId)} />)}{!catalog.units.length && <Empty>No matching unit templates.</Empty>}</div>
    </Pane>
    <Pane title={selected ? form.displayName || "New unit" : "Unit:Side maker"} meta={selected ? `Based on ${selected.summary?.displayName || humanize(selected.base.m_UnitStrID)} · ${form.unitStrId}` : "Choose a foundation to begin"} className="unit-studio-pane">
      {error && <Status kind="bad">{error}</Status>}
      {!selected ? <Empty>Select a unit on the left. Unit:Side will turn it into a safe, editable custom unit.</Empty> : <form className="unit-maker-shell" onSubmit={create}>
        <div className="unit-hero">
          <span className="unit-avatar"><FiUser aria-hidden="true" /></span>
          <div><small>Custom unit preview</small><h2>{form.displayName || "Unnamed unit"}</h2><p>{rarityLabel(form)} {friendly(form.role)} · {form.respawnCost || "—"} deployment cost · {form.airUnit ? "Air" : "Ground"}</p></div>
          <dl>{previewStats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </div>
        <nav className="unit-tabs" aria-label="Unit maker sections">{TABS.map(([id, label, Icon]) => <button type="button" key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}><Icon aria-hidden="true" /><span>{label}</span></button>)}</nav>
        <div className="unit-editor-scroll">
          {tab === "profile" && <ProfileEditor form={form} update={update} options={catalog.options || {}} editing={Boolean(selected.edit)} lockedProject={Boolean(activeProject)} />}
          {tab === "details" && <DetailsEditor form={form} update={update} />}
          {tab === "collection" && <CollectionEditor form={form} update={update} updateMap={updateMap} hasProfile={Boolean((selected.edit?.profile || selected.profile)?.raw && Object.keys((selected.edit?.profile || selected.profile).raw).length)} />}
          {tab === "stats" && <StatsEditor form={form} updateMap={updateMap} />}
          {tab === "skills" && <SkillsEditor form={form} update={update} updateSkill={updateSkill} updateSkillLevel={updateSkillLevel} basePath={basePath} editing={Boolean(selected.edit)} />}
          {tab === "voices" && <VoiceEditor form={form} update={update} updateVoiceLine={updateVoiceLine} addVoiceLine={addVoiceLine} removeVoiceLine={removeVoiceLine} basePath={basePath} voiceAssets={voiceAssets} voiceExtraction={voiceExtraction} extractVoiceAudio={extractVoiceAudio} unity={unity} createdProject={createdProject} attachSelectedVoices={attachSelectedVoices} />}
          {tab === "appearance" && <AppearanceEditor selected={selected} form={form} update={update} updateMap={updateMap} spine={spine} setSpine={setSpine} createdProject={createdProject} attachSelectedSpine={attachSelectedSpine} basePath={basePath} editing={Boolean(selected.edit)} />}
          {tab === "advanced" && <AdvancedEditor form={form} update={update} unity={unity} bundleName={bundleName} setBundleName={setBundleName} setBundleFiles={setBundleFiles} buildBundle={buildBundle} createdProject={createdProject} />}
          {result && <section className="unit-result"><FiCheck aria-hidden="true" /><div><strong>{result.unit.displayName || form.displayName} is ready</strong><p>{result.project.manifest.id} · {result.project.patches.length} data patches · {result.clonedSkins} skins · {result.spineBundles?.length || 0} custom Spine bundles · {result.voiceBundles?.length || 0} voice bundles</p>{result.runtimeRebuilt && <small>Active runtime rebuilt. CombatHost will load and validate every unit before the next battle.</small>}{result.warnings?.map((warning) => <small key={warning}>{warning}</small>)}</div></section>}
          {output && <Status>{output}</Status>}
        </div>
        <footer className="unit-actions">
          <span><FiCheck aria-hidden="true" />Required collection, progression, voice, reactor, and battle data is generated automatically.</span>
          <div><Button icon={selected.edit ? FiCheck : FiFilePlus} className="primary" type="submit">{selected.edit ? "Save unit" : activeProject ? "Add unit to pack" : "Create unit mod"}</Button>{result && <Button icon={FiPlus} type="button" onClick={startAnotherUnit}>Add another unit</Button>}{createdProject && <Button icon={FiDownload} type="button" onClick={() => { location.href = downloadUrl(basePath, createdProject); }}>Export ZIP</Button>}</div>
        </footer>
      </form>}
    </Pane>
  </section>;
}

function ProfileEditor({ form, update, options, editing, lockedProject }) {
  return <>
    <MakerSection icon={FiUser} title="Identity" meta="What creators and players will see">
      <div className="form-grid">
        <Field label="Display name" hint="The localized name shown in game"><input required value={form.displayName} onChange={(event) => update("displayName", event.target.value)} /></Field>
        <Field label="Project name"><input required disabled={lockedProject || editing} value={form.projectName} onChange={(event) => update("projectName", event.target.value)} /></Field>
        <Field label="Mod ID" hint="Lowercase; safe for folders and load order"><input required disabled={lockedProject || editing} pattern="[a-z0-9][a-z0-9._-]{1,63}" value={form.projectId} onChange={(event) => update("projectId", event.target.value.toLowerCase())} /></Field>
        <Field label="Numeric unit ID" hint={editing ? "Unit identities stay fixed while editing" : "Suggested collision-free ID"}><input type="number" min="1" required disabled={editing} value={form.unitId} onChange={(event) => update("unitId", event.target.value)} /></Field>
        <Field label="Internal unit ID" hint={editing ? "Add a new unit to use a different ID" : "Generated from the source; advanced but required"} wide><input required disabled={editing} pattern="NKM_(UNIT|SHIP|MOB)_[A-Z0-9_]{3,120}" value={form.unitStrId} onChange={(event) => update("unitStrId", event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} /></Field>
      </div>
    </MakerSection>
    <MakerSection icon={FiSliders} title="Combat profile" meta="CounterSide's player-facing unit categories">
      <div className="form-grid">
        <SelectField label="Rarity" value={form.rarity} options={options.rarities} onChange={(value) => update("rarity", value)} />
        <SelectField label="Role" value={form.role} options={options.roles} onChange={(value) => update("role", value)} />
        <SelectField label="Unit type" value={form.style} options={options.styles} onChange={(value) => update("style", value)} />
        <SelectField label="Source advantage" value={form.sourceType} options={options.sources} onChange={(value) => update("sourceType", value)} />
        <SelectField label="Target priority" value={form.targetType} options={options.targetTypes} onChange={(value) => update("targetType", value)} />
        <Field label="Deployment cost"><input type="number" min="0" max="99" value={form.respawnCost} onChange={(event) => update("respawnCost", event.target.value)} /></Field>
        <Field label="Maximum stars"><input type="number" min="1" max="10" value={form.maxStars} onChange={(event) => update("maxStars", event.target.value)} /></Field>
        <Field label="Team / faction" hint="Used by collection and team-up systems"><input list="unit-team-options" value={form.teamUp} onChange={(event) => update("teamUp", event.target.value)} /><datalist id="unit-team-options">{(options.teams || []).map((value) => <option value={value} key={value} />)}</datalist></Field>
      </div>
      <div className="unit-toggle-grid"><Toggle label="Awakened unit" hint="Shown as Awakened at SSR rarity and treated as a classified unit" checked={form.awakened} onChange={(value) => update("awakened", value)} /><Toggle label="Air unit" hint="Deploys and moves in the air" checked={form.airUnit} onChange={(value) => update("airUnit", value)} /><Toggle label="Contractable" hint="Can appear in recruitment systems" checked={form.contractable} onChange={(value) => update("contractable", value)} /><Toggle label="Monster behavior" hint="Use only for enemy-style units" checked={form.monster} onChange={(value) => update("monster", value)} /></div>
    </MakerSection>
    <MakerSection icon={FiCode} title="Gameplay tags" meta="Optional mechanics inherited from or added to this unit">
      <div className="form-grid"><Field label="Unit traits" hint="Comma-separated tags such as barrier or debuff traits" wide><input value={form.unitTags} onChange={(event) => update("unitTags", event.target.value)} /></Field><Field label="Runtime traits" hint="Usually blank; preserve only known engine tags" wide><input value={form.runtimeTags} onChange={(event) => update("runtimeTags", event.target.value)} /></Field></div>
    </MakerSection>
  </>;
}

function DetailsEditor({ form, update }) {
  const details = form.details;
  const set = (changes) => update("details", { ...details, ...changes });
  const setItem = (group, index, changes) => set({ [group]: details[group].map((item, at) => at === index ? { ...item, ...changes } : item) });
  const setTextField = (group, index, field, value) => setItem(group, index, { fields: { ...details[group][index].fields, [field]: value } });
  const setReactor = (changes) => set({ reactor: { ...details.reactor, ...changes } });
  const setReactorLevel = (index, changes) => setReactor({ levels: details.reactor.levels.map((item, at) => at === index ? { ...item, ...changes } : item) });
  const addAssociation = () => set({ associations: [...details.associations, { sourceActId: 0, actId: 0, action1: "", action2: "", align: true, range: 400, type1: "Unit", ids1: [String(form.unitId)], type2: "Unit", ids2: [], raw: {} }] });
  return <>
    <MakerSection icon={FiFileText} title="All unit text" meta="Player-facing identity, description, team, and credited voice actors">
      <div className="form-grid">
        <Field label="Title / affiliation"><input value={details.title || ""} onChange={(event) => set({ title: event.target.value })} /></Field>
        <Field label="Collection team name"><input value={details.teamName || ""} onChange={(event) => set({ teamName: event.target.value })} /></Field>
        <Field label="Unit description" wide><textarea rows="4" value={details.description || ""} onChange={(event) => set({ description: event.target.value })} /></Field>
        {[["KOR", "Korean voice actor"], ["JPN", "Japanese voice actor"], ["CHN", "Chinese voice actor"]].map(([language, label]) => <Field label={label} key={language}><input value={details.voiceActors?.[language] || ""} placeholder="Keep source credit" onChange={(event) => set({ voiceActors: { ...details.voiceActors, [language]: event.target.value } })} /></Field>)}
      </div>
    </MakerSection>
    <MakerSection icon={FiImage} title="Skin text" meta="Names and descriptions for every cloned appearance">
      <div className="unit-detail-list">{details.skins.map((skin, index) => <details key={skin.sourceSkinId}><summary>{skin.title || humanize(skin.strId)} <small>ID {skin.skinId}</small></summary><div className="form-grid"><Field label="Skin name"><input value={skin.title || ""} onChange={(event) => setItem("skins", index, { title: event.target.value })} /></Field><Field label="Skin description" wide><textarea rows="5" value={skin.description || ""} placeholder="Keep source localization" onChange={(event) => setItem("skins", index, { description: event.target.value })} /></Field></div></details>)}{!details.skins.length && <Empty>No skins are cloned for this unit.</Empty>}</div>
    </MakerSection>
    <MakerSection icon={FiMic} title="Management and result dialogue" meta="Victory, defeat, acquisition, limit break, and negotiation text. Existing voice-backed lines remain voiced unless changed.">
      <div className="unit-detail-list">
        {details.resultLines.map((line, index) => <details key={`result-${line.sourceSkinId}`}><summary>{line.sourceSkinId ? `Skin ${line.skinId}` : "Base unit"} result lines</summary><div className="form-grid">{RESULT_TEXT_FIELDS.map(([field, label]) => <Field label={label} key={field} wide><textarea rows="2" value={line.fields[field] || ""} onChange={(event) => setTextField("resultLines", index, field, event.target.value)} /></Field>)}</div></details>)}
        {details.negotiationLines.map((line, index) => <details key={`nego-${line.sourceSkinId}`}><summary>{line.sourceSkinId ? `Skin ${line.skinId}` : "Base unit"} negotiation lines</summary><div className="form-grid">{NEGOTIATION_TEXT_FIELDS.map(([field, label]) => <Field label={label} key={field} wide><textarea rows="2" value={line.fields[field] || ""} onChange={(event) => setTextField("negotiationLines", index, field, event.target.value)} /></Field>)}</div></details>)}
        {!details.resultLines.length && !details.negotiationLines.length && <Empty>This source unit has no management dialogue records.</Empty>}
      </div>
    </MakerSection>
    {details.reactor && <MakerSection icon={FiZap} title="Alternium Reactor text" meta="Reactor name, lore, and level effect descriptions">
      <div className="form-grid"><Field label="Reactor name"><input value={details.reactor.name || ""} onChange={(event) => setReactor({ name: event.target.value })} /></Field><Field label="Reactor description" wide><textarea rows="5" value={details.reactor.description || ""} onChange={(event) => setReactor({ description: event.target.value })} /></Field></div>
      <div className="unit-detail-list">{details.reactor.levels.map((level, index) => <details key={level.sourceIdx}><summary>Reactor level {index + 1}</summary><div className="form-grid"><Field label="Level title"><input value={level.title || ""} onChange={(event) => setReactorLevel(index, { title: event.target.value })} /></Field><Field label="Level description" wide><textarea rows="3" value={level.description || ""} onChange={(event) => setReactorLevel(index, { description: event.target.value })} /></Field></div></details>)}</div>
    </MakerSection>}
    <MakerSection icon={FiUser} title="Office associations" meta="Who this unit can interact with in Management. IDs may reference units or skins.">
      <div className="unit-detail-list">{details.associations.map((association, index) => <details open key={`${association.sourceActId}-${index}`}><summary>Association {index + 1} <small>{association.action1 || "New interaction"}</small></summary>
        <div className="form-grid">
          <Field label="First interaction action"><input required value={association.action1} onChange={(event) => setItem("associations", index, { action1: event.target.value })} /></Field>
          <Field label="Second interaction action"><input required value={association.action2} onChange={(event) => setItem("associations", index, { action2: event.target.value })} /></Field>
          <Field label="First side type"><select value={association.type1} onChange={(event) => setItem("associations", index, { type1: event.target.value })}><option>Unit</option><option>Skin</option></select></Field>
          <Field label="First side IDs" hint="Comma-separated unit or skin IDs"><input required value={association.ids1.join(", ")} onChange={(event) => setItem("associations", index, { ids1: commaList(event.target.value) })} /></Field>
          <Field label="Second side type"><select value={association.type2} onChange={(event) => setItem("associations", index, { type2: event.target.value })}><option>Unit</option><option>Skin</option></select></Field>
          <Field label="Second side IDs" hint="Comma-separated unit or skin IDs"><input required value={association.ids2.join(", ")} onChange={(event) => setItem("associations", index, { ids2: commaList(event.target.value) })} /></Field>
          <NumberField label="Interaction range" value={association.range} min="1" step="1" onChange={(value) => setItem("associations", index, { range: value })} />
        </div>
        <div className="unit-toggle-grid"><Toggle label="Align units" checked={association.align} onChange={(value) => setItem("associations", index, { align: value })} /></div>
        <Button icon={FiTrash2} type="button" className="danger" onClick={() => set({ associations: details.associations.filter((_, at) => at !== index) })}>Remove association</Button>
      </details>)}{!details.associations.length && <Empty>No existing office association. Add one to define an interaction.</Empty>}</div>
      <Button icon={FiPlus} type="button" onClick={addAssociation}>Add association</Button>
    </MakerSection>
  </>;
}

function CollectionEditor({ form, update, updateMap, hasProfile }) {
  return <>
    <MakerSection icon={FiBookOpen} title="Collection information" meta="The introduction shown on this unit's Collection page">
      <Field label="Collection introduction" hint="Leave blank to keep the source localization" wide><textarea rows="7" value={form.collectionIntro} onChange={(event) => update("collectionIntro", event.target.value)} /></Field>
    </MakerSection>
    {!hasProfile ? <Empty>This source does not use CounterSide's employee profile table. Its Collection introduction can still be edited above.</Empty> : <>
      <MakerSection icon={FiUser} title="Employee profile" meta="Biography, affiliation, and personal details shown in Collection">
        <div className="form-grid">
          <Field label="Profile biography" hint="May differ from the Collection introduction" wide><textarea rows="6" value={form.profileBiography} onChange={(event) => update("profileBiography", event.target.value)} /></Field>
          <Field label="Affiliation title"><input value={form.profileTeamTitle} onChange={(event) => update("profileTeamTitle", event.target.value)} /></Field>
          <Field label="Team name"><input value={form.profileTeamName} onChange={(event) => update("profileTeamName", event.target.value)} /></Field>
          <Field label="Gender"><input value={form.profileGender} onChange={(event) => update("profileGender", event.target.value)} /></Field>
          <NumberField label="Birth month" value={form.profileBirthMonth} min="1" max="12" step="1" onChange={(value) => update("profileBirthMonth", value)} />
          <NumberField label="Birth day" value={form.profileBirthDay} min="1" max="31" step="1" onChange={(value) => update("profileBirthDay", value)} />
          <NumberField label="Height (cm)" value={form.profileHeight} min="1" max="999" step="0.1" onChange={(value) => update("profileHeight", value)} />
          <Field label="Speciality"><input value={form.profileSpeciality} onChange={(event) => update("profileSpeciality", event.target.value)} /></Field>
          <Field label="Likes"><input value={form.profileLikes} onChange={(event) => update("profileLikes", event.target.value)} /></Field>
          <Field label="Dislikes"><input value={form.profileDislikes} onChange={(event) => update("profileDislikes", event.target.value)} /></Field>
        </div>
      </MakerSection>
      <MakerSection icon={FiActivity} title="Profile evaluation" meta="Collection ratings and CRF measurement values">
        <div className="form-grid"><Field label="Combat rating"><input value={form.profileCombatLevel} onChange={(event) => update("profileCombatLevel", event.target.value)} /></Field><Field label="Command rating"><input value={form.profileCommandLevel} onChange={(event) => update("profileCommandLevel", event.target.value)} /></Field></div>
        <div className="stat-grid">
          <NumberField label="Maximum power" value={form.profileCrf.maxPower} min="0" max="9999" step="1" onChange={(value) => updateMap("profileCrf", "maxPower", value)} />
          <NumberField label="Resistance" value={form.profileCrf.resistance} min="0" max="9999" step="1" onChange={(value) => updateMap("profileCrf", "resistance", value)} />
          <NumberField label="Dependence" value={form.profileCrf.dependence} min="0" max="9999" step="1" onChange={(value) => updateMap("profileCrf", "dependence", value)} />
          <NumberField label="Reinforced" value={form.profileCrf.reinforced} min="0" max="9999" step="1" onChange={(value) => updateMap("profileCrf", "reinforced", value)} />
          <NumberField label="Control" value={form.profileCrf.control} min="0" max="9999" step="1" onChange={(value) => updateMap("profileCrf", "control", value)} />
        </div>
      </MakerSection>
    </>}
  </>;
}

function StatsEditor({ form, updateMap }) {
  return <>
    <MakerSection icon={FiActivity} title="Base stats" meta="Level 1 combat values">
      <div className="stat-grid">{CORE_STATS.map(([key, label, step]) => <NumberField key={key} label={label} value={form.stats[key]} min="0" step={step} onChange={(value) => updateMap("stats", key, value)} />)}</div>
    </MakerSection>
    <MakerSection icon={FiActivity} title="Growth per level" meta="Added as the unit levels up">
      <div className="stat-grid">{CORE_STATS.map(([key, label]) => <NumberField key={key} label={`${label} growth`} value={form.growth[key]} min="0" step="0.01" onChange={(value) => updateMap("growth", key, value)} />)}</div>
    </MakerSection>
    <MakerSection icon={FiSliders} title="Combat rates" meta="Decimals: 0.10 means 10%">
      <div className="stat-grid">{RATE_STATS.map(([key, label, step]) => <NumberField key={key} label={label} value={form.stats[key]} step={step} onChange={(value) => updateMap("stats", key, value)} />)}</div>
    </MakerSection>
  </>;
}

function SkillsEditor({ form, update, updateSkill, updateSkillLevel, basePath, editing }) {
  const hasEditableRows = form.skills.some((skill) => skill.levels.length);
  const lockedClone = editing && form.cloneSkills;
  return <>
    <MakerSection icon={FiZap} title="Skill setup" meta="Basic Attack, Passive, Special, and Ultimate data from the selected CounterSide unit">
      <Toggle label="Customize this unit's skills" hint={lockedClone ? "This unit already owns collision-safe skill copies" : editing ? "Clone the shared source skills once to edit their names, descriptions, progression, and combat values" : hasEditableRows ? "Creates collision-safe copies so names, descriptions, icons, progression, and combat values can be changed safely" : "This template uses a separate skill system; its existing skill references remain shared"} checked={form.cloneSkills} onChange={(value) => update("cloneSkills", value)} disabled={lockedClone || !hasEditableRows} />
    </MakerSection>
    {form.skills.map((skill, index) => <section className="skill-card" key={skill.sourceSkill}>
      <header><span className="skill-slot">{index + 1}</span><AppearanceAssetPreview field="m_UnitSkillIcon" id={skill.icon} basePath={basePath} compact /><div><small>{skill.label}</small><h3>{skill.sourceName}</h3><p>{friendly(skill.type)} · {skill.levels.length} levels{skill.levels[0]?.cooldown ? ` · ${skill.levels[0].cooldown}s cooldown` : ""}</p></div></header>
      <div className="form-grid">
        <Field label="Source skill ID" hint={form.cloneSkills ? "A collision-safe skill ID is generated when this unit is saved" : "This unit currently reuses the source skill"} wide><input value={skill.selectedSkill} readOnly /></Field>
        {form.cloneSkills && <><Field label="Skill name" hint={`Leave blank to keep “${skill.sourceName}”`}><input value={skill.customName} placeholder={skill.sourceName} onChange={(event) => updateSkill(index, { customName: event.target.value })} /></Field><Field label="Skill icon ID"><input value={skill.icon} onChange={(event) => updateSkill(index, { icon: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} /></Field><SelectField label="Skill type" value={skill.type} options={SKILL_TYPES} onChange={(value) => updateSkill(index, { type: value })} /></>}
      </div>
      <div className="skill-level-list">{skill.levels.map((level, levelIndex) => <article className="skill-level-card" key={level.level}>
        <header><strong>Lv. {level.level}</strong><p>{level.sourceDescription}</p></header>
        {form.cloneSkills && <><Field label="Custom in-game description" hint="Leave blank to preserve the source localization" wide><textarea rows="3" value={level.description} placeholder={level.sourceDescription} onChange={(event) => updateSkillLevel(index, levelIndex, { description: event.target.value })} /></Field><details><summary>Combat and progression values</summary><div className="skill-combat-grid"><NumberField label="Damage scaling" value={level.power} min="0" step="0.01" onChange={(value) => updateSkillLevel(index, levelIndex, { power: value })} /><NumberField label="Cooldown (seconds)" value={level.cooldown} min="0" step="0.1" onChange={(value) => updateSkillLevel(index, levelIndex, { cooldown: value })} /><NumberField label="Valid hits" value={level.hits} min="0" step="1" onChange={(value) => updateSkillLevel(index, levelIndex, { hits: value })} /><NumberField label="Fusion unlock tier" value={level.unlock} min="0" step="1" onChange={(value) => updateSkillLevel(index, levelIndex, { unlock: value })} /><Field label="Stat modifier"><input value={level.statType} placeholder="None" onChange={(event) => updateSkillLevel(index, levelIndex, { statType: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} /></Field><NumberField label="Stat modifier value" value={level.statValue} step="0.001" onChange={(value) => updateSkillLevel(index, levelIndex, { statValue: value })} /></div></details></>}
      </article>)}</div>
    </section>)}
    {!form.skills.length && <Empty>This template does not use employee skill slots.</Empty>}
  </>;
}

function VoiceEditor({ form, update, updateVoiceLine, addVoiceLine, removeVoiceLine, basePath, voiceAssets, voiceExtraction, extractVoiceAudio, unity, createdProject, attachSelectedVoices }) {
  const language = form.voiceLanguage || "KOR";
  const hasVoiceEdits = form.voiceGroups.some((group) => group.lines.some((line) => line.audioFiles?.KOR || line.audioFiles?.JPN || (line.source && line.value !== line.source)));
  return <>
    <MakerSection icon={FiMic} title="Battle voice lines" meta="Edit sound event references used for deployment, attacks, skills, damage, and defeat. New lines join the same random voice pool.">
      <div className="voice-toolbar">
        <Field label="Preview and replacement language"><select value={language} onChange={(event) => update("voiceLanguage", event.target.value)}><option value="KOR">Korean</option><option value="JPN">Japanese</option></select></Field>
        <Button icon={FiDownload} type="button" onClick={() => extractVoiceAudio(true)}>Extract / refresh audio</Button>
        <span>{voiceExtraction?.loading ? "Extracting voice bundles…" : voiceExtraction?.error ? "Extraction failed" : voiceExtraction ? `${voiceExtraction.audioCount} playable clips ready` : "Audio extracts when this tab opens"}</span>
      </div>
      <p className="section-note voice-note">Choose an MP3 to replace or add a line. Unit:Side preserves the other source clips and builds the encrypted .vkor/.vjpn bundle. Skin-specific voice groups remain separate.</p>
    </MakerSection>
    <div className="voice-groups">{form.voiceGroups.map((group, groupIndex) => <section className="voice-group" key={group.key}>
      <header><div><h3>{group.label}</h3><p>{group.lines.length} sound events</p></div><Button icon={FiPlus} type="button" onClick={() => addVoiceLine(groupIndex)}>Add line</Button></header>
      <div>{group.lines.map((line, lineIndex) => <div className="voice-line" key={`${line.source || "new"}-${lineIndex}`}>
        <Field label={line.source ? `Line ${lineIndex + 1}` : "New line"}><input required pattern="VOICE_[A-Z0-9_]{3,160}" value={line.value} onChange={(event) => updateVoiceLine(groupIndex, lineIndex, { value: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} /></Field>
        <VoiceAssetPreview assetPath={voiceAssets?.[language]?.[line.source || line.value]} file={line.audioFiles?.[language]} basePath={basePath} extracting={voiceExtraction?.loading} />
        <label className="voice-upload button"><FiUpload aria-hidden="true" /><span>{line.audioFiles?.[language]?.name || "Choose MP3"}</span><input type="file" accept=".mp3,audio/mpeg" onChange={(event) => updateVoiceLine(groupIndex, lineIndex, { audioFiles: { ...line.audioFiles, [language]: event.target.files?.[0] } })} /></label>
        {!line.source && <Button icon={FiTrash2} type="button" className="danger" title="Remove new voice line" onClick={() => removeVoiceLine(groupIndex, lineIndex)} />}
      </div>)}</div>
    </section>)}{!form.voiceGroups.length && <Empty>This battle template does not reference voice events.</Empty>}</div>
    <MakerSection icon={FiTool} title="Voice bundle output" meta={unity?.message || "Checking Unity voice-bundle compiler"}>
      <Button icon={FiUpload} type="button" onClick={attachSelectedVoices} disabled={!createdProject || !unity?.available || !hasVoiceEdits}>Build selected MP3 voice bundles</Button>
      {!createdProject && <p className="section-note">Choose MP3 files now; voice bundles build automatically when you create the unit mod.</p>}
    </MakerSection>
  </>;
}

function AppearanceEditor({ selected, form, update, updateMap, spine, setSpine, createdProject, attachSelectedSpine, basePath, editing }) {
  function toggleSkin(skinId, checked) { update("skinIds", checked ? [...new Set([...form.skinIds, skinId])] : form.skinIds.filter((value) => value !== skinId)); }
  return <>
    <MakerSection icon={FiImage} title="Presentation assets" meta="Keep the source values or point to compatible CounterSide assets">
      <div className="form-grid appearance-grid">{ASSET_FIELDS.map(([key, label]) => { const previewField = key === "m_SpriteName" ? "m_SpriteBundleName" : key; const previewValue = key === "m_SpriteName" ? form.assets.m_SpriteBundleName : form.assets[key]; return <Field key={key} label={label}><input value={form.assets[key] || ""} onChange={(event) => updateMap("assets", key, event.target.value)} /><AppearanceAssetPreview field={previewField} id={previewValue} basePath={basePath} /></Field>; })}</div>
    </MakerSection>
    <MakerSection icon={FiImage} title="Skins" meta={`${selected.skins.length} source skins are available`}>
      <Toggle label="Clone selected skins" hint={editing ? "Existing cloned skin IDs are preserved to prevent broken references" : "Each selected skin receives a collision-free ID and points to the custom unit"} checked={form.cloneSkins} onChange={(value) => update("cloneSkins", value)} disabled={editing} />
      {form.cloneSkins && <div className="skin-grid">{selected.skins.map((skin) => <label key={skin.m_SkinID} className={form.skinIds.includes(skin.m_SkinID) ? "selected" : ""}><input type="checkbox" disabled={editing} checked={form.skinIds.includes(skin.m_SkinID)} onChange={(event) => toggleSkin(skin.m_SkinID, event.target.checked)} /><span><strong>{humanize(skin.m_SkinStrID)}</strong><small>{friendly(skin.m_SkinGrade)} · ID {skin.m_SkinID}</small></span></label>)}{!selected.skins.length && <Empty>This source unit has no skins.</Empty>}</div>}
    </MakerSection>
    <MakerSection icon={FiUpload} title="Custom Spine2D assets" meta="Optional. Each set needs one Spine 3.7.x .skel, one .atlas, and every PNG page named by that atlas.">
      <div className="three-inputs"><FileField label="Management illustration" accept=".skel,.atlas,.png" multiple onChange={(files) => setSpine({ ...spine, illustration: files })} /><FileField label="SD illustration" accept=".skel,.atlas,.png" multiple onChange={(files) => setSpine({ ...spine, sd: files })} /><FileField label="Live battle model" accept=".skel,.atlas,.png" multiple onChange={(files) => setSpine({ ...spine, battle: files })} /></div>
      <Button icon={FiUpload} type="button" onClick={attachSelectedSpine} disabled={!createdProject}>Attach selected Spine sets</Button>
      {!createdProject && <p className="section-note">You can choose files now; they will be built automatically when you create the unit.</p>}
    </MakerSection>
  </>;
}

function AdvancedEditor({ form, update, unity, bundleName, setBundleName, setBundleFiles, buildBundle, createdProject }) {
  return <>
    <MakerSection icon={FiCode} title="Expert overrides" meta="Optional escape hatch for fields not represented by the visual editor">
      <details><summary>Raw table overrides</summary><div className="form-grid"><JsonInput label="Base record" value={form.advancedBase} onChange={(value) => update("advancedBase", value)} /><JsonInput label="Stat record" value={form.advancedStat} onChange={(value) => update("advancedStat", value)} /><JsonInput label="Collection record" value={form.advancedCollection} onChange={(value) => update("advancedCollection", value)} /><JsonInput label="Employee profile record" value={form.advancedProfile} onChange={(value) => update("advancedProfile", value)} /><JsonInput label="Skill records" value={form.advancedSkills} onChange={(value) => update("advancedSkills", value)} /><JsonInput label="Skin records" value={form.skinOverrides} onChange={(value) => update("skinOverrides", value)} /><JsonInput label="Additional voice replacements" value={form.voices} onChange={(value) => update("voices", value)} /></div></details>
    </MakerSection>
    <MakerSection icon={FiTool} title="Extra Unity AssetBundle" meta={unity?.message || "Checking Unity Editor"}>
      <div className="bundle-row"><input value={bundleName} onChange={(event) => setBundleName(event.target.value)} placeholder="AssetBundle name" /><FileField label="Source assets" multiple onChange={setBundleFiles} /><Button icon={FiTool} type="button" onClick={buildBundle} disabled={!createdProject || !unity?.available}>Build Windows bundle</Button></div>
    </MakerSection>
  </>;
}

function MakerSection({ icon: Icon, title, meta, children }) { return <section className="maker-section"><header><Icon aria-hidden="true" /><div><h3>{title}</h3><p>{meta}</p></div></header>{children}</section>; }
function UnitAvatar({ unit, basePath }) {
  const root = useRef(null);
  const [source, setSource] = useState("");
  useEffect(() => {
    const node = root.current;
    if (!node || source) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const type = unit.unitType === "NUT_SHIP" ? "ship" : "unit";
        const response = await fetch(`${basePath}/api/object?type=${type}&id=${encodeURIComponent(unit.id)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const detail = await response.json();
        const preview = detail.ids?.find((entry) => entry.field === "m_InvenIconName" && entry.preview)?.preview;
        const path = preview || String(detail.image || "").replace(/^\/asset-png\//, "");
        if (path) setSource(`${basePath}/api/asset?path=${encodeURIComponent(path)}`);
      } catch (error) { if (error.name !== "AbortError") setSource(""); }
    };
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: "180px" });
    observer.observe(node);
    return () => { observer.disconnect(); controller.abort(); };
  }, [unit.id, unit.unitType, basePath, source]);
  return <span className="unit-list-avatar" ref={root}>{source ? <img src={source} loading="lazy" decoding="async" alt="" /> : <FiUser aria-hidden="true" />}</span>;
}
function AppearanceAssetPreview({ field, id, basePath, compact = false }) {
  const debounced = useDebounced(id, 250);
  const [asset, setAsset] = useState(null);
  useEffect(() => {
    setAsset(null);
    if (!String(debounced || "").trim()) return;
    const controller = new AbortController();
    fetch(`${basePath}/api/unit-maker/asset?field=${encodeURIComponent(field)}&id=${encodeURIComponent(debounced)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : { found: false })
      .then((value) => setAsset(value.found ? { ...value, url: `${basePath}/api/asset?path=${encodeURIComponent(value.path)}` } : { found: false }))
      .catch((error) => { if (error.name !== "AbortError") setAsset({ found: false }); });
    return () => controller.abort();
  }, [field, debounced, basePath]);
  if (compact && (!debounced || !asset?.found)) return <span className="skill-icon-preview"><FiZap aria-hidden="true" /></span>;
  if (!debounced) return <small className="appearance-preview-note">No asset assigned</small>;
  if (!asset) return <small className="appearance-preview-note">Resolving preview</small>;
  if (!asset.found) return <small className="appearance-preview-note">No extracted preview</small>;
  return <span className={compact ? "skill-icon-preview" : "appearance-preview"}><img src={asset.url} loading="lazy" decoding="async" alt={`${debounced} preview`} /></span>;
}
function VoiceAssetPreview({ assetPath, file, basePath, extracting }) {
  const [fileUrl, setFileUrl] = useState("");
  useEffect(() => {
    if (!file) { setFileUrl(""); return undefined; }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const url = fileUrl || (assetPath ? `${basePath}/api/asset?path=${encodeURIComponent(assetPath)}` : "");
  return <span className="voice-preview">{url ? <audio controls preload="none" src={url} /> : <small>{extracting ? "Extracting audio…" : "No clip for this language"}</small>}</span>;
}
function SelectField({ label, value, options = [], onChange }) { const values = value && !options.includes(value) ? [value, ...options] : options; return <Field label={label}><select value={value} onChange={(event) => onChange(event.target.value)}>{values.map((option) => <option value={option} key={option}>{friendly(option)}</option>)}</select></Field>; }
function NumberField({ label, value, onChange, ...props }) { return <Field label={label}><input type="number" value={value ?? ""} {...props} onChange={(event) => onChange(event.target.value)} /></Field>; }
function Toggle({ label, hint, checked, onChange, disabled = false }) { return <label className={`unit-toggle ${disabled ? "disabled" : ""}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span></label>; }
function FileField({ label, onChange, ...props }) { return <label className="file-field"><span>{label}</span><span className="button"><FiUpload aria-hidden="true" /><span>Choose files</span></span><input type="file" {...props} onChange={(event) => onChange(Array.from(event.target.files || []))} /></label>; }
function commaList(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }
function voiceChanges(form) {
  return {
    voiceMap: Object.fromEntries(form.voiceGroups.flatMap((group) => group.lines.filter((line) => line.source && line.value.trim() !== line.source).map((line) => [line.source, line.value.trim()]))),
    voiceAdditions: Object.fromEntries(form.voiceGroups.map((group) => [group.key, group.lines.filter((line) => !line.source && line.value.trim()).map((line) => line.value.trim())]).filter(([, lines]) => lines.length)),
  };
}
function validateSpine(role, files) { const extensions = files.map((file) => file.name.slice(file.name.lastIndexOf(".")).toLowerCase()); if (extensions.filter((value) => value === ".skel").length !== 1 || extensions.filter((value) => value === ".atlas").length !== 1 || !extensions.includes(".png") || extensions.some((value) => ![".skel", ".atlas", ".png"].includes(value))) throw new Error(`${role} needs one .skel, one .atlas, and every atlas PNG page.`); }
function fieldValue(record, key) { return Object.hasOwn(record, key) ? String(record[key]) : ""; }
function numberValue(value) { if (value === "" || value == null) return undefined; const number = Number(value); return Number.isFinite(number) ? number : undefined; }
function numericMap(values) { return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, numberValue(value)]).filter(([, value]) => value !== undefined)); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined)); }
function objectJson(value, label) { const parsed = parseJson(value, label); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`); return parsed; }
function deepMerge(base, override) { const output = { ...base }; for (const [key, value] of Object.entries(override || {})) output[key] = value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key]) ? deepMerge(output[key], value) : value; return output; }
function friendly(value) { return String(value || "Unknown").replace(/^(NUG|NURT|NUST|NFTT|NST|NUT|SG)_/, "").split("_").filter(Boolean).map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(" "); }
function humanize(value) { return String(value || "").replace(/^NKM_(?:UNIT|SHIP|MOB)_/, "").replace(/_MOD_\d+$/, "").split("_").filter(Boolean).map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(" "); }
function templateTypeLabel(value) { return value === "PLAYABLE" ? "Employees & NPCs" : value === "ENEMY" ? "Enemies & bosses" : value === "NUT_NORMAL" ? "Normal units" : value === "NUT_SHIP" ? "Ships" : value === "NUT_SYSTEM" ? "Engine bases" : friendly(value); }
function skillLabel(index, type) { return ({ NST_ATTACK: "Basic attack", NST_PASSIVE: "Passive skill", NST_SKILL: "Special skill", NST_HYPER: "Ultimate skill", NST_LEADER: "Leader skill" })[type] || ["Basic attack", "Passive skill", "Special skill", "Ultimate skill"][index] || friendly(type); }
function rarityLabel(value) { return `${value.awakened ? "Awakened " : ""}${friendly(value.rarity)}`; }
function nextVoiceLineId(group) { const used = new Set(group.lines.map((line) => line.value)); let number = Math.max(0, ...group.lines.map((line) => Number(String(line.value).match(/_(\d+)$/)?.[1]) || 0)) + 1; while (used.has(`${group.key}_${number}`)) number += 1; return `${group.key}_${number}`; }
