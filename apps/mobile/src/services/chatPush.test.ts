import { describe, expect, it } from "vitest";
import { createChatAccountBinding, parseChatPush } from "./chatPush";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const data = { type: "CHAT_REQUEST", recipientId: a, conversationId: b, notificationId: a };

describe("content-free chat push admission", () => {
  it("accepts only the exact two four-field variants", () => {
    expect(parseChatPush(data)).toEqual(data);
    expect(parseChatPush({ ...data, type: "CHAT_CONNECTED" })?.type).toBe("CHAT_CONNECTED");
    for (const value of [null, {}, { ...data, type: "CHAT_OTHER" }, { ...data, url: "https://evil.invalid" },
      { ...data, conversationId: "../signin" }, { ...data, recipientId: 42 }, { ...data, body: "private" }]) {
      expect(parseChatPush(value)).toBeNull();
    }
  });

  it("serializes an in-flight old bind, logout clear and new bind without a stale overwrite", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const pending = new Promise<void>((done) => { release = done; });
    const writes: Array<string | null> = [];
    const binding = createChatAccountBinding(async (account) => {
      if (account === a) { entered(); await pending; }
      writes.push(account);
    });
    let account: string | null = a;
    const first = binding.set(a, () => account === a);
    await started;
    account = null;
    const clear = binding.set(null, () => true);
    account = b;
    const next = binding.set(b, () => account === b);
    release();
    await Promise.all([first, clear, next]);
    expect(writes).toEqual([a, null, b]);
    expect(await binding.ready(b)).toBe(true);
    expect(await binding.ready(a)).toBe(false);
  });

  it("does not admit chat after a failed bind, and can retry", async () => {
    let fail = true;
    const binding = createChatAccountBinding(async () => { if (fail) throw new Error("bridge"); });
    await expect(binding.set(a, () => true)).rejects.toThrow("bridge");
    expect(await binding.ready(a)).toBe(false);
    fail = false;
    await binding.set(a, () => true);
    expect(await binding.ready(a)).toBe(true);
  });
});
