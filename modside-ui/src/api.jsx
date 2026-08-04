import { createContext, useCallback, useContext, useRef, useState } from "react";
import { FiLayers } from "react-icons/fi";

const ApiContext = createContext(null);
const basePath = document.querySelector('meta[name="modside-base"]')?.content || "/mod-side";

const routeNames = {
  health: "Workspace status",
  systems: "Game systems",
  "system-tables": "System tables",
  fields: "Gameplay fields",
  tables: "Gameplay tables",
  table: "Gameplay table",
  objects: "Game objects",
  object: "Game object",
  assets: "Extracted assets",
  asset: "Extracted asset",
  text: "Text preview",
  related: "Related data",
  "spine-set": "Spine asset set",
  references: "Record references",
  "asset-replacement": "Asset replacement",
  "unity-compiler": "Unity compiler",
  "mod-runtime": "Mod load order",
  mods: "Mod projects",
  "episode-maker": "Story:Side",
  "unit-maker": "Unit:Side",
};

function loadingCopy(route, method, body, explicitTitle) {
  const parsed = new URL(`${basePath}/api/${route}`, location.origin);
  const parts = parsed.pathname.slice(`${basePath}/api/`.length).split("/").filter(Boolean);
  const resource = routeNames[parts[0]] || parts.join(" ").replaceAll("-", " ");
  const queryName = parsed.searchParams.get("path") || parsed.searchParams.get("file") || parsed.searchParams.get("id") || parsed.searchParams.get("stageId") || parsed.searchParams.get("episodeId") || parsed.searchParams.get("query");
  const bodyName = body && typeof body === "object" && !(body instanceof Blob) && (body.projectName || body.displayName || body.name || body.unitStrId || body.bundleName || body.projectId);
  const title = explicitTitle || body?.name || queryName?.split(/[\\/]/).pop() || bodyName || resource;
  const verb = parts.includes("extract") ? "Extracting" : method === "GET" ? "Loading" : method === "DELETE" ? "Deleting" : method === "PUT" ? "Updating" : "Building";
  return { title: String(title), message: `${verb} ${resource}` };
}

export function ApiProvider({ children }) {
  const operations = useRef(new Map());
  const sequence = useRef(0);
  const showTimer = useRef();
  const hideTimer = useRef();
  const [loading, setLoading] = useState({ visible: false, title: "", message: "", progress: 0 });

  const renderProgress = useCallback((copy, force = false) => {
    const values = [...operations.current.values()];
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 100;
    setLoading((current) => ({ ...current, ...copy, progress: force ? 100 : Math.min(98, Math.max(current.progress, Math.floor(average))) }));
  }, []);

  const request = useCallback(async (route, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const id = ++sequence.current;
    const copy = loadingCopy(route, method, options.body, options.title);
    operations.current.set(id, 5);
    clearTimeout(hideTimer.current);
    renderProgress(copy);
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setLoading((current) => ({ ...current, visible: operations.current.size > 0 })), 140);
    try {
      const headers = {};
      let body = options.body;
      if (options.json !== false && body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(body);
      }
      let response = await fetch(`${basePath}/api/${route}`, { method, headers, body, cache: "no-store" });
      operations.current.set(id, 14);
      renderProgress(copy);
      if (response.body?.getReader && typeof ReadableStream !== "undefined") {
        const total = Number(response.headers.get("content-length")) || 0;
        let loaded = 0;
        const reader = response.body.getReader();
        const stream = new ReadableStream({
          async pull(controller) {
            const part = await reader.read();
            if (part.done) {
              operations.current.set(id, 96);
              renderProgress(copy);
              controller.close();
              return;
            }
            loaded += part.value.byteLength;
            const progress = total ? 14 + 82 * Math.min(1, loaded / total) : Math.min(92, 14 + Math.log2(loaded / 1024 + 1) * 8);
            operations.current.set(id, progress);
            renderProgress(copy);
            controller.enqueue(part.value);
          },
        });
        response = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      const value = options.response === "blob" ? await response.blob() : await response.json();
      if (!response.ok) throw new Error(value?.error || response.statusText);
      return value;
    } finally {
      operations.current.delete(id);
      if (!operations.current.size) {
        clearTimeout(showTimer.current);
        renderProgress(copy, true);
        hideTimer.current = setTimeout(() => setLoading({ visible: false, title: "", message: "", progress: 0 }), 180);
      }
    }
  }, [renderProgress]);

  return (
    <ApiContext.Provider value={{ basePath, request }}>
      {children}
      {loading.visible && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-dialog">
            <div className="loading-heading">
              <span className="loading-icon"><FiLayers /></span>
              <span className="loading-copy"><strong>{loading.title}</strong><small>{loading.message}</small></span>
              <span className="loading-value">{loading.progress}%</span>
            </div>
            <div className="loading-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={loading.progress}>
              <span style={{ width: `${loading.progress}%` }} />
            </div>
          </div>
        </div>
      )}
    </ApiContext.Provider>
  );
}

export function useApi() {
  const value = useContext(ApiContext);
  if (!value) throw new Error("ApiProvider is missing");
  return value;
}
