import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ModelRecord, PriceClass, PriceLine, ProviderId } from "../services/ai/providerContract";
import {
  formatPerMillionTokens,
  isFastRecord,
  isRelayRouted,
  supportsVision,
} from "../services/ai/modelCatalog";
import { listItemVariants, motionDurations, motionEasings, pressFeedback } from "./uiMotion";

export type CatalogFilter =
  | { readonly kind: "all" | "free" | "vision" | "fast" | "offline" }
  | { readonly kind: "provider"; readonly provider: ProviderId };

export type ModelCatalogSheetProps = {
  /** Catalogue rows to list. Empty means none loaded — never rendered as verified. */
  readonly models: readonly ModelRecord[];
  /** Source timestamp of the list, when known. */
  readonly retrievedAt?: string | null;
  /** True when the list is older than the freshness budget (browse-only). */
  readonly stale?: boolean;
  readonly selectedId?: string | null;
  readonly onSelect?: (modelId: string) => void;
  /** Controlled filter; uncontrolled (internal state) when omitted. */
  readonly activeFilter?: CatalogFilter;
  readonly onFilterChange?: (filter: CatalogFilter) => void;
  /**
   * True once the on-device adapter is wired (native bridge landed).
   * False keeps the Offline view honest: no offline row is ever shown as
   * ready, and the status line says so.
   */
  readonly offlineAvailable?: boolean;
  /** Honest offline readiness copy (e.g. from the registry seam); overrides the default line. */
  readonly offlineDetail?: string | null;
};

const BADGE_COPY: Record<PriceClass, string> = {
  free: "Free",
  paid: "Paid",
  unknown: "Unknown price",
  variable: "Variable price",
};

export function priceLineCopy(line: PriceLine): string {
  if (line.unit === "token") {
    const perMillion = formatPerMillionTokens(line.amountDecimal);
    if (perMillion !== null) return `$${perMillion} USD per 1M ${line.dimension} tokens`;
  }
  if (line.unit === "request") return `$${line.amountDecimal} USD per ${line.dimension}`;
  if (line.unit === "image") return `$${line.amountDecimal} USD per ${line.dimension} image`;
  return `$${line.amountDecimal} USD / ${line.unit} (${line.dimension})`;
}

export function matchesCatalogFilter(model: ModelRecord, filter: CatalogFilter): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "free":
      return model.priceClass === "free";
    case "vision":
      return supportsVision(model);
    case "fast":
      return isFastRecord(model);
    case "offline":
      return model.provider === "offline";
    case "provider":
      return model.provider === filter.provider;
  }
}

export function ModelCatalogSheet({
  models,
  retrievedAt,
  stale = false,
  selectedId,
  onSelect,
  activeFilter,
  onFilterChange,
  offlineAvailable = false,
  offlineDetail = null,
}: ModelCatalogSheetProps) {
  const [internalFilter, setInternalFilter] = useState<CatalogFilter>({ kind: "all" });
  const filter = activeFilter ?? internalFilter;
  const providers = useMemo(() => {
    const seen = new Set<ProviderId>();
    for (const model of models) seen.add(model.provider);
    return [...seen].sort();
  }, [models]);
  const visible = useMemo(() => models.filter((model) => matchesCatalogFilter(model, filter)), [models, filter]);
  function choose(next: CatalogFilter) {
    if (onFilterChange) onFilterChange(next);
    else setInternalFilter(next);
  }
  const offlineStatus =
    offlineDetail ?? (offlineAvailable ? "No offline models are ready yet." : "Offline AI is not available in this build.");
  return (
    <section aria-label="Model catalogue" className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Models</h2>
        {models.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No models loaded.</p>
        ) : (
          <p className="text-sm text-on-surface-variant">
            {models.length} {models.length === 1 ? "model" : "models"}
            {retrievedAt ? ` · listed ${retrievedAt}` : ""}
            {stale ? " · list may be out of date" : ""} · availability depends on your connected accounts.
          </p>
        )}
      </header>
      {models.length > 0 ? (
        <div role="group" aria-label="Filter models" className="flex flex-wrap gap-2">
          {(
            [
              { kind: "all", label: "All" },
              { kind: "free", label: "Free" },
              { kind: "vision", label: "Vision" },
              { kind: "fast", label: "Fast" },
              { kind: "offline", label: "Offline" },
            ] as const
          ).map((chip) => (
            <button
              key={chip.kind}
              type="button"
              aria-pressed={filter.kind === chip.kind}
              title={chip.kind === "fast" ? "Rough heuristic, not measured speed." : undefined}
              onClick={() => choose({ kind: chip.kind })}
              className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
            >
              {chip.label}
            </button>
          ))}
          {providers.map((provider) => (
            <button
              key={provider}
              type="button"
              aria-pressed={filter.kind === "provider" && filter.provider === provider}
              onClick={() => choose({ kind: "provider", provider })}
              className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
            >
              {provider}
            </button>
          ))}
        </div>
      ) : null}
      {filter.kind === "offline" ? (
        <p data-testid="offline-status" role="status" className="text-xs text-on-surface-variant">
          {offlineStatus}
        </p>
      ) : null}
      {models.length > 0 && visible.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No models match this filter.</p>
      ) : null}
      {visible.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {/* Filtering the catalogue is a list edit: rows rise in, filtered-out
              rows leave, and the rest re-flow on Motion `layout` instead of
              jumping. */}
          <AnimatePresence initial={false}>
          {visible.map((model) => {
            const selected = selectedId === model.id;
            return (
              <motion.li
                key={`${model.provider}/${model.id}`}
                layout
                variants={listItemVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
                className="flex flex-col gap-1 rounded-m3-sm border border-outline bg-surface px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{model.id}</span>
                  <span className="shrink-0 text-xs font-semibold" aria-label={`Price: ${BADGE_COPY[model.priceClass]}`}>
                    {BADGE_COPY[model.priceClass]}
                  </span>
                </div>
                <p className="text-xs text-on-surface-variant">
                  {model.provider}
                  {isRelayRouted(model) ? " · via relay, never direct" : ""}
                  {" · "}
                  {model.contextTokens !== undefined ? `Up to ${model.contextTokens} context tokens` : "Context window unknown"}
                  {" · "}
                  {supportsVision(model) ? "Accepts images" : "Text only"}
                  {model.entitlement === "blocked"
                    ? " · Not usable on this account"
                    : model.entitlement === "verified"
                      ? " · Verified on this account"
                      : " · Not yet tested on this account"}
                </p>
                {model.prices.length > 0 ? (
                  <ul className="flex flex-col gap-0.5">
                    {model.prices.map((line) => (
                      <li key={`${line.dimension}-${line.sourceField}`} className="text-xs text-on-surface-variant">
                        {priceLineCopy(line)}
                        {line.conditions ? ` (${line.conditions})` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-on-surface-variant">Price unknown.</p>
                )}
                {onSelect ? (
                  <motion.button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(model.id)}
                    whileTap={pressFeedback.button}
                    transition={{ duration: motionDurations.instant }}
                    className="mt-1 min-h-[48px] rounded-m3-sm border border-outline px-3 text-sm font-medium"
                  >
                    {selected ? "Selected" : "Select"}
                  </motion.button>
                ) : null}
              </motion.li>
            );
          })}
          </AnimatePresence>
        </ul>
      ) : null}
    </section>
  );
}
