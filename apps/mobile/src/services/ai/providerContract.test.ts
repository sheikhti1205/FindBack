import { describe, expect, it } from "vitest";
import {
  CHAT_CHECKPOINT_SCHEMA_VERSION,
  hasNoInlineImageBytesOrKeys,
  isChatCheckpoint,
  isDecimalAmount,
  isFreeClass,
  isSelectionAuthorized,
  priceClassFromLines,
  resolveContextTokens,
} from "./providerContract";
import type {
  AiSelection,
  ChatCheckpoint,
  CredentialHandle,
  ModelRecord,
  NormalizedRequest,
  PriceLine,
  StreamEvent,
} from "./providerContract";

function line(
  amountDecimal: string,
  overrides: Partial<PriceLine> = {},
): PriceLine {
  return {
    amountDecimal,
    currency: "USD",
    unit: "million_tokens",
    dimension: "input",
    sourceField: "pricing.prompt",
    ...overrides,
  };
}

function record(
  overrides: Partial<ModelRecord> = {},
): ModelRecord {
  return {
    provider: "openrouter",
    id: "fixture-model-a",
    input: ["text"],
    output: ["text"],
    prices: [line("0")],
    priceClass: "free",
    retrievedAt: "2026-09-25T00:00:00.000Z",
    entitlement: "untested",
    ...overrides,
  };
}

function selection(overrides: Partial<AiSelection> = {}): AiSelection {
  return {
    accountId: "account-1",
    provider: "openrouter",
    modelId: "fixture-model-a",
    mode: "free-only",
    ...overrides,
  };
}

