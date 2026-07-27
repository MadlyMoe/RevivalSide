import { useSettings } from "@/components/providers/settings-provider";
import { useLauncherState } from "@/components/providers/launcher-state-provider";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MinusIcon, XIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

export const WindowControls = () => {
  const { settings: appSettings } = useSettings();
  const { settings, services } = useLauncherState();
  const win = getCurrentWindow();
  const [isResiazble, setIsResizable] = useState(false);

  const handleClose = async () => {
    const hasRunningServices = Object.values(services).some((service) => service.state !== "stopped");
    const configured = appSettings.closeWindow === "tray_on_start" ? "exit" : appSettings.closeWindow;
    const behavior = settings.minimizeToTray && hasRunningServices ? "tray" : configured;
    await invoke("close_window", { behavior });
  };

  useEffect(() => {
    const checkResizable = async () => {
      const resizable = await win.isResizable();
      setIsResizable(resizable);
    };

    checkResizable();
  }, [win]);

  return (
    <div data-tauri-drag-region className="fixed top-0 h-8 flex items-center justify-end w-screen z-40">
      <button
        onClick={() => win.minimize()}
        className="w-11 h-full flex items-center justify-center text-foreground not-disabled:hover:bg-foreground/10 disabled:opacity-25 transition-colors"
      >
        <MinusIcon size={14} />
      </button>
      <button
        onClick={async () => win.toggleMaximize()}
        disabled={!isResiazble}
        className="w-11 h-full flex items-center justify-center text-foreground not-disabled:hover:bg-foreground/10 disabled:opacity-25 transition-colors"
      >
        <SquareIcon size={14} />
      </button>
      <button
        onClick={handleClose}
        className="w-11 h-full flex items-center justify-center text-foreground not-disabled:hover:bg-red-600 disabled:opacity-25 transition-colors"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
};
