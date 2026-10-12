import { describe, expect, it } from "vitest";
import {
  aggregateBenchmarkScores,
  benchmarkEchoFlag,
  benchmarkKeywordRecall,
  benchmarkMean,
  benchmarkStructuredValidity,
  scoreBenchmarkOutput,
} from "./benchmarkScoreCalculator";

describe("benchmarkScoreCalculator", () => {
  it("computes keyword recall case-insensitively", () => {
    expect(benchmarkKeywordRecall("Black Umbrella near the Library", ["black umbrella", "library"])).toBe(1);
    expect(benchmarkKeywordRecall("red scarf", ["black umbrella", "library"])).toBe(0);
    expect(benchmarkKeywordRecall("anything", [])).toBeNull();
  });

  it("scores structured validity strictly", () => {
    expect(benchmarkStructuredValidity('{"title":"keys"}')).toBe(1);
    expect(benchmarkStructuredValidity("plain prose answer")).toBe(0);
    expect(benchmarkStructuredValidity("{broken")).toBe(0);
    expect(benchmarkStructuredValidity("")).toBe(0);
  });

  it("flags echo loops and passes clean output", () => {
    expect(benchmarkEchoFlag("Tap Report, then Lost. ".repeat(8).trim())).toBe(1);
    expect(benchmarkEchoFlag("Open the Report tab, choose Lost, then Publish.")).toBe(0);
  });

  it("is deterministic across repeated runs", () => {
    const outputs = [
      '{"title":"Black umbrella","category":"accessories"}',
      "Tap Report, then Lost. ".repeat(8).trim(),
      "red scarf found near the bus stop",
      "",
    ];
    const keywords: readonly (readonly string[])[] = [
      ["black umbrella", "accessories"],
      ["report", "lost"],
      ["red scarf", "bus stop"],
      ["report"],
    ];
    const first = outputs.map((output, index) => scoreBenchmarkOutput(output, keywords[index] ?? []));
    const second = outputs.map((output, index) => scoreBenchmarkOutput(output, keywords[index] ?? []));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(aggregateBenchmarkScores(first)).toEqual(aggregateBenchmarkScores(second));
  });

  it("aggregates means and never returns NaN", () => {
    expect(benchmarkMean([])).toBeNull();
    expect(benchmarkMean([null, null])).toBeNull();
    expect(benchmarkMean([1, 0, 0.5])).toBeCloseTo(0.5);
    const aggregate = aggregateBenchmarkScores([
      scoreBenchmarkOutput('{"title":"keys"}', ["keys"]),
      scoreBenchmarkOutput("nothing relevant here at all", ["keys"]),
    ]);
    expect(aggregate.count).toBe(2);
    expect(aggregate.meanKeywordRecall).toBeCloseTo(0.5);
    expect(aggregate.meanStructuredValidity).toBeCloseTo(0.5);
  });
});
