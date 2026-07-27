import {
  DEFAULT_REVIVALSIDE_SETTINGS,
  EMPTY_SERVICES,
  getLauncherSnapshot,
  runLauncherAction,
  startLauncherService,
  stopLauncherService,
  type LauncherServices,
  type LauncherSnapshot,
  type RevivalSideSettings,
  type ServiceName,
} from "@/lib/launcher-api";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LauncherLogEntry {
  id: number;
  timestamp: Date;
  level: LogLevel;
  message: string;
}

interface LauncherStateContextValue {
  snapshot: LauncherSnapshot | null;
  settings: RevivalSideSettings;
  services: LauncherServices;
  logs: LauncherLogEntry[];
  loading: boolean;
  busyAction: string | null;
  lastError: string | null;
  setSetting: <K extends keyof RevivalSideSettings>(key: K, value: RevivalSideSettings[K]) => void;
  saveSettings: () => Promise<void>;
  resetSettings: () => Promise<void>;
  refresh: () => Promise<LauncherSnapshot>;
  runAction: <T extends object = Record<string, unknown>>(
    action: string,
    payload?: Record<string, unknown>,
  ) => Promise<T & { ok: true }>;
  startService: (service: ServiceName) => Promise<void>;
  stopService: (service: ServiceName) => Promise<void>;
  clearError: () => void;
  clearLogs: () => void;
}

const LauncherStateContext = createContext<LauncherStateContextValue | null>(null);
let logId = 0;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const LauncherStateProvider = ({ children }: { children: ReactNode }) => {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [settings, setSettings] = useState<RevivalSideSettings>(DEFAULT_REVIVALSIDE_SETTINGS);
  const [services, setServices] = useState<LauncherServices>(EMPTY_SERVICES);
  const [logs, setLogs] = useState<LauncherLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const appendLog = useCallback((level: LogLevel, message: string) => {
    setLogs((current) => [
      ...current.slice(-1999),
      { id: ++logId, timestamp: new Date(), level, message },
    ]);
  }, []);

  const refresh = useCallback(async () => {
    const next = await getLauncherSnapshot();
    setSnapshot(next);
    setSettings(next.settings);
    setServices(next.services);
    return next;
  }, []);

  const saveSettings = useCallback(async () => {
    const result = await runLauncherAction<{ settings: RevivalSideSettings }>("save-settings", {
      settings: settingsRef.current,
    });
    setSettings(result.settings);
    settingsRef.current = result.settings;
  }, []);

  const setSetting = useCallback(<K extends keyof RevivalSideSettings>(key: K, value: RevivalSideSettings[K]) => {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      settingsRef.current = next;
      return next;
    });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveSettings().catch((error) => setLastError(errorMessage(error)));
    }, 450);
  }, [saveSettings]);

  const runAction = useCallback(async <T extends object = Record<string, unknown>>(
    action: string,
    payload: Record<string, unknown> = {},
  ) => {
    setBusyAction(action);
    setLastError(null);
    try {
      if (action !== "save-settings" && action !== "snapshot") await saveSettings();
      const result = await runLauncherAction<T>(action, payload);
      await refresh();
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setLastError(message);
      appendLog("error", message);
      throw error;
    } finally {
      setBusyAction(null);
    }
  }, [appendLog, refresh, saveSettings]);

  const startService = useCallback(async (service: ServiceName) => {
    setLastError(null);
    try {
      await saveSettings();
      await startLauncherService(service);
    } catch (error) {
      const message = errorMessage(error);
      setLastError(message);
      appendLog("error", message);
      throw error;
    }
  }, [appendLog, saveSettings]);

  const stopService = useCallback(async (service: ServiceName) => {
    setLastError(null);
    try {
      await stopLauncherService(service);
    } catch (error) {
      const message = errorMessage(error);
      setLastError(message);
      appendLog("error", message);
      throw error;
    }
  }, [appendLog]);

  const resetSettings = useCallback(async () => {
    setSettings(DEFAULT_REVIVALSIDE_SETTINGS);
    settingsRef.current = DEFAULT_REVIVALSIDE_SETTINGS;
    await runLauncherAction("save-settings", { settings: DEFAULT_REVIVALSIDE_SETTINGS });
    await refresh();
  }, [refresh]);

  useEffect(() => {
    let mounted = true;
    const unlisten: Array<() => void> = [];
    Promise.all([
      listen<{ level: LogLevel; message: string }>("launcher-log", (event) => {
        appendLog(event.payload.level, event.payload.message);
      }),
      listen<LauncherServices>("launcher-services", (event) => {
        setServices(event.payload);
        if (event.payload.listener.state === "running") {
          void refresh().catch((error) => appendLog("error", errorMessage(error)));
        }
      }),
      listen<{ service: ServiceName; unexpected: boolean }>("launcher-service-stopped", async (event) => {
        if (!event.payload.unexpected || !settingsRef.current.notifyServiceStops) return;
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) {
          sendNotification({
            title: "RevivalSide service stopped",
            body: `${event.payload.service} stopped unexpectedly. Open the launcher logs for details.`,
          });
        }
      }),
    ]).then((listeners) => {
      if (mounted) unlisten.push(...listeners);
      else listeners.forEach((stop) => stop());
    });
    refresh()
      .catch((error) => {
        setLastError(errorMessage(error));
        appendLog("error", errorMessage(error));
      })
      .finally(() => setLoading(false));
    return () => {
      mounted = false;
      unlisten.forEach((stop) => stop());
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [appendLog, refresh]);

  const value = useMemo<LauncherStateContextValue>(() => ({
    snapshot,
    settings,
    services,
    logs,
    loading,
    busyAction,
    lastError,
    setSetting,
    saveSettings,
    resetSettings,
    refresh,
    runAction,
    startService,
    stopService,
    clearError: () => setLastError(null),
    clearLogs: () => setLogs([]),
  }), [
    snapshot, settings, services, logs, loading, busyAction, lastError, setSetting, saveSettings,
    resetSettings, refresh, runAction, startService, stopService,
  ]);

  return <LauncherStateContext.Provider value={value}>{children}</LauncherStateContext.Provider>;
};

export const useLauncherState = () => {
  const context = useContext(LauncherStateContext);
  if (!context) throw new Error("useLauncherState must be used within LauncherStateProvider");
  return context;
};
