/**
 * push-dispatch unit tests. Run with `deno test supabase/functions/push-dispatch/`.
 * Pure planning/payload/auth only: no network, no secrets, no database.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import dispatcher from "./index.ts";
import {
  buildFcmMessage,
  buildReplyTokenRow,
  categoryFor,
  configurationFailure,
  isAuthorized,
  missingDispatchConfig,
  notifiableReplyTargets,
  planDeliveries,
  planDispatchOutcomes,
  sanitizeReactionKind,
  shouldPruneToken,
  type Delivery,
  type DispatchNotification,
} from "./index.ts";

const notification = (overrides: Partial<DispatchNotification> = {}): DispatchNotification => ({
  id: "n1",
  user_id: "u1",
  type: "LIKE",
  post_id: "p1",
  comment_id: null,
  created_at: "2026-10-02T00:00:00.000Z",
  ...overrides,
});

const prefs = (overrides: Record<string, unknown> = {}) => ({
  user_id: "u1",
  push_enabled: 1,
  likes: 1,
  comments: 1,
  mentions: 1,
  status: 1,
  ...overrides,
});

const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  notificationId: "n1",
  userId: "u1",
  token: "tok",
  type: "COMMENT",
  postId: "post-9",
  commentId: "c1",
  ...overrides,
});

Deno.test("categoryFor maps every notification type", () => {
  assertEquals(categoryFor("LIKE"), "likes");
  assertEquals(categoryFor("DISLIKE"), "likes");
  assertEquals(categoryFor("REACTION"), "likes");
  assertEquals(categoryFor("COMMENT"), "comments");
  assertEquals(categoryFor("MENTION"), "mentions");
  assertEquals(categoryFor("STATUS"), "status");
  assertEquals(categoryFor("MODERATION"), null);
  assertEquals(categoryFor("UNKNOWN"), null);
});

Deno.test("buildFcmMessage renders a REACTION notification (W1-A FBX-009)", () => {
  const message = buildFcmMessage(
    delivery({ type: "REACTION", commentId: null }),
    "https://findbackapp.social",
  ) as { data: Record<string, string> };
  assertEquals(message.data.type, "REACTION");
  assertEquals(message.data.body, "Someone reacted to your report");
});

Deno.test("planDeliveries defaults to all-on and fans out per token", () => {
  const deliveries = planDeliveries(
    [notification()],
    [],
    [{ user_id: "u1", token: "a" }, { user_id: "u1", token: "b" }],
  );
  assertEquals(deliveries.length, 2);
  assertEquals(deliveries.map((d) => d.token).sort(), ["a", "b"]);
});

Deno.test("planDeliveries honours push and category opt-outs", () => {
  const off = planDeliveries(
    [notification()],
    [prefs({ push_enabled: 0 })],
    [{ user_id: "u1", token: "a" }],
  );
  assertEquals(off, []);

  const noLikes = planDeliveries(
    [notification({ type: "LIKE" })],
    [prefs({ likes: 0 })],
    [{ user_id: "u1", token: "a" }],
  );
  assertEquals(noLikes, []);

  const stillComment = planDeliveries(
    [notification({ type: "COMMENT", comment_id: "c1" })],
    [prefs({ likes: 0 })],
    [{ user_id: "u1", token: "a" }],
  );
  assertEquals(stillComment.length, 1);
  assertEquals(stillComment[0]!.commentId, "c1");
});

Deno.test("planDeliveries skips rows with no report or no device", () => {
  const noPost = planDeliveries([notification({ post_id: null })], [], [{ user_id: "u1", token: "a" }]);
  assertEquals(noPost, []);
  const noDevice = planDeliveries([notification()], [], []);
  assertEquals(noDevice, []);
});

Deno.test("buildFcmMessage is data-only and carries the report URL, no content", () => {
  const message = buildFcmMessage(delivery(), "https://findbackapp.social") as {
    token: string;
    notification?: unknown;
    data: Record<string, string>;
    android: { priority: string };
  };
  assertEquals(message.token, "tok");
  assertEquals(message.notification, undefined);
  assertEquals(message.data.title, "FindBack");
  assertEquals(message.data.url, "https://findbackapp.social/r/post-9");
  assertEquals(message.data.postId, "post-9");
  assertEquals(message.data.commentId, "c1");
  assertEquals(message.android.priority, "high");
  assert(!("replyToken" in message.data));
});

Deno.test("buildFcmMessage includes a reply token only when supplied", () => {
  const token = "A".repeat(43);
  const message = buildFcmMessage(delivery(), "https://findbackapp.social", token) as {
    data: Record<string, string>;
  };
  assertEquals(message.data.replyToken, token);
});

Deno.test("buildReplyTokenRow is only for comment notifications on a report", () => {
  const created = "2026-10-02T00:00:00.000Z";
  const expires = "2026-10-09T00:00:00.000Z";
  const row = buildReplyTokenRow(
    notification({ type: "COMMENT", comment_id: "c1" }),
    "hash",
    created,
    expires,
  );
  assertEquals(row?.parent_comment_id, "c1");
  assertEquals(row?.post_id, "p1");
  assertEquals(row?.notification_id, "n1");
  assertEquals(row?.token_hash, "hash");
  assertEquals(row?.expires_at, expires);

  assertEquals(buildReplyTokenRow(notification({ type: "LIKE" }), "h", created, expires), null);
  assertEquals(
    buildReplyTokenRow(notification({ type: "COMMENT", comment_id: null }), "h", created, expires),
    null,
  );
  assertEquals(
    buildReplyTokenRow(notification({ type: "COMMENT", comment_id: "c1", post_id: null }), "h", created, expires),
    null,
  );
});

Deno.test("isAuthorized compares the dispatch secret in constant time", () => {
  assert(isAuthorized("s3cret", "s3cret"));
  assert(!isAuthorized("s3cret", "other"));
  assert(!isAuthorized("short", "s3cret-longer"));
  assert(!isAuthorized(null, "s3cret"));
  assert(!isAuthorized("anything", undefined));
});

Deno.test("shouldPruneToken only prunes permanently invalid tokens", () => {
  assert(shouldPruneToken(404, ""));
  assert(shouldPruneToken(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}'));
  assert(shouldPruneToken(400, "Requested entity was not found."));
  assert(!shouldPruneToken(500, "UNREGISTERED"));
  assert(!shouldPruneToken(429, "quota"));
  assert(!shouldPruneToken(400, "some other invalid request"));
});

Deno.test("planDispatchOutcomes retires delivered, device-less and terminal-failure rows", () => {
  const notifications = [{ id: "n1" }, { id: "n2" }, { id: "n3" }, { id: "n4" }];
  const plan = planDispatchOutcomes(notifications, [
    { notificationId: "n1", ok: true, prune: false },
    { notificationId: "n2", ok: false, prune: true },
    // n3 has no deliveries at all (no device / preference off)
    { notificationId: "n4", ok: false, prune: false },
  ]);
  assertEquals(plan.handled.sort(), ["n1", "n2", "n3"]);
  assertEquals(plan.retry, ["n4"]);
});

Deno.test("planDispatchOutcomes keeps a notification pending only on transient failure", () => {
  const plan = planDispatchOutcomes(
    [{ id: "n1" }],
    [
      { notificationId: "n1", ok: false, prune: false },
      { notificationId: "n1", ok: false, prune: false },
    ],
  );
  assertEquals(plan.handled, []);
  assertEquals(plan.retry, ["n1"]);
});

Deno.test("planDispatchOutcomes treats a partial send as handled", () => {
  const plan = planDispatchOutcomes(
    [{ id: "n1" }],
    [
      { notificationId: "n1", ok: true, prune: false },
      { notificationId: "n1", ok: false, prune: false },
    ],
  );
  assertEquals(plan.handled, ["n1"]);
  assertEquals(plan.retry, []);
});

Deno.test("sanitizeReactionKind forwards only canonical REACTION kinds", () => {
  assertEquals(sanitizeReactionKind("REACTION", "LOVE"), "LOVE");
  assertEquals(sanitizeReactionKind("REACTION", "HELPFUL"), "HELPFUL");
  assertEquals(sanitizeReactionKind("REACTION", "SUPPORT"), "SUPPORT");
  assertEquals(sanitizeReactionKind("REACTION", "WOW"), "WOW");
  // Legacy kinds and anything unexpected are dropped before the payload.
  assertEquals(sanitizeReactionKind("REACTION", "LIKE"), null);
  assertEquals(sanitizeReactionKind("REACTION", "unknown; drop table"), null);
  assertEquals(sanitizeReactionKind("REACTION", null), null);
  assertEquals(sanitizeReactionKind("REACTION", undefined), null);
  // Non-REACTION types never carry a kind, even if the column is set.
  assertEquals(sanitizeReactionKind("LIKE", "LOVE"), null);
});

Deno.test("planDeliveries carries a validated reaction kind onto each delivery", () => {
  const rows = planDeliveries(
    [notification({ type: "REACTION", reaction_kind: "HELPFUL" })],
    [prefs()],
    [{ user_id: "u1", token: "tok-1" }],
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.reactionKind, "HELPFUL");
});

Deno.test("planDeliveries drops an unknown reaction kind", () => {
  const rows = planDeliveries(
    [notification({ type: "REACTION", reaction_kind: "EVIL" })],
    [prefs()],
    [{ user_id: "u1", token: "tok-1" }],
  );
  assertEquals(rows[0]?.reactionKind, null);
});

Deno.test("buildFcmMessage carries the reaction kind on REACTION pushes only", () => {
  const withKind = buildFcmMessage(
    delivery({ type: "REACTION", commentId: null, reactionKind: "SUPPORT" }),
    "https://findback.example",
  );
  assertEquals((withKind.data as Record<string, string>).reactionKind, "SUPPORT");

  const withoutKind = buildFcmMessage(
    delivery({ type: "REACTION", commentId: null }),
    "https://findback.example",
  );
  assertEquals("reactionKind" in (withoutKind.data as Record<string, string>), false);

  const comment = buildFcmMessage(delivery(), "https://findback.example");
  assertEquals("reactionKind" in (comment.data as Record<string, string>), false);
});

Deno.test("notifiableReplyTargets only keeps notifications with a planned delivery", () => {
  const rows = [
    notification({ id: "n1", type: "COMMENT", comment_id: "c1" }),
    notification({ id: "n2", type: "COMMENT", comment_id: "c2" }),
  ];
  assertEquals(
    notifiableReplyTargets(rows, [{ notificationId: "n1" }]).map((row) => row.id),
    ["n1"],
  );
  assertEquals(notifiableReplyTargets(rows, []).length, 0);
  assertEquals(notifiableReplyTargets([], [{ notificationId: "n1" }]).length, 0);
});

Deno.test("missingDispatchConfig names every absent credential and nothing else", () => {
  assertEquals(missingDispatchConfig({}), [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "FCM_PROJECT_ID",
    "PUBLIC_SHARE_ORIGIN",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
  ]);
  const complete = {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    FCM_PROJECT_ID: "project",
    PUBLIC_SHARE_ORIGIN: "https://findbackapp.social",
    FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
  };
  assertEquals(missingDispatchConfig(complete), []);
  // A blank value is as absent as a missing one.
  assertEquals(
    missingDispatchConfig({ ...complete, FIREBASE_SERVICE_ACCOUNT_JSON: "   " }),
    ["FIREBASE_SERVICE_ACCOUNT_JSON"],
  );
});

Deno.test("configurationFailure fails loudly, names the reason and never reports a send", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  let response: Response;
  try {
    response = configurationFailure(["PUSH_DISPATCH_SECRET"]);
  } finally {
    console.error = original;
  }
  assertEquals(response.status, 503);
  const body = await response.json();
  assertEquals(body.error, "dispatch not configured");
  assertEquals(body.missing, ["PUSH_DISPATCH_SECRET"]);
  // Nothing was sent, and the response must not look like a successful run.
  assertEquals(body.sent, 0);
  // The operator sees the reason in the function log.
  assert(logs.length === 1);
  assert(logs[0]!.includes("PUSH_DISPATCH_SECRET"));
});

Deno.test("request with an absent dispatch secret returns 503 before any network call", async () => {
  const original = Deno.env.get;
  Deno.env.get = () => undefined;
  try {
    const response = await dispatcher.fetch(new Request("https://example.test", { method: "POST" }));
    assertEquals(response.status, 503);
    assertEquals((await response.json()).missing, ["PUSH_DISPATCH_SECRET"]);
  } finally { Deno.env.get = original; }
});

Deno.test("authorized request names missing sender credentials and sends nothing", async () => {
  const original = Deno.env.get;
  Deno.env.get = (key: string) => key === "PUSH_DISPATCH_SECRET" ? "test-only" : undefined;
  try {
    const response = await dispatcher.fetch(new Request("https://example.test", {
      method: "POST", headers: { "x-findback-dispatch-secret": "test-only" },
    }));
    assertEquals(response.status, 503);
    const body = await response.json();
    assert(body.missing.includes("FIREBASE_SERVICE_ACCOUNT_JSON"));
    assertEquals(body.sent, 0);
  } finally { Deno.env.get = original; }
});

// Real fetch handler with in-memory HTTP peers. No live env/key/network access.
async function dispatchFixture(states: Array<boolean | "error">) {
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  // Composed at runtime so the repository never contains a literal key header
  // for the secret scanner to flag. The material is a throwaway key generated
  // in this test, never a credential.
  const pem = `${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\n${btoa(String.fromCharCode(...bytes))}\n${["-----END", "PRIVATE", "KEY-----"].join(" ")}`;
  const fakeEnv: Record<string, string> = {
    PUSH_DISPATCH_SECRET: "test-only", SUPABASE_URL: "https://dispatch.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-credential", FCM_PROJECT_ID: "test-project",
    PUBLIC_SHARE_ORIGIN: "https://findback.invalid", FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "test@example.invalid", private_key: pem,
    }),
  };
  const originalEnv = Deno.env.get;
  const originalFetch = globalThis.fetch;
  const minted: unknown[] = []; const stamped: unknown[] = []; const retiredTokens: string[] = [];
  let sent = 0; let checked = 0; let retries = 0;
  Deno.env.get = (name) => fakeEnv[name];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "test-only-access", expires_in: 3600 });
    if (url.hostname === "fcm.googleapis.com") { sent++; return json({ name: "test-message" }); }
    if (url.hostname !== "dispatch.invalid") throw new Error("Unexpected network destination");
    if (url.pathname.endsWith("/rpc/findback_notification_delivery_allowed")) {
      assertEquals(await request.json(), { p_notification_id: "n1" });
      const state = states[Math.min(checked++, states.length - 1)];
      return state === "error" ? json({ message: "test unavailable" }, 503) : json(state);
    }
    if (url.pathname.endsWith("/rpc/findback_record_push_failure")) { retries++; return json(0); }
    if (url.pathname.endsWith("/notifications")) {
      if (request.method === "GET") return json([notification({ type: "COMMENT", comment_id: "c1" })]);
      stamped.push(await request.json()); return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/notification_preferences")) return json([prefs()]);
    if (url.pathname.endsWith("/device_tokens")) return json([{ user_id: "u1", token: "test-device" }]);
    if (url.pathname.endsWith("/push_reply_tokens")) {
      if (request.method === "POST") minted.push(await request.json());
      if (request.method === "DELETE") retiredTokens.push(url.search);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected test route ${url.pathname}`);
  };
  try {
    const response = await dispatcher.fetch(new Request("https://example.invalid", {
      method: "POST", headers: { "x-findback-dispatch-secret": "test-only" },
    }));
    return { status: response.status, body: await response.json(), checked, minted, stamped, sent, retries, retiredTokens };
  } finally { Deno.env.get = originalEnv; globalThis.fetch = originalFetch; }
}

Deno.test("queued notification concealed before scan mints and sends nothing, then retires", async () => {
  const r = await dispatchFixture([false]);
  assertEquals(r.sent, 0); assertEquals(r.minted.length, 0);
  assertEquals(r.checked, 1); assertEquals(r.stamped.length, 1);
});
Deno.test("eligibility RPC error fails closed and leaves pending notification retryable", async () => {
  const r = await dispatchFixture(["error"]);
  assertEquals(r.sent, 0); assertEquals(r.minted.length, 0); assertEquals(r.stamped.length, 0);
  assertEquals(r.status, 503);
});
Deno.test("recipient concealed after scan is checked again before token mint", async () => {
  const r = await dispatchFixture([true, false]);
  assertEquals(r.sent, 0); assertEquals(r.minted.length, 0); assertEquals(r.stamped.length, 1);
});
Deno.test("recipient concealed after token mint is checked before send and token is retired", async () => {
  const r = await dispatchFixture([true, true, false]);
  assertEquals(r.sent, 0); assertEquals(r.minted.length, 1);
  assertEquals(r.retiredTokens.length, 1); assertEquals(r.stamped.length, 1);
});
Deno.test("eligibility failure after token mint sends nothing and retries without terminal stamp", async () => {
  const r = await dispatchFixture([true, true, "error"]);
  assertEquals(r.sent, 0); assertEquals(r.stamped.length, 0); assertEquals(r.retries, 1);
});
Deno.test("eligible recipient gets one token and one send through the actual handler", async () => {
  const r = await dispatchFixture([true]);
  assertEquals(r.checked, 3); assertEquals(r.sent, 1); assertEquals(r.minted.length, 1); assertEquals(r.stamped.length, 1);
});
