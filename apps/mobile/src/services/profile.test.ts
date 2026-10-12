import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostItem, PublicUser } from "@findback/shared";

const { clientMock, fetchMeMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
  fetchMeMock: vi.fn(),
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, fetchMe: (...args: unknown[]) => fetchMeMock(...args) };
});

import {
  PHONE_CHANGE_COOLDOWN,
  appendReportPage,
  fetchPhoneChangeEligibility,
  fetchPublicProfile,
  formatPhoneChangeEligibleAt,
  hasMoreReports,
  isOwnAvatarKey,
  isPhoneChangeCooldownError,
  parsePhoneCooldownEligibleAt,
  requestPhoneChange,
  searchProfilesByPrefix,
  updateMyProfile,
} from "./profile";

const row = {
  id: "u2",
  username: "owner",
  avatar_url: null,
  email_verified: 1,
  phone_verified: 0,
  display_name: "Owner Name",
  bio: "I find things",
  location_label: "Dhaka",
  created_at: "2026-01-05T00:00:00.000Z",
};

beforeEach(() => {
  clientMock.rpc.mockReset();
  fetchMeMock.mockReset();
});

describe("fetchPublicProfile", () => {
  it("looks the handle up through the safe public RPC", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row], error: null });

    const profile = await fetchPublicProfile("owner");

    expect(clientMock.rpc).toHaveBeenCalledWith("public_profile_by_username", {
      p_username: "owner",
    });
    expect(profile).toEqual({
      id: "u2",
      username: "owner",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      displayName: "Owner Name",
      bio: "I find things",
      locationLabel: "Dhaka",
      createdAt: "2026-01-05T00:00:00.000Z",
    });
  });

  it("never exposes email or phone in the mapped profile", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row], error: null });

    const profile = await fetchPublicProfile("owner");

    expect(profile).not.toHaveProperty("email");
    expect(profile).not.toHaveProperty("phone");
  });

  it("reports a missing profile with a 404-shaped human error", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await expect(fetchPublicProfile("ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a blank handle without touching the backend", async () => {
    await expect(fetchPublicProfile("   ")).rejects.toThrow();
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("maps RPC transport failures to a human error", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "400" } });

    await expect(fetchPublicProfile("owner")).rejects.toThrow(/could not be loaded/i);
  });
});

describe("updateMyProfile", () => {
  const refreshed: PublicUser = {
    id: "u1",
    username: "tester",
    email: "tester@example.com",
    phone: "+8801812345678",
    emailVerified: true,
    phoneVerified: false,
    avatarUrl: null,
    displayName: "New Name",
    bio: "hi",
    locationLabel: "Dhaka",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("sends trimmed values through the self-update RPC then reloads the profile", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    fetchMeMock.mockResolvedValue(refreshed);

    const result = await updateMyProfile({
      displayName: "  New Name ",
      bio: "  hi ",
      locationLabel: " Dhaka ",
    });

    expect(clientMock.rpc).toHaveBeenCalledWith("update_my_profile", {
      p_display_name: "New Name",
      p_bio: "hi",
      p_location_label: "Dhaka",
    });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(refreshed);
  });

  it("stores blank bio/location as null so the column is cleared", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    fetchMeMock.mockResolvedValue(refreshed);

    await updateMyProfile({ displayName: "Name", bio: "   ", locationLabel: "" });

    expect(clientMock.rpc).toHaveBeenCalledWith("update_my_profile", {
      p_display_name: "Name",
      p_bio: null,
      p_location_label: null,
    });
  });

  it("requires a non-empty display name before calling the backend", async () => {
    await expect(updateMyProfile({ displayName: "   " })).rejects.toThrow(/display name/i);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("bounds display name, bio and location client-side", async () => {
    await expect(updateMyProfile({ displayName: "x".repeat(81) })).rejects.toThrow(/80/);
    await expect(updateMyProfile({ displayName: "ok", bio: "x".repeat(281) })).rejects.toThrow(/280/);
    await expect(updateMyProfile({ displayName: "ok", locationLabel: "x".repeat(61) })).rejects.toThrow(/60/);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("maps RPC failures to a human save error", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "invalid bio", code: "22023" } });

    await expect(updateMyProfile({ displayName: "Name", bio: "hi" })).rejects.toThrow(
      /could not save/i,
    );
    expect(fetchMeMock).not.toHaveBeenCalled();
  });
});

