import { cn } from "@/lib/utils";
import { Loader2Icon } from "lucide-react";

function Spinner({ className, hidden, ...props }: React.ComponentProps<"svg"> & { hidden?: boolean }) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", hidden && "hidden", className)}
      {...props}
    />
  );
}

export { Spinner };
