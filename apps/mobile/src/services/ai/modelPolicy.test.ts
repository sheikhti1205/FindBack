import { describe, expect, it } from "vitest";
import type { ModelRecord, TaskScope } from "./providerContract";
import {
  DEFAULT_MODEL_ID,
  authorizePaidSelection,
  defaultSelection,
  resolveSelection,
  switchAccountSelection,
} from "./modelPolicy";

function freeRecord(id: string = DEFAULT_MODEL_ID): ModelRecord {
  return {
    provider: "openrouter",
    id,
    input: ["text"],
    output: ["text"],
    contextTokens: 200000,
    prices: [
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
      {
        amountDecimal: "0",
        currency: "USD",
        unit: "token",
        dimension: "output",
        sourceField: "pricing.completion",
      },
    ],
    priceClass: "free",
    retrievedAt: "2026-09-25T00:00:00.000Z",
    entitlement: "untested",
  };
}

function paidRecord(id = "openai/gpt-4o-mini"): ModelRecord {
  return {
    ...freeRecord(id),
    prices: [
      {
        amountDecimal: "0.00000015",
        currency: "USD",
        unit: "token",
        dimension: "input",
        sourceField: "pricing.prompt",
      },
      {
        amountDecimal: "0.0000006",
        currency: "USD",
        unit: "token",
        dimension: "output",
        sourceField: "pricing.completion",
      },
    ],
    priceClass: "paid",
  };
}

function unknownRecord(id = "vendor/mystery"): ModelRecord {
  return { ...freeRecord(id), prices: [], priceClass: "unknown" };
}

const fingerprintOf = (record: ModelRecord): string =>
  JSON.stringify(record.prices.map((p) => [p.dimension, p.amountDecimal, p.sourceField].join("|")));

