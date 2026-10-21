// @vitest-environment jsdom
/**
 * §11 / CF-040 F6: the sentence a person reads when a strictly-local helper
 * returns nothing must be a statement about the *device*, never a verdict on
 * the text they wrote. Both surfaces that ask (Smart Search, the report form's
 * "fill missing details") share these maps, so they can never tell different
 * stories about the same device.
 *
 * SMART SEARCH ALSO SEARCHES. Ordinary search never depends on the helper, so
 * every Smart Search sentence has to say what happened to the READER'S WORDS.
 * A sentence that implied the search did nothing would be a lie about the app.
 */
import { describe, expect, it } from "vitest";
import { DEVICE_INCOMPATIBLE_REASON } from "../services/ai/applicationAi";
import type { NlHelperState } from "../services/liveNarrowTasks";
import {
  NL_EMPTY_PATCH_NOTE,
  NL_SEARCH_FAILED_NOTE,
  NL_SEARCH_FILTERS_CHANGED_NOTE,
  NL_SEARCH_INVALID_DATE_NOTE,
  NL_SUGGESTION_FAILURE_NOTE,
  nlSearchAppliedNote,
} from "./nlHelperCopy";
import { OFFLINE_NEEDS_ANDROID } from "./AiModels";

const STATES: readonly NlHelperState[] = [
  "ready",
  "not-set-up",
  "unsupported-platform",
  "unsupported-device",
  "unknown",
];

const MAPS = [NL_EMPTY_PATCH_NOTE, NL_SUGGESTION_FAILURE_NOTE];

describe("local-helper copy", () => {
  it("answers every helper state on both surfaces", () => {
    for (const notes of MAPS) {
      for (const state of STATES) {
        expect(notes[state].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("speaks the canonical device truth where no install can help", () => {
    for (const notes of MAPS) {
      expect(notes["unsupported-platform"]).toBe(OFFLINE_NEEDS_ANDROID);
      expect(notes["unsupported-device"]).toBe(DEVICE_INCOMPATIBLE_REASON);
    }
  });

  it("offers the install only where installing can change the outcome", () => {
    // The report form's fix is a link to Manage local tools.
    expect(NL_SUGGESTION_FAILURE_NOTE["not-set-up"]).toMatch(/manage local tools/i);
    // Smart Search's fix is the INLINE offer on the screen itself, so its
    // sentence names the helper instead of a place the person has to go.
    expect(NL_EMPTY_PATCH_NOTE["not-set-up"]).toMatch(/local search helper/i);
    // Neither surface may offer an install in any other state.
    for (const notes of MAPS) {
      for (const state of STATES.filter((s) => s !== "not-set-up")) {
        expect(notes[state]).not.toMatch(/manage local tools/i);
        expect(notes[state]).not.toMatch(/local search helper/i);
      }
    }
  });

  it("never blames the person's sentence for a device state", () => {
    for (const notes of MAPS) {
      for (const state of ["unsupported-platform", "unsupported-device"] as const) {
        expect(notes[state]).not.toMatch(/try adding|keep writing|nothing found/i);
      }
    }
  });

  it("never lets Smart Search imply that the search did nothing", () => {
    // Every Smart Search sentence has to say the words were searched.
    for (const state of ["ready", "unknown"] as const) {
      expect(NL_EMPTY_PATCH_NOTE[state]).toMatch(/searching your words/i);
    }
    expect(NL_EMPTY_PATCH_NOTE["not-set-up"]).toMatch(/searching your words/i);
    expect(NL_SEARCH_FAILED_NOTE).toMatch(/searching your words/i);
    expect(NL_SEARCH_FILTERS_CHANGED_NOTE).toMatch(/only your words were used/i);
    expect(NL_SEARCH_INVALID_DATE_NOTE).toMatch(/only your words were used/i);
    // The old wording ("nothing changed") is exactly the lie this guards.
    for (const sentence of [
      NL_EMPTY_PATCH_NOTE.ready,
      NL_EMPTY_PATCH_NOTE.unknown,
      NL_SEARCH_FAILED_NOTE,
      NL_SEARCH_FILTERS_CHANGED_NOTE,
      NL_SEARCH_INVALID_DATE_NOTE,
    ]) {
      expect(sentence).not.toMatch(/nothing changed/i);
    }
  });

  it("counts the filters it actually applied", () => {
    expect(nlSearchAppliedNote(1)).toMatch(/applied 1 smart filter\b/i);
    expect(nlSearchAppliedNote(2)).toMatch(/applied 2 smart filters\b/i);
    expect(nlSearchAppliedNote(0)).toMatch(/applied 0 smart filters\b/i);
  });
});