const REPO_ROOT = resolve(process.cwd(), "../..");
const PREFIX_SEARCH_SQL = resolve(
  REPO_ROOT,
  "supabase/migrations/20261009040000_profile_prefix_search.sql",
);

function prefixSearchSql(): string {
  return readFileSync(PREFIX_SEARCH_SQL, "utf8");
}

/**
 * The prefix-search migration auto-applies on push, so these pin the
 * additive-safety contract: a new authenticated-only RPC, four safe columns,
 * a bounded prefix match, and no private contact columns anywhere.
 */
describe("profile prefix-search migration", () => {
  it("creates findback_search_profiles_client with a prefix arg and the 4 safe columns", () => {
    const text = prefixSearchSql();
    expect(text).toMatch(/create.+function public\.findback_search_profiles_client\(p_prefix text\)/i);
    expect(text).toMatch(/returns table \(/i);
    expect(text).toMatch(/\bid text\b/i);
    expect(text).toMatch(/\busername text\b/i);
    expect(text).toMatch(/\bdisplay_name text\b/i);
    expect(text).toMatch(/\bavatar_url text\b/i);
    expect(text).not.toMatch(/\bu\.email\b|\bu\.phone\b/i);
  });

  it("prefix-matches case-insensitively, orders by username, and bounds to 8 rows", () => {
    const text = prefixSearchSql();
    expect(text).toMatch(/lower\(u\.username\) like lower\(v_prefix\) \|\| '%'/i);
    expect(text).toMatch(/order by u\.username/i);
    expect(text).toMatch(/limit 8/i);
  });

  it("rejects anonymous callers and revokes anon execute", () => {
    const text = prefixSearchSql();
    expect(text).toMatch(/errcode = '28000'/i);
    expect(text).toMatch(
      /revoke execute on function public\.findback_search_profiles_client\(text\) from anon/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.findback_search_profiles_client\(text\) to authenticated/i,
    );
  });

  it("is strictly additive with a locked search_path", () => {
    const text = prefixSearchSql();
    expect(text).not.toMatch(/drop table|drop column|delete from|truncate/i);
    expect(text).toMatch(/security definer\s+set search_path = public, pg_temp/i);
  });
});

describe("searchProfilesByPrefix", () => {
  it("short-circuits empty and single-char prefixes without calling the RPC", async () => {
    await expect(searchProfilesByPrefix("")).resolves.toEqual([]);
    await expect(searchProfilesByPrefix("   ")).resolves.toEqual([]);
    await expect(searchProfilesByPrefix("a")).resolves.toEqual([]);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("trims the prefix before querying the prefix-search RPC", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await searchProfilesByPrefix("  al ");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_search_profiles_client", {
      p_prefix: "al",
    });
  });

  it("maps rows to searched profiles without private fields", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ id: "u9", username: "ali", display_name: "Ali", avatar_url: null }],
      error: null,
    });

    await expect(searchProfilesByPrefix("al")).resolves.toEqual([
      { id: "u9", username: "ali", displayName: "Ali", avatarUrl: null },
    ]);
  });

  it("propagates RPC failures instead of swallowing them", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "400" } });

    await expect(searchProfilesByPrefix("al")).rejects.toThrow(/could not be searched/i);
  });
});

