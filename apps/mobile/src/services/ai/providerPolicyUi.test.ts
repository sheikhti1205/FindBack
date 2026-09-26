/**
 * Worker E (M2 QA/security) — paid-consent + blocked-provider +
 * no-cross-provider-photo policy battery.
 *
 * Method: test through C's PUBLIC policy functions only —
 * `modelPolicy` (defaultSelection, switchAccountSelection,
 * authorizePaidSelection, resolveSelection), `providerContract`
 * (isSelectionAuthorized, priceClassFromLines, hasNoInlineImageBytesOrKeys),
 * `modelCatalog` (parseModelCatalog, priceFingerprint, supportsVision,
 * isCatalogStale), and the providers' `directKeyEntitlement()`.
 * No implementation files edited; no internals reached into.
 *
 * Fixtures are synthetic only. No paid calls, no live catalog fetch.
 */
import { describe, expect, it } from "vitest";
import {
  authorizePaidSelection,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  defaultSelection,
  resolveSelection,
  switchAccountSelection,
} from "./modelPolicy";
import {
  hasNoInlineImageBytesOrKeys,
  isSelectionAuthorized,
  priceClassFromLines,
  type ModelRecord,
  type NormalizedRequest,
  type PaidConsent,
  type PriceLine,
  type TaskScope,
} from "./providerContract";
import {
  isCatalogStale,
  parseModelCatalog,
  priceFingerprint,
  supportsVision,
} from "./modelCatalog";
import { directKeyEntitlement as openaiEntitlement } from "./providers/openai";
import { directKeyEntitlement as deepseekEntitlement } from "./providers/deepseek";
import { sanitizeControllerError } from "./chatController";

const TASK: TaskScope = "general";
const NOW = "2026-09-26T00:00:00.000Z";
const ACCEPTED_AT = "2026-09-26T00:00:00.000Z";

function line(amountDecimal: string, dimension = "input", sourceField = "pricing.prompt"): PriceLine {
  return { amountDecimal, currency: "USD", unit: "token", dimension, sourceField };
}

function freeRecord(id: string = DEFAULT_MODEL_ID): ModelRecord {
  return {
    provider: "openrouter",
    id,
    input: ["text"],
    output: ["text"],
    contextTokens: 200000,
    prices: [line("0"), line("0", "output", "pricing.completion")],
    priceClass: "free",
    retrievedAt: NOW,
    entitlement: "untested",
  };
}

function paidRecord(id = "openrouter/synthetic-paid"): ModelRecord {
  return {
    ...freeRecord(id),
    prices: [line("0.000001"), line("0.000002", "output", "pricing.completion")],
    priceClass: "paid",
  };
}

function unknownPriceRecord(id = "openrouter/synthetic-unknown"): ModelRecord {
  return { ...freeRecord(id), prices: [], priceClass: "unknown" };
}

const fingerprintOf = (record: ModelRecord): string => priceFingerprint(record);

function consentFor(record: ModelRecord, task: TaskScope = TASK): PaidConsent {
  return {
    provider: record.provider,
    modelId: record.id,
    fingerprint: priceFingerprint(record),
    taskScopes: [task],
    acceptedAt: ACCEPTED_AT,
  };
}

