/**
 * Pure model-selection policy.
 *
 * - Default selection is `openrouter/free`; default mode is `free-only`.
 * - In `free-only` mode a paid/unknown-priced (or blocked) model is never silently
 *   selected or fallen back to: `unknown ≠ free`, and failures return an explicit
 *   error with the safe default selection attached (caller must NOT send).
 * - Paid selection requires `mode: 'paid-explicit'` plus a matching `PaidConsent`
 *   (provider + model + price fingerprint + task scope) checked through the frozen
 *   `isSelectionAuthorized`. A changed fee (fingerprint) or model invalidates consent.
 *   `unknown` priceClass is never consentable — consent to an unknown price is void.
 * - Account switching never inherits another account's selection/consent: it returns
 *   a fresh default for the new account.
 */
import {
  isSelectionAuthorized,
  type AiSelection,
  type ModelRecord,
  type PaidConsent,
  type ProviderId,
  type TaskScope,
} from "./providerContract";

export const DEFAULT_MODEL_ID = "openrouter/free" as const;
export const DEFAULT_PROVIDER = "openrouter" as const;

export type PolicyErrorCode =
  | "unknown-model"
  | "blocked-model"
  | "consent-required"
  | "consent-invalid";

export type PolicyResolveResult =
  | { readonly ok: true; readonly selection: AiSelection; readonly record: ModelRecord }
  | { readonly ok: false; readonly error: PolicyErrorCode; readonly selection: AiSelection };

export type AuthorizePaidInput = {
  readonly accountId: string;
  readonly record: ModelRecord;
  readonly fingerprint: string;
  readonly taskScopes: readonly TaskScope[];
  readonly acceptedAt: string;
};

export type ResolveSelectionInput = {
  readonly accountId: string;
  readonly catalog: readonly ModelRecord[];
  readonly task: TaskScope;
  readonly desiredModelId?: string;
  readonly mode?: AiSelection["mode"];
  readonly paidConsent?: PaidConsent;
  readonly fingerprintOf: (record: ModelRecord) => string;
};

/** Fresh default selection for an account: free-only on the free route, no consent. */
export function defaultSelection(accountId: string): AiSelection {
  return {
    accountId,
    provider: DEFAULT_PROVIDER,
    modelId: DEFAULT_MODEL_ID,
    mode: "free-only",
  };
}

/**
 * Account switch: always a fresh default for the new account. The previous
 * selection/consent is dropped unconditionally — consent never crosses accounts.
 * The catalog is accepted for signature symmetry with resolve paths; selection
 * itself carries no record data.
 */
export function switchAccountSelection(
  accountId: string,
  _catalog: readonly ModelRecord[],
): AiSelection {
  return defaultSelection(accountId);
}

/** Build a paid-explicit selection carrying per-task consent for one model/fee state. */
export function authorizePaidSelection(input: AuthorizePaidInput): AiSelection {
  return {
    accountId: input.accountId,
    provider: input.record.provider,
    modelId: input.record.id,
    mode: "paid-explicit",
    paidConsent: {
      provider: input.record.provider,
      modelId: input.record.id,
      fingerprint: input.fingerprint,
      taskScopes: [...input.taskScopes],
      acceptedAt: input.acceptedAt,
    },
  };
}

function findRecord(catalog: readonly ModelRecord[], modelId: string): ModelRecord | undefined {
  return catalog.find((record) => record.id === modelId);
}

export function resolveSelection(input: ResolveSelectionInput): PolicyResolveResult {
  const fallback = defaultSelection(input.accountId);
  const desiredId = input.desiredModelId ?? DEFAULT_MODEL_ID;
  const record = findRecord(input.catalog, desiredId);
  if (record === undefined) return { ok: false, error: "unknown-model", selection: fallback };
  if (record.entitlement === "blocked") return { ok: false, error: "blocked-model", selection: fallback };

  if (record.priceClass === "free") {
    return {
      ok: true,
      selection: {
        accountId: input.accountId,
        provider: record.provider,
        modelId: record.id,
        mode: input.mode ?? "free-only",
        ...(input.mode === "paid-explicit" && input.paidConsent !== undefined
          ? { paidConsent: input.paidConsent }
          : {}),
      },
      record,
    };
  }

  // Non-free: unknown prices are never consentable; paid/variable need consent.
  if (record.priceClass === "unknown") return { ok: false, error: "consent-invalid", selection: fallback };
  if (input.mode !== "paid-explicit" || input.paidConsent === undefined) {
    return { ok: false, error: "consent-required", selection: fallback };
  }
  const selection: AiSelection = {
    accountId: input.accountId,
    provider: record.provider,
    modelId: record.id,
    mode: "paid-explicit",
    paidConsent: input.paidConsent,
  };
  const authorized = isSelectionAuthorized(selection, record, input.fingerprintOf(record), input.task);
  if (!authorized) return { ok: false, error: "consent-invalid", selection: fallback };
  return { ok: true, selection, record };
}

