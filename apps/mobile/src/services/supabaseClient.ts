/** Injected at build time by Vite (see vite.config.ts `define`). */
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

/** Rejects keys that must never ship in a client bundle. Never logs the key. */
export function isLikelySecretKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.startsWith("sb_secret_")) return true;
  const parts = trimmed.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]!)) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export function validateSupabaseConfig(url: string, key: string): { url: string; key: string } {
  const trimmedUrl = url.trim();
  const trimmedKey = key.trim();
  if (!trimmedUrl) throw new SupabaseConfigError("Supabase URL is not configured");
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    throw new SupabaseConfigError("Supabase URL must be an http(s) URL");
  }
  if (!trimmedKey) throw new SupabaseConfigError("Supabase publishable key is not configured");
  if (isLikelySecretKey(trimmedKey)) {
    throw new SupabaseConfigError(
      "Supabase secret key detected; use the publishable key for the mobile app",
    );
  }
  return { url: trimmedUrl, key: trimmedKey };
}

let client: SupabaseClient | null = null;

/**
 * Lazily create the Supabase client. Config is validated on first use (not at
 * module import) so tests and unused code paths never touch the injected env.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const { url, key } = validateSupabaseConfig(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__);
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}
