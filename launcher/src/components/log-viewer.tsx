import { useEffect, useRef, useState, type FC, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { cva } from "class-variance-authority";
import { Button } from "@/components/ui/button";
import { useLauncherState } from "@/components/providers/launcher-state-provider";

const loggingLevels = cva("", {
  variants: {
    level: {
      info: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
      warn: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
      error: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
      debug: "bg-muted text-muted-foreground border border-border",
    },
  },
});

interface LogViewerProps extends ComponentProps<"div"> {
  bodyClassName?: string;
}

export const LogViewer: FC<LogViewerProps> = ({ className, bodyClassName, ...props }) => {
  const { logs, clearLogs } = useLauncherState();
  const [paused, setPaused] = useState(false);
  const [pausedLines, setPausedLines] = useState(logs);
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lines = paused ? pausedLines : logs;

  const onScroll = () => {
    const current = bodyRef.current;
    if (!current) return;
    atBottomRef.current = current.scrollHeight - current.scrollTop - current.clientHeight < 8;
  };

  useEffect(() => {
    if (atBottomRef.current) {
      const current = bodyRef.current;
      if (current) current.scrollTop = current.scrollHeight;
    }
  }, [lines]);

  const togglePaused = () => {
    if (!paused) setPausedLines(logs);
    setPaused((current) => !current);
  };

  return (
    <div
      className={cn("font-mono text-[10px] rounded-lg border border-border overflow-hidden bg-muted/40", className)}
      {...props}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="size-2 flex items-center justify-center relative">
          <span
            className={cn(
              "absolute h-full w-full rounded-full opacity-75",
              paused ? "bg-amber-400" : "bg-green-500 animate-ping",
            )}
          />
          <span className={cn("w-full h-full rounded-full", paused ? "bg-amber-500" : "bg-green-600")} />
        </span>
        <span className="text-muted-foreground">{paused ? "Paused" : "Live"}</span>
        <div className="flex-1" />
        <Button variant="outline" size="xs" onClick={togglePaused}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="outline" size="xs" onClick={clearLogs}>
          Clear
        </Button>
      </div>
      <div
        ref={bodyRef}
        onScroll={onScroll}
        className={cn("h-64 overflow-y-auto p-2.5 space-y-0.5", bodyClassName)}
      >
        {lines.length === 0 && <div className="text-muted-foreground p-2">Service output will appear here.</div>}
        {lines.map((line) => (
          <div key={line.id} className="flex gap-2 hover:bg-foreground/10 rounded px-1 py-px">
            <span className="text-muted-foreground/60 shrink-0 tabular-nums select-none">
              {line.timestamp.toISOString().replace("T", " ").slice(0, 19)}
            </span>
            <span
              className={cn(
                "shrink-0 px-1 rounded text-[10px] font-medium self-start mt-px uppercase",
                loggingLevels({ level: line.level }),
              )}
            >
              {line.level}
            </span>
            <span className="text-foreground break-all whitespace-pre-wrap flex-1">{line.message}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-3 py-1.5 border-t">
        <span className="text-muted-foreground">{lines.length} lines</span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
          }}
        >
          Jump to bottom
        </Button>
      </div>
    </div>
  );
};
