/**
 * push-dispatch unit tests. Run with `deno test supabase/functions/push-dispatch/`.
 * Pure planning/payload/auth only: no network, no secrets, no database.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import {
  buildFcmMessage,
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
    [notification({ type: "COMMENT" })],
    [prefs({ likes: 0 })],
    [{ user_id: "u1", token: "a" }],
  );
  assertEquals(stillComment.length, 1);
});

Deno.test("planDeliveries skips rows with no report or no device", () => {
  const noPost = planDeliveries([notification({ post_id: null })], [], [{ user_id: "u1", token: "a" }]);
  assertEquals(noPost, []);
  const noDevice = planDeliveries([notification()], [], []);
  assertEquals(noDevice, []);
});

Deno.test("buildFcmMessage carries only the report URL, never report content", () => {
  const delivery: Delivery = {
    notificationId: "n1",
    userId: "u1",
    token: "tok",
    type: "COMMENT",
    postId: "post-9",
  };
  const message = buildFcmMessage(delivery, "https://findbackapp.social") as {
    token: string;
    notification: { title: string; body: string };
    data: Record<string, string>;
    android: { notification: { channel_id: string; tag: string } };
  };
  assertEquals(message.token, "tok");
  assertEquals(message.notification.title, "FindBack");
  assertEquals(message.data.url, "https://findbackapp.social/r/post-9");
  assertEquals(message.data.postId, "post-9");
  assertEquals(message.android.notification.channel_id, "findback_updates");
  assertEquals(message.android.notification.tag, "n1");
  assert(!JSON.stringify(message).includes("Lost"));
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