function checkpoint(overrides: Partial<ChatCheckpoint> = {}): ChatCheckpoint {
  return {
    schemaVersion: CHAT_CHECKPOINT_SCHEMA_VERSION,
    coveredThroughTurnId: "turn-2",
    sourceTurnIds: ["turn-1", "turn-2"],
    summaryText: "User asked about reports; assistant outlined steps.",
    generatedBy: "local-extractive",
    estimatedTokens: 120,
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    selection: selection(),
    task: "general",
    policyVersion: "policy-1",
    knowledgeVersion: "knowledge-1",
    recentTurns: [],
    currentText: "Hello",
    approvedImageIds: [],
    authorizedResultIds: [],
    maxOutputTokens: 512,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("providerContract decimal shape", () => {
  it("accepts plain non-negative decimals and rejects anything else", () => {
    expect(isDecimalAmount("0")).toBe(true);
    expect(isDecimalAmount("0.00")).toBe(true);
    expect(isDecimalAmount("1.25")).toBe(true);
    expect(isDecimalAmount("")).toBe(false);
    expect(isDecimalAmount("-1")).toBe(false);
    expect(isDecimalAmount("abc")).toBe(false);
    expect(isDecimalAmount("1e3")).toBe(false);
    expect(isDecimalAmount(" 1")).toBe(false);
    expect(isDecimalAmount(undefined)).toBe(false);
  });
});

describe("providerContract price-class derivation", () => {
  it("derives free when every line is an explicit zero", () => {
    expect(priceClassFromLines([line("0"), line("0.00")])).toBe("free");
    expect(isFreeClass(priceClassFromLines([line("0")]))).toBe(true);
  });

  it("derives paid when any line carries a positive amount", () => {
    expect(priceClassFromLines([line("0"), line("0.5")])).toBe("paid");
    expect(isFreeClass("paid")).toBe(false);
  });

  it("derives unknown for missing or malformed pricing", () => {
    expect(priceClassFromLines([])).toBe("unknown");
    expect(priceClassFromLines([line("not-a-number")])).toBe("unknown");
    expect(isFreeClass("unknown")).toBe(false);
  });

  it("derives variable when any line carries a pricing condition", () => {
    const conditional = line("0", { conditions: "first units included" });
    expect(priceClassFromLines([conditional])).toBe("variable");
    expect(priceClassFromLines([line("0.5", { conditions: "cache reads billed" })])).toBe(
      "variable",
    );
    expect(isFreeClass("variable")).toBe(false);
  });
});

describe("providerContract context tokens", () => {
  it("keeps unknown context unknown and never synthesizes zero", () => {
    const unknown = record({ contextTokens: undefined });
    expect(resolveContextTokens(unknown)).toBeUndefined();
    expect(resolveContextTokens(unknown)).not.toBe(0);
    const known = record({ contextTokens: 200000 });
    expect(resolveContextTokens(known)).toBe(200000);
  });
});

describe("providerContract paid consent", () => {
  const fingerprint = "price-fingerprint-1";

  it("requires paid-explicit consent for a paid provider+model", () => {
    const paid = record({ priceClass: "paid", prices: [line("0.5")] });
    expect(isSelectionAuthorized(selection({ mode: "free-only" }), paid, fingerprint, "general")).toBe(
      false,
    );
    expect(
      isSelectionAuthorized(selection({ mode: "paid-explicit" }), paid, fingerprint, "general"),
    ).toBe(false);
    const consented = selection({
      mode: "paid-explicit",
      paidConsent: {
        provider: "openrouter",
        modelId: "fixture-model-a",
        fingerprint,
        taskScopes: ["general"],
        acceptedAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(isSelectionAuthorized(consented, paid, fingerprint, "general")).toBe(true);
  });

  it("invalidates consent when the price fingerprint changes", () => {
    const paid = record({ priceClass: "paid", prices: [line("0.5")] });
    const consented = selection({
      mode: "paid-explicit",
      paidConsent: {
        provider: "openrouter",
        modelId: "fixture-model-a",
        fingerprint: "old-fingerprint",
        taskScopes: ["general"],
        acceptedAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(isSelectionAuthorized(consented, paid, "new-fingerprint", "general")).toBe(false);
  });

  it("invalidates consent on provider/model/task-scope mismatch", () => {
    const paid = record({ priceClass: "paid", prices: [line("0.5")] });
    const wrongModel = selection({
      mode: "paid-explicit",
      paidConsent: {
        provider: "openrouter",
        modelId: "other-model",
        fingerprint,
        taskScopes: ["general"],
        acceptedAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(isSelectionAuthorized(wrongModel, paid, fingerprint, "general")).toBe(false);
    const wrongScope = selection({
      mode: "paid-explicit",
      paidConsent: {
        provider: "openrouter",
        modelId: "fixture-model-a",
        fingerprint,
        taskScopes: ["app-help"],
        acceptedAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(isSelectionAuthorized(wrongScope, paid, fingerprint, "general")).toBe(false);
  });

  it("allows a free model without consent", () => {
    const free = record({ priceClass: "free", prices: [line("0")] });
    expect(isSelectionAuthorized(selection({ mode: "free-only" }), free, fingerprint, "general")).toBe(
      true,
    );
  });
});

describe("providerContract checkpoint shape", () => {
  it("accepts a well-formed checkpoint pinned to the current schema version", () => {
    expect(CHAT_CHECKPOINT_SCHEMA_VERSION).toBe(1);
    expect(isChatCheckpoint(checkpoint())).toBe(true);
  });

  it("rejects checkpoints with a wrong schema version or uncovered turn pointer", () => {
    expect(isChatCheckpoint(checkpoint({ schemaVersion: 999 }))).toBe(false);
    expect(isChatCheckpoint(checkpoint({ coveredThroughTurnId: "" }))).toBe(false);
    expect(isChatCheckpoint(checkpoint({ sourceTurnIds: [] }))).toBe(false);
    expect(
      isChatCheckpoint(
        checkpoint({ coveredThroughTurnId: "turn-9", sourceTurnIds: ["turn-1", "turn-2"] }),
      ),
    ).toBe(false);
  });
});

describe("providerContract request safety", () => {
  it("carries only image/result ids and never inline bytes or raw keys", () => {
    const clean = request({
      approvedImageIds: ["staging-object-1"],
      authorizedResultIds: ["post-1"],
    });
    expect(hasNoInlineImageBytesOrKeys(clean)).toBe(true);
    const payload = JSON.stringify(clean);
    expect(payload).not.toMatch(/api[_-]?key|raw[_-]?key|secret|data:image\//i);
  });

  it("rejects smuggled image bytes or credential fields", () => {
    const withBytes = request({
      approvedImageIds: ["data:image/png;base64,iVBORw0KGgo="],
    });
    expect(hasNoInlineImageBytesOrKeys(withBytes)).toBe(false);
    const withKey = {
      ...request(),
      apiKey: "should-never-be-here",
    } as unknown as NormalizedRequest;
    expect(hasNoInlineImageBytesOrKeys(withKey)).toBe(false);
  });
});

describe("providerContract streaming and credential shapes", () => {
  it("labels every stream event with its partial attempt", () => {
    const events: readonly StreamEvent[] = [
      { kind: "phase", phase: "sending", attempt: 1 },
      { kind: "text", attempt: 1, delta: "Hello" },
      { kind: "usage", attempt: 1, inputTokens: 10, outputTokens: 3 },
      { kind: "error", attempt: 1, code: "OVERLOADED", message: "busy", retryable: true },
      { kind: "phase", phase: "retrying", attempt: 2 },
      { kind: "done", attempt: 2, stopReason: "complete" },
    ];
    for (const event of events) {
      expect(typeof event.attempt).toBe("number");
    }
    expect(events[0]).toEqual({ kind: "phase", phase: "sending", attempt: 1 });
    expect(events[5]).toEqual({ kind: "done", attempt: 2, stopReason: "complete" });
  });

  it("keeps the credential handle opaque with no raw key field", () => {
    const handle: CredentialHandle = {
      accountId: "account-1",
      provider: "openrouter",
      handle: "handle-abc",
    };
    expect(Object.keys(handle).sort()).toEqual(["accountId", "handle", "provider"]);
    expect("apiKey" in handle).toBe(false);
    expect(JSON.stringify(handle)).not.toMatch(/api[_-]?key|secret/i);
  });
});