// ---------------------------------------------------------------------------
// W5-IDENTITY appended cases: phone-change cooldown (spec 25), public-report
// pagination, and avatar-key ownership. The migration auto-applies on push;
// live Auth/SMS verification stays LIVE-PENDING (owner-deferred).
// ---------------------------------------------------------------------------

const COOLDOWN_MIGRATION = "supabase/migrations/20261012000000_phone_cooldown_avatar_key.sql";

function cooldownSql(): string {
  // Vitest may run from the repo root or apps/mobile — resolve by trial so
  // the contract holds from either cwd.
  for (const candidate of [COOLDOWN_MIGRATION, `../../${COOLDOWN_MIGRATION}`]) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // Not under this cwd — try the next candidate.
    }
  }
  throw new Error(`cannot locate ${COOLDOWN_MIGRATION} from cwd ${process.cwd()}`);
}

/**
 * Pins the additive-safety + server-authority contract: private nullable
 * columns only (no client table grants), session-resolved callers, server
 * clock comparisons, a stable PHONE_CHANGE_COOLDOWN marker with the eligible
 * date, an owned object-key avatar writer with existence check, and the
 * missing owner-scoped UPDATE policy.
 */
describe("phone cooldown + avatar-key migration", () => {
  it("adds the private cooldown columns additively, never dropping data", () => {
    const text = cooldownSql();
    expect(text).toMatch(/alter table public\.users\s+add column if not exists phone_verified_at text/i);
    expect(text).toMatch(/alter table public\.users\s+add column if not exists phone_last_changed_at text/i);
    expect(text).toMatch(/alter table public\.users\s+add column if not exists phone_change_eligible_at text/i);
    expect(text).not.toMatch(/drop table|drop column|delete from|truncate/i);
  });

  it("grants no table access for the new columns (RPC/trigger-owned only)", () => {
    const text = cooldownSql();
    expect(text).not.toMatch(/grant (select|update|insert|delete) on public\.users/i);
  });

  it("maintains the cooldown in a trigger: first stamp, same-number keep, different restamp", () => {
    const text = cooldownSql();
    expect(text).toMatch(/create trigger users_phone_cooldown/i);
    expect(text).toMatch(/before update of phone, phone_verified on public\.users/i);
    expect(text).toMatch(/maintain_phone_change_cooldown/i);
    expect(text).toMatch(/interval '6 months'/i);
    expect(text).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(text).toMatch(/revoke all on function public\.maintain_phone_change_cooldown\(\) from public, anon, authenticated/i);
  });

  it("reads eligibility self-only on the server clock, revoked from anon", () => {
    const text = cooldownSql();
    expect(text).toMatch(/create or replace function public\.phone_change_eligibility\(\)/i);
    expect(text).toMatch(/v_uid\s+text := public\.findback_uid\(\)/i);
    expect(text).toMatch(/now\(\) at time zone 'utc'\) >= \(v_eligible_at\)::timestamptz/i);
    expect(text).not.toMatch(/p_now|p_client_time/i);
    expect(text).toMatch(/revoke execute on function public\.phone_change_eligibility\(\) from anon/i);
    expect(text).toMatch(/grant execute on function public\.phone_change_eligibility\(\) to authenticated/i);
  });

  it("gates replacement server-side: first/same-number allowed, different held with the stable marker", () => {
    const text = cooldownSql();
    expect(text).toMatch(/create or replace function public\.request_phone_change\(p_new_phone text\)/i);
    expect(text).toMatch(/findback_normalize_bd_phone/i);
    expect(text).toMatch(/PHONE_CHANGE_COOLDOWN eligible_at=%/i);
    expect(text).toMatch(/using errcode = 'P0001'/i);
    expect(text).toMatch(/revoke execute on function public\.request_phone_change\(text\) from anon/i);
    expect(text).toMatch(/grant execute on function public\.request_phone_change\(text\) to authenticated/i);
  });

  it("adds the missing owner-scoped avatar UPDATE policy without touching report policies", () => {
    const text = cooldownSql();
    expect(text).toMatch(/findback_images_avatar_update_own/i);
    expect(text).toMatch(/for update to authenticated/i);
    expect(text).toMatch(/\(storage\.foldername\(name\)\)\[1\] = 'avatars'/i);
    expect(text).toMatch(/\(storage\.foldername\(name\)\)\[2\] = \(select auth\.uid\(\)\)::text/i);
    expect(text).not.toMatch(/insert into storage\.buckets/i);
  });

  it("writes avatars through an owned object-key RPC that verifies Storage existence", () => {
    const text = cooldownSql();
    expect(text).toMatch(/create or replace function public\.update_my_avatar_by_key\(\s*p_object_key text,\s*p_avatar_url text\s*\)/i);
    expect(text).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(text).toMatch(/v_uid\s+text := public\.findback_uid\(\)/i);
    expect(text).not.toMatch(/p_user_id|p_uid/i);
    expect(text).toMatch(/v_parts\[1\] <> 'avatars'/i);
    expect(text).toMatch(/v_parts\[2\] <> v_uid/i);
    expect(text).toMatch(/position\('..' in v_key\)/i);
    expect(text).toMatch(/storage\.objects/i);
    expect(text).toMatch(/avatar object not found/i);
    expect(text).toMatch(/\/findback-images\//i);
    expect(text).toMatch(/revoke execute on function public\.update_my_avatar_by_key\(text, text\) from anon/i);
    expect(text).toMatch(/grant execute on function public\.update_my_avatar_by_key\(text, text\) to authenticated/i);
  });
});

