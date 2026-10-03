import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KNOWN_PHOTO_FIELDS,
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

describe("bundled synthetic corpus (tools/bench/corpus.v1.json)", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
  const raw = readFileSync(join(repoRoot, "tools", "bench", "corpus.v1.json"), "utf8");
  const doc = JSON.parse(raw) as GoldenCorpus & { license?: unknown };

  it("loads and validates cleanly", () => {
    expect(validateGoldenCorpus(doc)).toEqual([]);
  });

  it("carries the synthetic-built-in license marker", () => {
    expect(doc.license).toBe("synthetic-built-in");
  });

  it("holds 12 text-match pairs with cross-referenced relevantIds", () => {
    expect(doc.textMatchPairs).toHaveLength(12);
    const ids = new Set(doc.textMatchPairs.map((p) => p.id));
    expect(ids.size).toBe(12);
    for (const pair of doc.textMatchPairs) {
      expect(pair.candidates.length).toBeGreaterThanOrEqual(2);
      const candidateIds = new Set(pair.candidates.map((c) => c.id));
      expect(pair.relevantIds.length).toBeGreaterThan(0);
      for (const rel of pair.relevantIds) expect(candidateIds.has(rel)).toBe(true);
    }
  });

  it("holds 6 photo stubs with expected fields and fixture refs, never remote URLs", () => {
    expect(doc.photoCases).toHaveLength(6);
    const known = new Set<string>(KNOWN_PHOTO_FIELDS);
    const ids = new Set(doc.photoCases.map((p) => p.id));
    expect(ids.size).toBe(6);
    for (const photo of doc.photoCases) {
      expect(photo.imageRef).toMatch(/^synthetic-fixture:\/\//);
      expect(photo.imageRef).not.toMatch(/^https?:\/\//);
      for (const field of ["objectName", "suggestedCategory", "colors", "suggestedTitle", "suggestedDescription"] as const) {
        expect(photo.expected[field]).toBeDefined();
      }
      expect(photo.expected.colors.length).toBeGreaterThan(0);
      expect(photo.requiredFields.length).toBeGreaterThan(0);
      for (const field of photo.requiredFields) expect(known.has(field)).toBe(true);
    }
  });

  it("shares no ids between text pairs and photo cases", () => {
    const all = [...doc.textMatchPairs.map((p) => p.id), ...doc.photoCases.map((p) => p.id)];
    expect(new Set(all).size).toBe(all.length);
  });
});
