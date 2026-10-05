/**
 * ai-release-gate regression tests: the gate must fail on a skeleton tree
 * (production seams absent) and pass on the real tree.
 *
 * Pure validators are exercised with synthetic sources; the real tree is
 * asserted by reading the repo files (this test runs from the repo root in
 * CI: `node --test scripts/ai-release-gate.test.mjs`).
 */
import { deepStrictEqual, equal, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkAiReleaseGate,
  validateRuntimeWiring,
  validateVisionTruth,
  validateApplicationIntegration,
} from "./ai-release-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const REAL = {
  registrySource: read("apps/mobile/src/services/ai/orchestrator/taskRegistry.ts"),
  runtimesSource: read("apps/mobile/src/services/ai/orchestrator/productionRuntimes.ts"),
  orchestratorSource: read("apps/mobile/src/services/ai/orchestrator/AiOrchestrator.ts"),
  offlineSource: read("apps/mobile/src/services/ai/providers/offline.ts"),
  capabilitiesSource: read("apps/mobile/src/services/appCapabilities.ts"),
  mainSource: read("apps/mobile/src/main.tsx"),
  appSource: read("apps/mobile/src/App.tsx"),
  serviceSource: read("apps/mobile/src/services/ai/applicationAi.ts"),
  providersSource: read("apps/mobile/src/services/ai/providerRegistry.ts"),
  modelsSource: read("apps/mobile/src/screens/AiModelsRoute.tsx"),
  advancedSource: read("apps/mobile/src/screens/AiAdvanced.tsx"),
  helpSource: read("apps/mobile/src/screens/Help.tsx"),
  matchesSource: read("apps/mobile/src/services/possibleMatches.ts"),
  visionNativeSource: read("apps/mobile/src/services/ai/vision/native.ts"),
  probeSource: read("apps/mobile/android/app/src/main/java/com/findback/app/vlm/DeviceProbe.kt"),
  timingSource: read("apps/mobile/android/app/src/main/java/com/findback/app/vlm/RuntimeTimingRunner.kt"),
  pluginSource: read("apps/mobile/android/app/src/main/java/com/findback/app/vlm/SmolVlmPlugin.kt"),
  analyzePhotoSource: read("apps/mobile/src/services/analyzeReportPhoto.ts"),
  localAnalyzeSource: read("apps/mobile/src/services/analyzeReportPhotoLocal.ts"),
  suggestionsSource: read("apps/mobile/src/components/VlmSuggestions.tsx"),
};

