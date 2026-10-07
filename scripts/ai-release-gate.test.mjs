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
  validateDescriptorRegistry,
  validatePhotoAnalysisTruth,
  validateUserFacingPhotoTruth,
  validatePhotoGroundingWired,
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
  clientCapabilitiesSource: read("apps/mobile/src/services/appCapabilities.ts"),
  serverCapabilitiesSource: read("supabase/functions/ai-help/capabilities.ts"),
  aboutSource: read("apps/mobile/src/screens/About.tsx"),
  mainSource: read("apps/mobile/src/main.tsx"),
  appSource: read("apps/mobile/src/App.tsx"),
  descriptorsSource: read("apps/mobile/src/services/ai/modelDescriptors.ts"),
  serviceSource: read("apps/mobile/src/services/ai/applicationAi.ts"),
  interpretersSource: read("apps/mobile/src/services/ai/orchestrator/taskInterpreters.ts"),
  routeValidationSource: read("apps/mobile/src/services/ai/orchestrator/routeValidation.ts"),
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
  aiConnectionSource: read("apps/mobile/src/screens/AiConnection.tsx"),
  aiPreferencesSource: read("apps/mobile/src/services/ai/aiPreferences.ts"),
  searchScreenSource: read("apps/mobile/src/screens/SearchScreen.tsx"),
  nlFiltersSource: read("apps/mobile/src/services/search/nlFilters.ts"),
  searchMappingSource: read("apps/mobile/src/services/assistant/searchFilterMapping.ts"),
  createReportSource: read("apps/mobile/src/screens/CreateReport.tsx"),
  categorySuggestionSource: read("apps/mobile/src/services/categorySuggestion.ts"),
  actionGateSource: read("apps/mobile/src/services/ai/orchestrator/actionGate.ts"),
  routeIntentSource: read("apps/mobile/src/services/ai/ops/routeIntent.ts"),
  intentRouterSource: read("apps/mobile/src/services/ai/ops/intentRouter.ts"),
  chatControllerSource: read("apps/mobile/src/services/ai/chatController.ts"),
  chatStoreSource: read("apps/mobile/src/services/ai/chatStore.ts"),
  photoGroundingSource: read("apps/mobile/src/services/photoGrounding.ts"),
  photoGroundingComponentSource: read("apps/mobile/src/components/PhotoGrounding.tsx"),
  livePhotoGroundingSource: read("apps/mobile/src/services/livePhotoGrounding.ts"),
  groundObjectsSource: read("apps/mobile/src/services/ai/ops/groundObjects.ts"),
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
    ["settings model preference display-only (binding removed)", "aiPreferencesSource", (source) => source.replace(/export function createAssistantModelBinding/g, "export function droppedBinding")],
    ["settings model preference display-only (sheet not forwarded)", "aiConnectionSource", (source) => source.replace(/selectedId=\{effectiveSelectedId\}/g, "selectedId={null}")],
    ["settings model preference display-only (selection never persisted)", "aiConnectionSource", (source) => source.replace(/onSelectModel\?\.\(record\.id\)/g, "void record.id")],
    ["Help ignores persisted default selection", "helpSource", (source) => source.replace(/defaultSelection\(accountId\)/g, "null")],
    ["photo analyzer drops explicit consent", "analyzePhotoSource", (source) => source.replace(/CONSENT_REQUIRED/g, "CONSENT_OPTIONAL")],
    ["photo analyzer drops engine-preference seam", "analyzePhotoSource", (source) => source.replace(/export function getPhotoEngine/g, "export function droppedEngine")],
    ["photo analyzer drops cloud fallback", "analyzePhotoSource", (source) => source.replace(/resolveAccountOpenRouterKey/g, "fakeCloud")],
    ["photo analyzer retargets cloud key to session lookup", "analyzePhotoSource", (source) => source.replace(/resolveAccountOpenRouterKey/g, "getConnectedOpenRouterKey")],
    ["NL search stops importing the validated seam", "searchScreenSource", (source) => source.replace(/services\/search\/nlFilters/g, "services/search/missing")],
    ["NL search stops consuming validated filters", "helpSource", (source) => source.replace(/mapAssistantSearchFilters\(/g, "unvalidatedSearch(")],
    ["validated-filter mapper removed", "searchMappingSource", (source) => source.replace(/export function mapAssistantSearchFilters/g, "export function droppedMapper")],
    ["SearchScreen stops consuming validated URL query", "searchScreenSource", (source) => source.replace(/useUrlParam\("q"\)/g, 'useUrlParam("zzz")')],
    ["report-field AI bypasses Apply review", "suggestionsSource", (source) => source.replace(/handleApplyTitle/g, "handleAutoApplyTitle")],
    ["report-field AI drops Keep review", "suggestionsSource", (source) => source.replace(/handleKeepTitle/g, "handleDropTitle")],
    ["draft-from-photo consent stops being mode-derived", "suggestionsSource", (source) => source.replace(/VLM_CONSENT_COPY/g, "STATIC_COPY")],
    ["draft-from-photo drops the on-device-only no-send promise", "suggestionsSource", (source) => source.replace(/never sent to OpenRouter/g, "sometimes sent")],
    ["draft-from-photo drops the cloud-only send promise", "suggestionsSource", (source) => source.replace(/Send this photo to OpenRouter/g, "Maybe send this photo")],
    ["category suggestions overwrite manual selection", "createReportSource", (source) => source.replace(/window\.confirm\("Replace the existing title, description or category/g, 'window.confirm("OK')],
    ["category confirm-or-override module removed", "categorySuggestionSource", (source) => source.replace(/export function resolveCategorySuggestion/g, "export function droppedResolver")],
    ["route-intent navigates without validation", "actionGateSource", (source) => source.replace(/function validateRouteIntent/g, "function droppedValidator")],
    ["route-intent CTA no longer validated", "intentRouterSource", (source) => source.replace(/export function ctaForRoute/g, "export function droppedCta")],
    ["summary consumer disconnects from compaction", "chatControllerSource", (source) => source.replace(/from "\.\/compaction"/g, 'from "./missing"')],
    ["summary grounding guard disconnected", "chatStoreSource", (source) => source.replace(/isSummaryPoisoned/g, "isSummaryIgnored")],
  ]) {
    it(`fails on ${label}`, () => {
      const broken = mutate(REAL[field]);
      ok(broken !== REAL[field], `${label}: mutation must change its input`);
      ok(validateApplicationIntegration({ ...REAL, [field]: broken }).length > 0, label);
    });
  }
});

