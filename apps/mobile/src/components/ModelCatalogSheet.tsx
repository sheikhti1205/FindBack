import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router";
import type { ModelRecord, PriceClass, PriceLine, ProviderId } from "../services/ai/providerContract";
import {
  formatPerMillionTokens,
  isFastRecord,
  supportsVision,
} from "../services/ai/modelCatalog";
import { displayNameForCatalogRecord, rolesForCatalogRecord, type UiModelRole } from "../services/ai/uiModelRoles";
import { getApplicationAi } from "../services/ai/applicationAi";
import { listItemVariants, motionDurations, motionEasings, pressFeedback } from "./uiMotion";

export type CatalogFilter =
  | { readonly kind: "all" | "free" | "vision" | "fast" | "offline" }
  | { readonly kind: "provider"; readonly provider: ProviderId };

/** Consumer capability filter for the settings library. "all" disables it. */
export type CatalogRoleFilter = UiModelRole | "all";

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
   * Presentation variant. "library" is the settings model library (price +
   * capability filters, full rows). "assistant" is the send-time picker:
   * Automatic first, Chat/Vision sections, conversational rows only, and a
   * Manage AI models link. Callers filter rows; the assistant variant never
   * lists tools/embeddings/speech rows it is given.
   */
  readonly variant?: "library" | "assistant";
  /** Assistant variant: selecting Automatic (selectedId null). */
  readonly onSelectAutomatic?: () => void;
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

/** Library capability predicate: "all" passes everything; otherwise the row must carry the role. */
export function matchesRoleFilter(model: ModelRecord, role: CatalogRoleFilter): boolean {
  if (role === "all") return true;
  return rolesForCatalogRecord(model).includes(role);
}

/**
 * A row is recommended when it is free to use — either the provider declared it
 * free or its consumer name/id says so. Owner preference: free models surface
 * first in every list as recommendations, but paid models stay user-selectable.
 */
export function isRecommendedFree(model: ModelRecord): boolean {
  if (model.priceClass === "free") return true;
  return /\bfree\b/i.test(`${model.displayName ?? ""} ${model.id}`);
}

/** Stable free-first ordering; paid/unknown rows keep their incoming order. */
function recommendedFirst(rows: readonly ModelRecord[]): ModelRecord[] {
  return [...rows].sort((a, b) => Number(isRecommendedFree(b)) - Number(isRecommendedFree(a)));
}

const ROLE_CHIPS: readonly { readonly role: CatalogRoleFilter; readonly label: string }[] = [
  { role: "all", label: "All roles" },
  { role: "chat", label: "Chat" },
  { role: "vision", label: "Vision" },
  { role: "tools", label: "Tools" },
  { role: "embeddings", label: "Embeddings" },
  { role: "stt", label: "Speech to text" },
  { role: "tts", label: "Text to speech" },
];

