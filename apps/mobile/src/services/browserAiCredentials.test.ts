import { describe, expect, it } from "vitest";
import { createBrowserAiCredentials } from "./browserAiCredentials";
import type { KeyValueStore } from "./storage";

function store(): KeyValueStore & { dump: () => string } {
  const contents = new Map<string, string>();
  return {
    getItem: (key) => contents.get(key) ?? null,
    setItem: (key, value) => { contents.set(key, value); },
    removeItem: (key) => { contents.delete(key); },
    dump: () => JSON.stringify([...contents.values()]),
  };
}

describe("browser BYOK storage", () => {
  it("defaults to in-memory, scopes credentials to users and forgets on session clear", async () => {
    const backend = store();
    const keys = createBrowserAiCredentials(backend);
    await keys.connect("alice", "sample-key", { remember: false });
    expect(await keys.get("alice")).toBe("sample-key");
    expect(await keys.get("bob")).toBeNull();
    expect(backend.dump()).not.toContain("sample-key");
    keys.clearSession();
    expect(await keys.get("alice")).toBeNull();
  });

  it("remembers only encrypted bytes and requires an unlock phrase next visit", async () => {
    const backend = store();
    const first = createBrowserAiCredentials(backend);
    await first.connect("alice", "sample-key", { remember: true, passphrase: "strong unlock phrase" });
    expect(backend.dump()).not.toContain("sample-key");
    expect(backend.dump()).not.toContain("strong unlock phrase");
    const second = createBrowserAiCredentials(backend);
    expect(second.hasSaved("alice")).toBe(true);
    expect(await second.get("alice")).toBeNull();
    await expect(second.unlock("alice", "wrong phrase")).rejects.toThrow("Cannot unlock");
    await second.unlock("alice", "strong unlock phrase");
    expect(await second.get("alice")).toBe("sample-key");
    expect(await second.get("bob")).toBeNull();
    await second.remove("alice");
    expect(second.hasSaved("alice")).toBe(false);
    expect(await second.get("alice")).toBeNull();
  });

  it("rejects remember without a passphrase and removes old ciphertext when opting out", async () => {
    const backend = store();
    const keys = createBrowserAiCredentials(backend);
    await expect(keys.connect("alice", "sample-key", { remember: true })).rejects.toThrow("unlock phrase");
    await keys.connect("alice", "sample-key", { remember: true, passphrase: "strong unlock phrase" });
    await keys.connect("alice", "different-key", { remember: false });
    expect(keys.hasSaved("alice")).toBe(false);
    expect(backend.dump()).not.toContain("different-key");
  });
});
