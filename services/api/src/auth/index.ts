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

let provider: AuthProvider | null = null;

/**
 * The active auth provider, selected once (mirrors `getStore()`).
 *
 * TODO(Supabase Auth): select `SupabaseAuthProvider` for `DB_PROVIDER=supabase`
 * in non-test environments. Until that provider lands, every environment
 * (tests, local demo, and even `DB_PROVIDER=supabase`) uses the local provider,
 * so the API keeps working unchanged after this refactor.
 */
export function getAuthProvider(): AuthProvider {
  if (!provider) provider = new LocalAuthProvider();
  return provider;
}
