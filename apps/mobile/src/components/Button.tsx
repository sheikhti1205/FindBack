import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AnimatePresence, motion, type HTMLMotionProps } from "framer-motion";
import { motionDurations, pressFeedback } from "./uiMotion";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "outline" | "text" | "error";
  size?: "md" | "lg";
  loading?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-primary text-on-primary hover:opacity-90 active:opacity-80",
  outline:
    "border border-outline text-on-surface bg-transparent hover:bg-surface-container",
  text: "text-on-surface hover:bg-surface-container",
  error: "bg-error text-on-error hover:opacity-90",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  children,
  disabled,
  // A bare <button> inside a <form> submits it. Default to type="button" so
  // sheet/dialog controls never submit a parent form; pass type="submit"
  // explicitly for real submit actions.
  type = "button",
  ...rest
}: ButtonProps) {
  const sizeCls =
    size === "lg" ? "min-h-[52px] px-6 text-base" : "min-h-[48px] px-5 text-sm";
  return (
    <motion.button
      type={type}
      whileTap={pressFeedback.button}
      transition={{ duration: motionDurations.instant }}
      className={`inline-flex items-center justify-center gap-2 rounded-m3-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${sizeCls} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      // framer-motion retypes onDrag* as pan handlers; the native HTML drag
      // handlers pass straight through to the underlying <button> unchanged.
      {...(rest as unknown as HTMLMotionProps<"button">)}
    >
      <AnimatePresence mode="wait" initial={false}>
        {loading && (
          <motion.span
            key="button-spinner"
            data-testid="button-spinner"
            aria-hidden="true"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: motionDurations.instant }}
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        )}
      </AnimatePresence>
      <motion.span
        key="button-label"
        initial={false}
        animate={{ opacity: loading ? 0.7 : 1 }}
        transition={{ duration: motionDurations.instant }}
        className="inline-flex items-center gap-2"
      >
        {children}
      </motion.span>
    </motion.button>
  );
}
