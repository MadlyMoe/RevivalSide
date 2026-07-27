import { useState } from "react";

export type ButtonState = "submitting" | "idle";

export const useAsyncButton = (onActivate: () => Promise<void>, texts: Partial<Record<ButtonState, string>> = {}) => {
  texts = {
    submitting: "Submitting...",
    ...texts,
  };
  const [state, setState] = useState<ButtonState>("idle");

  const isSubmitting = state === "submitting";
  const text = texts[state];

  const activate = async () => {
    if (state === "submitting") return;
    setState("submitting");
    try {
      await onActivate();
    } finally {
      setState("idle");
    }
  };

  return { state, isSubmitting, activate, text };
};
