import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { createChatMediaCleanupEndpoint } from "./handler.ts";

// Fabricated fixture values, never local credentials; all network is replaced.
const env = { url: "https://project.example.invalid", secretKeys: { default: "sb_secret_unit_test_placeholder" },
  publishableKeys: { default: "sb_publishable_unit_test_placeholder" }, jwks: { keys: [] } };
const uuid = (n: number) => `00000000-0000-4000-9855-${String(n).padStart(12, "0")}`;
const row = (n = 1) => ({
  bucket_id: "findback-chat-media", media_id: uuid(n), generation: uuid(n + 10), object_key: `attachments/${uuid(n + 20)}`,
});
const evidenceRow = () => ({
  bucket_id: "findback-chat-moderation-evidence", media_id: uuid(40), generation: uuid(41), object_key: `evidence/${uuid(42)}`,
});

function fixture(batches: unknown[][] = [[row()]]) {
  const paths: string[] = []; const confirmed: unknown[] = []; const rechecked: unknown[] = []; const claims: unknown[] = [];
  const present = new Set<string>();
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init); const path = new URL(req.url).pathname;
    paths.push(`${req.method} ${path}`); ok(req.signal instanceof AbortSignal); req.signal.throwIfAborted();
    if (path.endsWith("/rpc/findback_chat_media_cleanup_candidates")) {
      claims.push(await req.json() as { p_limit: number; p_after_bucket: string | null; p_after_key: string | null });
      const batch = batches.shift() ?? [];
      return Response.json(batch);
    }
    if (path.endsWith("/rpc/findback_chat_media_cleanup_done")) {
      confirmed.push(await req.json()); return Response.json(true);
    }
    if (path.endsWith("/rpc/findback_chat_media_cleanup_recheck")) {
      rechecked.push(await req.json()); return Response.json(true);
    }
    if (req.method === "DELETE") {
      const body = await req.json() as { prefixes: string[] };
      for (const key of body.prefixes) present.delete(key);
      return Response.json(body.prefixes.map((name) => ({ name })));
    }
    if (req.method === "HEAD") {
      const key = path.replace(/^\/storage\/v1\/object\/[^/]+\//, "");
      if (present.has(key)) return new Response(null, { status: 200 });
      return Response.json({ code: "NoSuchKey", message: "Object not found" }, { status: 404 });
    }
    throw new Error(`Unexpected SDK operation ${req.method} ${path}`);
  };
  return { transport, paths, confirmed, rechecked, claims, present };
}
const request = () => new Request("https://edge.example.invalid/cleanup-chat-media", {
  method: "POST", headers: { apikey: env.secretKeys.default },
});

Deno.test("real SDK removes one object, verifies absence and acknowledges it", async () => {
  const f = fixture(); const endpoint = createChatMediaCleanupEndpoint(env, f.transport);
  const res = await endpoint(request());
  equal(res.status, 200);
  equal(await res.json(), {
    status: "ok", claimed: 1, removed: 1, confirmed: 1, deferred: 0, requeued: 0, batches: 1, more: false,
  });
  equal(f.confirmed, [{ p_bucket_id: "findback-chat-media", p_media_id: uuid(1),
    p_generation: uuid(11), p_object_key: `attachments/${uuid(21)}` }]);
  equal(f.paths, [
    "POST /rest/v1/rpc/findback_chat_media_cleanup_candidates",
    "DELETE /storage/v1/object/findback-chat-media",
    `HEAD /storage/v1/object/findback-chat-media/attachments/${uuid(21)}`,
    "POST /rest/v1/rpc/findback_chat_media_cleanup_done",
    `HEAD /storage/v1/object/findback-chat-media/attachments/${uuid(21)}`,
    "POST /rest/v1/rpc/findback_chat_media_cleanup_candidates",
  ]);
  ok(!f.paths.some((p) => /list|signed|chat_media_cleanup_queue|reserve|commit/.test(p)));
  // The first claim carries no cursor; the follow-up claim continues after the
  // last key already handled, so an undeletable row cannot be re-claimed.
  equal(f.claims, [
    { p_limit: 25, p_after_bucket: null, p_after_key: null },
    { p_limit: 25, p_after_bucket: "findback-chat-media", p_after_key: `attachments/${uuid(21)}` },
  ]);
});

