import type { z } from "zod";
import type { loginSchema, registerSchema, PublicUser } from "@findback/shared";

/** Verification channels supported by the auth seam (mirrors the domain). */
export type VerificationChannel = "EMAIL" | "PHONE";

/** A successful authentication result: bearer token + the public profile. */
export interface AuthSession {
  token: string;
  user: PublicUser;
}

export interface VerificationSendResult {
  /** Dev-only: echoed code so the local/demo flow works without a provider. */
  devCode?: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface VerificationVerifyResult {
  emailVerified: boolean;
  phoneVerified: boolean;
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
  register(input: z.infer<typeof registerSchema>): Promise<AuthSession>;
  login(input: z.infer<typeof loginSchema>): Promise<AuthSession>;
  /** Verify an access token; throws AppError(401) when invalid or expired. */
  validateAccessToken(token: string): Promise<{ userId: string }>;
  signOut(): Promise<void>;
  sendVerificationCode(
    userId: string,
    channel: VerificationChannel,
  ): Promise<VerificationSendResult>;
  verifyVerificationCode(
    userId: string,
    channel: VerificationChannel,
    code: string,
  ): Promise<VerificationVerifyResult>;
}
