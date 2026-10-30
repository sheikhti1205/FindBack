/**
 * Lane isolation boundary tests.
 *
 * Runs under Deno: `deno test supabase/functions/_shared/`.
 * Behavioural coverage of the production two-lane seam lives in
 * `dispatchLanes_test.ts`; this file covers the boundary primitive itself.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { boundedLaneError, degradedLanes, isolateLane, redactSecrets } from "./laneIsolation.ts";

Deno.test("a lane throw becomes a bounded failure value", async () => {
  const outcome = await isolateLane("chat", () => Promise.reject(new Error("findback_claim_chat_external_wakes unavailable")));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error, "findback_claim_chat_external_wakes unavailable");
  }
  assertEquals(degradedLanes(["chat", outcome]), ["chat"]);
});

Deno.test("lane errors are bounded and carry no stack or newlines", async () => {
  const logged: string[] = [];
  const outcome = await isolateLane(
    "chat",
    () => Promise.reject(new Error(`boom\n${"x".repeat(500)}`)),
    (message) => logged.push(message),
  );
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.length <= 200, true);
    assertEquals(outcome.error.includes("\n"), false);
  }
  assertEquals(logged.length, 1);
  assertEquals(logged[0]!.length <= 200 + "chat lane failed: ".length, true);
});

Deno.test("a throwing logger never becomes a dispatcher failure", async () => {
  const outcome = await isolateLane(
    "chat",
    () => Promise.reject(new Error("denied")),
    () => {
      throw new Error("logger failed");
    },
  );
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.error, "denied");
});

Deno.test("successful lanes keep their value untouched", async () => {
  const outcome = await isolateLane("chat", () => Promise.resolve({ claimed: 1, sent: 1, failed: 0 }));
  assertEquals(outcome, { ok: true, value: { claimed: 1, sent: 1, failed: 0 } });
  assertEquals(degradedLanes(["chat", outcome]), []);
});

// A thrown message can carry whatever a runtime or network library put in it.
// Truncation is not redaction, so each credential shape is asserted absent from
// both the returned error and the log line. The third tuple element is the exact
// secret that must not survive, so a case cannot pass by asserting the wrong
// fragment.
const syntheticSecret = ["sb", "secret", "AbCdEf1234567890"].join("_");
const syntheticKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const SECRET_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["Authorization header", "request failed: Authorization: Bearer abc123def456ghi789", "abc123def456ghi789"],
  ["bearer token", "send failed with Bearer sk_live_51H8xQ2eZvKYlo2C", "sk_live_51H8xQ2eZvKYlo2C"],
  ["supabase secret key", `connect failed using ${syntheticSecret}`, syntheticSecret],
  [
    "jwt",
    "token rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "eyJhbGciOiJIUzI1NiJ9",
  ],
  ["api key assignment", "upstream error api_key=super-secret-value-123", "super-secret-value-123"],
  ["credential-bearing url", "fetch failed https://user:hunter2@example.com/hook", "hunter2"],
  [
    "private key",
    `invalid key ${syntheticKeyHeader}\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----`,
    "MIIEvQIBADANBg",
  ],
  ["google api key", "fcm denied AIzaSyD-1234567890abcdefghijklmnopqrstu", "AIzaSyD-1234567890abcdefghijklmnopqrstu"],
  // Compound names: `_` is a word character, so a bare `\b` name list misses
  // `client_secret` / `access_token` entirely. These are the reviewer's exact
  // counterexamples.
  ["compound client secret", "upstream error client_secret=hunter2", "hunter2"],
  ["compound access token", "denied access_token=abc123", "abc123"],
  ["compound refresh token", 'response body {"refresh_token":"shortvalue"}', "shortvalue"],
  ["hyphenated api key header", "request rejected x-api-key: shortkey1", "shortkey1"],
  ["compound private key", "config failed private_key=abc123", "abc123"],
  ["service role key", "client init failed service_role_key=xyz789", "xyz789"],
  // The reviewer's second round: an unquoted value with spaces, the `:=`
  // delimiter, and a short Bearer value that the token rule cannot see.
  ["short bearer value", "authorization=Bearer v", "Bearer v"],
  ["walrus-style assignment", "secret := v", "v"],
  ["unquoted multiword value", "client_secret=two words", "two words"],
  ["multiword value then prose", "access_token=alpha beta gamma\nnext line", "alpha beta gamma"],
  // Third round: the value must be taken to the end of its line. A delimiter or
  // length boundary leaves a tail that still reaches the log and the response.
  ["value on the next line", "secret=\nSECRET", "SECRET"],
  ["semicolon tail", "api_key=a;b", "b"],
  ["comma tail", "token=x,y", "y"],
  ["over-long value tail", `password=${"p".repeat(600)}TAIL`, "TAIL"],
  // Fourth round: `\n[^\n]*` consumed only one line, so a blank line before the
  // value left it exposed.
  ["blank line before value", "secret=\n\nSECRET", "SECRET"],
  ["blank lines and indentation before value", "secret=\n \n  SECRET", "SECRET"],
  ["crlf next-line value", "secret=\r\nSECRET", "SECRET"],
];

for (const [label, message, secret] of SECRET_CASES) {
  Deno.test(`lane failure text is secret-safe: ${label}`, async () => {
    const logged: string[] = [];
    const outcome = await isolateLane(
      "chat",
      () => Promise.reject(new Error(message)),
      (line) => logged.push(line),
    );
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.includes(secret), false, `${label} leaked into chatError`);
    }
    assertEquals(logged.length, 1);
    assertEquals(logged[0]!.includes(secret), false, `${label} leaked into the log line`);
  });
}

Deno.test("redaction leaves unrelated query parameters and prose alone", () => {
  // A non-credential assignment keeps its value, so diagnostics stay useful.
  assertStringIncludes(redactSecrets("read failed after 3 attempts"), "after 3 attempts");
  assertStringIncludes(redactSecrets("notification:1234"), "notification:1234");
  assertStringIncludes(redactSecrets("tokenize the body"), "tokenize the body");
  assertStringIncludes(redactSecrets("?page=2&sort=new"), "page=2&sort=new");
});

Deno.test("redaction keeps ordinary diagnostics readable", () => {
  const message = boundedLaneError(new Error("Chat wake disposition unavailable"));
  assertEquals(message, "Chat wake disposition unavailable");
  assertStringIncludes(redactSecrets("read failed after 3 attempts"), "read failed after 3 attempts");
});

Deno.test("non-Error throws still produce an honest message", () => {
  assertEquals(boundedLaneError(undefined), "lane failed");
  assertEquals(boundedLaneError({}), "lane failed");
  assertEquals(boundedLaneError("plain string failure"), "plain string failure");
});
