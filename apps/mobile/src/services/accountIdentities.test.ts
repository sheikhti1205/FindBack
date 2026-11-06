// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fetchAccountIdentities, readCachedAccountIdentities, clearAccountIdentityCache } from "./accountLabels";

const m = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("./supabaseClient", () => ({ getSupabase: () => m }));
beforeEach(() => { clearAccountIdentityCache(); localStorage.clear(); m.from.mockReset(); });

it("caches public real names and avatars without substituting them for usernames", async () => {
  const builder = { select: vi.fn(() => builder), in: vi.fn().mockResolvedValue({ data: [
    { id: "peer", username: "sam_r", display_name: "Sam Rivera", avatar_url: "https://example.test/avatar" },
  ], error: null }) };
  m.from.mockReturnValue(builder);
  const people = await fetchAccountIdentities("account", ["peer"]);
  expect(people.get("peer")).toEqual({ id: "peer", username: "sam_r", displayName: "Sam Rivera", avatarUrl: "https://example.test/avatar" });
  expect(readCachedAccountIdentities("account", ["peer"])).toEqual(people);
  await fetchAccountIdentities("account", ["peer"]);
  expect(m.from).toHaveBeenCalledTimes(1);
  expect(builder.select).toHaveBeenCalledWith("id, username, display_name, avatar_url");
  expect(readCachedAccountIdentities("other-account", ["peer"]).size).toBe(0);
});

it("does not repopulate a cleared account cache from a late response", async () => {
  let resolve!: (value: unknown) => void;
  const builder = { select: () => builder, in: () => new Promise(r => { resolve = r; }) };
  m.from.mockReturnValue(builder);
  const pending = fetchAccountIdentities("account", ["peer"]);
  clearAccountIdentityCache();
  resolve({ data: [{ id: "peer", username: "sam", display_name: "Sam" }], error: null });
  await pending;
  expect(readCachedAccountIdentities("account", ["peer"]).size).toBe(0);
});
