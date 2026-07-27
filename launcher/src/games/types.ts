import type { SidebarNavItem } from "@/components/sidebar";
import type { ComponentType, ReactNode } from "react";
import type { RouteObject } from "react-router-dom";

export type GameAssets<T = unknown> = {
  backgrounds: string[];
  mainBackground: string;
  featuredBackground?: string;
  favicon: string;
  logo: string;
} & T;

export interface GameConfig {
  id: string;
  name: string;
  description?: ReactNode;
  assets?: GameAssets;
  sidebarItems: SidebarNavItem[];
  routes: RouteObject[];
  SettingsProvider: ComponentType<{ children: ReactNode }>;
}
