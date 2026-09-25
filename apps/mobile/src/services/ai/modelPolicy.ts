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
