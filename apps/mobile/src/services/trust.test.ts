import { beforeEach, describe, expect, it, vi } from "vitest";
import * as trust from "./trust";
import {
  RECOVERY_HELPER_KINDS,
  STANDINGS,
  REPUTATION_TIERS,
  canRateReturn,
  fetchActiveSanctionKind,
  fetchInteractionLimits,
  fetchPostLimit,
  fetchReputationTier,
  fetchStanding,
  isInteractionLimitRefusal,
  isTrustUnavailable,
  listMyRecoveries,
  listReturnRatings,
  markRecovered,
  rateReturn,
  type MyRecovery,
} from "./trust";

const { clientMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

beforeEach(() => {
  clientMock.rpc.mockReset();
});

function lastCall(name: string): Record<string, unknown> {
  const call = clientMock.rpc.mock.calls.find((entry) => entry[0] === name);
  expect(call, `${name} was called`).toBeTruthy();
  return call![1] as Record<string, unknown>;
}

function callNames(): string[] {
  return clientMock.rpc.mock.calls.map((entry) => entry[0] as string);
}

const RECOVERY: MyRecovery = {
  returnId: "ret-1",
  lostPostId: "post-1",
  counterpartUserId: "user-2",
  externalHelper: false,
  recoveredAt: "2026-10-22T10:00:00.000Z",
  myRating: null,
  counterpartRating: null,
};

describe("the trust contract", () => {
  it("speaks only the server's own RPC names", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });

    await markRecovered({ postId: "post-1", helperKind: "OUTSIDE" }).catch(() => undefined);
    await listMyRecoveries().catch(() => undefined);
    await rateReturn({ returnId: "ret-1", score: 4 }).catch(() => undefined);
    await listReturnRatings("ret-1").catch(() => undefined);
    await fetchStanding().catch(() => undefined);
    await fetchReputationTier("user-1").catch(() => undefined);
    await fetchPostLimit().catch(() => undefined);
    await fetchActiveSanctionKind("user-1").catch(() => undefined);

    expect(callNames()).toEqual([
      "findback_mark_recovered",
      "findback_my_recoveries",
      "findback_rate_return",
      "findback_return_ratings",
      "findback_standing",
      "findback_reputation_tier",
      "findback_post_limit",
      "findback_active_sanction_kind",
    ]);
  });

  it("keeps the server's closed vocabularies closed", () => {
    expect([...RECOVERY_HELPER_KINDS]).toEqual(["FINDBACK_USER", "OUTSIDE", "SELF_OR_PRIVATE"]);
    expect([...STANDINGS]).toEqual(["GOOD", "PROBATION", "RESTRICTED", "SUSPENDED", "BANNED"]);
    expect([...REPUTATION_TIERS]).toEqual(["NEW", "NORMAL", "TRUSTED"]);
  });
});

