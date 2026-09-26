import type { ModelRecord, PriceClass, PriceLine } from "../services/ai/providerContract";
import { formatPerMillionTokens, supportsVision } from "../services/ai/modelCatalog";

export type ModelCatalogSheetProps = {
  /** Catalogue rows to list. Empty means none loaded — never rendered as verified. */
  readonly models: readonly ModelRecord[];
  /** Source timestamp of the list, when known. */
  readonly retrievedAt?: string | null;
  /** True when the list is older than the freshness budget (browse-only). */
  readonly stale?: boolean;
  readonly selectedId?: string | null;
  readonly onSelect?: (modelId: string) => void;
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

export function ModelCatalogSheet({
  models,
  retrievedAt,
  stale = false,
  selectedId,
  onSelect,
}: ModelCatalogSheetProps) {
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
            {stale ? " · list may be out of date" : ""} · availability depends on your OpenRouter
            account.
          </p>
        )}
      </header>
      {models.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {models.map((model) => {
            const selected = selectedId === model.id;
            return (
              <li
                key={model.id}
                className="flex flex-col gap-1 rounded-m3-sm border border-outline bg-surface px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{model.id}</span>
                  <span className="shrink-0 text-xs font-semibold" aria-label={`Price: ${BADGE_COPY[model.priceClass]}`}>
                    {BADGE_COPY[model.priceClass]}
                  </span>
                </div>
                <p className="text-xs text-on-surface-variant">
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
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(model.id)}
                    className="mt-1 min-h-[48px] rounded-m3-sm border border-outline px-3 text-sm font-medium"
                  >
                    {selected ? "Selected" : "Select"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
