import { Sidebar, SidebarGroup, SidebarItem, type SidebarNavItem } from "@/components/sidebar";
import { NavLink, useLocation, useOutlet } from "react-router-dom";
import { Fragment, useEffect, useState } from "react";
import { cn, getRandomItem } from "@/lib/utils";
import { WindowControls } from "@/components/window-controls";
import { Separator } from "@/components/ui/separator";
import { LayoutGridIcon, SettingsIcon } from "lucide-react";
import { useGame } from "@/games/GameProvider";
import { AnimateYFade } from "@/components/animate-y-fade";
import * as m from "motion/react-m";
import { AnimatePresence, domAnimation, LazyMotion } from "motion/react";

const defaultItems: SidebarNavItem[] = [
  {
    name: "Settings",
    icon: SettingsIcon,
    href: "/settings",
    side: "bottom",
  },
];

export const Layout = () => {
  const outlet = useOutlet();
  const location = useLocation();
  const { activeGame, hoveredGame } = useGame();

  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [prevBgUrl, setPrevBgUrl] = useState<string | null>(null);
  const [fading, setFading] = useState(false);

  const isHome = (activeGame && location.pathname === `/${activeGame.id}`) || location.pathname === "/";
  const GameSettingsProvider = activeGame?.SettingsProvider ?? Fragment;

  const items: SidebarNavItem[] = [
    ...(activeGame?.sidebarItems
      ? activeGame.sidebarItems.map((item) => ({ ...item, href: `/${activeGame.id}${item.href}` }))
      : []),
    ...defaultItems,
  ];

  const handleNewBgLoaded = () => {
    requestAnimationFrame(() => {
      setFading(false);
      setTimeout(() => setPrevBgUrl(null), 600);
    });
  };

  useEffect(() => {
    const game = activeGame ?? hoveredGame;
    if (!game) return;

    const next =
      game.assets?.featuredBackground ?? (game.assets?.backgrounds ? getRandomItem(game.assets.backgrounds) : null);

    if (!next || next === bgUrl) return;

    setPrevBgUrl(bgUrl);
    setFading(true);
    setBgUrl(next);
  }, [activeGame, hoveredGame]);

  return (
    <>
      <WindowControls />
      <div className="select-none relative w-screen h-full flex">
        <div className="fixed -z-50 h-screen w-full bg-muted">
          {prevBgUrl && (
            <img
              src={prevBgUrl}
              className={cn(
                "absolute inset-0 w-full h-full object-cover transition-opacity duration-500",
                fading ? "opacity-100" : "opacity-0",
              )}
            />
          )}
          {bgUrl && (
            <img
              key={bgUrl}
              src={bgUrl}
              onLoad={handleNewBgLoaded}
              className={cn(
                "absolute inset-0 w-full h-full object-cover transition-opacity duration-500",
                fading ? "opacity-0" : "opacity-100",
              )}
            />
          )}
        </div>
        <div className="fixed -z-40 h-full w-full bg-background/60" />
        <LazyMotion features={domAnimation}>
          <Sidebar className="backdrop-blur-3xl">
            <NavLink to="/">
              <AnimatePresence mode="wait">
                <m.div
                  key={activeGame?.id}
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                >
                  {activeGame?.assets?.favicon ? (
                    <img src={activeGame.assets.favicon} className="size-8" />
                  ) : (
                    <LayoutGridIcon className="size-8" />
                  )}
                </m.div>
              </AnimatePresence>
            </NavLink>
            <Separator />
            <SidebarGroup>
              <AnimatePresence>
                {items
                  .filter((item) => item.side === "top" || !item.side)
                  .map((item, index) => (
                    <SidebarItem key={index} item={item} delay={index * 0.05} />
                  ))}
              </AnimatePresence>
            </SidebarGroup>
            <SidebarGroup className="mt-auto">
              <AnimatePresence>
                {items
                  .filter((item) => item.side === "bottom")
                  .map((item, index) => (
                    <SidebarItem key={index} item={item} />
                  ))}
              </AnimatePresence>
            </SidebarGroup>
          </Sidebar>
        </LazyMotion>
        <div
          className={cn(
            "flex-1 transition-[backdrop-filter] p-14  duration-300 h-screen overflow-hidden",
            !isHome && "backdrop-blur-3xl overflow-y-scroll",
          )}
        >
          <AnimateYFade motionKey={location.key} className={cn("w-full h-full opacity-0", !isHome && "max-w-xl")}>
            {activeGame ? <GameSettingsProvider>{outlet}</GameSettingsProvider> : outlet}
          </AnimateYFade>
        </div>
      </div>
    </>
  );
};
