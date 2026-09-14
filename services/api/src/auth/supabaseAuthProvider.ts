import type { z } from "zod";
import { loginSchema, registerSchema } from "@findback/shared";
import type { PublicUser } from "@findback/shared";
import { AppError, nowIso, toPublicUser } from "../domain/helpers.js";
import type { Store } from "../db/index.js";
import type {
  AuthProvider,
  AuthRegistrationResult,
  AuthSession,
  VerificationResult,
  VerificationSendResult,
  VerificationTarget,
} from "./authProvider.js";

/**
 * Minimal Supabase Auth result the provider consumes. The production adapter
 * (`supabaseAuthClient.ts`) normalizes the SDK's response shapes into this, so
 * the provider stays decoupled from `@supabase/supabase-js` types and unit
 * tests can supply plain fakes.
 */
export interface SupabaseAuthUser {
  id: string;
  email?: string | null;
  emailConfirmedAt?: string | null;
}

export interface SupabaseSessionData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt?: number;
}

export interface SupabaseAuthOutcome {
  user: SupabaseAuthUser | null;
  session: SupabaseSessionData | null;
  /**
   * `signUp` only: number of auth identities. Supabase returns `0` for an
   * already-registered email when confirmation is required (enumeration
   * protection), which the provider treats as a duplicate.
   */
  identitiesCount?: number;
  errorCode?: string | null;
  errorMessage: string | null;
}

export interface SupabaseClaimsResult {
  sub: string | null;
  errorMessage: string | null;
}

export interface SupabaseResendResult {
  errorCode?: string | null;
  errorMessage: string | null;
}

/** Normal Supabase Auth operations (publishable key, user-facing). */
export interface SupabaseAuthOperations {
  signUp(input: { email: string; password: string }): Promise<SupabaseAuthOutcome>;
  signInWithPassword(input: { email: string; password: string }): Promise<SupabaseAuthOutcome>;
  refreshSession(input: { refresh_token: string }): Promise<SupabaseAuthOutcome>;
  getClaims(token: string): Promise<SupabaseClaimsResult>;
  /** Resend the signup confirmation email (`resend({ type: "signup" })`). */
  resendSignupEmail(email: string): Promise<SupabaseResendResult>;
  /** Verify a signup email OTP (`verifyOtp({ type: "email" })`). */
  verifyEmailOtp(email: string, token: string): Promise<SupabaseAuthOutcome>;
}

/** Trusted admin operations (secret key, service-role). Never mobile-facing. */
export interface SupabaseAdminOperations {
  deleteUser(id: string): Promise<{ errorMessage: string | null }>;
  revokeSession(accessToken: string): Promise<{ errorMessage: string | null }>;
}

/**
 * Thrown by verification methods that are intentionally not wired to Supabase.
 * Email verification is live; PHONE is unsupported until an SMS provider is
 * chosen (Supabase phone provider disabled).
 */
export class SupabaseVerificationNotEnabledError extends AppError {
  readonly operation: string;
  constructor(operation: string) {
    // User-facing message is intentionally generic; `operation` stays internal.
    super(501, "Phone verification is not available yet");
    this.name = "SupabaseVerificationNotEnabledError";
    this.operation = operation;
  }
}

function mapSession(session: SupabaseSessionData, user: PublicUser): AuthSession {
  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    expiresAt: session.expiresAt,
    user,
  };
}

/** Map a failed sign-in into the existing FindBack error semantics. */
function mapSignInError(outcome: SupabaseAuthOutcome): AppError {
  if (outcome.errorCode === "email_not_confirmed") {
    // Only reachable after a correct password, so this does not enumerate users.
    return new AppError(403, "Email not confirmed. Verify your email to continue");
  }
  if (
    outcome.errorCode === "invalid_credentials" ||
    outcome.errorCode === "user_not_found" ||
    outcome.errorCode === "invalid_grant"
  ) {
    return new AppError(401, "Invalid credentials");
  }
  return new AppError(500, "Authentication service error");
}

/** Map a failed sign-up; duplicate identities become the existing 409. */
function mapRegisterError(outcome: SupabaseAuthOutcome): AppError {
  if (
    outcome.errorCode === "user_already_exists" ||
    outcome.errorCode === "email_exists" ||
    outcome.errorCode === "phone_exists"
  ) {
    return new AppError(409, "An account with these details already exists");
  }
  return new AppError(500, "Authentication service error");
}

const RATE_LIMIT_CODES = new Set([
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "rate_limit_exceeded",
]);

