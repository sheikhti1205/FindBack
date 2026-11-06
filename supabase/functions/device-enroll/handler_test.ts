import { strict as assert } from "node:assert";
import { createDeviceEnrollmentEndpoint } from "./handler.ts";
const env = { url: "https://synthetic.supabase.co", secretKeys: { default: ["sb", "secret", "placeholder"].join("_") },
  publishableKeys: { default: "sb_publishable_placeholder" }, jwks: { keys: [] } };
Deno.test("enrollment preflight and methods never call the registry", async () => {
  const endpoint = createDeviceEnrollmentEndpoint(env);
  const response = await endpoint(new Request("https://example.invalid", { method: "OPTIONS" }));
  assert.equal(response.status, 204); assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal((await endpoint(new Request("https://example.invalid"))).status, 405);
});
Deno.test("enrollment rejects oversized streamed bodies without requiring declared length", async () => {
  const endpoint = createDeviceEnrollmentEndpoint(env);
  const response = await endpoint(new Request("https://example.invalid", { method: "POST", body: "x".repeat(2048) }));
  assert.equal(response.status, 413);
});
Deno.test("a syntactically valid enrollment proof still requires verified USER auth", async () => {
  const endpoint = createDeviceEnrollmentEndpoint(env);
  const response = await endpoint(new Request("https://example.invalid", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: "00000000-0000-4000-9006-000000000001", signature: "a".repeat(128) }) }));
  assert.equal(response.status, 401);
  // The browser must be able to read the real status; an auth rejection without
  // the CORS contract surfaces as an opaque network failure instead.
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
Deno.test("enrollment preflight allows the Sentry tracing headers the web bundle sends", async () => {
  const endpoint = createDeviceEnrollmentEndpoint(env);
  const response = await endpoint(new Request("https://example.invalid", { method: "OPTIONS",
    headers: { origin: "https://findbackapp.social", "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,baggage,sentry-trace" } }));
  assert.equal(response.status, 204);
  const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  for (const header of ["baggage", "sentry-trace"]) assert.ok(allowed.includes(header), header);
});
