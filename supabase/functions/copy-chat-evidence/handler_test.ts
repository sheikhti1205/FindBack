import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { createEvidenceCopyEndpoint } from "./handler.ts";

// Fabricated fixture values, never local credentials; all network is replaced.
const env = { url: "https://project.example.invalid", secretKeys: { default: "sb_secret_unit_test_placeholder" },
  publishableKeys: { default: "sb_publishable_unit_test_placeholder" }, jwks: { keys: [] } };
const uuid = (n: number) => `00000000-0000-4000-9854-${String(n).padStart(12, "0")}`;
const bytes = new TextEncoder().encode("trusted normalized source");
const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
const work = () => ({ id: uuid(1), reportId: uuid(2), sourceAttachmentId: uuid(3), generation: uuid(4), workToken: uuid(5),
  workExpiresAt: new Date(Date.now() + 300_000).toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(),
  sourceBucket: "findback-chat-media", sourceObjectKey: `attachments/${uuid(6)}`,
  bucket: "findback-chat-moderation-evidence", objectKey: `evidence/${uuid(7)}`,
  sha256: sha, mime: "image/png", bytes: bytes.length, width: 1920, height: 1080 });

function fixture() {
  const paths: string[] = []; const finished: unknown[] = []; const destination: Uint8Array[] = [];
  let copy = false;
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init); const path = new URL(req.url).pathname; paths.push(`${req.method} ${path}`);
    ok(req.signal instanceof AbortSignal);
    req.signal.throwIfAborted();
    if (path.endsWith("/rpc/findback_claim_chat_media_evidence_job")) return Response.json(work());
    if (path.endsWith("/rpc/findback_finish_chat_media_evidence_job")) {
      finished.push(await req.json()); return new Response(null, { status: 204 });
    }
    if (path === `/storage/v1/object/findback-chat-media/attachments/${uuid(6)}`) return new Response(bytes);
    if (path === `/storage/v1/object/findback-chat-moderation-evidence/evidence/${uuid(7)}`) {
      if (req.method === "POST") {
        equal(req.headers.get("x-upsert"), "false"); equal(req.headers.get("content-type"), "image/png");
        equal(req.headers.get("cache-control"), "max-age=0");
        destination.push(new Uint8Array(await req.arrayBuffer())); copy = true;
        return Response.json({ Key: "opaque" });
      }
      return copy ? new Response(destination[0]!.slice()) : Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 404 });
    }
    throw new Error(`Unexpected SDK operation ${req.method} ${path}`);
  };
  return { transport, paths, finished, destination };
}
const request = () => new Request("https://edge.example.invalid/copy-chat-evidence", {
  method: "POST", headers: { apikey: env.secretKeys.default },
});

Deno.test("real SDK routes immutable upload and lease-aware finish only", async () => {
  const f = fixture(); const endpoint = createEvidenceCopyEndpoint(env, f.transport);
  const res = await endpoint(request()); equal(res.status, 200); equal(await res.json(), { status: "attached" });
  equal(f.destination, [bytes]);
  equal(f.finished, [{ p_evidence_id: uuid(1), p_generation: uuid(4), p_work_token: uuid(5),
    p_object_key: `evidence/${uuid(7)}`, p_sha: sha, p_mime: "image/png", p_bytes: bytes.length, p_width: 1920, p_height: 1080 }]);
  ok(!f.paths.some(p => /commit_chat_media|reserve_chat_media|signed|remove/.test(p)));
  equal(f.paths.length, 6);
});

for (const apikey of [null, env.publishableKeys.default, "sb_secret_wrong_placeholder"]) {
  Deno.test(`worker rejects non-secret auth without accessing work: ${apikey === null ? "missing" : apikey.includes("publishable") ? "publishable" : "wrong"}`, async () => {
    const f = fixture(); const headers: Record<string, string> = apikey ? { apikey } : {};
    const res = await createEvidenceCopyEndpoint(env, f.transport)(new Request("https://edge.example.invalid", { method: "POST", headers }));
    equal(res.status, 401); equal(f.paths, []);
  });
}

