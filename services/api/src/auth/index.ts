import type { AuthProvider } from "./authProvider.js";
import { LocalAuthProvider } from "./localAuthProvider.js";

export {
  AuthRefreshUnsupportedError,
  type AuthProvider,
  type AuthRegistrationResult,
  type AuthSession,
  type VerificationChannel,
  type VerificationResult,
  type VerificationSendResult,
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
 * The active auth provider, selected once (mirrors `getStore()`).
 *
 * TODO(Supabase Auth): select `SupabaseAuthProvider` (via
 * `createSupabaseAuthProvider()`) for `DB_PROVIDER=supabase` in non-test
 * environments once the email/OTP cutover lands. `SupabaseAuthProvider` exists
 * and is tested, but every environment (tests, local demo, and even
 * `DB_PROVIDER=supabase`) intentionally still uses the local provider.
 */
export function getAuthProvider(): AuthProvider {
  if (!provider) provider = new LocalAuthProvider();
  return provider;
}
