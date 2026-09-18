import type { User } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient";
import { ApiError, setToken } from "./session";
import type { PublicUser } from "@findback/shared";

/** Supabase signup with Confirm-email ON: account created, no session yet. */
export interface RegisterResult {
  user: PublicUser;
  emailVerificationRequired: boolean;
  email?: string;
}

const DUPLICATE_ACCOUNT_MESSAGE = "An account with these details already exists.";
const RATE_LIMIT_MESSAGE = "Too many attempts. Please wait a moment and try again.";
const INVALID_CODE_MESSAGE = "Invalid or expired verification code";

/** Same syntax/length the registration trigger enforces (^[A-Za-z0-9_]{3,20}$). */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** Escape LIKE metacharacters so `_` is matched literally, not as a wildcard. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface AuthErrorLike {
  message?: string;
  code?: string | undefined;
  status?: number | undefined;
}

function isRateLimited(code: string, message: string): boolean {
  return (
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit" ||
    code === "over_sms_send_rate_limit" ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  );
}

function isEnumerationError(code: string): boolean {
  return code === "user_not_found" || code === "email_not_confirmed";
}

/** Map SDK errors to user-facing messages without leaking provider internals. */
function mapAuthError(error: AuthErrorLike): ApiError {
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();

  if (code === "user_already_exists" || code === "email_exists" || code === "phone_exists") {
    return new ApiError(DUPLICATE_ACCOUNT_MESSAGE, 409);
  }
  if (message.includes("invalid username") || message.includes("invalid phone")) {
    return new ApiError("Please check your username and phone number.", 400);
  }
  if (
    message.includes("unique constraint") ||
    message.includes("duplicate key") ||
    code === "23505"
  ) {
    return new ApiError(DUPLICATE_ACCOUNT_MESSAGE, 409);
  }
  if (isRateLimited(code, message)) {
    return new ApiError(RATE_LIMIT_MESSAGE, 429);
  }
  if (code === "email_not_confirmed") {
    return new ApiError("Email not confirmed. Verify your email to continue.", 403);
  }
  if (
    code === "invalid_credentials" ||
    code === "user_not_found" ||
    code === "invalid_grant" ||
    message.includes("invalid login credentials")
  ) {
    return new ApiError("Invalid credentials", 401);
  }
  if (
    code === "otp_expired" ||
    code === "invalid_otp" ||
    code === "token_has_expired" ||
    message.includes("token has expired") ||
    message.includes("invalid otp")
  ) {
    return new ApiError(INVALID_CODE_MESSAGE, 400);
  }
  return new ApiError("Authentication failed. Please try again.", error.status ?? 400);
}

function pendingUser(user: User | null, input: { username: string; email: string; phone: string }): PublicUser {
  return {
    id: user?.id ?? "",
    username: input.username,
    email: user?.email ?? input.email,
    phone: input.phone,
    emailVerified: false,
    phoneVerified: false,
    avatarUrl: null,
    createdAt: user?.created_at ?? new Date().toISOString(),
  };
}

interface ProfileRow {
  id: string;
  username: string;
  email_verified: boolean | null;
  phone_verified: boolean | null;
  avatar_url: string | null;
  created_at: string;
}

export async function register(input: {
  username: string;
  email: string;
  phone: string;
  password: string;
}): Promise<RegisterResult> {
  const { data, error } = await getSupabase().auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { username: input.username, phone: input.phone } },
  });

  if (error) throw mapAuthError(error);

  // Supabase returns an empty-identity user instead of an error to avoid
  // leaking which emails are registered.
  if (data.user && (data.user.identities?.length ?? 0) === 0 && !data.session) {
    throw new ApiError(DUPLICATE_ACCOUNT_MESSAGE, 409);
  }

  if (data.session) {
    setToken(data.session.access_token);
    return { user: await fetchMe(), emailVerificationRequired: false };
  }

  return {
    user: pendingUser(data.user, input),
    emailVerificationRequired: true,
    email: input.email,
  };
}