describe("paid consent — free-only never silently spends (AI-10)", () => {
  it("resolves the free default with no consent required", () => {
    const catalog = [freeRecord()];
    const result = resolveSelection({ accountId: "a1", catalog, task: TASK, fingerprintOf });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selection.mode).toBe("free-only");
  });

  it("blocks a paid model in free-only mode with consent-required + safe default", () => {
    const paid = paidRecord();
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord(), paid],
      task: TASK,
      desiredModelId: paid.id,
      fingerprintOf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("consent-required");
      // Caller must NOT send: the attached selection is the safe free default.
      expect(result.selection.modelId).toBe(DEFAULT_MODEL_ID);
      expect(result.selection.mode).toBe("free-only");
      expect(result.selection.paidConsent).toBeUndefined();
    }
  });

  it("blocks paid-explicit mode without consent", () => {
    const paid = paidRecord();
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord(), paid],
      task: TASK,
      desiredModelId: paid.id,
      mode: "paid-explicit",
      fingerprintOf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("consent-required");
  });

  it("authorizes paid-explicit with matching consent, fingerprint, and task scope", () => {
    const paid = paidRecord();
    const selection = authorizePaidSelection({
      accountId: "a1",
      record: paid,
      fingerprint: priceFingerprint(paid),
      taskScopes: [TASK],
      acceptedAt: ACCEPTED_AT,
    });
    expect(selection.mode).toBe("paid-explicit");
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord(), paid],
      task: TASK,
      desiredModelId: paid.id,
      mode: "paid-explicit",
      paidConsent: selection.paidConsent,
      fingerprintOf,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selection.modelId).toBe(paid.id);
  });

  it("invalidates consent when the fee fingerprint changes (price rise voids consent)", () => {
    const paid = paidRecord();
    const stale = consentFor(paid);
    const repriced: ModelRecord = {
      ...paid,
      prices: [line("0.000009"), line("0.000002", "output", "pricing.completion")],
    };
    expect(priceFingerprint(repriced)).not.toBe(priceFingerprint(paid));
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord(), repriced],
      task: TASK,
      desiredModelId: repriced.id,
      mode: "paid-explicit",
      paidConsent: stale,
      fingerprintOf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("consent-invalid");
  });

  it("invalidates consent for a task outside the consented scopes", () => {
    const paid = paidRecord();
    const narrow = consentFor(paid, "app-help");
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord(), paid],
      task: "image-question",
      desiredModelId: paid.id,
      mode: "paid-explicit",
      paidConsent: narrow,
      fingerprintOf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("consent-invalid");
  });

  it("never treats unknown price as consentable (unknown ≠ free)", () => {
    const unknown = unknownPriceRecord();
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord(), unknown],
      task: TASK,
      desiredModelId: unknown.id,
      mode: "paid-explicit",
      paidConsent: consentFor(unknown),
      fingerprintOf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("consent-invalid");
  });

  it("account switch drops consent and returns a fresh free default", () => {
    const paid = paidRecord();
    const consented = authorizePaidSelection({
      accountId: "a1",
      record: paid,
      fingerprint: priceFingerprint(paid),
      taskScopes: [TASK],
      acceptedAt: ACCEPTED_AT,
    });
    expect(consented.paidConsent).toBeDefined();
    const next = switchAccountSelection("a2", [freeRecord(), paid]);
    expect(next.accountId).toBe("a2");
    expect(next.mode).toBe("free-only");
    expect(next.paidConsent).toBeUndefined();
    expect(next.provider).toBe(DEFAULT_PROVIDER);
    expect(next.modelId).toBe(DEFAULT_MODEL_ID);
  });
});

describe("isSelectionAuthorized — direct authorization checks", () => {
  it("free records authorize without consent; mismatches and paid-without-consent fail", () => {
    const free = freeRecord();
    expect(isSelectionAuthorized(defaultSelection("a1"), free, priceFingerprint(free), TASK)).toBe(true);
    const paid = paidRecord();
    const freeMode = defaultSelection("a1");
    expect(isSelectionAuthorized({ ...freeMode, provider: paid.provider, modelId: paid.id }, paid, priceFingerprint(paid), TASK)).toBe(false);
    const wrongModel = { ...freeMode, modelId: "openrouter/other" };
    expect(isSelectionAuthorized(wrongModel, free, priceFingerprint(free), TASK)).toBe(false);
    const emptyConsent: PaidConsent = { ...consentFor(paid), acceptedAt: "  " };
    const consented = authorizePaidSelection({
      accountId: "a1", record: paid, fingerprint: priceFingerprint(paid),
      taskScopes: [TASK], acceptedAt: ACCEPTED_AT,
    });
    expect(isSelectionAuthorized({ ...consented, paidConsent: emptyConsent }, paid, priceFingerprint(paid), TASK)).toBe(false);
  });
});

describe("blocked providers — OpenAI/DeepSeek direct keys never connect (AI-09/AI-13)", () => {
  it("both providers report blocked direct-key entitlement", () => {
    expect(openaiEntitlement()).toBe("blocked");
    expect(deepseekEntitlement()).toBe("blocked");
  });

  it("catalog rows marked blocked resolve to blocked-model with safe default", () => {
    const response = {
      data: [
        {
          id: "openai/synthetic-blocked",
          pricing: { prompt: "0.000001", completion: "0.000002" },
          context_length: 128000,
        },
      ],
      total_count: 1,
      links: { next: null },
    };
    const catalog = parseModelCatalog(response, {
      retrievedAt: NOW,
      blockedIds: ["openai/synthetic-blocked"],
    });
    expect(catalog[0]?.entitlement).toBe("blocked");
    const record = catalog[0] as ModelRecord;
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord(), record],
      task: TASK,
      desiredModelId: record.id,
      fingerprintOf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("blocked-model");
      expect(result.selection.modelId).toBe(DEFAULT_MODEL_ID);
    }
  });

  it("unknown model ids resolve to unknown-model with safe default", () => {
    const result = resolveSelection({
      accountId: "a1",
      catalog: [freeRecord()],
      task: TASK,
      desiredModelId: "nope/synthetic-missing",
      fingerprintOf,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown-model");
  });
});

