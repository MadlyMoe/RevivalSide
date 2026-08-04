import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FiAlertTriangle, FiCheck, FiCheckCircle, FiChevronDown, FiChevronUp, FiCode,
  FiCopy, FiDownload, FiEdit3, FiFilePlus, FiList, FiPackage, FiRefreshCw,
  FiSave, FiSearch, FiTrash2, FiUpload, FiX,
} from "react-icons/fi";
import { useApi } from "./api.jsx";
import { Button, Empty, Field, IconButton, ListButton, Modal, Pane, Status, downloadUrl } from "./ui.jsx";

export function ModCreator() {
  const { basePath, request } = useApi();
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [patch, setPatch] = useState(null);
  const [editor, setEditor] = useState("form");
  const [editorValue, setEditorValue] = useState(null);
  const [newProject, setNewProject] = useState({ id: "", name: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reference, setReference] = useState(null);

  const refresh = useCallback(async (keepId) => {
    const data = await request("mods");
    setProjects(data.projects);
    const id = keepId || selected?.manifest.id;
    if (id && data.projects.some((item) => item.id === id)) setSelected(await request(`mods/${encodeURIComponent(id)}`));
    return data.projects;
  }, [request, selected?.manifest.id]);

  useEffect(() => { refresh(new URLSearchParams(location.search).get("project") || "").catch((value) => setError(value.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function openProject(id) {
    try { setSelected(await request(`mods/${encodeURIComponent(id)}`)); setPatch(null); setEditorValue(null); setError(""); }
    catch (value) { setError(value.message); }
  }

  async function createProject(event) {
    event.preventDefault();
    try {
      const project = await request("mods", { method: "POST", body: newProject, title: newProject.name });
      setNewProject({ id: "", name: "" });
      await refresh(project.manifest.id);
      setMessage(`${project.manifest.name} created.`);
      setError("");
    } catch (value) { setError(value.message); }
  }

  async function importProject(file) {
    if (!file) return;
    try {
      const project = await request("mods/import", { method: "POST", body: file, json: false, title: file.name });
      await refresh(project.manifest.id);
      setMessage(`${project.manifest.name} imported.`);
      setError("");
    } catch (value) { setError(value.message); }
  }

  async function saveManifest(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const project = await request(`mods/${encodeURIComponent(selected.manifest.id)}`, { method: "PUT", body: Object.fromEntries(form), title: selected.manifest.name });
      setSelected(project);
      await refresh(project.manifest.id);
      setMessage("Manifest saved.");
      setError("");
    } catch (value) { setError(value.message); }
  }

  async function validateProject() {
    try {
      const validation = await request(`mods/${encodeURIComponent(selected.manifest.id)}/validate`);
      setSelected((project) => ({ ...project, validation }));
      setMessage(validation.ok ? "Project is valid." : `${validation.errors.length} validation errors found.`);
    } catch (value) { setError(value.message); }
  }

  async function openPatch(patchId) {
    try {
      const detail = await request(`mods/${encodeURIComponent(selected.manifest.id)}/patch?patchId=${encodeURIComponent(patchId)}`);
      setPatch(detail);
      setEditorValue(structuredClone(detail.patch.value));
      setEditor("form");
      setError("");
    } catch (value) { setError(value.message); }
  }

  async function savePatch(value = editorValue) {
    try {
      const detail = await request(`mods/${encodeURIComponent(selected.manifest.id)}/patch`, { method: "PUT", body: { table: patch.patch.table, key: patch.patch.key, source: patch.patch.source, previousPatchId: patch.patch.patchId, value }, title: String(patch.patch.key.value) });
      setPatch(detail);
      setEditorValue(structuredClone(detail.patch.value));
      await refresh(selected.manifest.id);
      setMessage("Record patch saved.");
      setError("");
    } catch (valueError) { setError(valueError.message); }
  }

  async function duplicatePatch() {
    if (patch?.baseIndex < 0) return;
    try {
      const detail = await request(`mods/${encodeURIComponent(selected.manifest.id)}/copy-record`, { method: "POST", body: { directory: patch.patch.table.directory, fileName: patch.patch.table.fileName, recordIndex: patch.baseIndex, duplicate: true }, title: String(patch.patch.key.value) });
      await refresh(selected.manifest.id);
      await openPatch(detail.patch.patchId);
    } catch (value) { setError(value.message); }
  }

  async function removePatch() {
    if (!confirm("Remove this patch from the mod?")) return;
    try {
      const project = await request(`mods/${encodeURIComponent(selected.manifest.id)}/patch?patchId=${encodeURIComponent(patch.patch.patchId)}`, { method: "DELETE", title: String(patch.patch.key.value) });
      setSelected(project);
      setPatch(null);
      setEditorValue(null);
      await refresh(project.manifest.id);
    } catch (value) { setError(value.message); }
  }

  return <section className="panel three-column creator-layout">
    <Pane title="Mod projects" meta="Portable, folder-based projects">
      <form className="stack-form" onSubmit={createProject}><input required pattern="[a-z0-9][a-z0-9._-]{1,63}" placeholder="mod-id" value={newProject.id} onChange={(event) => setNewProject({ ...newProject, id: event.target.value })} /><input required placeholder="Mod name" value={newProject.name} onChange={(event) => setNewProject({ ...newProject, name: event.target.value })} /><Button icon={FiFilePlus} className="primary" type="submit">Create project</Button><label className="button file-button"><FiUpload aria-hidden="true" /><span>Import ZIP</span><input type="file" accept=".zip,.revivalmod" onChange={(event) => importProject(event.target.files[0])} /></label></form>
      <div className="scroll-list">{projects.map((project) => <ListButton key={project.id} icon={FiPackage} title={project.name} meta={`${project.id} · ${project.version} · ${project.patchCount} patches`} active={selected?.manifest.id === project.id} onClick={() => openProject(project.id)} />)}{!projects.length && <Empty>No mod projects loaded.</Empty>}</div>
    </Pane>
    <Pane title={selected?.manifest.name || "Project"} meta={selected ? `${selected.manifest.id} · ${selected.manifest.version}` : "Select a mod project"}>
      {selected ? <>
        <form className="form-grid" onSubmit={saveManifest}><Field label="Name"><input name="name" required defaultValue={selected.manifest.name} key={`${selected.manifest.id}-name`} /></Field><Field label="Version"><input name="version" required defaultValue={selected.manifest.version} key={`${selected.manifest.id}-version`} /></Field><Field label="Author" wide><input name="author" defaultValue={selected.manifest.author || ""} key={`${selected.manifest.id}-author`} /></Field><Field label="Description" wide><textarea name="description" rows="3" defaultValue={selected.manifest.description || ""} key={`${selected.manifest.id}-description`} /></Field><div className="button-row wide"><Button icon={FiSave} className="primary" type="submit">Save</Button><Button icon={FiCheckCircle} onClick={validateProject}>Validate</Button><Button icon={FiDownload} onClick={() => { location.href = downloadUrl(basePath, selected.manifest.id); }}>Export ZIP</Button></div></form>
        <Status kind={selected.validation?.ok ? "good" : "bad"}>{selected.validation?.ok ? <FiCheckCircle /> : <FiAlertTriangle />}<span>{selected.validation?.ok ? "Valid" : `${selected.validation?.errors?.length || 0} errors`} · {selected.validation?.patchCount || 0} patches</span></Status>
        {(error || message) && <Status kind={error ? "bad" : "good"}>{error || message}</Status>}
        <h3 className="subheading">Mod records</h3><div className="scroll-list patches">{selected.patches.map((item) => <ListButton key={item.patchId} icon={item.removed ? FiTrash2 : FiEdit3} title={`${item.removed ? "Remove " : ""}${item.label}`} meta={`${item.table.tableName} · ${item.key.field}`} active={patch?.patch.patchId === item.patchId} onClick={() => openPatch(item.patchId)} />)}{!selected.patches.length && <Empty>Copy or duplicate a record from Asset:Side tables.</Empty>}</div>
      </> : <Empty>Select or create a project.</Empty>}
    </Pane>
    <Pane title={patch ? String(patch.patch.key.value) : "Record editor"} meta={patch ? `${patch.patch.table.tableName} · ${patch.patch.key.field}` : "Select a mod record"} actions={patch && <div className="button-row"><Button icon={FiSave} className="primary" onClick={() => savePatch()}>Save</Button><IconButton icon={FiCopy} label="Duplicate record" disabled={patch.baseIndex < 0} onClick={duplicatePatch} /><IconButton icon={FiTrash2} label="Delete record" className="danger" onClick={() => savePatch(null)} /><IconButton icon={FiX} label="Remove from mod" onClick={removePatch} /></div>}>
      {patch ? <RecordEditor mode={editor} setMode={setEditor} value={editorValue} setValue={setEditorValue} detail={patch} onReference={setReference} /> : <Empty>Select a record to edit.</Empty>}
    </Pane>
    {reference && <ReferencePicker value={reference.value} onClose={() => setReference(null)} onSelect={(value) => { setEditorValue(setAt(editorValue, reference.path, value)); setReference(null); }} />}
  </section>;
}

function RecordEditor({ mode, setMode, value, setValue, detail, onReference }) {
  const changes = useMemo(() => diff(detail.base, value), [detail.base, value]);
  return <div className="editor-shell"><div className="editor-tabs"><Button icon={FiList} className={mode === "form" ? "active" : "ghost"} onClick={() => setMode("form")}>Fields</Button><Button icon={FiCode} className={mode === "raw" ? "active" : "ghost"} onClick={() => setMode("raw")}>JSON</Button><Button icon={FiRefreshCw} className={mode === "diff" ? "active" : "ghost"} onClick={() => setMode("diff")}>Changes</Button><Button icon={FiCheck} className={mode === "validation" ? "active" : "ghost"} onClick={() => setMode("validation")}>Validation</Button></div>
    {mode === "form" && (value === null ? <Empty>This patch removes the record.</Empty> : <div className="primitive-fields">{walk(value).map(({ path, value: fieldValue }) => <PrimitiveField key={path.join(".")} path={path} value={fieldValue} onChange={(next) => setValue(setAt(value, path, next))} onReference={onReference} />)}</div>)}
    {mode === "raw" && <RawRecordEditor value={value} onChange={setValue} />}
    {mode === "diff" && <div className="report-list">{changes.map((change) => <article key={change.path}><code>{change.path}</code><pre>{`Before: ${JSON.stringify(change.before, null, 2)}\nAfter: ${JSON.stringify(change.after, null, 2)}`}</pre></article>)}{!changes.length && <Empty>No differences from the base record.</Empty>}</div>}
    {mode === "validation" && <div className="report-list">{(detail.validation.errors || []).map((issue, index) => <article className="error" key={`e${index}`}><code>{issue.path || "record"}</code><span>{issue.message}</span></article>)}{(detail.validation.warnings || []).map((issue, index) => <article className="warning" key={`w${index}`}><code>{issue.path || "record"}</code><span>{issue.message}</span></article>)}{!detail.validation.errors?.length && !detail.validation.warnings?.length && <Empty>No validation issues.</Empty>}</div>}
  </div>;
}

function RawRecordEditor({ value, onChange }) {
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(JSON.stringify(value, null, 2)); setInvalid(false); }, [value]);
  function update(next) { setDraft(next); try { JSON.parse(next); setInvalid(false); } catch { setInvalid(true); } }
  function commit() { try { onChange(JSON.parse(draft)); } catch { setInvalid(true); } }
  return <textarea className={`raw-editor ${invalid ? "invalid" : ""}`} aria-invalid={invalid} value={draft} onChange={(event) => update(event.target.value)} onBlur={commit} spellCheck="false" />;
}

function PrimitiveField({ path, value, onChange, onReference }) {
  const name = path.map((part, index) => typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${part}`).join("");
  const reference = /id|key|item|unit|stage|dungeon|reward/i.test(name);
  return <label className="primitive-field"><span>{name}</span><span className="field-control">{typeof value === "boolean" ? <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /> : <input type={typeof value === "number" ? "number" : "text"} step={typeof value === "number" ? "any" : undefined} value={value ?? ""} onChange={(event) => onChange(typeof value === "number" ? Number(event.target.value) : event.target.value)} />}{reference && <IconButton icon={FiSearch} label={`Find reference for ${name}`} onClick={() => onReference({ path, value })} />}</span></label>;
}

function ReferencePicker({ value, onClose, onSelect }) {
  const { request } = useApi();
  const [query, setQuery] = useState(String(value ?? ""));
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  async function search(event) { event.preventDefault(); if (query.trim().length < 2) return; try { setItems((await request(`references?query=${encodeURIComponent(query.trim())}`)).references); setError(""); } catch (valueError) { setError(valueError.message); } }
  return <Modal title="Select referenced record" onClose={onClose}><form className="search-row" onSubmit={search}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, name, table, or type" /><Button icon={FiSearch} className="primary" type="submit">Search</Button></form>{error && <Status kind="bad">{error}</Status>}<div className="scroll-list modal-list">{items.map((item, index) => <ListButton key={`${item.table}-${item.id}-${index}`} title={item.name || item.strId || String(item.id)} meta={`${item.table || "Table"} · ${item.type || "Record"} · ID ${item.id}`} onClick={() => onSelect(typeof value === "string" && item.strId ? item.strId : item.id)} />)}{!items.length && <Empty>Search for a referenced record.</Empty>}</div></Modal>;
}

export function ModLoader() {
  const { basePath, request } = useApi();
  const [runtime, setRuntime] = useState(null);
  const [enabled, setEnabled] = useState([]);
  const [copying, setCopying] = useState(null);
  const [copyInput, setCopyInput] = useState({ id: "", name: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => { const value = await request("mod-runtime"); setRuntime(value); setEnabled(value.profile.enabled.slice()); return value; }, [request]);
  useEffect(() => { refresh().catch((value) => setError(value.message)); }, [refresh]);

  const ordered = useMemo(() => {
    if (!runtime) return [];
    const byId = Object.fromEntries(runtime.projects.map((project) => [project.id, project]));
    return enabled.map((id) => byId[id]).filter(Boolean).concat(runtime.projects.filter((project) => !enabled.includes(project.id)));
  }, [runtime, enabled]);

  async function apply(next = enabled) {
    try { const value = await request("mod-runtime/apply", { method: "PUT", body: { enabled: next }, title: `${next.length} active mods` }); setRuntime(value); setEnabled(value.profile.enabled.slice()); setMessage("Load order applied. Restart the client to reload content."); setError(""); }
    catch (value) { setError(value.message); await refresh(); }
  }
  async function toggle(id, checked) { const next = enabled.filter((value) => value !== id); if (checked) next.push(id); setEnabled(next); await apply(next); }
  function move(id, direction) { const next = enabled.slice(); const index = next.indexOf(id); const target = index + direction; if (index < 0 || target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; setEnabled(next); }
  async function rollback() { try { const value = await request("mod-runtime/rollback", { method: "POST" }); setRuntime(value); setEnabled(value.profile.enabled.slice()); setMessage("Previous runtime restored."); } catch (value) { setError(value.message); } }
  async function importProject(file) { if (!file) return; try { await request("mods/import", { method: "POST", body: file, json: false, title: file.name }); await refresh(); setMessage(`${file.name} added.`); } catch (value) { setError(value.message); } }
  async function remove(project) { if (!confirm(`Delete ${project.name} permanently?`)) return; try { const value = await request(`mods/${encodeURIComponent(project.id)}`, { method: "DELETE", title: project.name }); setRuntime(value); setEnabled(value.profile.enabled.slice()); setMessage(`${project.name} deleted.`); } catch (value) { setError(value.message); } }
  function edit(project) { location.href = project.episodeProject ? `${basePath}/story?project=${encodeURIComponent(project.id)}` : `${basePath}?view=creator&project=${encodeURIComponent(project.id)}`; }
  function startCopy(project) { setCopying(project); setCopyInput({ id: `${project.id.slice(0, 59)}-copy`, name: `${project.name} Copy` }); setError(""); }
  async function copyProject(event) {
    event.preventDefault();
    try {
      const result = await request(`mods/${encodeURIComponent(copying.id)}/copy`, { method: "POST", body: copyInput, title: copyInput.name });
      await refresh(); setCopying(null); setMessage(`${result.manifest.name} copied${result.remapped.length ? ` with ${result.remapped.length} collision-safe remaps` : ""}. The copy is disabled until you enable it.`); setError("");
    } catch (value) { setError(value.message); }
  }

  const current = runtime?.current;
  return <section className="panel two-column loader-layout"><Pane title="Runtime load order" meta="Activation is immediate; restart the client to reload" actions={<div className="button-row"><label className="button file-button"><FiUpload /><span>Add mod</span><input type="file" accept=".zip,.revivalmod" onChange={(event) => importProject(event.target.files[0])} /></label><Button icon={FiCheck} className="primary" onClick={() => apply()}>Apply order</Button><Button icon={FiRefreshCw} className="danger" disabled={!runtime?.previous} onClick={rollback}>Rollback</Button></div>}>
    {(error || message) && <Status kind={error ? "bad" : "good"}>{error || message}</Status>}
    <div className="scroll-list loader-list">{ordered.map((project) => { const index = enabled.indexOf(project.id); return <div className={`loader-row ${index >= 0 ? "enabled" : ""}`} key={project.id}><input type="checkbox" checked={index >= 0} aria-label={`Enable ${project.name}`} onChange={(event) => toggle(project.id, event.target.checked)} /><span className="list-copy"><strong>{index >= 0 ? `${index + 1}. ${project.name}` : project.name}</strong><small>{project.id} · {project.version} · {project.patchCount} patches</small></span><IconButton icon={FiEdit3} label={`Edit ${project.name}`} onClick={() => edit(project)} /><IconButton icon={FiCopy} label={`Copy ${project.name}`} onClick={() => startCopy(project)} /><IconButton icon={FiChevronUp} label="Move earlier" disabled={index <= 0} onClick={() => move(project.id, -1)} /><IconButton icon={FiChevronDown} label="Move later" disabled={index < 0 || index >= enabled.length - 1} onClick={() => move(project.id, 1)} /><IconButton icon={FiTrash2} label={`Delete ${project.name}`} className="danger" onClick={() => remove(project)} /></div>; })}{!ordered.length && <Empty>Create or import a mod project first.</Empty>}</div>
  </Pane><Pane title="Effective runtime" meta="Shared by the listener, combat host, and patched client"><div className="runtime-summary"><strong>{current ? `${current.enabled.length} mods active` : "No runtime built"}</strong><code>{current?.hash || "No mod-set hash"}</code><span>{current ? `${current.tableCount} tables · ${current.patchCount} patches · ${(current.warnings || []).length} warnings` : "Choose mods and apply a profile."}</span></div><RuntimeReport current={current} /></Pane>{copying && <Modal title={`Copy ${copying.name}`} onClose={() => setCopying(null)}><form className="form-grid" onSubmit={copyProject}><Field label="New project ID" wide><input autoFocus required pattern="[a-z0-9][a-z0-9._-]{1,63}" value={copyInput.id} onChange={(event) => setCopyInput({ ...copyInput, id: event.target.value })} /></Field><Field label="New project name" wide><input required value={copyInput.name} onChange={(event) => setCopyInput({ ...copyInput, name: event.target.value })} /></Field><p className="wide copy-note">Story:Side copies receive new generated stage, dungeon, cutscene, string, and stage-slot IDs. Other mods are copied as exact editable forks.</p><div className="button-row wide"><Button icon={FiCopy} className="primary" type="submit">Create copy</Button></div></form></Modal>}</section>;
}

function RuntimeReport({ current }) {
  if (!current) return <Empty>Apply a profile to inspect effective changes.</Empty>;
  return <div className="runtime-report"><h3>{current.conflicts?.length ? `${current.conflicts.length} resolved conflicts` : "No load-order conflicts"}</h3>{(current.conflicts || []).map((item, index) => <article key={`c${index}`}><code>{item.table} · {item.key.field}={JSON.stringify(item.key.value)}</code><span>{item.previousModId} replaced by {item.winningModId}</span></article>)}{Boolean(current.warnings?.length) && <h3>Reference warnings</h3>}{(current.warnings || []).map((item, index) => <article className="warning" key={`w${index}`}><code>{item.table} · {item.path}</code><span>{item.message}</span></article>)}<h3>Effective changes</h3>{(current.changes || []).map((item, index) => <article key={`m${index}`}><code>{item.action.toUpperCase()} · {item.table || item.string || item.assetBundle || "runtime"}</code><span>{item.modId}</span></article>)}</div>;
}

function walk(value, path = [], result = []) {
  if (value === null || typeof value !== "object") { result.push({ path, value }); return result; }
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index], result));
  else Object.entries(value).forEach(([key, item]) => walk(item, [...path, key], result));
  return result;
}

function setAt(root, path, value) {
  const next = structuredClone(root);
  let target = next;
  for (let index = 0; index < path.length - 1; index += 1) target = target[path[index]];
  target[path.at(-1)] = value;
  return next;
}

function diff(before, after, prefix = "", changes = []) {
  if (changes.length >= 500 || JSON.stringify(before) === JSON.stringify(after)) return changes;
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    new Set([...Object.keys(before), ...Object.keys(after)]).forEach((key) => diff(before[key], after[key], prefix ? `${prefix}.${key}` : key, changes));
  } else changes.push({ path: prefix || "$", before, after });
  return changes;
}
