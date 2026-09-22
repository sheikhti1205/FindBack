import { describe, expect, it } from "vitest";
import { REPORT_SLOTS_INSTRUCTION, extractReportFields } from "./extractReportFields";
import { mustProfile, stubGenerate } from "./testSupport";

describe("extract-report-fields op", () => {
  it("extracts slots with a known location and no clarification", async () => {
    const result = await extractReportFields(
      stubGenerate(
        '{"title":"Black umbrella","description":"Lost yesterday","category":"accessories",' +
          '"dateText":"yesterday","locationNote":"central market"}',
      ),
      "I lost my black umbrella yesterday near the central market.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fields.title).toBe("Black umbrella");
      expect(result.value.fields.locationNote).toBe("central market");
      expect(result.value.action).toEqual({ action: "NONE" });
    }
  });

  it("resolves missing location to ASK_USER success, never coordinates", async () => {
    const result = await extractReportFields(
      stubGenerate('{"title":"Wallet","description":"Brown leather wallet"}'),
      "I lost my wallet.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action.action).toBe("ASK_USER");
      expect(result.value.action.prompt?.field).toBe("location");
      expect(JSON.stringify(result.value)).not.toMatch(/-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/);
    }
  });

  it("rejects model-chosen coordinates", async () => {
    const result = await extractReportFields(
      stubGenerate('{"title":"Keys","locationNote":"12.3456, 65.4321"}'),
      "Lost keys.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R5_COORDINATES_NOT_ACCEPTED");
  });

  it("fails closed on malformed extraction", async () => {
    const result = await extractReportFields(
      stubGenerate("{objectName: black umbrella, colors: [}"),
      "Lost umbrella.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("INVALID_OUTPUT");
  });

  it("rejects userContext echo with no explicit context (R6 wired)", async () => {
    const userMessage = "found near the central market fountain by the north gate entrance";
    const result = await extractReportFields(
      stubGenerate(`{"title":"Umbrella","description":"${userMessage}"}`),
      userMessage,
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });

  it("rejects instruction verbatim in free text with no explicit context (BV08-stock shape)", async () => {
    const result = await extractReportFields(
      stubGenerate(JSON.stringify({ title: "Umbrella", description: REPORT_SLOTS_INSTRUCTION })),
      "I lost my black umbrella yesterday near the central market.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });
});
