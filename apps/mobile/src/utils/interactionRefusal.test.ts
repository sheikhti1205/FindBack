import { describe, expect, it } from "vitest";
import { ApiError } from "../services/session";
import {
  INTERACTION_LIMIT_REFUSALS,
  interactionRefusalCopy,
  interactionRefusalWord,
  isInteractionLimitRefusal,
  refusalStatus,
  isStandingRefusal,
  isStandingRefusalMessage,
  refusalWordIn,
} from "./interactionRefusal";

/**
 * The guard's refusal vocabulary is a contract, not a string search: the word is
 * the protocol, the sentence behind it is not written for readers, and the
 * standing word means something different from the two waits.
 */
describe("the interaction-limit refusal vocabulary", () => {
  it("names the guard's three words, in the order the guard can raise them", () => {
    expect(INTERACTION_LIMIT_REFUSALS).toEqual([
      "POST_LIMIT_REACHED",
      "POST_COOLDOWN",
      "POST_NOT_AVAILABLE",
    ]);
  });

  it("reads the word out of a typed refusal, and out of nothing else", () => {
    expect(interactionRefusalWord(new ApiError("POST_LIMIT_REACHED: today's limit is 5", 429, "P0001")))
      .toBe("POST_LIMIT_REACHED");
    expect(interactionRefusalWord(new ApiError("POST_NOT_AVAILABLE: not now", 403, "P0001")))
      .toBe("POST_NOT_AVAILABLE");
    // A bare Error whose text happens to contain the word is not the server
    // refusing a write, and neither is a non-guard refusal that merely rhymes.
    expect(interactionRefusalWord(new Error("POST_LIMIT_REACHED"))).toBeNull();
    expect(interactionRefusalWord(new ApiError("FEEDBACK_LIMIT_REACHED: feedback limit", 429, "P0001")))
      .toBeNull();
    expect(interactionRefusalWord(new ApiError("Post not found", 404, "P0002"))).toBeNull();
    expect(interactionRefusalWord(null)).toBeNull();
  });

  it("does not classify a message that merely mentions the word (N-6)", () => {
    // The word is a leading token the server raises, not a substring. Otherwise a
    // field echo could make an ordinary validation error claim the account is barred.
    expect(refusalWordIn("p_clear_fields: POST_LIMIT_REACHED")).toBeNull();
    expect(refusalWordIn("Invalid category: POST_COOLDOWN")).toBeNull();
    expect(refusalWordIn("  POST_LIMIT_REACHED: spent  ")).toBe("POST_LIMIT_REACHED");
    expect(refusalWordIn("POST_COOLDOWN")).toBe("POST_COOLDOWN");
  });

  it("reads the word from an already-unwrapped message, for the status mappers", () => {
    expect(refusalWordIn("POST_COOLDOWN: wait 90 seconds before posting again")).toBe("POST_COOLDOWN");
    expect(refusalWordIn("something else entirely")).toBeNull();
  });

  it("treats a zero limit as standing and the other two as waits", () => {
    const standing = new ApiError("POST_NOT_AVAILABLE: your account cannot post or comment right now", 403, "P0001");
    const ceiling = new ApiError("POST_LIMIT_REACHED: today's limit is 5", 429, "P0001");
    const cooldown = new ApiError("POST_COOLDOWN: wait 90 seconds", 429, "P0001");

    expect(isStandingRefusal(standing)).toBe(true);
    expect(isStandingRefusal(ceiling)).toBe(false);
    expect(isStandingRefusal(cooldown)).toBe(false);
    expect(isStandingRefusalMessage("POST_NOT_AVAILABLE: not now")).toBe(true);
    expect(isStandingRefusalMessage("POST_LIMIT_REACHED: spent")).toBe(false);
    // The standing word is still a guard refusal — it is the zero-limit case, not
    // a fourth kind of error.
    expect(isInteractionLimitRefusal(standing)).toBe(true);
  });

  it("gives each word its own reader sentence, and never the token or a futile retry", () => {
    const copies = INTERACTION_LIMIT_REFUSALS.map((word) =>
      interactionRefusalCopy(new ApiError(`${word}: server sentence`, 400, "P0001")),
    );
    for (const copy of copies) {
      expect(copy).toBeTruthy();
      // The protocol token never reaches a screen.
      expect(copy).not.toMatch(/POST_/);
      // Nor does the server's own sentence, which is where the token lives.
      expect(copy).not.toMatch(/server sentence/);
    }
    // Three words, three different sentences — a shared sentence is how the two
    // causes became indistinguishable in the first place.
    expect(new Set(copies).size).toBe(INTERACTION_LIMIT_REFUSALS.length);

    // A zero limit cannot be fixed today, so its sentence never invites a retry.
    const standing = interactionRefusalCopy(
      new ApiError("POST_NOT_AVAILABLE: your account cannot post or comment right now", 403, "P0001"),
    );
    expect(standing).toBe("Your account can't post or reply right now.");
    expect(standing).not.toMatch(/try again|tomorrow/i);

    // A spent day is not a transport failure either: it says what the wait is.
    expect(interactionRefusalCopy(new ApiError("POST_LIMIT_REACHED: x", 429, "P0001")))
      .toBe("You've reached your limit for today. Come back tomorrow.");
    // The 30-second clock is the one refusal a retry genuinely answers.
    expect(interactionRefusalCopy(new ApiError("POST_COOLDOWN: x", 429, "P0001")))
      .toBe("You're posting too quickly. Wait a moment, then try again.");
  });

  it("classifies the words in one place, so every service answers the same status", () => {
    // The standing word is a fact about the account, not a quota.
    expect(refusalStatus("POST_NOT_AVAILABLE: not now")).toBe(403);
    expect(refusalStatus("POST_LIMIT_REACHED: spent")).toBe(429);
    expect(refusalStatus("POST_COOLDOWN: wait")).toBe(429);
    expect(refusalStatus("Post not found")).toBeNull();
    expect(refusalStatus("")).toBeNull();
  });

  it("answers null for everything that is not a guard refusal, so callers keep their own copy", () => {
    expect(interactionRefusalCopy(new Error("offline"))).toBeNull();
    expect(interactionRefusalCopy(new ApiError("Post not found", 404, "P0002"))).toBeNull();
    expect(interactionRefusalCopy(undefined)).toBeNull();
  });
});
