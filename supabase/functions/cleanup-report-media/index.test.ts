import { assertEquals } from "jsr:@std/assert";
import { createReportCleanupEndpoint, handleCleanupRequest, type CleanupClients } from "./index.ts";

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

Deno.test("production SDK boundary authenticates secret key and honors max_batches", async () => {
  const config = { url: "https://project.example.invalid", secretKeys: { default: "sb_secret_synthetic_fixture" },
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
