// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../services/session";
import { friendlyError } from "./friendlyErrors";

/**
 * The error taxonomy every consumer surface renders.
 *
 * Two rules matter most: raw server jargon never reaches a reader, and a
 * write that landed but could not be read back is never reported as a
 * failed save.
 */
describe("friendlyError", () => {
  it("keeps a landed write that could not be read back out of the generic copy", () => {
    const error = new ApiError(
      "Your report was saved, but the app could not read it back. Refresh to see it.",
      500,
      "READ_BACK_FAILED",
    );
    const friendly = friendlyError(error);
    expect(friendly.message).toMatch(/was saved/i);
    expect(friendly.message).not.toMatch(/having trouble/i);
  });

  it("uses app-owned saved copy even if the read-back error carries server text or the network drops", () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      const friendly = friendlyError(new ApiError("postgres internal relation secret", 500, "READ_BACK_FAILED"));
      expect(friendly.message).toBe("Your report was saved, but the app could not read it back. Refresh to see it.");
    } finally {
      online.mockRestore();
    }
  });

  it("turns a server fault into the server's own copy, not the server's text", () => {
    const error = new ApiError(
      "Could not find the function public.findback_update_post_client in the schema cache",
      500,
      "PGRST202",
    );
    const friendly = friendlyError(error);
    expect(friendly.code).toBe("SERVER");
    expect(friendly.message).not.toMatch(/public\.|schema cache/i);
  });

  it("shows a validation refusal as it is, without jargon", () => {
    const error = new ApiError("Invalid category", 400, "22023");
    const friendly = friendlyError(error);
    expect(friendly.code).toBe("VALIDATION");
    expect(friendly.message).toBe("Invalid category");
  });

  it("never leaks backend jargon into a reader's copy", () => {
    const error = new ApiError(
      "supabase postgrest rpc failed for jwt",
      400,
      "PGRST116",
    );
    const friendly = friendlyError(error);
    expect(friendly.message.toLowerCase()).not.toMatch(/supabase|postgrest|jwt|\brpc\b/);
  });

  it("says an absent contract is unavailable, not that the server is unwell", () => {
    const error = new ApiError("Could not find the function public.findback_mark_recovered", 501, "RPC_UNAVAILABLE");
    const friendly = friendlyError(error);
    expect(friendly.code).toBe("UNAVAILABLE");
    expect(friendly.message).toBe("This feature is not available in this build.");
    expect(friendly.message).not.toMatch(/having trouble/i);
  });

  it("keeps a refusal that names itself in its own words", () => {
    const already = friendlyError(new ApiError("You have already rated this recovery", 409, "23505"));
    expect(already.code).toBe("CONFLICT");
    expect(already.message).toBe("You have already rated this recovery");

    const limit = friendlyError(new ApiError("you have reached today's limit of 5", 409, "P0001"));
    expect(limit.code).toBe("RATE_LIMIT");
    expect(limit.message).toBe("you have reached today's limit of 5");
  });

  it("turns the guard's own refusal words into reader sentences, never tokens", () => {
    const standing = friendlyError(
      new ApiError("POST_NOT_AVAILABLE: your account cannot post or comment right now", 400, "P0001"),
    );
    expect(standing.code).toBe("PERMISSION");
    expect(standing.message).toBe("Your account can't post or reply right now.");
    // A zero limit cannot be fixed today: no retry, no "come back later" that
    // implies it can be. This is R3-delta's N-4.
    expect(standing.message).not.toMatch(/try again/i);

    const ceiling = friendlyError(
      new ApiError("POST_LIMIT_REACHED: you have reached today's limit of 5", 400, "P0001"),
    );
    expect(ceiling.code).toBe("RATE_LIMIT");
    expect(ceiling.message).toBe("You've reached your limit for today. Come back tomorrow.");

    const cooldown = friendlyError(
      new ApiError("POST_COOLDOWN: wait 90 seconds before posting again", 400, "P0001"),
    );
    expect(cooldown.code).toBe("RATE_LIMIT");
    expect(cooldown.message).toBe("You're posting too quickly. Wait a moment, then try again.");

    for (const friendly of [standing, ceiling, cooldown]) {
      // The protocol token and the server's sentence behind it never surface.
      expect(friendly.message).not.toMatch(/POST_|POST_NOT|POST_LIMIT|POST_COOLDOWN/);
    }
  });

  it("does not leak the feedback ceiling's token either", () => {
    // A different vocabulary, the same shape: a token in front of a sentence. It used
    // to reach the feedback form verbatim (delta review R-6).
    const limit = friendlyError(
      new ApiError("FEEDBACK_LIMIT_REACHED: you have reached today's feedback limit", 429, "P0001"),
    );
    expect(limit.code).toBe("RATE_LIMIT");
    expect(limit.message).toBe("You've reached today's feedback limit. Come back tomorrow.");
    expect(limit.message).not.toMatch(/FEEDBACK_LIMIT_REACHED/);
  });

  it("keeps the standing refusal's fact when a service rethrows it as 403", () => {
    const standing = friendlyError(
      new ApiError("POST_NOT_AVAILABLE: your account cannot post or comment right now", 403, "P0001"),
    );
    // Not the generic "you do not have permission to do that": the server
    // volunteered one fact and the reader gets it.
    expect(standing.message).toBe("Your account can't post or reply right now.");
  });

  it("does not echo a catalogue error carried by a 400", () => {
    // A not-null or check violation arrives with its own SQLSTATE, not 23505,
    // and used to reach the reader verbatim through the validation branch.
    const notNull = friendlyError(
      new ApiError('null value in column "title" of relation "posts" violates not-null constraint', 400, "23502"),
    );
    expect(notNull.code).toBe("VALIDATION");
    expect(notNull.message).not.toMatch(/column|relation|constraint|posts/i);
    expect(notNull.message).toBe("Check the highlighted fields and try again.");

    const unknown = friendlyError(new ApiError('relation "public.posts" does not exist', 400, "42P01"));
    expect(unknown.message).not.toMatch(/relation|public\.|does not exist/i);

    // The schema cache is the other shape a missing contract takes, and it also
    // arrives as 400 — the same leak, through the same branch.
    const schemaCache = friendlyError(
      new ApiError("Could not find the function public.private_rpc(p_conversation_id uuid) in the schema cache", 400, "PGRST202"),
    );
    expect(schemaCache.code).toBe("VALIDATION");
    expect(schemaCache.message).not.toMatch(/public\.|schema cache|private_rpc|function/i);
    expect(schemaCache.message).toBe("Check the highlighted fields and try again.");
  });

  it("keeps a sentence the server wrote for the reader", () => {
    // The catalogue filter must not eat ordinary prose that happens to use
    // similar words.
    expect(friendlyError(new ApiError("This post violates our guidelines", 400, "22023")).message)
      .toBe("This post violates our guidelines");
    expect(friendlyError(new ApiError("Title is required", 400, "22023")).message)
      .toBe("Title is required");
  });

  it("does not show a raw catalogue error as if the server had said it", () => {
    const raw = friendlyError(
      new ApiError('duplicate key value violates unique constraint "content_reports_pkey"', 409, "23505"),
    );
    expect(raw.message).not.toMatch(/constraint|duplicate key/i);
    expect(raw.message).toMatch(/conflicts with something already saved/i);
  });

  it("uses only fixed deletion domain copy, never arbitrary coded text", () => {
    expect(friendlyError(new ApiError("postgres private rpc", 409, "LAST_ADMIN_DELETION_BLOCKED")).message)
      .toBe("This is the only admin account. Promote another admin before deleting this one.");
    expect(friendlyError(new ApiError("postgres private rpc", 502, "ACCOUNT_DELETION_PENDING")).message)
      .toBe("Your account deletion is pending. Account privileges and uploads remain disabled. Try deleting your account again to finish.");
    expect(friendlyError(new ApiError("postgres private rpc", 409, "UNKNOWN")).message)
      .toBe("That conflicts with something already saved. Refresh and try again.");
  });
});