Deno.test("a write that lands after acknowledgement re-arms the tombstone", async () => {
  const f = fixture();
  let acknowledged = false;
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init); const path = new URL(req.url).pathname;
    if (path.endsWith("/rpc/findback_chat_media_cleanup_done")) {
      acknowledged = true; return await f.transport(input, init);
    }
    if (req.method === "HEAD") {
      // Absent while the sweep verifies, present again immediately afterwards.
      return acknowledged
        ? new Response(null, { status: 200 })
        : Response.json({ code: "NoSuchKey", message: "Object not found" }, { status: 404 });
    }
    return await f.transport(input, init);
  };
  const res = await createChatMediaCleanupEndpoint(env, transport)(request());
  equal(res.status, 200);
  equal(await res.json(), {
    status: "ok", claimed: 1, removed: 1, confirmed: 1, deferred: 0, requeued: 1, batches: 1, more: false,
  });
  equal(f.rechecked.length, 1);
});

Deno.test("bytes that remain after a second removal are never acknowledged", async () => {
  const f = fixture();
  // A delete call that reports success while the object is still there is the
  // exact condition the second removal and the missing acknowledgement guard.
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (req.method === "DELETE") return Promise.resolve(Response.json([{ name: uuid(21) }]));
    if (req.method === "HEAD") return Promise.resolve(new Response(null, { status: 200 }));
    return f.transport(input, init);
  };
  const res = await createChatMediaCleanupEndpoint(env, transport)(request());
  equal(res.status, 200);
  const body = await res.json() as { status: string; confirmed: number; deferred: number };
  equal(body.status, "partial"); equal(body.confirmed, 0); equal(body.deferred, 1);
  equal(f.confirmed, []);
});

for (const apikey of [null, env.publishableKeys.default, "sb_secret_wrong_placeholder"]) {
  Deno.test(`sweep rejects non-secret auth without touching Storage: ${apikey === null ? "missing" : apikey.includes("publishable") ? "publishable" : "wrong"}`, async () => {
    const f = fixture(); const headers: Record<string, string> = apikey ? { apikey } : {};
    const res = await createChatMediaCleanupEndpoint(env, f.transport)(new Request("https://edge.example.invalid", { method: "POST", headers }));
    equal(res.status, 401); equal(f.paths, []); equal(f.confirmed, []);
  });
}

Deno.test("method and body cannot turn the sweep into a caller-selected deletion", async () => {
  const f = fixture(); const endpoint = createChatMediaCleanupEndpoint(env, f.transport);
  equal((await endpoint(new Request("https://edge.example.invalid"))).status, 405);
  equal((await endpoint(new Request("https://edge.example.invalid", { method: "POST",
    headers: { apikey: env.secretKeys.default }, body: '{"bucket":"findback-chat-media"}' }))).status, 400);
  equal(f.paths, []);
});

for (const failure of [403, 400, 500]) {
  Deno.test(`ambiguous existence response ${failure} defers instead of acknowledging`, async () => {
    const f = fixture();
    const transport: typeof fetch = (input, init) => {
      const req = new Request(input, init);
      if (req.method === "HEAD") return Promise.resolve(Response.json({ message: "private-storage-diagnostic" }, { status: failure }));
      return f.transport(input, init);
    };
    const res = await createChatMediaCleanupEndpoint(env, transport)(request());
    equal(res.status, 200);
    const body = await res.json() as { status: string; deferred: number };
    equal(body.status, "partial"); equal(body.deferred, 1);
    equal(f.confirmed, []); ok(!JSON.stringify(body).includes("private-storage-diagnostic"));
  });
}

Deno.test("a removal failure is not acknowledged and reports retry-free partial progress", async () => {
  const f = fixture();
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (req.method === "DELETE") return Promise.resolve(Response.json({ message: "storage unavailable" }, { status: 503 }));
    return f.transport(input, init);
  };
  const res = await createChatMediaCleanupEndpoint(env, transport)(request());
  equal(res.status, 200);
  const body = await res.json() as { status: string; deferred: number };
  equal(body.status, "partial"); equal(body.deferred, 1); equal(f.confirmed, []);
});

