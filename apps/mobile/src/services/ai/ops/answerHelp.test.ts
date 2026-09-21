import { describe, expect, it } from "vitest";
import { answerHelp } from "./answerHelp";
import { FakeAiProvider } from "../testing/FakeAiProvider";
import { fakeGenerate, mustProfile, stubGenerate } from "./testSupport";

describe("answer-help op", () => {
  it("returns prose answers without thought leakage", async () => {
    const result = await answerHelp(
      stubGenerate(
        "[thought] The user asks how to report. Answer briefly. [/thought]\n\n" +
          "Open the Report tab, choose Lost, fill the form, then Publish.",
      ),
      "How do I report a lost item?",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.answerText).toContain("Report tab");
      expect(result.value.answerText).not.toContain("[thought]");
      expect(result.value.action).toEqual({ action: "NONE" });
    }
  });

  it("passes simulator prose through for non-thought profiles", async () => {
    const result = await answerHelp(
      fakeGenerate(new FakeAiProvider({ mode: "GOOD" })),
      "How do I report a lost item?",
      mustProfile("lfm2.5-1.2b-q4_0"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.answerText).toContain("Report tab");
  });

  it("maps empty output to INVALID_OUTPUT/EMPTY, not refusal", async () => {
    const result = await answerHelp(
      fakeGenerate(new FakeAiProvider({ mode: "EMPTY" })),
      "What can this app do?",
      mustProfile("lfm2.5-1.2b-q4_0"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("INVALID_OUTPUT");
      expect(result.error.diagnostic).toBe("R4_EMPTY_OUTPUT");
    }
  });
});
