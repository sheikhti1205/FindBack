import { assert, assertEquals } from "jsr:@std/assert";
import { createCommentCleanupEndpoint } from "./index.ts";

const config = {
  url: "https://project.example.invalid",
  secretKeys: { default: ["sb", "secret", "synthetic_fixture"].join("_") },
  publishableKeys: { default: "sb_publishable_synthetic_fixture" },
};
function fixture(pending = true, failPurge = false) {
  const calls: { path: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    calls.push({ path, body: await req.json() });
    if (path.endsWith("/purge_abandoned_comment_media")) return failPurge ? Response.json({ message: "purge unavailable" }, { status: 503 }) : Response.json(3);
    if (path.endsWith("/claim_comment_media_cleanup")) return Response.json([{ storage_key: "synthetic/object.jpg" }]);
    if (path.endsWith("/ack_comment_media_cleanup")) return Response.json([{ storage_key: "synthetic/object.jpg" }]);
    if (path.endsWith("/findback_comment_media_cleanup_pending")) return Response.json(pending);
    if (req.method === "DELETE") return Response.json([{ name: "synthetic/object.jpg" }]);
    throw new Error("Unexpected maintenance request");
  };
  return { endpoint: createCommentCleanupEndpoint(config, transport), calls };
}
function request(body = "{}", headers: Record<string, string> = { apikey: config.secretKeys.default }) {
  return new Request("https://test.invalid/cleanup", { method: "POST", body, headers });
}
Deno.test("production auth rejects absent, ordinary, legacy-bearer and cron credentials before any operation", async () => {
  const { endpoint, calls } = fixture();
  const rejected: Record<string, string>[] = [{}, { apikey: config.publishableKeys.default },
    { Authorization: "Bearer synthetic-service-role" }, { "x-cleanup-secret": "synthetic-cron" }];
  for (const headers of rejected) {
    const response = await endpoint(request("not-json", headers));
    assertEquals(response.status, 401);
  }
  assertEquals(calls.length, 0);
});
Deno.test("production max_batches bounds real claims, runs TTL first and checks pending work", async () => {
  const { endpoint, calls } = fixture();
  const response = await endpoint(request('{"max_batches":2}'));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.batches, 2);
  assertEquals(body.complete, false);
  assertEquals(body.purgedStaging, 3);
  assert(calls[0].path.endsWith("/purge_abandoned_comment_media"));
  assertEquals(calls[0].body, { p_limit: 200 });
  assertEquals(calls.filter(c => c.path.endsWith("/claim_comment_media_cleanup")).length, 2);
  assert(calls.at(-1)!.path.endsWith("/findback_comment_media_cleanup_pending"));
});
Deno.test("invalid HTTP controls never purge or claim", async () => {
  const { endpoint, calls } = fixture();
  for (const body of ['{"max_batches":0}', '{"max_batches":11}', '{"max_batches":1.5}', '{"max_batches":"2"}', '{"max_batches":null}', "[]", "null", "not-json"]) {
    assertEquals((await endpoint(request(body))).status, 400);
  }
  assertEquals(calls.length, 0);
});
Deno.test("production TTL failure is red before Storage deletion", async () => {
  const { endpoint, calls } = fixture(true, true);
  assertEquals((await endpoint(request())).status, 502);
  assert(calls.every(c => c.path.endsWith("/purge_abandoned_comment_media")));
});
