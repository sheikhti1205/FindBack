import { describe, expect, it } from "vitest";
import { createBrowserAiCredentials } from "./browserAiCredentials";
import type { ProviderId } from "./ai/providerContract";
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

const FIVE_PROVIDERS: readonly ProviderId[] = ["openrouter", "openai", "anthropic", "google", "deepseek"];
const K1_PHRASE = "k1 strong unlock phrase";
const fakeKey = (provider: string, tag: string): string => `FAKE-K1-KEY-${provider}-${tag}`;
const bogusProvider = (name: string): ProviderId => name as unknown as ProviderId;

describe("browser five-provider vault (K1)", () => {
  it("isolates five per-provider namespaces for one account", async () => {
    const backend = store();
    const keys = createBrowserAiCredentials(backend);
    for (const provider of FIVE_PROVIDERS) {
      await keys.connect("alice", fakeKey(provider, "ns1"), { remember: true, passphrase: K1_PHRASE, provider });
    }
    for (const provider of FIVE_PROVIDERS) {
      expect(await keys.get("alice", provider)).toBe(fakeKey(provider, "ns1"));
      expect(keys.hasSaved("alice", provider)).toBe(true);
    }
    expect(await keys.get("alice", "openai")).not.toBe(fakeKey("anthropic", "ns1"));
    expect(await keys.get("alice", "deepseek")).not.toBe(fakeKey("google", "ns1"));
    const dump = backend.dump();
    for (const provider of FIVE_PROVIDERS) {
      expect(dump).not.toContain(fakeKey(provider, "ns1"));
    }
    expect(dump).not.toContain(K1_PHRASE);
  });

  it("isolates accounts within the same provider slot", async () => {
    const backend = store();
    const keys = createBrowserAiCredentials(backend);
    await keys.connect("alice", fakeKey("openai", "alice1"), { remember: true, passphrase: K1_PHRASE, provider: "openai" });
    await keys.connect("bob", fakeKey("openai", "bob1"), { remember: true, passphrase: K1_PHRASE, provider: "openai" });
    expect(await keys.get("alice", "openai")).toBe(fakeKey("openai", "alice1"));
    expect(await keys.get("bob", "openai")).toBe(fakeKey("openai", "bob1"));
    expect(await keys.get("alice", "anthropic")).toBeNull();
    const dump = backend.dump();
    expect(dump).not.toContain(fakeKey("openai", "alice1"));
    expect(dump).not.toContain(fakeKey("openai", "bob1"));
  });

  it("removes exactly one provider slot; account logout clears all five and nobody else's", async () => {
    const backend = store();
    const keys = createBrowserAiCredentials(backend);
    for (const provider of FIVE_PROVIDERS) {
      await keys.connect("alice", fakeKey(provider, "rm1"), { remember: true, passphrase: K1_PHRASE, provider });
    }
    await keys.connect("bob", fakeKey("openai", "rm1"), { remember: true, passphrase: K1_PHRASE, provider: "openai" });

    await keys.remove("alice", "openai");
    expect(await keys.get("alice", "openai")).toBeNull();
    expect(keys.hasSaved("alice", "openai")).toBe(false);
    expect(await keys.get("alice", "anthropic")).toBe(fakeKey("anthropic", "rm1"));
    expect(await keys.get("bob", "openai")).toBe(fakeKey("openai", "rm1"));

    await keys.removeAccount("alice");
    for (const provider of FIVE_PROVIDERS) {
      expect(await keys.get("alice", provider)).toBeNull();
      expect(keys.hasSaved("alice", provider)).toBe(false);
    }
    expect(await keys.get("bob", "openai")).toBe(fakeKey("openai", "rm1"));
    expect(keys.hasSaved("bob", "openai")).toBe(true);
  });

  it("unlocks each provider slot independently after a restart", async () => {
    const backend = store();
    const first = createBrowserAiCredentials(backend);
    await first.connect("alice", fakeKey("google", "ul1"), { remember: true, passphrase: K1_PHRASE, provider: "google" });
    await first.connect("alice", fakeKey("deepseek", "ul1"), { remember: true, passphrase: K1_PHRASE, provider: "deepseek" });

    const second = createBrowserAiCredentials(backend);
    expect(await second.get("alice", "google")).toBeNull();
    await second.unlock("alice", K1_PHRASE, "google");
    expect(await second.get("alice", "google")).toBe(fakeKey("google", "ul1"));
    expect(await second.get("alice", "deepseek")).toBeNull();
    await second.unlock("alice", K1_PHRASE, "deepseek");
    expect(await second.get("alice", "deepseek")).toBe(fakeKey("deepseek", "ul1"));
    await expect(second.unlock("alice", "wrong unlock phrase!!", "google")).rejects.toThrow("Cannot unlock");
  });

  it("exposes only an opaque credential handle without key material", async () => {
    const backend = store();
    const keys = createBrowserAiCredentials(backend);
    await keys.connect("alice", fakeKey("openai", "hd1"), { remember: false, provider: "openai" });
    const handle = keys.credentialHandle("alice", "openai");
    expect(handle.accountId).toBe("alice");
    expect(handle.provider).toBe("openai");
    expect(typeof handle.handle).toBe("string");
    expect(handle.handle.length).toBeGreaterThan(0);
    expect(JSON.stringify(handle)).not.toContain(fakeKey("openai", "hd1"));
  });

  it("rejects unknown providers without echoing key material", async () => {
    const backend = store();
    const keys = createBrowserAiCredentials(backend);
    const raw = fakeKey("bogus", "xx1");
    await expect(keys.connect("alice", raw, { remember: false, provider: bogusProvider("bogus") })).rejects.toThrow(
      /provider/i,
    );
    await expect(keys.connect("alice", raw, { remember: false, provider: bogusProvider("bogus") })).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !error.message.includes(raw),
    );
    expect(await keys.get("alice", bogusProvider("bogus"))).toBeNull();
    expect(keys.hasSaved("alice", bogusProvider("bogus"))).toBe(false);
  });
});