export async function login(input: {
  email: string;
  password: string;
}): Promise<PublicUser> {
  const { data, error } = await getSupabase().auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });
  if (error) throw mapAuthError(error);
  if (data.session) setToken(data.session.access_token);
  return fetchMe();
}

export async function fetchMe(): Promise<PublicUser> {
  const {
    data: { user },
  } = await getSupabase().auth.getUser();
  if (!user) throw new ApiError("Not authenticated", 401);

  // public.users no longer exposes email/phone to the authenticated role (both
  // are private). Read only the safe public columns here; the signed-in user's
  // own email comes from the Auth session and their phone from signup metadata
  // (display only — never used for authorization).
  const { data: row, error } = await getSupabase()
    .from("users")
    .select("id,username,email_verified,phone_verified,avatar_url,created_at")
    .eq("id", user.id)
    .single<ProfileRow>();
  if (error || !row) throw new ApiError(error?.message ?? "Could not load profile", 400);

  const metadataPhone = user.user_metadata?.phone;
  return {
    id: row.id,
    username: row.username,
    email: user.email ?? "",
    phone: typeof metadataPhone === "string" ? metadataPhone : "",
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified),
    avatarUrl: row.avatar_url ?? null,
    createdAt: row.created_at,
  };
}

export async function restoreSession(): Promise<PublicUser> {
  const { data } = await getSupabase().auth.getSession();
  if (!data.session) throw new ApiError("Session expired", 401);
  setToken(data.session.access_token);
  return fetchMe();
}

export async function logout(): Promise<void> {
  try {
    await getSupabase().auth.signOut();
  } catch {
    /* best effort: local state is cleared by the caller */
  }
}

export async function sendPendingEmailCode(email: string): Promise<void> {
  const { error } = await getSupabase().auth.resend({ type: "signup", email });
  if (!error) return;
  if (isEnumerationError(error.code ?? "")) return;
  throw mapAuthError(error);
}

export async function verifyPendingEmailCode(email: string, code: string): Promise<PublicUser> {
  if (!/^\d{6,10}$/.test(code)) throw new ApiError(INVALID_CODE_MESSAGE, 400);
  const { data, error } = await getSupabase().auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });
  if (error) throw mapAuthError(error);
  if (data.session) setToken(data.session.access_token);
  return fetchMe();
}

export async function checkUsername(
  username: string,
): Promise<{ available: boolean; normalized: string }> {
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) throw new ApiError("Invalid username", 400);

  const { data, error } = await getSupabase()
    .from("users")
    .select("username")
    .ilike("username", escapeLikePattern(normalized))
    .limit(1);
  if (error) throw new ApiError(error.message, 400);

  return { available: !data || data.length === 0, normalized };
}

export interface AiHelpMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Safe optional Help context: current route, app version, online state.
 * Never identity (no email/phone/user id), GPS, post/comment contents, or paths.
 */
export interface AiHelpContext {
  route?: string;
  appVersion?: string;
  online?: boolean;
}

export async function askAiHelp(
  question: string,
  opts?: { history?: AiHelpMessage[]; context?: AiHelpContext; signal?: AbortSignal },
): Promise<{
  text: string;
  source: "llm" | "fallback";
}> {
  const body: Record<string, unknown> = { question };
  if (opts?.history?.length) body.history = opts.history.slice(-6);
  if (opts?.context) body.context = opts.context;
  const { data, error } = await getSupabase().functions.invoke("ai-help", {
    body,
    signal: opts?.signal,
  });
  if (error) {
    if (opts?.signal?.aborted) {
      const aborted = new Error("Cancelled");
      aborted.name = "AbortError";
      throw aborted;
    }
    throw new ApiError(error.message || "AI Help is unavailable right now", 502);
  }
  return data as { text: string; source: "llm" | "fallback" };
}

export { ApiError, getToken } from "./session";