describe("fetchPhoneChangeEligibility", () => {
  it("reads the gate through the self-only eligibility RPC", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ eligible: false, eligible_at: "2027-04-12T00:00:00.000Z", phone_verified: true }],
      error: null,
    });

    const gate = await fetchPhoneChangeEligibility();

    expect(clientMock.rpc).toHaveBeenCalledWith("phone_change_eligibility");
    expect(gate).toEqual({
      eligible: false,
      eligibleAt: "2027-04-12T00:00:00.000Z",
      phoneVerified: true,
    });
  });

  it("treats an empty row set as eligible with no date (never fabricates one)", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await expect(fetchPhoneChangeEligibility()).resolves.toEqual({
      eligible: true,
      eligibleAt: null,
      phoneVerified: false,
    });
  });

  it("maps transport failures to a human error", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "400" } });

    await expect(fetchPhoneChangeEligibility()).rejects.toThrow(/could not check your number change/i);
  });
});

describe("requestPhoneChange", () => {
  it("normalizes before calling the server gate", async () => {
    clientMock.rpc.mockResolvedValue({ data: [{ eligible: true, eligible_at: null }], error: null });

    await requestPhoneChange("01812345678");

    expect(clientMock.rpc).toHaveBeenCalledWith("request_phone_change", {
      p_new_phone: "+8801812345678",
    });
  });

  it("rejects an invalid number before touching the backend", async () => {
    await expect(requestPhoneChange("not-a-number")).rejects.toThrow(/valid Bangladesh/i);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("maps the held gate to a 409 naming the eligible date", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "PHONE_CHANGE_COOLDOWN eligible_at=2027-04-12T00:00:00.000Z", code: "P0001" },
    });

    const failure = await requestPhoneChange("01911111111").catch((err) => err);
    expect(failure.status).toBe(409);
    expect(failure.message).toMatch(/2027/);
    // Status-only detection: the mapped error carries no internal marker
    // (it is never user-facing); consumers detect the cooldown by the 409.
    expect(isPhoneChangeCooldownError(failure)).toBe(false);
  });

  it("maps non-gate failures to a human error", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "400" } });

    await expect(requestPhoneChange("01911111111")).rejects.toThrow(/could not start/i);
  });
});

