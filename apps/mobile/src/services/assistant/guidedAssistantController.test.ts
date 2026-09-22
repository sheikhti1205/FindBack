import { describe, expect, it } from "vitest";
import { RECOVERY_COPY } from "../ai/errors";
import { ACTIONS, makeAiError } from "../ai/types";
import {
  GUIDED_FLOWS,
  GUIDED_RECOVERY_CLASSES,
  allowedActions,
  applyReportFields,
  applySearchFields,
  chooseLocation,
  choosePhoto,
  failWith,
  flowForIntent,
  intentForFlow,
  nextMissingQuestion,
  retryAfterRecovery,
  snapshotForIntent,
  startFlow,
  type ConversationState,
  type GuidedFlow,
} from "./guidedAssistantController";

const STATES: readonly ConversationState[] = [
  "idle",
  "collecting",
  "awaitingPhoto",
  "awaitingLocation",
  "ready",
  "recovering",
];

describe("intent ownership", () => {
  it("starts each flow with its contract intent", () => {
    expect(startFlow("lost").intent).toBe("REPORT_LOST");
    expect(startFlow("found").intent).toBe("REPORT_FOUND");
    expect(startFlow("search").intent).toBe("SEARCH");
    expect(startFlow("ask").intent).toBe("OPEN_QUESTION");
  });

  it("maps every contract intent to a flow", () => {
    expect(flowForIntent("REPORT_LOST")).toBe("lost");
    expect(flowForIntent("REPORT_FOUND")).toBe("found");
    expect(flowForIntent("SEARCH")).toBe("search");
    expect(flowForIntent("APP_QUESTION")).toBe("ask");
    expect(flowForIntent("OPEN_QUESTION")).toBe("ask");
    expect(flowForIntent("UNKNOWN")).toBe("ask");
    expect(snapshotForIntent("UNKNOWN").flow).toBe("ask");
  });

  it("round-trips flow to intent", () => {
    expect(intentForFlow("lost")).toBe("REPORT_LOST");
    expect(intentForFlow("found")).toBe("REPORT_FOUND");
    expect(intentForFlow("search")).toBe("SEARCH");
    expect(intentForFlow("ask")).toBe("OPEN_QUESTION");
  });
});

describe("missing fields and collection", () => {
  it("starts a lost report missing category, date, location, and photo", () => {
    const snapshot = startFlow("lost");
    expect(snapshot.state).toBe("collecting");
    expect(snapshot.missingFields).toEqual(["category", "date", "location", "photo"]);
    expect(snapshot.allowedActions).toEqual(["ASK_USER"]);
  });

  it("starts a search missing only the query", () => {
    const snapshot = startFlow("search");
    expect(snapshot.missingFields).toEqual(["query"]);
  });

  it("collects report slots until only the photo step remains", () => {
    let snapshot = startFlow("lost");
    snapshot = applyReportFields(snapshot, { category: "Keys" });
    expect(snapshot.missingFields).toContain("date");
    expect(snapshot.state).toBe("collecting");
    snapshot = applyReportFields(snapshot, { dateText: "2026-09-01" });
    snapshot = applyReportFields(snapshot, { locationNote: "Central library" });
    expect(snapshot.state).toBe("awaitingPhoto");
    expect(snapshot.missingFields).toEqual(["photo"]);
    expect(snapshot.photoRequest?.choices).toEqual(["take", "choose", "none"]);
    expect(snapshot.allowedActions).toEqual(["PICK_PHOTO", "TAKE_PHOTO"]);
  });

  it("keeps invalid category and date as missing", () => {
    const snapshot = applyReportFields(startFlow("found"), {
      category: "Spaceship",
      dateText: "someday",
    });
    expect(snapshot.missingFields).toContain("category");
    expect(snapshot.missingFields).toContain("date");
    expect(snapshot.patch.category).toBeUndefined();
    expect(snapshot.patch.eventDate).toBeUndefined();
  });
});

