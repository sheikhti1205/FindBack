import { describe, expect, it } from "vitest";
import { profileFor, type ModelProfile } from "./modelProfiles";
import {
  checkNonEmptyOrRefusal,
  detectRefusal,
  extractOneJsonObject,
  normalizeJsonOp,
  normalizeProse,
  stripThoughtEnvelope,
  validateIntentPayload,
  validatePhotoAnalysis,
  validateReportSlots,
  validateSearchFilters,
  type NormalizeOptions,
} from "./normalize";
import { REFUSAL_TEXT } from "./testing/FakeAiProvider";

function mustProfile(id: string): ModelProfile {
  const profile = profileFor(id);
  if (profile === undefined) throw new Error(`missing profile: ${id}`);
  return profile;
}

const QWEN = "qwen3-0.6b-dynamic-int4";
const SMOL_TEXT = "smolvlm2-500m-text";

const THOUGHT_PLUS_JSON =
  "[thought] The user wants to search, so the intent is SEARCH. [/thought]\n\n" +
  '{"intent":"SEARCH"}';
const THOUGHT_ONLY = "[thought] The user lost a jacket and asks about dates [/thought]";
const THOUGHT_PLUS_PROSE =
  "[thought] This is a help question. [/thought]\n\nOpen the Report tab and choose Lost.";

const VALID_PHOTO = {
  objectName: "black umbrella",
  suggestedCategory: "accessories",
  colors: ["black"],
  visibleBrand: null,
  visibleText: [],
  identifyingFeatures: ["curved wooden handle"],
  suggestedTitle: "Black umbrella found near the library",
  suggestedDescription: "A black umbrella with a curved wooden handle.",
  uncertainFields: ["visibleBrand"],
};

describe("R1 de-fence: one object only, then strict validation", () => {
  it("extracts fenced and prose-wrapped single objects", () => {
    expect(extractOneJsonObject('```json\n{"intent":"SEARCH"}\n```').ok).toBe(true);
    expect(
      extractOneJsonObject('Here it is:\n{"intent":"SEARCH"}\nHope that helps.').ok,
    ).toBe(true);
  });

  it("rejects multiple, missing, and truncated objects", () => {
    const multi = extractOneJsonObject('{"intent":"SEARCH"} {"intent":"UNKNOWN"}');
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.error.diagnostic).toBe("R1_MULTIPLE_JSON_OBJECTS");
    const missing = extractOneJsonObject("no json here at all");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.diagnostic).toBe("R1_NO_JSON_OBJECT");
    const truncated = extractOneJsonObject('{"intent":"SEAR');
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.error.diagnostic).toBe("R1_MALFORMED_JSON");
  });

  it("rejects lookalike alias keys and missing fields in photo objects", () => {
    const alias = validatePhotoAnalysis({ ...VALID_PHOTO, title: "Umbrella" });
    expect(alias.ok).toBe(false);
    if (!alias.ok) expect(alias.error.diagnostic).toBe("R1_UNKNOWN_FIELD:title");
    const { colors: _dropped, ...missing } = VALID_PHOTO;
    const missed = validatePhotoAnalysis(missing);
    expect(missed.ok).toBe(false);
    if (!missed.ok) expect(missed.error.diagnostic).toBe("R1_MISSING_FIELD:colors");
  });

  it("rejects wrong-typed fields (BV02-stock colors-as-string shape)", () => {
    const bad = validatePhotoAnalysis({ ...VALID_PHOTO, colors: "brown" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.diagnostic).toBe("R1_BAD_FIELD:colors");
  });
});

