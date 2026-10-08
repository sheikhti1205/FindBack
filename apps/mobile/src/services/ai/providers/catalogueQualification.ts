/**
 * Catalogue qualification is provider-owned, not an I/O heuristic.
 * Reviewed 2026-10-08 against:
 * https://developers.openai.com/api/docs/models
 * https://console.groq.com/docs/models
 * https://docs.mistral.ai/api/endpoint/models (capabilities.completion_chat)
 * https://docs.x.ai/developers/models (Text vs Imagine/Voice APIs)
 * https://api-docs.deepseek.com/quick_start/pricing
 * https://openrouter.ai/docs/guides/overview/models
 * https://openrouter.ai/api/v1/models/{id}/endpoints (Gemini 2.5 Flash,
 * Claude Sonnet 4, Qwen3 32B, Llama 3 8B Instruct — dialogue endpoints).
 *
 * Known chat families / aliases are deliberately bounded. New IDs require
 * review, not an automatic role claim. Generic OpenAI-compatible hosts have
 * no documented model contract and cannot borrow official-provider evidence.
 * Roles describe product tasks, not entitlement or a latency/quality promise.
 */
import type { ModelRecord, ProviderId, UiModelRole } from "../providerContract";

type Qualification = { readonly title: string; readonly roles: readonly UiModelRole[] };
const chat = (title: string): Qualification => ({ title, roles: ["chat"] });
const vision = (title: string): Qualification => ({ title, roles: ["chat", "vision"] });
const speech = (title: string, role: "stt" | "tts"): Qualification => ({ title, roles: [role] });

const OPENAI: Readonly<Record<string, Qualification>> = {
  "gpt-3.5-turbo": chat("GPT-3.5 Turbo"),
  "gpt-4": chat("GPT-4"),
  "gpt-4-turbo": vision("GPT-4 Turbo"),
  "gpt-4o": vision("GPT-4o"),
  "gpt-4o-mini": vision("GPT-4o mini"),
  "gpt-4.1": vision("GPT-4.1"),
  "gpt-4.1-mini": vision("GPT-4.1 mini"),
  "gpt-4.1-nano": vision("GPT-4.1 nano"),
  "gpt-5": vision("GPT-5"),
  "gpt-5-mini": vision("GPT-5 mini"),
  "gpt-5-nano": vision("GPT-5 nano"),
  "o1": vision("o1"),
  "o1-mini": chat("o1 mini"),
  "o3": vision("o3"),
  "o3-mini": chat("o3 mini"),
  "o4-mini": vision("o4 mini"),
  "whisper-1": speech("Whisper", "stt"),
  "gpt-4o-transcribe": speech("GPT-4o Transcribe", "stt"),
  "gpt-4o-mini-transcribe": speech("GPT-4o mini Transcribe", "stt"),
  "gpt-4o-transcribe-diarize": speech("GPT-4o Transcribe Diarize", "stt"),
  "tts-1": speech("TTS 1", "tts"),
  "tts-1-hd": speech("TTS 1 HD", "tts"),
  "gpt-4o-mini-tts": speech("GPT-4o mini TTS", "tts"),
  "text-embedding-3-small": { title: "Text Embedding 3 Small", roles: ["embeddings"] },
  "text-embedding-3-large": { title: "Text Embedding 3 Large", roles: ["embeddings"] },
  "text-embedding-ada-002": { title: "Text Embedding Ada 002", roles: ["embeddings"] },
};
const GROQ: Readonly<Record<string, Qualification>> = {
  "llama-3.1-8b-instant": chat("Llama 3.1 8B"),
  "llama-3.3-70b-versatile": chat("Llama 3.3 70B"),
  "openai/gpt-oss-20b": chat("GPT OSS 20B"),
  "openai/gpt-oss-120b": chat("GPT OSS 120B"),
  "qwen/qwen3-32b": chat("Qwen3 32B"),
  "whisper-large-v3": speech("Whisper Large V3", "stt"),
  "whisper-large-v3-turbo": speech("Whisper Large V3 Turbo", "stt"),
  "canopylabs/orpheus-v1-english": speech("Orpheus English", "tts"),
  "canopylabs/orpheus-arabic-saudi": speech("Orpheus Arabic Saudi", "tts"),
};
const MISTRAL: Readonly<Record<string, Qualification>> = {
  "mistral-large-latest": chat("Mistral Large"),
  "mistral-small-latest": chat("Mistral Small"),
  "open-mistral-7b": chat("Mistral 7B"),
  "pixtral-12b-2409": vision("Pixtral 12B"),
  "pixtral-large-latest": vision("Pixtral Large"),
  "mistral-embed": { title: "Mistral Embed", roles: ["embeddings"] },
};
const DEEPSEEK: Readonly<Record<string, Qualification>> = {
  "deepseek-chat": chat("DeepSeek Chat"),
  "deepseek-reasoner": chat("DeepSeek Reasoner"),
  "deepseek-flash": chat("DeepSeek Flash"),
  "deepseek-v4-pro": chat("DeepSeek V4 Pro"),
};
const XAI: Readonly<Record<string, Qualification>> = {
  "grok-2": chat("Grok 2"),
  "grok-2-latest": chat("Grok 2"),
  "grok-2-vision-latest": vision("Grok 2 Vision"),
  "grok-3": chat("Grok 3"),
  "grok-3-mini": chat("Grok 3 mini"),
  "grok-3-latest": chat("Grok 3"),
  "grok-4": vision("Grok 4"),
  "grok-4-0709": vision("Grok 4"),
  "grok-4-fast-reasoning": vision("Grok 4 Fast Reasoning"),
  "grok-4-fast-non-reasoning": vision("Grok 4 Fast"),
};
const OPENROUTER_DIALOGUE: Readonly<Record<string, Qualification>> = {
  "google/gemini-2.5-flash": vision("Gemini 2.5 Flash"),
  "anthropic/claude-sonnet-4": vision("Claude Sonnet 4"),
  "qwen/qwen3-32b": chat("Qwen3 32B"),
  "meta-llama/llama-3-8b-instruct": chat("Llama 3 8B Instruct"),
};

