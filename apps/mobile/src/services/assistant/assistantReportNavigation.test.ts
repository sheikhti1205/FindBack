import { describe, expect, it, beforeEach } from "vitest";
import { applyReportFields, chooseLocation, choosePhoto, startFlow } from "./guidedAssistantController";
import { buildAssistantReportHandoff } from "./assistantHandoff";
import {
  ASSISTANT_REPORT_ROUTE,
  assistantReportNavigationTarget,
  clearStagedAssistantReportHandoff,
  peekStagedAssistantReportHandoff,
  stageAssistantReportHandoff,
  takeStagedAssistantReportHandoff,
} from "./assistantReportNavigation";

function readyHandoff() {
  let snapshot = startFlow("lost");
  snapshot = applyReportFields(snapshot, {
    title: "Keys",
    category: "Keys",
    dateText: "2026-09-01",
    locationNote: "Central library",
  });
  snapshot = choosePhoto(snapshot, "none");
  snapshot = chooseLocation(snapshot, "skip");
  return buildAssistantReportHandoff(snapshot)!;
}

beforeEach(() => {
  clearStagedAssistantReportHandoff();
});

describe("assistantReportNavigationTarget", () => {
  it("routes a versioned assistant handoff to /report", () => {
    expect(assistantReportNavigationTarget(readyHandoff())).toBe("/report");
    expect(assistantReportNavigationTarget(readyHandoff())).toBe(ASSISTANT_REPORT_ROUTE);
  });

  it("rejects unversioned or non-assistant payloads", () => {
    expect(assistantReportNavigationTarget(null)).toBeNull();
    expect(assistantReportNavigationTarget({ version: 2, source: "assistant", patch: {} })).toBeNull();
    expect(assistantReportNavigationTarget({ version: 1, source: "other", patch: {} })).toBeNull();
    expect(assistantReportNavigationTarget(startFlow("lost"))).toBeNull();
  });
});

describe("staged assistant handoff draft seam", () => {
  it("stages and consumes a versioned handoff once", () => {
    const handoff = readyHandoff();
    stageAssistantReportHandoff(handoff);
    expect(peekStagedAssistantReportHandoff()?.patch.category).toBe("Keys");
    expect(takeStagedAssistantReportHandoff()?.patch.category).toBe("Keys");
    expect(takeStagedAssistantReportHandoff()).toBeNull();
  });

  it("never stages an invalid payload", () => {
    stageAssistantReportHandoff({ version: 2, source: "assistant", patch: {} } as never);
    expect(takeStagedAssistantReportHandoff()).toBeNull();
  });
});
