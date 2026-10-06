import { describe, expect, it, vi } from "vitest";
import {
  SessionHealthTracker,
  classifyTextOutput,
  createGuardController,
  detectArrayRunaway,
  detectCharacterRunaway,
  detectLoop,
  detectLowNovelty,
  detectParagraphRepetition,
  detectRawEnumerationRunaway,
  detectRepeatedNgrams,
  detectSentenceRepetition,
  detectSingleKeyRunaway,
  guardedGenerate,
  stripGuardThoughtEnvelopes,
} from "./generationGuard";
import type { GuardProvider, GuardResult } from "./generationGuard";
import { GuardError } from "./errors";
import { FAULT_MODES, FakeAiProvider, REFUSAL_TEXT, extractSingleJsonObject } from "./testing/FakeAiProvider";
import type { FaultMode } from "./testing/FakeAiProvider";
import type { AiErrorClass } from "./errors";

const PHOTO_VALIDATE = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "objectName" in value;

const DENY_ALL_ACTIONS = { isSupportedAction: (_action: string): boolean => false };

function textProvider(text: string, modelId = "smolvlm2-500m"): GuardProvider & { calls: number } {
  const provider = {
    calls: 0,
    generateText: async (): Promise<GuardResult> => {
      provider.calls += 1;
      return { text, modelId };
    },
    analyzePhoto: async (): Promise<GuardResult> => {
      provider.calls += 1;
      return { text, modelId };
    },
  };
  return provider;
}

describe("sentence/paragraph repetition detectors", () => {
  it("flags the fake sentence loop, passes clean help text", async () => {
    const loop = (await new FakeAiProvider({ mode: "LOOP_SENTENCE" }).generateText({ prompt: "hi" })).text;
    expect(detectSentenceRepetition(loop)).toBe(true);
    expect(detectSentenceRepetition("Open the Report tab, choose Lost, fill the form, then Publish.")).toBe(false);
  });

  it("flags the fake paragraph loop", async () => {
    const loop = (await new FakeAiProvider({ mode: "LOOP_PARAGRAPH" }).generateText({ prompt: "hi" })).text;
    expect(detectParagraphRepetition(loop)).toBe(true);
    expect(detectLoop(loop).loop).toBe(true);
  });
});

describe("n-gram, novelty, and R3 enumeration caps", () => {
  it("flags evaluation-style enumeration streams via n-grams", () => {
    const enumeration = `OBJECT: laptop; keyboard; ${"coffee cup; coffee cup lid; ".repeat(40)}`;
    expect(detectRepeatedNgrams(enumeration)).toBe(true);
    expect(detectRawEnumerationRunaway(enumeration)).toBe(true);
    expect(detectLoop(enumeration).loop).toBe(true);
  });

  it("flags single-phrase tag repetition (book.fixb shape)", () => {
    const tags = `OBJECT: ${"<main object> ".repeat(80)}`.trim();
    expect(detectLoop(tags).loop).toBe(true);
  });

  it("flags low-novelty streams but not normal prose", () => {
    expect(detectLowNovelty(`${"coffee cup lid ".repeat(50)}`.trim())).toBe(true);
    expect(
      detectLowNovelty("Open the Report tab, choose Lost, fill the form with a title and Publish when ready."),
    ).toBe(false);
  });

  it("caps runaway arrays and passes diverse ones", () => {
    expect(detectArrayRunaway(new Array(12).fill("coffee cup"))).toBe(true);
    expect(detectArrayRunaway(new Array(12).fill(0))).toBe(true);
    expect(detectArrayRunaway(["wallet", "keys", "phone", "bag", "book", "watch", "jacket", "desk", "sign", "glasses", "umbrella", "headphones"])).toBe(
      false,
    );
    expect(detectArrayRunaway(["a", "b"])).toBe(false);
  });

  it("flags single-key xN object streams", () => {
    const stream = `{${new Array(16).fill('"tag": "x"').join(", ")}}`;
    expect(detectSingleKeyRunaway(stream)).toBe(true);
    expect(detectSingleKeyRunaway('{"objectName": "umbrella", "colors": ["black"]}')).toBe(false);
  });

  it("marks output-limit-reached-while-looping distinctly", () => {
    const loop = "Tap Report, then Lost. ".repeat(30).trim();
    const atLimit = detectLoop(loop, { truncatedAtLimit: true });
    expect(atLimit.reasons).toContain("OUTPUT_LIMIT_REACHED_WHILE_LOOPING");
    const clean = detectLoop("Open the Report tab, choose Lost, then Publish.", { truncatedAtLimit: true });
    expect(clean.loop).toBe(false);
  });
});

