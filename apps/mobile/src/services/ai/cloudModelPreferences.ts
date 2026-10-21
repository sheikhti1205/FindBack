/** Cloud-only preferences. No credentials or conversation text belong here.
 *
 * This module OWNS the Chat model choice (default, favorites, last used) and
 * does not mirror `aiPreferences.preferredAssistantModel`: that legacy field
 * stores a bare model id with no provider, so its provider cannot be known
 * without a catalogue. Migration is therefore catalogue-based and one-time:
 * a legacy id migrates only when exactly one cloud row in the supplied
 * catalogue carries that id. Ambiguous or local ids are never guessed, and
 * after the v1 record exists the legacy field is ignored for good.
 */
import { loadAiPreferences } from "./aiPreferences";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "./modelPolicy";
import type { ModelRecord, ProviderId } from "./providerContract";

export type CloudProvider = Exclude<ProviderId, "offline">;
export const CLOUD_PROVIDERS: readonly CloudProvider[] = ["openrouter", "openai", "anthropic", "google", "deepseek", "mistral", "groq", "xai", "cohere", "generic"];
export const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", google: "Gemini", deepseek: "DeepSeek",
  mistral: "Mistral", groq: "Groq", xai: "xAI", cohere: "Cohere", generic: "OpenAI-compatible",
};
export type CloudModel = { provider: CloudProvider; modelId: string };
export type CloudModelPreferences = { defaultModel: CloudModel | null; favorites: CloudModel[]; lastUsed: CloudModel[] };
/**
 * The route a fresh account starts on: the app's canonical default provider
 * and model (the same pair the controller's default selection uses). It is a
 * route, not a price promise: nothing here claims the model is free.
 */
export const CLOUD_DEFAULT_ROUTE: CloudModel = { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID };
export function sameCloudModel(a: CloudModel | null, b: CloudModel | null): boolean {
  return a !== null && b !== null && a.provider === b.provider && a.modelId === b.modelId;
}
function key(accountId: string) { return `findback.cloud.models.v1.${encodeURIComponent(accountId)}`; }
/**
 * A model id is a short, printable token: no whitespace and no control
 * characters, so a typed id can never smuggle a line break into a request.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function valid(value: unknown): value is CloudModel {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CloudModel>;
  if (!CLOUD_PROVIDERS.includes(entry.provider as CloudProvider)) return false;
  if (typeof entry.modelId !== "string") return false;
  const id = entry.modelId.trim();
  if (id.length === 0 || id.length > 256) return false;
  return !/\s/.test(id) && !hasControlCharacter(id);
}
function list(value: unknown): CloudModel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(valid).map(({ provider, modelId }) => ({ provider, modelId })).filter((item, index, all) => all.findIndex((other) => sameCloudModel(other, item)) === index).slice(0, 30);
}
function persist(accountId: string, value: CloudModelPreferences): CloudModelPreferences {
  globalThis.localStorage.setItem(key(accountId), JSON.stringify(value));
  return value;
}
export function loadCloudModelPreferences(accountId: string, catalog: readonly ModelRecord[] = []): CloudModelPreferences {
  const empty: CloudModelPreferences = { defaultModel: null, favorites: [], lastUsed: [] };
  try {
    const raw = globalThis.localStorage.getItem(key(accountId));
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return empty;
      const value = parsed as Partial<CloudModelPreferences>;
      return { defaultModel: valid(value.defaultModel) ? { provider: value.defaultModel.provider, modelId: value.defaultModel.modelId } : null, favorites: list(value.favorites), lastUsed: list(value.lastUsed) };
    }
    const legacy = loadAiPreferences(accountId).preferredAssistantModel;
    const candidates = catalog.filter((row) => row.provider !== "offline" && row.id === legacy);
    const migrated = legacy === DEFAULT_MODEL_ID
      ? CLOUD_DEFAULT_ROUTE
      : candidates.length === 1 ? { provider: candidates[0]!.provider as CloudProvider, modelId: legacy! } : null;
    if (migrated !== null) return persist(accountId, { ...empty, defaultModel: migrated });
  } catch { /* Corrupt/unavailable storage never crosses account boundaries. */ }
  return empty;
}
/**
 * The legacy cloud model id that could not be migrated, if any.
 *
 * The legacy field stores a bare model id with no provider, so it can only be
 * resolved against a catalogue that carries the id. Providers without a
 * catalogue endpoint (Anthropic, Google, Cohere) can never resolve it, and an
 * unknown id must never be guessed onto a provider. When that happens the
 * choice is not silently dropped: this returns the id so the surface can tell
 * the reader their previous model is still theirs to pick again.
 *
 * Returns null when there is nothing pending: no legacy choice, a legacy id
 * that already migrated, or a v1 record that exists (the legacy field is
 * ignored for good from then on).
 */
export function loadUnresolvedLegacyModelId(accountId: string): string | null {
  try {
    if (globalThis.localStorage.getItem(key(accountId)) !== null) return null;
    const legacy = loadAiPreferences(accountId).preferredAssistantModel;
    if (legacy === null) return null;
    const id = legacy.trim();
    if (id === "" || id === DEFAULT_MODEL_ID) return null;
    return id;
  } catch {
    return null;
  }
}
export function saveCloudModelDefault(accountId: string, model: CloudModel): CloudModelPreferences {
  if (!valid(model)) throw new Error("Enter a model ID without spaces (up to 256 characters).");
  return persist(accountId, { ...loadCloudModelPreferences(accountId), defaultModel: { provider: model.provider, modelId: model.modelId } });
}
export function toggleCloudFavorite(accountId: string, model: CloudModel): CloudModelPreferences {
  if (!valid(model)) throw new Error("Invalid model.");
  const prefs = loadCloudModelPreferences(accountId);
  const exists = prefs.favorites.some((item) => sameCloudModel(item, model));
  return persist(accountId, { ...prefs, favorites: exists ? prefs.favorites.filter((item) => !sameCloudModel(item, model)) : list([model, ...prefs.favorites]) });
}
export function recordCloudModelUsed(accountId: string, model: CloudModel): CloudModelPreferences {
  if (!valid(model)) throw new Error("Invalid model.");
  return persist(accountId, { ...loadCloudModelPreferences(accountId), lastUsed: list([model, ...loadCloudModelPreferences(accountId).lastUsed]) });
}
