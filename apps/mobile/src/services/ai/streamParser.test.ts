import { describe, expect, it } from "vitest";
import { SseStreamParser } from "./streamParser";

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function run(chunks: Uint8Array[]) {
  const parser = new SseStreamParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  return { events, tail: parser.flush() };
}

function textDeltas(events: Array<{ type: string; delta?: string }>): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => event.delta ?? "")
    .join("");
}

describe("SseStreamParser SSE framing", () => {
  it("assembles one event split across network chunks (chunk != event)", () => {
    const payload = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    const bytes = enc(`${payload}\n\n`);
    const { events, tail } = run([bytes.slice(0, 11), bytes.slice(11)]);
    expect(textDeltas(events)).toBe("hello");
    expect(tail).toEqual([{ type: "done" }]);
  });

  it("survives a split multi-byte UTF-8 character across chunks", () => {
    const message = "Hi 😊 found";
    const payload = `data: {"choices":[{"delta":{"content":${JSON.stringify(message)}}}]} \n\n`;
    const bytes = enc(payload);
    // Split inside the 4-byte emoji encoding, not on a char boundary.
    const emojiByte = bytes.indexOf(enc("😊")[0]!);
    const { events } = run([bytes.slice(0, emojiByte + 1), bytes.slice(emojiByte + 1)]);
    expect(textDeltas(events)).toBe(message);
  });

  it("handles CRLF line endings identically to LF", () => {
    const crlf = enc('data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n');
    const lf = enc('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n');
    expect(textDeltas(run([crlf]).events)).toBe("ab");
    expect(textDeltas(run([lf]).events)).toBe("ab");
  });

  it("joins multiline data: lines of one event into a single payload", () => {
    const { events } = run([
      enc('data: {"choices":[{"delta":\ndata: {"content":"multi"}}]}\n\n'),
    ]);
    expect(textDeltas(events)).toBe("multi");
  });

  it("ignores comment and keepalive lines", () => {
    const { events, tail } = run([
      enc(': ping\n: PROCESSING\n\ndata: {"choices":[{"delta":{"content":"kept"}}]}\n\n: trailing\n'),
    ]);
    expect(textDeltas(events)).toBe("kept");
    expect(tail).toEqual([{ type: "done" }]);
  });

  it("emits several events from a single network chunk", () => {
    const { events } = run([
      enc(
        'data: {"choices":[{"delta":{"content":"one"}}]}\n\ndata: {"choices":[{"delta":{"content":"two"}}]}\n\n',
      ),
    ]);
    expect(textDeltas(events)).toBe("onetwo");
  });

  it("ignores event:, id: and retry: fields", () => {
    const { events } = run([
      enc('event: message\nid: 7\nretry: 3000\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
    ]);
    expect(textDeltas(events)).toBe("x");
  });

  it("skips malformed JSON lines and continues the stream", () => {
    const { events, tail } = run([
      enc('data: {broken\n\ndata: {"choices":[{"delta":{"content":"after"}}]}\n\n'),
    ]);
    expect(textDeltas(events)).toBe("after");
    expect(tail).toEqual([{ type: "done" }]);
  });

  it("terminates cleanly on [DONE]", () => {
    const { events, tail } = run([
      enc('data: {"choices":[{"delta":{"content":"fin"}}]}\n\ndata: [DONE]\n\n'),
    ]);
    expect(textDeltas(events)).toBe("fin");
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    // DONE already terminated the stream: flush stays terminal without duplicating done.
    expect(tail).toEqual([]);
  });

  it("tolerates a missing terminal [DONE] at EOF", () => {
    const parser = new SseStreamParser();
    const events = parser.push(enc('data: {"choices":[{"delta":{"content":"orphan"}}]}\n\n'));
    const tail = parser.flush();
    expect(textDeltas(events)).toBe("orphan");
    expect(tail).toEqual([{ type: "done" }]);
  });

  it("surfaces mid-stream error payloads", () => {
    const { events } = run([
      enc('data: {"error":{"message":"upstream exploded"},"choices":[{"finish_reason":"error"}]}\n\n'),
    ]);
    const errors = events.filter((event) => event.type === "stream-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "stream-error", code: "stream-error" });
    expect(String((errors[0] as { message?: unknown }).message ?? "")).toContain("upstream exploded");
  });

  it("emits usage frames with prompt and completion tokens", () => {
    const { events } = run([
      enc('data: {"choices":[{}],"usage":{"prompt_tokens":120,"completion_tokens":44}}\n\n'),
    ]);
    expect(events).toContainEqual({
      type: "usage",
      promptTokens: 120,
      completionTokens: 44,
    });
  });

  it("emits usage frames split across chunks without losing text", () => {
    const bytes = enc(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
    );
    const mid = Math.floor(bytes.length / 2);
    const { events, tail } = run([bytes.slice(0, mid), bytes.slice(mid)]);
    expect(textDeltas(events)).toBe("hi");
    expect(events).toContainEqual({ type: "usage", promptTokens: 7, completionTokens: 3 });
    // Exactly one terminal marker across pushes and the final flush.
    const terminal = [...events, ...tail].filter((event) => event.type === "done");
    expect(terminal).toHaveLength(1);
  });
});