describe("marking a report recovered", () => {
  it("sends exactly the server's three arguments and returns the recovery id", async () => {
    clientMock.rpc.mockResolvedValue({ data: "ret-9", error: null });

    await expect(
      markRecovered({ postId: "  post-1  ", helperKind: "FINDBACK_USER", helperUserId: "  user-2  " }),
    ).resolves.toBe("ret-9");

    expect(lastCall("findback_mark_recovered")).toEqual({
      p_post_id: "post-1",
      p_helper_kind: "FINDBACK_USER",
      p_helper_user_id: "user-2",
    });
  });

  it("sends no account for an outside or private helper", async () => {
    clientMock.rpc.mockResolvedValue({ data: "ret-9", error: null });

    await markRecovered({ postId: "post-1", helperKind: "OUTSIDE" });
    expect(lastCall("findback_mark_recovered")).toEqual({
      p_post_id: "post-1",
      p_helper_kind: "OUTSIDE",
      p_helper_user_id: null,
    });
  });

  it("refuses the cases the server refuses, without a round trip", async () => {
    await expect(markRecovered({ postId: "  ", helperKind: "OUTSIDE" })).rejects.toMatchObject({
      status: 400,
      code: "MISSING_POST_ID",
    });
    await expect(
      markRecovered({ postId: "post-1", helperKind: "SOMEONE" as unknown as "OUTSIDE" }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_HELPER_KIND" });
    await expect(markRecovered({ postId: "post-1", helperKind: "FINDBACK_USER" })).rejects.toMatchObject({
      status: 400,
      code: "MISSING_HELPER_ID",
    });
    await expect(
      markRecovered({ postId: "post-1", helperKind: "OUTSIDE", helperUserId: "user-2" }),
    ).rejects.toMatchObject({ status: 400, code: "HELPER_HAS_NO_ACCOUNT" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("refuses to name the caller as the FindBack helper", async () => {
    await expect(
      markRecovered({
        postId: "post-1",
        helperKind: "FINDBACK_USER",
        helperUserId: "user-1",
        selfUserId: "user-1",
      }),
    ).rejects.toMatchObject({ status: 400, code: "SELF_HELPER" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("carries the server's refusal, with the server's own words", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "This report has already been marked recovered", code: "23505" },
    });
    await expect(markRecovered({ postId: "post-1", helperKind: "OUTSIDE" })).rejects.toMatchObject({
      status: 409,
      code: "23505",
      message: "This report has already been marked recovered",
    });
  });

  it("maps the server's refusals to their own meanings", async () => {
    const cases: Array<[string, number]> = [
      ["42501", 403],
      ["22023", 400],
      ["28000", 401],
      ["P0002", 404],
      ["23505", 409],
      ["PGRST202", 501],
    ];
    for (const [code, status] of cases) {
      clientMock.rpc.mockResolvedValue({ data: null, error: { message: "refused", code } });
      await expect(markRecovered({ postId: "post-1", helperKind: "OUTSIDE" })).rejects.toMatchObject({
        status,
        code: code === "PGRST202" ? trust.TRUST_UNAVAILABLE_CODE : code,
      });
    }
  });

  it("does not claim a recovery the server did not confirm", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    await expect(markRecovered({ postId: "post-1", helperKind: "OUTSIDE" })).rejects.toMatchObject({
      status: 500,
      code: "UNEXPECTED_SHAPE",
    });
  });
});

describe("the caller's own recoveries", () => {
  it("maps the row the server returns", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        {
          successful_return_id: "ret-1",
          lost_post_id: "post-1",
          counterpart_user_id: "user-2",
          external_helper: false,
          recovered_at: "2026-10-22T10:00:00.000Z",
          my_rating: 5,
          counterpart_rating: 4,
        },
      ],
      error: null,
    });

    await expect(listMyRecoveries()).resolves.toEqual([
      {
        returnId: "ret-1",
        lostPostId: "post-1",
        counterpartUserId: "user-2",
        externalHelper: false,
        recoveredAt: "2026-10-22T10:00:00.000Z",
        myRating: 5,
        counterpartRating: 4,
      },
    ]);
    expect(lastCall("findback_my_recoveries")).toEqual({});
  });

  it("keeps an unnamed counterpart unnamed instead of inventing one", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        {
          successful_return_id: "ret-2",
          lost_post_id: "post-2",
          counterpart_user_id: null,
          external_helper: true,
          recovered_at: "2026-10-21T10:00:00.000Z",
          my_rating: null,
          counterpart_rating: null,
        },
      ],
      error: null,
    });

    await expect(listMyRecoveries()).resolves.toEqual([
      {
        returnId: "ret-2",
        lostPostId: "post-2",
        counterpartUserId: null,
        externalHelper: true,
        recoveredAt: "2026-10-21T10:00:00.000Z",
        myRating: null,
        counterpartRating: null,
      },
    ]);
  });

  it("drops a row it cannot name instead of rendering an empty entry", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ successful_return_id: "", lost_post_id: "post-3" }],
      error: null,
    });
    await expect(listMyRecoveries()).resolves.toEqual([]);
  });

  it("carries a refusal rather than showing an empty history", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "Not authenticated", code: "28000" } });
    await expect(listMyRecoveries()).rejects.toMatchObject({ status: 401, code: "28000" });
  });
});

