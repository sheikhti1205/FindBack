/**
 * WS-C transport tests (TDD): Range resume, redirect policy, byte bound,
 * progress, abort, and the sidecar journal.
 *
 * No real network: every case injects a fake `fetch`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  TransportError,
  createResumeJournal,
  downloadFile,
  journalResumeOffset,
  type FetchFn,
} from "./transport";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface FakeRoute {
  status: number;
  headers?: Record<string, string>;
  bodyText?: string;
  chunks?: string[];
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => FakeRoute,
  seen: { url: string; headers: Record<string, string> }[] = [],
): FetchFn {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: target, headers: { ...rawHeaders } });
    const route = handler(target, init ?? {});
    const payload = route.chunks?.join("") ?? route.bodyText ?? "";
    const encoded = bytesOf(payload);
    const headers = new Headers(route.headers ?? {});
    if (route.bodyText !== undefined || route.chunks !== undefined) {
      if (!headers.has("content-length")) {
        headers.set("content-length", String(encoded.length));
      }
    }
    const stream =
      route.chunks === undefined
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of route.chunks ?? []) {
                controller.enqueue(bytesOf(chunk));
              }
              controller.close();
            },
          });
    return {
      status: route.status,
      headers,
      body: stream,
      arrayBuffer: async () => encoded.buffer as ArrayBuffer,
    } as unknown as Response;
  }) as FetchFn;
}

describe("chunk transport", () => {
  it("downloads bytes and records a sidecar journal", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 200,
      bodyText: "hello",
    }));
    const result = await downloadFile("https://cdn.example.com/m.gguf", {
      fetchFn,
      expectedSha: "a".repeat(64),
    });
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    expect(result.journal).toEqual({
      url: "https://cdn.example.com/m.gguf",
      offset: 5,
      sha: "a".repeat(64),
    });
  });

  it("resumes from an offset with a Range header and verifies Content-Range", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = fakeFetch(
      () => ({
        status: 206,
        headers: { "content-range": "bytes 4-9/10" },
        bodyText: "567890",
      }),
      seen,
    );
    const result = await downloadFile("https://cdn.example.com/m.gguf", {
      fetchFn,
      offset: 4,
      expectedSha: "b".repeat(64),
    });
    expect(seen[0]?.headers["Range"]).toBe("bytes=4-");
    expect(result.bytesReceived).toBe(6);
    expect(result.journal.offset).toBe(10);
    expect(journalResumeOffset(result.journal)).toBe(10);
  });

  it("refuses a 200 restart when staged bytes exist", async () => {
    const fetchFn = fakeFetch(() => ({ status: 200, bodyText: "full" }));
    await expect(
      downloadFile("https://cdn.example.com/m.gguf", { fetchFn, offset: 4 }),
    ).rejects.toMatchObject({ code: "RESUME_NOT_SUPPORTED" });
  });

  it("rejects a Content-Range that mismatches the resume offset", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 206,
      headers: { "content-range": "bytes 0-5/10" },
      bodyText: "012345",
    }));
    await expect(
      downloadFile("https://cdn.example.com/m.gguf", { fetchFn, offset: 4 }),
    ).rejects.toMatchObject({ code: "OFFSET_MISMATCH" });
  });

  it("follows https redirects up to the limit and records the final URL", async () => {
    const fetchFn = fakeFetch((url) => {
      if (url === "https://cdn.example.com/a") {
        return { status: 302, headers: { location: "https://cdn.example.com/b" } };
      }
      return { status: 200, bodyText: "ok" };
    });
    const result = await downloadFile("https://cdn.example.com/a", { fetchFn });
    expect(result.journal.url).toBe("https://cdn.example.com/b");
    expect(new TextDecoder().decode(result.bytes)).toBe("ok");
  });

  it("refuses non-https redirects", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 302,
      headers: { location: "http://evil.example.com/m" },
    }));
    await expect(
      downloadFile("https://cdn.example.com/a", { fetchFn }),
    ).rejects.toMatchObject({ code: "REDIRECT_NON_HTTPS" });
  });

  it("stops after max redirects", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 302,
      headers: { location: "https://cdn.example.com/loop" },
    }));
    await expect(
      downloadFile("https://cdn.example.com/loop", { fetchFn, maxRedirects: 3 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  it("enforces the byte bound before and during streaming", async () => {
    const tooBig = fakeFetch(() => ({
      status: 200,
      headers: { "content-length": "100" },
      bodyText: "x".repeat(100),
    }));
    await expect(
      downloadFile("https://cdn.example.com/m.gguf", {
        fetchFn: tooBig,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "BYTE_BOUND_EXCEEDED" });

    const streamer = fakeFetch(() => ({
      status: 200,
      chunks: ["aaaa", "bbbb"],
    }));
    await expect(
      downloadFile("https://cdn.example.com/m.gguf", {
        fetchFn: streamer,
        maxBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "BYTE_BOUND_EXCEEDED" });
  });

  it("reports progress per chunk", async () => {
    const onProgress = vi.fn();
    const fetchFn = fakeFetch(() => ({
      status: 200,
      chunks: ["ab", "cd"],
    }));
    await downloadFile("https://cdn.example.com/m.gguf", {
      fetchFn,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[1]?.[0]).toMatchObject({ received: 4 });
  });

  it("honours AbortSignal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = fakeFetch(() => ({ status: 200, bodyText: "x" }));
    await expect(
      downloadFile("https://cdn.example.com/m.gguf", {
        fetchFn,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("round-trips a resume journal offset", () => {
    const journal = createResumeJournal("https://cdn.example.com/m", 42, "c".repeat(64));
    expect(journalResumeOffset(journal)).toBe(42);
  });
});
