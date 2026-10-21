/**
 * What the on-device helper's silence means, per device state (CF-040 F6).
 *
 * One home for the sentence a person reads when a local helper returns nothing.
 * Two surfaces ask the same question — Smart Search ("no extra filters") and
 * the report form's "fill missing details" (§11) — and if they each kept their
 * own copy they could tell different stories about the same device.
 *
 * Only `not-set-up` may offer an action, because only there can installing
 * change the outcome: a build without the runtime, or a device that cannot run
 * it, is a terminal answer, and promising an install would be the same defect in
 * reverse. `ready` and `unknown` make no claim about the device at all — the
 * helper ran (or may have) and simply had nothing to offer.
 *
 * SMART SEARCH ALSO SEARCHES. Ordinary search never depends on the helper, so
 * every Smart Search sentence that speaks about the SEARCH says what happened
 * to the READER'S WORDS: the words were searched even when no filter could be
 * added. A sentence that implied the search did nothing would be a lie about
 * the app. The two DEVICE TRUTHS are the deliberate exception: they say what
 * this platform or this device cannot do, and they do not repeat what happened
 * to the words.
 */
import { DEVICE_INCOMPATIBLE_REASON } from "../services/ai/applicationAi";
import type { NlHelperState } from "../services/liveNarrowTasks";
import { OFFLINE_NEEDS_ANDROID } from "./AiModels";

/**
 * Smart Search's not-set-up sentence. It names the one thing that can change
 * the outcome (the helper is not on this phone) and says that the ordinary
 * search carries on.
 */
const NL_HELPER_NOT_SET_UP_NOTE =
  "Smart Search needs the local search helper. Searching your words normally.";

/**
 * The report form's not-set-up sentence. Separate wording because the failing
 * action is a different one — a person who asked for report suggestions is not
 * owed a sentence about search filters.
 */
const SUGGESTION_NOT_SET_UP_NOTE =
  "Fill missing details needs the on-device model, which isn't set up on this device yet — open Manage local tools to install it.";

const SEARCH_EMPTY_NOTE = "No extra filters found — searching your words.";
/**
 * The report helper's own default. Neither cause can be claimed: the op collapses
 * every non-abort failure to one error class, so "nothing to suggest" and "the
 * op broke" arrive identically. Naming no cause is the only honest thing left,
 * and it never blames the sentence the person wrote.
 */
const SUGGESTION_FAILED_NOTE = "Couldn't get a suggestion this time — try again, or keep writing.";

/**
 * The extractor failed outright. The words are searched normally, so the
 * sentence says that and never blames the reader's sentence.
 */
export const NL_SEARCH_FAILED_NOTE = "Smart Search couldn't add filters — searching your words.";

/**
 * The reader changed the filters while Smart Search was working, so its
 * filters were not applied — only the words were used.
 */
export const NL_SEARCH_FILTERS_CHANGED_NOTE =
  "Your filter choices changed while Smart Search worked, so only your words were used.";

/**
 * What the extractor offered that could not become a filter.
 *
 * A date that is not a real day is not a filter, and a place that is not a
 * place NAME (a bare number, a time phrase) is not a filter either: both are
 * refused before they reach the URL, and neither is counted as applied.
 */
export type NlRefusal = "date" | "place";

const REFUSAL_COPY: Record<NlRefusal, string> = {
  date: "a date that isn't a real date",
  place: "a place that isn't a place name",
};

/**
 * The sentence for a refused value.
 *
 * It says what was refused and what was applied. "Only your words were
 * used" appears ONLY when no filter besides the reader's words was applied —
 * otherwise it would be a lie about the filters the reader now has on.
 *
 * `applied` is the count the other notes use (the words count as one);
 * `appliedBesidesWords` is what decides the "only your words" wording.
 */
export function nlSearchRefusedNote(
  refusals: readonly NlRefusal[],
  applied: number,
  appliedBesidesWords: number,
): string {
  const what = refusals.map((refusal) => REFUSAL_COPY[refusal]).join(" and ");
  if (appliedBesidesWords <= 0) return `Smart Search had ${what}, so only your words were used.`;
  const many = refusals.length > 1;
  return `Smart Search had ${what}, so ${many ? "they were" : "it was"} not used. ${nlSearchAppliedNote(applied)}`;
}

/**
 * The reader had already chosen the filter Smart Search wanted to set, so the
 * reader's own choice was kept and only the words were used.
 *
 * A filter the reader chose is their answer: Smart Search may not overrule
 * it, and it says so instead of quietly changing the search behind them.
 */
export const NL_SEARCH_FILTERS_KEPT_NOTE =
  "Your own filter choice was kept, so only your words were used.";

/** The number of filters Smart Search actually applied. */
export function nlSearchAppliedNote(count: number): string {
  return `Applied ${count} smart filter${count === 1 ? "" : "s"} — review or remove them below.`;
}

/**
 * Some filters were applied and the reader's own choice was kept for another
 * one. Both facts are in the sentence: the count of what was applied, and the
 * fact that nothing of the reader's was overruled.
 */
export function nlSearchAppliedAndKeptNote(count: number): string {
  return `Applied ${count} smart filter${count === 1 ? "" : "s"} and kept your own choice for the rest — review or remove them below.`;
}

/** Smart Search: an empty patch, per helper state. */
export const NL_EMPTY_PATCH_NOTE: Record<NlHelperState, string> = {
  ready: SEARCH_EMPTY_NOTE,
  "not-set-up": NL_HELPER_NOT_SET_UP_NOTE,
  "unsupported-platform": OFFLINE_NEEDS_ANDROID,
  "unsupported-device": DEVICE_INCOMPATIBLE_REASON,
  unknown: SEARCH_EMPTY_NOTE,
};

/**
 * The report form's "fill missing details" (§11): a failed/empty suggestion is
 * a statement about the device, not a verdict on the sentence someone wrote.
 * The device truths replace the default wherever the helper cannot run; only
 * `not-set-up` offers an install, because only there can one change the outcome.
 */
export const NL_SUGGESTION_FAILURE_NOTE: Record<NlHelperState, string> = {
  ready: SUGGESTION_FAILED_NOTE,
  "not-set-up": SUGGESTION_NOT_SET_UP_NOTE,
  "unsupported-platform": OFFLINE_NEEDS_ANDROID,
  "unsupported-device": DEVICE_INCOMPATIBLE_REASON,
  unknown: SUGGESTION_FAILED_NOTE,
};
