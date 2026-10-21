// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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
});