describe("output classification", () => {
  it("maps empty/refusal/action/multiples to their stable classes", () => {
    expect(classifyTextOutput("   ", { expectStructured: false }).errorClass).toBe("INVALID_OUTPUT");
    expect(classifyTextOutput(REFUSAL_TEXT, { expectStructured: false })).toMatchObject({
      ok: false,
      errorClass: "UNSUPPORTED_REQUEST",
    });
    expect(
      classifyTextOutput(JSON.stringify({ action: "teleport_item_home", args: {} }), {
        expectStructured: false,
        actionPolicy: DENY_ALL_ACTIONS,
      }).errorClass,
    ).toBe("UNSUPPORTED_ACTION");
    expect(classifyTextOutput('{"a":1} {"b":2}', { expectStructured: true }).errorClass).toBe("INVALID_OUTPUT");
    expect(classifyTextOutput("{objectName: broken, colors: [}", { expectStructured: true }).errorClass).toBe(
      "INVALID_OUTPUT",
    );
  });

  it("accepts supported actions and valid structured output", () => {
    const verdict = classifyTextOutput(JSON.stringify({ action: "file_report", args: {} }), {
      expectStructured: false,
      actionPolicy: { isSupportedAction: (action: string): boolean => action === "file_report" },
    });
    expect(verdict).toMatchObject({ ok: true, errorClass: null });
  });
});

