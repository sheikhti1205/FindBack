/**
 * Push dispatch — Supabase Edge Function.
 *
 * Scans `public.notifications` for rows that have not been pushed
 * (`pushed_at is null and deleted_at is null`), honours each recipient's
 * `notification_preferences` and `device_tokens`, sends FCM HTTP v1, then
 * stamps `pushed_at`. Invalid tokens reported by FCM (`UNREGISTERED`,
 * `INVALID_ARGUMENT`) are pruned so they are never retried.
 *
 * Invocation is server-to-server only: callers present
 * `x-findback-dispatch-secret` matching the `PUSH_DISPATCH_SECRET` function
 * secret. The service-role key is read from the runtime environment
 * (`SUPABASE_SERVICE_ROLE_KEY`) and never leaves this function.
 *
 * Required function environment (set with `supabase secrets set`):
 * - `FIREBASE_SERVICE_ACCOUNT_JSON` — dedicated `findback-push` sender.
 * - `FCM_PROJECT_ID`, `PUBLIC_SHARE_ORIGIN`, `PUSH_DISPATCH_SECRET`.
 * - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — injected by the runtime.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateReplyToken, hashToken, REPLY_TOKEN_TTL_MS } from "../_shared/replyTokens.ts";

const BATCH_LIMIT = 100;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** A transient FCM failure keeps a notification pending this many runs. */
const MAX_PUSH_ATTEMPTS = 5;

export interface DispatchNotification {
  id: string;
  user_id: string;
  type: string;
  post_id: string | null;
  comment_id: string | null;
  created_at: string;
  /** Canonical reaction kind on REACTION rows; null on every other type. */
  reaction_kind?: string | null;
}

export interface PreferenceRow {
  user_id: string;
  push_enabled: number | boolean;
  likes: number | boolean;
  comments: number | boolean;
  mentions: number | boolean;
  status: number | boolean;
}

export interface DeviceTokenRow {
  user_id: string;
  token: string;
}

export interface Delivery {
  notificationId: string;
  userId: string;
  token: string;
  type: string;
  postId: string;
  commentId: string | null;
  /** Validated canonical kind; only set (and only sent) for REACTION rows. */
  reactionKind?: string | null;
}

/**
 * Canonical reaction kinds, mirroring `packages/shared` CANONICAL_REACTION_KINDS.
 * `notifications.reaction_kind` is unconstrained text, so anything outside this
 * set is dropped before it can reach an FCM data payload.
 */
export const CANONICAL_REACTION_KINDS = ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const;

/** Allowlisted kind or null — arbitrary strings never enter the payload. */
export function sanitizeReactionKind(type: string, kind: string | null | undefined): string | null {
  if (type !== "REACTION" || !kind) return null;
  return (CANONICAL_REACTION_KINDS as readonly string[]).includes(kind) ? kind : null;
}

/** Maps a notification type to its preference column; null means never push. */
export function categoryFor(type: string): keyof Pick<PreferenceRow, "likes" | "comments" | "mentions" | "status"> | null {
  switch (type) {
    case "LIKE":
    case "DISLIKE":
    case "REACTION":
      return "likes";
    case "COMMENT":
      return "comments";
    case "MENTION":
      return "mentions";
    case "STATUS":
      return "status";
    // MODERATION notifications (report approved/rejected) are realtime-only:
    // they are surfaced in-app via the inbox subscription, never pushed, so
    // moderation activity is not leaked to a device lock screen (consumer-first).
    case "MODERATION":
      return null;
    default:
      return null;
  }
}

const BODY: Record<string, string> = {
  LIKE: "Someone liked your report",
  DISLIKE: "Someone disliked your report",
  REACTION: "Someone reacted to your report",
  COMMENT: "New comment on your report",
  MENTION: "You were mentioned in a comment",
  STATUS: "A report you follow was updated",
};

function on(value: number | boolean | undefined): boolean {
  return value === undefined ? true : Boolean(value);
}

/**
 * Pure fan-out: one delivery per (notification, eligible device token).
 * Absent preference rows default every category on; push-disabled users get none.
 */
