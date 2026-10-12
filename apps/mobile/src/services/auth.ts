import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient";
import { ApiError, setToken } from "./session";
import { BootTimeoutError, withTimeout } from "./timeout";
import { recordBootEvent } from "./bootDiagnostics";
import type { PublicUser } from "@findback/shared";
import { normalizePhone } from "@findback/shared";
import { publicShareOrigin } from "../utils/reportLinks";
import { createOpenRouterClient, OpenRouterError } from "./openRouter";
import { getConnectedOpenRouterKey } from "./aiCredentials";
import { builtInHelp } from "./helpFaq";
import { buildGroundedPrompt, groundAppAnswer } from "./ai/appKnowledge";
import { requestPhoneChange } from "./profile";

/** Same validated, publishable-only Vite configuration as getSupabase(). */
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

/** Supabase signup with Confirm-email ON: account created, no session yet. */
export interface RegisterResult {
  user: PublicUser;
  emailVerificationRequired: boolean;
  email?: string;
}

const DUPLICATE_ACCOUNT_MESSAGE = "An account with these details already exists.";
const RATE_LIMIT_MESSAGE = "Too many attempts. Please wait a moment and try again.";
const INVALID_CODE_MESSAGE = "Invalid or expired verification code";

/** Boot restore budget: local session read + validation. Never indefinite. */
const SESSION_RESTORE_TIMEOUT_MS = 12_000;
/** Boot profile budget after a session is confirmed. */
const PROFILE_LOAD_TIMEOUT_MS = 15_000;

/** Re-exported so boot UI can distinguish "unreachable" from "signed out". */
export { BootTimeoutError };

/** Same syntax/length the registration trigger enforces (^[A-Za-z0-9_]{3,20}$). */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** Escape LIKE metacharacters so `_` is matched literally, not as a wildcard. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * True when a Supabase error means "this RPC does not exist on the backend"
 * (PostgREST PGRST202 / HTTP 404). Only this narrow case may use the legacy
 * direct-lookup fallback in checkUsername.
 */
function isMissingFunctionError(error: { code?: string; status?: number; message?: string }): boolean {
  if (error.code === "PGRST202" || error.status === 404) return true;
  return (error.message ?? "").includes("is_username_available");
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
    displayName: null,
    bio: null,
    locationLabel: null,
  };
}

interface ProfileRow {
  id: string;
  username: string;
  email_verified: boolean | null;
  phone_verified: boolean | null;
  avatar_url: string | null;
  created_at: string;
  display_name: string | null;
  bio: string | null;
  location_label: string | null;
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

export async function fetchMe(expectedUserId?: string): Promise<PublicUser> {
  const {
    data: { user },
  } = await getSupabase().auth.getUser();
  if (!user) throw new ApiError("Not authenticated", 401);
  if (expectedUserId && user.id !== expectedUserId) throw new ApiError("Your account changed. Try again from the current account.", 409);

  // public.users no longer exposes email/phone to the authenticated role (both
  // are private). Read only the safe public columns here; the signed-in user's
  // own email comes from Auth. Metadata holds the desired display phone;
  // auth.phone + phone_confirmed_at alone prove ownership of that number.
  const { data: row, error } = await getSupabase()
    .from("users")
    .select("id,username,email_verified,phone_verified,avatar_url,created_at,display_name,bio,location_label")
    .eq("id", user.id)
    .single<ProfileRow>();
  if (error || !row) throw new ApiError(error?.message ?? "Could not load profile", 400);

  const metadataPhone = user.user_metadata?.phone;
  const phone = typeof metadataPhone === "string" ? metadataPhone : normalizePhone(user.phone ?? "") ?? "";
  return {
    id: row.id,
    username: row.username,
    email: user.email ?? "",
    phone,
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified) && Boolean(user.phone_confirmed_at) &&
      normalizePhone(phone) !== null && normalizePhone(phone) === normalizePhone(user.phone ?? ""),
    avatarUrl: row.avatar_url ?? null,
    createdAt: row.created_at,
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    locationLabel: row.location_label ?? null,
  };
}

