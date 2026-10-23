import { describe, expect, it } from "vitest";
import {
  MODERATION_ACTION_HINTS,
  MODERATION_ACTION_LABELS,
  RATING_REFUSAL_SENTENCES,
  REPORT_REASON_HINTS,
  REPORT_REASON_LABELS,
  REPORT_STATUS_LABELS,
  REPORT_TARGET_LABELS,
  REPUTATION_TIER_SENTENCES,
  STANDING_SENTENCES,
  formatSafetyDate,
} from "./safetyCopy";
import {
  MODERATION_ACTIONS,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from "../services/moderation";
import { REPUTATION_TIERS, STANDINGS } from "../services/trust";

describe("the safety copy", () => {
  it("names every reason, every status and every action", () => {
    for (const reason of REPORT_REASONS) {
      expect(REPORT_REASON_LABELS[reason]).toBeTruthy();
      expect(REPORT_REASON_HINTS[reason]).toBeTruthy();
    }
    for (const status of REPORT_STATUSES) {
      expect(REPORT_STATUS_LABELS[status]).toBeTruthy();
    }
    for (const action of MODERATION_ACTIONS) {
      expect(MODERATION_ACTION_LABELS[action]).toBeTruthy();
      expect(MODERATION_ACTION_HINTS[action]).toBeTruthy();
    }
    for (const target of REPORT_TARGET_TYPES) {
      expect(REPORT_TARGET_LABELS[target]).toBeTruthy();
    }
  });

  it("never prints a database word as its own label", () => {
    for (const reason of REPORT_REASONS) {
      expect(REPORT_REASON_LABELS[reason]).not.toBe(reason);
      expect(REPORT_REASON_LABELS[reason]).not.toContain("_");
    }
    for (const action of MODERATION_ACTIONS) {
      expect(MODERATION_ACTION_LABELS[action]).not.toBe(action);
      expect(MODERATION_ACTION_LABELS[action]).not.toContain("_");
    }
    for (const status of REPORT_STATUSES) {
      expect(REPORT_STATUS_LABELS[status]).not.toBe(status);
    }
  });

  it("calls a member a person, never a user", () => {
    expect(REPORT_TARGET_LABELS.USER).toBe("person");
  });

  it("says no date at all when the date is unreadable", () => {
    expect(formatSafetyDate("not a date")).toBe("");
    expect(formatSafetyDate(null)).toBe("");
    expect(formatSafetyDate("")).toBe("");
    expect(formatSafetyDate("2026-10-22T10:00:00.000Z")).toBeTruthy();
  });

  it("says the standing and the reputation as a whole sentence", () => {
    for (const standing of STANDINGS) {
      expect(STANDING_SENTENCES[standing]).toBeTruthy();
      expect(STANDING_SENTENCES[standing].endsWith(".")).toBe(true);
    }
    for (const tier of REPUTATION_TIERS) {
      expect(REPUTATION_TIER_SENTENCES[tier]).toBeTruthy();
      expect(REPUTATION_TIER_SENTENCES[tier].endsWith(".")).toBe(true);
    }
    expect(REPUTATION_TIER_SENTENCES.NORMAL).toBe("You are an established member.");
  });

  it("phrases a refusal without leaking the server's code", () => {
    for (const sentence of Object.values(RATING_REFUSAL_SENTENCES)) {
      expect(sentence).toBeTruthy();
      expect(sentence).not.toMatch(/23505|22023|42501|rpc|postgres/i);
    }
  });
});