export function planDeliveries(
  notifications: DispatchNotification[],
  preferences: PreferenceRow[],
  tokens: DeviceTokenRow[],
): Delivery[] {
  const prefsByUser = new Map(preferences.map((row) => [row.user_id, row]));
  const tokensByUser = new Map<string, string[]>();
  for (const { user_id, token } of tokens) {
    if (!token) continue;
    const list = tokensByUser.get(user_id) ?? [];
    list.push(token);
    tokensByUser.set(user_id, list);
  }

  const deliveries: Delivery[] = [];
  for (const notification of notifications) {
    const postId = notification.post_id;
    if (!postId) continue;
    const category = categoryFor(notification.type);
    if (!category) continue;
    const prefs = prefsByUser.get(notification.user_id);
    if (prefs && !on(prefs.push_enabled)) continue;
    if (prefs && !on(prefs[category])) continue;
    for (const token of tokensByUser.get(notification.user_id) ?? []) {
      deliveries.push({
        notificationId: notification.id,
        userId: notification.user_id,
        token,
        type: notification.type,
        postId,
        commentId: notification.comment_id ?? null,
        reactionKind: sanitizeReactionKind(notification.type, notification.reaction_kind),
      });
    }
  }
  return deliveries;
}

export interface SendOutcome {
  notificationId: string;
  ok: boolean;
  prune: boolean;
}

export interface DispatchPlan {
  /** Delivered to at least one device, had no eligible device, or failed only
   * terminally: safe to stamp `pushed_at` now. */
  handled: string[];
  /** Nothing delivered and at least one transient failure: keep pending. */
  retry: string[];
}

/**
 * Decides per-notification disposition from the per-delivery results. A
 * notification is only retried when nothing reached a device and at least one
 * failure was transient (not a pruned/invalid token). This is what stops a
 * temporary FCM outage from silently retiring an undelivered notification.
 */
export function planDispatchOutcomes(
  notifications: ReadonlyArray<{ id: string }>,
  results: ReadonlyArray<SendOutcome>,
): DispatchPlan {
  const sent = new Map<string, number>();
  const retryable = new Map<string, number>();
  for (const result of results) {
    if (result.ok) sent.set(result.notificationId, (sent.get(result.notificationId) ?? 0) + 1);
    else if (!result.prune) {
      retryable.set(result.notificationId, (retryable.get(result.notificationId) ?? 0) + 1);
    }
  }
  const handled: string[] = [];
  const retry: string[] = [];
  for (const notification of notifications) {
    const delivered = sent.get(notification.id) ?? 0;
    const transient = retryable.get(notification.id) ?? 0;
    if (delivered > 0 || transient === 0) handled.push(notification.id);
    else retry.push(notification.id);
  }
  return { handled, retry };
}

/**
 * Builds a data-only FCM HTTP v1 `message`. Data-only is required so the app's
 * FirebaseMessagingService can attach the RemoteInput reply action; the system
 * will not auto-display notification payloads. Report content is never included.
 */
export function buildFcmMessage(
  delivery: Delivery,
  origin: string,
  replyToken?: string,
): Record<string, unknown> {
  const data: Record<string, string> = {
    title: "FindBack",
    body: BODY[delivery.type] ?? "New activity on your report",
    type: delivery.type,
    postId: delivery.postId,
    notificationId: delivery.notificationId,
    url: `${origin}/r/${encodeURIComponent(delivery.postId)}`,
  };
  if (delivery.commentId) data.commentId = delivery.commentId;
  // Canonical reaction kind (LOVE/HELPFUL/SUPPORT/WOW) so the Android
  // payload can render the matching icon; sanitized upstream, only REACTION.
  if (delivery.reactionKind) data.reactionKind = delivery.reactionKind;
  if (replyToken) data.replyToken = replyToken;
  return {
    token: delivery.token,
    data,
    android: { priority: "high", ttl: "86400s" },
  };
}

/**
 * Row shape for a minted reply token. Only the hash is persisted; the raw token
 * travels in the FCM payload. Null when the notification cannot be replied to.
 */
export interface ReplyTokenInsert {
  id: string;
  user_id: string;
  post_id: string;
  parent_comment_id: string;
  notification_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
}