describe("phone cooldown pure helpers", () => {
  it("exposes the stable server marker", () => {
    expect(PHONE_CHANGE_COOLDOWN).toBe("PHONE_CHANGE_COOLDOWN");
  });

  it("parses the eligible date out of the server message", () => {
    expect(parsePhoneCooldownEligibleAt("PHONE_CHANGE_COOLDOWN eligible_at=2027-04-12T00:00:00.000Z")).toBe(
      "2027-04-12T00:00:00.000Z",
    );
    expect(parsePhoneCooldownEligibleAt("PHONE_CHANGE_COOLDOWN")).toBeNull();
    expect(parsePhoneCooldownEligibleAt("something else")).toBeNull();
  });

  it("detects gate rejections in any error shape", () => {
    expect(isPhoneChangeCooldownError(new Error("PHONE_CHANGE_COOLDOWN eligible_at=x"))).toBe(true);
    expect(isPhoneChangeCooldownError("PHONE_CHANGE_COOLDOWN")).toBe(true);
    expect(isPhoneChangeCooldownError({ message: "PHONE_CHANGE_COOLDOWN" })).toBe(true);
    expect(isPhoneChangeCooldownError(new Error("boom"))).toBe(false);
    expect(isPhoneChangeCooldownError(null)).toBe(false);
  });

  it("formats the eligible date tolerantly, never fabricating one", () => {
    expect(formatPhoneChangeEligibleAt("2027-04-12T00:00:00.000Z")).toMatch(/2027/);
    expect(formatPhoneChangeEligibleAt(null)).toBe("");
    expect(formatPhoneChangeEligibleAt(undefined)).toBe("");
    expect(formatPhoneChangeEligibleAt("not-a-date")).toBe("");
  });
});

describe("public-reports pagination helpers", () => {
  const first: PostItem = {
    id: "p1",
    userId: "u2",
    author: {
      id: "u2",
      username: "owner",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      createdAt: "2026-01-05T00:00:00.000Z",
    },
    type: "FOUND",
    title: "Found a wallet",
    description: "Brown leather wallet near the park.",
    category: "Bags & Wallets",
    status: "OPEN",
    eventDate: "2026-01-02",
    latitude: null,
    longitude: null,
    locationLabel: "Dhaka",
    youtubeUrl: null,
    attachments: [],
    likeCount: 0,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    createdAt: "2026-01-05T00:00:00.000Z",
    updatedAt: "2026-01-05T00:00:00.000Z",
  };

  it("hasMoreReports follows only the server cursor", () => {
    expect(hasMoreReports({ items: [], nextCursor: "abc" })).toBe(true);
    expect(hasMoreReports({ items: [], nextCursor: null })).toBe(false);
    expect(hasMoreReports({ items: [], nextCursor: "" })).toBe(false);
  });

  it("appendReportPage appends without mutating and dedupes repeated cursors", () => {
    const previous = [{ ...first }];
    const next = { ...first, id: "p2", title: "Lost keys" };
    const merged = appendReportPage(previous, { items: [next], nextCursor: null });

    expect(merged).toHaveLength(2);
    expect(previous).toHaveLength(1);
    expect(appendReportPage(merged, { items: [{ ...first }, { ...next }], nextCursor: null })).toHaveLength(2);
    expect(appendReportPage(previous, { items: [], nextCursor: null })).toBe(previous);
  });
});

describe("isOwnAvatarKey", () => {
  it("accepts the caller's own key and rejects foreign/traversal shapes", () => {
    expect(isOwnAvatarKey("avatars/user-1/a.jpg", "user-1")).toBe(true);
    expect(isOwnAvatarKey("avatars/user-2/a.jpg", "user-1")).toBe(false);
    expect(isOwnAvatarKey("avatars/user-1/../x.jpg", "user-1")).toBe(false);
    expect(isOwnAvatarKey("user-1/a.jpg", "user-1")).toBe(false);
    expect(isOwnAvatarKey("", "user-1")).toBe(false);
  });
});
