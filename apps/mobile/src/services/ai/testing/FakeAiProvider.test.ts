import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_LOCATION_STATE,
  FAULT_MODES,
  FakeAiError,
  FakeAiProvider,
  PROPOSED_MODE_ERROR_MAP,
  REFUSAL_TEXT,
  diagnosticCodeForMode,
  extractSingleJsonObject,
  type FaultMode,
} from "./FakeAiProvider";

const ALL_MODES: FaultMode[] = [...FAULT_MODES];

describe("FakeAiProvider scaffolding", () => {
  it("declares all 19 required modes", () => {
    expect(ALL_MODES).toHaveLength(19);
    for (const mode of [
      "GOOD",
      "SLOW",
      "TIMEOUT",
      "LOOP_SENTENCE",
      "LOOP_PARAGRAPH",
      "EMPTY",
      "INVALID_JSON",
      "FENCED_JSON",
      "PROSE_PLUS_JSON",
      "TRUNCATED_JSON",
      "WRONG_ACTION",
      "UNKNOWN_ACTION",
      "REFUSAL",
      "OOM",
      "RUNTIME_CRASH",
      "MODEL_MISSING",
      "MODEL_CORRUPT",
      "LOW_MEMORY",
      "CANCELLED",
    ] as FaultMode[]) {
      expect(ALL_MODES).toContain(mode);
    }
  });

  it("proposes an error class (or explicit success) for every mode", () => {
    for (const mode of ALL_MODES) {
      expect(mode in PROPOSED_MODE_ERROR_MAP).toBe(true);
    }
    expect(PROPOSED_MODE_ERROR_MAP.GOOD).toBeNull();
    expect(PROPOSED_MODE_ERROR_MAP.SLOW).toBeNull();
    expect(PROPOSED_MODE_ERROR_MAP.TIMEOUT).toBe("TIMEOUT");
    expect(PROPOSED_MODE_ERROR_MAP.LOOP_SENTENCE).toBe("LOOP_DETECTED");
    expect(PROPOSED_MODE_ERROR_MAP.LOOP_PARAGRAPH).toBe("LOOP_DETECTED");
    expect(PROPOSED_MODE_ERROR_MAP.WRONG_ACTION).toBe("UNSUPPORTED_ACTION");
    expect(PROPOSED_MODE_ERROR_MAP.UNKNOWN_ACTION).toBe("UNSUPPORTED_ACTION");
    expect(PROPOSED_MODE_ERROR_MAP.REFUSAL).toBe("UNSUPPORTED_REQUEST");
    expect(PROPOSED_MODE_ERROR_MAP.FENCED_JSON).toBeNull();
    expect(PROPOSED_MODE_ERROR_MAP.PROSE_PLUS_JSON).toBeNull();
    expect(PROPOSED_MODE_ERROR_MAP.OOM).toBe("LOW_MEMORY");
    expect(PROPOSED_MODE_ERROR_MAP.LOW_MEMORY).toBe("LOW_MEMORY");
    expect(PROPOSED_MODE_ERROR_MAP.RUNTIME_CRASH).toBe("RUNTIME_ERROR");
    expect(PROPOSED_MODE_ERROR_MAP.MODEL_MISSING).toBe("MODEL_UNAVAILABLE");
    expect(PROPOSED_MODE_ERROR_MAP.MODEL_CORRUPT).toBe("MODEL_CORRUPT");
    expect(PROPOSED_MODE_ERROR_MAP.CANCELLED).toBe("CANCELLED");
  });

  it("GOOD returns deterministic help text and valid photo JSON", async () => {
    const fake = new FakeAiProvider({ mode: "GOOD" });
    const help = await fake.generateText({ prompt: "How do I report a lost item?" });
    expect(help.text).toContain("Report tab");
    const photo = await fake.analyzePhoto({ imageUri: "x", instruction: "describe" });
    expect(() => JSON.parse(photo.text)).not.toThrow();
    expect(JSON.parse(photo.text).objectName).toBe("black umbrella");
  });

  it("SLOW succeeds after the configured delay and is not itself an error", async () => {
    const fake = new FakeAiProvider({ mode: "SLOW", slowDelayMs: 20 });
    const started = Date.now();
    const res = await fake.generateText({ prompt: "hi" });
    expect(res.text.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("TIMEOUT rejects with TIMEOUT", async () => {
    const fake = new FakeAiProvider({ mode: "TIMEOUT", timeoutMs: 10 });
    await expect(fake.generateText({ prompt: "hi" })).rejects.toMatchObject({ errorClass: "TIMEOUT" });
  });

  it("loop modes return repeated text classified as LOOP_DETECTED", async () => {
    for (const mode of ["LOOP_SENTENCE", "LOOP_PARAGRAPH"] as const) {
      const fake = new FakeAiProvider({ mode });
      const res = await fake.generateText({ prompt: "hi" });
      const sentences = res.text.split(". ");
      expect(sentences.length).toBeGreaterThan(3);
      expect(new Set(sentences).size).toBeLessThan(sentences.length);
      expect(PROPOSED_MODE_ERROR_MAP[mode]).toBe("LOOP_DETECTED");
    }
  });

  it("EMPTY / INVALID_JSON / TRUNCATED_JSON are INVALID_OUTPUT", async () => {
    const empty = new FakeAiProvider({ mode: "EMPTY" });
    expect((await empty.generateText({ prompt: "hi" })).text).toBe("");
    const invalid = new FakeAiProvider({ mode: "INVALID_JSON" });
    const invalidText = (await invalid.generateText({ prompt: "hi" })).text;
    expect(() => JSON.parse(invalidText)).toThrow();
    const truncated = new FakeAiProvider({ mode: "TRUNCATED_JSON" });
    const truncatedText = (await truncated.generateText({ prompt: "hi" })).text;
    expect(() => JSON.parse(truncatedText)).toThrow();
    expect(PROPOSED_MODE_ERROR_MAP.EMPTY).toBe("INVALID_OUTPUT");
    expect(PROPOSED_MODE_ERROR_MAP.INVALID_JSON).toBe("INVALID_OUTPUT");
    expect(PROPOSED_MODE_ERROR_MAP.TRUNCATED_JSON).toBe("INVALID_OUTPUT");
  });

  it("FENCED_JSON / PROSE_PLUS_JSON yield ONE recoverable object; multiples → INVALID_OUTPUT", async () => {
    const fenced = new FakeAiProvider({ mode: "FENCED_JSON" });
    const fencedText = (await fenced.analyzePhoto({ imageUri: "x", instruction: "y" })).text;
    const fencedOut = extractSingleJsonObject(fencedText);
    expect(fencedOut.count).toBe(1);
    expect(JSON.parse(fencedOut.json as string).objectName).toBe("black umbrella");
    const prose = new FakeAiProvider({ mode: "PROSE_PLUS_JSON" });
    const proseText = (await prose.analyzePhoto({ imageUri: "x", instruction: "y" })).text;
    const proseOut = extractSingleJsonObject(proseText);
    expect(proseOut.count).toBe(1);
    expect(JSON.parse(proseOut.json as string).objectName).toBe("black umbrella");
    expect(extractSingleJsonObject('{"a":1} {"b":2}').count).toBe(2);
  });

  it("WRONG_ACTION / UNKNOWN_ACTION map to UNSUPPORTED_ACTION preserving the mode", async () => {
    const wrong = new FakeAiProvider({ mode: "WRONG_ACTION" });
    expect(JSON.parse((await wrong.generateText({ prompt: "hi" })).text).action).toBe(
      "delete_someone_elses_post",
    );
    const unknown = new FakeAiProvider({ mode: "UNKNOWN_ACTION" });
    expect(JSON.parse((await unknown.generateText({ prompt: "hi" })).text).action).toBe(
      "teleport_item_home",
    );
    expect(diagnosticCodeForMode("WRONG_ACTION")).toBe("WRONG_ACTION");
    expect(diagnosticCodeForMode("UNKNOWN_ACTION")).toBe("UNKNOWN_ACTION");
  });

  it("REFUSAL maps to UNSUPPORTED_REQUEST with a refusal reason", async () => {
    const text = (await new FakeAiProvider({ mode: "REFUSAL" }).generateText({ prompt: "hi" })).text;
    expect(text).toBe(REFUSAL_TEXT);
    expect(PROPOSED_MODE_ERROR_MAP.REFUSAL).toBe("UNSUPPORTED_REQUEST");
    expect(diagnosticCodeForMode("REFUSAL")).toBe("REFUSAL_POLICY");
  });

  it("OOM / LOW_MEMORY share LOW_MEMORY class but keep distinct diagnostics", async () => {
    try {
      await new FakeAiProvider({ mode: "OOM" }).generateText({ prompt: "hi" });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ errorClass: "LOW_MEMORY", mode: "OOM", detail: "OOM_RUNTIME" });
    }
    try {
      await new FakeAiProvider({ mode: "LOW_MEMORY" }).generateText({ prompt: "hi" });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({
        errorClass: "LOW_MEMORY",
        mode: "LOW_MEMORY",
        detail: "PRECHECK_INSUFFICIENT_MEMORY",
      });
    }
    await expect(
      new FakeAiProvider({ mode: "RUNTIME_CRASH" }).generateText({ prompt: "hi" }),
    ).rejects.toMatchObject({ errorClass: "RUNTIME_ERROR" });
  });

  it("MODEL_MISSING rejects with MODEL_UNAVAILABLE; MODEL_CORRUPT with MODEL_CORRUPT", async () => {
    await expect(
      new FakeAiProvider({ mode: "MODEL_MISSING" }).generateText({ prompt: "hi" }),
    ).rejects.toMatchObject({ errorClass: "MODEL_UNAVAILABLE" });
    await expect(
      new FakeAiProvider({ mode: "MODEL_CORRUPT" }).generateText({ prompt: "hi" }),
    ).rejects.toMatchObject({ errorClass: "MODEL_CORRUPT", mode: "MODEL_CORRUPT" });
  });

  it("ambiguous location is ASK_USER, not an error", () => {
    expect(AMBIGUOUS_LOCATION_STATE).toBe("ASK_USER");
    expect(PROPOSED_MODE_ERROR_MAP.GOOD).toBeNull();
  });

  it("abort mid-generation rejects with CANCELLED and FakeAiError carries mode", async () => {
    const fake = new FakeAiProvider({ mode: "SLOW", slowDelayMs: 200 });
    const controller = new AbortController();
    const pending = fake.generateText({ prompt: "hi" }, controller.signal);
    controller.abort();
    try {
      await pending;
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FakeAiError);
      expect((err as FakeAiError).errorClass).toBe("CANCELLED");
    }
  });

  it("deleteModel then generate rejects MODEL_UNAVAILABLE; switchModel releases the old runtime", async () => {
    const fake = new FakeAiProvider({ mode: "GOOD" });
    fake.deleteModel("smolvlm2-500m");
    await expect(fake.generateText({ prompt: "hi" })).rejects.toMatchObject({
      errorClass: "MODEL_UNAVAILABLE",
    });
    const switcher = new FakeAiProvider({ mode: "GOOD" });
    switcher.switchModel("smolvlm-256m");
    expect(switcher.loadedModel()).toBe("smolvlm-256m");
    expect(switcher.releasedModels()).toEqual(["smolvlm2-500m"]);
    expect(() => switcher.switchModel("not-a-model")).toThrowError(/not installed/);
  });
});
