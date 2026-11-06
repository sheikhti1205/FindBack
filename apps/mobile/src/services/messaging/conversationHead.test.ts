import { describe, expect, it } from "vitest";
import { assessConversationHead, copyConversationHead, type ConversationHead } from "./conversationHead";

const accountId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const base: ConversationHead = { accountId, conversationId, streamId: "stream-a", epoch: "relationship-a",
  revision: 3, position: 20, messageHead: 20, stateHead: 0, serverTime: 1_000 };

describe("authorized conversation HEAD gate", () => {
  it("opens an equal durable checkpoint without treating server time as progress", () => {
    expect(assessConversationHead(base, { ...base, serverTime: 2_000 })).toEqual({ mode: "ready", missing: 0 });
  });
  it.each([1, 9, 10])("silently catches up %i harmless events with cached interaction", missing => {
    expect(assessConversationHead(base, { ...base, position: 20 + missing, messageHead: 20 + missing }))
      .toEqual({ mode: "soft", missing });
  });
  it.each([11, 21, 1_000])("blocks %i missing events", missing => {
    expect(assessConversationHead(base, { ...base, position: 20 + missing, messageHead: 20 + missing }))
      .toEqual({ mode: "blocking", missing, reason: "gap" });
  });
  it("does not fabricate a baseline for a new installation or a restored backup", () => {
    expect(assessConversationHead(null, base)).toEqual({ mode: "blocking", missing: 20, reason: "unknown" });
  });
  it("hard-gates even one erasure event without erasing harmless events from the count", () => {
    expect(assessConversationHead(base, { ...base, position: 21, stateHead: 21 }))
      .toEqual({ mode: "blocking", missing: 1, reason: "state" });
  });
  it("does not repeatedly hard-gate an erasure already applied at the checkpoint", () => {
    const applied = { ...base, stateHead: 19 };
    expect(assessConversationHead(applied, { ...applied, position: 21, messageHead: 21 }))
      .toEqual({ mode: "soft", missing: 1 });
  });
  it.each([
    { epoch: "relationship-b" }, { revision: 4 }, { streamId: "stream-b" },
    { accountId: "00000000-0000-4000-8000-000000000003" },
    { conversationId: "00000000-0000-4000-8000-000000000004" },
  ])("hard-gates an authority or stream boundary at zero gap: %j", change => {
    expect(assessConversationHead(base, { ...base, ...change })).toMatchObject({ mode: "blocking", reason: "authority" });
  });
  it.each([
    { position: 19, messageHead: 19 }, { messageHead: 19 }, { serverTime: 999 },
  ])("rejects a regressed/replayed HEAD: %j", change => {
    expect(assessConversationHead(base, { ...base, ...change })).toMatchObject({ mode: "blocking", reason: "integrity" });
  });
  it("rejects incompatible event identities at the same consumed position", () => {
    const applied = { ...base, messageHead: 19, stateHead: 20 };
    expect(assessConversationHead(applied, { ...applied, messageHead: 20 }))
      .toMatchObject({ mode: "blocking", reason: "integrity" });
  });
  it.each([
    null, {}, { ...base, accountId: "bad" }, { ...base, position: -1 },
    { ...base, position: 1.2 }, { ...base, position: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, messageHead: 21 }, { ...base, stateHead: 21 }, { ...base, revision: -1 },
    { ...base, serverTime: NaN }, { ...base, streamId: "" }, { ...base, epoch: "" },
    { ...base, position: 21 },
  ])("validates the complete transport shape before comparison: %j", value => {
    expect(() => copyConversationHead(value)).toThrow();
  });
  it("copies allowed scalar metadata rather than retaining mutable transport objects or message bodies", () => {
    const input = { ...base, body: "private", arbitrary: { value: 1 } };
    const copy = copyConversationHead(input);
    expect(copy).toEqual(base); expect(copy).not.toBe(input);
    input.position = 99; expect(copy.position).toBe(20);
  });
});
