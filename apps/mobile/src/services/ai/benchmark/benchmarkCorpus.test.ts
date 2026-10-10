import { describe, expect, it } from "vitest";
import {
  MODEL_LAB_CORPUS,
  MODEL_LAB_TOKEN_BUDGETS,
  validateModelLabCorpus,
} from "./benchmarkCorpus";

describe("benchmarkCorpus", () => {
  it("validates clean", () => {
    expect(validateModelLabCorpus(MODEL_LAB_CORPUS)).toEqual([]);
  });

  it("uses identical token budgets across runtimes", () => {
    expect(MODEL_LAB_TOKEN_BUDGETS.text).toBe(256);
    expect(MODEL_LAB_TOKEN_BUDGETS.vision).toBe(512);
    for (const item of MODEL_LAB_CORPUS.textCases) {
      expect(item.maxOutputTokens).toBe(256);
    }
    for (const item of MODEL_LAB_CORPUS.visionCases) {
      expect(item.maxOutputTokens).toBe(512);
    }
  });

  it("covers English + Bangla and every required text category", () => {
    const languages = new Set(MODEL_LAB_CORPUS.textCases.map((c) => c.language));
    expect(languages.has("en")).toBe(true);
    expect(languages.has("bn")).toBe(true);
    const categories = new Set(MODEL_LAB_CORPUS.textCases.map((c) => c.category));
    for (const required of [
      "english-extraction",
      "bangla-extraction",
      "bangladesh-location",
      "ambiguous-description",
      "tool-call",
      "refusal-privacy",
      "loop-echo-attack",
    ]) {
      expect(categories.has(required as never)).toBe(true);
    }
  });

  it("covers every required vision category with repo-local refs", () => {
    const categories = new Set(MODEL_LAB_CORPUS.visionCases.map((c) => c.category));
    for (const required of [
      "normal-camera",
      "document-card",
      "damaged-item",
      "multiple-objects",
      "poor-light",
      "high-res-derivative",
    ]) {
      expect(categories.has(required as never)).toBe(true);
    }
    for (const item of MODEL_LAB_CORPUS.visionCases) {
      expect(item.imageRef).not.toMatch(/^https?:\/\//i);
    }
  });

  it("rejects remote image refs and missing categories", () => {
    const bad = {
      ...MODEL_LAB_CORPUS,
      visionCases: [
        { ...MODEL_LAB_CORPUS.visionCases[0]!, imageRef: "https://example.com/photo.jpg" },
        ...MODEL_LAB_CORPUS.visionCases.slice(1),
      ],
    };
    expect(validateModelLabCorpus(bad).join("\n")).toMatch(/repo-local/i);
  });
});