describe("guardedGenerate over all 31 FakeAiProvider modes", () => {
  it("maps every mode to its stable class (null = success)", async () => {
    const expected: Record<FaultMode, AiErrorClass | null> = {
      GOOD: null,
      SLOW: null,
      TIMEOUT: "TIMEOUT",
      LOOP_SENTENCE: "LOOP_DETECTED",
      LOOP_PARAGRAPH: "LOOP_DETECTED",
      EMPTY: "INVALID_OUTPUT",
      INVALID_JSON: "INVALID_OUTPUT",
      FENCED_JSON: null,
      PROSE_PLUS_JSON: null,
      TRUNCATED_JSON: "INVALID_OUTPUT",
      WRONG_ACTION: "UNSUPPORTED_ACTION",
      UNKNOWN_ACTION: "UNSUPPORTED_ACTION",
      REFUSAL: "UNSUPPORTED_REQUEST",
      OOM: "LOW_MEMORY",
      RUNTIME_CRASH: "RUNTIME_ERROR",
      MODEL_MISSING: "MODEL_UNAVAILABLE",
      MODEL_CORRUPT: "MODEL_CORRUPT",
      LOW_MEMORY: "LOW_MEMORY",
      CANCELLED: "CANCELLED",
      HTTP_DROP: "MODEL_UNAVAILABLE",
      WRONG_CONTENT_RANGE: "MODEL_CORRUPT",
      HASH_MISMATCH: "MODEL_CORRUPT",
      DISK_FULL: "LOW_MEMORY",
      GPU_INIT_ERROR: "RUNTIME_ERROR",
      NPU_ABSENT: "RUNTIME_ERROR",
      INVALID_UTF8: "INVALID_OUTPUT",
      PROCESS_DEATH: "RUNTIME_ERROR",
      TWO_VLM_RACE: "RUNTIME_ERROR",
      MODEL_UPDATE_DURING_INFERENCE: "RUNTIME_ERROR",
      CLOUD_OFFLINE: "UNSUPPORTED_REQUEST",
      PATH_TRAVERSAL: "UNSUPPORTED_REQUEST",
    };
    expect(Object.keys(expected)).toHaveLength(31);
    for (const mode of FAULT_MODES as FaultMode[]) {
      const provider = new FakeAiProvider({ mode, slowDelayMs: 10, timeoutMs: 10 });
      const photoKind = mode === "EMPTY" || mode === "INVALID_JSON" || mode === "TRUNCATED_JSON" || mode === "FENCED_JSON" || mode === "PROSE_PLUS_JSON" || mode === "INVALID_UTF8";
      const attempt = guardedGenerate({
        provider,
        kind: photoKind ? "photo" : "text",
        prompt: "hi",
        imageUri: "x",
        instruction: "describe",
        expectStructured: photoKind,
        validate: PHOTO_VALIDATE,
        actionPolicy: DENY_ALL_ACTIONS,
        faultMode: mode,
      });
      if (expected[mode] === null) {
        const res = await attempt;
        expect(res.text.length).toBeGreaterThan(0);
      } else {
        await expect(attempt).rejects.toMatchObject({ errorClass: expected[mode] });
      }
    }
  });

  it("GOOD succeeds on text and photo paths", async () => {
    const provider = new FakeAiProvider({ mode: "GOOD" });
    const text = await guardedGenerate({ provider, kind: "text", prompt: "hi", expectStructured: false });
    expect(text.text).toContain("Report tab");
    expect(text.attempts).toBe(1);
    const photo = await guardedGenerate({
      provider,
      kind: "photo",
      imageUri: "x",
      instruction: "describe",
      expectStructured: true,
      validate: PHOTO_VALIDATE,
    });
    expect(JSON.parse(photo.text).objectName).toBe("black umbrella");
  });

  it("SLOW is latency, never an error; the guard deadline still applies", async () => {
    const slow = new FakeAiProvider({ mode: "SLOW", slowDelayMs: 10 });
    const ok = await guardedGenerate({ provider: slow, kind: "text", prompt: "hi", expectStructured: false, deadlineMs: 2000 });
    expect(ok.text.length).toBeGreaterThan(0);
    const tight = new FakeAiProvider({ mode: "SLOW", slowDelayMs: 300 });
    await expect(
      guardedGenerate({ provider: tight, kind: "text", prompt: "hi", expectStructured: false, deadlineMs: 5 }),
    ).rejects.toMatchObject({ errorClass: "TIMEOUT" });
  });

  it("TIMEOUT rejects as TIMEOUT", async () => {
    await expect(
      guardedGenerate({
        provider: new FakeAiProvider({ mode: "TIMEOUT", timeoutMs: 10 }),
        kind: "text",
        prompt: "hi",
        expectStructured: false,
      }),
    ).rejects.toMatchObject({ errorClass: "TIMEOUT" });
  });

  it("loop modes surface LOOP_DETECTED after exactly one retry", async () => {
    for (const mode of ["LOOP_SENTENCE", "LOOP_PARAGRAPH"] as const) {
      try {
        await guardedGenerate({
          provider: new FakeAiProvider({ mode }),
          kind: "text",
          prompt: "hi",
          expectStructured: false,
          faultMode: mode,
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(GuardError);
        expect(error).toMatchObject({ errorClass: "LOOP_DETECTED", attempts: 2 });
      }
    }
  });

  it("EMPTY/INVALID/TRUNCATED surface INVALID_OUTPUT on the structured path", async () => {
    for (const mode of ["EMPTY", "INVALID_JSON", "TRUNCATED_JSON"] as const) {
      await expect(
        guardedGenerate({
          provider: new FakeAiProvider({ mode }),
          kind: "photo",
          imageUri: "x",
          instruction: "describe",
          expectStructured: true,
          validate: PHOTO_VALIDATE,
          faultMode: mode,
        }),
      ).rejects.toMatchObject({ errorClass: "INVALID_OUTPUT" });
    }
  });

  it("FENCED/PROSE yield one recoverable object and succeed", async () => {
    for (const mode of ["FENCED_JSON", "PROSE_PLUS_JSON"] as const) {
      const res = await guardedGenerate({
        provider: new FakeAiProvider({ mode }),
        kind: "photo",
        imageUri: "x",
        instruction: "describe",
        expectStructured: true,
        validate: PHOTO_VALIDATE,
        faultMode: mode,
      });
      const extracted = extractSingleJsonObject(res.text);
      expect(extracted.count).toBe(1);
      expect(JSON.parse(extracted.json as string).objectName).toBe("black umbrella");
    }
  });

  it("WRONG/UNKNOWN actions are rejected without retry", async () => {
    for (const mode of ["WRONG_ACTION", "UNKNOWN_ACTION"] as const) {
      try {
        await guardedGenerate({
          provider: new FakeAiProvider({ mode }),
          kind: "text",
          prompt: "hi",
          expectStructured: false,
          actionPolicy: DENY_ALL_ACTIONS,
          faultMode: mode,
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ errorClass: "UNSUPPORTED_ACTION", attempts: 1 });
      }
    }
  });

  it("REFUSAL maps to UNSUPPORTED_REQUEST", async () => {
    await expect(
      guardedGenerate({
        provider: new FakeAiProvider({ mode: "REFUSAL" }),
        kind: "text",
        prompt: "hi",
        expectStructured: false,
        faultMode: "REFUSAL",
      }),
    ).rejects.toMatchObject({ errorClass: "UNSUPPORTED_REQUEST" });
  });

  it("OOM/LOW_MEMORY share LOW_MEMORY with distinct diagnostics", async () => {
    try {
      await guardedGenerate({
        provider: new FakeAiProvider({ mode: "OOM" }),
        kind: "text",
        prompt: "hi",
        expectStructured: false,
        faultMode: "OOM",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ errorClass: "LOW_MEMORY", diagnosticCode: "OOM_RUNTIME" });
    }
    try {
      await guardedGenerate({
        provider: new FakeAiProvider({ mode: "LOW_MEMORY" }),
        kind: "text",
        prompt: "hi",
        expectStructured: false,
        faultMode: "LOW_MEMORY",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ errorClass: "LOW_MEMORY", diagnosticCode: "PRECHECK_INSUFFICIENT_MEMORY" });
    }
  });

  it("RUNTIME_CRASH/MODEL_MISSING/MODEL_CORRUPT map without auto-retry", async () => {
    await expect(
      guardedGenerate({ provider: new FakeAiProvider({ mode: "RUNTIME_CRASH" }), kind: "text", prompt: "hi", expectStructured: false }),
    ).rejects.toMatchObject({ errorClass: "RUNTIME_ERROR" });
    await expect(
      guardedGenerate({ provider: new FakeAiProvider({ mode: "MODEL_MISSING" }), kind: "text", prompt: "hi", expectStructured: false }),
    ).rejects.toMatchObject({ errorClass: "MODEL_UNAVAILABLE" });
    try {
      await guardedGenerate({
        provider: new FakeAiProvider({ mode: "MODEL_CORRUPT" }),
        kind: "text",
        prompt: "hi",
        expectStructured: false,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ errorClass: "MODEL_CORRUPT", attempts: 1 });
      expect((error as GuardError).recovery.actions).toEqual(["Repair model", "Delete model"]);
    }
  });

  it("CANCELLED mode and mid-flight abort both surface CANCELLED, never success", async () => {
    await expect(
      guardedGenerate({ provider: new FakeAiProvider({ mode: "CANCELLED" }), kind: "text", prompt: "hi", expectStructured: false }),
    ).rejects.toMatchObject({ errorClass: "CANCELLED" });
    const slow = new FakeAiProvider({ mode: "SLOW", slowDelayMs: 300 });
    const controller = new AbortController();
    const pending = guardedGenerate({ provider: slow, kind: "text", prompt: "hi", expectStructured: false, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ errorClass: "CANCELLED" });
  });
});

describe("single-retry policy", () => {
  it("recovers on the one allowed retry, then stops", async () => {
    const loopText = "Tap Report, then Lost. ".repeat(12).trim();
    const flaky = textProvider(loopText);
    let attempts = 0;
    flaky.generateText = async (): Promise<GuardResult> => {
      attempts += 1;
      flaky.calls += 1;
      if (attempts === 1) return { text: loopText, modelId: "smolvlm2-500m" };
      return { text: "Open the Report tab, choose Lost, then Publish.", modelId: "smolvlm2-500m" };
    };
    const res = await guardedGenerate({ provider: flaky, kind: "text", prompt: "hi", expectStructured: false });
    expect(res.retried).toBe(true);
    expect(res.attempts).toBe(2);
    expect(flaky.calls).toBe(2);
  });

  it("never loops hidden retries on persistent failure", async () => {
    const stuck = textProvider("Tap Report, then Lost. ".repeat(12).trim());
    await expect(guardedGenerate({ provider: stuck, kind: "text", prompt: "hi", expectStructured: false })).rejects.toMatchObject(
      { errorClass: "LOOP_DETECTED", attempts: 2 },
    );
    expect(stuck.calls).toBe(2);
  });
});

describe("session health", () => {
  it("needs repetition before condemning a model, session-only", () => {
    const tracker = new SessionHealthTracker();
    expect(tracker.health("m")).toBe("HEALTHY");
    expect(tracker.record("m", "INVALID_OUTPUT")).toBe("DEGRADED");
    expect(tracker.health("m")).toBe("DEGRADED");
    expect(tracker.record("m", "OK")).toBe("DEGRADED");
    expect(tracker.record("m", "LOOP_DETECTED")).toBe("DEGRADED");
    expect(tracker.record("m", "RUNTIME_ERROR")).toBe("UNSTABLE_THIS_SESSION");
    expect(new SessionHealthTracker().health("m")).toBe("HEALTHY");
  });

  it("marks unstable on repeated loops alone", () => {
    const tracker = new SessionHealthTracker();
    tracker.record("m", "LOOP_DETECTED");
    expect(tracker.record("m", "LOOP_DETECTED")).toBe("UNSTABLE_THIS_SESSION");
  });
});

describe("R3 interrupt", () => {
  it("omitting deadlineMs never invents a guard budget", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (result: GuardResult) => void;
      let signal: AbortSignal | undefined;
      const provider = textProvider("unused");
      provider.generateText = (_request, nextSignal) => {
        signal = nextSignal;
        return new Promise((resolve) => { finish = resolve; });
      };
      let settled = false;
      const pending = guardedGenerate({ provider, kind: "text", expectStructured: false });
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(false);
      finish({ text: "Open the Report tab.", modelId: "lab" });
      await expect(pending).resolves.toMatchObject({ attempts: 1, retried: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts via AbortSignal where the runtime allows it", () => {
    const linked = new AbortController();
    const guard = createGuardController(linked.signal);
    expect(guard.signal.aborted).toBe(false);
    guard.interrupt();
    expect(guard.signal.aborted).toBe(true);
    const preAborted = createGuardController(new AbortController().signal);
    expect(preAborted.signal.aborted).toBe(false);
  });

  it("deadline interrupts the runaway and never starts an overlapping retry", async () => {
    let calls = 0;
    let seenSignal: AbortSignal | undefined;
    const hanging: GuardProvider = {
      generateText: (_request, signal): Promise<GuardResult> => {
        calls += 1;
        seenSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted mid-generation")), { once: true });
        });
      },
      analyzePhoto: (_request, signal): Promise<GuardResult> => {
        calls += 1;
        seenSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted mid-generation")), { once: true });
        });
      },
    };
    await expect(
      guardedGenerate({ provider: hanging, kind: "text", prompt: "hi", expectStructured: false, deadlineMs: 10 }),
    ).rejects.toMatchObject({ errorClass: "TIMEOUT", diagnosticCode: "GUARD_DEADLINE_EXCEEDED", attempts: 1 });
    expect(calls).toBe(1);
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe("generation policy propagation (M1)", () => {
  it("forwards caller caps to the provider", async () => {
    const provider = new FakeAiProvider({ mode: "GOOD" });
    await guardedGenerate({
      provider,
      kind: "text",
      prompt: "hi",
      expectStructured: false,
      maxOutputTokens: 300,
      temperature: 0.2,
    });
    expect(provider.textRequests).toHaveLength(1);
    expect(provider.textRequests[0]).toMatchObject({ prompt: "hi", maxOutputTokens: 300, temperature: 0.2 });
  });

  it("restores the evidence envelope by default (256 text / 512 photo at 0.0)", async () => {
    const provider = new FakeAiProvider({ mode: "GOOD" });
    await guardedGenerate({ provider, kind: "text", prompt: "hi", expectStructured: false });
    expect(provider.textRequests[0]).toMatchObject({ maxOutputTokens: 256, temperature: 0 });
    await guardedGenerate({
      provider,
      kind: "photo",
      imageUri: "x",
      instruction: "describe",
      expectStructured: true,
      validate: PHOTO_VALIDATE,
    });
    expect(provider.photoRequests[0]).toMatchObject({ maxOutputTokens: 512, temperature: 0 });
  });
});

describe("character-level runaway detector (M5)", () => {
  it("flags the T24 shape: a ~98-zero mega-token run word detectors miss", () => {
    const prefix = Array.from({ length: 280 }, (_, i) => `note${i}`).join(" ");
    const text = `${prefix} ${"0".repeat(98)}`;
    expect(detectSentenceRepetition(text)).toBe(false);
    expect(detectRepeatedNgrams(text)).toBe(false);
    expect(detectRawEnumerationRunaway(text)).toBe(false);
    expect(detectCharacterRunaway(text)).toBe(true);
    const loop = detectLoop(text);
    expect(loop.loop).toBe(true);
    expect(loop.reasons).toContain("CHARACTER_RUNAWAY");
    expect(classifyTextOutput("0".repeat(98), { expectStructured: false })).toMatchObject({
      ok: false,
      errorClass: "LOOP_DETECTED",
      diagnosticCode: "CHARACTER_RUNAWAY",
    });
  });

  it("flags the BV10 shape: 2501 chars in a couple of mega-tokens", () => {
    const text = `${"A".repeat(1250)} ${"B".repeat(1250)}`;
    expect(text.length).toBe(2501);
    expect(detectCharacterRunaway(text)).toBe(true);
    expect(detectLoop(text).reasons).toContain("CHARACTER_RUNAWAY");
  });

  it("does not flag normal prose or structured photo output", () => {
    expect(detectCharacterRunaway("Open the Report tab, choose Lost, fill the form, then Publish.")).toBe(false);
    expect(
      detectCharacterRunaway(
        JSON.stringify({ objectName: "black umbrella", colors: ["black"], identifyingFeatures: ["curved wooden handle"] }),
      ),
    ).toBe(false);
  });
});

describe("thought seam (post-R2 verdicts)", () => {
  it("T03 shape: sentence-loop thought plus clean answer is not LOOP", () => {
    const raw = `[thought]${"Tap Report, then Lost. ".repeat(12).trim()}[/thought]Open the Report tab, choose Lost, then Publish.`;
    expect(detectLoop(raw).loop).toBe(true);
    expect(stripGuardThoughtEnvelopes(raw)).toBe("Open the Report tab, choose Lost, then Publish.");
    expect(classifyTextOutput(raw, { expectStructured: false })).toMatchObject({ ok: true, errorClass: null });
  });

  it("T18 shape: looping thought plus honest-unavailable answer is not LOOP", () => {
    const raw = `[thought]${"The item might be lost. ".repeat(12).trim()}[/thought]I do not have enough information to identify this item from the photo.`;
    expect(classifyTextOutput(raw, { expectStructured: false })).toMatchObject({ ok: true, errorClass: null });
  });

  it("T25 shape: paragraph-loop thought plus clean prose is not LOOP", () => {
    const thought =
      "To report a lost item, open the Report tab and choose Lost. Fill in the title, description, category, date and map location. Publish when ready. ";
    const raw = `[thought]${thought.repeat(4).trim()}[/thought]Here is how to file a lost-item report from the Report tab.`;
    expect(classifyTextOutput(raw, { expectStructured: false })).toMatchObject({ ok: true, errorClass: null });
  });

  it("thought-only output stays INVALID_OUTPUT and never surfaces reasoning", () => {
    const raw = `[thought]${"Tap Report, then Lost. ".repeat(12).trim()}[/thought]`;
    expect(classifyTextOutput(raw, { expectStructured: false })).toMatchObject({ ok: false, errorClass: "INVALID_OUTPUT" });
  });
});
