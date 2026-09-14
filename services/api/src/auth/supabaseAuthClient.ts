import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { getStore } from "../db/index.js";
import {
  SupabaseAuthProvider,
  type SupabaseAdminOperations,
  type SupabaseAuthOperations,
  type SupabaseAuthOutcome,
} from "./supabaseAuthProvider.js";

/**
 * Server-side Supabase Auth clients.
 *
 * Both clients are stateless (no session persistence, no auto-refresh, no URL
 * detection) because the Node API never keeps a user session of its own:
 *  - the normal client uses the publishable key for user-facing Auth calls and
 *    `getClaims` (JWKS verification with asymmetric signing keys);
 *  - the admin client uses the secret key only for trusted backend operations
 *    (rollback deletes, session revocation). It must never reach the mobile app
 *    or any `VITE_` variable.
 */

const STATELESS_AUTH = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

export function createSupabaseAuthClient(): SupabaseClient {
  if (!config.supabaseUrl) throw new Error("Supabase Auth requires SUPABASE_URL");
  if (!config.supabasePublishableKey) {
    throw new Error("Supabase Auth requires SUPABASE_PUBLISHABLE_KEY");
  }
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { ...STATELESS_AUTH },
  });
}

export function createSupabaseAdminClient(): SupabaseClient {
  if (!config.supabaseUrl) throw new Error("Supabase admin requires SUPABASE_URL");
  if (!config.supabaseSecretKey) {
    throw new Error("Supabase admin requires SUPABASE_SECRET_KEY");
  }
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { ...STATELESS_AUTH },
  });
}

/** Structural view of the SDK response we normalize (keeps fakes easy). */
interface RawAuthUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  identities?: unknown[] | null;
}

interface RawAuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
}

interface RawAuthResponse {
  data: {
    user: RawAuthUser | null;
    session: RawAuthSession | null;
  } | null;
  error: { message?: string; code?: string } | null;
}

function normalizeAuthOutcome(response: RawAuthResponse): SupabaseAuthOutcome {
  if (response.error) {
    return {
      user: null,
      session: null,
      errorCode: response.error.code ?? null,
      errorMessage: response.error.message ?? "Authentication error",
    };
  }
  const user = response.data?.user ?? null;
  const session = response.data?.session ?? null;
  return {
    user: user
      ? {
          id: user.id,
          email: user.email ?? null,
          emailConfirmedAt: user.email_confirmed_at ?? null,
        }
      : null,
    session: session
      ? {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          expiresIn: session.expires_in,
          expiresAt: session.expires_at,
        }
      : null,
    identitiesCount: Array.isArray(user?.identities) ? user.identities.length : undefined,
    errorCode: null,
    errorMessage: null,
  };
}

/** Adapt the SDK's auth client to the provider's narrow operations interface. */
export function createSupabaseAuthOperations(client: SupabaseClient): SupabaseAuthOperations {
  return {
    async signUp({ email, password }) {
      return normalizeAuthOutcome(await client.auth.signUp({ email, password }));
    },
    async signInWithPassword({ email, password }) {
      return normalizeAuthOutcome(await client.auth.signInWithPassword({ email, password }));
    },
    async refreshSession({ refresh_token }) {
      return normalizeAuthOutcome(await client.auth.refreshSession({ refresh_token }));
    },
    async getClaims(token) {
      const { data, error } = await client.auth.getClaims(token);
      if (error || !data) {
        return { sub: null, errorMessage: error?.message ?? "Invalid token" };
      }
      const sub = data.claims?.sub;
      return {
        sub: typeof sub === "string" && sub ? sub : null,
        errorMessage: null,
      };
    },
    async resendSignupEmail(email) {
      // Resend type is "signup" (the OTP verification type is "email").
      const { error } = await client.auth.resend({ type: "signup", email });
      if (error) return { errorCode: error.code ?? null, errorMessage: error.message };
      return { errorCode: null, errorMessage: null };
    },
    async verifyEmailOtp(email, token) {
      return normalizeAuthOutcome(
        await client.auth.verifyOtp({ email, token, type: "email" }),
      );
    },
  };
}

/** Adapt the SDK's admin client to the provider's admin operations interface. */
export function createSupabaseAdminOperations(client: SupabaseClient): SupabaseAdminOperations {
  return {
    async deleteUser(id) {
      const { error } = await client.auth.admin.deleteUser(id);
      return { errorMessage: error?.message ?? null };
    },
    async revokeSession(accessToken) {
      // `local` scope revokes only the caller's current session, matching
      // FindBack's per-device logout (not a global all-devices sign-out).
      const { error } = await client.auth.admin.signOut(accessToken, "local");
      return { errorMessage: error?.message ?? null };
    },
  };
}

/**
 * Production wiring for `SupabaseAuthProvider`. Selected by
 * `getAuthProvider()` when `DB_PROVIDER=supabase`.
 */
export function createSupabaseAuthProvider(): SupabaseAuthProvider {
  return new SupabaseAuthProvider(
    createSupabaseAuthOperations(createSupabaseAuthClient()),
    createSupabaseAdminOperations(createSupabaseAdminClient()),
    getStore(),
  );
}
