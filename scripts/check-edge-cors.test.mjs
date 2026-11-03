// Canonical Edge CORS contract: the shared module is the only allow-list owner,
// and every chat function answers a browser preflight from it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cors = await import(resolve(ROOT, "supabase/functions/_shared/cors.js"));
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

// Exactly what the browser sees for a chat-media upload POST.
const CLIENT_HEADERS = [
  "authorization",
  "apikey",
  "content-type",
  "x-attachment-id",
  "x-message-id",
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".js")) out.push(full);
  }
  return out;
}

test("preflight answers OPTIONS with a cached, explicit contract", async () => {
  const response = cors.preflight(new Request("https://example.test/functions/v1/chat-media", {
    method: "OPTIONS",
    headers: {
      origin: "https://findbackapp.social",
      "access-control-request-method": "POST",
      "access-control-request-headers": CLIENT_HEADERS.join(","),
    },
  }));
  assert.ok(response, "OPTIONS must produce a preflight response");
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const allowed = (response.headers.get("access-control-allow-headers") ?? "")
    .split(",").map((value) => value.trim().toLowerCase());
  for (const header of CLIENT_HEADERS) assert.ok(allowed.includes(header), `missing allow-header ${header}`);
  const methods = (response.headers.get("access-control-allow-methods") ?? "").toUpperCase();
  for (const method of ["GET", "POST", "OPTIONS"]) assert.ok(methods.includes(method), `missing method ${method}`);
  assert.ok(Number(response.headers.get("access-control-max-age")) > 0, "preflight must be cacheable to cut chat latency");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("preflight leaves ordinary requests alone", () => {
  for (const method of ["GET", "POST"]) {
    const response = cors.preflight(new Request("https://example.test/functions/v1/chat-wake", { method }));
    assert.equal(response, null);
  }
});

test("json responses carry the same CORS contract", async () => {
  const response = cors.corsJson({ error: "Method not allowed" }, 405);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-methods"), cors.CHAT_CORS.allowMethods);
  assert.equal(response.headers.get("access-control-allow-headers"), cors.CHAT_CORS.allowHeaders);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});

test("chat-wake answers browser preflight instead of 405", () => {
  const source = read("supabase/functions/chat-wake/handler.ts");
  assert.match(source, /preflight\(/, "chat-wake must use the shared preflight");
  assert.match(source, /_shared\/cors\.js/, "chat-wake must import the canonical CORS module");
  const optionsAt = source.indexOf("preflight(");
  const postGuardAt = source.indexOf('request.method !== "POST"');
  assert.ok(optionsAt !== -1 && optionsAt < postGuardAt, "OPTIONS must be answered before the POST-only guard");
});

test("chat and media functions share one allow-list", () => {
  for (const path of ["supabase/functions/chat-media/handler.ts", "supabase/functions/chat-wake/handler.ts"]) {
    const source = read(path);
    assert.match(source, /_shared\/cors\.js/, `${path} must import the shared CORS module`);
    assert.doesNotMatch(source, /Access-Control-Allow-(Headers|Methods|Origin)/, `${path} must not hand-maintain CORS`);
  }
  const offenders = walk(resolve(ROOT, "supabase/functions"))
    .filter((file) => !file.endsWith("/_shared/cors.js"))
    .filter((file) => /Access-Control-Allow-Headers/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "only _shared/cors.js may declare the allowed headers");
});