Deno.test("method and body cannot turn cron into a caller-selected Storage operation", async () => {
  const f = fixture(); const endpoint = createEvidenceCopyEndpoint(env, f.transport);
  equal((await endpoint(new Request("https://edge.example.invalid"))).status, 405);
  equal((await endpoint(new Request("https://edge.example.invalid", { method: "POST", headers: { apikey: env.secretKeys.default }, body: '{"source":"anything"}' }))).status, 400);
  equal(f.paths, []);
});

Deno.test("Storage auth failure is not treated as missing object or exposed as raw error", async () => {
  const f = fixture(); const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname.includes("/storage/")) return Promise.resolve(Response.json({ message: "private-storage-diagnostic" }, { status: 403 }));
    return f.transport(input, init);
  };
  const res = await createEvidenceCopyEndpoint(env, transport)(request());
  equal(res.status, 503); equal(await res.json(), { status: "retry" }); equal(f.finished, []); equal(f.destination, []);
});

Deno.test("request cancellation aborts actual SDK upload and never calls finish", async () => {
  const f = fixture(); const c = new AbortController(); let uploadAborted = false;
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (req.method === "POST" && new URL(req.url).pathname.includes("/storage/")) {
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener("abort", () => { uploadAborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
        c.abort();
      });
    }
    return f.transport(input, init);
  };
  const req = new Request(request(), { signal: c.signal });
  const res = await createEvidenceCopyEndpoint(env, transport)(req);
  equal(res.status, 503); equal(await res.json(), { status: "retry" }); ok(uploadAborted); equal(f.finished, []);
});

Deno.test("modern NoSuchKey response permits immutable copy via actual SDK error decoding", async () => {
  const f = fixture(); let missing = true;
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (missing && req.method === "GET" && new URL(req.url).pathname.includes("/findback-chat-moderation-evidence/")) {
      missing = false;
      return Promise.resolve(Response.json({ code: "NoSuchKey", message: "Object not found" }, { status: 404 }));
    }
    return f.transport(input, init);
  };
  const res = await createEvidenceCopyEndpoint(env, transport)(request());
  equal(res.status, 200); equal(await res.json(), { status: "attached" }); equal(f.destination, [bytes]);
});

for (const missing of [new Response("<h1>Proxy route not found</h1>", { status: 404 }),
  Response.json({ code: "NoSuchBucket", message: "Bucket not found" }, { status: 404 }),
  Response.json({ message: "private auth failure", statusCode: "404" }, { status: 403 })]) {
  Deno.test(`non-object-missing response never initiates copy: ${missing.status} ${missing.headers.get("content-type")}`, async () => {
    const f = fixture(); let storageReads = 0;
    const transport: typeof fetch = (input, init) => {
      if (new URL(new Request(input, init).url).pathname.includes("/storage/")) {
        storageReads++; return Promise.resolve(missing.clone());
      }
      return f.transport(input, init);
    };
    const res = await createEvidenceCopyEndpoint(env, transport)(request());
    equal(res.status, 503); equal(f.destination, []); equal(f.finished, []);
    equal(storageReads, 1); // Fail closed at destination; do not even read source.
    equal(f.paths.length, 1); // Only claim, no source download/upload/finish.
  });
}

Deno.test("overlapping invocation is rejected before claim and capacity reopens after success", async () => {
  const f = fixture(); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const hold = new Promise<void>(r => { release = r; }); let claimCount = 0;
  const transport: typeof fetch = async (input, init) => {
    if (new URL(new Request(input, init).url).pathname.endsWith("/rpc/findback_claim_chat_media_evidence_job")) {
      claimCount++; if (claimCount === 1) { entered(); await hold; }
    }
    return await f.transport(input, init);
  };
  const endpoint = createEvidenceCopyEndpoint(env, transport);
  const first = endpoint(request()); await started;
  let second: Response;
  try { second = await endpoint(request()); } finally { release(); }
  const firstResult = await first;
  equal(second.status, 503); equal(await second.json(), { status: "retry" });
  equal(firstResult.status, 200); equal(claimCount, 1);
  equal((await endpoint(request())).status, 200); equal(claimCount, 2);
});
