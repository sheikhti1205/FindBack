import type { CSSProperties, ReactNode } from "react";

/**
 * L-FIXTURE section chrome. Plain route + sections only — no new heavy
 * deps. Each section renders one production surface across a fixed variant
 * list (normal, loading, empty, error, long-content, large-text, dark,
 * AMOLED, small-width 320dp). The frame attributes (`data-fixture-section`,
 * `data-fixture-variant`) are the hooks reviewers and tests use.
 */

export type FixtureVariant =
  | "normal"
  | "loading"
  | "empty"
  | "error"
  | "long-content"
  | "large-text"
  | "dark"
  | "amoled"
  | "small-width";

export const ALL_VARIANTS: FixtureVariant[] = [
  "normal",
  "loading",
  "empty",
  "error",
  "long-content",
  "large-text",
  "dark",
  "amoled",
  "small-width",
];

export const VARIANT_LABELS: Record<FixtureVariant, string> = {
  normal: "Normal",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  "long-content": "Long content",
  "large-text": "Large text",
  dark: "Dark",
  amoled: "AMOLED",
  "small-width": "Small width (320dp)",
};

function frameStyle(variant: FixtureVariant): CSSProperties {
  switch (variant) {
    case "large-text":
      return { fontSize: "125%" };
    case "dark":
      return { backgroundColor: "#1c1b1f", color: "#e6e1e9" };
    case "amoled":
      return { backgroundColor: "#000000", color: "#ffffff" };
    case "small-width":
      return { maxWidth: 320, marginInline: "auto", width: "100%" };
    default:
      return {};
  }
}

export function FixtureFrame({
  section,
  variant,
  children,
}: {
  section: string;
  variant: FixtureVariant;
  children: ReactNode;
}) {
  const dark = variant === "dark" || variant === "amoled";
  return (
    <div
      data-testid={`fixture-${section}-${variant}`}
      data-fixture-section={section}
      data-fixture-variant={variant}
      data-fixture-theme={dark ? variant : "light"}
      style={frameStyle(variant)}
      className="overflow-hidden rounded-m3-md border border-outline-variant"
    >
      <p className="border-b border-outline-variant px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
        {VARIANT_LABELS[variant]}
      </p>
      <div className="p-3">{children}</div>
    </div>
  );
}

export function FixtureSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={`fixture-${id}`}
      aria-label={title}
      data-testid={`fixture-section-${id}`}
      data-fixture-section-root={id}
      className="flex flex-col gap-3 scroll-mt-4"
    >
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-on-surface-variant">{description}</p>
      </div>
      {children}
    </section>
  );
}
