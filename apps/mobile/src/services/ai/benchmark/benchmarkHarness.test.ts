import { describe, expect, it } from "vitest";
import { labCandidateFor } from "./labCatalog";
import {
  detectEchoLoop,
  runBenchmarkForCandidate,
  runBenchmarkMatrix,
  scoreStructuredValidity,
  scoreTextCase,
  scoreVisionCase,
  type BenchmarkRuntimeAdapter,
} from "./benchmarkHarness";
import { MODEL_LAB_CORPUS } from "./benchmarkCorpus";

function fixtureAdapter(
  runtimeId: string,
  respond: (kind: "text" | "vision", id: string) => string,
): BenchmarkRuntimeAdapter {
  return {
    runtimeId,
    generateText: async (prompt: string) => respond("text", prompt.slice(0, 24)),
    describeImage: async (imageRef: string) => respond("vision", imageRef),
  };
}

describe("benchmarkHarness scoring", () => {
  it("flags echo loops and scores structured validity", () => {
    expect(detectEchoLoop("umbrella umbrella umbrella umbrella umbrella umbrella umbrella umbrella umbrella umbrella umbrella umbrella")).toBe(true);
    expect(detectEchoLoop("A black umbrella with a wooden handle found at the library.")).toBe(false);
    expect(scoreStructuredValidity('{"title":"x"}')).toBe(1);
    expect(scoreStructuredValidity("not json at all")).toBe(0);
    expect(scoreStructuredValidity("")).toBe(0);
  });

  it("scores Bangla, refusal, and extraction from fixtures", () => {
    const bnCase = MODEL_LAB_CORPUS.textCases.find((c) => c.id === "txt-bn-01-lost-wallet")!;
    const bnOutput = "ওয়ালেট বাদামী, ভেতরে পরিচয়পত্র, ক্যাফেটেরিয়া থেকে পাওয়া।";
    const bnScores = scoreTextCase(bnOutput, bnCase);
    expect(bnScores.banglaScore).toBeGreaterThan(0);
    expect(bnScores.keywordRecall).toBeGreaterThan(0);

    const refusalCase = MODEL_LAB_CORPUS.textCases.find((c) => c.id === "txt-ref-01-pii")!;
    expect(scoreTextCase("I cannot share ID numbers or phone numbers.", refusalCase).refusalScore).toBe(1);
    expect(scoreTextCase("Here is the number 1234567890.", refusalCase).refusalScore).toBe(0);

    const visionCase = MODEL_LAB_CORPUS.visionCases[0]!;
    const visionScores = scoreVisionCase('{"objectName":"black umbrella"} black umbrella handle', visionCase);
    expect(visionScores.keywordRecall).toBeGreaterThan(0);
    expect(visionScores.visionAccuracy).toBe(visionScores.keywordRecall);
  });

  it("runs one candidate over the corpus with identical budgets (fixture mode)", async () => {
    const candidate = labCandidateFor("qwen3-0.6b-dynamic-int4")!;
    const adapter = fixtureAdapter(candidate.runtime, (kind) =>
      kind === "text"
        ? '{"title":"Black umbrella","description":"Wooden handle at library"} umbrella wooden library'
        : '{"objectName":"black umbrella"} umbrella black handle',
    );
    const { results, deviceRequired } = await runBenchmarkForCandidate(candidate, adapter, {
      textCases: MODEL_LAB_CORPUS.textCases.slice(0, 3),
      visionCases: [],
    });
    expect(deviceRequired).toBe(true);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.modelId).toBe(candidate.modelId);
      expect(result.runtime).toBe(candidate.runtime);
      expect(result.textScores).not.toBeNull();
    }
  });

  it("runs the matrix across runtimes without inventing missing adapters", async () => {
    const textCandidate = labCandidateFor("qwen3-0.6b-dynamic-int4")!;
    const visionCandidate = labCandidateFor("smolvlm2-500M-vision")!;
    const report = await runBenchmarkMatrix([textCandidate, visionCandidate], {
      [`${textCandidate.modelId}@${textCandidate.runtime}`]: fixtureAdapter(
        textCandidate.runtime,
        () => '{"title":"x"} umbrella wooden library keys lanyard cafe ওয়ালেট',
      ),
      [`${visionCandidate.modelId}@${visionCandidate.runtime}`]: fixtureAdapter(
        visionCandidate.runtime,
        () => '{"objectName":"x"} umbrella black handle passport',
      ),
    });
    expect(report.harnessVersion).toBe("model-lab-harness-v1");
    expect(report.corpusVersion).toBe(MODEL_LAB_CORPUS.corpusVersion);
    expect(report.deviceRequired).toBe(true);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.summaries).toHaveLength(2);
    for (const summary of report.summaries) {
      expect(summary.casesExecuted).toBeGreaterThan(0);
    }
  });
});
