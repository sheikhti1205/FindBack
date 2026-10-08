import { describe, expect, it } from "vitest";
import { createOpenAiAdapter } from "./openai";
import { createOpenRouterAdapter } from "./openrouter";
import { createDeepSeekAdapter } from "./deepseek";
import { createGroqAdapter } from "./groq";
import { createMistralAdapter } from "./mistral";
import { createXaiAdapter } from "./xai";
import { createGenericAdapter } from "./generic";

const fetchRows = (data: unknown[]): typeof fetch => async () => new Response(JSON.stringify({ data }), {
  headers: { "Content-Type": "application/json" },
});

describe("adapter-owned catalogue qualification", () => {
  it("OpenAI qualifies conversational families, not audio/embedding/image/unknown endpoints", async () => {
    const adapter = createOpenAiAdapter({
      resolveCredential: async () => "test", resolveListCredential: async () => "test",
      assembleSystemText: () => "Test instructions",
      fetchImpl: fetchRows(["gpt-4o-mini", "gpt-4o-mini-transcribe", "tts-1", "text-embedding-3-small", "gpt-image-1", "future-model"].map((id) => ({ id }))),
    });
    const rows = await adapter.listModels!();
    expect(rows.map((r) => r.qualifiedRoles)).toEqual([["chat", "vision"], ["stt"], ["tts"], ["embeddings"], [], []]);
    expect(rows[0]?.displayName).toBe("GPT-4o mini");
  });

  it("Groq keeps Whisper and Orpheus out of Chat alongside unknown and guard models", async () => {
    const rows = await createGroqAdapter({ getApiKey: async () => "test", fetchImpl: fetchRows([
      "llama-3.3-70b-versatile", "whisper-large-v3", "canopylabs/orpheus-v1-english", "meta-llama/llama-prompt-guard-2-22m", "unknown",
    ].map((id) => ({ id }))) }).listModels!();
    expect(rows.map((r) => r.qualifiedRoles)).toEqual([["chat"], ["stt"], ["tts"], [], []]);
  });

  it("Mistral uses completion_chat evidence, not vision/function_calling alone", async () => {
    const rows = await createMistralAdapter({ getApiKey: async () => "test", fetchImpl: fetchRows([
      { id: "custom", name: "Custom assistant", capabilities: { completion_chat: true, vision: true } },
      { id: "vision-tool", capabilities: { vision: true, function_calling: true } },
      { id: "mistral-large-latest", capabilities: { completion_chat: false } },
    ]) }).listModels!();
    expect(rows.map((r) => r.qualifiedRoles)).toEqual([["chat", "vision"], [], []]);
    expect(rows[0]?.displayName).toBe("Custom assistant");
  });

  it("OpenRouter qualifies conversational endpoints with metadata and preserves upstream names", async () => {
    const rows = await createOpenRouterAdapter({ getApiKey: async () => "test", fetchImpl: fetchRows([
      { id: "openai/gpt-4o", name: "OpenAI: GPT-4o", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "image/tool", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "openrouter/free" },
      { id: "openai/text-embedding-3-small" },
    ]) }).listModels!();
    expect(rows.map((r) => r.qualifiedRoles)).toEqual([["chat", "vision"], [], ["chat"], ["embeddings"]]);
    expect(rows[0]?.displayName).toBe("OpenAI: GPT-4o");
  });

  it("DeepSeek and xAI qualify known text families but not arbitrary or image-generator IDs", async () => {
    const ds = await createDeepSeekAdapter({ getApiKey: async () => "test", fetchImpl: fetchRows([
      { id: "deepseek-chat" }, { id: "mystery", input_modalities: ["image"], output_modalities: ["text"] },
    ]) }).listModels!();
    const xai = await createXaiAdapter({ getApiKey: async () => "test", fetchImpl: fetchRows([
      { id: "grok-3" }, { id: "grok-imagine-image" }, { id: "unknown" },
    ]) }).listModels!();
    expect(ds.map((r) => r.qualifiedRoles)).toEqual([["chat"], []]);
    expect(xai.map((r) => r.qualifiedRoles)).toEqual([["chat"], [], []]);
  });

  it("an unknown compatible endpoint cannot borrow qualification from a familiar ID", async () => {
    const rows = await createGenericAdapter({ baseURL: "https://example.test/v1", getApiKey: async () => "test",
      fetchImpl: fetchRows([{ id: "gpt-4o", qualifiedRoles: ["chat"], capabilities: { completion_chat: true } }]),
    }).listModels!();
    expect(rows[0]?.qualifiedRoles).toEqual([]);
  });

  it("qualifies documented OpenRouter dialogue endpoints across model vendors", async () => {
    const rows = await createOpenRouterAdapter({ getApiKey: async () => "test", fetchImpl: fetchRows([
      { id: "google/gemini-2.5-flash", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "anthropic/claude-sonnet-4", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "qwen/qwen3-32b", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    ]) }).listModels!();
    expect(rows.map((r) => r.qualifiedRoles)).toEqual([["chat", "vision"], ["chat", "vision"], ["chat"]]);
  });
});
