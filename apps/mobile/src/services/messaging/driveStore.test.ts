// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DriveRestStore, DriveStoreError, driveStore } from "./driveStore";

const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
const TOKEN = "ya29.a0AfH6SMBexampleTokenValue";

function responder(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const tokens = (value = TOKEN) => {
  const calls: boolean[] = [];
  return { calls, source: { token: async (force: boolean) => { calls.push(force); return value; } } };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const bodyText = (body: BodyInit | null | undefined): string =>
  new TextDecoder().decode(body as unknown as Uint8Array);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("transport cancellation fences", () => {
  it("never dispatches a write when cancellation arrives during token renewal", async () => {
    const access = deferred<string>(), controller = new AbortController();
    const network = responder(() => json({ id: FILE, name: "backup", size: 1 }));
    const store = new DriveRestStore({ token: () => access.promise }, { fetch: network.fetch,
      ...{ signal: controller.signal } });
    const pending = store.write({ name: "backup", bytes: new Uint8Array([1]).buffer }).catch(() => null);
    controller.abort(); access.resolve(TOKEN); await pending;
    expect(network.calls).toHaveLength(0);
  });

  it("passes cancellation to a dispatched fetch and does not retry its 401", async () => {
    const response = deferred<Response>(), entered = deferred<void>(), controller = new AbortController();
    const network = responder(() => { entered.resolve(); return response.promise; });
    const store = new DriveRestStore(tokens().source, { fetch: network.fetch,
      ...{ signal: controller.signal } });
    const pending = store.list().catch(() => null); await entered.promise;
    controller.abort(); response.resolve(new Response(null, { status: 401 })); await pending;
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]!.init.signal?.aborted).toBe(true);
  });
});

