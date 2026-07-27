import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, FC } from "react";
import { NavLink } from "react-router-dom";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import * as m from "motion/react-m";

export interface SidebarNavItem {
  name: string;
  icon: LucideIcon;
  href: string;
  side?: "top" | "bottom";
  type?: "link" | "folder" | "external";
}

export const Sidebar: FC<ComponentProps<"nav">> = ({ className, children, ...props }) => {
  return (
    <nav className={cn("sticky top-0 z-50 flex w-fit h-screen flex-col items-center gap-4 p-2", className)} {...props}>
      {children}
    </nav>
  );
};

export const SidebarGroup: FC<ComponentProps<"div">> = ({ className, children, ...props }) => {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {children}
    </div>
  );
};

interface SidebarItemProps extends ComponentProps<"div"> {
  item: SidebarNavItem;
  delay?: number;
  asChild?: boolean;
  animate?: boolean;
}

export const SidebarItem: FC<SidebarItemProps> = ({ item, className, delay, animate }) => {
  item = {
    type: "link",
    ...item,
  };

  const Comp: FC<ComponentProps<"div"> & { active?: boolean }> = ({ children, active, className }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Slot.Root
          className={cn(
            "gap-2 size-9 rounded-lg brightness-80 hover:brightness-100 transition-all duration-300 hover:bg-muted inline-flex items-center justify-center box-content p-1",
            active && "brightness-100 bg-muted",
            className,
          )}
        >
          {children}
        </Slot.Root>
      </TooltipTrigger>
      <TooltipContent side="right">{item.name}</TooltipContent>
    </Tooltip>
  );

  const handleClick = async () => {
    try {
      if (item.type === "external") {
        await openUrl(item.href);
      } else {
        await openPath(item.href);
      }
    } catch (err) {
      console.error(`failed to open "${item.href}":`, err);
    }
  };

  const content =
    item.type === "link" ? (
      <NavLink to={item.href} end>
        {({ isActive }) => (
          <Comp active={isActive} className={className}>
            <div>
              <item.icon />
            </div>
          </Comp>
        )}
      </NavLink>
    ) : (
      <Comp>
        <button className={cn(className)} type="button" onClick={handleClick}>
          <item.icon />
        </button>
      </Comp>
    );

  if (!animate) return content;

  return (
    <m.div
      initial={{ opacity: 0, x: -8, scale: 0.85 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -8, scale: 0.85 }}
      transition={{ duration: 0.2, delay, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {content}
    </m.div>
  );
};
