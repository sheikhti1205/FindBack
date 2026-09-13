import type { z } from "zod";
import type { loginSchema, registerSchema } from "@findback/shared";
import { login, register, verifyToken } from "../domain/authService.js";
import {
  devVerificationProvider,
  sendChallenge,
  verifyChallenge,
} from "../domain/verificationService.js";
import {
  AuthRefreshUnsupportedError,
  type AuthProvider,
  type AuthRegistrationResult,
  type AuthSession,
  type VerificationChannel,
  type VerificationResult,
  type VerificationSendResult,
} from "./authProvider.js";

/**
 * Local auth provider — the original FindBack behavior: bcrypt password hashing,
 * locally signed JWT access tokens, and dev verification codes (echoed in dev).
 *
 * Used by tests, local demo, and (until the Supabase Auth cutover) every runtime
 * configuration. It delegates to the existing domain helpers rather than
 * reimplementing them.
 */
export class LocalAuthProvider implements AuthProvider {
  async register(input: z.infer<typeof registerSchema>): Promise<AuthRegistrationResult> {
    const { token, user } = await register(input);
    // Local signup is immediately authenticated; no email confirmation gate.
    return {
      user,
      session: { token, user },
      emailVerificationRequired: false,
    };
  }

  login(input: z.infer<typeof loginSchema>): Promise<AuthSession> {
    return login(input);
  }

  async refresh(_refreshToken: string): Promise<AuthSession> {
    // Local JWTs are stateless and have no refresh concept.
    throw new AuthRefreshUnsupportedError("LocalAuthProvider");
  }

  async validateAccessToken(token: string): Promise<{ userId: string }> {
    return verifyToken(token);
  }

  async signOut(_accessToken?: string): Promise<void> {
    // Local JWTs are stateless; the client discards its token. No revocation.
  }

  sendVerificationCode(
    userId: string,
    channel: VerificationChannel,
  ): Promise<VerificationSendResult> {
    return sendChallenge(userId, channel, devVerificationProvider);
  }

  verifyVerificationCode(
    userId: string,
    channel: VerificationChannel,
    code: string,
  ): Promise<VerificationResult> {
    return verifyChallenge(userId, channel, code);
  }
}
