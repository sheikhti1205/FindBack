import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "outline" | "text" | "error";
  size?: "md" | "lg";
  loading?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-on-surface text-surface hover:opacity-90 active:opacity-80",
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
  ...rest
}: ButtonProps) {
  const sizeCls =
    size === "lg" ? "min-h-[52px] px-6 text-base" : "min-h-[48px] px-5 text-sm";
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-m3-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${sizeCls} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