describe("modelPolicy (P1 red)", () => {
  it("starts fresh on openrouter/free in free-only mode", () => {
    const selection = defaultSelection("acct-1");
    expect(selection.accountId).toBe("acct-1");
    expect(selection.provider).toBe("openrouter");
    expect(selection.modelId).toBe("openrouter/free");
    expect(selection.modelId).toBe(DEFAULT_MODEL_ID);
    expect(selection.mode).toBe("free-only");
    expect(selection.paidConsent).toBeUndefined();
    const resolved = resolveSelection({
      accountId: "acct-1",
      catalog: [freeRecord()],
      task: "general",
      fingerprintOf,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.record.id).toBe("openrouter/free");
  });

  it("never inherits another account's selection or consent on switch", () => {
    const paid = paidRecord();
    const consenting = authorizePaidSelection({
      accountId: "acct-1",
      record: paid,
      fingerprint: fingerprintOf(paid),
      taskScopes: ["report-draft"] as const,
      acceptedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(consenting.mode).toBe("paid-explicit");
    const switched = switchAccountSelection("acct-2", [freeRecord(), paid]);
    expect(switched.accountId).toBe("acct-2");
    expect(switched.modelId).toBe("openrouter/free");
    expect(switched.mode).toBe("free-only");
    expect(switched.paidConsent).toBeUndefined();
  });

  it("authorizes paid selection per task scope with matching fingerprint", () => {
    const paid = paidRecord();
    const fingerprint = fingerprintOf(paid);
    const task: TaskScope = "report-draft";
    const selection = authorizePaidSelection({
      accountId: "acct-1",
      record: paid,
      fingerprint,
      taskScopes: [task],
      acceptedAt: "2026-09-25T00:00:00.000Z",
    });
    const allowed = resolveSelection({
      accountId: "acct-1",
      catalog: [freeRecord(), paid],
      task,
      desiredModelId: paid.id,
      mode: "paid-explicit",
      paidConsent: selection.paidConsent,
      fingerprintOf,
    });
    expect(allowed.ok).toBe(true);
    const otherTask = resolveSelection({
      accountId: "acct-1",
      catalog: [freeRecord(), paid],
      task: "general",
      desiredModelId: paid.id,
      mode: "paid-explicit",
      paidConsent: selection.paidConsent,
      fingerprintOf,
    });
    expect(otherTask.ok).toBe(false);
  });

  it("invalidates consent when the fee fingerprint changes", () => {
    const paid = paidRecord();
    const selection = authorizePaidSelection({
      accountId: "acct-1",
      record: paid,
      fingerprint: fingerprintOf(paid),
      taskScopes: ["report-draft"],
      acceptedAt: "2026-09-25T00:00:00.000Z",
    });
    const repriced: ModelRecord = {
      ...paid,
      prices: paid.prices.map((p) =>
        p.dimension === "input" ? { ...p, amountDecimal: "0.0000003" } : p,
      ),
    };
    const resolved = resolveSelection({
      accountId: "acct-1",
      catalog: [freeRecord(), repriced],
      task: "report-draft",
      desiredModelId: paid.id,
      mode: "paid-explicit",
      paidConsent: selection.paidConsent,
      fingerprintOf,
    });
    expect(resolved.ok).toBe(false);
  });

  it("invalidates consent when the model changes", () => {
    const paid = paidRecord("openai/gpt-4o-mini");
    const selection = authorizePaidSelection({
      accountId: "acct-1",
      record: paid,
      fingerprint: fingerprintOf(paid),
      taskScopes: ["report-draft"],
      acceptedAt: "2026-09-25T00:00:00.000Z",
    });
    const other = paidRecord("anthropic/claude-sonnet-4.5");
    const resolved = resolveSelection({
      accountId: "acct-1",
      catalog: [freeRecord(), paid, other],
      task: "report-draft",
      desiredModelId: other.id,
      mode: "paid-explicit",
      paidConsent: selection.paidConsent,
      fingerprintOf,
    });
    expect(resolved.ok).toBe(false);
  });

  it("never silently selects or falls back to paid/unknown models in free-only mode", () => {
    const paid = paidRecord();
    const unknown = unknownRecord();
    const blockedFree: ModelRecord = { ...freeRecord(), entitlement: "blocked" };
    const silentPaid = resolveSelection({
      accountId: "acct-1",
      catalog: [blockedFree, paid, unknown],
      task: "general",
      desiredModelId: paid.id,
      fingerprintOf,
    });
    expect(silentPaid.ok).toBe(false);
    if (!silentPaid.ok) {
      expect(silentPaid.selection.mode).toBe("free-only");
      expect(silentPaid.selection.modelId).toBe("openrouter/free");
      expect(silentPaid.selection.paidConsent).toBeUndefined();
    }
    const silentUnknown = resolveSelection({
      accountId: "acct-1",
      catalog: [blockedFree, paid, unknown],
      task: "general",
      desiredModelId: unknown.id,
      fingerprintOf,
    });
    expect(silentUnknown.ok).toBe(false);
  });

  it("rejects paid selection without paid-explicit mode and matching consent", () => {
    const paid = paidRecord();
    expect(
      resolveSelection({
        accountId: "acct-1",
        catalog: [freeRecord(), paid],
        task: "general",
        desiredModelId: paid.id,
        fingerprintOf,
      }).ok,
    ).toBe(false);
    expect(
      resolveSelection({
        accountId: "acct-1",
        catalog: [freeRecord(), paid],
        task: "general",
        desiredModelId: paid.id,
        mode: "paid-explicit",
        fingerprintOf,
      }).ok,
    ).toBe(false);
  });

  it("rejects consent for unknown-priced models even in paid-explicit mode", () => {
    const unknown = unknownRecord();
    const selection = authorizePaidSelection({
      accountId: "acct-1",
      record: unknown,
      fingerprint: fingerprintOf(unknown),
      taskScopes: ["general"],
      acceptedAt: "2026-09-25T00:00:00.000Z",
    });
    const resolved = resolveSelection({
      accountId: "acct-1",
      catalog: [freeRecord(), unknown],
      task: "general",
      desiredModelId: unknown.id,
      mode: "paid-explicit",
      paidConsent: selection.paidConsent,
      fingerprintOf,
    });
    expect(resolved.ok).toBe(false);
  });
});
