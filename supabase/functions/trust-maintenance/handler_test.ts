import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { createTrustMaintenanceEndpoint } from "./handler.ts";

// Complete fake SDK environment and transport: never local credential values.
const fixtureSecret = ["sb", "secret", "unit", "test", "placeholder"].join("_");
const env = { url: "https://project.example.invalid", secretKeys: { default: fixtureSecret },
  publishableKeys: { default: "sb_publishable_unit_test_placeholder" }, jwks: { keys: [] } };
const request = (key: string | null = env.secretKeys.default) => new Request("https://edge.example.invalid/trust-maintenance", {
  method: "POST", headers: key ? { apikey: key } : {},
});
function fixture(appeals: unknown = 2, evidence: unknown = 3) {
  const paths: string[] = []; const bodies: unknown[] = [];
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init); req.signal.throwIfAborted();
    const path = new URL(req.url).pathname;
    paths.push(path); bodies.push(await req.json());
    if (path.endsWith("/rpc/findback_expire_stale_appeals")) return Response.json(appeals);
    if (path.endsWith("/rpc/findback_expire_report_evidence")) return Response.json(evidence);
    throw new Error("Unexpected SDK operation");
  };
  return { paths, bodies, transport };
}
Deno.test("real SDK runs only canonical expiry boundaries with fixed bounds", async () => {
  const f = fixture(); const res = await createTrustMaintenanceEndpoint(env, f.transport)(request());
  equal(res.status, 200); equal(await res.json(), { status: "ok", appealsExpired: 2, evidenceErased: 3 });
  equal(f.paths, ["/rest/v1/rpc/findback_expire_stale_appeals", "/rest/v1/rpc/findback_expire_report_evidence"]);
  equal(f.bodies, [{}, { p_limit: 100 }]);
  equal(res.headers.get("cache-control"), "no-store");
});
for (const key of [null, env.publishableKeys.default, fixtureSecret.replace("unit_test", "wrong")]) {
  Deno.test(`non-secret maintenance caller refused: ${key === null ? "missing" : key.includes("publishable") ? "publishable" : "wrong"}`, async () => {
    const f = fixture(); const res = await createTrustMaintenanceEndpoint(env, f.transport)(request(key));
    equal(res.status, 401); equal(f.paths, []);
  });
}
Deno.test("method or body cannot select an appeal, clock or batch", async () => {
  const f = fixture(); const endpoint = createTrustMaintenanceEndpoint(env, f.transport);
  equal((await endpoint(new Request("https://edge.example.invalid"))).status, 405);
  equal((await endpoint(new Request("https://edge.example.invalid", { method: "POST", headers: { apikey: env.secretKeys.default }, body: '{"p_now":"2099","p_limit":99999}' }))).status, 400);
  equal(f.paths, []);
});
Deno.test("RPC failures never print row data or report success", async () => {
  const transport: typeof fetch = () => Promise.resolve(Response.json({ message: "private-diagnostic", code: "P0001" }, { status: 500 }));
  const res = await createTrustMaintenanceEndpoint(env, transport)(request());
  equal(res.status, 503); equal(await res.json(), { status: "retry" });
});
for (const value of [null, "2", -1, 101, { private: "diagnostic" }]) {
  Deno.test(`malformed expiry count fails closed: ${JSON.stringify(value)}`, async () => {
    const f = fixture(value); const res = await createTrustMaintenanceEndpoint(env, f.transport)(request());
    equal(res.status, 503); equal(await res.json(), { status: "retry" });
    equal(f.paths.length, 1);
  });
}
Deno.test("transport receives caller cancellation and no timer survives", async () => {
  const controller = new AbortController();
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init); ok(req.signal instanceof AbortSignal);
    controller.abort(); req.signal.throwIfAborted();
    return Promise.resolve(Response.json(0));
  };
  const req = new Request("https://edge.example.invalid", { method: "POST", headers: { apikey: env.secretKeys.default }, signal: controller.signal });
  const res = await createTrustMaintenanceEndpoint(env, transport)(req);
  equal(res.status, 503);
});
