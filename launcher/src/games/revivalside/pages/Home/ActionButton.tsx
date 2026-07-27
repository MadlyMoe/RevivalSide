import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ComponentProps, FC } from "react";

interface ActionButtonProps extends ComponentProps<typeof Button> {
  tooltip?: string;
}

export const ActionButton: FC<ActionButtonProps> = ({ tooltip, className, children, ...props }) => {
  const button = (
    <Button
      className={cn("backdrop-blur-3xl bg-secondary/20", className)}
      variant="secondary"
      size="action-icon-sm"
      {...props}
    >
      {children}
    </Button>
  );

  return (
    <>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </>
  );
};
