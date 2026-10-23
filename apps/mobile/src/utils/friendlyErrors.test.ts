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
