// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSupabaseFunctionFetch } from "./supabaseClient";

// Explicitly synthetic auth fixtures. Never deployed keys, JWTs or accounts.
const config = { url: "https://project.example.test/base/", key: "sb_publishable_synthetic" };
const session = (id = "account-a") => ({ data: { session: { user: { id }, access_token: "synthetic-token-a" } }, error: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("canonical authenticated raw function fetch", () => {
  it("uses explicit captured auth, no cookies/redirects/cache and returns unread binary", async () => {
    let request: Request | undefined, options: RequestInit | undefined;
    const fetcher = createSupabaseFunctionFetch(config, { getSession: async () => session() }, async (input, init) => {
      options = init; request = new Request(input, init);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    });
    const response = await fetcher("chat-media", "account-a", { method: "GET", signal: new AbortController().signal,
      headers: { authorization: "ignored", apikey: "ignored", "x-attachment-id": "synthetic-id" } });
    expect(request!.url).toBe("https://project.example.test/base/functions/v1/chat-media");
    expect(request!.headers.get("authorization")).toBe("Bearer synthetic-token-a");
    expect(request!.headers.get("apikey")).toBe("sb_publishable_synthetic");
    expect(options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    expect(response.bodyUsed).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("captures body and headers before getSession awaits", async () => {
    const auth = deferred<ReturnType<typeof session>>(); let request: Request | undefined;
    const fetcher = createSupabaseFunctionFetch(config, { getSession: () => auth.promise }, async (input, init) => {
      request = new Request(input, init); return new Response();
    });
    const bytes = new Uint8Array([1, 2, 3]).buffer, headers = { "x-attachment-id": "original" };
    const pending = fetcher("chat-media", "account-a", { method: "POST", body: bytes, headers, signal: new AbortController().signal });
    headers["x-attachment-id"] = "mutated"; new Uint8Array(bytes).fill(9); auth.resolve(session()); await pending;
    expect(request!.headers.get("x-attachment-id")).toBe("original");
    expect(new Uint8Array(await request!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each(["missing", "other-account", "auth-error", "no-token"])("refuses %s before network", async (kind) => {
    let calls = 0;
    const result = kind === "missing" ? { data: { session: null }, error: null }
      : kind === "other-account" ? session("account-b")
      : kind === "auth-error" ? { ...session(), error: new Error("private") }
      : { data: { session: { user: { id: "account-a" }, access_token: "" } }, error: null };
    const fetcher = createSupabaseFunctionFetch(config, { getSession: async () => result }, async () => { calls++; return new Response(); });
    await expect(fetcher("chat-media", "account-a", { method: "GET", signal: new AbortController().signal })).rejects.toThrow("Request unavailable");
    expect(calls).toBe(0);
  });

  it("refuses owner closure while waiting for auth and never starts network later", async () => {
    const auth = deferred<ReturnType<typeof session>>(), owner = new AbortController(); let calls = 0;
    const fetcher = createSupabaseFunctionFetch(config, { getSession: () => auth.promise }, async () => { calls++; return new Response(); });
    const rejected = expect(fetcher("chat-media", "account-a", { method: "GET", signal: owner.signal })).rejects.toThrow();
    owner.abort(); auth.resolve(session()); await rejected; expect(calls).toBe(0);
  });

  it("cancels a late raw response after account-owner closure", async () => {
    const response = deferred<Response>(), entered = deferred<void>(), owner = new AbortController(); let cancelled = false;
    const fetcher = createSupabaseFunctionFetch(config, { getSession: async () => session() }, () => { entered.resolve(); return response.promise; });
    const rejected = expect(fetcher("chat-media", "account-a", { method: "GET", signal: owner.signal })).rejects.toThrow();
    await entered.promise; owner.abort();
    response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await rejected; expect(cancelled).toBe(true);
  });

  it.each(["https://user:pass@example.test", "https://example.test?x=y", "https://example.test/#x", "javascript:alert(1)"])("refuses unsafe configured URL %s", (url) => {
    expect(() => createSupabaseFunctionFetch({ ...config, url }, { getSession: async () => session() }, async () => new Response())).toThrow();
  });

  it.each(["../other", "https://other.test/", "chat-media?x=y", ""])("refuses arbitrary endpoint %s", async (name) => {
    let calls = 0;
    const fetcher = createSupabaseFunctionFetch(config, { getSession: async () => session() }, async () => { calls++; return new Response(); });
    await expect(fetcher(name, "account-a", { method: "GET", signal: new AbortController().signal })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
