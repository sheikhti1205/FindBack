// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetBackInterceptors } from "./backNavigation";
import { assistantReportNavigationTarget } from "../services/assistant/assistantReportNavigation";
import { clearStagedAssistantReportHandoff } from "../services/assistant/assistantReportNavigation";
import { applyReportFields, chooseLocation, choosePhoto, startFlow } from "../services/assistant/guidedAssistantController";
import { buildAssistantReportHandoff } from "../services/assistant/assistantHandoff";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  clearStagedAssistantReportHandoff();
  document.body.style.overflow = "";
});

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

describe("assistantReportNavigationTarget", () => {
  it("routes the versioned handoff to /report and rejects others", () => {
    expect(assistantReportNavigationTarget(readyHandoff())).toBe("/report");
    expect(assistantReportNavigationTarget(null)).toBeNull();
    expect(assistantReportNavigationTarget({ version: 2, source: "assistant", patch: {} })).toBeNull();
  });
});

// NOTE: the sheet-driven "Review report wiring" flow test was removed with the
// global AssistantSheet (owner decision 2026-09-26). The same guided-report
// handoff → /report behavior is covered in screens/Help.assistant.test.tsx.
