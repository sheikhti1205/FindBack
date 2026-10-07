import { describe, expect, it } from "vitest";
import { routeIntent } from "./routeIntent";
import { getTaskSpec } from "../orchestrator/taskRegistry";
import { mustProfile, stubGenerate } from "./testSupport";

const PROFILE = "qwen3-0.6b-dynamic-int4";

describe("route-intent op", () => {
  it("routes a search intent to OPEN_SEARCH", async () => {
    const result = await routeIntent(
      stubGenerate('{"route":"OPEN_SEARCH"}'),
      { intent: "SEARCH" },
      mustProfile(PROFILE),
    );
    expect(result).toEqual({ ok: true, value: { route: "OPEN_SEARCH" } });
  });

  it("passes confidence and reason through", async () => {
    const result = await routeIntent(
      stubGenerate('{"route":"OPEN_REPORT_LOST","confidence":0.9,"reason":"user lost keys"}'),
      { intent: "REPORT_LOST" },
      mustProfile(PROFILE),
    );
    expect(result).toEqual({
      ok: true,
      value: { route: "OPEN_REPORT_LOST", confidence: 0.9, reason: "user lost keys" },
    });
  });

  it("rejects non-object payloads (invalid shape)", async () => {
    const result = await routeIntent(stubGenerate("[1, 2, 3]"), { intent: "SEARCH" }, mustProfile(PROFILE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("INVALID_OUTPUT");
  });

  it("rejects missing route and mistyped confidence (invalid shape)", async () => {
    const missing = await routeIntent(stubGenerate('{"confidence":0.9}'), { intent: "SEARCH" }, mustProfile(PROFILE));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.diagnostic).toBe("R1_MISSING_ROUTE");

    const mistyped = await routeIntent(
      stubGenerate('{"route":"OPEN_SEARCH","confidence":"high"}'),
      { intent: "SEARCH" },
      mustProfile(PROFILE),
    );
    expect(mistyped.ok).toBe(false);
    if (!mistyped.ok) expect(mistyped.error.diagnostic).toBe("R1_BAD_CONFIDENCE");
  });

  it("rejects routes outside the allowlist (invalid enum)", async () => {
    const result = await routeIntent(
      stubGenerate('{"route":"TELEPORT_HOME"}'),
      { intent: "SEARCH" },
      mustProfile(PROFILE),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("INVALID_OUTPUT");
      expect(result.error.diagnostic).toBe("R1_UNKNOWN_ROUTE:TELEPORT_HOME");
    }
  });

  it("rejects oversize reasons without side effects", async () => {
    const generate = stubGenerate(`{"route":"ASK_USER","reason":"${"x".repeat(200)}"}`);
    const result = await routeIntent(generate, { intent: "UNKNOWN" }, mustProfile(PROFILE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R5_FIELD_TOO_LONG:reason");
  });

  it("rejects oversize hints before calling generate", async () => {
    const generate = stubGenerate('{"route":"OPEN_SEARCH"}');
    const result = await routeIntent(generate, { intent: "SEARCH", hint: "y".repeat(281) }, mustProfile(PROFILE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R5_INPUT_TOO_LONG:hint");
    expect(generate.calls).toBe(0);
  });

  it("enforces business rules: ASK_USER needs a reason, OPEN_MAP needs location", async () => {
    const noReason = await routeIntent(
      stubGenerate('{"route":"ASK_USER"}'),
      { intent: "UNKNOWN" },
      mustProfile(PROFILE),
    );
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.diagnostic).toBe("R1_BUSINESS_RULE:ASK_USER_REQUIRES_REASON");

    const noLocation = await routeIntent(
      stubGenerate('{"route":"OPEN_MAP"}'),
      { intent: "SEARCH" },
      mustProfile(PROFILE),
    );
    expect(noLocation.ok).toBe(false);
    if (!noLocation.ok) expect(noLocation.error.diagnostic).toBe("R1_BUSINESS_RULE:OPEN_MAP_REQUIRES_LOCATION");

    const withLocation = await routeIntent(
      stubGenerate('{"route":"OPEN_MAP"}'),
      { intent: "SEARCH", hasLocation: true },
      mustProfile(PROFILE),
    );
    expect(withLocation).toEqual({ ok: true, value: { route: "OPEN_MAP" } });
  });

  it("surfaces cancellation without calling generate", async () => {
    const generate = stubGenerate('{"route":"OPEN_SEARCH"}');
    const controller = new AbortController();
    controller.abort();
    const result = await routeIntent(generate, { intent: "SEARCH" }, mustProfile(PROFILE), {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_BEFORE_START" } });
    expect(generate.calls).toBe(0);
  });

  it("carries the canonical task envelope with budgets, runtimes, timeout, and no consent", () => {
    const spec = getTaskSpec("route-intent")!;
    expect(spec.taskId).toBe("route-intent");
    expect(spec.maxInputChars).toBe(280);
    expect(spec.maxOutputTokens).toBeGreaterThan(0);
    expect(spec.timeoutMs).toBeGreaterThan(0);
    expect(spec.privacy.tier).toBe("local-only");
    expect(spec.runtimes).toContain("local-text");
    expect(spec.consent.required).toBe(false);
  });
});
