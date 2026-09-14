import type { User } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient";
import { apiFetch, ApiError, setToken } from "./api";
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
  email: string | null;
  phone: string | null;
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
  identifier: string;
  password: string;
}): Promise<PublicUser> {
  let email = input.identifier;
  if (!input.identifier.includes("@")) {
    const { data } = await getSupabase().rpc("findback_login_email", {
      p_identifier: input.identifier,
    });
    if (typeof data !== "string" || !data) throw new ApiError("Invalid credentials", 401);
    email = data;
  }

  const { data, error } = await getSupabase().auth.signInWithPassword({
    email,
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

  const { data: row, error } = await getSupabase()
    .from("users")
    .select("id,username,email,phone,email_verified,phone_verified,avatar_url,created_at")
    .eq("id", user.id)
    .single<ProfileRow>();
  if (error || !row) throw new ApiError(error?.message ?? "Could not load profile", 400);

  return {
    id: row.id,
    username: row.username,
    email: row.email ?? user.email ?? "",
    phone: row.phone ?? "",
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
  return apiFetch<{ available: boolean; normalized: string }>(
    `/users/check-username?username=${encodeURIComponent(username)}`,
  );
}

export async function sendVerificationCode(
  channel: "EMAIL" | "PHONE",
): Promise<{ devCode?: string; expiresInSeconds?: number; resendAfterSeconds?: number }> {
  return apiFetch(`/verification/${channel}/send`, { method: "POST" });
}

export async function verifyCode(
  channel: "EMAIL" | "PHONE",
  code: string,
): Promise<{ emailVerified: boolean; phoneVerified: boolean }> {
  return apiFetch(`/verification/${channel}/verify`, {
    method: "POST",
    body: JSON.stringify({ channel, code }),
  });
}

export async function askAiHelp(question: string): Promise<{
  text: string;
  source: "llm" | "fallback";
}> {
  return apiFetch("/ai/help", {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}

export { ApiError, getAccessToken, getToken } from "./api";