/**
 * Map a failed confirmation-email resend. Returns `null` for errors that must
 * stay silent so a resend cannot enumerate accounts (e.g. unknown email).
 */
function mapResendError(code?: string | null): AppError | null {
  if (!code) return null;
  if (RATE_LIMIT_CODES.has(code)) {
    return new AppError(429, "Too many resend attempts. Please wait and try again");
  }
  if (code === "email_address_invalid" || code === "validation_failed") {
    return new AppError(400, "A valid email address is required");
  }
  if (code === "user_not_found" || code === "email_not_confirmed") {
    // Enumeration protection: behave as if the confirmation email was sent.
    return null;
  }
  return new AppError(500, "Authentication service error");
}

/** Map a failed email OTP verification. */
function mapOtpError(code?: string | null): AppError {
  if (RATE_LIMIT_CODES.has(code ?? "")) {
    return new AppError(429, "Too many attempts. Please wait and try again");
  }
  if (
    code === "otp_expired" ||
    code === "token_has_expired" ||
    code === "invalid_otp" ||
    code === "validation_failed"
  ) {
    return new AppError(400, "Invalid or expired verification code");
  }
  return new AppError(500, "Authentication service error");
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/**
 * Supabase Auth implementation of the `AuthProvider` seam.
 *
 * Core operations (register/login/refresh/validate/signOut) plus email OTP
 * verification are implemented; PHONE verification is deferred pending an SMS
 * provider. All dependencies are injected so unit tests run fully offline.
 *
 * Selected by `getAuthProvider()` when `DB_PROVIDER=supabase`.
 */
export class SupabaseAuthProvider implements AuthProvider {
  constructor(
    private readonly auth: SupabaseAuthOperations,
    private readonly admin: SupabaseAdminOperations,
    private readonly store: Store,
  ) {}

  private async assertUnique(
    field: "username" | "email" | "phone",
    value: string,
  ): Promise<void> {
    const row = await this.store.findUserIdByField(field, value);
    if (row) throw new AppError(409, `${field} "${value}" is already registered`);
  }

  /** Best-effort rollback after a failed profile insert; never hides the cause. */
  private async rollbackAuthUser(authUserId: string): Promise<void> {
    try {
      const { errorMessage } = await this.admin.deleteUser(authUserId);
      if (errorMessage) {
        console.error(`[supabase-auth] rollback deleteUser failed: ${errorMessage}`);
      }
    } catch (err) {
      console.error(`[supabase-auth] rollback deleteUser threw: ${errorMessageOf(err)}`);
    }
  }

  async register(input: z.infer<typeof registerSchema>): Promise<AuthRegistrationResult> {
    const parsed = registerSchema.parse(input);
    await this.assertUnique("username", parsed.username);
    await this.assertUnique("email", parsed.email);
    await this.assertUnique("phone", parsed.phone);

    const outcome = await this.auth.signUp({
      email: parsed.email,
      password: parsed.password,
    });
    if (outcome.errorMessage) throw mapRegisterError(outcome);
    const authUser = outcome.user;
    if (!authUser?.id) throw new AppError(500, "Authentication service error");

    // Supabase hides an existing email behind a user with no identities when
    // confirmation is required. Treat it as a duplicate and DO NOT delete or
    // insert — the real account must be left untouched.
    if (outcome.identitiesCount === 0 && !outcome.session) {
      throw new AppError(409, "An account with these details already exists");
    }

    const now = nowIso();
    try {
      await this.store.insertUser({
        id: authUser.id,
        username: parsed.username,
        email: parsed.email,
        phone: parsed.phone,
        password_hash: null,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      console.error(`[supabase-auth] profile insert failed: ${errorMessageOf(err)}`);
      await this.rollbackAuthUser(authUser.id);
      throw new AppError(500, "Could not create the account profile");
    }

    if (authUser.emailConfirmedAt) {
      await this.store.setUserVerified(authUser.id, "email_verified");
    }
    const row = await this.store.findUserById(authUser.id);
    if (!row) throw new AppError(500, "Profile row missing after registration");
    const user = toPublicUser(row);

    if (outcome.session) {
      return {
        user,
        session: mapSession(outcome.session, user),
        emailVerificationRequired: false,
      };
    }
    return {
      user,
      session: null,
      emailVerificationRequired: true,
      email: parsed.email,
    };
  }

  async login(input: z.infer<typeof loginSchema>): Promise<AuthSession> {
    const parsed = loginSchema.parse(input);
    const row = await this.store.findUserByIdentifier(parsed.identifier);
    if (!row) throw new AppError(401, "Invalid credentials");

    const outcome = await this.auth.signInWithPassword({
      email: String(row.email),
      password: parsed.password,
    });
    if (outcome.errorMessage || !outcome.session) throw mapSignInError(outcome);
    return mapSession(outcome.session, toPublicUser(row));
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const outcome = await this.auth.refreshSession({ refresh_token: refreshToken });
    if (outcome.errorMessage || !outcome.session || !outcome.user?.id) {
      throw new AppError(401, "Invalid or expired refresh token");
    }
    const row = await this.store.findUserById(outcome.user.id);
    if (!row) throw new AppError(401, "Invalid or expired refresh token");
    return mapSession(outcome.session, toPublicUser(row));
  }

  async validateAccessToken(token: string): Promise<{ userId: string }> {
    // getClaims verifies the signature (JWKS for asymmetric keys) and expiry;
    // never trust a plain decode for authorization.
    const { sub, errorMessage } = await this.auth.getClaims(token);
    if (errorMessage || !sub) throw new AppError(401, "Invalid or expired token");
    return { userId: String(sub) };
  }

  async signOut(accessToken?: string): Promise<void> {
    if (!accessToken) return;
    try {
      // Revoke only the current session (per-device logout), matching FindBack.
      const { errorMessage } = await this.admin.revokeSession(accessToken);
      if (errorMessage) {
        console.error(`[supabase-auth] session revoke failed: ${errorMessage}`);
      }
    } catch (err) {
      console.error(`[supabase-auth] session revoke threw: ${errorMessageOf(err)}`);
    }
  }

  /** Resolve the email for an EMAIL verification target. */
  private async resolveEmail(
    target: Extract<VerificationTarget, { channel: "EMAIL" }>,
  ): Promise<string> {
    if (target.email) {
      const email = target.email.trim();
      if (email) return email;
    }
    if (target.userId) {
      const row = await this.store.findUserById(target.userId);
      const email = row?.email ? String(row.email).trim() : "";
      if (email) return email;
    }
    throw new AppError(400, "Email verification requires an email or authenticated user");
  }

  /**
   * Send/resend the signup confirmation email. Supabase owns the code, expiry
   * and rate limiting, so no dev code is returned.
   */
  async sendVerificationCode(target: VerificationTarget): Promise<VerificationSendResult> {
    if (target.channel === "PHONE") {
      throw new SupabaseVerificationNotEnabledError("sendVerificationCode");
    }
    const email = await this.resolveEmail(target);
    const { errorCode, errorMessage } = await this.auth.resendSignupEmail(email);
    if (errorMessage) {
      const mapped = mapResendError(errorCode);
      if (mapped) throw mapped;
    }
    return {};
  }

  /**
   * Verify the signup email OTP and return the first session. The public REST
   * route (`POST /auth/email-verification/verify`) returns that session.
   */
  async verifyVerificationCode(
    target: VerificationTarget,
    code: string,
  ): Promise<VerificationResult> {
    if (target.channel === "PHONE") {
      throw new SupabaseVerificationNotEnabledError("verifyVerificationCode");
    }
    const email = await this.resolveEmail(target);
    // Supabase OTP length is configurable (6-10); accept the whole range.
    if (!/^\d{6,10}$/.test(code)) {
      throw new AppError(400, "Verification code must be 6-10 digits");
    }

    const outcome = await this.auth.verifyEmailOtp(email, code);
    if (outcome.errorMessage) throw mapOtpError(outcome.errorCode);
    const authUser = outcome.user;
    const sessionData = outcome.session;
    if (!authUser?.id || !sessionData) {
      throw new AppError(400, "Email verification failed");
    }

    // The verified Auth identity must map to exactly one public profile.
    const row = await this.store.findUserById(authUser.id);
    if (!row) throw new AppError(401, "Email verification failed");
    if (String(row.id) !== authUser.id) {
      throw new AppError(401, "Email verification identity mismatch");
    }
    if (String(row.email).trim().toLowerCase() !== email.trim().toLowerCase()) {
      throw new AppError(401, "Email verification identity mismatch");
    }

    await this.store.setUserVerified(authUser.id, "email_verified");
    const reloaded = (await this.store.findUserById(authUser.id)) ?? row;
    const user = toPublicUser(reloaded);
    return {
      emailVerified: true,
      phoneVerified: Boolean(user.phoneVerified),
      session: mapSession(sessionData, user),
    };
  }
}
