/**
 * push-dispatch unit tests. Run with `deno test supabase/functions/push-dispatch/`.
 * Pure planning/payload/auth only: no network, no secrets, no database.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import {
  buildFcmMessage,
  buildReplyTokenRow,
  categoryFor,
  isAuthorized,
  planDeliveries,
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
  assertEquals(categoryFor("COMMENT"), "comments");
  assertEquals(categoryFor("MENTION"), "mentions");
  assertEquals(categoryFor("STATUS"), "status");
  assertEquals(categoryFor("UNKNOWN"), null);
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
