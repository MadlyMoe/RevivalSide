import { useEffect, useState } from "react";
import { FiChevronLeft, FiChevronRight, FiInbox } from "react-icons/fi";

export const PAGE_SIZE = 100;

export function Button({ icon: Icon, children, className = "", title, ...props }) {
  return <button className={`button ${className}`.trim()} title={title} {...props}>{Icon && <Icon aria-hidden="true" />}{children && <span>{children}</span>}</button>;
}

export function IconButton({ icon: Icon, label, className = "", ...props }) {
  return <button className={`button icon-button ${className}`.trim()} aria-label={label} title={label} {...props}><Icon aria-hidden="true" /></button>;
}

export function Empty({ children }) {
  return <div className="empty"><FiInbox aria-hidden="true" /><span>{children}</span></div>;
}

export function Pager({ offset, total, onChange }) {
  const end = Math.min(offset + PAGE_SIZE, total);
  return <div className="pager"><IconButton icon={FiChevronLeft} label="Previous page" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))} /><span>{total ? `${offset + 1}-${end} of ${total.toLocaleString()}` : "0 items"}</span><IconButton icon={FiChevronRight} label="Next page" disabled={end >= total} onClick={() => onChange(offset + PAGE_SIZE)} /></div>;
}

export function Pane({ title, meta, actions, children, className = "" }) {
  return <section className={`pane ${className}`.trim()}><header className="pane-heading"><div><h2>{title}</h2>{meta && <p>{meta}</p>}</div>{actions && <div className="pane-actions">{actions}</div>}</header>{children}</section>;
}

export function ListButton({ title, meta, active, icon: Icon, leading, trailing, onClick }) {
  return <button type="button" className={`list-button ${active ? "active" : ""}`} onClick={onClick}>{leading || (Icon && <Icon aria-hidden="true" />)}<span className="list-copy"><strong>{title}</strong>{meta && <small>{meta}</small>}</span>{trailing}</button>;
}

export function Field({ label, hint, wide, children }) {
  return <label className={wide ? "field wide" : "field"}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function JsonInput({ label, value, onChange, rows = 5, hint }) {
  return <Field label={label} hint={hint} wide><textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} spellCheck="false" /></Field>;
}

export function Status({ kind = "neutral", children }) {
  return <div className={`status ${kind}`}>{children}</div>;
}

export function Modal({ title, onClose, children, actions }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><Button className="ghost" onClick={onClose}>Close</Button></header><div className="modal-body">{children}</div>{actions && <footer>{actions}</footer>}</section></div>;
}

export function useDebounced(value, delay = 180) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function formatBytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function parseJson(value, label) {
  try { return JSON.parse(value || "null"); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
}

export function recordLabel(record, index) {
  if (!record || typeof record !== "object") return `Record ${index + 1}`;
  const keys = Object.keys(record);
  const key = keys.find((name) => /strid$|_key$|^id$|name$/i.test(name) && record[name] !== "") || keys.find((name) => /id|key|name/i.test(name) && record[name] !== "");
  return key ? String(record[key]) : `Record ${index + 1}`;
}

export function downloadUrl(basePath, projectId) {
  return `${basePath}/api/mods/${encodeURIComponent(projectId)}/export`;
}
