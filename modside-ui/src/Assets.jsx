import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FiBox, FiCheck, FiCode, FiDatabase, FiDownload, FiEdit3, FiEye, FiFile,
  FiFileText, FiFolder, FiGrid, FiHardDrive, FiImage, FiLink2, FiMusic, FiPackage,
  FiPlus, FiSearch, FiTool, FiUpload, FiVideo,
} from "react-icons/fi";
import { useApi } from "./api.jsx";
import { Button, Empty, Field, IconButton, ListButton, Modal, PAGE_SIZE, Pager, Pane, Status, downloadUrl, formatBytes, recordLabel, useDebounced } from "./ui.jsx";

const tabs = [
  ["systems", "Game systems", FiGrid],
  ["objects", "Game objects", FiBox],
  ["tables", "Gameplay tables", FiDatabase],
  ["assets", "Extracted assets", FiFolder],
];

export function AssetApp() {
  const initial = new URLSearchParams(location.search).get("view");
  const [tab, setTab] = useState(tabs.some(([id]) => id === initial) ? initial : "systems");
  const [tableTarget, setTableTarget] = useState(null);
  function select(next) { setTab(next); const url = new URL(location.href); url.searchParams.set("view", next); history.replaceState(null, "", url); }
  function openTable(table) { setTableTarget(table); select("tables"); }
  return <div className="app-surface"><nav className="top-tabs asset-tabs" aria-label="Asset:Side sections">{tabs.map(([id, label, Icon]) => <Button key={id} icon={Icon} className={tab === id ? "active" : "ghost"} onClick={() => select(id)}>{label}</Button>)}</nav>{tab === "systems" && <Systems onOpenTable={openTable} />}{tab === "objects" && <Objects />}{tab === "tables" && <Tables target={tableTarget} />}{tab === "assets" && <AssetBrowser />}</div>;
}