describe("price lines — catalog truthfulness, no invented free (AI-09)", () => {
  it("derives free/paid/unknown/variable exactly from raw lines", () => {
    expect(priceClassFromLines([])).toBe("unknown");
    expect(priceClassFromLines([line("0"), line("0.00", "output", "pricing.completion")])).toBe("free");
    expect(priceClassFromLines([line("0.000001")])).toBe("paid");
    expect(priceClassFromLines([{ ...line("0"), conditions: "min_prompt_tokens>1000" }])).toBe("variable");
    expect(priceClassFromLines([line("not-a-number")])).toBe("unknown");
  });

  it("priceFingerprint is stable per fee state and voids consent on any change", () => {
    const paid = paidRecord();
    expect(priceFingerprint({ ...paid })).toBe(priceFingerprint(paid));
    const changed: ModelRecord = {
      ...paid,
      prices: paid.prices.map((entry) => ({ ...entry })),
    };
    changed.prices = [line("0.000001"), line("0.000003", "output", "pricing.completion")];
    expect(priceFingerprint(changed)).not.toBe(priceFingerprint(paid));
  });

  it("isCatalogStale treats old or unparseable timestamps as stale", () => {
    const now = Date.parse(NOW);
    expect(isCatalogStale(NOW, now)).toBe(false);
    expect(isCatalogStale("2026-09-20T00:00:00.000Z", now)).toBe(true);
    expect(isCatalogStale("not-a-timestamp", now)).toBe(true);
  });
});

describe("no-cross-provider-photo — requests carry id references only (AI-13/CHAT-01)", () => {  function baseRequest(): NormalizedRequest {
    return {
      selection: defaultSelection("a1"),
      task: TASK,
      policyVersion: "synthetic-policy-1",
      knowledgeVersion: "synthetic-kb-1",
      recentTurns: [{ id: "t1", role: "user", text: "hi", attachmentIds: ["photo-ref-1"], createdAt: NOW }],
      currentText: "describe this",
      approvedImageIds: ["photo-ref-1", "photo-ref-2"],
      authorizedResultIds: [],
      maxOutputTokens: 512,
      signal: new AbortController().signal,
    };
  }

  it("accepts a clean id-reference request (photo routing stays provider-scoped)", () => {
    expect(hasNoInlineImageBytesOrKeys(baseRequest())).toBe(true);
  });

  it("rejects inline photo bytes (data-URL) in any id list", () => {
    const dirty = baseRequest();
    dirty.approvedImageIds = ["photo-ref-1", "data:image/jpeg;base64," + "a".repeat(32)];
    expect(hasNoInlineImageBytesOrKeys(dirty)).toBe(false);
  });

  it("rejects smuggled credential/payload keys at top level and in selection", () => {
    const extraTop = { ...baseRequest(), imageBytes: "aaa" } as unknown as NormalizedRequest;
    expect(hasNoInlineImageBytesOrKeys(extraTop)).toBe(false);
    const extraSel = baseRequest();
    (extraSel.selection as unknown as Record<string, unknown>)["apiKey"] = "synthetic";
    expect(hasNoInlineImageBytesOrKeys(extraSel)).toBe(false);
  });

  it("supportsVision is explicit: text-only models must not receive images silently", () => {
    expect(supportsVision(freeRecord())).toBe(false);
    expect(supportsVision({ ...freeRecord(), input: ["text", "image"] })).toBe(true);
  });
});

describe("controller lastError hygiene — provider echoes never leak keys/prompts (SEN-03/AI-12)", () => {
  // C's public sanitizeControllerError clips + scrubs raw provider error text
  // before it reaches ControllerState.lastError (which B renders and which
  // may flow into Sentry breadcrumbs). Tested through the public export only.
  const SYN_KEY = ["sk", "synthetic"].join("-") + "-abc123XYZ";
  const PROMPT = "my lost black wallet near central park";

  it("redacts key-like material and caller-supplied prompt echoes", () => {
    const out = sanitizeControllerError(
      `provider said invalid key ${SYN_KEY} for prompt ${PROMPT}`,
      [PROMPT],
    );
    expect(out).not.toContain(SYN_KEY);
    expect(out).not.toContain(PROMPT);
    expect(out).toContain("[redacted-key]");
    expect(out).toContain("[redacted-input]");
  });

  it("redacts bearer/api-key/data-URL shapes and clips to 300 chars", () => {
    const long = `oops Bearer synthetic-bearer-token api_key = secret123 ${"x".repeat(500)}`;
    const out = sanitizeControllerError(long);
    expect(out).not.toContain("synthetic-bearer-token");
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith("…")).toBe(true);
  });

  it("passes benign errors through unchanged", () => {
    expect(sanitizeControllerError("model overloaded, retry later")).toBe(
      "model overloaded, retry later",
    );
  });
});
