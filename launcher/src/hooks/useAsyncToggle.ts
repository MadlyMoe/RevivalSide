import { useState } from "react";

export type ToggleState = "on" | "off" | "starting" | "stopping";

export const useAsyncToggle = (
  onActivate: () => Promise<void>,
  onDeactivate: () => Promise<void>,
  texts: Partial<Record<ToggleState, string>> = {},
) => {
  texts = {
    on: "On",
    off: "Off",
    starting: "Starting...",
    stopping: "Stopping...",
    ...texts,
  };
  const [state, setState] = useState<ToggleState>("off");

  const isLoading = state === "starting" || state === "stopping";
  const isOn = state === "on" || state === "stopping";
  const text = texts[state];

  const toggle = async () => {
    if (isLoading) return;

    if (isOn) {
      setState("stopping");
      await onDeactivate();
      setState("off");
    } else {
      setState("starting");
      await onActivate();
      setState("on");
    }
  };

  return { state, isLoading, isOn, toggle, text };
};
