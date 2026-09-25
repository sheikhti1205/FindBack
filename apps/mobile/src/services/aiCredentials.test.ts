import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderId } from "./ai/providerContract";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  registerPlugin: vi.fn(),
}));

import { aiCredentials } from "./aiCredentials";

const FIVE_PROVIDERS: readonly ProviderId[] = ["openrouter", "openai", "anthropic", "google", "deepseek"];
const K1_PHRASE = "k1 facade unlock phrase";
const fakeKey = (provider: string, tag: string): string => `FAKE-K1-FACADE-${provider}-${tag}`;
const bogusProvider = (name: string): ProviderId => name as unknown as ProviderId;

let counter = 0;
const user = (tag: string): string => `k1-${tag}-${(counter += 1)}`;

beforeEach(() => {
  aiCredentials.clearSession();
});

describe("aiCredentials facade compatibility (K1)", () => {
  it("keeps the single-provider API on the default openrouter slot", async () => {
    const id = user("compat");
    await aiCredentials.connect(id, "  compat-key  ", { remember: false });
    expect(await aiCredentials.get(id)).toBe("compat-key");
    expect(await aiCredentials.hasSaved(id)).toBe(false);
    await aiCredentials.remove(id);
    expect(await aiCredentials.get(id)).toBeNull();
  });

  it("rejects empty user/key without echoing key material", async () => {
    const raw = fakeKey("openai", "empty1");
    await expect(aiCredentials.connect("", raw, { remember: false })).rejects.toThrow();
    await expect(aiCredentials.connect(user("empty"), "   ", { remember: false })).rejects.toThrow();
    expect(await aiCredentials.get("")).toBeNull();
    expect(await aiCredentials.hasSaved("")).toBe(false);
  });
});

describe("aiCredentials five-provider vault (K1)", () => {
  it("isolates five per-provider namespaces for one account", async () => {
    const id = user("ns");
    for (const provider of FIVE_PROVIDERS) {
      await aiCredentials.connect(id, fakeKey(provider, "ns1"), {
        remember: true,
        passphrase: K1_PHRASE,
        provider,
      });
    }
    for (const provider of FIVE_PROVIDERS) {
      expect(await aiCredentials.get(id, provider)).toBe(fakeKey(provider, "ns1"));
      expect(await aiCredentials.hasSaved(id, provider)).toBe(true);
    }
    expect(await aiCredentials.get(id, "openai")).not.toBe(fakeKey("anthropic", "ns1"));
  });

  it("isolates accounts within the same provider slot", async () => {
    const alice = user("alice");
    const bob = user("bob");
    await aiCredentials.connect(alice, fakeKey("deepseek", "acct1"), { remember: false, provider: "deepseek" });
    await aiCredentials.connect(bob, fakeKey("deepseek", "acct2"), { remember: false, provider: "deepseek" });
    expect(await aiCredentials.get(alice, "deepseek")).toBe(fakeKey("deepseek", "acct1"));
    expect(await aiCredentials.get(bob, "deepseek")).toBe(fakeKey("deepseek", "acct2"));
    expect(await aiCredentials.get(alice, "google")).toBeNull();
  });

  it("logout clears exactly that account's provider slots", async () => {
    const alice = user("logout-a");
    const bob = user("logout-b");
    for (const provider of FIVE_PROVIDERS) {
      await aiCredentials.connect(alice, fakeKey(provider, "lo1"), { remember: true, passphrase: K1_PHRASE, provider });
    }
    await aiCredentials.connect(bob, fakeKey("openai", "lo1"), { remember: true, passphrase: K1_PHRASE, provider: "openai" });

    await aiCredentials.remove(alice, "openai");
    expect(await aiCredentials.get(alice, "openai")).toBeNull();
    expect(await aiCredentials.get(alice, "anthropic")).toBe(fakeKey("anthropic", "lo1"));

    await aiCredentials.removeAccountCredentials(alice);
    for (const provider of FIVE_PROVIDERS) {
      expect(await aiCredentials.get(alice, provider)).toBeNull();
      expect(await aiCredentials.hasSaved(alice, provider)).toBe(false);
    }
    expect(await aiCredentials.get(bob, "openai")).toBe(fakeKey("openai", "lo1"));
    expect(await aiCredentials.hasSaved(bob, "openai")).toBe(true);
  });

  it("round-trips an opaque credential handle without key material", async () => {
    const id = user("handle");
    const raw = fakeKey("anthropic", "hd1");
    await aiCredentials.connect(id, raw, { remember: false, provider: "anthropic" });
    const handle = aiCredentials.credentialHandle(id, "anthropic");
    expect(handle.accountId).toBe(id);
    expect(handle.provider).toBe("anthropic");
    expect(typeof handle.handle).toBe("string");
    expect(JSON.stringify(handle)).not.toContain(raw);
    expect(await aiCredentials.resolveCredential(handle)).toBe(raw);
    expect(await aiCredentials.hasCredential(handle)).toBe(true);
    await aiCredentials.removeCredential(handle);
    expect(await aiCredentials.resolveCredential(handle)).toBeNull();
    expect(await aiCredentials.hasCredential(handle)).toBe(false);
  });

  it("resolveCredential returns null for unknown accounts, never throws key material", async () => {
    const handle = aiCredentials.credentialHandle(user("ghost"), "google");
    expect(await aiCredentials.resolveCredential(handle)).toBeNull();
    expect(await aiCredentials.hasCredential(handle)).toBe(false);
  });

  it("rejects unknown providers without echoing key material", async () => {
    const id = user("bogus");
    const raw = fakeKey("bogus", "xx1");
    await expect(
      aiCredentials.connect(id, raw, { remember: false, provider: bogusProvider("bogus") }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && /provider/i.test(error.message) && !error.message.includes(raw),
    );
    expect(await aiCredentials.get(id, bogusProvider("bogus"))).toBeNull();
    expect(() => aiCredentials.credentialHandle(id, bogusProvider("bogus"))).toThrow(/provider/i);
  });
});
