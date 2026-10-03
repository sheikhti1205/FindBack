/**
 * Provider registry (packet AI-024a): `ProviderId` → adapter wiring.
 *
 * Pure adapter wiring only. Every factory receives the caller's key through
 * the standard credential-getter seam
 * (`(accountId, provider) => key | null`, e.g.
 * `(accountId, provider) => aiCredentials.get(accountId, provider)`); no key
 * material is embedded, cached, or logged here, and errors never echo it.
 *
 * No policy lives here: no model choice, no catalog, no authorization, no
 * fallback. The two options that would require inventing caller-owned
 * content fail loudly instead:
 * - `generic` needs the caller-supplied endpoint (`genericBaseURL`);
 * - `openai` needs caller-owned framing (`assembleSystemText`).
 * Image resolution beyond the shared URL seam (`resolveImageUrl`) stays
 * packet-owned and is left unset, so image-bearing requests fail loudly in
 * the adapter instead of being silently downgraded.
 */
import { SUPPORTED_AI_PROVIDERS } from "../browserAiCredentials";
import type {
  CredentialHandle,
  NormalizedRequest,
  ProviderAdapter,
  ProviderId,
} from "./providerContract";
import { createAnthropicAdapter } from "./providers/anthropic";
import { createCohereAdapter } from "./providers/cohere";
import { createDeepSeekAdapter } from "./providers/deepseek";
import { createGenericAdapter } from "./providers/generic";
import { createGoogleAdapter } from "./providers/google";
import { createGroqAdapter } from "./providers/groq";
import { createMistralAdapter } from "./providers/mistral";
import { createOpenAiAdapter } from "./providers/openai";
import { createOpenRouterAdapter } from "./providers/openrouter";
import { createXaiAdapter } from "./providers/xai";
import { getApplicationAi, type ApplicationAiService } from "./applicationAi";

/**
 * Standard credential-getter seam. Returns the vault key for one
 * account/provider slot, or null when no key is available now.
 */
export type RegistryCredentialGetter = (
  accountId: string,
  provider: ProviderId,
) => Promise<string | null>;

export type ProviderRegistryOptions = {
  readonly offlineService?: ApplicationAiService;
  /** Owning account; its per-provider slot is the only slot ever read. */
  readonly accountId: string;
  /** Standard seam, e.g. `(accountId, provider) => aiCredentials.get(accountId, provider)`. */
  readonly resolveKey: RegistryCredentialGetter;
  /** Test seam; defaults to the ambient fetch. No test performs a real call. */
  readonly fetchImpl?: typeof fetch;
  /** Shared image-URL seam for the URL-based adapters. Packet-owned when set. */
  readonly resolveImageUrl?: (imageId: string) => Promise<string | null>;
  /** Caller-supplied OpenAI-compatible endpoint root. Required for `generic`. */
  readonly genericBaseURL?: string;
  /**
   * Account-scoped endpoint resolver for `generic` (e.g.
   * `(accountId) => loadGenericEndpoint(accountId)`). Used when
   * `genericBaseURL` is absent so catalogue, test, and send paths share one
   * configured URL. No default is ever invented: a generic key without an
   * endpoint stays unusable with a visible explanation.
   */
  readonly resolveGenericEndpoint?: (accountId: string) => string | null;
  /** Caller-owned system framing. Required for `openai`. */
  readonly assembleSystemText?: (request: NormalizedRequest) => string | undefined;
};

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([...SUPPORTED_AI_PROVIDERS, "offline"]);

function isKnownProvider(provider: unknown): provider is ProviderId {
  return typeof provider === "string" && KNOWN_PROVIDERS.has(provider);
}

/**
 * Build the adapter for one provider. Unknown ids throw a generic error
 * that never carries key material. Adapters resolve their credential
 * lazily per call through `resolveKey`, so rotation/removal takes effect
 * without rebuilding the adapter.
 */
export function createProviderAdapter(
  provider: ProviderId,
  options: ProviderRegistryOptions,
): ProviderAdapter {
  if (!isKnownProvider(provider)) throw new Error("Unknown AI provider.");
  const { accountId, resolveKey, fetchImpl, resolveImageUrl } = options;
  // Closure seam for the OpenAI-compatible factories: exactly this
  // account/provider slot, nothing else.
  const getApiKey = (): Promise<string | null> => resolveKey(accountId, provider);
  // Account-keyed seam for the factories that take the account per call.
  const getAccountKey = (id: string): Promise<string | null> =>
    resolveKey(id, provider as "anthropic" | "google");

  switch (provider) {
    case "openrouter":
      return createOpenRouterAdapter({ getApiKey, fetchImpl, resolveImageUrl });
    case "deepseek":
      return createDeepSeekAdapter({ getApiKey, fetchImpl, resolveImageUrl });
    case "mistral":
      return createMistralAdapter({ getApiKey, fetchImpl, resolveImageUrl });
    case "groq":
      return createGroqAdapter({ getApiKey, fetchImpl, resolveImageUrl });
    case "xai":
      return createXaiAdapter({ getApiKey, fetchImpl, resolveImageUrl });
    case "cohere":
      return createCohereAdapter({ getApiKey, fetchImpl, resolveImageUrl });
    case "anthropic":
      return createAnthropicAdapter({ getApiKey: getAccountKey, fetchImpl });
    case "google":
      return createGoogleAdapter({ getApiKey: getAccountKey, fetchImpl });
    case "generic": {
      const direct = options.genericBaseURL?.trim() ?? "";
      const stored =
        direct !== "" ? direct : (options.resolveGenericEndpoint?.(accountId)?.trim() ?? "");
      if (stored === "")
        throw new Error(
          "A generic key without an endpoint is unusable: set a custom endpoint base URL for this account first. No default endpoint is assumed.",
        );
      return createGenericAdapter({ baseURL: stored, getApiKey, fetchImpl, resolveImageUrl });
    }
    case "openai": {
      const assembleSystemText = options.assembleSystemText;
      if (assembleSystemText === undefined)
        throw new Error("OpenAI wiring needs caller-owned assembleSystemText.");
      const resolveCredential = (handle: CredentialHandle): Promise<string | null> =>
        resolveKey(handle.accountId, handle.provider);
      return createOpenAiAdapter({
        resolveCredential,
        resolveListCredential: () => resolveKey(accountId, "openai"),
        assembleSystemText,
        fetchImpl,
      });
    }
    case "offline":
      return (options.offlineService ?? getApplicationAi()).offlineAdapter(
        resolveImageUrl === undefined ? undefined : async (id) => {
          const url = await resolveImageUrl(id);
          const bytes = url?.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/)?.[1];
          if (!bytes) throw new Error("Approved local image bytes are unavailable");
          return bytes;
        },
      );
  }
}
