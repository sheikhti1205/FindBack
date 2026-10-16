// @vitest-environment jsdom
/**
 * §11 / CF-040 F6: the sentence a person reads when a strictly-local helper
 * returns nothing must be a statement about the *device*, never a verdict on the
 * text they wrote. Both surfaces that ask (Smart Search, the report form's "fill
 * missing details") share these maps, so they can never tell different stories
 * about the same device.
 */
import { describe, expect, it } from "vitest";
import { DEVICE_INCOMPATIBLE_REASON } from "../services/ai/applicationAi";
import type { NlHelperState } from "../services/liveNarrowTasks";
import { NL_EMPTY_PATCH_NOTE, NL_SUGGESTION_FAILURE_NOTE } from "./nlHelperCopy";
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
    for (const notes of MAPS) {
      expect(notes["not-set-up"]).toMatch(/manage ai models/i);
      for (const state of STATES.filter((s) => s !== "not-set-up")) {
        expect(notes[state]).not.toMatch(/manage ai models/i);
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
});
