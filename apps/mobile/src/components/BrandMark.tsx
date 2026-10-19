import type { CSSProperties } from "react";
import { resolveTheme, useTheme } from "../theme";
import brandMarkDark from "../assets/brand/brand-mark-dark.png";
import brandMarkLight from "../assets/brand/brand-mark-light.png";
import brandTileDark from "../assets/brand/brand-tile-dark.png";
import brandTileLight from "../assets/brand/brand-tile-light.png";

/**
 * Canonical FindBack brand mark (owner LOGO2, derived from the source
 * asset — never redrawn). `dark` is the black glyph for light surfaces;
 * `light` is the white glyph for dark surfaces; `auto` (default) follows
 * the resolved app theme (documentElement `.dark`/`.amoled`, falling back
 * to the theme preference). The mark itself is monochrome; it carries no
 * UI color opinions.
 */
export type BrandMarkVariant = "dark" | "light" | "auto";

/**
 * `glyph` (default) is the bare mark above. `tile` is the owner's app-icon
 * treatment: the same glyph knocked out of a filled squircle, derived from the
 * 2026-10-19 master (`brand-tile-master.png`) by `derive-brand-tile.py`. The
 * master is an opaque render on a white page field, so derivation is
 * unavoidable rather than decorative: the page field is keyed to transparency
 * and the two ink layers swap polarity per theme (a near-black tile is
 * invisible on a near-black surface). Geometry, corner radius and glyph are
 * reused verbatim — nothing is redrawn. `tile` reads smaller than `glyph` at
 * the same nominal size because the knocked-out glyph sits inside the tile.
 */
export type BrandMarkShape = "glyph" | "tile";

export interface BrandMarkProps {
  size?: number;
  variant?: BrandMarkVariant;
  shape?: BrandMarkShape;
  /**
   * Accessible name for the mark. Defaults to "FindBack" for the surfaces where
   * the mark *is* the brand (splash, about). Pass `""` where a visible wordmark
   * already carries the name beside it, so screen readers do not announce it
   * twice — a decorative mark beside its own label.
   */
  alt?: string;
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

export function BrandMark({
  size = 32,
  variant = "auto",
  shape = "glyph",
  alt = "FindBack",
  className,
  style,
}: BrandMarkProps) {
  const auto = useAutoVariant();
  const effective = variant === "auto" ? auto : variant;
  const assets = shape === "tile"
    ? { dark: brandTileDark, light: brandTileLight }
    : { dark: brandMarkDark, light: brandMarkLight };
  return (
    <img
      src={effective === "light" ? assets.light : assets.dark}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      className={className}
      style={{ width: size, height: size, objectFit: "contain", ...style }}
    />
  );
}
