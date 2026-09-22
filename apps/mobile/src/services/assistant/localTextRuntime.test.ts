import { describe, expect, it, vi } from "vitest";
import {
  resolveLocalTextRuntime,
  type LocalTextRuntimeSignals,
} from "./localTextRuntime";
import {
  QWEN_TEXT_BRIDGE_MODEL_ID,
  QWEN_TEXT_ENTRY_ID,
  type GenerateTextRequest,
  type GenerateTextResult,
} from "../models/textRuntime";
import { executeAssistantMessage } from "./assistantExecution";

function signals(
  overrides: Partial<LocalTextRuntimeSignals> = {},
): LocalTextRuntimeSignals {
  return {
    activeEntryId: QWEN_TEXT_ENTRY_ID,
    textRuntimePresent: true,
    installed: true,
    textReady: true,
    generateText: async (request: GenerateTextRequest) => ({
      text: `echo:${request.prompt.slice(0, 8)}`,
      modelId: request.modelId,
    }),
    ...overrides,
  };
}

describe("resolveLocalTextRuntime", () => {
  it("injects an explicit-modelId generator with the Qwen text profile", async () => {
    const seen: GenerateTextRequest[] = [];
    const generateText = vi.fn(
      async (request: GenerateTextRequest): Promise<GenerateTextResult> => {
        seen.push(request);
        return { text: "answer", modelId: request.modelId };
      },
    );
    const runtime = resolveLocalTextRuntime(signals({ generateText }));
    expect(runtime.generate).toBeDefined();
    expect(runtime.profile?.id).toBe("qwen3-0.6b-dynamic-int4");
    await expect(
      runtime.generate?.("hi", { maxOutputTokens: 64, temperature: 0 }),
    ).resolves.toBe("answer");
    expect(seen).toEqual([
      {
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        prompt: "hi",
        maxOutputTokens: 64,
        temperature: 0,
      },
    ]);
  });

  it("stays generator-free without active entry, bridge, or install", () => {
    expect(
      resolveLocalTextRuntime(signals({ activeEntryId: null })).generate,
    ).toBeUndefined();
    expect(
      resolveLocalTextRuntime(
        signals({ activeEntryId: "smolvlm2-500m-litert-int4" }),
      ).generate,
    ).toBeUndefined();
    expect(
      resolveLocalTextRuntime(signals({ textRuntimePresent: false })).generate,
    ).toBeUndefined();
    expect(resolveLocalTextRuntime(signals({ installed: false })).generate).toBe(
      undefined,
    );
  });

  it("stays generator-free when installed but TEXT_READY is not observed", () => {
    expect(resolveLocalTextRuntime(signals({ textReady: false })).generate).toBe(
      undefined,
    );
  });

  it("drives a model answer through the guard, else the grounded fallback", async () => {
    const modelRuntime = resolveLocalTextRuntime(
      signals({
        generateText: (() => {
          const queue = [
            '{"intent": "OPEN_QUESTION"}',
            "FindBack helps you search listings from the Search tab.",
          ];
          return async (
            request: GenerateTextRequest,
          ): Promise<GenerateTextResult> => ({
            text: queue.length > 1 ? (queue.shift() as string) : queue[0] as string,
            modelId: request.modelId,
          });
        })(),
      }),
    );
    const modeled = await executeAssistantMessage(
      null,
      "hello there friend",
      modelRuntime,
    );
    expect(modeled.replySource).toBe("model");
    expect(modeled.reply).toContain("Search tab");

    const grounded = await executeAssistantMessage(null, "How do I search?", {
      ...resolveLocalTextRuntime(signals({ activeEntryId: null })),
      answerAppQuestion: async () => ({
        text: "Use the Search tab filters.",
        source: "fallback" as const,
      }),
    });
    expect(grounded.replySource).toBe("grounded");
    expect(grounded.reply).toContain("Search tab");
  });
});
