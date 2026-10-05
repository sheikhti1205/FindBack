import { Capacitor, registerPlugin } from "@capacitor/core";
import type { CredentialHandle, ProviderId } from "./ai/providerContract";
import {
  SUPPORTED_AI_PROVIDERS,
  aiCredentialHandle,
  createBrowserAiCredentials,
  resolveAiProvider,
} from "./browserAiCredentials";
import { storage } from "./storage";
import { getSupabase } from "./supabaseClient";

export { SUPPORTED_AI_PROVIDERS };
export type { CredentialHandle, ProviderId };

/** Display labels for the cloud-connection summary. No key material. */
export const CLOUD_PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  xai: "xAI",
  cohere: "Cohere",
  generic: "Custom endpoint",
  offline: "On-device",
};

/** Credential-presence summary. Carries provider ids + display text only. */
export type CloudConnectionSummary = {
  connected: boolean;
  count: number;
  providers: readonly ProviderId[];
  summary: string;
};

/**
 * Truthful display text for a set of connected providers. Input is provider
 * ids only — never key material — so the output cannot leak secrets.
 */
export function cloudConnectionsSummary(providers: readonly ProviderId[]): string {
  const unique: ProviderId[] = [];
  for (const provider of providers) {
    if ((SUPPORTED_AI_PROVIDERS as readonly string[]).includes(provider) && !unique.includes(provider)) {
      unique.push(provider);
    }
  }
  if (unique.length === 0) return "Not connected";
  const [first] = unique;
  if (unique.length === 1 && first !== undefined) return `${CLOUD_PROVIDER_LABELS[first]} connected`;
  if (unique.length === 1) return "Not connected";
  return `${unique.length} connections`;
}

interface NativeKeyBridge {
  set(options: { userId: string; key: string; provider?: string }): Promise<void>;
  get(options: { userId: string; provider?: string }): Promise<{ key: string | null }>;
  remove(options: { userId: string; provider?: string }): Promise<void>;
}

export interface AiConnectOptions {
  remember: boolean;
  passphrase?: string;
  provider?: ProviderId;
}

const browser = createBrowserAiCredentials(storage);
const session = new Map<string, string>();
let bridge: NativeKeyBridge | null = null;

function native(): NativeKeyBridge | null {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return null;
  bridge ??= registerPlugin<NativeKeyBridge>("OpenRouterKey");
  return bridge;
}

function sessionKey(userId: string, provider: ProviderId): string {
  return `${provider}\0${userId}`;
}

/**
 * Presence probes stay fail-closed: an unknown provider slot simply holds
 * nothing (null/false) instead of throwing.
 */
function lenientProvider(provider: unknown): ProviderId | null {
  try {
    return resolveAiProvider(provider);
  } catch {
    return null;
  }
}

function isHandleShape(value: unknown): value is CredentialHandle {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["accountId"] === "string" &&
    (candidate["accountId"] as string).length > 0 &&
    typeof candidate["provider"] === "string" &&
    (SUPPORTED_AI_PROVIDERS as readonly string[]).includes(candidate["provider"] as string) &&
    typeof candidate["handle"] === "string" &&
    (candidate["handle"] as string).length > 0
  );
}

/** Never store credentials in plaintext in browser persistence or app configuration. */
export const aiCredentials = {
  async connect(userId: string, key: string, options: AiConnectOptions): Promise<void> {
    const provider = resolveAiProvider(options.provider);
    const android = native();
    if (!android) {
      await browser.connect(userId, key, { ...options, provider });
      return;
    }
    if (!userId || !key.trim()) throw new Error("A user and API key are required.");
    if (options.remember) await android.set({ userId, key: key.trim(), provider });
    else await android.remove({ userId, provider });
    session.set(sessionKey(userId, provider), key.trim());
  },
  async get(userId: string, provider?: ProviderId): Promise<string | null> {
    if (!userId) return null;
    const slot = lenientProvider(provider);
    if (!slot) return null;
    if (!native()) return browser.get(userId, slot);
    const namespaced = sessionKey(userId, slot);
    if (session.has(namespaced)) return session.get(namespaced)!;
    return (await native()!.get({ userId, provider: slot })).key;
  },
  async hasSaved(userId: string, provider?: ProviderId): Promise<boolean> {
    if (!userId) return false;
    const slot = lenientProvider(provider);
    if (!slot) return false;
    const android = native();
    return android ? !!(await android.get({ userId, provider: slot })).key : browser.hasSaved(userId, slot);
  },
  async unlock(userId: string, passphrase: string, provider?: ProviderId): Promise<void> {
    if (native()) return;
    await browser.unlock(userId, passphrase, provider);
  },
  async remove(userId: string, provider?: ProviderId): Promise<void> {
    const slot = resolveAiProvider(provider);
    session.delete(sessionKey(userId, slot));
    const android = native();
    if (android) await android.remove({ userId, provider: slot });
    else await browser.remove(userId, slot);
  },
  /** Logout: clear every provider slot (persisted + session) for one account only. */
  async removeAccountCredentials(userId: string): Promise<void> {
    if (!userId) return;
    const android = native();
    if (android) {
      for (const provider of SUPPORTED_AI_PROVIDERS) {
        session.delete(sessionKey(userId, provider));
        await android.remove({ userId, provider });
      }
      return;
    }
    await browser.removeAccount(userId);
  },
  /**
   * Opaque handle for one account/provider slot. The struct carries no key
   * material and is safe to pass into `providerContract` consumers.
   */
  credentialHandle(accountId: string, provider?: ProviderId): CredentialHandle {
    if (!accountId) throw new Error("A user and provider are required.");
    return aiCredentialHandle(accountId, resolveAiProvider(provider));
  },
  /** Resolve a handle to key material for the owning adapter. Null when absent. */
  async resolveCredential(handle: CredentialHandle): Promise<string | null> {
    if (!isHandleShape(handle)) return null;
    return aiCredentials.get(handle.accountId, handle.provider);
  },
  /** Validate-presence: a key is available now or saved for later unlock. */
  async hasCredential(handle: CredentialHandle): Promise<boolean> {
    if (!isHandleShape(handle)) return false;
    if ((await aiCredentials.get(handle.accountId, handle.provider)) !== null) return true;
    return aiCredentials.hasSaved(handle.accountId, handle.provider);
  },
  async removeCredential(handle: CredentialHandle): Promise<void> {
    if (!isHandleShape(handle)) throw new Error("Invalid credential handle.");
    await aiCredentials.remove(handle.accountId, handle.provider);
  },
  clearSession(): void {
    session.clear();
    browser.clearSession();
  },
};

/** The Supabase Auth session determines which user's credential can be read. */
export async function getConnectedOpenRouterKey(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.user.id ? aiCredentials.get(data.session.user.id) : null;
}

/**
 * Credential-presence probe across every supported provider (session-available
 * OR persisted). Returns provider ids + display text only — never key
 * material, never logs secrets. Fail-closed and strictly per-account.
 */
export async function describeCloudConnections(userId: string): Promise<CloudConnectionSummary> {
  if (!userId) return { connected: false, count: 0, providers: [], summary: "Not connected" };
  const found: ProviderId[] = [];
  for (const provider of SUPPORTED_AI_PROVIDERS) {
    try {
      if (await aiCredentials.hasCredential(aiCredentials.credentialHandle(userId, provider))) {
        found.push(provider);
      }
    } catch {
      /* fail-closed: skip the unreadable slot */
    }
  }
  return {
    connected: found.length > 0,
    count: found.length,
    providers: found,
    summary: cloudConnectionsSummary(found),
  };
}