describe("rating the other participant", () => {
  it("names the recovery and the score and nothing else", async () => {
    clientMock.rpc.mockResolvedValue({ data: "rating-1", error: null });

    await expect(rateReturn({ returnId: "  ret-1  ", score: 4 })).resolves.toBe("rating-1");

    expect(lastCall("findback_rate_return")).toEqual({ p_return_id: "ret-1", p_score: 4 });
    // There is no rated-user parameter to fill: the server derives the
    // counterpart, so a rating can never name a target.
    expect(Object.keys(lastCall("findback_rate_return"))).toEqual(["p_return_id", "p_score"]);
  });

  it("refuses a score outside the server's 1–5 range", async () => {
    for (const score of [0, 6, 2.5, Number.NaN]) {
      await expect(rateReturn({ returnId: "ret-1", score })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_SCORE",
      });
    }
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("refuses a rating of yourself, exactly as the server refuses one", async () => {
    await expect(
      rateReturn({ returnId: "ret-1", score: 5, recovery: RECOVERY, selfUserId: "user-2" }),
    ).rejects.toMatchObject({ status: 400, code: "SELF_RATING" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("refuses a recovery with no FindBack counterpart to rate", async () => {
    await expect(
      rateReturn({
        returnId: "ret-2",
        score: 5,
        recovery: { ...RECOVERY, returnId: "ret-2", counterpartUserId: null, externalHelper: true },
        selfUserId: "user-1",
      }),
    ).rejects.toMatchObject({ status: 400, code: "NO_COUNTERPART" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("surfaces the server's own refusals instead of guessing them", async () => {
    const cases: Array<[string, number]> = [
      ["23505", 409],
      ["42501", 403],
      ["P0002", 404],
      ["22023", 400],
    ];
    for (const [code, status] of cases) {
      clientMock.rpc.mockResolvedValue({ data: null, error: { message: "refused", code } });
      await expect(rateReturn({ returnId: "ret-1", score: 5 })).rejects.toMatchObject({ status, code });
    }
  });

  it("keeps the server's words on a refusal", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "You have already rated this recovery", code: "23505" },
    });
    await expect(rateReturn({ returnId: "ret-1", score: 5 })).rejects.toMatchObject({
      status: 409,
      code: "23505",
      message: "You have already rated this recovery",
    });
  });

  it("hints at the rating that is still possible, without authorizing it", () => {
    expect(canRateReturn(RECOVERY)).toBe(true);
    expect(canRateReturn({ ...RECOVERY, myRating: 5 })).toBe(false);
    expect(canRateReturn({ ...RECOVERY, counterpartUserId: null })).toBe(false);
  });
});

describe("reading a recovery's ratings", () => {
  it("returns the rows as the server assembles them", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        { rater_user_id: "user-1", rated_user_id: "user-2", score: 5, created_at: "2026-10-22T10:00:00.000Z" },
        { rater_user_id: "user-2", rated_user_id: "user-1", score: 4, created_at: "2026-10-22T11:00:00.000Z" },
      ],
      error: null,
    });

    await expect(listReturnRatings("ret-1")).resolves.toEqual([
      { raterUserId: "user-1", ratedUserId: "user-2", score: 5, createdAt: "2026-10-22T10:00:00.000Z" },
      { raterUserId: "user-2", ratedUserId: "user-1", score: 4, createdAt: "2026-10-22T11:00:00.000Z" },
    ]);
    expect(lastCall("findback_return_ratings")).toEqual({ p_return_id: "ret-1" });
  });

  it("computes no average and no total of its own", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        { rater_user_id: "user-1", rated_user_id: "user-2", score: 5, created_at: "2026-10-22T10:00:00.000Z" },
        { rater_user_id: "user-2", rated_user_id: "user-1", score: 4, created_at: "2026-10-22T11:00:00.000Z" },
      ],
      error: null,
    });

    const ratings = await listReturnRatings("ret-1");
    expect(ratings).toHaveLength(2);
    // The only average that exists is the server's own derivation inside
    // findback_reputation_tier(); a second one on the phone would drift.
    for (const rating of ratings) {
      expect(Object.keys(rating).sort()).toEqual(["createdAt", "ratedUserId", "raterUserId", "score"]);
    }
  });

  it("drops a row with no score rather than showing a rating without one", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ rater_user_id: "user-1", rated_user_id: "user-2", created_at: "2026-10-22T10:00:00.000Z" }],
      error: null,
    });
    await expect(listReturnRatings("ret-1")).resolves.toEqual([]);
  });

  it("carries a refusal rather than showing no ratings", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Only the people in this recovery can read its ratings", code: "42501" },
    });
    await expect(listReturnRatings("ret-1")).rejects.toMatchObject({
      status: 403,
      code: "42501",
      message: "Only the people in this recovery can read its ratings",
    });
  });
});

