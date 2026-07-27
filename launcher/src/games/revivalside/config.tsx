// src/games/revivalside/config.tsx
import { FileTextIcon, HomeIcon, InfoIcon, SaveIcon } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import type { GameConfig } from "@/games/types";
import { getGameAssets } from "@/lib/utils";

const Home = lazy(() => import("./pages/Home").then((m) => ({ default: m.Home })));
const Save = lazy(() => import("./pages/Save").then((m) => ({ default: m.Save })));
const Logs = lazy(() => import("./pages/Logs").then((m) => ({ default: m.Logs })));

export const RevivalSideSettingsProvider = ({ children }: { children: ReactNode }) => children;

export const revivalsideConfig: GameConfig = {
  id: "revivalside",
  name: "RevivalSide",
  description:
    "A world where conflict never ends between Counters and Corrupted Objects after the Administration Failure. We invite you to a journey to save the Reality.",
  assets: getGameAssets("revivalside"),
  SettingsProvider: RevivalSideSettingsProvider,
  sidebarItems: [
    {
      name: "Home",
      icon: HomeIcon,
      href: "",
    },
    {
      name: "Cross Save",
      icon: SaveIcon,
      href: "/save",
    },
    {
      name: "Logs",
      icon: FileTextIcon,
      href: "/logs",
    },
    {
      name: "Help",
      icon: InfoIcon,
      href: "https://discord.gg/9FryPYZSjH",
      type: "external",
      side: "bottom",
    },
  ],
  routes: [
    {
      index: true,
      element: (
        <Suspense>
          <Home />
        </Suspense>
      ),
    },
    {
      path: "save",
      element: (
        <Suspense>
          <Save />
        </Suspense>
      ),
    },
    {
      path: "logs",
      element: (
        <Suspense>
          <Logs />
        </Suspense>
      ),
    },
  ],
};
