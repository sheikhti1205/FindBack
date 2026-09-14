import type { AuthProvider } from "./authProvider.js";
import { LocalAuthProvider } from "./localAuthProvider.js";
import { createSupabaseAuthProvider } from "./supabaseAuthClient.js";
import { config } from "../config.js";

export {
  AuthRefreshUnsupportedError,
  type AuthProvider,
  type AuthRegistrationResult,
  type AuthSession,
  type VerificationChannel,
  type VerificationResult,
  type VerificationSendResult,
  type VerificationTarget,
} from "./authProvider.js";
export {
  SupabaseAuthProvider,
  SupabaseVerificationNotEnabledError,
  type SupabaseAdminOperations,
  type SupabaseAuthOperations,
  type SupabaseAuthOutcome,
  type SupabaseClaimsResult,
  type SupabaseSessionData,
  type SupabaseAuthUser,
} from "./supabaseAuthProvider.js";
export { createSupabaseAuthProvider } from "./supabaseAuthClient.js";

let provider: AuthProvider | null = null;

/**
 * Pure provider selection. Kept separate from the singleton so it can be tested
 * without touching the real Supabase clients.
 *
 * - `sqlite` (tests + local demo) → `LocalAuthProvider`
 * - `supabase` (real application) → `SupabaseAuthProvider`
 *
 * `config.dbProvider` is pinned to `sqlite` whenever `NODE_ENV=test`, so tests
 * always select the local provider even if `DB_PROVIDER=supabase` is set.
 */
export function selectAuthProvider(
  dbProvider: "sqlite" | "supabase",
  createSupabase: () => AuthProvider = createSupabaseAuthProvider,
): AuthProvider {
  return dbProvider === "supabase" ? createSupabase() : new LocalAuthProvider();
}

/**
 * The active auth provider, selected once (mirrors `getStore()`).
 *
 * Production (`DB_PROVIDER=supabase`) uses `SupabaseAuthProvider`; tests and
 * the local demo use `LocalAuthProvider`. If Supabase is selected without the
 * required configuration, `createSupabaseAuthProvider()` throws a clear error —
 * there is intentionally no silent fallback to the local provider.
 */
export function getAuthProvider(): AuthProvider {
  if (!provider) provider = selectAuthProvider(config.dbProvider);
  return provider;
}

/** Test hook: override the singleton provider (or reset with `null`). */
export function setAuthProviderForTests(next: AuthProvider | null): void {
  provider = next;
}
