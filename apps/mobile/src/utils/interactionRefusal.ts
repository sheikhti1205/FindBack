/**
 * The interaction-limit guard's refusal vocabulary, owned in one place.
 *
 * The guard (`findback_enforce_interaction_limit`) is a BEFORE INSERT trigger on
 * `item_posts` and `comments`; when it refuses a write it raises `P0001` with a
 * stable word in front of its sentence. The **word is the protocol**; the
 * sentence is not written for readers, so it must never be shown as-is (it
 * carries the token: `POST_NOT_AVAILABLE: your account cannot post …`).
 *
 * The three words mean three different things, and two of them are not the same
 * kind of refusal:
 *
 *   `POST_NOT_AVAILABLE`  the account cannot write at all right now — suspended,
 *                         restricted, or a zero self-derived limit. A **standing**
 *                         fact: nothing the reader does today changes it, so no
 *                         surface may answer it with "try again".
 *   `POST_LIMIT_REACHED`  today's allowance is spent. A wait, and a long one.
 *   `POST_COOLDOWN`       the 30 s spacing is still running. A wait, and a short one.
 *
 * `services/trust.ts` re-exports the vocabulary so existing callers keep their
 * import path, and every reader-facing surface goes through
 * `interactionRefusalCopy()` rather than inventing a fourth sentence.
 */
import { ApiError } from "../services/session";

/** Every word the guard can put in front of a `P0001` refusal. */
export const INTERACTION_LIMIT_REFUSALS = [
  "POST_LIMIT_REACHED",
  "POST_COOLDOWN",
  "POST_NOT_AVAILABLE",
] as const;

export type InteractionLimitRefusal = (typeof INTERACTION_LIMIT_REFUSALS)[number];

/**
 * The zero-limit word. A standing refusal is the one case that must never be
 * presented as a retry, so it gets its own name rather than a comment.
 */
export const STANDING_REFUSALS: readonly InteractionLimitRefusal[] = ["POST_NOT_AVAILABLE"];

/**
 * Which refusal word this message carries, or `null`. Message-level, because
 * the status mappers classify a row they have already unwrapped.
 *
 * The word is a **prefix token**, not a substring: the server raises
 * `WORD: sentence`, or the bare `WORD`. A substring test would also match a
 * sentence that merely mentions the word (delta-close N-6: a crafted field echo
 * such as `p_clear_fields: POST_LIMIT_REACHED` is not the guard refusing), and
 * the classification decides whether a screen tells someone their account
 * cannot write — so it must not be triggerable by text the server did not raise.
 */
export function refusalWordIn(message: string): InteractionLimitRefusal | null {
  const head = message.trimStart().split(":")[0]?.trim();
  if (!head) return null;
  return (INTERACTION_LIMIT_REFUSALS as readonly string[]).includes(head)
    ? (head as InteractionLimitRefusal)
    : null;
}

/**
 * Which refusal word this error carries, or `null` when it is not a guard
 * refusal. Only an `ApiError` counts: a bare `Error` whose text happens to
 * contain the word is not the server refusing a write (the check is on the
 * typed error, not on a string search of anything thrown).
 */
export function interactionRefusalWord(error: unknown): InteractionLimitRefusal | null {
  if (!(error instanceof ApiError)) return null;
  return refusalWordIn(error.message);
}

/** Is this error the guard refusing a write? */
export function isInteractionLimitRefusal(error: unknown): boolean {
  return interactionRefusalWord(error) !== null;
}

/** Is this message the **standing** refusal (a zero limit)? */
export function isStandingRefusalMessage(message: string): boolean {
  const word = refusalWordIn(message);
  return word !== null && STANDING_REFUSALS.includes(word);
}

/**
 * Is this the **standing** refusal (a zero limit), as opposed to a spent day or
 * the 30 s clock? A caller that treats a wait as a wait but a standing fact as a
 * fact asks this one.
 */
export function isStandingRefusal(error: unknown): boolean {
  return error instanceof ApiError && isStandingRefusalMessage(error.message);
}

/**
 * The reader-facing sentence for a guard refusal, or `null` when the error is
 * not one — so a caller can keep its own copy for everything else.
 *
 * None of these invites a retry that cannot succeed: the standing sentence
 * states the fact without a verb of trying, and the two limit sentences say what
 * the wait actually is. `friendlyError()` and the comment composer both read
 * this, which is why the raw token has no route to a screen.
 */
export function interactionRefusalCopy(error: unknown): string | null {
  switch (interactionRefusalWord(error)) {
    case "POST_NOT_AVAILABLE":
      // Verb-neutral on purpose (R-5 in the delta review): the same sentence serves
      // a new report and a comment, and "Posting isn't available" was wrong on the
      // comment composer. It states the fact and never invites a retry.
      return "Your account can't post or reply right now.";
    case "POST_LIMIT_REACHED":
      return "You've reached your limit for today. Come back tomorrow.";
    case "POST_COOLDOWN":
      return "You're posting too quickly. Wait a moment, then try again.";
    default:
      return null;
  }
}

/**
 * The HTTP status a guard refusal answers with, or `null` when the message is not
 * one. Lives here so every service mapper classifies the words the same way: the
 * standing refusal is 403 (a fact about the account), the two waits are 429.
 * Before this, the words were recognised only in `trust.ts`, whose own calls
 * cannot raise them, while the two services that *do* carry them still answered
 * 400 (delta review R-4).
 */
export function refusalStatus(message: string): number | null {
  const word = refusalWordIn(message);
  if (word === null) return null;
  return word === "POST_NOT_AVAILABLE" ? 403 : 429;
}
