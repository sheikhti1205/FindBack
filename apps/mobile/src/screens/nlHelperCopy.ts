/**
 * What the on-device helper's silence means, per device state (CF-040 F6).
 *
 * One home for the sentence a person reads when a local helper returns nothing.
 * Two surfaces ask the same question — Smart Search ("no confident filters") and
 * the report form's "fill missing details" (§11) — and if they each kept their
 * own copy they could tell different stories about the same device.
 *
 * Only `not-set-up` may offer an action, because only there can installing
 * change the outcome: a build without the runtime, or a device that cannot run
 * it, is a terminal answer, and promising an install would be the same defect in
 * reverse. `ready` and `unknown` make no claim about the device at all — the
 * helper ran (or may have) and simply had nothing to offer.
 */
import { DEVICE_INCOMPATIBLE_REASON } from "../services/ai/applicationAi";
import type { NlHelperState } from "../services/liveNarrowTasks";
import { OFFLINE_NEEDS_ANDROID } from "./AiModels";

/** Smart Search's not-set-up sentence: it names the one action that fixes it. */
const NL_HELPER_NOT_SET_UP_NOTE =
  "Smart Search needs the on-device model, which isn't set up on this device yet — open Manage local tools to install it.";

/**
 * The report form's not-set-up sentence. Separate wording because the failing
 * action is a different one — a person who asked for report suggestions is not
 * owed a sentence about search filters.
 */
const SUGGESTION_NOT_SET_UP_NOTE =
  "Fill missing details needs the on-device model, which isn't set up on this device yet — open Manage local tools to install it.";

const SEARCH_EMPTY_NOTE = "No confident filters found — nothing changed.";
/**
 * The report helper's own default. Neither cause can be claimed: the op collapses
 * every non-abort failure to one error class, so "nothing to suggest" and "the
 * op broke" arrive identically. Naming no cause is the only honest thing left,
 * and it never blames the sentence the person wrote.
 */
const SUGGESTION_FAILED_NOTE = "Couldn't get a suggestion this time — try again, or keep writing.";

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