export async function restoreSession(): Promise<PublicUser> {
  // Bounded boot restore (Termux finding: endpoints can hang and freeze
  // startup). A timeout throws BootTimeoutError and must NOT clear or destroy
  // the stored session — the UI offers Retry instead of signing out.
  recordBootEvent("session-restore-start");
  const { data } = await withTimeout(
    () => getSupabase().auth.getSession(),
    SESSION_RESTORE_TIMEOUT_MS,
    "Session restore timed out",
  );
  if (!data.session) throw new ApiError("Session expired", 401);
  setToken(data.session.access_token);
  recordBootEvent("session-restore-ok");
  try {
    const user = await withTimeout(fetchMe, PROFILE_LOAD_TIMEOUT_MS, "Profile load timed out");
    recordBootEvent("profile-load-ok");
    return user;
  } catch (err) {
    recordBootEvent("profile-load-failed", err instanceof Error ? err.name : "unknown");
    throw err;
  }
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

/** Minimum password length, shared with the sign-up form's "at least 8" rule. */
const MIN_PASSWORD_LENGTH = 8;

/** Recovery-link landing path. Must be allowlisted as a Supabase redirect URL (hosted Auth config). */
export const PASSWORD_RECOVERY_ROUTE = "/recovery";

/** Absolute recovery URL sent as the reset-email redirect (App Links compatible). */
export function passwordRecoveryRedirect(): string {
  return `${publicShareOrigin()}${PASSWORD_RECOVERY_ROUTE}`;
}

/**
 * Request a password-reset email. Unknown addresses resolve silently
 * (anti-enumeration): the UI always shows the same "check your inbox"
 * message, so existence is never leaked. Throws only on invalid input,
 * missing share-origin config, or rate limits.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const address = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new ApiError("Enter a valid email address.", 400);
  const { error } = await getSupabase().auth.resetPasswordForEmail(address, {
    redirectTo: passwordRecoveryRedirect(),
  });
  if (error && !isEnumerationError(error.code ?? "")) throw mapAuthError(error);
}

/**
 * Exchange a recovery-link PKCE code for a session. A missing session or
 * exchange error means the link is invalid, expired, or already used.
 */
export async function exchangeRecoveryCode(code: string): Promise<void> {
  if (!code) throw new ApiError("This password-reset link is invalid or expired.", 400);
  const { data, error } = await getSupabase().auth.exchangeCodeForSession(code);
  if (error) throw mapAuthError(error);
  if (!data.session) throw new ApiError("This password-reset link is invalid or expired.", 400);
  setToken(data.session.access_token);
}

/** Set a new password for the recovery session. Session stays valid; the user lands signed in. */
export async function updatePassword(password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new ApiError("Password must be at least 8 characters.", 400);
  const { error } = await getSupabase().auth.updateUser({ password });
  if (error) throw mapAuthError(error);
}

/** Server-reported result of self-serve account deletion (FBA-036). */
export interface AccountDeletionResult {
  storageRemoved: number;
}

/**
 * Delete the signed-in account via the `delete-account` edge function. The
 * session JWT travels automatically; the function resolves the uid from it,
 * so one account can never delete another. The session is dead afterwards —
 * the caller must run the normal logout wipe next. Throws ApiError with the
 * server's reason when the purge refuses or fails partway.
 */
export async function requestAccountDeletion(): Promise<AccountDeletionResult> {
  let data: unknown;
  try {
    const invoked = await getSupabase().functions.invoke("delete-account", { method: "POST" });
    if (invoked.error) throw invoked.error;
    data = invoked.data;
  } catch (err) {
    throw mapDeletionError(err);
  }
  const removed = (data as { storageRemoved?: unknown } | null)?.storageRemoved;
  if (typeof removed !== "number") {
    throw new ApiError("Account deletion did not confirm. Please try again.", 502);
  }
  return { storageRemoved: removed };
}

function mapDeletionError(err: unknown): ApiError {
  const like = (err ?? {}) as { message?: unknown; status?: unknown; context?: unknown };
  const contextMessage =
    like.context && typeof like.context === "object"
      ? (like.context as { error?: unknown }).error
      : undefined;
  const message =
    (typeof contextMessage === "string" && contextMessage) ||
    (typeof like.message === "string" && like.message) ||
    "";
  if (/session|credential|auth|jwt|token|expired/i.test(message)) {
    return new ApiError("Your session expired. Sign in again, then delete your account.", 401);
  }
  if (message) return new ApiError(`Account deletion failed: ${message}`, 502);
  return new ApiError("Account deletion failed. Check your connection and try again.", 502);
}

function requirePhone(phone: string): string {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new ApiError("Enter a valid Bangladesh mobile number (e.g., 01812345678).", 400);
  return normalized;
}

async function phoneAccount(expectedUserId: string): Promise<User> {
  const { data: { user }, error } = await getSupabase().auth.getUser();
  if (error || !user || user.id !== expectedUserId) {
    throw new ApiError("Your account changed. Try again from the current account.", 409);
  }
  return user;
}

let phoneClientSequence = 0;

async function phoneMutation<T>(
  userId: string,
  phone: string | undefined,
  challenge: boolean,
  run: (auth: SupabaseClient["auth"]) => Promise<T>,
): Promise<T> {
  // getSupabase() validates the canonical config. Capture the *current* account
  // immediately before a mutation. SDK updateUser/verifyOtp save their returned
  // session; doing that on the shared client can resurrect a signed-out account
  // or overwrite a newly selected one while the network request is in flight.
  const { data: { session }, error } = await getSupabase().auth.getSession();
  if (error || !session || session.user.id !== userId) {
    throw new ApiError("Your account changed. Try again from the current account.", 409);
  }
  const isolated = createClient(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `findback-phone-change-${++phoneClientSequence}`,
    },
  });
  try {
    const { error: sessionError } = await isolated.auth.setSession({
      access_token: session.access_token, refresh_token: session.refresh_token,
    });
    if (sessionError) throw mapPhoneError(sessionError);
    const current = await phoneAccount(userId);
    if (phone) requireDestination(current, phone, challenge);
    return await run(isolated.auth);
  } finally {
    await isolated.auth.dispose();
  }
}

