import { describe, expect, it } from "vitest";
import {
  applyReportFields,
  chooseLocation,
  choosePhoto,
  startFlow,
} from "./guidedAssistantController";
import { buildAssistantReportHandoff, isAssistantReportHandoff } from "./assistantHandoff";

function readyLost() {
  let snapshot = startFlow("lost");
  snapshot = applyReportFields(snapshot, {
    title: "Keys",
    category: "Keys",
    dateText: "2026-09-01",
    locationNote: "Central library",
  });
  snapshot = choosePhoto(snapshot, "none");
  snapshot = chooseLocation(snapshot, "skip");
  return snapshot;
}

describe("buildAssistantReportHandoff", () => {
  it("emits the frozen versioned handoff for a ready report", () => {
    const handoff = buildAssistantReportHandoff(readyLost());
    expect(handoff?.version).toBe(1);
    expect(handoff?.source).toBe("assistant");
    expect(handoff?.patch.category).toBe("Keys");
    expect(handoff?.photoChoice).toBe("none");
    expect(handoff?.locationChoice).toBe("skip");
  });
  it("returns null while the report is still collecting", () => {
    expect(buildAssistantReportHandoff(startFlow("lost"))).toBeNull();
  });
  it("returns null for a ready search", () => {
    expect(buildAssistantReportHandoff(startFlow("search"))).toBeNull();
  });
  it("validates the frozen shape", () => {
    const handoff = buildAssistantReportHandoff(readyLost());
    expect(isAssistantReportHandoff(handoff)).toBe(true);
    expect(isAssistantReportHandoff({ version: 2, source: "assistant", patch: {} })).toBe(false);
  });
});