export function buildReplyTokenRow(
  notification: DispatchNotification,
  tokenHash: string,
  createdAt: string,
  expiresAt: string,
): ReplyTokenInsert | null {
  if (notification.type !== "COMMENT" || !notification.comment_id || !notification.post_id) {
    return null;
  }
  return {
    id: crypto.randomUUID(),
    user_id: notification.user_id,
    post_id: notification.post_id,
    parent_comment_id: notification.comment_id,
    notification_id: notification.id,
    token_hash: tokenHash,
    created_at: createdAt,
    expires_at: expiresAt,
  };
}

/**
 * Notifications worth minting a reply token for: only those that will actually
 * be pushed. Tokens minted for a user with no eligible device (push disabled,
 * no registered token) would sit unused in `push_reply_tokens` until TTL.
 */
export function notifiableReplyTargets(
  notifications: ReadonlyArray<DispatchNotification>,
  deliveries: ReadonlyArray<Pick<Delivery, "notificationId">>,
): DispatchNotification[] {
  const delivered = new Set(deliveries.map((delivery) => delivery.notificationId));
  return notifications.filter((notification) => delivered.has(notification.id));
}

export function isAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  if (header.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/** True when FCM says this token can never succeed and should be removed. */
export function shouldPruneToken(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /UNREGISTERED|INVALID_ARGUMENT|registration-token-not-registered|requested entity was not found/i.test(
    body,
  );
}

/**
 * The configuration this function needs to send anything. Names only: a value
 * is never echoed, logged or returned.
 */
export const REQUIRED_DISPATCH_CONFIG = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "FCM_PROJECT_ID",
  "PUBLIC_SHARE_ORIGIN",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
] as const;

/** The names of the configuration that is absent. Empty means "fully set up". */
export function missingDispatchConfig(env: Record<string, string | undefined>): string[] {
  return REQUIRED_DISPATCH_CONFIG.filter((name) => !env[name]?.trim());
}

/**
 * A misconfigured dispatcher fails loudly, in a way an operator can see in the
 * function log, and it never looks like a successful run: the response names
 * the missing configuration and reports that nothing was sent.
 */
export function configurationFailure(missing: string[]): Response {
  console.error(
    `push-dispatch: not configured — missing ${missing.join(", ")}. No notifications were sent.`,
  );
  return Response.json(
    { error: "dispatch not configured", missing, scanned: 0, sent: 0 },
    { status: 503 },
  );
}