Deno.test("request cancellation aborts the actual SDK delete and never acknowledges", async () => {
  const f = fixture(); const c = new AbortController(); let deleteAborted = false;
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (req.method === "DELETE") {
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener("abort", () => { deleteAborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
        c.abort();
      });
    }
    return f.transport(input, init);
  };
  const res = await createChatMediaCleanupEndpoint(env, transport)(new Request(request(), { signal: c.signal }));
  equal(res.status, 503); equal(await res.json(), { status: "retry", claimed: 1, removed: 0, confirmed: 0,
    deferred: 0, requeued: 0, batches: 1, more: false });
  ok(deleteAborted); equal(f.confirmed, []);
});

Deno.test("overlapping sweep is rejected before claim and capacity reopens afterwards", async () => {
  const f = fixture([[row()], []]); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const hold = new Promise<void>((r) => { release = r; }); let claims = 0;
  const transport: typeof fetch = async (input, init) => {
    if (new URL(new Request(input, init).url).pathname.endsWith("/rpc/findback_chat_media_cleanup_candidates")) {
      claims += 1; if (claims === 1) { entered(); await hold; }
    }
    return await f.transport(input, init);
  };
  const endpoint = createChatMediaCleanupEndpoint(env, transport);
  const first = endpoint(request()); await started;
  let second: Response;
  try { second = await endpoint(request()); } finally { release(); }
  equal(second.status, 503); equal(await second.json(), { status: "retry" });
  equal((await first).status, 200);
  equal((await endpoint(request())).status, 200);
});

Deno.test("evidence candidates are swept from the evidence bucket only", async () => {
  const f = fixture([[evidenceRow()]]);
  const res = await createChatMediaCleanupEndpoint(env, f.transport)(request());
  equal(res.status, 200);
  ok(f.paths.includes("DELETE /storage/v1/object/findback-chat-moderation-evidence"));
  equal(f.confirmed, [{ p_bucket_id: "findback-chat-moderation-evidence", p_media_id: uuid(40),
    p_generation: uuid(41), p_object_key: `evidence/${uuid(42)}` }]);
});

Deno.test("response never exposes object keys, generations or raw storage errors", async () => {
  const f = fixture();
  const res = await createChatMediaCleanupEndpoint(env, f.transport)(request());
  const text = JSON.stringify(await res.json());
  ok(!text.includes(uuid(21)) && !text.includes(uuid(11)) && !text.includes("attachments/"));
});

Deno.test("hosted HEAD 400 is confirmed absent only by structured object-info 404", async () => {
  const f = fixture();
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (req.method === "HEAD") return Promise.resolve(new Response(null, { status: 400 }));
    if (new URL(req.url).pathname.includes("/object/info/")) return Promise.resolve(Response.json({
      statusCode: "404", error: "not_found", code: "NoSuchKey", message: "Object not found",
    }, { status: 400 }));
    return f.transport(input, init);
  };
  const response = await createChatMediaCleanupEndpoint(env, transport)(request());
  equal(response.status, 200);
  const result = await response.json();
  equal(result.confirmed, 1);
  equal(result.deferred, 0);
  equal(f.confirmed.length, 1);
});

for (const status of [400, 401, 403, 500]) {
  Deno.test(`HEAD 400 with ambiguous object-info ${status} never acknowledges`, async () => {
    const f = fixture();
    const transport: typeof fetch = (input, init) => {
      const req = new Request(input, init);
      if (req.method === "HEAD") return Promise.resolve(new Response(null, { status: 400 }));
      if (new URL(req.url).pathname.includes("/object/info/")) return Promise.resolve(
        Response.json({ message: "unavailable", statusCode: String(status) }, { status }));
      return f.transport(input, init);
    };
    const response = await createChatMediaCleanupEndpoint(env, transport)(request());
    const result = await response.json();
    equal(result.confirmed, 0);
    equal(result.deferred, 1);
    equal(f.confirmed.length, 0);
  });
}

Deno.test("object-info auth failure cannot masquerade as absence", async () => {
  const f = fixture();
  const transport: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    if (req.method === "HEAD") return Promise.resolve(new Response(null, { status: 400 }));
    if (new URL(req.url).pathname.includes("/object/info/")) return Promise.resolve(
      Response.json({ statusCode: "404", message: "denied" }, { status: 403 }));
    return f.transport(input, init);
  };
  const response = await createChatMediaCleanupEndpoint(env, transport)(request());
  equal((await response.json()).confirmed, 0);
  equal(f.confirmed.length, 0);
});
