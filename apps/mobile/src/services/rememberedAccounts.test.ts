// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { PublicUser } from "@norfold/shared";
import { readRememberedAccounts, rememberAccount, refreshRememberedAccount, removeRememberedAccount, subscribeRememberedAccounts } from "./rememberedAccounts";

const KEY = "findback.rememberedAccounts";
const user = (id = "account-a"): PublicUser => ({ id, username: `person_${id}`, displayName: "A Person", email: `${id}@example.com`, phone: "private-phone", emailVerified: true, phoneVerified: false, avatarUrl: "https://example.com/signed?token=private", createdAt: "2026-01-01" });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("retains only explicitly projected presentation metadata after consent", () => {
  expect(rememberAccount({ ...user(), password: "private-password", access_token: "private-token" } as PublicUser)).toBe(true);
  expect(readRememberedAccounts()).toEqual([expect.objectContaining({ id: "account-a", username: "person_account-a", displayName: "A Person", loginEmail: "account-a@example.com", maskedEmail: "a…@example.com" })]);
  const saved = localStorage.getItem(KEY)!;
  expect(saved).not.toMatch(/private-|phone|password|token|avatarUrl|createdAt|emailVerified/);
});

it("does not silently remember a new identity during login or restore", () => {
  refreshRememberedAccount(user());
  expect(readRememberedAccounts()).toEqual([]);
  rememberAccount(user());
  refreshRememberedAccount({ ...user(), displayName: "Changed name" });
  expect(readRememberedAccounts()[0]?.displayName).toBe("Changed name");
});

it("updates one identity, bounds the list and keeps most recently used first", () => {
  for (let i = 0; i < 12; i++) rememberAccount(user(`account-${i}`));
  expect(readRememberedAccounts()).toHaveLength(6);
  expect(readRememberedAccounts()[0]?.id).toBe("account-11");
  rememberAccount({ ...user("account-10"), username: "updated" });
  expect(readRememberedAccounts()[0]?.username).toBe("updated");
  expect(readRememberedAccounts().filter(a => a.id === "account-10")).toHaveLength(1);
});

it("removes only the chosen metadata and never shared downloads or session owners", () => {
  rememberAccount(user()); rememberAccount(user("account-b"));
  localStorage.setItem("model-download", "retained");
  expect(removeRememberedAccount("account-a")).toBe(true);
  expect(readRememberedAccounts().map(a => a.id)).toEqual(["account-b"]);
  expect(localStorage.getItem("model-download")).toBe("retained");
});

it.each(["broken", '{"version":99,"accounts":[]}', '{"version":1,"accounts":[null,{"id":"x"}]}', "x".repeat(65000)])("ignores malformed or oversized storage", raw => {
  localStorage.setItem(KEY, raw);
  expect(readRememberedAccounts()).toEqual([]);
});

it("revalidates persisted identities and drops unrecognized fields on read", () => {
  rememberAccount(user());
  const stored = JSON.parse(localStorage.getItem(KEY)!);
  stored.accounts[0].password = "injected";
  stored.accounts.push({ ...stored.accounts[0], id: "bad\nidentity" });
  localStorage.setItem(KEY, JSON.stringify(stored));
  expect(readRememberedAccounts()).toHaveLength(1);
  expect(JSON.stringify(readRememberedAccounts())).not.toContain("injected");
});

it("signals same-tab updates and relevant cross-tab changes, then unsubscribes", () => {
  const listener = vi.fn(); const unsubscribe = subscribeRememberedAccounts(listener);
  rememberAccount(user()); expect(listener).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  expect(listener).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe(); removeRememberedAccount("account-a");
  expect(listener).toHaveBeenCalledTimes(2);
});

it("degrades safely when browser storage is unavailable without pretending a write succeeded", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  expect(rememberAccount(user())).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  expect(readRememberedAccounts()).toEqual([]);
});

it("does not certify a destructive removal or overwrite siblings when storage cannot be read", () => {
  rememberAccount(user());
  const read = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
    if (key === KEY) throw new Error("read denied");
    return read.call(this, key);
  });
  expect(readRememberedAccounts()).toEqual([]); // Presentation remains forgiving.
  expect(removeRememberedAccount("account-a")).toBe(false);
  expect(rememberAccount(user("account-b"))).toBe(false);
});
