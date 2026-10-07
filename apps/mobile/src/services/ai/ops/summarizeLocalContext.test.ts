import { describe, expect, it } from "vitest";
import { summarizeLocalContext, type SummarizeLocalContextInput } from "./summarizeLocalContext";
import { getTaskSpec } from "../orchestrator/taskRegistry";
import { REFUSAL_TEXT } from "../testing/FakeAiProvider";
import { mustProfile, stubGenerate } from "./testSupport";

const PROFILE = "qwen3-0.6b-dynamic-int4";

describe("summarize-local-context op", () => {
  it("summarizes notes as short prose", async () => {
    const result = await summarizeLocalContext(
      stubGenerate("You have two open drafts: a black umbrella and a set of keys."),
      { notes: "draft: black umbrella; draft: keys; search: red backpack" },
      mustProfile(PROFILE),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summaryText).toContain("two open drafts");
      expect(result.value.density).toBe("short");
    }
  });

  it("honors detailed density", async () => {
    const result = await summarizeLocalContext(
      stubGenerate("First sentence. Second sentence with a bit more detail here."),
      { notes: "draft: umbrella", density: "detailed" },
      mustProfile(PROFILE),
    );
    expect(result).toEqual({
      ok: true,
      value: { summaryText: "First sentence. Second sentence with a bit more detail here.", density: "detailed" },
    });
  });

  it("rejects non-string and empty notes (invalid shape)", async () => {
    const generate = stubGenerate("Some summary.");
    const nonString = await summarizeLocalContext(
      generate,
      { notes: 42 as unknown as string },
      mustProfile(PROFILE),
    );
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) expect(nonString.error.diagnostic).toBe("R1_BAD_INPUT:notes");

    const empty = await summarizeLocalContext(generate, { notes: "   " }, mustProfile(PROFILE));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.diagnostic).toBe("R4_EMPTY_INPUT");
    expect(generate.calls).toBe(0);
  });

  it("rejects densities outside the allowlist (invalid enum)", async () => {
    const generate = stubGenerate("Some summary.");
    const input = { notes: "draft: umbrella", density: "verbose" } as unknown as SummarizeLocalContextInput;
    const result = await summarizeLocalContext(generate, input, mustProfile(PROFILE));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("INVALID_OUTPUT");
      expect(result.error.diagnostic).toBe("R1_UNKNOWN_DENSITY:verbose");
    }
    expect(generate.calls).toBe(0);
  });

  it("rejects oversize summaries and oversize notes", async () => {
    const longSummary = await summarizeLocalContext(
      stubGenerate("s".repeat(600)),
      { notes: "draft: umbrella" },
      mustProfile(PROFILE),
    );
    expect(longSummary.ok).toBe(false);
    if (!longSummary.ok) expect(longSummary.error.diagnostic).toBe("R5_SUMMARY_TOO_LONG");

    const generate = stubGenerate("Some summary.");
    const longNotes = await summarizeLocalContext(generate, { notes: "n".repeat(2001) }, mustProfile(PROFILE));
    expect(longNotes.ok).toBe(false);
    if (!longNotes.ok) expect(longNotes.error.diagnostic).toBe("R5_INPUT_TOO_LONG:notes");
    expect(generate.calls).toBe(0);
  });

  it("rejects coordinates in the summary (business rule)", async () => {
    const result = await summarizeLocalContext(
      stubGenerate("The umbrella was found at 12.3456, 65.4321 near the gate."),
      { notes: "found: umbrella near the gate" },
      mustProfile(PROFILE),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R5_COORDINATES_NOT_ACCEPTED:summary");
  });

  it("propagates refusals as typed refusals", async () => {
    const result = await summarizeLocalContext(
      stubGenerate(REFUSAL_TEXT),
      { notes: "draft: umbrella" },
      mustProfile(PROFILE),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("UNSUPPORTED_REQUEST");
  });

  it("surfaces cancellation without calling generate", async () => {
    const generate = stubGenerate("Some summary.");
    const controller = new AbortController();
    controller.abort();
    const result = await summarizeLocalContext(generate, { notes: "draft: umbrella" }, mustProfile(PROFILE), {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_BEFORE_START" } });
    expect(generate.calls).toBe(0);
  });

  it("carries the canonical task envelope with budgets, runtimes, timeout, and no consent", () => {
    const spec = getTaskSpec("summarize-local-context")!;
    expect(spec.taskId).toBe("summarize-local-context");
    expect(spec.maxInputChars).toBe(2000);
    expect(spec.maxOutputTokens).toBeGreaterThan(0);
    expect(spec.timeoutMs).toBeGreaterThan(0);
    expect(spec.privacy.tier).toBe("local-only");
    expect(spec.runtimes).toContain("local-text");
    expect(spec.consent.required).toBe(false);
  });
});