describe("photo and location seams", () => {
  function collectedToPhoto(): ReturnType<typeof startFlow> {
    let snapshot = startFlow("lost");
    snapshot = applyReportFields(snapshot, {
      category: "Keys",
      dateText: "2026-09-01",
      locationNote: "Central library",
    });
    return snapshot;
  }

  it("records the photo choice and requests a location choice", () => {
    const snapshot = choosePhoto(collectedToPhoto(), "take");
    expect(snapshot.photoChoice).toBe("take");
    expect(snapshot.state).toBe("awaitingLocation");
    expect(snapshot.locationRequest?.choices).toEqual(["map", "current", "typed", "skip"]);
    expect(snapshot.allowedActions).toEqual(["OPEN_MAP"]);
  });

  it("skipping location resolves without inferring a note", () => {
    const snapshot = chooseLocation(choosePhoto(collectedToPhoto(), "none"), "skip");
    expect(snapshot.state).toBe("ready");
    expect(snapshot.locationChoice).toBe("skip");
    expect(snapshot.patch.locationNote).toBe("Central library");
    expect(snapshot.allowedActions).toEqual(["APPLY_REPORT_DRAFT"]);
  });

  it("map and current choices never invent a location note", () => {
    let snapshot = startFlow("found");
    snapshot = applyReportFields(snapshot, { category: "Keys", dateText: "2026-09-01" });
    snapshot = choosePhoto(snapshot, "choose");
    snapshot = chooseLocation(snapshot, "map");
    expect(snapshot.state).toBe("ready");
    expect(snapshot.patch.locationNote).toBeUndefined();
    const current = chooseLocation(choosePhoto(snapshot, "choose"), "current");
    expect(current.patch.locationNote).toBeUndefined();
  });

  it("typed choice carries only the explicitly typed note", () => {
    let snapshot = startFlow("found");
    snapshot = applyReportFields(snapshot, { category: "Keys", dateText: "2026-09-01" });
    snapshot = choosePhoto(snapshot, "none");
    snapshot = chooseLocation(snapshot, "typed", "North gate bench");
    expect(snapshot.state).toBe("ready");
    expect(snapshot.patch.locationNote).toBe("North gate bench");
  });

  it("collects a search query into a ready search", () => {
    let snapshot = applySearchFields(startFlow("search"), {});
    expect(snapshot.state).toBe("collecting");
    snapshot = applySearchFields(snapshot, { query: "black umbrella" });
    expect(snapshot.state).toBe("ready");
    expect(snapshot.allowedActions).toEqual(["OPEN_SEARCH"]);
    expect(snapshot.searchFilters?.query).toBe("black umbrella");
  });
});

describe("recovery", () => {
  it("covers every guided recovery class with frozen copy", () => {
    expect(GUIDED_RECOVERY_CLASSES).toEqual([
      "LOOP_DETECTED",
      "TIMEOUT",
      "LOW_MEMORY",
      "INVALID_OUTPUT",
      "MODEL_UNAVAILABLE",
      "MODEL_CORRUPT",
      "UNSUPPORTED_REQUEST",
    ]);
    for (const errorClass of GUIDED_RECOVERY_CLASSES) {
      const snapshot = failWith(startFlow("lost"), makeAiError(errorClass, "TEST_DIAG"));
      expect(snapshot.state).toBe("recovering");
      expect(snapshot.allowedActions).toEqual([]);
      expect(snapshot.recovery?.message).toBe(RECOVERY_COPY[errorClass].message);
      expect(snapshot.recovery?.actions).toEqual([...RECOVERY_COPY[errorClass].actions]);
      expect(snapshot.recovery?.diagnostic).toBe("TEST_DIAG");
    }
  });

  it("retries back into the interrupted state", () => {
    let snapshot = startFlow("lost");
    snapshot = applyReportFields(snapshot, {
      category: "Keys",
      dateText: "2026-09-01",
      locationNote: "Central library",
    });
    snapshot = choosePhoto(snapshot, "take");
    snapshot = failWith(snapshot, makeAiError("TIMEOUT", "GUARD_TIMEOUT"));
    expect(snapshot.state).toBe("recovering");
    snapshot = retryAfterRecovery(snapshot);
    expect(snapshot.state).toBe("awaitingLocation");
    expect(snapshot.recovery).toBeUndefined();
    expect(snapshot.locationRequest?.choices).toContain("skip");
  });

  it("ignores field updates while recovering", () => {
    const failed = failWith(startFlow("lost"), makeAiError("TIMEOUT", "T"));
    expect(applyReportFields(failed, { category: "Keys" })).toBe(failed);
    expect(choosePhoto(failed, "none")).toBe(failed);
    expect(chooseLocation(failed, "skip")).toBe(failed);
  });
});

describe("questions and allowed actions", () => {
  it("asks for the first missing field", () => {
    const question = nextMissingQuestion(startFlow("lost"));
    expect(question?.field).toBe("category");
    expect(question?.question.length).toBeGreaterThan(0);
  });

  it("has no question once the draft is ready", () => {
    let snapshot = startFlow("search");
    snapshot = applySearchFields(snapshot, { query: "umbrella" });
    expect(nextMissingQuestion(snapshot)).toBeNull();
  });

  it("keeps every allowed action inside the contract allowlist", () => {
    const flows: readonly GuidedFlow[] = GUIDED_FLOWS;
    for (const flow of flows) {
      for (const state of STATES) {
        for (const action of allowedActions(flow, state)) {
          expect((ACTIONS as readonly string[])).toContain(action);
        }
      }
    }
  });
});
