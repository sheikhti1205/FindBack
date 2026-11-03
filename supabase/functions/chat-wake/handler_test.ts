import { strict as assert } from "node:assert";
import { createChatWakeEndpoint } from "./handler.ts";

// Synthetic environment only: no deployed credentials, no FCM sender, no accounts.
const env = {
  url: "https://project.example.invalid",
  secretKeys: { default: ["sb", "secret", "placeholder"].join("_") },
  publishableKeys: { default: "sb_publishable_placeholder" },
  jwks: { keys: [] },
};

function assertCors(response: Response) {
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  const methods = (response.headers.get("access-control-allow-methods") ?? "").split(",").map((x) => x.trim());
  assert.deepEqual(methods.sort(), ["GET", "OPTIONS", "POST"]);
  const allowed = (response.headers.get("access-control-allow-headers") ?? "").split(",").map((x) => x.trim().toLowerCase());
  for (const header of ["authorization", "apikey", "content-type", "x-client-info"]) {
    assert(allowed.includes(header), `Missing CORS request header ${header}`);
  }
}

Deno.test("browser preflight is answered instead of 405", async () => {
  const endpoint = createChatWakeEndpoint(env);
  for (const origin of ["https://findbackapp.social", "https://localhost:5173"]) {
    const response = await endpoint(new Request("https://example.invalid", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    }));
    assert.equal(response.status, 204);
    assertCors(response);
    assert.equal(await response.text(), "");
    assert.ok(Number(response.headers.get("access-control-max-age")) > 0);
  }
});

Deno.test("a non-POST method still fails closed but carries CORS", async () => {
  const endpoint = createChatWakeEndpoint(env);
  const response = await endpoint(new Request("https://example.invalid", { method: "GET" }));
  assert.equal(response.status, 405);
  assertCors(response);
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});

Deno.test("preflight never touches the wake queue or FCM configuration", async () => {
  let calls = 0;
  const endpoint = createChatWakeEndpoint(env);
  const original = globalThis.fetch;
  // Any outbound call during a preflight would mean the handler did real work.
  globalThis.fetch = (() => { calls++; return Promise.reject(Error("unexpected transport")); }) as typeof fetch;
  try {
    await endpoint(new Request("https://example.invalid", { method: "OPTIONS" }));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});