export function ModelCatalogSheet({
  models,
  retrievedAt,
  stale = false,
  selectedId,
  onSelect,
  activeFilter,
  onFilterChange,
  variant = "library",
  onSelectAutomatic,
  offlineAvailable = false,
  offlineDetail = null,
}: ModelCatalogSheetProps) {
  const [internalFilter, setInternalFilter] = useState<CatalogFilter>({ kind: "all" });
  const [internalRole, setInternalRole] = useState<CatalogRoleFilter>("all");
  const filter = activeFilter ?? internalFilter;
  const providers = useMemo(() => {
    const seen = new Set<ProviderId>();
    for (const model of models) seen.add(model.provider);
    return [...seen].sort();
  }, [models]);
  const visible = useMemo(
    () => recommendedFirst(models.filter((model) => matchesCatalogFilter(model, filter) && matchesRoleFilter(model, internalRole))),
    [models, filter, internalRole],
  );
  function choose(next: CatalogFilter) {
    if (onFilterChange) onFilterChange(next);
    else setInternalFilter(next);
  }
  const offlineStatus =
    offlineDetail ?? (offlineAvailable ? "No offline models are ready yet." : "On-device AI requires the Android app.");
  if (variant === "assistant") {
    return (
      <AssistantPickerSections
        models={models}
        selectedId={selectedId}
        onSelect={onSelect}
        onSelectAutomatic={onSelectAutomatic}
        retrievedAt={retrievedAt}
        stale={stale}
      />
    );
  }
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
      {models.length > 0 ? (
        <div role="group" aria-label="Filter by capability" className="flex flex-wrap gap-2">
          {ROLE_CHIPS.map((chip) => (
            <button
              key={chip.role}
              type="button"
              aria-pressed={internalRole === chip.role}
              aria-label={`Capability: ${chip.label}`}
              onClick={() => setInternalRole(chip.role)}
              className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
            >
              {chip.label}
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
        <ul className="flex flex-col">
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
                className="flex flex-col gap-1 border-t border-outline-variant py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{displayNameForCatalogRecord(model)}</span>
                  <span className="shrink-0 text-xs font-semibold" aria-label={`Price: ${BADGE_COPY[model.priceClass]}`}>
                    {BADGE_COPY[model.priceClass]}
                  </span>
                </div>
                <p className="text-xs text-on-surface-variant">
                  {rolesForCatalogRecord(model).map((role) => ROLE_CHIPS.find((chip) => chip.role === role)?.label).join(" · ") || "Capabilities not qualified"}
                </p>
                <ModelTechnicalDetails model={model} />
                <p className="text-xs text-on-surface-variant">
                  {model.provider}
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

/** Locality badge copy: installed engines read Local, provider rows read Cloud. */
function localityFor(model: ModelRecord): string {
  return model.provider === "offline" ? "Local" : "Cloud";
}

/**
 * Consumer provider label for the assistant picker (FBX-020): the provider is
 * secondary metadata under the model title — never a flat row of its own.
 * Engine ids and connection kinds never stand in for a model name here.
 */
export function assistantProviderLabel(provider: ProviderId): string {
  switch (provider) {
    case "offline": return "On-device";
    case "openrouter": return "OpenRouter";
    case "openai": return "OpenAI";
    case "anthropic": return "Anthropic";
    case "google": return "Google";
    case "deepseek": return "DeepSeek";
    case "mistral": return "Mistral";
    case "groq": return "Groq";
    case "xai": return "xAI";
    case "cohere": return "Cohere";
    case "generic": return "Custom endpoint";
  }
}

/**
 * Assistant picker row title (FBX-020, UI text only): cloud rows keep the
 * curated consumer name; on-device rows show the registry consumer title
 * (e.g. "Photo analysis") — a raw engine id is never a row title.
 */
export function assistantRowTitle(model: ModelRecord): string {
  if (model.provider === "offline") {
    try {
      const descriptor = getApplicationAi().registry.descriptorFor(model.id);
      const title = descriptor?.consumerTitle.trim() ?? "";
      if (title !== "") return title;
    } catch {
      // Registry unavailable: fall through to the honest generic title.
    }
    return "On-device model";
  }
  return displayNameForCatalogRecord(model);
}

/**
 * Assistant send-time picker (U3): Automatic first, then Chat and Vision
 * sections with conversational rows only. A cross-listed row (Chat + Vision)
 * appears in both sections with a combined badge. Tool/embedding/speech rows
 * are never rendered here even when passed in — they belong to the settings
 * library, not the conversation.
 */
function AssistantPickerSections({
  models,
  selectedId,
  onSelect,
  onSelectAutomatic,
  retrievedAt,
  stale,
}: {
  models: readonly ModelRecord[];
  selectedId?: string | null;
  onSelect?: (modelId: string) => void;
  onSelectAutomatic?: () => void;
  retrievedAt?: string | null;
  stale?: boolean;
}) {
  const conversational = models.filter((model) => rolesForCatalogRecord(model).some((role) => role === "chat" || role === "vision"));
  const chatRows = recommendedFirst(conversational.filter((model) => rolesForCatalogRecord(model).includes("chat")));
  const visionRows = recommendedFirst(conversational.filter((model) => rolesForCatalogRecord(model).includes("vision")));
  const automaticSelected = selectedId === null || selectedId === undefined;
  function rowBadge(model: ModelRecord): { locality: string; provider: string } {
    const roles = rolesForCatalogRecord(model);
    const both = roles.includes("chat") && roles.includes("vision");
    // Models lead; the provider is secondary metadata ("via X").
    return {
      locality: `${localityFor(model)}${both ? " · Chat + Vision" : ""}`,
      provider: `via ${assistantProviderLabel(model.provider)}`,
    };
  }
  function renderRow(model: ModelRecord) {
    const selected = selectedId === model.id;
    const badge = rowBadge(model);
    return (
      <motion.li
        key={`${model.provider}/${model.id}`}
        layout
        variants={listItemVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
        className="flex flex-col gap-1 border-t border-outline-variant py-2"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{assistantRowTitle(model)}</span>
          <span className="shrink-0 text-xs text-on-surface-variant">
            {isRecommendedFree(model) ? (
              <span data-testid="model-recommended" className="mr-1 rounded-full bg-surface-container-high px-2 py-0.5 font-medium">
                Recommended
              </span>
            ) : null}
            <span data-testid={`model-provider-${model.provider}`}>
              <span>{badge.locality}</span>
              {" · "}
              <span>{badge.provider}</span>
            </span>
          </span>
        </div>
        <ModelTechnicalDetails model={model} />
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
  }
  return (
    <section aria-label="Choose model" className="flex flex-col gap-3">
      <button
        type="button"
        data-testid="model-pick-automatic"
        aria-pressed={automaticSelected}
        onClick={() => onSelectAutomatic?.()}
        className="flex min-h-[48px] flex-col justify-center gap-0.5 rounded-m3-sm border border-outline bg-surface px-3 text-left"
      >
        <span className="text-sm font-medium">{automaticSelected ? "● Automatic" : "○ Automatic"}</span>
        <span className="text-xs text-on-surface-variant">Picks the best compatible model for this message</span>
      </button>
      {chatRows.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Chat</h3>
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>{chatRows.map(renderRow)}</AnimatePresence>
          </ul>
        </div>
      ) : null}
      {visionRows.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Vision</h3>
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>{visionRows.map(renderRow)}</AnimatePresence>
          </ul>
        </div>
      ) : null}
      {conversational.length === 0 ? (
        <p className="text-sm text-on-surface-variant">
          No conversational models loaded{retrievedAt ? ` · listed ${retrievedAt}` : ""}{stale ? " · list may be out of date" : ""}.
          Tool engines run automatically in the background.
        </p>
      ) : null}
      <Link
        to="/settings/ai/models"
        data-testid="model-manage-link"
        className="flex min-h-[48px] items-center justify-center rounded-m3-sm border border-outline-variant px-3 text-sm font-medium"
      >
        Manage AI models
      </Link>
    </section>
  );
}

function ModelTechnicalDetails({ model }: { readonly model: ModelRecord }) {
  return (
    <details className="text-xs text-on-surface-variant">
      <summary className="min-h-[48px] cursor-pointer py-3">Technical details</summary>
      <p className="break-all"><span className="font-medium">Model ID: </span><code>{model.id}</code></p>
    </details>
  );
}