function requireDestination(user: User, phone: string, challenge: boolean): void {
  const metadataPhone = user.user_metadata?.phone;
  const desired = typeof metadataPhone === "string" ? metadataPhone : user.phone ?? "";
  if (normalizePhone(desired) !== phone) {
    throw new ApiError("Your mobile number changed. Send a new code to the current number.", 409);
  }
  if (challenge && normalizePhone(user.new_phone ?? "") !== phone) {
    throw new ApiError("Send a new code to this mobile number before verifying or resending.", 409);
  }
}

function mapPhoneError(error: AuthErrorLike): ApiError {
  const message = (error.message ?? "").toLowerCase();
  if (error.status === 429 || isRateLimited(error.code ?? "", message)) return new ApiError(RATE_LIMIT_MESSAGE, 429);
  if (error.code === "phone_provider_disabled" || error.code === "sms_provider_disabled" ||
      message.includes("phone provider is disabled") || message.includes("sms provider is not configured")) {
    return new ApiError("SMS verification is not enabled for this app. Contact support to enable it.", 503);
  }
  if (error.code === "sms_send_failed" || error.code === "hook_send_sms_error" ||
      message.includes("error sending") || message.includes("sms provider")) {
    return new ApiError("The SMS code could not be sent. Check the number and try again later; contact support if this continues.", 503);
  }
  if (error.code === "phone_exists") return new ApiError("This mobile number is already linked to an account. Use another number.", 409);
  const mapped = mapAuthError(error);
  if (mapped.message === "Authentication failed. Please try again.") {
    return new ApiError("Phone verification failed. Check your connection and try again.", error.status ?? 400);
  }
  return mapped;
}

/** Saving a display number never sends SMS. The Auth trigger clears its badge. */
export async function saveProfilePhone(userId: string, phone: string): Promise<PublicUser> {
  const normalized = requirePhone(phone);
  await phoneAccount(userId);
  const { error } = await phoneMutation(userId, undefined, false,
    (auth) => auth.updateUser({ data: { phone: normalized } }));
  if (error) throw new ApiError("Could not save your mobile number. Check your connection and try again.", 400);
  const profile = await fetchMe(userId);
  await phoneAccount(userId);
  return profile;
}

