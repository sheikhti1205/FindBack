import { describe, expect, it } from "vitest";
import { HELP_INSTRUCTION, answerHelp, buildHelpPrompt } from "./answerHelp";
import { getCurrentKnowledge } from "../appKnowledge";
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

  it("rejects userContext echo with no explicit context (R6 wired)", async () => {
    const userMessage = "how do I report a lost black umbrella near the central market fountain";
    const result = await answerHelp(
      stubGenerate(userMessage),
      userMessage,
      mustProfile("lfm2.5-1.2b-q4_0"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });

  it("rejects instruction verbatim with no explicit context (BV08-stock shape)", async () => {
    const result = await answerHelp(
      stubGenerate(HELP_INSTRUCTION),
      "How do I report a lost item?",
      mustProfile("lfm2.5-1.2b-q4_0"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });

  it("grounds the prompt in current FindBack capability knowledge", () => {
    const prompt = buildHelpPrompt("How do I report a lost item?");
    const knowledge = getCurrentKnowledge();
    expect(prompt).toContain(HELP_INSTRUCTION);
    expect(prompt).toContain(`[knowledge version=${knowledge.version}]`);
    expect(prompt).toContain("/report");
    expect(prompt).toContain("User question: How do I report a lost item?");
  });

  it("screens model SQL leakage into the honest grounded refusal", async () => {
    const result = await answerHelp(
      stubGenerate("SELECT email, phone FROM profiles WHERE id = 1"),
      "how do I search?",
      mustProfile("lfm2.5-1.2b-q4_0"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.answerText.toUpperCase()).not.toContain("SELECT");
      expect(result.value.answerText.toLowerCase()).not.toContain("profiles");
      expect(result.value.action).toEqual({ action: "NONE" });
    }
  });

  it("rejects echo of explicitly supplied context", async () => {
    const supplied = "custom user context about a lost wallet near the fountain entrance gate";
    const result = await answerHelp(
      stubGenerate(`You asked about this: ${supplied} and here is that again.`),
      "How do I report a lost item?",
      mustProfile("lfm2.5-1.2b-q4_0"),
      { context: { userContext: supplied } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });
});
