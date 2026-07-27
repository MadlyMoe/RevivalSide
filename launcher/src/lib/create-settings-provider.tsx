import { load, type Store } from "@tauri-apps/plugin-store";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { z, ZodObject, ZodRawShape } from "zod/v4";

interface SettingsContext<TOutput, TInput> {
  settings: TOutput;
  setSetting: <K extends keyof TInput>(key: K, value: TInput[K]) => Promise<void>;
  saveSettings: () => Promise<void>;
  resetSettings: () => Promise<void>;
  loading: boolean;
}

export const createSettingsProvider = <TShape extends ZodRawShape>(schema: ZodObject<TShape>, storeFile: string) => {
  type Settings = z.output<typeof schema>;
  type SettingsInput = z.input<typeof schema>;

  const defaults = schema.parse({}) as Settings;

  const Context = createContext<SettingsContext<Settings, SettingsInput> | null>(null);

  const Provider = ({ children }: { children: ReactNode }) => {
    const [settings, setSettings] = useState<Settings>(defaults);
    const [loading, setLoading] = useState(true);
    const storeRef = useRef<Store | null>(null);

    const getStore = useCallback(async (): Promise<Store> => {
      if (storeRef.current) return storeRef.current;
      const store = await load(storeFile, { defaults, autoSave: true });
      storeRef.current = store;
      return store;
    }, []);

    const setSetting = useCallback(
      async <K extends keyof SettingsInput>(key: K, value: SettingsInput[K]) => {
        const next = schema.parse({ ...settings, [key]: value }) as Settings;
        setSettings(next);
        const store = await getStore();
        await store.set("settings", next);
      },
      [settings, getStore],
    );

    const saveSettings = useCallback(async () => {
      const store = await getStore();
      await store.set("settings", settings);
      await store.save();
    }, [settings, getStore]);

    const resetSettings = useCallback(async () => {
      const store = await getStore();
      await store.reset();
      setSettings(defaults);
    }, [getStore]);

    useEffect(() => {
      getStore().then(async (store) => {
        const saved = await store.get<Settings>("settings");
        if (saved) setSettings(schema.parse(saved) as Settings);
        setLoading(false);
      });
    }, [getStore]);

    return (
      <Context.Provider value={{ settings, setSetting, saveSettings, loading, resetSettings }}>
        {children}
      </Context.Provider>
    );
  };

  const useSettings = () => {
    const ctx = useContext(Context);
    if (!ctx) throw new Error(`useSettings must be used within its Provider (store: ${storeFile})`);
    return ctx;
  };

  return { Provider, useSettings };
};
