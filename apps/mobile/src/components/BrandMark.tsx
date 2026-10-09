import type { CSSProperties } from "react";
import { resolveTheme, useTheme } from "../theme";
import brandMarkDark from "../assets/brand/brand-mark-dark.png";
import brandMarkLight from "../assets/brand/brand-mark-light.png";

/**
 * Canonical FindBack brand mark (owner LOGO2, derived from the source
 * asset — never redrawn). `dark` is the black glyph for light surfaces;
 * `light` is the white glyph for dark surfaces; `auto` (default) follows
 * the resolved app theme (documentElement `.dark`/`.amoled`, falling back
 * to the theme preference). The mark itself is monochrome; it carries no
 * UI color opinions.
 */
export type BrandMarkVariant = "dark" | "light" | "auto";

export interface BrandMarkProps {
  size?: number;
  variant?: BrandMarkVariant;
  className?: string;
  style?: CSSProperties;
}

function useAutoVariant(): "dark" | "light" {
  const { theme, trueBlackDark } = useTheme();
  if (typeof document !== "undefined") {
    const classes = document.documentElement.classList;
    if (classes.contains("dark") || classes.contains("amoled")) return "light";
    if (classes.contains("light")) return "dark";
  }
  const osDark = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
  return resolveTheme(theme, osDark, trueBlackDark) === "light" ? "dark" : "light";
}

export function BrandMark({ size = 32, variant = "auto", className, style }: BrandMarkProps) {
  const auto = useAutoVariant();
  const effective = variant === "auto" ? auto : variant;
  return (
    <img
      src={effective === "light" ? brandMarkLight : brandMarkDark}
      width={size}
      height={size}
      alt="FindBack"
      draggable={false}
      className={className}
      style={{ width: size, height: size, objectFit: "contain", ...style }}
    />
  );
}
