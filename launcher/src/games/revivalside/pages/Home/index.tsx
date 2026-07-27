import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ArchiveIcon,
  BookOpenIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  MenuIcon,
  PauseIcon,
  PlayIcon,
  RocketIcon,
  SettingsIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react";
import { LogViewer } from "@/components/log-viewer";
import { useEffect, useState } from "react";
import logo from "@/assets/revivalside/logo.webp";
import { ActionButton } from "@/games/revivalside/pages/Home/ActionButton";
import { useLauncherState } from "@/components/providers/launcher-state-provider";
import { GameSettings } from "@/games/revivalside/pages/Home/GameSettings";
import { ask } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

export const Home = () => {
  const {
    snapshot,
    settings,
    services,
    busyAction,
    lastError,
    clearError,
    startService,
    stopService,
    runAction,
  } = useLauncherState();
  const [open, setOpen] = useState(false);
  const [showGameSettings, setShowGameSettings] = useState(false);
  const [openWikiWhenReady, setOpenWikiWhenReady] = useState(false);
  const listener = services.listener;
  const wiki = services.wiki;
  const listenerBusy = listener.state === "starting" || listener.state === "stopping";

  useEffect(() => {
    if (openWikiWhenReady && wiki.state === "running") {
      setOpenWikiWhenReady(false);
      void openUrl(`http://127.0.0.1:${settings.wikiPort}/`);
    }
  }, [openWikiWhenReady, settings.wikiPort, wiki.state]);

  const toggleListener = () => {
    if (listener.state === "running") void stopService("listener");
    else if (listener.state === "stopped") void startService("listener");
  };

  const listenerButton = () => {
    if (listener.state === "running") return { icon: <PauseIcon />, text: "Stop Server" };
    if (listener.state === "starting") return { icon: <Spinner />, text: listener.details || "Starting..." };
    if (listener.state === "stopping") return { icon: <Spinner />, text: "Stopping..." };
    return { icon: <PlayIcon />, text: "Start Game" };
  };

  const openWiki = async () => {
    if (wiki.state === "running") {
      await openUrl(`http://127.0.0.1:${settings.wikiPort}/`);
      return;
    }
    setOpenWikiWhenReady(true);
    try {
      await startService("wiki");
    } catch {
      setOpenWikiWhenReady(false);
    }
  };

  const freezeClient = async () => {
    const source = settings.clientPath || "the detected CounterSide installation";
    const confirmed = await ask(
      `Copy ${source} into RevivalSide's frozen archive? Steam updates will not touch the frozen copy.`,
      { title: "Freeze CounterSide client", kind: "warning" },
    );
    if (confirmed) await runAction("freeze-client");
  };

  const button = listenerButton();
  const routingReady = snapshot?.routing.state === "ready";

  return (
    <>
      <div className="relative flex h-full min-h-0 flex-1 flex-col">
        <img src={logo} className="w-sm" alt="RevivalSide" />
        <div className="absolute bottom-0 left-0 flex w-full max-w-xl flex-col gap-4">
          {lastError && (
            <Card className="max-w-2xl bg-destructive/15 border-destructive/40 backdrop-blur-3xl">
              <CardContent className="flex items-start gap-3 text-sm">
                <span className="flex-1">{lastError}</span>
                <button onClick={clearError} aria-label="Dismiss error"><XIcon className="size-4" /></button>
              </CardContent>
            </Card>
          )}
          <div className="flex w-full flex-col gap-2">
              <div className="flex gap-2">
                <ActionButton
                  tooltip="User Manager"
                  disabled={listener.state !== "running"}
                  onClick={() => openUrl(`http://127.0.0.1:${settings.httpPort}/user-manager`)}
                >
                  <UsersRoundIcon />
                </ActionButton>
                <ActionButton tooltip={wiki.state === "starting" ? "Starting Wiki" : "Wiki"} onClick={openWiki}>
                  {wiki.state === "starting" ? <Spinner /> : <BookOpenIcon />}
                </ActionButton>
                <ActionButton
                  tooltip="Freeze Client"
                  disabled={!settings.clientPath || !!busyAction || listener.state !== "stopped"}
                  onClick={() => void freezeClient()}
                >
                  {busyAction === "freeze-client" ? <Spinner /> : <ArchiveIcon />}
                </ActionButton>
                <ActionButton
                  tooltip="Relaunch Frozen Client"
                  disabled={listener.state !== "running" || !snapshot?.frozenClientRoot || !!busyAction}
                  onClick={() => void runAction("launch-client")}
                >
                  {busyAction === "launch-client" ? <Spinner /> : <RocketIcon />}
                </ActionButton>
              </div>

              <Card className="bg-card/20 backdrop-blur-3xl py-3">
                <CardContent className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-2 rounded-full", routingReady ? "bg-green-500" : "bg-amber-400")} />
                    <span>{snapshot?.routing.message ?? "Checking client routing..."}</span>
                  </div>
                  <div className="text-muted-foreground">
                    Gameplay cache: {snapshot?.gameplay.description ?? "Checking..."}
                  </div>
                  <div className="text-muted-foreground">
                    {listener.state === "starting"
                      ? `Start flow: ${listener.details || "Preparing local services"}`
                      : listener.state === "running"
                        ? listener.details
                        : "Start patches the frozen client, waits for all local services, then launches it automatically."}
                  </div>
                </CardContent>
              </Card>

              <Collapsible open={open} onOpenChange={setOpen}>
                <Card
                  className={cn(
                    "bg-card/20 backdrop-blur-3xl transition-colors hover:bg-foreground/10",
                    open ? "rounded-b-none" : "",
                  )}
                >
                  <CardContent>
                    <CollapsibleTrigger asChild>
                      <button className="w-full uppercase flex items-stretch group">
                        <span className="font-semibold uppercase tracking-widest">Logs</span>
                        <ChevronDownIcon className="ml-auto rotate-0 group-data-[state=open]:rotate-180 transition-transform" />
                      </button>
                    </CollapsibleTrigger>
                  </CardContent>
                </Card>
                <CollapsibleContent className="ring-1 ring-foreground/10 rounded-lg rounded-t-none">
                  <LogViewer
                    className="w-full bg-transparent backdrop-blur-3xl rounded-t-none border-none"
                    bodyClassName="h-[clamp(10rem,28vh,16rem)]!"
                  />
                </CollapsibleContent>
              </Collapsible>
          </div>
        </div>

        <div className="absolute bottom-0 right-0 z-10 flex items-end gap-2">
              <Button
                className="h-14 group border-none gap-4 flex px-7 justify-center items-center rounded-full"
                onClick={toggleListener}
                disabled={listenerBusy}
              >
                <span className="*:size-5! *:fill-primary-foreground *:group-hover:fill-primary *:transition-colors">
                  {button.icon}
                </span>
                <span className="text-lg font-extrabold">{button.text}</span>
              </Button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <ActionButton size="action-icon"><MenuIcon /></ActionButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-fit" side="top" align="end">
                  <DropdownMenuItem
                    disabled={!snapshot}
                    onClick={() => snapshot && openPath(snapshot.frozenClientRoot || snapshot.appRoot)}
                  >
                    <FolderOpenIcon />
                    Browse Local Files
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowGameSettings(true)}>
                    <SettingsIcon />
                    Game Settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
        </div>
      </div>
      <GameSettings open={showGameSettings} onOpenChange={setShowGameSettings} />
    </>
  );
};
