import { createClient, processLock } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { AuthAccountChangedError, createAccountScopedAuthStorage } from "./accountScopedAuthStorage";

function fixture() {
  const values = new Map<string, string>();
  let failing = false;
  const raw = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { if (failing) throw new Error("storage unavailable"); values.delete(key); } };
  const boundary = createAccountScopedAuthStorage(raw, "account-test-session");
  const session = (id: string) => ({ access_token: `synthetic-${id}`, refresh_token: `refresh-${id}`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: { id, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-14T00:00:00Z" } });
  const putSession = (id: string) => raw.setItem("account-test-session", JSON.stringify(session(id)));
  return { raw, boundary, putSession, failRemoval: (value: boolean) => { failing = value; } };
}

describe("account-scoped Supabase persistence boundary", () => {
  it("detects a storage removal failure in the real SDK and retries successfully", async () => {
    const f = fixture(); f.putSession("A");
    const urls: string[] = [];
    const sdk = createClient("https://test.invalid", "sb_publishable_fixture", { auth: { storageKey: "account-test-session", storage: f.boundary.storage, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock }, global: { fetch: async (url) => { urls.push(String(url)); return new Response(null, { status: 204 }); } } });
    try {
      await sdk.auth.getSession(); f.failRemoval(true);
      await expect(f.boundary.cleanAccount("A", () => sdk.auth.signOut())).rejects.toThrow(/storage unavailable/);
      expect(f.raw.getItem("account-test-session")).not.toBeNull();
      f.failRemoval(false);
      await f.boundary.cleanAccount("A", () => sdk.auth.signOut());
      expect((await sdk.auth.getSession()).data.session).toBeNull();
      expect(f.raw.getItem("account-test-session")).toBeNull();
      // Sign-out keeps the SDK default: global revocation, not a silent narrowing.
      expect(urls.some((url) => url.includes("/logout") && url.includes("scope=global"))).toBe(true);
    } finally { await sdk.auth.stopAutoRefresh(); }
  });

  it("does not send B's token to signout when A's cleanup starts after a switch", async () => {
    const f = fixture(); f.putSession("B");
    let calls = 0;
    const sdk = createClient("https://test.invalid", "sb_publishable_fixture", { auth: { storageKey: "account-test-session", storage: f.boundary.storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async () => { calls++; return new Response(null, { status: 204 }); } } });
    try {
      await sdk.auth.getSession();
      await expect(f.boundary.cleanAccount("A", () => sdk.auth.signOut())).rejects.toBeInstanceOf(AuthAccountChangedError);
      expect(calls).toBe(0);
      expect((await sdk.auth.getSession()).data.session?.user.id).toBe("B");
    } finally { await sdk.auth.stopAutoRefresh(); }
  });

  it("preserves a cross-tab B session arriving during A's real SDK network signout", async () => {
    const f = fixture(); f.putSession("A");
    let started!: () => void, release!: () => void;
    const entering = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const sdk = createClient("https://test.invalid", "sb_publishable_fixture", { auth: { storageKey: "account-test-session", storage: f.boundary.storage, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock }, global: { fetch: async (_url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer synthetic-A"); started(); await pending; return new Response(null, { status: 204 });
    } } });
    try {
      await sdk.auth.getSession();
      const cleanup = expect(f.boundary.cleanAccount("A", () => sdk.auth.signOut())).rejects.toBeInstanceOf(AuthAccountChangedError);
      await entering; f.putSession("B"); release(); await cleanup;
      expect((await sdk.auth.getSession()).data.session?.user.id).toBe("B");
    } finally { release(); await sdk.auth.stopAutoRefresh(); }
  });

  it("treats a remote-failing sign-out as done only when the SDK actually removed persistence", async () => {
    const f = fixture(); f.putSession("A");
    const sdk = createClient("https://test.invalid", "sb_publishable_fixture", { auth: { storageKey: "account-test-session", storage: f.boundary.storage, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock }, global: { fetch: async () => new Response("nope", { status: 500 }) } });
    try {
      await sdk.auth.getSession();
      // The SDK removes the current session even on an HTTP failure response,
      // so the boundary verifies the real outcome rather than the status code.
      await f.boundary.cleanAccount("A", () => sdk.auth.signOut());
      expect(f.raw.getItem("account-test-session")).toBeNull();
      expect((await sdk.auth.getSession()).data.session).toBeNull();
    } finally { await sdk.auth.stopAutoRefresh(); }
  });

  it("does not accept a silent persistence no-op as completed cleanup", async () => {
    const values = new Map([["session", JSON.stringify({ user: { id: "A" } })]]);
    const boundary = createAccountScopedAuthStorage({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: () => {} }, "session");
    await expect(boundary.cleanAccount("A", async () => { boundary.storage.removeItem("session"); })).rejects.toThrow(/could not be removed/);
  });
});
