import { createSettingsProvider } from "@/lib/create-settings-provider";
import { settingsSchema } from "@/lib/schema";

export const { Provider: SettingsProvider, useSettings } = createSettingsProvider(settingsSchema, "settings.json");
