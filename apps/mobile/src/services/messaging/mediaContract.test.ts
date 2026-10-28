// @vitest-environment node
/**
 * The shared chat-media record rules.
 *
 * SQLite enforces these with CHECK constraints; IndexedDB has none, so this
 * validator is the single set of rules both adapters call. A rule that exists
 * in only one place is a divergence waiting to happen, so every constraint the
 * schema states is exercised here directly.
 */
import { describe, expect, it } from "vitest";
import { copyMediaAttachment, copyMediaMessage, sniffMediaMime } from "./validation";
import type { MediaAttachment } from "./history";
import { mediaBytes } from "./mediaTestDoubles";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const MESSAGE = "00000000-0000-4000-8000-000000000008";
const ATTACHMENT = "00000000-0000-4000-8000-000000000020";
const SHA = "a".repeat(64);

function record(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: ATTACHMENT,
    messageId: MESSAGE,
    direction: "OUT",
    sha256: SHA,
    mime: "image/png",
    byteSize: 64,
    width: 32,
    height: 32,
    expiresAt: null,
    state: "QUEUED",
    attempts: 0,
    lastAccessAt: 0,
    ...overrides,
  };
}

describe("media attachment records", () => {
  it("copies a valid outbound queue record and an acknowledged inbound record", () => {
    expect(copyMediaAttachment(record())).toEqual(record());
    const inbound = record({ direction: "IN", state: "AWAITING_ACK", expiresAt: 1_700_000_000_000 });
    expect(copyMediaAttachment(inbound)).toEqual(inbound);
    expect(copyMediaAttachment(record({ state: "READY", expiresAt: 5 }))).toEqual(
      record({ state: "READY", expiresAt: 5 }),
    );
  });

  it("returns a copy, so a caller cannot mutate the stored shape afterwards", () => {
    const input = record();
    const copy = copyMediaAttachment(input);
    expect(copy).not.toBe(input);
    expect(copy).toEqual(input);
  });

  it("refuses every digest, MIME, size and dimension value the schema bounds", () => {
    const invalid: Array<[string, Partial<MediaAttachment>]> = [
      ["uppercase digest", { sha256: "A".repeat(64) }],
      ["non-hex digest", { sha256: "g".repeat(64) }],
      ["short digest", { sha256: "a".repeat(63) }],
      ["missing digest", { sha256: undefined as never }],
      ["unsupported mime", { mime: "image/gif" as never }],
      ["zero size", { byteSize: 0 }],
      ["negative size", { byteSize: -1 }],
      ["oversized size", { byteSize: 20 * 1024 * 1024 + 1 }],
      ["fractional size", { byteSize: 1.5 }],
      ["zero width", { width: 0 }],
      ["oversized width", { width: 8193 }],
      ["zero height", { height: 0 }],
      ["oversized height", { height: 8193 }],
      ["zero expiry", { expiresAt: 0 }],
      ["negative expiry", { expiresAt: -5 }],
      ["fractional expiry", { expiresAt: 1.5 }],
      ["negative attempts", { attempts: -1 }],
      ["fractional attempts", { attempts: 0.5 }],
      ["negative access", { lastAccessAt: -1 }],
      ["unknown state", { state: "SENDING" as never }],
      ["missing state", { state: undefined as never }],
      ["invalid id", { id: "not-a-uuid" }],
      ["invalid message id", { messageId: "not-a-uuid" }],
      ["invalid direction", { direction: "BOTH" as never }],
    ];
    for (const [label, overrides] of invalid) {
      expect(() => copyMediaAttachment(record(overrides)), label).toThrow();
    }
  });

  it("restricts inbound states and requires inbound delivery metadata", () => {
    // Inbound only exists once bytes arrived; there is no local queue to claim.
    for (const state of ["QUEUED", "UPLOADING", "FAILED"] as const) {
      expect(() => copyMediaAttachment(record({ direction: "IN", state, expiresAt: 5 })), state).toThrow(
        /state for direction|media state/i,
      );
    }
    expect(() => copyMediaAttachment(record({ direction: "IN", state: "AWAITING_ACK" })))
      .toThrow(/expiry/i);
    expect(() => copyMediaAttachment(record({ direction: "IN", state: "READY" }))).toThrow(/expiry/i);
    expect(() => copyMediaAttachment(record({ direction: "IN", state: "EVICTED", expiresAt: 5 })))
      .not.toThrow();
    // Outbound may be null before trusted delivery metadata exists.
    expect(() => copyMediaAttachment(record({ state: "READY" }))).not.toThrow();
  });

  it("ties the lease to UPLOADING in both directions", () => {
    expect(() => copyMediaAttachment(record({ state: "UPLOADING" }))).toThrow(/lease/i);
    expect(() => copyMediaAttachment(record({ state: "UPLOADING", token: ATTACHMENT }))).toThrow(/lease/i);
    expect(() => copyMediaAttachment(record({ state: "UPLOADING", leaseUntil: 5 }))).toThrow(/lease/i);
    expect(() => copyMediaAttachment(record({
      state: "UPLOADING", token: "not-a-uuid", leaseUntil: 5,
    }))).toThrow(/UUID/i);
    expect(() => copyMediaAttachment(record({ token: ATTACHMENT }))).toThrow(/lease/i);
    expect(() => copyMediaAttachment(record({ leaseUntil: 5 }))).toThrow(/lease/i);
    const held = record({ state: "UPLOADING", token: ATTACHMENT, leaseUntil: 5 });
    expect(copyMediaAttachment(held)).toEqual(held);
  });
});

describe("image-only messages", () => {
  it("accepts an empty caption as 'no caption', not as suppression", () => {
    expect(copyMediaMessage({
      id: MESSAGE, conversationId: MESSAGE, authorId: A, recipientId: B, body: "",
    })).toEqual({ id: MESSAGE, conversationId: MESSAGE, authorId: A, recipientId: B, body: "", messageType: "MEDIA" });
  });

  it("still refuses whitespace-only, NUL and oversized captions", () => {
    const message = { id: MESSAGE, conversationId: MESSAGE, authorId: A, recipientId: B, body: "" };
    expect(() => copyMediaMessage({ ...message, body: "   " })).toThrow(/Invalid messaging text/);
    expect(() => copyMediaMessage({ ...message, body: "a\u0000b" })).toThrow(/Invalid messaging text/);
    expect(() => copyMediaMessage({ ...message, body: "x".repeat(100_001) })).toThrow(/Invalid messaging text/);
    expect(() => copyMediaMessage({ ...message, body: "hello" })).not.toThrow();
  });
});

describe("media content sniffing", () => {
  it("recognises the three accepted containers", () => {
    expect(sniffMediaMime(mediaBytes("image/png"))).toBe("image/png");
    expect(sniffMediaMime(mediaBytes("image/jpeg"))).toBe("image/jpeg");
    expect(sniffMediaMime(mediaBytes("image/webp"))).toBe("image/webp");
  });

  it("returns null rather than guessing for anything else", () => {
    expect(sniffMediaMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer)).toBeNull();
    expect(sniffMediaMime(new ArrayBuffer(2))).toBeNull();
  });
});
