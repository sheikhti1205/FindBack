import type { z } from "zod";
import type { loginSchema, registerSchema, PublicUser } from "@findback/shared";

/** Verification channels supported by the auth seam (mirrors the domain). */
export type VerificationChannel = "EMAIL" | "PHONE";

/**
 * What a verification send/verify operates on.
 *
 * EMAIL may be addressed by `userId` (local, authenticated) or by `email` alone
 * (a pending Supabase signup has no session/user yet). PHONE stays userId-only.
 */
export type VerificationTarget =
  | {
      channel: "EMAIL";
      userId?: string;
      email?: string;
    }
  | {
      channel: "PHONE";
      userId: string;
    };

/**
 * A provider-issued authenticated session, future-capable of carrying the
 * Supabase Auth shape.
 *
 * The local provider only ever sets `token` (its existing JWT); the optional
 * refresh/expiry fields are reserved for `SupabaseAuthProvider` so sessions can
 * be represented without hacking them into `{ token, user }`.
 */
export interface AuthSession {
  /** Bearer access token. */
  token: string;
  /** Refresh token, when the provider issues one (Supabase); local has none. */
  refreshToken?: string;
  /** Access-token lifetime in seconds, when the provider reports it. */
  expiresIn?: number;
  /** Absolute access-token expiry, when the provider reports it. */
  expiresAt?: number;
  user: PublicUser;
}

/**
 * Outcome of a registration attempt.
 *
 * Supabase Auth can create a user that must confirm their email before a session
 * exists, so registration is not always an immediate login. `session === null`
 * means the account exists but the caller is not yet signed in.
 */
export interface AuthRegistrationResult {
  user: PublicUser;
  /** `null` when email confirmation is pending; a session otherwise. */
  session: AuthSession | null;
  emailVerificationRequired: boolean;
  email?: string;
}

export interface VerificationSendResult {
  /** Dev-only: echoed code so the local/demo flow works without a provider. */
  devCode?: string;
  /** Seconds the code stays valid, when the provider knows (local does). */
  expiresInSeconds?: number;
  /** Minimum seconds before a resend, when the provider enforces it (local does). */
  resendAfterSeconds?: number;
}

/**
 * Outcome of verifying an email/phone challenge. `session` is reserved for the
 * future case where confirming email establishes the caller's first session.
 */
export interface VerificationResult {
  emailVerified: boolean;
  phoneVerified: boolean;
  session?: AuthSession;
}

/**
 * Thrown by a provider that cannot refresh sessions (e.g. the local provider,
 * whose stateless JWTs have no refresh concept). Typed so callers can detect
 * the capability gap instead of string-matching a message.
 */
export class AuthRefreshUnsupportedError extends Error {
  constructor(provider: string) {
    super(`${provider} does not support refresh tokens`);
    this.name = "AuthRefreshUnsupportedError";
  }
}

/**
 * Authentication seam.
 *
 * Routes, middleware, GraphQL and Socket.IO depend on this interface, never on a
 * concrete provider, so a `SupabaseAuthProvider` can replace `LocalAuthProvider`
 * in a later block without touching any consumer. `validateAccessToken` returns
 * the caller's user id, which is all downstream code needs (`req.userId`).
 */
export interface AuthProvider {
  register(input: z.infer<typeof registerSchema>): Promise<AuthRegistrationResult>;
  login(input: z.infer<typeof loginSchema>): Promise<AuthSession>;
  /**
   * Exchange a refresh token for a new session. Providers without refresh
   * tokens throw `AuthRefreshUnsupportedError`. No HTTP route exposes this yet.
   */
  refresh(refreshToken: string): Promise<AuthSession>;
  /** Verify an access token; throws AppError(401) when invalid or expired. */
  validateAccessToken(token: string): Promise<{ userId: string }>;
  /**
   * End the session. `accessToken` is optional context for providers that can
   * revoke server-side (Supabase); the local provider ignores it.
   */
  signOut(accessToken?: string): Promise<void>;
  sendVerificationCode(target: VerificationTarget): Promise<VerificationSendResult>;
  verifyVerificationCode(
    target: VerificationTarget,
    code: string,
  ): Promise<VerificationResult>;
}