describe("the Drive store", () => {
  it("lists the app folder with the narrow query and bounded fields", async () => {
    const { fetch, calls } = responder((url) => json(url.includes("pageToken")
      ? { files: [{ id: FILE, name: "norfold.manifest.v1.bin", size: "42" }] }
      : { nextPageToken: "next", files: [{ id: FILE, name: "norfold.chunk.v1.bin", size: 128 }] }));
    const store = new DriveRestStore(tokens().source, { fetch });
    const files = await store.list();
    expect(files).toEqual([
      { id: FILE, name: "norfold.chunk.v1.bin", size: 128 },
      { id: FILE, name: "norfold.manifest.v1.bin", size: 42 },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("spaces=appDataFolder");
    expect(calls[0]!.url).toContain("q=trashed%3Dfalse");
    expect(calls[0]!.url).toContain("pageSize=1000");
    expect(calls[1]!.url).toContain("pageToken=next");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a folder listing it cannot trust", async () => {
    const cases: Array<() => Response> = [
      () => json({ files: [{ id: "bad id", name: "n", size: 1 }] }),
      () => json({ files: [{ id: FILE, name: "", size: 1 }] }),
      () => json({ files: [{ id: FILE, name: "n", size: -1 }] }),
      () => json({ files: [{ id: FILE, name: "n", size: 1.5 }] }),
      () => json({ files: {} }),
      () => json({}),
    ];
    for (const response of cases) {
      const store = new DriveRestStore(tokens().source, { fetch: responder(() => response()).fetch });
      await expect(store.list()).rejects.toMatchObject({ kind: "invalid" });
    }
    const tooMany = new DriveRestStore(tokens().source, { maxFiles: 1,
      fetch: responder(() => json({ files: [
        { id: FILE, name: "a", size: 1 }, { id: FILE, name: "b", size: 1 },
      ] })).fetch });
    await expect(tooMany.list()).rejects.toMatchObject({ kind: "invalid" });
  });

  it("reads object bytes and refuses an oversized response", async () => {
    const { fetch } = responder(() => new Response(new Uint8Array([1, 2, 3])));
    const store = new DriveRestStore(tokens().source, { fetch });
    expect(new Uint8Array(await store.read(FILE))).toEqual(new Uint8Array([1, 2, 3]));

    const huge = new DriveRestStore(tokens().source, {
      fetch: responder(() => new Response(new Uint8Array([1]), {
        headers: { "content-length": String(5 * 1024 * 1024) },
      })).fetch,
    });
    await expect(huge.read(FILE)).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.read("../etc/passwd")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("creates in the app folder with metadata and media, and updates without it", async () => {
    const created: Array<{ url: string; init: RequestInit }> = [];
    const create = responder((url, init) => {
      created.push({ url, init });
      return json({ id: FILE, name: "norfold.manifest.v1.bin", size: 9 });
    });
    const store = new DriveRestStore(tokens().source, { fetch: create.fetch });
    const bytes = new TextEncoder().encode("sealed!!").buffer as ArrayBuffer;
    await expect(store.write({ name: "norfold.manifest.v1.bin", bytes }))
      .resolves.toEqual({ id: FILE, name: "norfold.manifest.v1.bin", size: 9 });
    expect(created[0]!.url).toContain("/upload/drive/v3/files?uploadType=multipart");
    const contentType = (created[0]!.init.headers as Record<string, string>)["Content-Type"]!;
    expect(contentType.startsWith("multipart/related; boundary=")).toBe(true);
    const body = bodyText(created[0]!.init.body);
    expect(body).toContain('"name":"norfold.manifest.v1.bin"');
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain("sealed!!");

    const updated: Array<RequestInit> = [];
    const update = responder((_url, init) => {
      updated.push(init);
      return json({ id: FILE, name: "n", size: 8 });
    });
    const second = new DriveRestStore(tokens().source, { fetch: update.fetch });
    await second.write({ id: FILE, name: "n", bytes });
    expect((updated[0]!.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    expect(updated[0]!.method).toBe("PATCH");
    expect(bodyText(updated[0]!.body)).toBe("sealed!!");
  });

  it("renews once on 401 and reports a second 401 as a consent problem", async () => {
    let attempt = 0;
    const token = tokens();
    const store = new DriveRestStore(token.source, { fetch: responder(() => {
      attempt++;
      return attempt === 1 ? new Response(null, { status: 401 }) : json({ files: [] });
    }).fetch });
    await expect(store.list()).resolves.toEqual([]);
    expect(token.calls).toEqual([false, true]);

    const denied = new DriveRestStore(token.source, { fetch: responder(() => new Response(null, { status: 401 })).fetch });
    await expect(denied.list()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("classifies throttling, transient and permanent failures", async () => {
    const later = new DriveRestStore(tokens().source, {
      fetch: responder(() => new Response("", { status: 429, headers: { "retry-after": "2" } })).fetch,
    });
    const error = await later.list().catch((err: unknown) => err as DriveStoreError);
    expect((error as DriveStoreError).kind).toBe("throttled");
    expect((error as DriveStoreError).retryAfterMs).toBe(2000);

    const quota = new DriveRestStore(tokens().source, {
      fetch: responder(() => json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403)).fetch,
    });
    await expect(quota.list()).rejects.toMatchObject({ kind: "throttled" });

    const refused = new DriveRestStore(tokens().source, {
      fetch: responder(() => json({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403)).fetch,
    });
    await expect(refused.list()).rejects.toMatchObject({ kind: "unauthorized", httpStatus: 403, providerReason: "scope" });

    const broken = new DriveRestStore(tokens().source, {
      fetch: responder(() => new Response("", { status: 503 })).fetch,
    });
    await expect(broken.list()).rejects.toMatchObject({ kind: "unavailable" });

    const offline = new DriveRestStore(tokens().source, {
      fetch: (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch,
    });
    await expect(offline.list()).rejects.toMatchObject({ kind: "unavailable" });

    const badToken = new DriveRestStore({ token: async () => "nope nope nope" },
      { fetch: responder(() => json({ files: [] })).fetch });
    await expect(badToken.list()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("retains only safe status and known provider reasons for disabled Drive APIs", async () => {
    const store = new DriveRestStore(tokens().source, {
      fetch: responder(() => json({ error: { message: "PRIVATE_PROVIDER_SENTINEL",
        details: [{ reason: "SERVICE_DISABLED" }] } }, 403)).fetch,
    });
    const error = await store.list().catch(error => error);
    expect(error).toMatchObject({ kind: "invalid", httpStatus: 403, providerReason: "api-disabled" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_PROVIDER_SENTINEL");
  });

  it("treats an already-deleted object as removed", async () => {
    const store = new DriveRestStore(tokens().source, {
      fetch: responder((url) => url.includes("/files/")
        ? new Response(null, { status: 404 }) : json({ files: [] })).fetch,
    });
    await expect(store.remove(FILE)).resolves.toBeUndefined();
    await expect(store.remove("not an id")).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("the production store port", () => {
  it("uses the current token, renews when absent or forced, and never invents one", async () => {
    const calls: string[] = [];
    const auth = {
      current: () => null,
      renew: async () => { calls.push("renew"); return null; },
      authorize: async () => ({ token: TOKEN }),
    };
    const store = driveStore(auth);
    await expect(store.list()).rejects.toMatchObject({ kind: "unauthorized" });
    expect(calls).toEqual(["renew"]);

    const { fetch, calls: requests } = responder(() => json({ files: [] }));
    const live = driveStore({ current: () => ({ token: TOKEN }), renew: async () => null,
      authorize: async () => ({ token: TOKEN }) }, { fetch });
    await live.list();
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