describe("standing", () => {
  it("asks for the caller's own standing, with no argument", async () => {
    clientMock.rpc.mockResolvedValue({ data: "GOOD", error: null });
    await expect(fetchStanding()).resolves.toBe("GOOD");
    expect(lastCall("findback_standing")).toEqual({});
  });

  it("carries the server's refusal to talk about somebody else", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Standing is visible only to the account it describes", code: "42501" },
    });
    await expect(fetchStanding()).rejects.toMatchObject({
      status: 403,
      code: "42501",
      message: "Standing is visible only to the account it describes",
    });
  });

  it("refuses to guess a standing the app does not know", async () => {
    clientMock.rpc.mockResolvedValue({ data: "SOMETHING", error: null });
    await expect(fetchStanding()).rejects.toMatchObject({ status: 500, code: "UNEXPECTED_SHAPE" });
  });
});

describe("reputation", () => {
  it("asks the server for the tier of the named account", async () => {
    clientMock.rpc.mockResolvedValue({ data: "TRUSTED", error: null });
    await expect(fetchReputationTier("  user-1  ")).resolves.toBe("TRUSTED");
    expect(lastCall("findback_reputation_tier")).toEqual({ p_user: "user-1" });
  });

  it("never caches the tier: every call asks the server again", async () => {
    clientMock.rpc.mockResolvedValue({ data: "NORMAL", error: null });

    await fetchReputationTier("user-1");
    await fetchReputationTier("user-1");

    expect(clientMock.rpc.mock.calls.filter((entry) => entry[0] === "findback_reputation_tier")).toHaveLength(2);
  });

  it("exports no local score, average or cache of its own", () => {
    const suspicious = Object.keys(trust).filter((name) => /average|avg|score|cache|memo|reputation_?score/i.test(name));
    expect(suspicious).toEqual([]);
  });

  it("refuses to guess a tier the app does not know", async () => {
    clientMock.rpc.mockResolvedValue({ data: "LEGENDARY", error: null });
    await expect(fetchReputationTier("user-1")).rejects.toMatchObject({
      status: 500,
      code: "UNEXPECTED_SHAPE",
    });
  });

  it("refuses a missing account without a round trip", async () => {
    await expect(fetchReputationTier("   ")).rejects.toMatchObject({ status: 400, code: "MISSING_USER_ID" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });
});

describe("the interaction limits", () => {
  it("reads the limit the server enforces", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ limit_per_day: 10, burst_cooldown_seconds: 60 }],
      error: null,
    });

    await expect(fetchPostLimit()).resolves.toEqual({ limitPerDay: 10, burstCooldownSeconds: 60 });
    expect(lastCall("findback_post_limit")).toEqual({});
  });

  it("reads the base number and the derived limit together", async () => {
    clientMock.rpc.mockImplementation(async (name: string) => {
      if (name === "findback_base_interaction_limit") return { data: 5, error: null };
      return { data: [{ limit_per_day: 10, burst_cooldown_seconds: 60 }], error: null };
    });

    await expect(fetchInteractionLimits()).resolves.toEqual({
      baseLimitPerDay: 5,
      limitPerDay: 10,
      burstCooldownSeconds: 60,
    });
  });

  it("does not answer a missing limit with a zero the server never gave", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    await expect(fetchPostLimit()).rejects.toMatchObject({ status: 500, code: "UNEXPECTED_SHAPE" });
  });

  it("recognises the guard's own refusals on a write", async () => {
    const { ApiError } = await import("./session");
    expect(isInteractionLimitRefusal(new ApiError("POST_LIMIT_REACHED: you have reached today's limit of 5", 429, "P0001"))).toBe(true);
    expect(isInteractionLimitRefusal(new ApiError("POST_COOLDOWN: wait 90 seconds before posting again", 429, "P0001"))).toBe(true);
    expect(isInteractionLimitRefusal(new ApiError("FEEDBACK_LIMIT_REACHED: you have reached today's feedback limit", 429, "P0001"))).toBe(false);
    expect(isInteractionLimitRefusal(new Error("POST_LIMIT_REACHED"))).toBe(false);
  });
});

