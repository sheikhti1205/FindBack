import { assertEquals } from "jsr:@std/assert";
import {
  createReportCleanupEndpoint, handleCleanup, handleCleanupRequest, type CleanupClients,
} from "./index.ts";

const env = { serviceRoleKey: "synthetic-service", cronSecret: "synthetic-cron" };
function fixture() {
  let claims = 0;
  const clients: CleanupClients = {
    queue: {
      claim: async () => { claims++; return { keys: ["synthetic/object.jpg"], error: null }; },
      ack: async () => ({ acked: 1, error: null }),
    },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
  return { clients, claims: () => claims };
}
const request = (body: string, authorized = true) => new Request("https://test.invalid/cleanup", {
  method: "POST", body,
  headers: { "content-type": "application/json", ...authorized ? { "x-cleanup-secret": env.cronSecret } : {} },
});
Deno.test("HTTP max_batches limits the actual number of claimed batches", async () => {
  const f = fixture();
  const response = await handleCleanupRequest(request('{"max_batches":2}'), f.clients, env);
  assertEquals(response.status, 200);
  assertEquals(f.claims(), 2);
  assertEquals((await response.json()).batches, 2);
});
Deno.test("invalid batch controls never start a sweep", async () => {
  for (const value of [0, 11, -1, 1.5, "2", null]) {
    const f = fixture();
    const response = await handleCleanupRequest(request(JSON.stringify({ max_batches: value })), f.clients, env);
    assertEquals(response.status, 400);
    assertEquals(f.claims(), 0);
  }
});
Deno.test("unauthorized malformed request cannot reach storage or queue", async () => {
  const f = fixture();
  const response = await handleCleanupRequest(request("invalid-json", false), f.clients, env);
  assertEquals(response.status, 401);
  assertEquals(f.claims(), 0);
});

Deno.test("complete is false when a key could not be removed", async () => {
  const clients: CleanupClients = {
    queue: {
      claim: async () => ({ keys: ["synthetic/a.jpg", "synthetic/b.jpg"], error: null }),
      ack: async (keys) => ({ acked: keys.length, error: null }),
    },
    storage: { from: () => ({ remove: async (paths) => paths[0] === "synthetic/a.jpg"
      ? { error: { message: "synthetic failure" } } : { error: null } }) },
  };
  const res = await handleCleanup(clients, `Bearer ${env.serviceRoleKey}`, null, env, { maxBatches: 1 });
  assertEquals(res.status, 200);
  assertEquals(res.body.failedKeys, ["synthetic/a.jpg"]);
  assertEquals(res.body.removed, 1);
  // A sweep that left a key behind is not a completed sweep, even at status 200
  // (the cron retries it after the lease expires instead of reporting success).
  assertEquals(res.body.complete, false);
});

Deno.test("complete requires the queue to drain and every removal to be acked", async () => {
  const remaining = ["synthetic/a.jpg", "synthetic/b.jpg"];
  let acked = 0;
  const clients: CleanupClients = {
    queue: {
      claim: async () => { const key = remaining.shift(); return { keys: key ? [key] : [], error: null }; },
      ack: async (keys) => { acked += keys.length; return { acked: keys.length, error: null }; },
    },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
  const drained = await handleCleanup(clients, `Bearer ${env.serviceRoleKey}`, null, env, { maxBatches: 5 });
  assertEquals(drained.body.batches, 2);
  assertEquals(acked, 2);
  assertEquals(drained.body.complete, true);
});

Deno.test("complete is false when the batch budget ends before the queue drains", async () => {
  let claimed = 0;
  const clients: CleanupClients = {
    queue: {
      claim: async () => { claimed += 1; return { keys: [`synthetic/${claimed}.jpg`], error: null }; },
      ack: async (keys) => ({ acked: keys.length, error: null }),
    },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
  const res = await handleCleanup(clients, `Bearer ${env.serviceRoleKey}`, null, env, { maxBatches: 2 });
  assertEquals(res.status, 200);
  assertEquals(res.body.batches, 2);
  assertEquals(res.body.complete, false);
});

Deno.test("a failed staging purge is reported in the response, not only the log", async () => {
  const clients: CleanupClients = {
    queue: { claim: async () => ({ keys: [], error: null }), ack: async () => ({ acked: 0, error: null }) },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    purgeStaging: async () => ({ purged: 0, error: { message: "synthetic failure" } }),
  };
  const res = await handleCleanup(clients, `Bearer ${env.serviceRoleKey}`, null, env, { maxBatches: 1 });
  assertEquals(res.body.stagingPurgeFailed, true);
  assertEquals(res.body.complete, false);
});

Deno.test("production SDK boundary authenticates secret key and honors max_batches", async () => {
  const config = { url: "https://project.example.invalid", secretKeys: { default: ["sb", "secret", "synthetic_fixture"].join("_") },
    publishableKeys: { default: "sb_publishable_synthetic_fixture" } };
  let claims = 0;
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path.endsWith("/purge_abandoned_staging_uploads")) return Response.json(0);
    if (path.endsWith("/claim_report_media_cleanup")) { claims++; return Response.json([{ bucket_id: "findback-report-media", object_key: "synthetic/object.jpg" }]); }
    if (path.endsWith("/ack_report_media_cleanup")) return Response.json(1);
    if (req.method === "DELETE") return Response.json([{ name: "synthetic/object.jpg" }]);
    throw new Error("Unexpected operation");
  };
  const endpoint = createReportCleanupEndpoint(config, transport);
  const unauthorized = await endpoint(new Request("https://test.invalid/cleanup", { method: "POST", body: "{}" }));
  assertEquals(unauthorized.status, 401);
  assertEquals(claims, 0);
  const response = await endpoint(new Request("https://test.invalid/cleanup", { method: "POST",
    headers: { apikey: config.secretKeys.default, "content-type": "application/json" }, body: '{"max_batches":2}' }));
  assertEquals(response.status, 200);
  assertEquals(claims, 2);
  assertEquals((await response.json()).batches, 2);
});