/**
 * Model-level fallback router (G11 companion to the coordinator's
 * same-adapter bounded retries — the coordinator itself is NEVER given a
 * second adapter; this router picks ONE alternative selection and the caller
 * starts a fresh, rebudgeted send for it).
 *
 * Hard gates (any violation ⇒ no fallback, explicit reason, caller keeps
 * working with the current model):
 * - free-only mode never transitions into paid/variable, and unknown prices
 *   are never consentable in any mode;
 * - with approved photos, only same-provider vision-capable candidates qualify
 *   (no silent cross-provider photo routing, never a vision→text downgrade);
 * - blocked-entitlement and credential-less providers are skipped;
 * - paid candidates require the caller's consent to authorize for the task.
 *
 * The router moves SELECTION ONLY: it carries no text, deltas, or partial
 * output. An interrupted partial stream is marked incomplete by the caller
 * and never spliced into the next attempt's context.
 */
export type FallbackPlanInput = {
  readonly accountId: string;
  readonly catalog: readonly ModelRecord[];
  readonly task: TaskScope;
  readonly currentModelId: string;
  readonly approvedImageIds: readonly string[];
  readonly mode: AiSelection["mode"];
  readonly paidConsent?: PaidConsent;
  readonly fingerprintOf: (record: ModelRecord) => string;
  readonly hasCredential: (provider: ProviderId) => boolean;
  readonly excludeModelIds?: readonly string[];
  /**
   * Offline rows are skipped unless this is explicitly true AND the caller
   * reports an offline credential. The offline adapter stays unwired until
   * the native bridge lands, so the default (false) never routes there.
   */
  readonly allowOffline?: boolean;
};

export type FallbackPlanResult =
  | {
      readonly ok: true;
      readonly selection: AiSelection;
      readonly record: ModelRecord;
      readonly sameProvider: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "no-compatible-fallback" | "photo-provider-pinned" | "current-unknown";
      readonly selection: AiSelection;
    };

function supportsImages(record: ModelRecord): boolean {
  return record.input.includes("image");
}

export function planModelFallback(input: FallbackPlanInput): FallbackPlanResult {
  const fallback = defaultSelection(input.accountId);
  const current = findRecord(input.catalog, input.currentModelId);
  if (current === undefined) return { ok: false, reason: "current-unknown", selection: fallback };
  const excluded = new Set(input.excludeModelIds ?? []);
  const needsVision = input.approvedImageIds.length > 0 || input.task === "image-question";

  const priceGate = (record: ModelRecord): boolean => {
    if (record.priceClass === "unknown") return false;
    if (input.mode === "free-only") return record.priceClass === "free";
    if (record.priceClass === "free") return true;
    const consent = input.paidConsent;
    if (consent === undefined) return false;
    const candidate: AiSelection = {
      accountId: input.accountId,
      provider: record.provider,
      modelId: record.id,
      mode: "paid-explicit",
      paidConsent: consent,
    };
    return isSelectionAuthorized(candidate, record, input.fingerprintOf(record), input.task);
  };

  const eligible = input.catalog.filter(
    (record) =>
      record.id !== input.currentModelId &&
      !excluded.has(record.id) &&
      record.entitlement !== "blocked" &&
      (record.provider !== "offline" || input.allowOffline === true) &&
      input.hasCredential(record.provider) &&
      (!needsVision || supportsImages(record)) &&
      priceGate(record),
  );
  if (eligible.length > 0) {
    const sameProvider = eligible.filter((record) => record.provider === current.provider);
    const ordered = [...sameProvider, ...eligible.filter((record) => record.provider !== current.provider)];
    // Photos pin the provider: cross-provider alternatives exist but must not
    // be taken silently (caller re-consents or stops). Without photos the
    // ordered list may cross providers for a free, authorized route.
    const withPhotos = input.approvedImageIds.length > 0;
    const pick = withPhotos ? ordered.find((record) => record.provider === current.provider) : ordered[0];
    if (pick === undefined) {
      return { ok: false, reason: "photo-provider-pinned", selection: fallback };
    }
    const paid = pick.priceClass !== "free";
    // Paid picks reuse the caller's consent verbatim (priceGate already proved
    // it authorizes THIS model+fingerprint+task); consent is never minted here.
    const consent = input.paidConsent;
    if (paid && consent === undefined) return { ok: false, reason: "no-compatible-fallback", selection: fallback };
    return {
      ok: true,
      selection:
        paid && consent !== undefined
          ? {
              accountId: input.accountId,
              provider: pick.provider,
              modelId: pick.id,
              mode: "paid-explicit" as const,
              paidConsent: consent,
            }
          : {
              accountId: input.accountId,
              provider: pick.provider,
              modelId: pick.id,
              mode: "free-only" as const,
            },
      record: pick,
      sameProvider: pick.provider === current.provider,
    };
  }

  // Distinguish "photos pin us here" from "nothing compatible at all": a
  // cross-provider vision route exists but is withheld pending explicit
  // photo-destination consent.
  if (input.approvedImageIds.length > 0) {
    const crossProviderVision = input.catalog.some(
      (record) =>
        record.id !== input.currentModelId &&
        !excluded.has(record.id) &&
        record.provider !== current.provider &&
        (record.provider !== "offline" || input.allowOffline === true) &&
        record.entitlement !== "blocked" &&
        input.hasCredential(record.provider) &&
        supportsImages(record) &&
        priceGate(record),
    );
    if (crossProviderVision) return { ok: false, reason: "photo-provider-pinned", selection: fallback };
  }
  return { ok: false, reason: "no-compatible-fallback", selection: fallback };
}
