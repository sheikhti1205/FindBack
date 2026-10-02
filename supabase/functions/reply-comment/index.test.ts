/**
 * reply-comment / shared reply-token tests.
 * Run with `deno test supabase/functions/reply-comment/`.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  evaluateReplyToken,
  generateReplyToken,
  hashToken,
  isWellFormedToken,
  MAX_REPLY_BODY,
  normalizeReplyBody,
  type ReplyTokenRow,
} from "../_shared/replyTokens.ts";

const row = (overrides: Partial<ReplyTokenRow> = {}): ReplyTokenRow => ({
  id: "t1",
  user_id: "u1",
  post_id: "p1",
  parent_comment_id: "c1",
  expires_at: "2030-01-01T00:00:00.000Z",
  used_at: null,
  ...overrides,
});

Deno.test("normalizeReplyBody trims and enforces 1-1000 characters", () => {
  assertEquals(normalizeReplyBody("  hello  "), "hello");
  assertEquals(normalizeReplyBody(""), null);
  assertEquals(normalizeReplyBody("   "), null);
  assertEquals(normalizeReplyBody("x".repeat(MAX_REPLY_BODY)), "x".repeat(MAX_REPLY_BODY));
  assertEquals(normalizeReplyBody("x".repeat(MAX_REPLY_BODY + 1)), null);
  assertEquals(normalizeReplyBody(42), null);
  assertEquals(normalizeReplyBody(null), null);
});

Deno.test("isWellFormedToken accepts only 43-char base64url", () => {
  assert(isWellFormedToken("A".repeat(43)));
  assert(!isWellFormedToken("A".repeat(42)));
  assert(!isWellFormedToken("A".repeat(44)));
  assert(!isWellFormedToken("A".repeat(42) + "+"));
  assert(!isWellFormedToken(undefined));
});

Deno.test("evaluateReplyToken rejects missing, used and expired tokens", () => {
  const now = "2026-10-02T00:00:00.000Z";
  assertEquals(evaluateReplyToken(null, now), { ok: false, reason: "missing" });
  assertEquals(evaluateReplyToken(row({ used_at: now }), now), { ok: false, reason: "used" });
  assertEquals(
    evaluateReplyToken(row({ expires_at: "2020-01-01T00:00:00.000Z" }), now),
    { ok: false, reason: "expired" },
  );
  assertEquals(evaluateReplyToken(row(), now), { ok: true });
});

Deno.test("hashToken is a deterministic 64-char hex digest", async () => {
  const token = "A".repeat(43);
  const first = await hashToken(token);
  const second = await hashToken(token);
  assertEquals(first, second);
  assert(/^[0-9a-f]{64}$/.test(first));
  assertNotEquals(first, await hashToken("B".repeat(43)));
});

Deno.test("generateReplyToken produces distinct 43-char base64url tokens", () => {
  const a = generateReplyToken();
  const b = generateReplyToken();
  assert(isWellFormedToken(a));
  assert(isWellFormedToken(b));
  assertNotEquals(a, b);
});