describe("the sanction kind", () => {
  it("is answered as unavailable, because the server grants it to nobody", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "permission denied for function findback_active_sanction_kind", code: "42501" },
    });

    await expect(fetchActiveSanctionKind("user-1")).rejects.toMatchObject({
      status: 501,
      code: trust.TRUST_UNAVAILABLE_CODE,
    });
  });

  it("is answered as unavailable when the function is not there at all", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Could not find the function in the schema cache", code: "PGRST202" },
    });

    await expect(fetchActiveSanctionKind("user-1")).rejects.toMatchObject({
      status: 501,
      code: trust.TRUST_UNAVAILABLE_CODE,
    });
  });

  it("reports no kind when the server ever grants it and there is none", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    await expect(fetchActiveSanctionKind("user-1")).resolves.toBeNull();
  });
});

describe("the unavailable outcome", () => {
  it("is typed, so a screen can tell it from an empty answer", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Could not find the function public.findback_my_recoveries in the schema cache", code: "PGRST202" },
    });

    const error = await listMyRecoveries().catch((caught: unknown) => caught);
    expect(isTrustUnavailable(error)).toBe(true);
    expect(error).toMatchObject({ status: 501, code: trust.TRUST_UNAVAILABLE_CODE });
    // The server's schema jargon never reaches the reader.
    expect((error as Error).message).not.toContain("schema cache");
  });

  it("never answers an absent RPC with a fake empty list", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Could not find the function in the schema cache", code: "PGRST202" },
    });

    await expect(listMyRecoveries()).rejects.toMatchObject({ code: trust.TRUST_UNAVAILABLE_CODE });
    await expect(fetchStanding()).rejects.toMatchObject({ code: trust.TRUST_UNAVAILABLE_CODE });
  });

  it("never answers an unreachable server with a fake value", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "TypeError: Failed to fetch" } });

    await expect(listMyRecoveries()).rejects.toMatchObject({ status: 503, code: "SERVICE_UNREACHABLE" });
    await expect(fetchPostLimit()).rejects.toMatchObject({ status: 503, code: "SERVICE_UNREACHABLE" });
  });

  it("does not mistake a plain refusal for an unavailable build", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "Not authenticated", code: "28000" } });

    const error = await fetchStanding().catch((caught: unknown) => caught);
    expect(isTrustUnavailable(error)).toBe(false);
    expect(error).toMatchObject({ status: 401, code: "28000" });
  });
});