function knownQualification(provider: ProviderId, id: string): Qualification | undefined {
  switch (provider) {
    case "openai": return OPENAI[id.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
    case "groq": return GROQ[id];
    case "mistral": return MISTRAL[id];
    case "deepseek": return DEEPSEEK[id];
    case "xai": return XAI[id];
    case "openrouter": {
      if (id === "openrouter/free") return chat("Free model router");
      const withoutFree = id.replace(/:free$/, "");
      if (OPENROUTER_DIALOGUE[withoutFree] !== undefined) return OPENROUTER_DIALOGUE[withoutFree];
      const slash = withoutFree.indexOf("/");
      const vendor = withoutFree.slice(0, slash);
      const upstreamId = withoutFree.slice(slash + 1);
      if (vendor === "openai") return knownQualification("openai", upstreamId);
      if (vendor === "x-ai") return knownQualification("xai", upstreamId);
      if (vendor === "deepseek") return DEEPSEEK[upstreamId];
      if (vendor === "mistralai") return MISTRAL[upstreamId];
      return undefined;
    }
    default: return undefined;
  }
}

export function curatedCloudModelName(provider: ProviderId, id: string): string | undefined {
  return knownQualification(provider, id)?.title;
}

/** Only call from an adapter for its documented endpoint (never trust wire qualifiedRoles). */
export function cloudCatalogMetadata(
  provider: ProviderId,
  id: string,
  evidence: { readonly name?: unknown; readonly input?: readonly string[]; readonly output?: readonly string[]; readonly capabilities?: unknown } = {},
): Pick<ModelRecord, "displayName" | "qualifiedRoles"> {
  const known = knownQualification(provider, id);
  let roles = known?.roles ?? [];
  if (provider === "mistral" && typeof evidence.capabilities === "object" && evidence.capabilities !== null) {
    const caps = evidence.capabilities as Record<string, unknown>;
    // An explicit refusal outranks a known-family fallback. Vision alone
    // (e.g. OCR) and function calling alone never establish conversation.
    if (caps["completion_chat"] === true) roles = caps["vision"] === true ? ["chat", "vision"] : ["chat"];
    else if (caps["completion_chat"] === false) roles = [];
  }
  if (roles.includes("chat") && provider === "openrouter" && evidence.input !== undefined) {
    // Listed modalities can restrict a known conversational family, never
    // qualify an unknown family. No image-generation or embedding promotion.
    if (evidence.output !== undefined && evidence.output.length > 0 && !evidence.output.includes("text")) roles = [];
    else roles = evidence.input.includes("image") ? ["chat", "vision"] : ["chat"];
  }
  if (roles.includes("chat") && provider === "deepseek" && evidence.input?.includes("image")) roles = ["chat", "vision"];
  const title = typeof evidence.name === "string" ? evidence.name.trim() : "";
  const displayName = title !== "" && title !== id ? title : known?.title;
  return { ...(displayName === undefined ? {} : { displayName }), qualifiedRoles: roles };
}