/** Authenticated phone change, not signInWithOtp (which could switch accounts). */
export async function sendPhoneChangeCode(userId: string, phone: string, resend = false): Promise<void> {
  const normalized = requirePhone(phone);
  const user = await phoneAccount(userId);
  requireDestination(user, normalized, resend);
  // Server-authoritative replacement gate (spec 25): runs before any SMS
  // challenge is created or resent. A held gate rejects with a 409 naming the
  // eligible date; the write below never runs.
  await requestPhoneChange(normalized);
  const { error } = await phoneMutation(userId, normalized, resend, async (auth) => resend
    ? auth.resend({ type: "phone_change", phone: normalized })
    : auth.updateUser({ phone: normalized }));
  if (error) throw mapPhoneError(error);
  const current = await phoneAccount(userId);
  requireDestination(current, normalized, false);
  if (normalizePhone(current.new_phone ?? "") !== normalized) {
    throw new ApiError("No SMS confirmation is pending. Refresh your contact details; contact support to check phone confirmation settings if this continues.", 503);
  }
}

export async function verifyPhoneChangeCode(userId: string, phone: string, code: string): Promise<PublicUser> {
  const normalized = requirePhone(phone);
  // Supabase SMS OTP length is configurable from 6–10 digits.
  if (!/^\d{6,10}$/.test(code)) throw new ApiError(INVALID_CODE_MESSAGE, 400);
  requireDestination(await phoneAccount(userId), normalized, true);
  const { data, error } = await phoneMutation(userId, normalized, true,
    (auth) => auth.verifyOtp({ phone: normalized, token: code, type: "phone_change" }));
  if (error) throw mapPhoneError(error);
  if (data.user?.id !== userId) throw new ApiError("Your account changed. Try again from the current account.", 409);
  const current = await phoneAccount(userId);
  requireDestination(current, normalized, false);
  if (normalizePhone(current.phone ?? "") !== normalized || !current.phone_confirmed_at) {
    throw new ApiError("Phone confirmation is incomplete. Send a new code and try again.", 409);
  }
  const profile = await fetchMe(userId);
  requireDestination(await phoneAccount(userId), normalized, false);
  if (!profile.phoneVerified) throw new ApiError("Your phone was confirmed, but the profile badge could not be refreshed. Try again later or contact support.", 503);
  return profile;
}

export async function checkUsername(
  username: string,
): Promise<{ available: boolean; normalized: string }> {
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) throw new ApiError("Invalid username", 400);

  // Primary: boolean availability RPC (post 20260920000000). It returns only
  // {available}, so anon callers can neither read rows nor harvest usernames.
  const { data, error } = await getSupabase().rpc("is_username_available", {
    p_username: normalized,
  });
  if (!error) return { available: data === true, normalized };

  // Fallback for backends where the RPC is not deployed yet: direct
  // username-only lookup. Removed automatically once the RPC exists — any
  // other error (permissions, network) still throws instead of falling back.
  if (!isMissingFunctionError(error)) throw new ApiError(error.message, 400);

  const { data: rows, error: lookupError } = await getSupabase()
    .from("users")
    .select("username")
    .ilike("username", escapeLikePattern(normalized))
    .limit(1);
  if (lookupError) throw new ApiError(lookupError.message, 400);

  return { available: !rows || rows.length === 0, normalized };
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
  const q = question.trim();
  if (q.length === 0 || q.length > 500) throw new ApiError("Enter a question of 1–500 characters.", 400);
  try {
    // No account identifiers, history, photos or report contents are forwarded.
    // The question ships as untrusted data behind the policy and knowledge
    // layers; the answer is screened before it is ever shown.
    const answer = await createOpenRouterClient(getConnectedOpenRouterKey).text(
      buildGroundedPrompt(q),
      { signal: opts?.signal },
    );
    const grounded = groundAppAnswer(answer);
    if (!grounded.safe) return { text: grounded.reply, source: "fallback" };
    return { text: grounded.text, source: "llm" };
  } catch (error) {
    if (opts?.signal?.aborted || (error instanceof OpenRouterError && error.code === "CANCELLED")) {
      const aborted = new Error("Cancelled");
      aborted.name = "AbortError";
      throw aborted;
    }
    const code = error instanceof OpenRouterError ? error.code : null;
    const prefix = code === "DAILY_LIMIT"
      ? "Your OpenRouter free allowance is exhausted. Built-in answer: "
      : code === "PAYMENT_OR_POLICY_BLOCKED"
        ? "OpenRouter blocked this free request (payment or policy); FindBack never uses paid models. Built-in answer: "
        : "";
    return { text: prefix + builtInHelp(q), source: "fallback" };
  }
}

export { ApiError, getToken } from "./session";
