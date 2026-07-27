import { LauncherStateProvider } from "@/components/providers/launcher-state-provider";
import { SettingsProvider } from "@/components/providers/settings-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GameProvider } from "@/games/GameProvider";
import type { GameConfig } from "@/games/types";
import type { FC, ReactNode } from "react";

interface ProvidersProps {
  games: GameConfig[];
  children: ReactNode;
}

export const Providers: FC<ProvidersProps> = ({ games, children }) => {
  return (
    <SettingsProvider>
      <GameProvider games={games}>
        <LauncherStateProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </LauncherStateProvider>
      </GameProvider>
    </SettingsProvider>
  );
};
