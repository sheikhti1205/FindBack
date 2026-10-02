import { describe, expect, it } from "vitest";
import {
  scorePhotoCase,
  validateGoldenCorpus,
  type ExpectedPhotoFields,
  type GoldenCorpus,
} from "./goldenCorpus";

const VALID_PHOTO_EXPECTED: ExpectedPhotoFields = {
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

function validCorpus(): GoldenCorpus {
  return {
    corpusVersion: "ws6-v1",
    textMatchPairs: [
      {
        id: "tm-001",
        query: { title: "lost black umbrella", description: "wooden handle", category: "Accessories & Jewelry" },
        candidates: [
          { id: "c1", title: "black umbrella", description: "wooden handle", category: "Accessories & Jewelry" },
          { id: "c2", title: "red scarf", description: "wool", category: "Clothing" },
        ],
        relevantIds: ["c1"],
      },
    ],
    photoCases: [
      {
        id: "ph-001",
        imageRef: "fixtures/umbrella.jpg",
        instruction: "Describe the object.",
        expected: VALID_PHOTO_EXPECTED,
        requiredFields: ["objectName", "suggestedCategory", "colors", "suggestedTitle", "suggestedDescription"],
      },
    ],
  };
}

describe("validateGoldenCorpus", () => {
  it("accepts a well-formed corpus", () => {
    expect(validateGoldenCorpus(validCorpus())).toEqual([]);
  });

  it("rejects a bad version, dangling relevantIds, and unknown required fields", () => {
    const corpus = validCorpus();
    corpus.corpusVersion = "v1";
    corpus.textMatchPairs[0]!.relevantIds = ["nope"];
    corpus.photoCases[0]!.requiredFields = ["teleport_item_home" as never];
    const errors = validateGoldenCorpus(corpus);
    expect(errors.length).toBe(3);
    expect(errors.join("\n")).toMatch(/corpusVersion/);
    expect(errors.join("\n")).toMatch(/relevantId nope/);
    expect(errors.join("\n")).toMatch(/unknown required field/);
  });

  it("rejects duplicate ids, single-candidate pairs, and empty requiredFields", () => {
    const corpus = validCorpus();
    corpus.textMatchPairs[0]!.candidates = [corpus.textMatchPairs[0]!.candidates[0]!];
    corpus.photoCases[0]!.id = "tm-001";
    corpus.photoCases[0]!.requiredFields = [];
    const errors = validateGoldenCorpus(corpus);
    expect(errors.join("\n")).toMatch(/at least 2 candidates/);
    expect(errors.join("\n")).toMatch(/duplicate record id/);
    expect(errors.join("\n")).toMatch(/requiredFields must be non-empty/);
  });

  it("rejects non-object roots", () => {
    expect(validateGoldenCorpus(null)).toHaveLength(1);
    expect(validateGoldenCorpus("ws6-v1")).toHaveLength(1);
  });
});

describe("scorePhotoCase", () => {
  it("scores an exact match as 1.0", () => {
    const actual = { ...VALID_PHOTO_EXPECTED };
    const { fieldScores, mean } = scorePhotoCase(VALID_PHOTO_EXPECTED, actual, [
      "objectName",
      "colors",
      "suggestedTitle",
    ]);
    expect(fieldScores).toEqual({ objectName: 1, colors: 1, suggestedTitle: 1 });
    expect(mean).toBe(1);
  });

  it("normalizes case/whitespace and ignores color order", () => {
    const { mean } = scorePhotoCase(
      VALID_PHOTO_EXPECTED,
      { objectName: "  Black Umbrella ", colors: ["BLACK"] },
      ["objectName", "colors", "suggestedTitle"],
    );
    expect(mean).toBeCloseTo(2 / 3);
  });

  it("scores null and missing fields strictly", () => {
    const { fieldScores } = scorePhotoCase(VALID_PHOTO_EXPECTED, { visibleBrand: "Nike" }, ["visibleBrand"]);
    expect(fieldScores).toEqual({ visibleBrand: 0 });
    const nulled = scorePhotoCase(VALID_PHOTO_EXPECTED, { visibleBrand: null }, ["visibleBrand"]);
    expect(nulled.mean).toBe(1);
  });

  it("scores an empty field list as 0, not NaN", () => {
    expect(scorePhotoCase(VALID_PHOTO_EXPECTED, {}, []).mean).toBe(0);
  });
});
