import { equal, ok } from "node:assert/strict";
import { rejectNonEmptyBody } from "./emptyPost.ts";

// The guard exists to stop a caller selecting work through the body. Its first
// version also rejected a declared-empty body, which is what curl sends when a
// content-type header is present and no data is: the scheduled sweep was
// answered 400 and could never drain the queue.

const request = (init: { body?: string | null; length?: string | null }) => {
  const headers = new Headers();
  if (init.length !== undefined && init.length !== null) headers.set("content-length", init.length);
  return new Request("https://example.test/functions/v1/cleanup-chat-media", {
    method: "POST", headers,
    ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
  });
};

Deno.test("a declared-zero length is an empty request, not a payload", () => {
  equal(rejectNonEmptyBody(request({ length: "0" })), null);
});

Deno.test("an absent length with no body is an empty request", () => {
  equal(rejectNonEmptyBody(request({})), null);
});

Deno.test("a declared payload is refused before anything is read", async () => {
  const response = rejectNonEmptyBody(request({ length: "12", body: '{"bucket":1}' }));
  ok(response);
  equal(response!.status, 400);
  equal((await response!.json()).error, "Empty request required");
});

Deno.test("a chunked payload with no declared length is refused", async () => {
  // `Request` with a string body always sets a length, so model the chunked case
  // by streaming without a content-length header.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
  });
  const chunked = new Request("https://example.test/functions/v1/copy-chat-evidence", {
    method: "POST", body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });
  equal(chunked.headers.get("content-length"), null);
  const response = rejectNonEmptyBody(chunked);
  ok(response);
  equal(response!.status, 400);
});

Deno.test("a non-POST is not this guard's concern", () => {
  // Method rejection stays in the handler so both lanes answer 405 identically.
  equal(rejectNonEmptyBody(new Request("https://example.test/functions/v1/cleanup-chat-media")), null);
});
