import { describe, expect, it } from "vitest";
import { ApiError } from "../services/session";
import { draftIsMeaningful, saveDraft, loadDraft, clearDraft } from "../services/reportDraft";
import { friendlyError } from "./friendlyErrors";

describe("friendlyError", () => {
  it("maps auth/permission/not-found codes without jargon", () => {
    expect(friendlyError(new ApiError("x", 401)).code).toBe("AUTH");
    expect(friendlyError(new ApiError("x", 403)).code).toBe("PERMISSION");
    expect(friendlyError(new ApiError("x", 404)).code).toBe("NOT_FOUND");
    expect(friendlyError(new ApiError("x", 429)).code).toBe("RATE_LIMIT");
    expect(friendlyError(new ApiError("boom", 500)).message).not.toMatch(/boom/);
  });

  it("strips Supabase/Postgres jargon", () => {
    const out = friendlyError(new ApiError("postgrest rpc jwt failed", 400));
    expect(out.message).not.toMatch(/postgrest|postgres|rpc|jwt/i);
  });
});

describe("reportDraft", () => {
  it("round-trips and detects meaningful content", () => {
    clearDraft();
    expect(loadDraft()).toBeNull();
    expect(draftIsMeaningful(null)).toBe(false);
    saveDraft({
      type: "LOST",
      title: "  ",
      description: "",
      category: "",
      eventDate: "2026-09-01",
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
    });
    expect(draftIsMeaningful(loadDraft())).toBe(false);
    const d = loadDraft()!;
    d.title = "Wallet";
    saveDraft(d);
    expect(draftIsMeaningful(loadDraft())).toBe(true);
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
});
