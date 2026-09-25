import { CATEGORIES } from "@findback/shared";
import { createOpenRouterClient, OpenRouterError } from "./openRouter";
import { getConnectedOpenRouterKey } from "./aiCredentials";
import { normalizeImage } from "./image";
import { parseVlmOutput, type VlmAnalysis } from "./vlmParser";

interface PhotoDeps {
  encode(file: File): Promise<string>;
  send(prompt: string, image: string, consent: boolean): Promise<string>;
}

async function encodePhoto(file: File): Promise<string> {
  const normalized = await normalizeImage(file);
  if (normalized.blob.size > 2_000_000 || normalized.width > 1920 || normalized.height > 1920) {
    throw new OpenRouterError("INVALID_IMAGE");
  }
  const bytes = new Uint8Array(await normalized.blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${normalized.mimeType};base64,${btoa(binary)}`;
}

const PROMPT = `Analyze only what is visible in this lost-and-found item photo. Do not guess personal details.
Return one JSON object with ALL of these fields: objectName (string|null), suggestedCategory (string|null), colors (string[]), visibleBrand (string|null), visibleText (string[]), identifyingFeatures (string[]), suggestedTitle (string|null), suggestedDescription (string|null), uncertainFields (string[]).
Allowed suggestedCategory: ${JSON.stringify(CATEGORIES)}. Mark uncertain details in uncertainFields. Never invent identifying text.`;

/** Suggestions only. Form application is an independent, confirmed UI action. */
export async function analyzeReportPhoto(file: File, consent: boolean, deps?: PhotoDeps): Promise<VlmAnalysis> {
  if (!consent) throw new OpenRouterError("CONSENT_REQUIRED");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8_000_000) {
    throw new OpenRouterError("INVALID_IMAGE");
  }
  const image = await (deps?.encode ?? encodePhoto)(file);
  const text = await (deps?.send ?? ((prompt, data, confirmed) =>
    createOpenRouterClient(getConnectedOpenRouterKey).image(prompt, data, confirmed)))(PROMPT, image, consent);
  const parsed = parseVlmOutput(text, CATEGORIES);
  if (parsed === null) throw new OpenRouterError("UNUSABLE_RESPONSE");
  return parsed;
}