function Systems({ onOpenTable }) {
  const { request } = useApi();
  const [catalog, setCatalog] = useState({ systems: [], tableCount: 0 });
  const [selected, setSelected] = useState(null);
  const [tables, setTables] = useState({ tables: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => { request("systems").then((value) => { setCatalog(value); setSelected(value.systems.find((item) => item.id === "units") || value.systems[0]); }).catch((value) => setError(value.message)); }, [request]);
  useEffect(() => { if (!selected) return; request(`system-tables?id=${encodeURIComponent(selected.id)}&offset=${offset}&limit=${PAGE_SIZE}`).then(setTables).catch((value) => setError(value.message)); }, [selected, offset, request]);
  async function search(event, value = query) { event?.preventDefault(); if (value.trim().length < 2) return; try { setResults(await request(`fields?query=${encodeURIComponent(value.trim())}`, { title: value.trim() })); setError(""); } catch (failure) { setError(failure.message); } }

  return <section className="panel three-column atlas-layout"><Pane title="Game Data Atlas" meta="Find the exact decoded table, nested field, type, and example value"><form className="search-row" onSubmit={search}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Unit HP, raid entry cost, buff duration" /><IconButton icon={FiSearch} label="Find gameplay value" className="primary" type="submit" /></form>{error && <Status kind="bad">{error}</Status>}<div className="scroll-list field-results">{results?.fields?.map((field) => <ListButton key={`${field.table.relativePath}-${field.path}`} icon={FiEdit3} title={field.path} meta={`${field.system} · ${field.table.tableName} · ${field.type} · ${JSON.stringify(field.example)}`} onClick={() => onOpenTable(field.table)} />)}{results && !results.fields.length && results.tables.map((table) => <ListButton key={table.relativePath} icon={FiDatabase} title={table.tableName} meta={`${table.system} · ${table.relativePath}`} onClick={() => onOpenTable(table)} />)}{!results && <Empty>Choose a common edit or search for a value.</Empty>}</div></Pane>
    <Pane title="Systems" meta={`${catalog.systems.length} systems · ${catalog.tableCount.toLocaleString()} decoded tables`}><div className="scroll-list">{catalog.systems.map((system) => <ListButton key={system.id} icon={FiGrid} title={system.title} meta={system.description} trailing={<span className="count">{system.tableCount.toLocaleString()}</span>} active={selected?.id === system.id} onClick={() => { setSelected(system); setOffset(0); }} />)}</div></Pane>
    <Pane title={selected?.title || "Related tables"} meta={selected ? `${selected.description} ${selected.tableCount.toLocaleString()} tables.` : "Select a system"}>{selected && <><div className="edit-targets">{(selected.commonEdits || []).map((edit) => <button key={edit.label} type="button" onClick={() => { setQuery(edit.query); search(null, edit.query); }}><strong>{edit.label}</strong><code>{edit.location}</code></button>)}</div><h3 className="subheading">Related LUAC tables</h3><div className="scroll-list">{tables.tables.map((table) => <ListButton key={table.relativePath} icon={FiDatabase} title={table.tableName} meta={`${table.directory} · ${table.format}`} onClick={() => onOpenTable(table)} />)}</div><Pager offset={offset} total={tables.total} onChange={setOffset} /></>}</Pane></section>;
}

function Objects() {
  const { basePath, request } = useApi();
  const [type, setType] = useState("unit");
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const [offset, setOffset] = useState(0);
  const [objects, setObjects] = useState({ objects: [], total: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [project, setProject] = useState(null);
  const [unity, setUnity] = useState(null);
  const [replacementPath, setReplacementPath] = useState("");
  const [error, setError] = useState("");

  const loadTools = useCallback(async (preferred) => {
    const [mods, compiler] = await Promise.all([request("mods"), request("unity-compiler")]);
    setProjects(mods.projects); setUnity(compiler);
    const id = preferred || projectId;
    if (id && mods.projects.some((item) => item.id === id)) { setProjectId(id); setProject(await request(`mods/${encodeURIComponent(id)}`)); }
  }, [request, projectId]);
  useEffect(() => { loadTools().catch((value) => setError(value.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOffset(0); }, [type, debounced]);
  useEffect(() => { request(`objects?type=${encodeURIComponent(type)}&query=${encodeURIComponent(debounced)}&offset=${offset}&limit=${PAGE_SIZE}`).then((value) => { setObjects(value); if (value.objects.length && selectedId == null) setSelectedId(value.objects[0].id); }).catch((value) => setError(value.message)); }, [type, debounced, offset, request]);
  useEffect(() => { if (selectedId == null) return; request(`object?type=${encodeURIComponent(type)}&id=${encodeURIComponent(selectedId)}`).then(setDetail).catch((value) => setError(value.message)); }, [type, selectedId, request]);

  async function chooseProject(id) { setProjectId(id); setProject(id ? await request(`mods/${encodeURIComponent(id)}`) : null); }
  async function createProject() { const id = prompt("New asset mod ID:", detail ? `${detail.type}-${detail.id}-assets`.toLowerCase() : "asset-overrides"); if (!id) return; const name = prompt("Mod name:", detail ? `${detail.name} Assets` : "Asset Overrides"); if (!name) return; try { const value = await request("mods", { method: "POST", body: { id: id.trim(), name: name.trim() } }); await loadTools(value.manifest.id); } catch (failure) { setError(failure.message); } }
  async function importProject(file) { if (!file) return; try { const value = await request("mods/import", { method: "POST", body: file, json: false, title: file.name }); await loadTools(value.manifest.id); } catch (failure) { setError(failure.message); } }
  async function buildAssets() { if (!project || !unity?.available) return; const groups = {}; project.assetReplacements.forEach((item) => { const group = groups[item.bundleName] ||= { assets: [], spriteAssets: [] }; const source = item.source.replace(/^assets\/source\//, ""); group.assets.push(source); if (item.unityType === "Sprite") group.spriteAssets.push(source); }); try { for (const [bundleName, group] of Object.entries(groups)) await request(`mods/${encodeURIComponent(project.manifest.id)}/unity-build`, { method: "POST", body: { bundleName, ...group }, title: bundleName }); await loadTools(project.manifest.id); } catch (failure) { setError(failure.message); } }

  return <section className="panel object-layout"><Pane title="Game objects" actions={<select value={type} onChange={(event) => { setType(event.target.value); setSelectedId(null); }}><option value="unit">Units</option><option value="ship">Ships</option><option value="operator">Operators</option><option value="gear">Gear</option></select>}><div className="search-row"><FiSearch /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search IDs or names" /></div><div className="scroll-list">{objects.objects.map((item) => <ListButton key={item.id} icon={FiBox} title={item.name} meta={`ID ${item.id}${item.strId ? ` · ${item.strId}` : ""}${item.meta ? ` · ${item.meta}` : ""}`} active={selectedId === item.id} onClick={() => setSelectedId(item.id)} />)}{!objects.objects.length && <Empty>No matching objects.</Empty>}</div><Pager offset={offset} total={objects.total} onChange={setOffset} /></Pane>
    <Pane title={detail?.name || "Object fields and IDs"} meta={detail ? `${detail.type} ID ${detail.id}${detail.strId ? ` · ${detail.strId}` : ""}` : "Select an object"} actions={<div className="object-toolbar"><select value={projectId} onChange={(event) => chooseProject(event.target.value)}><option value="">Select asset mod</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><IconButton icon={FiPlus} label="Create asset mod" onClick={createProject} /><label className="button icon-button file-button" title="Import mod ZIP"><FiUpload /><input type="file" accept=".zip,.revivalmod" onChange={(event) => importProject(event.target.files[0])} /></label>{project && <IconButton icon={FiDownload} label="Export mod ZIP" onClick={() => { location.href = downloadUrl(basePath, project.manifest.id); }} />}<IconButton icon={FiTool} label="Build pending assets" disabled={!project?.assetReplacements?.length || !unity?.available} onClick={buildAssets} /></div>}>
      {error && <Status kind="bad">{error}</Status>}{project && <Status kind={project.validation?.ok ? "good" : "neutral"}>{project.assetReplacements.length} replacements · {project.assetReplacements.filter((item) => !item.built).length} pending builds</Status>}
      <form className="search-row asset-path" onSubmit={(event) => { event.preventDefault(); if (replacementPath.trim()) setReplacementPath(replacementPath.trim()); }}><input value={replacementPath} onChange={(event) => setReplacementPath(event.target.value)} placeholder="Extracted asset path" /><IconButton icon={FiEdit3} label="Edit asset path" type="submit" /></form>
      {detail ? <ObjectDetail detail={detail} basePath={basePath} onReplace={setReplacementPath} /> : <Empty>Select a unit, ship, operator, or gear.</Empty>}
    </Pane>{replacementPath && <ReplacementModal path={replacementPath} project={project} unity={unity} onClose={() => setReplacementPath("")} onSaved={async () => { await loadTools(project.manifest.id); setReplacementPath(""); }} />}
  </section>;
}

function ObjectDetail({ detail, basePath, onReplace }) {
  const sections = [
    ["Relevant IDs and fields", detail.ids || [], (item) => ({ title: item.label, lines: [`${item.field} = ${JSON.stringify(item.value)}`], source: item.sourceTable, description: item.description, preview: item.preview })],
    ["Unit stat IDs and fields", detail.stats || [], (item) => ({ title: `${item.name} · Stat ID ${item.statId ?? "unknown"}`, lines: [`Type = ${item.statType}`, `${item.fields.base} = ${item.base}`, `${item.fields.perLevel} = ${item.perLevel}`], source: "Unit stat template", description: item.description })],
    ["Gear stat IDs, fields, and ranges", detail.gear_stat_ids || [], (item) => ({ title: `${item.name} · Stat ID ${item.statId ?? "unknown"}`, lines: [`Type = ${item.statType}`, `Slot = ${item.slot}`, `Range = ${item.min} to ${item.max}`, ...Object.entries(item.fields || {}).map(([key, value]) => `${key} field = ${value}`)], source: item.sourceTable, description: item.description })],
  ];
  return <div className="object-detail"><div className="object-summary">{detail.image && <img src={`${basePath}/api/asset?path=${encodeURIComponent(String(detail.image).replace(/^\/asset-png\//, ""))}`} alt={detail.name} />}<div><h2>{detail.name}</h2><p>ID {detail.id}{detail.strId ? ` · ${detail.strId}` : ""}{detail.meta ? ` · ${detail.meta}` : ""}</p></div></div>{sections.map(([title, items, transform]) => Boolean(items.length) && <section className="object-section" key={title}><h3>{title} <span>{items.length}</span></h3><div className="object-grid">{items.map((item, index) => { const card = transform(item); return <article key={`${title}-${index}`}><strong>{card.title}</strong><code>{card.lines.join("\n")}</code><small>{card.source}</small><p>{card.description}</p>{card.preview && <><img loading="lazy" src={`${basePath}/api/asset?path=${encodeURIComponent(card.preview)}`} alt={card.title} /><Button icon={FiEdit3} onClick={() => onReplace(card.preview)}>Replace asset</Button></>}</article>; })}</div></section>)}</div>;
}

function ReplacementModal({ path, project, unity, onClose, onSaved }) {
  const { request } = useApi();
  const [metadata, setMetadata] = useState(null);
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState("");
  useEffect(() => { request(`asset-replacement?path=${encodeURIComponent(path.replace(/^\/asset-png\//, ""))}`).then(setMetadata).catch((value) => setMessage(value.message)); }, [path, request]);
  async function save() { if (!project) return setMessage("Choose or create a mod project first."); if (!file) return setMessage(`Choose a ${metadata.extension} file.`); try { const result = await request(`mods/${encodeURIComponent(project.manifest.id)}/asset-replacement?path=${encodeURIComponent(metadata.targetPath)}&fileName=${encodeURIComponent(file.name)}`, { method: "POST", body: file, json: false, title: file.name }); if (unity?.available) await request(`mods/${encodeURIComponent(project.manifest.id)}/unity-build`, { method: "POST", body: { bundleName: result.replacement.bundleName, assets: result.bundleAssets, spriteAssets: result.spriteAssets }, title: result.replacement.bundleName }); await onSaved(); } catch (value) { setMessage(value.message); } }
  return <Modal title={metadata ? `Replace ${metadata.assetName}` : "Asset replacement"} onClose={onClose} actions={<Button icon={FiCheck} className="primary" onClick={save} disabled={!metadata}>Save{unity?.available ? " and build" : " source"}</Button>}>{metadata ? <div className="stack-form"><code>{metadata.targetPath}</code><p>{metadata.extension === ".png" ? `Required PNG: exactly ${metadata.width} x ${metadata.height} pixels.` : `Required type: ${metadata.extension}.`} Bundle: {metadata.bundleName}.</p><input type="file" accept={metadata.extension} onChange={(event) => setFile(event.target.files[0])} /></div> : <Empty>Loading asset requirements.</Empty>}{message && <Status kind="bad">{message}</Status>}</Modal>;
}

function Tables({ target }) {
  const { request } = useApi();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const [tableOffset, setTableOffset] = useState(0);
  const [tables, setTables] = useState({ tables: [], total: 0 });
  const [selectedTable, setSelectedTable] = useState(target);
  const [recordQuery, setRecordQuery] = useState("");
  const recordDebounced = useDebounced(recordQuery);
  const [recordOffset, setRecordOffset] = useState(0);
  const [records, setRecords] = useState({ records: [], recordIndexes: [], total: 0 });
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { request("mods").then((value) => setProjects(value.projects)); }, [request]);
  useEffect(() => { if (target) setSelectedTable(target); }, [target]);
  useEffect(() => { request(`tables?query=${encodeURIComponent(debounced)}&offset=${tableOffset}&limit=${PAGE_SIZE}`).then(setTables); }, [debounced, tableOffset, request]);
  useEffect(() => { if (!selectedTable) return; request(`table?directory=${encodeURIComponent(selectedTable.directory)}&file=${encodeURIComponent(selectedTable.fileName)}&query=${encodeURIComponent(recordDebounced)}&offset=${recordOffset}&limit=${PAGE_SIZE}`).then((value) => { setRecords(value); setSelectedRecord(null); }); }, [selectedTable, recordDebounced, recordOffset, request]);
  async function copy(duplicate) { if (!projectId || !selectedRecord) return setMessage("Select a mod project first."); try { await request(`mods/${encodeURIComponent(projectId)}/copy-record`, { method: "POST", body: { directory: selectedTable.directory, fileName: selectedTable.fileName, recordIndex: selectedRecord.index, duplicate }, title: recordLabel(selectedRecord.value, selectedRecord.index) }); setMessage(duplicate ? "Duplicate added to the mod." : "Record copied to the mod."); } catch (value) { setMessage(value.message); } }
  return <section className="panel three-column tables-layout"><Pane title="Tables"><div className="search-row"><FiSearch /><input value={query} onChange={(event) => { setQuery(event.target.value); setTableOffset(0); }} placeholder="Search decoded tables" /></div><div className="scroll-list">{tables.tables.map((table) => <ListButton key={table.relativePath} icon={FiDatabase} title={table.tableName} meta={`${table.directory} · ${table.format}`} active={selectedTable?.relativePath === table.relativePath} onClick={() => { setSelectedTable(table); setRecordOffset(0); setRecordQuery(""); }} />)}</div><Pager offset={tableOffset} total={tables.total} onChange={setTableOffset} /></Pane>
    <Pane title={selectedTable?.tableName || "Records"} meta={selectedTable?.relativePath || "Select a table"}>{selectedTable ? <><div className="search-row"><FiSearch /><input value={recordQuery} onChange={(event) => { setRecordQuery(event.target.value); setRecordOffset(0); }} placeholder="Search selected table" /></div><div className="scroll-list">{records.records.map((record, index) => <ListButton key={records.recordIndexes[index]} icon={FiFileText} title={recordLabel(record, records.recordIndexes[index])} meta={JSON.stringify(record)} active={selectedRecord?.index === records.recordIndexes[index]} onClick={() => setSelectedRecord({ value: record, index: records.recordIndexes[index] })} />)}{!records.records.length && <Empty>No records found.</Empty>}</div><Pager offset={recordOffset} total={records.total} onChange={setRecordOffset} /></> : <Empty>Select a gameplay table.</Empty>}</Pane>
    <Pane title={selectedRecord ? recordLabel(selectedRecord.value, selectedRecord.index) : "Record JSON"} meta="Exact decoded value" actions={selectedRecord && <div className="record-actions"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select mod project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><Button icon={FiEdit3} onClick={() => copy(false)}>Copy</Button><Button icon={FiPlus} className="primary" onClick={() => copy(true)}>Duplicate</Button></div>}>{message && <Status>{message}</Status>}{selectedRecord ? <pre className="json-preview">{JSON.stringify(selectedRecord.value, null, 2)}</pre> : <Empty>Select a record.</Empty>}</Pane></section>;
}

function AssetBrowser() {
  const { basePath, request } = useApi();
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const [offset, setOffset] = useState(0);
  const [directory, setDirectory] = useState({ entries: [], total: 0, path: "" });
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState("preview");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { request(`assets?path=${encodeURIComponent(path)}&query=${encodeURIComponent(debounced)}&offset=${offset}&limit=${PAGE_SIZE}`, { title: path.split("/").pop() || "Extracted assets" }).then(setDirectory).catch((value) => setError(value.message)); }, [path, debounced, offset, request]);
  function open(entry) { if (entry.kind === "directory") { setPath(entry.path); setOffset(0); setQuery(""); setSelected(null); setPreview(null); } else { setSelected(entry); setView("preview"); setPreview(null); } }
  async function showRelated() { if (!selected) return; setView("related"); try { setPreview(await request(`related?path=${encodeURIComponent(selected.path)}`, { title: selected.name })); } catch (value) { setError(value.message); } }
  async function reveal() { if (!selected) return; try { await request(`open-file-location?path=${encodeURIComponent(selected.path)}`, { method: "POST", title: selected.name }); } catch (value) { setError(value.message); } }
  const crumbs = useMemo(() => [{ name: "Root", path: "" }, ...path.split("/").filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join("/") }))], [path]);
  return <section className="panel asset-layout"><Pane title="Extracted assets" meta={<span className="breadcrumbs">{crumbs.map((crumb) => <button key={crumb.path} type="button" onClick={() => { setPath(crumb.path); setOffset(0); setSelected(null); }}>{crumb.name}</button>)}</span>}><div className="search-row"><FiSearch /><input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="Filter this folder" /></div>{error && <Status kind="bad">{error}</Status>}<div className="scroll-list">{directory.entries.map((entry) => <ListButton key={entry.path} icon={entry.kind === "directory" ? FiFolder : assetIcon(entry)} title={entry.name} meta={entry.kind === "directory" ? "Folder" : `${formatBytes(entry.size)} · ${entry.assetType || entry.extension || "file"}`} active={selected?.path === entry.path} onClick={() => open(entry)} />)}{!directory.entries.length && <Empty>This folder is empty.</Empty>}</div><Pager offset={offset} total={directory.total} onChange={setOffset} /></Pane>
    <div className="asset-focus"><Pane title="Selected object" meta="Only the active object">{selected ? <article className="selected-asset"><span className="asset-kind">{selected.assetType || selected.extension || "File"}</span><h2>{selected.name}</h2><dl><div><dt>Size</dt><dd>{formatBytes(selected.size)}</dd></div><div><dt>Path</dt><dd>{selected.path}</dd></div></dl><div className="button-row"><Button icon={FiEye} className={view === "preview" ? "active" : ""} onClick={() => { setView("preview"); setPreview(null); }}>Preview</Button><Button icon={FiLink2} className={view === "related" ? "active" : ""} onClick={showRelated}>Related</Button><IconButton icon={FiHardDrive} label="Open file location" onClick={reveal} /></div></article> : <Empty>Select an object.</Empty>}</Pane><Pane title={selected ? (view === "related" ? `Related to ${selected.name}` : selected.name) : "Asset preview"} meta={selected?.path || "Select a file"}>{selected ? (view === "related" ? <RelatedPreview value={preview} onOpen={open} /> : <AssetPreview entry={selected} basePath={basePath} request={request} />) : <Empty>Images, audio, video, text, Unity data, and Spine sets appear here.</Empty>}</Pane></div>
  </section>;
}

function AssetPreview({ entry, basePath, request }) {
  const [text, setText] = useState("");
  const [spine, setSpine] = useState(null);
  const frameRef = useRef(null);
  const url = `${basePath}/api/asset?path=${encodeURIComponent(entry.path)}`;
  const ext = entry.extension;
  const isText = [".bytes", ".csv", ".json", ".log", ".lua", ".md", ".txt", ".xml", ".yaml", ".yml"].includes(ext);
  const spineCandidate = [".skel", ".atlas"].includes(ext) || ([".bytes", ".json"].includes(ext) && String(entry.assetType || "").includes("TextAsset"));
  useEffect(() => { setText(""); setSpine(null); if (spineCandidate) request(`spine-set?path=${encodeURIComponent(entry.path)}`, { title: entry.name }).then(setSpine).catch(() => {}); else if (isText) request(`text?path=${encodeURIComponent(entry.path)}`, { title: entry.name }).then((value) => { let next = value.text; if (ext === ".json" && !value.truncated) try { next = JSON.stringify(JSON.parse(next.replace(/^\uFEFF/, "")), null, 2); } catch {} setText(next + (value.truncated ? "\n\n[Preview truncated]" : "")); }); }, [entry.path]); // eslint-disable-line react-hooks/exhaustive-deps
  async function loadSpine() { if (!spine?.ready || !frameRef.current?.contentWindow) return; const loaded = await Promise.all(spine.files.map(async (file) => ({ name: file.name, blob: await request(`asset?path=${encodeURIComponent(file.path)}`, { response: "blob", title: file.name }) }))); const win = frameRef.current.contentWindow; const transfer = new win.DataTransfer(); loaded.forEach((file) => transfer.items.add(new win.File([file.blob], file.name, { type: file.blob.type }))); win.dispatchEvent(new win.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })); }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return <div className="media-preview"><img src={url} alt={entry.name} /></div>;
  if ([".wav", ".mp3", ".ogg"].includes(ext)) return <div className="media-preview"><audio controls src={url} /></div>;
  if ([".mp4", ".webm"].includes(ext)) return <div className="media-preview"><video controls src={url} /></div>;
  if (spine?.ready) return <iframe ref={frameRef} className="spine-frame" src={`${basePath}/spine/?mode=view`} title={`Spine preview for ${entry.name}`} onLoad={loadSpine} />;
  if (isText || spineCandidate) return <pre className="json-preview">{text || (spine && !spine.ready ? `Spine set incomplete: ${(spine.missing || []).join(", ")}` : "Loading preview")}</pre>;
  return <Empty>No inline preview is available for this file.</Empty>;
}

function RelatedPreview({ value, onOpen }) {
  if (!value) return <Empty>Finding related objects.</Empty>;
  const assets = [...(value.assets || []), ...(value.unityObjects || [])];
  if (!assets.length && !value.tables?.length) return <Empty>No direct Unity references or gameplay table matches were found.</Empty>;
  return <div className="related-preview">{Boolean(assets.length) && <section><h3>Assets</h3>{assets.map((item, index) => item.path ? <ListButton key={`${item.path}-${index}`} icon={FiLink2} title={item.name} meta={`${item.relation || "Related asset"} · ${item.assetType || "Unity object"} · ${item.path}`} onClick={() => onOpen(item)} /> : <article key={index}><strong>{item.name}</strong><span>{item.relation || "Unity object"}</span></article>)}</section>}{Boolean(value.tables?.length) && <section><h3>Gameplay table values</h3>{value.tables.map((item, index) => <article key={index}><strong>{item.table || "Gameplay table"} · {item.idField || "ID"} {item.id}</strong><span>Matched by {item.matchedBy}</span><code>{JSON.stringify(item, null, 2)}</code></article>)}</section>}</div>;
}

function assetIcon(entry) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(entry.extension)) return FiImage;
  if ([".wav", ".mp3", ".ogg"].includes(entry.extension)) return FiMusic;
  if ([".mp4", ".webm"].includes(entry.extension)) return FiVideo;
  if ([".json", ".txt", ".bytes", ".atlas", ".xml", ".lua"].includes(entry.extension)) return FiFileText;
  return FiFile;
}