describe("validatePhotoGroundingWired", () => {
  it("passes on the real reviewed grounding flow", () => {
    deepStrictEqual(validatePhotoGroundingWired(REAL), []);
  });

  for (const [label, mutate] of [
    ["service drops the op import", (s) => ({
      ...s,
      photoGroundingSource: s.photoGroundingSource.replace(/from "\.\/ai\/ops\/groundObjects"/g, 'from "./ai/ops/missing"'),
    })],
    ["service drops the op call", (s) => ({
      ...s,
      photoGroundingSource: s.photoGroundingSource.replace(/await groundObjects\(/g, "await missingOp("),
    })],
    ["service drops the consent gate", (s) => ({
      ...s,
      photoGroundingSource: s.photoGroundingSource.replace(/input\.imageConsent !== true/g, "input.imageConsent !== false"),
    })],
    ["op voids the approved image", (s) => ({
      ...s,
      groundObjectsSource: `${s.groundObjectsSource}\nvoid input.imageUri;\n`,
    })],
    ["CreateReport unmounts the grounding component", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(/<PhotoGrounding/g, "<RemovedGrounding"),
    })],
    ["component stops calling the live transport", (s) => ({
      ...s,
      photoGroundingComponentSource: s.photoGroundingComponentSource.replace(/groundReportPhoto\(/g, "fakeGround("),
    })],
    ["component drops percentage overlays", (s) => ({
      ...s,
      photoGroundingComponentSource: s.photoGroundingComponentSource.replace(/toCssPercentRect\(/g, "toRawRect("),
    })],
    ["component drops Keep review", (s) => ({
      ...s,
      photoGroundingComponentSource: s.photoGroundingComponentSource.replace(/Keep my title/g, "Drop my title"),
    })],
    ["transport stops binding the approved image", (s) => ({
      ...s,
      livePhotoGroundingSource: s.livePhotoGroundingSource.replace(/transport\.imageUri !== imageUrl/g, "false"),
    })],
    ["transport drops the account-bound key resolver", (s) => ({
      ...s,
      livePhotoGroundingSource: s.livePhotoGroundingSource.replace(/resolveAccountOpenRouterKey/g, "getConnectedOpenRouterKey"),
    })],
  ]) {
    it(`fails on ${label}`, () => {
      const broken = mutate(REAL);
      ok(validatePhotoGroundingWired(broken).length > 0, label);
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

describe("validatePhotoAnalysisTruth", () => {
  it("passes on the real tree", () => {
    deepStrictEqual(
      validatePhotoAnalysisTruth({
        clientCapabilitiesSource: REAL.clientCapabilitiesSource,
        serverCapabilitiesSource: REAL.serverCapabilitiesSource,
      }),
      [],
    );
  });

  it("fails on the stale never-claim-offline-inference instruction", () => {
    const errors = validatePhotoAnalysisTruth({
      clientCapabilitiesSource: REAL.clientCapabilitiesSource,
      serverCapabilitiesSource:
        `${REAL.serverCapabilitiesSource}\nNever claim the create-report Analyze photo button uses offline inference; its consented path is the connected cloud provider.`,
    });
    ok(errors.some((e) => e.includes("stale cloud-only")), `expected stale-claim complaint, got: ${errors}`);
  });

  it("fails on the stale connected-provider-as-the-photo-path copy", () => {
    const errors = validatePhotoAnalysisTruth({
      clientCapabilitiesSource:
        "With that consent the selected photo is sent to your connected AI provider for that one request.",
      serverCapabilitiesSource: REAL.serverCapabilitiesSource,
    });
    ok(errors.some((e) => e.includes("stale cloud-only")), `expected stale-claim complaint, got: ${errors}`);
  });

  it("fails when local-first engine truth is missing", () => {
    const errors = validatePhotoAnalysisTruth({
      clientCapabilitiesSource: REAL.clientCapabilitiesSource.replace(/local-first/gi, "cloud"),
      serverCapabilitiesSource: REAL.serverCapabilitiesSource,
    });
    ok(errors.some((e) => e.includes("missing required photo truth")), `expected missing-truth complaint, got: ${errors}`);
  });

  it("fails when on-device-only/cloud-only semantics are missing", () => {
    const errors = validatePhotoAnalysisTruth({
      clientCapabilitiesSource: REAL.clientCapabilitiesSource,
      serverCapabilitiesSource: REAL.serverCapabilitiesSource
        .replace(/on-device-only/gi, "offline")
        .replace(/cloud-only/gi, "remote"),
    });
    ok(errors.some((e) => e.includes("missing required photo truth")), `expected missing-truth complaint, got: ${errors}`);
  });
});

describe("validateUserFacingPhotoTruth", () => {
  it("passes on the real About/Help tree", () => {
    deepStrictEqual(
      validateUserFacingPhotoTruth({
        aboutSource: REAL.aboutSource,
        helpSource: REAL.helpSource,
      }),
      [],
    );
  });

  it("fails on stale cloud-only photo phrasing in About copy", () => {
    const errors = validateUserFacingPhotoTruth({
      aboutSource:
        "With your consent a selected report photo is sent to your connected AI provider for suggestions.",
      helpSource: REAL.helpSource,
    });
    ok(errors.some((e) => e.includes("About") && e.includes("stale cloud-only")), `expected About stale-claim complaint, got: ${errors}`);
  });

  it("fails on stale cloud-only photo phrasing in Help copy", () => {
    const errors = validateUserFacingPhotoTruth({
      aboutSource: REAL.aboutSource,
      helpSource:
        "Its consented path is the connected cloud provider for that one request.",
    });
    ok(errors.some((e) => e.includes("Help") && e.includes("stale cloud-only")), `expected Help stale-claim complaint, got: ${errors}`);
  });

  it("fails when About copy loses local-first/fallback semantics", () => {
    const errors = validateUserFacingPhotoTruth({
      aboutSource: REAL.aboutSource.replace(/local-first/gi, "cloud"),
      helpSource: REAL.helpSource,
    });
    ok(errors.some((e) => e.includes("About") && e.includes("missing required photo truth")), `expected About missing-truth complaint, got: ${errors}`);
  });

  it("fails when Help copy loses on-device-only/cloud-only semantics", () => {
    const errors = validateUserFacingPhotoTruth({
      aboutSource: REAL.aboutSource,
      helpSource: REAL.helpSource
        .replace(/on-device-only/gi, "offline")
        .replace(/cloud-only/gi, "remote"),
    });
    ok(errors.some((e) => e.includes("Help") && e.includes("missing required photo truth")), `expected Help missing-truth complaint, got: ${errors}`);
  });
});

describe("checkAiReleaseGate", () => {
  it("passes on the real tree", () => {
    const { passed, results } = checkAiReleaseGate();
    equal(passed, true, JSON.stringify(results.filter((r) => !r.ok), null, 2));
  });
});

describe("validateDescriptorRegistry", () => {
  const base = () => ({
    descriptorsSource: REAL.descriptorsSource,
    serviceSource: REAL.serviceSource,
    modelsSource: REAL.modelsSource,
    runtimesSource: REAL.runtimesSource,
    orchestratorSource: REAL.orchestratorSource,
    interpretersSource: REAL.interpretersSource,
    routeValidationSource: REAL.routeValidationSource,
  });

  it("passes on the real tree", () => {
    deepStrictEqual(validateDescriptorRegistry(base()), []);
  });

  it("fails on positional catalogue indexing in shipped code", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      serviceSource: `${REAL.serviceSource}\nconst id = DOWNLOAD_MODELS[1].modelId;`,
    });
    ok(errors.some((e) => e.includes("catalogue position")), `expected position complaint, got: ${errors}`);
  });

  it("fails on an unapproved production runtime id", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      descriptorsSource: REAL.descriptorsSource.replace(
        'SMOL_VLM_RUNTIME_ID = "smolvlm2-litertlm"',
        'SMOL_VLM_RUNTIME_ID = "llama-cpp"',
      ),
    });
    ok(errors.some((e) => e.includes("llama-cpp")), `expected runtime complaint, got: ${errors}`);
  });

  it("fails on a downloadable entry that is not curated", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      descriptorsSource: REAL.descriptorsSource.replace('trust: "curated"', 'trust: "imported"'),
    });
    ok(errors.some((e) => e.includes("not curated")), `expected curation complaint, got: ${errors}`);
  });

  it("fails when removal loses its fail-closed unknown-runtime default", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      serviceSource: REAL.serviceSource.replace("throw new Error(`No production runtime adapter", "throw new Error(`oops"),
    });
    ok(errors.some((e) => e.includes("fail-closed")), `expected fail-closed complaint, got: ${errors}`);
  });

  it("fails when heavy switches bypass the residency coordinator", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      serviceSource: REAL.serviceSource.replaceAll('coordinator.switchTo("needle"', 'directLoad("needle"'),
    });
    ok(errors.some((e) => e.includes("residency coordinator")), `expected coordinator complaint, got: ${errors}`);
  });

  it("fails when download ignores declared descriptor ABIs", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      serviceSource: REAL.serviceSource.replace("await this.requireCompatible(model);", "void model;"),
    });
    ok(errors.some((e) => e.includes("ignores declared descriptor ABIs")), `expected ABI complaint, got: ${errors}`);
  });

  it("fails when taskRoles never gate runtime selection", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      runtimesSource: REAL.runtimesSource.replaceAll("servesTask", "servesNothing"),
    });
    ok(errors.some((e) => e.includes("never gate runtime selection")), `expected roles complaint, got: ${errors}`);
  });

  it("fails when the generic text runtime parses model output", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      runtimesSource: `${REAL.runtimesSource}\nconst legacy = JSON.parse(raw);`,
    });
    ok(errors.some((e) => e.includes("parses model output")), `expected parse complaint, got: ${errors}`);
  });

  it("fails when a routable task lacks an explicit interpreter", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      interpretersSource: REAL.interpretersSource.replace('taskId: "ground-objects",', 'taskId: "ground-objects-x",'),
    });
    ok(errors.some((e) => e.includes('routable task "ground-objects"')), `expected interpreter complaint, got: ${errors}`);
  });

  it("fails when unlisted tasks fall through to success", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      routeValidationSource: `${REAL.routeValidationSource}\nif (validate === undefined) return { ok: true };`,
    });
    ok(errors.some((e) => e.includes("fall through to success")), `expected fallthrough complaint, got: ${errors}`);
  });

  it("fails when catalogue order picks the default model", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      descriptorsSource: `${REAL.descriptorsSource}\nconst legacy = frozen.find((item) => item.capabilities.includes("vision"));`,
    });
    ok(errors.some((e) => e.includes("catalogue order")), `expected order complaint, got: ${errors}`);
  });
});
