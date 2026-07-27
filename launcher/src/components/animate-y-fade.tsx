import { cn } from "@/lib/utils";
import { AnimatePresence, domAnimation, LazyMotion } from "motion/react";
import * as m from "motion/react-m";
import type { ComponentProps, FC, Key } from "react";

interface AnimateYFadeProps extends ComponentProps<typeof m.div> {
  motionKey: Key | null | undefined;
}

export const AnimateYFade: FC<AnimateYFadeProps> = ({ motionKey, className, children, ...props }) => {
  return (
    <LazyMotion features={domAnimation}>
      <AnimatePresence mode="wait">
        <m.div
          key={motionKey}
          initial={{ opacity: 0, y: 40 }}
          animate={{
            opacity: 1,
            y: 0,
            transition: { duration: 0.25, delay: 0.2, ease: [0.25, 0.1, 0.25, 1] },
          }}
          exit={{
            opacity: 0,
            transition: { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] },
          }}
          className={cn(className)}
          {...props}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </LazyMotion>
  );
};
