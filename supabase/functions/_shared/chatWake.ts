/**
 * Shared chat external-wake delivery (P11).
 *
 * One implementation for both consumers:
 *   - `push-dispatch` drains the queue on its schedule (backstop);
 *   - `chat-wake` claims only the wake belonging to one message right after
 *     the sender posts it, so a connected recipient learns about it in
 *     seconds instead of on the next ten-minute sweep.
 *
 * The queue, lease and eligibility rules stay in SQL
 * (`20261027030000_chat_external_wake.sql`); this module only performs the FCM
 * step and writes the disposition back. Payloads are data-only and
 * content-free: a wake carries ids and a kind, never a message body.
 */

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** One device per claim, so a lease never expires while earlier sends run. */
export const CHAT_CLAIM_CHUNK = 1;
export const CHAT_MAX_CLAIMS_PER_INVOCATION = 100;

export interface ChatClaim {
  wake_id: string;
  device_id: string;
  claim_token: string;
}

export interface ChatWakeDelivery {
  wakeId: string;
  recipientId: string;
  conversationId: string;
  kind: "CHAT_REQUEST" | "CHAT_CONNECTED";
  token: string;
}

export type ChatDisposition = "SENT" | "SUPPRESSED" | "INVALID" | "RETRY";

export interface FcmSendResult {
  ok: boolean;
  prune: boolean;
  status: number;
}

/** Structural view of the service-role client this module needs. */
export interface ChatWakeAdmin {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    delete(): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): {
          eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
}

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RS256-sign `data` with a PKCS#8 PEM private key using WebCrypto (no npm dep). */
async function signRs256(data: string, pem: string): Promise<string> {
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

export async function getChatAccessToken(
  serviceAccount: { client_email: string; private_key: string; token_uri?: string },
  signal?: AbortSignal,
): Promise<string> {
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
    signal,
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

export function shouldPruneToken(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /UNREGISTERED|INVALID_ARGUMENT|registration-token-not-registered|requested entity was not found/i.test(
    body,
  );
}

export async function sendFcm(
  projectId: string,
  accessToken: string,
  message: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FcmSendResult> {
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (response.ok) return { ok: true, prune: false, status: response.status };
  const body = await response.text();
  return { ok: false, prune: shouldPruneToken(response.status, body), status: response.status };
}

/** Data-only, content-free; a stable wake ID supports collapse/native dedupe. */
export function buildChatFcmMessage(delivery: ChatWakeDelivery): Record<string, unknown> {
  return {
    token: delivery.token,
    data: {
      type: delivery.kind,
      recipientId: delivery.recipientId,
      conversationId: delivery.conversationId,
      notificationId: delivery.wakeId,
    },
    android: { priority: "normal", ttl: "86400s", collapse_key: delivery.wakeId },
  };
}

/**
 * One claimed device: re-read eligibility, send once, write the disposition.
 * Any failure becomes RETRY so the row is reclaimed after its lease, never a
 * silent loss. Returns the disposition it wrote.
 */
export async function deliverClaimedChatWake(
  admin: ChatWakeAdmin,
  projectId: string,
  senderJson: string,
  claim: ChatClaim,
  tokenCache?: { token: string | null },
): Promise<ChatDisposition> {
  let disposition: ChatDisposition = "RETRY";
  let delivery: ChatWakeDelivery | null = null;
  try {
    const result = await admin.rpc("findback_chat_external_wake_delivery", {
      p_wake_id: claim.wake_id,
      p_device_id: claim.device_id,
      p_claim_token: claim.claim_token,
    });
    if (result.error) throw new Error("Chat wake eligibility unavailable");
    if (result.data === null) {
      disposition = "SUPPRESSED";
    } else {
      const value = result.data as Record<string, unknown>;
      if (
        value.wakeId !== claim.wake_id ||
        typeof value.recipientId !== "string" ||
        typeof value.conversationId !== "string" ||
        typeof value.token !== "string" ||
        (value.kind !== "CHAT_REQUEST" && value.kind !== "CHAT_CONNECTED")
      ) {
        throw new Error("Invalid chat wake delivery");
      }
      delivery = value as unknown as ChatWakeDelivery;
      if (!tokenCache?.token) {
        const token = await getChatAccessToken(JSON.parse(senderJson), AbortSignal.timeout(30_000));
        if (tokenCache) tokenCache.token = token;
        else tokenCache = { token };
      }
      const accessToken = tokenCache?.token;
      if (!accessToken) throw new Error("Chat wake token unavailable");
      // Recheck after OAuth, immediately before the device send.
      const recheck = await admin.rpc("findback_chat_external_wake_delivery", {
        p_wake_id: claim.wake_id,
        p_device_id: claim.device_id,
        p_claim_token: claim.claim_token,
      });
      if (recheck.error) throw new Error("Chat wake eligibility unavailable");
      if (recheck.data === null) {
        disposition = "SUPPRESSED";
      } else if (JSON.stringify(recheck.data) !== JSON.stringify(value)) {
        throw new Error("Chat wake changed");
      } else {
        const sent = await sendFcm(
          projectId,
          accessToken,
          buildChatFcmMessage(delivery),
          AbortSignal.timeout(30_000),
        );
        disposition = sent.ok ? "SENT" : sent.prune ? "INVALID" : "RETRY";
      }
    }
  } catch {
    // Transient failure (OAuth, network, a malformed delivery): RETRY leaves
    // the row reclaimable after the 2-minute lease and bounded by the SQL
    // attempt ceiling (5), so it can never retry forever.
    disposition = "RETRY";
  }
  const finish = await admin.rpc("findback_finish_chat_external_wake", {
    p_wake_id: claim.wake_id,
    p_device_id: claim.device_id,
    p_claim_token: claim.claim_token,
    p_result: disposition,
  });
  if (finish.error || finish.data !== true) throw new Error("Chat wake disposition unavailable");
  if (disposition === "INVALID" && delivery) {
    // Never prune a token that has changed owner since the eligibility check.
    await admin
      .from("device_tokens")
      .delete()
      .eq("id", claim.device_id)
      .eq("user_id", delivery.recipientId)
      .eq("token", delivery.token);
  }
  return disposition;
}

/**
 * Claim and deliver until the claim function returns nothing or `limit` claims
 * have been handled. `claimNext` owns the scope: the scheduler claims any due
 * wake, `chat-wake` claims only the wakes of one message.
 */
export async function drainChatWakes(
  admin: ChatWakeAdmin,
  projectId: string,
  senderJson: string,
  claimNext: (limit: number) => Promise<ChatClaim[]>,
  limit: number = CHAT_MAX_CLAIMS_PER_INVOCATION,
): Promise<{ claimed: number; sent: number; failed: number }> {
  let claimed = 0;
  let sent = 0;
  let failed = 0;
  const tokenCache: { token: string | null } = { token: null };
  for (let i = 0; i < limit; i += 1) {
    const batch = await claimNext(CHAT_CLAIM_CHUNK);
    if (batch.length === 0) break;
    for (const claim of batch) {
      claimed += 1;
      const disposition = await deliverClaimedChatWake(admin, projectId, senderJson, claim, tokenCache);
      if (disposition === "SENT") sent += 1;
      else if (disposition !== "SUPPRESSED") failed += 1;
    }
  }
  return { claimed, sent, failed };
}