describe("R2 Qwen thought-strip is profile-specific", () => {
  it("strips thought+answer on Qwen and processes the answer", () => {
    const stripped = stripThoughtEnvelope(THOUGHT_PLUS_JSON, mustProfile(QWEN));
    expect(stripped).toEqual({ ok: true, value: '{"intent":"SEARCH"}' });
    const full = normalizeJsonOp(THOUGHT_PLUS_JSON, mustProfile(QWEN), validateIntentPayload);
    expect(full.ok).toBe(true);
  });

  it("fails thought-without-answer (T11 shape) as INVALID_OUTPUT", () => {
    const stripped = stripThoughtEnvelope(THOUGHT_ONLY, mustProfile(QWEN));
    expect(stripped.ok).toBe(false);
    if (!stripped.ok) {
      expect(stripped.error.errorClass).toBe("INVALID_OUTPUT");
      expect(stripped.error.diagnostic).toBe("R2_THOUGHT_WITHOUT_ANSWER");
    }
  });

  it("drops an unclosed trailing thought but keeps a leading answer", () => {
    const stripped = stripThoughtEnvelope(
      "Open the Report tab. [thought] trailing reasoning never closed",
      mustProfile(QWEN),
    );
    expect(stripped).toEqual({ ok: true, value: "Open the Report tab." });
  });

  it("leaves other profiles untouched — no global thought regex", () => {
    const untouched = stripThoughtEnvelope(THOUGHT_PLUS_PROSE, mustProfile(SMOL_TEXT));
    expect(untouched).toEqual({ ok: true, value: THOUGHT_PLUS_PROSE });
  });

  it("never surfaces reasoning text in prose answers", () => {
    const answer = normalizeProse(THOUGHT_PLUS_PROSE, mustProfile(QWEN));
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.value).not.toContain("[thought]");
      expect(answer.value).toContain("Report tab");
    }
  });
});

describe("R4 empty is not refusal", () => {
  it("maps whitespace-only output to INVALID_OUTPUT/EMPTY", () => {
    const empty = checkNonEmptyOrRefusal("   \n  ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.errorClass).toBe("INVALID_OUTPUT");
      expect(empty.error.diagnostic).toBe("R4_EMPTY_OUTPUT");
    }
  });

  it("maps the canned refusal to UNSUPPORTED_REQUEST with a reason", () => {
    expect(detectRefusal(REFUSAL_TEXT)).toBe("REFUSAL_POLICY");
    const refused = checkNonEmptyOrRefusal(REFUSAL_TEXT);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.errorClass).toBe("UNSUPPORTED_REQUEST");
      expect(refused.error.diagnostic).toBe("R4_REFUSAL_POLICY");
      expect(refused.error.reason).toBe("REFUSAL_POLICY");
    }
  });

  it("recognizes the T26 PII refusal shape", () => {
    const pii =
      "I'm sorry, but I cannot provide you with the information you requested. " +
      "I do not have access to personal information.";
    const refused = checkNonEmptyOrRefusal(pii);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.errorClass).toBe("UNSUPPORTED_REQUEST");
  });
});

describe("R5 field-stuffing fails even when JSON parses", () => {
  it("rejects a 60-item color repetition dump", () => {
    const stuffed = validatePhotoAnalysis({
      ...VALID_PHOTO,
      visibleText: Array.from({ length: 60 }, () => "red"),
    });
    expect(stuffed.ok).toBe(false);
    if (!stuffed.ok) expect(stuffed.error.diagnostic).toContain("R5_FIELD_STUFFING");
  });

  it("rejects one value repeated across fields (Champion-everywhere shape)", () => {
    const champion = {
      objectName: "Champion",
      suggestedCategory: "Champion",
      colors: ["red"],
      visibleBrand: "Champion",
      visibleText: ["Champion"],
      identifyingFeatures: ["Champion"],
      suggestedTitle: "Champion",
      suggestedDescription: "Champion backpack",
      uncertainFields: ["Champion"],
    };
    const rejected = validatePhotoAnalysis(champion);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.diagnostic).toContain("R5_FIELD_STUFFING");
  });

  it("rejects 3-field cross-field duplication (BV03/BV04-stock shape)", () => {
    const duped = validatePhotoAnalysis({
      ...VALID_PHOTO,
      colors: ["brown"],
      visibleText: ["brown"],
      identifyingFeatures: ["brown"],
    });
    expect(duped.ok).toBe(false);
    if (!duped.ok) expect(duped.error.diagnostic).toContain("R5_FIELD_STUFFING");
  });

  it("rejects BV11-stock shape (8 items / 4 distinct + cross-field broken bag)", () => {
    const bv11 = validatePhotoAnalysis({
      ...VALID_PHOTO,
      objectName: "broken bag",
      suggestedTitle: "broken bag",
      colors: ["black", "gray", "white", "red", "blue", "yellow", "orange", "purple"],
      identifyingFeatures: [
        "strap",
        "strap",
        "buckle",
        "buckle",
        "zipper",
        "zipper",
        "pocket",
        "pocket",
      ],
    });
    expect(bv11.ok).toBe(false);
    if (!bv11.ok) expect(bv11.error.diagnostic).toContain("R5_FIELD_STUFFING");
  });

  it("accepts the valid photo object and sparse nulls", () => {
    const sparse = validatePhotoAnalysis({
      ...VALID_PHOTO,
      visibleBrand: null,
      visibleText: [],
      suggestedCategory: null,
    });
    expect(sparse.ok).toBe(true);
  });

  it("rejects model-chosen coordinates in location slots", () => {
    const coords = validateReportSlots({ locationNote: "12.3456, 65.4321" });
    expect(coords.ok).toBe(false);
    if (!coords.ok) expect(coords.error.diagnostic).toContain("R5_COORDINATES_NOT_ACCEPTED");
    const search = validateSearchFilters({ query: "umbrella near 12.3456, 65.4321" });
    expect(search.ok).toBe(false);
    if (!search.ok) expect(search.error.diagnostic).toContain("R5_COORDINATES_NOT_ACCEPTED");
  });

  it("bounds overlong prose answers", () => {
    const long = normalizeProse("x".repeat(2001), mustProfile(SMOL_TEXT));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.diagnostic).toBe("R5_ANSWER_TOO_LONG");
  });
});