describe("validateApplicationIntegration", () => {
  it("passes only with the real application-owned path", () => {
    deepStrictEqual(validateApplicationIntegration(REAL), []);
  });
  for (const [label, field, mutate] of [
    ["disconnected startup", "mainSource", (source) => source.replace(/initializeApplicationAi\(\)/g, "Promise.resolve()")],
    ["manager without production boot", "serviceSource", (source) => source.replace(/bootProductionAi\(/g, "fakeBoot(")],
    ["unconstructed Needle bridge", "serviceSource", (source) => source.replace(/new CapacitorNeedleBridge\(/g, "fakeNeedle(")],
    ["unconstructed Smol bridge", "serviceSource", (source) => source.replace(/new CapacitorSmolVlmBridge\(/g, "fakeSmol(")],
    ["offline id excluded by provider guard", "providersSource", (source) => source.replace('...SUPPORTED_AI_PROVIDERS, "offline"', "...SUPPORTED_AI_PROVIDERS")],
    ["offline provider hard refusal", "providersSource", (source) => source.replace(/\.offlineAdapter\(/g, ".refuseOffline(")],
    ["plain models screen at product route", "appSource", (source) => source.replace(/<AiModelsRoute\s*\/>/g, "<AiModels />")],
    ["absent route download controls", "modelsSource", (source) => source.replace(/run\(service\.(download|pause|remove)\(modelId\)/g, "run(fakeService.$1(modelId)")],
    ["download button disconnected from driver", "modelsSource", (source) => source.replace(/service\.download\(/g, "fakeDownload(")],
    ["measure removed from Advanced", "advancedSource", (source) => source.replace(/service\.measure\(/g, "fakeMeasure(")],
    ["Help without installed offline catalogue", "helpSource", (source) => source.replace(/createProviderAdapter\("offline",/g, "fakeOffline(")],
    ["matching never calls Needle", "matchesSource", (source) => source.replace(/ai\.embedNeedle\(/g, "fakeEmbed(")],
    ["native Smol binding disconnected", "visionNativeSource", (source) => source.replace('"FindbackSmolVlm"', '"MissingPlugin"')],
    ["null production timing runner", "probeSource", (source) => source.replace(/RuntimeTimingRunner\.forInstalledSmol\(appContext\)/g, "null")],
    ["synthetic token estimates", "timingSource", (source) => source.replace(/conversation\.getBenchmarkInfo\(\)/g, "wordEstimates()")],
    ["no native timing endpoint", "pluginSource", (source) => source.replace(/fun measureBackend\(/g, "fun disconnectedMeasurement(")],
    ["photo analyzer stops trying local first", "analyzePhotoSource", (source) => source.replace(/await analyzeLocally\(file/g, "await cloudFirst(file")],
    ["local analyzer stops routing analyze-image", "localAnalyzeSource", (source) => source.replace(/"analyze-image"/g, '"describe-image"')],
    ["local analyzer drops imageBase64", "localAnalyzeSource", (source) => source.replace("PHOTO_INSTRUCTION, imageBase64 }", "PHOTO_INSTRUCTION, imageData }")],
    ["photo suggestions stop using the local-first analyzer", "suggestionsSource", (source) => source.replace(/analyzeReportPhoto\(file/g, "cloudAnalyze(file")],
  ]) {
    it(`fails on ${label}`, () => {
      const broken = mutate(REAL[field]);
      ok(broken !== REAL[field], `${label}: mutation must change its input`);
      ok(validateApplicationIntegration({ ...REAL, [field]: broken }).length > 0, label);
    });
  }
});

describe("validateRuntimeWiring", () => {
  it("passes on the real tree", () => {
    deepStrictEqual(
      validateRuntimeWiring({
        registrySource: REAL.registrySource,
        runtimesSource: REAL.runtimesSource,
        orchestratorSource: REAL.orchestratorSource,
      }),
      [],
    );
  });

  it("fails when a spec runtime has no production adapter", () => {
    const errors = validateRuntimeWiring({
      registrySource: REAL.registrySource,
      runtimesSource: "export function registerProductionRuntimes() { return []; }",
      orchestratorSource: REAL.orchestratorSource,
    });
    ok(errors.some((e) => e.includes("local-text")), `expected local-text complaint, got: ${errors}`);
    ok(errors.some((e) => e.includes("local-vision")), `expected local-vision complaint, got: ${errors}`);
    ok(errors.some((e) => e.includes("local-embedding")), `expected local-embedding complaint, got: ${errors}`);
  });

  it("fails when a foreign runtime is registered as routable", () => {
    const errors = validateRuntimeWiring({
      registrySource: REAL.registrySource,
      runtimesSource: `${REAL.runtimesSource}\nregistry.register(llamaChallenger(registry));`,
      orchestratorSource: REAL.orchestratorSource,
    });
    ok(errors.some((e) => e.includes("llama")), `expected lab-runtime complaint, got: ${errors}`);
  });

  it("fails when the orchestrator lets deterministic-local shadow model runtimes", () => {
    const errors = validateRuntimeWiring({
      registrySource: REAL.registrySource,
      runtimesSource: REAL.runtimesSource,
      orchestratorSource: "const runtime = registry.firstAvailable(spec.runtimes);",
    });
    ok(errors.some((e) => e.includes("deterministic")), `expected shadowing complaint, got: ${errors}`);
  });
});

describe("validateVisionTruth", () => {
  it("passes on the real tree", () => {
    deepStrictEqual(
      validateVisionTruth({
        offlineSource: REAL.offlineSource,
        runtimesSource: REAL.runtimesSource,
        capabilitiesSource: REAL.capabilitiesSource,
      }),
      [],
    );
  });

  it("fails when the vision seam is absent (text-only skeleton)", () => {
    const errors = validateVisionTruth({
      offlineSource: "// text-only adapter, no vision seam",
      runtimesSource: REAL.runtimesSource,
      capabilitiesSource: REAL.capabilitiesSource,
    });
    ok(errors.some((e) => e.includes("seam")), `expected seam complaint, got: ${errors}`);
  });

  it("fails when capability copy claims ready vision without device evidence", () => {
    const errors = validateVisionTruth({
      offlineSource: REAL.offlineSource,
      runtimesSource: REAL.runtimesSource,
      capabilitiesSource: "export const vision = 'on-device vision is ready for everyone';",
    });
    ok(errors.some((e) => e.includes("ready")), `expected ready-claim complaint, got: ${errors}`);
  });
});

describe("checkAiReleaseGate", () => {
  it("passes on the real tree", () => {
    const { passed, results } = checkAiReleaseGate();
    equal(passed, true, JSON.stringify(results.filter((r) => !r.ok), null, 2));
  });
});