async function getAccessToken(serviceAccount: {
  client_email: string;
  private_key: string;
  token_uri?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: FCM_SCOPE,
      aud: serviceAccount.token_uri ?? GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = await signRs256(`${header}.${claims}`, serviceAccount.private_key);
  const assertion = `${header}.${claims}.${signature}`;
  const response = await fetch(serviceAccount.token_uri ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error("oauth token exchange failed");
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("oauth token missing");
  return payload.access_token;
}

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RS256-sign `data` with a PKCS#8 PEM private key using WebCrypto (no npm dep). */
async function signRs256(data: string, pem: string): Promise<string> {
  // Drop the PEM armor lines, then all whitespace, leaving base64 DER.
  const der = pem
    .split("\n")
    .filter((line) => !line.includes("-----"))
    .join("")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(der), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface SendResult {
  ok: boolean;
  prune: boolean;
  status: number;
}

async function sendMessage(
  projectId: string,
  accessToken: string,
  message: Record<string, unknown>,
): Promise<SendResult> {
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (response.ok) return { ok: true, prune: false, status: response.status };
  const body = await response.text();
  return { ok: false, prune: shouldPruneToken(response.status, body), status: response.status };
}

export default {
  async fetch(req: Request): Promise<Response> {
    const secret = Deno.env.get("PUSH_DISPATCH_SECRET");
    if (!secret?.trim()) return configurationFailure(["PUSH_DISPATCH_SECRET"]);
    if (!isAuthorized(req.headers.get("x-findback-dispatch-secret"), secret)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const projectId = Deno.env.get("FCM_PROJECT_ID");
    const origin = Deno.env.get("PUBLIC_SHARE_ORIGIN");
    const senderJson = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");
    const missing = missingDispatchConfig({
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      FCM_PROJECT_ID: projectId,
      PUBLIC_SHARE_ORIGIN: origin,
      FIREBASE_SERVICE_ACCOUNT_JSON: senderJson,
    });
    // A missing credential is a loud, named failure — never a green no-op and
    // never a result that looks like a successful send.
    if (missing.length > 0) return configurationFailure(missing);

    const admin = createClient(supabaseUrl!, serviceKey!, { auth: { persistSession: false } });
    const { data: pending, error: readError } = await admin
      .from("notifications")
      .select("id, user_id, type, post_id, comment_id, created_at, reaction_kind")
      .is("pushed_at", null)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);
    if (readError) {
      console.error("push-dispatch: could not read pending notifications. No notifications were sent.");
      return Response.json({ error: "read failed", scanned: 0, sent: 0 }, { status: 500 });
    }

    const notifications = (pending ?? []) as DispatchNotification[];
    if (notifications.length === 0) return Response.json({ scanned: 0, sent: 0, pruned: 0, failed: 0 });

    const userIds = [...new Set(notifications.map((n) => n.user_id))];
    const [{ data: prefs }, { data: tokens }] = await Promise.all([
      admin.from("notification_preferences").select("*").in("user_id", userIds),
      admin.from("device_tokens").select("user_id, token").in("user_id", userIds),
    ]);

    const deliveries = planDeliveries(
      notifications,
      (prefs ?? []) as PreferenceRow[],
      (tokens ?? []) as DeviceTokenRow[],
    );

    let accessToken = "";
    try {
      accessToken = await getAccessToken(JSON.parse(senderJson!));
    } catch {
      console.error("push-dispatch: FIREBASE_SERVICE_ACCOUNT_JSON is invalid or FCM authentication failed. No notifications were sent.");
      return Response.json(
        { error: "fcm auth failed", scanned: notifications.length, sent: 0 },
        { status: 502 },
      );
    }

    // One single-use reply token per COMMENT notification, shared by that user's
    // devices so a reply sent from any device consumes it once. Only minted for
    // notifications that will actually be pushed (at least one planned
    // delivery): a user with no eligible device must not leave orphan tokens.
    const replyTokens = new Map<string, string>();
    const tokenCreatedAt = new Date().toISOString();
    const tokenExpiresAt = new Date(Date.now() + REPLY_TOKEN_TTL_MS).toISOString();
    for (const notification of notifiableReplyTargets(notifications, deliveries)) {
      if (notification.type !== "COMMENT" || !notification.comment_id || !notification.post_id) continue;
      const raw = generateReplyToken();
      const row = buildReplyTokenRow(
        notification,
        await hashToken(raw),
        tokenCreatedAt,
        tokenExpiresAt,
      );
      if (!row) continue;
      const { error } = await admin.from("push_reply_tokens").insert(row);
      if (!error) replyTokens.set(notification.id, raw);
    }

    let sent = 0;
    let failed = 0;
    const pruned: string[] = [];
    const outcomes: SendOutcome[] = [];
    for (const delivery of deliveries) {
      const result = await sendMessage(
        projectId!,
        accessToken,
        buildFcmMessage(delivery, origin!, replyTokens.get(delivery.notificationId)),
      );
      outcomes.push({ notificationId: delivery.notificationId, ok: result.ok, prune: result.prune });
      if (result.ok) sent += 1;
      else {
        failed += 1;
        if (result.prune) pruned.push(delivery.token);
      }
    }

    // Terminal disposition only: a notification with no eligible device, one
    // delivered anywhere, or only invalid-token failures is stamped. A
    // notification whose only failures were transient stays pending so the next
    // scheduled run retries it, up to MAX_PUSH_ATTEMPTS.
    const { handled, retry } = planDispatchOutcomes(notifications, outcomes);
    const pushedAt = new Date().toISOString();
    if (handled.length > 0) {
      await admin.from("notifications").update({ pushed_at: pushedAt }).in("id", handled);
    }
    let retired = 0;
    if (retry.length > 0) {
      const { data } = await admin.rpc("findback_record_push_failure", {
        p_ids: retry,
        p_error: "temporary FCM failure",
        p_max_attempts: MAX_PUSH_ATTEMPTS,
      });
      retired = Number(data ?? 0);
    }

    if (pruned.length > 0) {
      await admin.from("device_tokens").delete().in("token", [...new Set(pruned)]);
    }

    return Response.json({
      scanned: notifications.length,
      sent,
      pruned: pruned.length,
      failed,
      retried: retry.length,
      retired,
    });
  },
};