describe("R6 prompt/context-echo rejection", () => {
  it("rejects schema regurgitation (BV05 shape)", () => {
    const echo = validatePhotoAnalysis({
      ...VALID_PHOTO,
      objectName: "string | null",
      suggestedCategory: "string | null",
    });
    expect(echo.ok).toBe(false);
    if (!echo.ok) expect(echo.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });

  it("rejects values reproducing userContext", () => {
    const userContext = "found near the central market fountain by the north gate entrance";
    const echoed = validatePhotoAnalysis(
      { ...VALID_PHOTO, suggestedDescription: `A photo. ${userContext} and more words here.` },
      { userContext },
    );
    expect(echoed.ok).toBe(false);
    if (!echoed.ok) expect(echoed.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });
});

describe("intent payloads honor the stable action mapping", () => {
  it("maps WRONG_ACTION and UNKNOWN_ACTION shapes to UNSUPPORTED_ACTION", () => {
    const wrong = validateIntentPayload({ action: "delete_someone_elses_post", args: { postId: "abc" } });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.errorClass).toBe("UNSUPPORTED_ACTION");
      expect(wrong.error.diagnostic).toBe("R1_UNSUPPORTED_ACTION:delete_someone_elses_post");
    }
    const unknown = validateIntentPayload({ action: "teleport_item_home", args: {} });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.errorClass).toBe("UNSUPPORTED_ACTION");
      expect(unknown.error.diagnostic).toBe("R1_UNSUPPORTED_ACTION:teleport_item_home");
    }
  });

  it("defaults missing actions and requires prompts for ASK_USER", () => {
    const lost = validateIntentPayload({ intent: "REPORT_LOST" });
    expect(lost).toEqual({ ok: true, value: { intent: "REPORT_LOST", action: { action: "OPEN_REPORT" } } });
    const ambiguous = validateIntentPayload({ intent: "UNKNOWN" });
    expect(ambiguous.ok).toBe(true);
    if (ambiguous.ok) {
      expect(ambiguous.value.action.action).toBe("ASK_USER");
      expect(ambiguous.value.action.prompt?.question.length ?? 0).toBeGreaterThan(0);
    }
    const badAsk = validateIntentPayload({ intent: "SEARCH", action: "ASK_USER" });
    expect(badAsk.ok).toBe(false);
    if (!badAsk.ok) expect(badAsk.error.diagnostic).toBe("R1_BAD_ACTION_SHAPE");
  });
});

describe("R3 loop seam belongs to the guard", () => {
  const loopHook = (text: string) => ({
    errorClass: "LOOP_DETECTED" as const,
    diagnostic: "TASK22_LOOP",
    reason: text.slice(0, 16),
  });
  const options: NormalizeOptions = { loopCheck: loopHook };

  it("honors an injected loop verdict", () => {
    const flagged = normalizeJsonOp('{"intent":"SEARCH"}', mustProfile(SMOL_TEXT), validateIntentPayload, options);
    expect(flagged.ok).toBe(false);
    if (!flagged.ok) expect(flagged.error.errorClass).toBe("LOOP_DETECTED");
  });

  it("performs no loop detection of its own", () => {
    const looped = normalizeProse(
      "Report tab. Report tab. Report tab. Report tab.",
      mustProfile(SMOL_TEXT),
    );
    expect(looped.ok).toBe(true);
  });
});
