/**
 * ai-release-gate regression tests: the gate must fail on a skeleton tree
 * (production seams absent) and pass on the real tree.
 *
 * Pure validators are exercised with synthetic sources; the real tree is
 * asserted by reading the repo files (this test runs from the repo root in
 * CI: `node --test scripts/ai-release-gate.test.mjs`).
 */
import { deepStrictEqual, equal, ok } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkAiReleaseGate,
  collectShippedSources,
  RETIRED_REPORT_PHOTO_AI_FILES,
  validateDescriptorRegistry,
  validatePhotoAnalysisTruth,
  validateRetiredReportPhotoAi,
  validateReportFieldHelperWired,
  validateUserFacingPhotoTruth,
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
  aiConnectionSource: read("apps/mobile/src/screens/AiConnection.tsx"),
  aiPreferencesSource: read("apps/mobile/src/services/ai/aiPreferences.ts"),
  searchScreenSource: read("apps/mobile/src/screens/SearchScreen.tsx"),
  nlFiltersSource: read("apps/mobile/src/services/search/nlFilters.ts"),
  createReportSource: read("apps/mobile/src/screens/CreateReport.tsx"),
  reportFieldSuggestionsSource: read("apps/mobile/src/services/reportFieldSuggestions.ts"),
  categorySuggestionSource: read("apps/mobile/src/services/categorySuggestion.ts"),
  actionGateSource: read("apps/mobile/src/services/ai/orchestrator/actionGate.ts"),
  routeIntentSource: read("apps/mobile/src/services/ai/ops/routeIntent.ts"),
  intentRouterSource: read("apps/mobile/src/services/ai/ops/intentRouter.ts"),
  chatControllerSource: read("apps/mobile/src/services/ai/chatController.ts"),
  chatStoreSource: read("apps/mobile/src/services/ai/chatStore.ts"),
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
    ["settings model preference display-only (binding removed)", "aiPreferencesSource", (source) => source.replace(/export function createAssistantModelBinding/g, "export function droppedBinding")],
    ["settings model preference display-only (sheet not forwarded)", "aiConnectionSource", (source) => source.replace(/selectedId=\{effectiveSelectedId\}/g, "selectedId={null}")],
    ["settings model preference display-only (selection never persisted)", "aiConnectionSource", (source) => source.replace(/onSelectModel\?\.\(record\.id\)/g, "void record.id")],
    ["Help ignores persisted default selection", "helpSource", (source) => source.replace(/defaultSelection\(accountId\)/g, "null")],
    ["NL search stops importing the validated seam", "searchScreenSource", (source) => source.replace(/services\/search\/nlFilters/g, "services/search/missing")],
    ["SearchScreen stops consuming validated URL query", "searchScreenSource", (source) => source.replace(/useUrlParam\("q"\)/g, 'useUrlParam("zzz")')],
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

describe("validateReportFieldHelperWired", () => {
  it("passes on the retained §11 text→fields helper", () => {
    deepStrictEqual(validateReportFieldHelperWired(REAL), []);
  });

  for (const [label, mutate] of [
    ["helper no longer exposes the field suggester", (s) => ({
      ...s,
      reportFieldSuggestionsSource: s.reportFieldSuggestionsSource.replace(
        /export async function suggestReportFields/g,
        "export async function droppedSuggester",
      ),
    })],
    ["helper drops the released-category guard", (s) => ({
      ...s,
      reportFieldSuggestionsSource: s.reportFieldSuggestionsSource.replace(
        /export function isReleasedCategoryPatch/g,
        "export function droppedGuard",
      ),
    })],
    ["helper is unbound from its reviewed narrow task", (s) => ({
      ...s,
      reportFieldSuggestionsSource: s.reportFieldSuggestionsSource.replace(
        /REPORT_FIELD_SOURCE\s*=\s*"extract-report-fields"/,
        'REPORT_FIELD_SOURCE = "something-else"',
      ),
    })],
    ["CreateReport stops reaching the field suggester", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(/suggestReportFields\(/g, "fakeSuggestFields("),
    })],
    ["CreateReport stops reaching the category suggester", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(/suggestCategoryForText\(/g, "fakeSuggestCategory("),
    })],
    ["suggestions auto-apply without a per-suggestion tap", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(/aiSuggestApplyField\(patch\)/g, "autoApply(patch)"),
    })],
    ["suggestions drop Keep review", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(/Keep mine/g, "Discard mine"),
    })],
    ["suggestions overwrite the existing title without confirmation", (s) => ({
      // Only the title's guard: the other fields' confirmations must not be
      // able to cover for it (CF-070 R2 retry-2 finding 2).
      ...s,
      createReportSource: s.createReportSource.replace(
        'if (!window.confirm("Replace the existing title with this suggestion?")) return;',
        "void 0;",
      ),
    })],
    ["suggestions overwrite the existing date without confirmation", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(
        'if (!window.confirm("Replace the existing date with this suggestion?")) return;',
        "void 0;",
      ),
    })],
    ["suggestions overwrite existing values without any confirmation", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(
        /window\.confirm\("Replace the existing/g,
        'window.confirm("OK',
      ),
    })],
    ["the reviewed narrow task is never invoked", (s) => ({
      // Keeps the export, the source label and the caller: only the executable
      // reviewed-op call is gone (CF-070 R2 retry-2 finding 2).
      ...s,
      reportFieldSuggestionsSource: s.reportFieldSuggestionsSource.replace(
        "const opTask = extractReportFields(generate, userMessage, profile);",
        "const opTask = Promise.resolve<ReturnType<typeof extractReportFields>>({\n  ok: false,\n  error: makeAiError(\"CANCELLED\", \"ABORT_BEFORE_START\"),\n});",
      ),
    })],
    ["one field loses its apply branch", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(
        'patch.field === "date"',
        'patch.field === "dropped"',
      ),
    })],
    ["the category suggestion applies from a shared tap", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(
        /aiSuggestApplyCategory\(aiCatSuggestion\)/g,
        "aiSuggestApplyField(aiCatSuggestion)",
      ),
    })],
    ["suggestions drop the released-category guard at the call site", (s) => ({
      ...s,
      createReportSource: s.createReportSource.replace(/isReleasedCategory\(/g, "fakeReleasedCategory("),
    })],
    ["photo bytes are routed back into the text helper", (s) => ({
      ...s,
      createReportSource: `${s.createReportSource}\nconst sneaky = { imageBase64 };\n`,
    })],
  ]) {
    it(`fails on ${label}`, () => {
      const broken = mutate(REAL);
      ok(validateReportFieldHelperWired(broken).length > 0, label);
    });
  }

  /**
   * CF-070 R2 retry-3 finding 3: the exact 23 mutations the review ran against
   * the full gate while all 14 checks stayed green. Each must now fail, and the
   * requirement that fails must be the binding that owns that mutation rather
   * than a neighbouring string, so a regression to token presence shows up
   * here instead of at release.
   */
  const RETRY_3_SURVIVING_MUTATIONS = [
    ...["title", "description", "date", "category"].map((field) => [
      `the ${field} branch is made unreachable`,
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          `if (patch.field === "${field}") {`,
          `if (false && patch.field === "${field}") {`,
        ),
      }),
      `the ${field} suggestion must have its own reachable apply branch`,
    ]),
    ...[
      ["title", "setTitle(patch.suggestedValue);"],
      ["description", "setDescription(patch.suggestedValue);"],
      ["date", "setEventDate(patch.suggestedValue);"],
      ["category", "setCategory(patch.suggestedValue as Category);"],
    ].map(([field, call]) => [
      `the ${field} setter is deleted from its branch`,
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(call, "void patch.suggestedValue;"),
      }),
      `the ${field} suggestion must apply through`,
    ]),
    ...["title", "description", "date", "category"].map((field) => [
      `the ${field} confirmation is made unreachable`,
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          `if (!window.confirm("Replace the existing ${field} with this suggestion?")) return;`,
          `if (false && !window.confirm("Replace the existing ${field} with this suggestion?")) return;`,
        ),
      }),
      `replacing an existing ${field} must be confirmed by a reachable guard`,
    ]),
    [
      "the title confirmation call is kept but its refusal is dropped",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          'if (!window.confirm("Replace the existing title with this suggestion?")) return;',
          'window.confirm("Replace the existing title with this suggestion?");',
        ),
      }),
      "replacing an existing title must be confirmed by a reachable guard",
    ],
    [
      "the title branch writes the description setter",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource
          .replace("setTitle(patch.suggestedValue);", "setDescription(patch.suggestedValue);"),
      }),
      "the title suggestion must apply through setTitle",
    ],
    [
      "only the separate category path loses its replacement confirmation",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          '    if (category && suggestion.suggestedCategory !== category) {\n      if (!window.confirm("Replace the existing category with this suggestion?")) return;\n    }\n',
          "    void 0;\n",
        ),
      }),
      "replacing an existing category from its own suggestion must be confirmed",
    ],
    [
      "the per-field Apply tap is disconnected",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          "onClick={() => aiSuggestApplyField(patch)}",
          "onClick={() => false && aiSuggestApplyField(patch)}",
        ),
      }),
      "must apply only from an explicit per-suggestion tap",
    ],
    [
      "the category Apply tap returns a function instead of applying",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          "onClick={() => aiSuggestApplyCategory(aiCatSuggestion)}",
          "onClick={() => () => aiSuggestApplyCategory(aiCatSuggestion)}",
        ),
      }),
      "the category suggestion must apply only from its own explicit tap",
    ],
    [
      "the per-field Keep control resolves nothing",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          "onClick={() => aiSuggestResolve(`field:${patch.field}`)}",
          "onClick={() => {}}",
        ),
      }),
      "each Keep control must resolve its own suggestion",
    ],
    [
      "the category Keep control resolves nothing",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          'onClick={() => aiSuggestResolve("categorySuggestion")}',
          "onClick={() => {}}",
        ),
      }),
      "each Keep control must resolve its own suggestion",
    ],
    [
      "the released-category guard in the category patch never rejects",
      (s) => ({
        ...s,
        createReportSource: s.createReportSource.replace(
          "if (!isReleasedCategory(patch.suggestedValue)) return;",
          "if (false && !isReleasedCategory(patch.suggestedValue)) return;",
        ),
      }),
      "the category patch must respect the released-category guard",
    ],
    [
      "the reviewed op runs but its result is discarded",
      (s) => ({
        ...s,
        reportFieldSuggestionsSource: s.reportFieldSuggestionsSource.replace(
          "const opTask = extractReportFields(generate, userMessage, profile);",
          'void extractReportFields(generate, userMessage, profile);\n  const opTask: ReturnType<typeof extractReportFields> = Promise.resolve({\n    ok: false,\n    error: makeAiError("CANCELLED", "DISCONNECTED"),\n  });',
        ),
      }),
      "must use the reviewed narrow task's result",
    ],
    [
      "the reviewed op is invoked inside a branch the compiler can fold away",
      (s) => ({
        ...s,
        reportFieldSuggestionsSource: s.reportFieldSuggestionsSource.replace(
          "const opTask = extractReportFields(generate, userMessage, profile);",
          'const opTask = false\n    ? extractReportFields(generate, userMessage, profile)\n    : Promise.resolve({ ok: false as const, error: makeAiError("CANCELLED", "DISCONNECTED") });',
        ),
      }),
      "must use the reviewed narrow task's result",
    ],
    [
      "the reviewed op survives only as a comment",
      (s) => ({
        ...s,
        reportFieldSuggestionsSource: s.reportFieldSuggestionsSource.replace(
          "const opTask = extractReportFields(generate, userMessage, profile);",
          '// extractReportFields(generate, userMessage, profile)\n  const opTask: ReturnType<typeof extractReportFields> = Promise.resolve({\n    ok: false,\n    error: makeAiError("CANCELLED", "DISCONNECTED"),\n  });',
        ),
      }),
      "must actually invoke the reviewed narrow task",
    ],
  ];

  for (const [label, mutate, expected] of RETRY_3_SURVIVING_MUTATIONS) {
    it(`fails on ${label} (CF-070 R2 retry-3 finding 3)`, () => {
      const errors = validateReportFieldHelperWired(mutate(REAL));
      ok(errors.length > 0, label);
      ok(
        errors.some((error) => error.includes(expected)),
        `${label}: expected ${expected} among ${JSON.stringify(errors)}`,
      );
    });
  }
});

/**
 * CF-070 R2 retry-4 finding 3: the 16 mutations that survived the retry-3
 * binding, plus the six behaviour-preserving rewrites the earlier token checks
 * wrongly rejected. Must-fail cases pin the requirement that owns them;
 * accepted cases must keep the gate green, so a future tightening cannot
 * quietly turn a legitimate spelling into a release blocker.
 */
describe("reportFieldWiring (CF-070 R2 retry-4)", () => {
  const FORM = REAL.createReportSource;
  const HELPER = REAL.reportFieldSuggestionsSource;
  const TITLE_GUARD =
    'if (!window.confirm("Replace the existing title with this suggestion?")) return;';
  const TITLE_BLOCK =
    '      if (title.trim() && patch.suggestedValue !== title) {\n' +
    '        if (!window.confirm("Replace the existing title with this suggestion?")) return;\n' +
    '      }';
  const SETTER = "setTitle(patch.suggestedValue);";
  const TAP = "onClick={() => aiSuggestApplyField(patch)}";
  const FIELD_KEEP = "onClick={() => aiSuggestResolve(`field:${patch.field}`)}";
  const RELGUARD = "if (!isReleasedCategory(patch.suggestedValue)) return;";
  const CAT_TAP = "onClick={() => aiSuggestApplyCategory(aiCatSuggestion)}";
  const FIELD_CMP = 'patch.field === "title"';
  const OP = "const opTask = extractReportFields(generate, userMessage, profile);";
  const OPRESULT_DECL = "let opResult: Awaited<typeof opTask>;";
  const AWAIT_OP = "opResult = await opTask;";

  const replace = (source, from, to, label) => {
    if (!source.includes(from)) throw new Error(`${label}: anchor missing: ${JSON.stringify(from)}`);
    return source.replace(from, to);
  };
  const onForm = (label, from, to) => (s) => ({
    ...s,
    createReportSource: replace(s.createReportSource, from, to, label),
  });
  const onHelper = (label, from, to) => (s) => ({
    ...s,
    reportFieldSuggestionsSource: replace(s.reportFieldSuggestionsSource, from, to, label),
  });

  for (const [label, mutate, expected] of [
    [
      "the confirm guard refuses by returning from a nested IIFE",
      onForm(
        "nested IIFE",
        TITLE_GUARD,
        'if (!window.confirm("Replace the existing title with this suggestion?")) { (function () { return; })(); }',
      ),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "the field Keep control resolves a literal key that is not its own suggestion",
      onForm("Keep literal", FIELD_KEEP, 'onClick={() => aiSuggestResolve("field:title")}'),
      "each Keep control must resolve its own suggestion",
    ],
    [
      "the date patch drops its calendar validation",
      onForm(
        "date validation",
        "if (!isValidCalendarDate(patch.suggestedValue) || isFutureDate(patch.suggestedValue)) return;",
        "void 0;",
      ),
      "the date suggestion must keep its calendar validation before applying",
    ],
    [
      "the op result is stored then only mentioned while a fabricated result is returned",
      onHelper(
        "void opTask",
        OP,
        `${OP}\n  void opTask;\n  return {\n    ok: true,\n    value: { suggestions: [], droppedCategory: false, action: opResultActionPlaceholder() },\n  };`,
      ),
      "must use the reviewed narrow task's result",
    ],
    [
      "the op result is overwritten before use",
      onHelper(
        "overwritten",
        OPRESULT_DECL,
        `${OPRESULT_DECL}\n  opResult = { ok: false as const, error: makeAiError("CANCELLED", "OVERWRITTEN_BEFORE_USE") };`,
      ),
      "must use the reviewed narrow task's result",
    ],
    [
      "the op promise is touched with catch before it is awaited",
      onHelper(
        "catch before await",
        AWAIT_OP,
        'opTask.catch(() => undefined);\n    opResult = await Promise.resolve({ ok: false as const, error: makeAiError("CANCELLED", "ABORT_BEFORE_START") });',
      ),
      "must use the reviewed narrow task's result",
    ],
    [
      "the field patches pass through a transform that returns an empty list",
      onForm(
        "substitutePatches",
        "setAiFieldPatches([...fieldsResult.value.suggestions]);",
        "setAiFieldPatches(substitutePatches(fieldsResult.value.suggestions));",
      ),
      "the reviewed field suggester's result must reach the rendered patch state",
    ],
    [
      "the category suggestion passes through a picker that returns null",
      onForm(
        "pickSuggestion",
        "setAiCatSuggestion(categoryResult.value.suggestion);",
        "setAiCatSuggestion(pickSuggestion(categoryResult.value.suggestion));",
      ),
      "the reviewed category suggester's result must reach the rendered suggestion state",
    ],
    [
      "window.confirm is hijacked to always return true",
      onForm("confirm hijack", TITLE_GUARD, `window.confirm = () => true;\n        ${TITLE_GUARD}`),
      "confirmation must come from the platform dialog",
    ],
    [
      "the whole title confirmation is wrapped in a dead block",
      onForm(
        "dead title block",
        TITLE_BLOCK,
        `      if (false) {\n${TITLE_BLOCK}\n      }`,
      ),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "the released-category guard is wrapped in a dead block",
      onForm("dead category guard", RELGUARD, `if (false) {\n        ${RELGUARD}\n      }`),
      "the category patch must respect the released-category guard before applying",
    ],
    [
      "the released-category guard is moved into a never-taken else branch",
      onForm(
        "never-taken else",
        `      ${RELGUARD}`,
        `      if (patch.field === "category") { /* no-op */ } else if (false) { ${RELGUARD} }`,
      ),
      "the category patch must respect the released-category guard before applying",
    ],
    [
      "the title branch writes an unrelated value through setTitle",
      onForm("wrong title value", SETTER, "setTitle(aiSuggestInput);"),
      "the title suggestion must apply the suggested value, not another one",
    ],
    [
      "the field Keep control resolves an unrelated key",
      onForm("unrelated key", FIELD_KEEP, 'onClick={() => aiSuggestResolve("nope")}'),
      "each Keep control must resolve its own suggestion",
    ],
    [
      "the card renders the suggested value but the tap applies another suggestion",
      onForm(
        "rendered vs applied",
        '<p className="text-sm">{patch.suggestedValue}</p>',
        '<p className="text-sm">{aiCatSuggestion?.suggestedCategory}</p>',
      ),
      "report-field suggestions must render the suggestion they apply",
    ],
    [
      "the category Apply tap passes a different suggestion variable",
      onForm(
        "different category variable",
        CAT_TAP,
        "onClick={() => aiSuggestApplyCategory(aiCatSuggestionForAnotherReport)}",
      ),
      "the category suggestion must apply the category it renders",
    ],
  ]) {
    it(`rejects ${label}`, () => {
      const broken = mutate(REAL);
      ok(broken.createReportSource !== FORM || broken.reportFieldSuggestionsSource !== HELPER, label);
      const errors = validateReportFieldHelperWired(broken);
      ok(errors.length > 0, label);
      ok(
        errors.some((error) => error.includes(expected)),
        `${label}: expected ${expected} among ${JSON.stringify(errors)}`,
      );
    });
  }

  for (const [label, mutate] of [
    [
      "the field id comparison reads a typed const instead of an inline literal",
      (s) => ({
        ...s,
        createReportSource: (() => {
          const renamed = replace(s.createReportSource, FIELD_CMP, "patch.field === TITLE_FIELD", "typed const");
          return replace(
            renamed,
            "export function CreateReport",
            'const TITLE_FIELD = "title" as const;\n\nexport function CreateReport',
            "typed const declaration",
          );
        })(),
      }),
    ],
    [
      "the field id comparison uses `as const`",
      onForm("as const", FIELD_CMP, 'patch.field === ("title" as const)'),
    ],
    [
      "the Keep label is rendered through a JSX expression container",
      onForm(
        "Keep expression container",
        ">\n                    Keep mine\n                  </Button>",
        '>\n                    {"Keep mine"}\n                  </Button>',
      ),
    ],
    [
      "the Keep text is translated but its resolve call is kept",
      onForm(
        "translated Keep",
        ">\n                    Keep mine\n                  </Button>",
        ">\n                    Keep\n                  </Button>",
      ),
    ],
    [
      "the confirm label is built by template literal from the field id",
      onForm(
        "template confirm label",
        TITLE_GUARD,
        "if (!window.confirm(`Replace the existing ${patch.field} with this suggestion?`)) return;",
      ),
    ],
    [
      "the Apply tap is written with a void prefix",
      onForm("void tap", TAP, "onClick={() => void aiSuggestApplyField(patch)}"),
    ],
  ]) {
    it(`accepts the behaviour-preserving rewrite: ${label}`, () => {
      const rewritten = mutate(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
    });
  }
});

describe("reportFieldWiring (CF-070 R2 retry-6: the retry-5 survivors N1-N10)", () => {
  const FORM = REAL.createReportSource;
  const HELPER = REAL.reportFieldSuggestionsSource;
  const TITLE_GUARD =
    'if (!window.confirm("Replace the existing title with this suggestion?")) return;';
  const DATE_GUARD =
    "if (!isValidCalendarDate(patch.suggestedValue) || isFutureDate(patch.suggestedValue)) return;";
  const DATE_SET = "setEventDate(patch.suggestedValue);";
  const FIELD_KEEP = "onClick={() => aiSuggestResolve(`field:${patch.field}`)}";
  const CAT_KEEP = 'onClick={() => aiSuggestResolve("categorySuggestion")}';
  const OP_AWAIT = "  if (!opResult.ok) return opResult;";
  const AWAIT_OP = "opResult = await opTask;";

  const replace = (source, from, to, label) => {
    if (!source.includes(from)) throw new Error(`${label}: anchor missing: ${JSON.stringify(from)}`);
    return source.replace(from, to);
  };
  const onForm = (label, from, to) => (s) => ({
    ...s,
    createReportSource: replace(s.createReportSource, from, to, label),
  });
  const onHelper = (label, from, to) => (s) => ({
    ...s,
    reportFieldSuggestionsSource: replace(s.reportFieldSuggestionsSource, from, to, label),
  });

  for (const [label, mutate, expected] of [
    [
      "N1 the date guard keeps both names but inverts its sense (future dates now apply)",
      onForm(
        "N1 inverted date guard",
        DATE_GUARD,
        "if (!(isValidCalendarDate(patch.suggestedValue) || isFutureDate(patch.suggestedValue))) return;",
      ),
      "the date suggestion must keep its calendar validation before applying",
    ],
    [
      "N1b both operands are negated, so a valid non-future date is refused",
      onForm(
        "N1b double negation",
        DATE_GUARD,
        "if (!isValidCalendarDate(patch.suggestedValue) || !isFutureDate(patch.suggestedValue)) return;",
      ),
      "the date suggestion must keep its calendar validation before applying",
    ],
    [
      "N2 the title confirmation sits inside `if (1 === 2) { … }`",
      onForm("N2 folded comparison", TITLE_GUARD, `if (1 === 2) { ${TITLE_GUARD} }`),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "N2b the dead branch is spelled with two string literals",
      onForm("N2b folded string comparison", TITLE_GUARD, `if ("a" === "b") { ${TITLE_GUARD} }`),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "N3 the awaited result is void-ed, a fabricated result is returned, and the real use is left after it",
      onHelper(
        "N3 unreachable use",
        OP_AWAIT,
        "  void opResult;\n  return {\n    ok: true,\n    value: { suggestions: [], droppedCategory: false, action: opResultActionPlaceholder() },\n  };\n" +
          OP_AWAIT,
      ),
      "must use the reviewed narrow task's result",
    ],
    [
      "N4 the calendar validation is moved below the date write",
      (s) => {
        const withoutGuard = replace(
          s.createReportSource,
          DATE_GUARD,
          "// validation moved below the write",
          "N4 guard removal",
        );
        return {
          ...s,
          createReportSource: replace(withoutGuard, DATE_SET, `${DATE_SET}\n      ${DATE_GUARD}`, "N4 guard move"),
        };
      },
      "the date suggestion must not write the date before its calendar validation",
    ],
    [
      "N4b a second validation runs after the write has already happened",
      onForm("N4b trailing validation", DATE_SET, `${DATE_SET}\n      ${DATE_GUARD}`),
      "the date suggestion must not write the date before its calendar validation",
    ],
    [
      "N5 window.confirm is replaced through element access",
      onForm("N5 element-access hijack", TITLE_GUARD, `window["confirm"] = () => true;\n        ${TITLE_GUARD}`),
      "confirmation must come from the platform dialog",
    ],
    [
      "the refusal keeps working after the return, which is not a refusal at once",
      onForm(
        "work after return",
        TITLE_GUARD,
        'if (!window.confirm("Replace the existing title with this suggestion?")) { return; setTitle(patch.suggestedValue); }',
      ),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
  ]) {
    it(`rejects ${label}`, () => {
      const broken = mutate(REAL);
      ok(broken.createReportSource !== FORM || broken.reportFieldSuggestionsSource !== HELPER, label);
      const errors = validateReportFieldHelperWired(broken);
      ok(errors.length > 0, label);
      ok(
        errors.some((error) => error.includes(expected)),
        `${label}: expected ${expected} among ${JSON.stringify(errors)}`,
      );
    });
  }

  for (const [label, mutate] of [
    [
      "N6 the refusal block carries a no-op statement before the return",
      onForm(
        "N6 no-op before return",
        TITLE_GUARD,
        'if (!window.confirm("Replace the existing title with this suggestion?")) { void 0; return; }',
      ),
    ],
    [
      "N6b the no-op is a discarded literal",
      onForm(
        "N6b literal before return",
        TITLE_GUARD,
        'if (!window.confirm("Replace the existing title with this suggestion?")) { 0; return; }',
      ),
    ],
    [
      "N5 the confirmation is read through element access",
      onForm(
        "N5b element-access guard",
        TITLE_GUARD,
        'if (!window["confirm"]("Replace the existing title with this suggestion?")) return;',
      ),
    ],
    [
      "N1 the date disjunction is written in the other order",
      onForm(
        "N1c reversed operands",
        DATE_GUARD,
        "if (isFutureDate(patch.suggestedValue) || !isValidCalendarDate(patch.suggestedValue)) return;",
      ),
    ],
    [
      "F3 the confirm label is templated from the patch field",
      onForm(
        "F3 templated confirm label",
        TITLE_GUARD,
        'if (!window.confirm(`Replace the existing ${patch.field} with this suggestion?`)) return;',
      ),
    ],
    [
      "F3b the template reads the field through element access",
      onForm(
        "F3b templated confirm label, element access",
        TITLE_GUARD,
        'if (!window.confirm(`Replace the existing ${patch["field"]} with this suggestion?`)) return;',
      ),
    ],
    [
      "N8 the field Keep binds the same field through element access",
      onForm("N8 element access", FIELD_KEEP, 'onClick={() => aiSuggestResolve(`field:${patch["field"]}`)}'),
    ],
    [
      "N9 the field Keep builds its key by string concatenation",
      onForm("N9 concatenation", FIELD_KEEP, 'onClick={() => aiSuggestResolve("field:" + patch.field)}'),
    ],
    [
      "N10 the awaited result is parenthesised",
      onHelper("N10 parenthesised await", AWAIT_OP, "opResult = (await opTask);"),
    ],
    [
      "the category Keep key is written as a typed const cast",
      onForm("category keep cast", CAT_KEEP, 'onClick={() => aiSuggestResolve("categorySuggestion" as const)}'),
    ],
  ]) {
    it(`accepts the behaviour-preserving rewrite: ${label}`, () => {
      const rewritten = mutate(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
    });
  }

  it("still rejects a Keep that resolves a key the card does not own, in either spelling", () => {
    for (const key of ['aiSuggestResolve("field:nope")', 'aiSuggestResolve("field:" + other.field)']) {
      const broken = onForm("unowned keep", FIELD_KEEP, `onClick={() => ${key}}`)(REAL);
      const errors = validateReportFieldHelperWired(broken);
      ok(
        errors.includes("application-integration: each Keep control must resolve its own suggestion"),
        `${key}: ${JSON.stringify(errors)}`,
      );
    }
  });

  it("still rejects a category Keep that resolves a literal other than its own key", () => {
    for (const key of ['aiSuggestResolve("categorySuggestionOther")', 'aiSuggestResolve("field:" + patch.field)']) {
      const broken = onForm("unowned category keep", CAT_KEEP, `onClick={() => ${key}}`)(REAL);
      const errors = validateReportFieldHelperWired(broken);
      ok(
        errors.includes("application-integration: each Keep control must resolve its own suggestion"),
        `${key}: ${JSON.stringify(errors)}`,
      );
    }
  });
});

/**
 * CF-070 R2 retry-7. The retry-6 review authored six mutants that the gate
 * accepted (K1-K6) and two behaviour-preserving rewrites it wrongly rejected
 * (P1, P2). Every fixture below carries its anchor: `replace` throws when the
 * text it rewrites is not in the real source, so a fixture that stops meaning
 * anything fails loudly instead of passing on an unmatchable string.
 */
describe("reportFieldWiring (CF-070 R2 retry-7: the retry-6 survivors K1-K6 and the R6-3 false positives)", () => {
  const FORM = REAL.createReportSource;
  const HELPER = REAL.reportFieldSuggestionsSource;
  const TITLE_GUARD =
    'if (!window.confirm("Replace the existing title with this suggestion?")) return;';
  const FIELD_KEEP = "onClick={() => aiSuggestResolve(`field:${patch.field}`)}";
  const CAT_KEEP = 'onClick={() => aiSuggestResolve("categorySuggestion")}';
  const OP_AWAIT = "  if (!opResult.ok) return opResult;";
  const FINAL_SUGGESTIONS = "      suggestions: built.suggestions,";
  const EXPORT_FORM = "export function CreateReport";

  const replace = (source, from, to, label) => {
    if (!source.includes(from)) throw new Error(`${label}: anchor missing: ${JSON.stringify(from)}`);
    return source.replace(from, to);
  };
  const onForm = (label, from, to) => (s) => ({
    ...s,
    createReportSource: replace(s.createReportSource, from, to, label),
  });
  const onHelper = (label, from, to) => (s) => ({
    ...s,
    reportFieldSuggestionsSource: replace(s.reportFieldSuggestionsSource, from, to, label),
  });
  const declared = (label, from, to, declaration) => (s) => {
    const rewritten = onForm(label, from, to)(s);
    return {
      ...rewritten,
      createReportSource: replace(rewritten.createReportSource, EXPORT_FORM, `${declaration}\n${EXPORT_FORM}`, label),
    };
  };
  /** A "successful" payload that mentions the reviewed result but does not carry it. */
  const fabricated = (before) =>
    `${before}  return {\n    ok: true,\n    value: { suggestions: [], droppedCategory: false, action: opResult.value.action },\n  };\n${OP_AWAIT}`;

  for (const [label, mutate, expected] of [
    [
      "K1 the whole confirmation is inside an IIFE, so Cancel returns from the IIFE",
      onForm("K1 IIFE guard", TITLE_GUARD, `(() => { ${TITLE_GUARD} })();`),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "K2 the confirmation sits in `while (1 === 2) { … }`",
      onForm("K2 folded while", TITLE_GUARD, `while (1 === 2) { ${TITLE_GUARD} }`),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "K2b the same folded loop spelled as a `for`",
      onForm("K2b folded for", TITLE_GUARD, `for (; 1 === 2;) { ${TITLE_GUARD} }`),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "K3 the guard lives in a helper, so Cancel returns from askConfirm()",
      onForm(
        "K3 guard helper",
        TITLE_GUARD,
        `const askConfirm = () => { ${TITLE_GUARD} };\n        askConfirm();`,
      ),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "K4 the helper reads opResult only for .action and returns fabricated suggestions",
      onHelper("K4 fabricated early return", OP_AWAIT, fabricated("")),
      "must use the reviewed narrow task's result",
    ],
    [
      "K5 the only read of opResult is inside `if (1 === 2)`, then a fabricated result is returned",
      onHelper(
        "K5 folded read",
        OP_AWAIT,
        fabricated("  if (1 === 2) { void opResult.value.fields; }\n"),
      ),
      "must use the reviewed narrow task's result",
    ],
    [
      "K6 the title refusal voids an unrelated field's write before returning",
      onForm(
        "K6 unrelated write",
        TITLE_GUARD,
        'if (!window.confirm("Replace the existing title with this suggestion?")) { void setDescription(""); return; }',
      ),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "K6b the title refusal voids the SAME setter's write before returning",
      onForm(
        "K6b same write",
        TITLE_GUARD,
        "if (!window.confirm(\"Replace the existing title with this suggestion?\")) { void setTitle(patch.suggestedValue); return; }",
      ),
      "replacing an existing title must be confirmed by a reachable guard that refuses",
    ],
    [
      "K4b the success payload replaces the built suggestions with an empty array, with no dead code",
      onHelper("K4b empty payload", FINAL_SUGGESTIONS, "      suggestions: [],"),
      "must use the reviewed narrow task's result",
    ],
    [
      "K4c the success payload drops the suggestions field entirely",
      onHelper(
        "K4c dropped payload",
        FINAL_SUGGESTIONS,
        "      droppedCategory: built.droppedCategory,",
      ),
      "must use the reviewed narrow task's result",
    ],
  ]) {
    it(`rejects ${label}`, () => {
      const broken = mutate(REAL);
      ok(broken.createReportSource !== FORM || broken.reportFieldSuggestionsSource !== HELPER, label);
      const errors = validateReportFieldHelperWired(broken);
      ok(errors.length > 0, label);
      ok(
        errors.some((error) => error.includes(expected)),
        `${label}: expected ${expected} among ${JSON.stringify(errors)}`,
      );
    });
  }

  for (const [label, mutate] of [
    [
      "P1 the confirm label is a const-bound string",
      declared(
        "P1 const confirm label",
        TITLE_GUARD,
        "if (!window.confirm(TITLE_CONFIRM_LABEL)) return;",
        'const TITLE_CONFIRM_LABEL = "Replace the existing title with this suggestion?";',
      ),
    ],
    [
      "P1b the const-bound confirm label is written `as const`",
      declared(
        "P1b const confirm label as const",
        TITLE_GUARD,
        "if (!window.confirm(TITLE_CONFIRM_LABEL)) return;",
        'const TITLE_CONFIRM_LABEL = "Replace the existing title with this suggestion?" as const;',
      ),
    ],
    [
      "P2 the category Keep key is a const-bound string",
      declared(
        "P2 const category key",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'const CAT_KEEP_KEY = "categorySuggestion";',
      ),
    ],
    [
      "P2b the const-bound category Keep key is written `as const`",
      declared(
        "P2b const category key as const",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'const CAT_KEEP_KEY = "categorySuggestion" as const;',
      ),
    ],
    [
      "N6 the refusal block keeps a side-effect-free `void` read in front of the return",
      onForm(
        "N6c void read before return",
        TITLE_GUARD,
        'if (!window.confirm("Replace the existing title with this suggestion?")) { void patch.suggestedValue; return; }',
      ),
    ],
    [
      "N7 the refusal block keeps its single bare return",
      onForm(
        "N7b bare return block",
        TITLE_GUARD,
        'if (!window.confirm("Replace the existing title with this suggestion?")) { return; }',
      ),
    ],
    [
      "P3 the field Keep key stays templated from the patch field",
      onForm("P3 field key template", FIELD_KEEP, FIELD_KEEP),
    ],
  ]) {
    it(`accepts the behaviour-preserving rewrite: ${label}`, () => {
      const rewritten = mutate(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
    });
  }

  it("still rejects a confirmation whose label names no field", () => {
    const broken = onForm(
      "unrelated confirm label",
      TITLE_GUARD,
      'if (!window.confirm("Are you sure?")) return;',
    )(REAL);
    const errors = validateReportFieldHelperWired(broken);
    ok(
      errors.includes("application-integration: replacing an existing title must be confirmed by a reachable guard that refuses"),
      JSON.stringify(errors),
    );
  });
});

describe("reportFieldWiring (CF-070 R2 retry-8: the seven retry-7 survivors and the P-4 label import)", () => {
  const FORM = REAL.createReportSource;
  const TITLE_GUARD =
    'if (!window.confirm("Replace the existing title with this suggestion?")) return;';
  const CAT_KEEP = 'onClick={() => aiSuggestResolve("categorySuggestion")}';
  const EXPORT_FORM = "export function CreateReport";
  const REPORT_FORM = "function ReportForm() {";
  const SUCCESS_PAYLOAD = [
    "  const built = buildReportFieldSuggestions(opResult.value.fields);",
    "  return {",
    "    ok: true,",
    "    value: {",
    "      suggestions: built.suggestions,",
    "      droppedCategory: built.droppedCategory,",
    "      action: opResult.value.action,",
    "    },",
    "  };",
  ].join("\n");

  const replace = (source, from, to, label) => {
    if (!source.includes(from)) throw new Error(`${label}: anchor missing: ${JSON.stringify(from)}`);
    return source.replace(from, to);
  };
  const onForm = (label, from, to) => (s) => ({
    ...s,
    createReportSource: replace(s.createReportSource, from, to, label),
  });
  const onHelper = (label, from, to) => (s) => ({
    ...s,
    reportFieldSuggestionsSource: replace(s.reportFieldSuggestionsSource, from, to, label),
  });
  const declared = (label, from, to, declaration) => (s) => {
    const rewritten = onForm(label, from, to)(s);
    return {
      ...rewritten,
      createReportSource: replace(rewritten.createReportSource, EXPORT_FORM, `${declaration}\n${EXPORT_FORM}`, label),
    };
  };
  /** The same const, declared in the component that renders the cards. */
  const declaredInForm = (label, from, to, declaration) => (s) => {
    const rewritten = onForm(label, from, to)(s);
    return {
      ...rewritten,
      createReportSource: replace(
        rewritten.createReportSource,
        REPORT_FORM,
        `${REPORT_FORM}\n  ${declaration}`,
        label,
      ),
    };
  };

  const WRITE_BEFORE_GUARD =
    "the title suggestion must not write a reviewed field before its confirmation guard";
  const UNREACHABLE_GUARD =
    "replacing an existing title must be confirmed by a reachable guard that refuses";
  const DISCARDED = "report-field helper must use the reviewed narrow task's result, not merely mention the call";
  const KEEP_RESOLVES = "each Keep control must resolve its own suggestion";

  for (const [label, mutate, expected] of [
    [
      "A the title branch writes another reviewed field before its still-valid guard",
      onForm("A stray description write", TITLE_GUARD, `setDescription("");\n        ${TITLE_GUARD}`),
      WRITE_BEFORE_GUARD,
    ],
    [
      "B the confirmation sits after a `break` inside `while (true) { … }`",
      onForm("B while-true break", TITLE_GUARD, `while (true) { break; ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B2 the same after a `break` inside `for (;;) { … }`",
      onForm("B2 for-empty break", TITLE_GUARD, `for (;;) { break; ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "C the payload slices the reviewed suggestions to nothing",
      onHelper(
        "C suggestions sliced",
        "      suggestions: built.suggestions,",
        "            suggestions: built.suggestions.slice(0, 0),",
      ),
      DISCARDED,
    ],
    [
      "C2 the payload filters the reviewed suggestions to nothing",
      onHelper(
        "C2 suggestions filtered",
        "      suggestions: built.suggestions,",
        "            suggestions: built.suggestions.filter(() => false),",
      ),
      DISCARDED,
    ],
    [
      "D the fabricated payload is handed back through a `const`",
      onHelper(
        "D payload via const",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  const manufactured = { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } };",
          "  return manufactured;",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "E the Keep key is a `let` bound to the reviewed string, then reassigned",
      declared(
        "E keep key reassigned",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'let CAT_KEEP_KEY = "categorySuggestion";\nCAT_KEEP_KEY = "nope";',
      ),
      KEEP_RESOLVES,
    ],
  ]) {
    it(`refuses the retry-7 survivor: ${label}`, () => {
      const rewritten = mutate(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.includes(`application-integration: ${expected}`), JSON.stringify(errors));
    });
  }

  for (const [label, mutate] of [
    [
      "P-1 the confirm label is a const bound to the literal",
      declared(
        "P1 confirm label const",
        TITLE_GUARD,
        "if (!window.confirm(TITLE_CONFIRM_LABEL)) return;",
        'const TITLE_CONFIRM_LABEL = "Replace the existing title with this suggestion?";',
      ),
    ],
    [
      "P-2 the category Keep key is a const bound with `as const`",
      declared(
        "P2 keep key const",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CATEGORY_KEEP_KEY)}",
        'const CATEGORY_KEEP_KEY = "categorySuggestion" as const;',
      ),
    ],
    [
      "P-3 the category Keep key is a const declared in the card's own component",
      declaredInForm(
        "P3 keep key component const",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(LOCAL_KEEP_KEY)}",
        'const LOCAL_KEEP_KEY = "categorySuggestion";',
      ),
    ],
  ]) {
    it(`accepts the behaviour-preserving rewrite: ${label}`, () => {
      const rewritten = mutate(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
    });
  }

  /**
   * The P-4 class: the confirm label is imported from a sibling copy module.
   * A readable relative module is resolved and the rewrite is accepted; a
   * specifier whose target the gate cannot read stays refused, which is the
   * recorded residual (refusing a behaviour-preserving spelling is a nit,
   * accepting an unread one would be a hole).
   */
  const importedLabel = (dir) => ({
    ...REAL,
    createReportPath: join(dir, "CreateReport.tsx"),
    createReportSource: replace(
      replace(FORM, TITLE_GUARD, "if (!window.confirm(TITLE_REPLACE_LABEL)) return;", "P4 guard"),
      "import {",
      'import { TITLE_REPLACE_LABEL } from "./aiSuggestCopy";\nimport {',
      "P4 import",
    ),
  });

  it("accepts 'the confirm label is imported from a readable sibling module' (R6-3/P-4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf070-r8-import-"));
    writeFileSync(
      join(dir, "aiSuggestCopy.ts"),
      'export const TITLE_REPLACE_LABEL = "Replace the existing title with this suggestion?";\n',
    );
    deepStrictEqual(validateReportFieldHelperWired(importedLabel(dir)), [], "P4 readable sibling");
  });

  it("still refuses the same import when the module it names cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf070-r8-missing-"));
    const errors = validateReportFieldHelperWired(importedLabel(dir));
    ok(errors.includes(`application-integration: ${UNREACHABLE_GUARD}`), JSON.stringify(errors));
  });

  it("still refuses a Keep key bound to a string the card does not own, however it is bound", () => {
    const broken = declared(
      "mismatched keep const",
      CAT_KEEP,
      "onClick={() => aiSuggestResolve(WRONG_KEEP_KEY)}",
      'const WRONG_KEEP_KEY = "categorySuggestionElsewhere";',
    )(REAL);
    const errors = validateReportFieldHelperWired(broken);
    ok(errors.includes(`application-integration: ${KEEP_RESOLVES}`), JSON.stringify(errors));
  });
});

/**
 * CF-070 R2 retry-9. The retry-8 review authored nine fresh spellings of the
 * same four harm classes the retry-8 tightenings target (A4 aliased setter;
 * B4-B7 statically-empty / statically-false loops; C6 spread-overwrite of the
 * reviewed payload; D2-D4 `let`/`var`/spread fabricated payloads) and seven
 * behaviour-preserving rewrites the retry-8 tightenings wrongly refused
 * (P5/P8 `let`-bound key never written; P9/P10 defensive payload copies;
 * Q1-Q3 binding-resolution shapes). Every fixture below carries its anchor:
 * `replace` throws when the text it rewrites is not in the real source, so a
 * fixture that stops meaning anything fails loudly instead of passing on an
 * unmatchable string.
 */
describe("reportFieldWiring (CF-070 R2 retry-9: the nine fresh survivors and the P5-P10/Q1-Q3 rewrites)", () => {
  const TITLE_GUARD =
    'if (!window.confirm("Replace the existing title with this suggestion?")) return;';
  const CAT_KEEP = 'onClick={() => aiSuggestResolve("categorySuggestion")}';
  const EXPORT_FORM = "export function CreateReport";
  const REPORT_FORM = "function ReportForm() {";
  const SUCCESS_ANCHOR = "      suggestions: built.suggestions,";
  const SUCCESS_PAYLOAD = [
    "  const built = buildReportFieldSuggestions(opResult.value.fields);",
    "  return {",
    "    ok: true,",
    "    value: {",
    "      suggestions: built.suggestions,",
    "      droppedCategory: built.droppedCategory,",
    "      action: opResult.value.action,",
    "    },",
    "  };",
  ].join("\n");

  const replace = (source, from, to, label) => {
    if (!source.includes(from)) throw new Error(`${label}: anchor missing: ${JSON.stringify(from)}`);
    return source.replace(from, to);
  };
  const onForm = (label, from, to) => (s) => ({
    ...s,
    createReportSource: replace(s.createReportSource, from, to, label),
  });
  const onHelper = (label, from, to) => (s) => ({
    ...s,
    reportFieldSuggestionsSource: replace(s.reportFieldSuggestionsSource, from, to, label),
  });
  const declared = (label, from, to, declaration) => (s) => {
    const rewritten = onForm(label, from, to)(s);
    return {
      ...rewritten,
      createReportSource: replace(rewritten.createReportSource, EXPORT_FORM, `${declaration}\n${EXPORT_FORM}`, label),
    };
  };
  const declaredInForm = (label, from, to, declaration) => (s) => {
    const rewritten = onForm(label, from, to)(s);
    return {
      ...rewritten,
      createReportSource: replace(
        rewritten.createReportSource,
        REPORT_FORM,
        `${REPORT_FORM}\n  ${declaration}`,
        label,
      ),
    };
  };

  const WRITE_BEFORE_GUARD =
    "the title suggestion must not write a reviewed field before its confirmation guard";
  const UNREACHABLE_GUARD =
    "replacing an existing title must be confirmed by a reachable guard that refuses";
  const DISCARDED = "report-field helper must use the reviewed narrow task's result, not merely mention the call";

  for (const [label, mutate, expected] of [
    [
      "A4 the title branch writes through a local alias of a reviewed setter before its guard",
      onForm(
        "A4 aliased setter before guard",
        TITLE_GUARD,
        `const wipe = setDescription;\n        wipe("");\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "B4 the confirmation sits in a loop over an empty array literal",
      onForm("B4 for-of empty array", TITLE_GUARD, `for (const _skip of []) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B5 the confirmation sits in a `for` whose condition counts from zero to zero",
      onForm("B5 for count zero", TITLE_GUARD, `for (let i = 0; i < 0; i += 1) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B6 the confirmation sits in `while (1 - 1)`",
      onForm("B6 folded while arithmetic", TITLE_GUARD, `while (1 - 1) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B7 the confirmation sits in `while (Boolean(false))`",
      onForm("B7 folded while boolean", TITLE_GUARD, `while (Boolean(false)) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "C6 the payload spreads the reviewed result then overwrites its suggestions with an empty list",
      onHelper(
        "C6 spread then empty",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  const shipped = { ...built, suggestions: [] };",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: shipped.suggestions,",
          "      droppedCategory: shipped.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "D2 the fabricated payload is handed back through a `let`",
      onHelper(
        "D2 fabricated let",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  let manufactured = { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } };",
          "  return manufactured;",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "D3 the fabricated payload is handed back through a `var`",
      onHelper(
        "D3 fabricated var",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  var manufactured = { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } };",
          "  return manufactured;",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "D4 the fabricated payload is spread into the returned object",
      onHelper(
        "D4 fabricated spread return",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  const manufactured = { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } };",
          "  return { ...manufactured };",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "B5b the confirmation sits in a nested `for` whose condition counts from zero to zero",
      onForm(
        "B5b nested for count zero",
        TITLE_GUARD,
        `for (let i = 0; i < 0; i += 1) { if (i > 0) ${TITLE_GUARD} }`,
      ),
      UNREACHABLE_GUARD,
    ],
    [
      "B8 the confirmation sits in a loop over an empty string literal",
      onForm("B8 for-of empty string", TITLE_GUARD, `for (const _c of "") { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      'B9 the confirmation sits in `while ("")`',
      onForm("B9 while empty string", TITLE_GUARD, `while ("") { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "C3 the payload concatenates the reviewed suggestions onto an empty array",
      onHelper("C3 concat empty", SUCCESS_ANCHOR, "            suggestions: [].concat(built.suggestions as never),"),
      DISCARDED,
    ],
    [
      "D5 the fabricated payload is returned from a branch while the reviewed result is only echoed",
      onHelper(
        "D5 fabricated conditional return",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  if (opResult.ok) { return { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } }; }",
          "  return built;",
        ].join("\n"),
      ),
      DISCARDED,
    ],
  ]) {
    it(`refuses the fresh survivor: ${label}`, () => {
      const rewritten = mutate(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.includes(`application-integration: ${expected}`), JSON.stringify(errors));
    });
  }

  for (const [label, mutate] of [
    [
      "P5 the Keep key is a module `let` bound to the reviewed string and never written",
      declared(
        "P5 module let keep key",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'let CAT_KEEP_KEY = "categorySuggestion";',
      ),
    ],
    [
      "P8 the Keep key is a `let` declared in the card's own component and never written",
      declaredInForm(
        "P8 component let keep key",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(LOCAL_KEEP_KEY)}",
        'let LOCAL_KEEP_KEY = "categorySuggestion";',
      ),
    ],
    [
      "P9 the payload is a defensive spread copy of the reviewed list",
      onHelper("P9 defensive spread copy", SUCCESS_ANCHOR, "      ...built,\n      suggestions: [ ...built.suggestions ],"),
    ],
    [
      "P10 the payload maps the reviewed list into a fresh copy of each item",
      onHelper("P10 map copy", SUCCESS_ANCHOR, "      suggestions: built.suggestions.map((s) => ({ ...s })),"),
    ],
    [
      "Q1 the Keep key is declared once at module scope and shadowed by an unrelated local",
      declared(
        "Q1 shadowed duplicate const",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'const CAT_KEEP_KEY = "categorySuggestion";\nfunction shadow() { const CAT_KEEP_KEY = "categorySuggestion"; return CAT_KEEP_KEY; }\nvoid shadow;',
      ),
    ],
    [
      "Q2 the Keep key resolves the literal through one alias `const`",
      declared(
        "Q2 alias const",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_ALIAS)}",
        'const CAT_KEEP_KEY = "categorySuggestion";\nconst CAT_KEEP_ALIAS = CAT_KEEP_KEY;',
      ),
    ],
    [
      "Q3 a same-named parameter is written in an unrelated function",
      declared(
        "Q3 param written elsewhere",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'const CAT_KEEP_KEY = "categorySuggestion";\nfunction unrelated(CAT_KEEP_KEY: string) { CAT_KEEP_KEY = "x"; }\nvoid unrelated;',
      ),
    ],
  ]) {
    it(`accepts the behaviour-preserving rewrite: ${label}`, () => {
      const rewritten = mutate(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
    });
  }
});

describe("validateRetiredReportPhotoAi", () => {
  const realMissingFiles = () =>
    RETIRED_REPORT_PHOTO_AI_FILES.map((file) => ({ file, present: false }));
  const realShippedSources = () =>
    collectShippedSources(resolve(REPO_ROOT, "apps/mobile/src")).map((entry) => ({
      file: `apps/mobile/src/${entry.file}`,
      source: entry.source,
    }));

  it("passes on the real tree (removed files stay removed, nothing imports them)", () => {
    deepStrictEqual(
      validateRetiredReportPhotoAi({
        missingFiles: realMissingFiles(),
        shippedSources: realShippedSources(),
      }),
      [],
    );
  });

  it("catches a retired module reappearing in the tree", () => {
    const errors = validateRetiredReportPhotoAi({
      missingFiles: RETIRED_REPORT_PHOTO_AI_FILES.map((file) => ({
        file,
        present: file.endsWith("photoGrounding.ts"),
      })),
      shippedSources: [],
    });
    ok(errors.some((e) => e.includes("photoGrounding.ts")), `expected file complaint, got: ${errors}`);
  });

  for (const [label, source] of [
    ["a static named import", 'import { analyzeReportPhoto } from "../services/analyzeReportPhoto";'],
    ["a side-effect import", 'import "../services/analyzeReportPhoto";'],
    ["a default import of a retired component", 'import Retired from "../components/VlmSuggestions";'],
    ["a dynamic import", 'const old = await import("../services/assistant/searchFilterMapping");'],
    ["a require call", 'const mod = require("../services/livePhotoGrounding");'],
    ["a re-export", 'export { groundObjects } from "../services/ai/ops/groundObjects";'],
    ["a JSX mount of a retired surface", "export const X = () => <PhotoGrounding file={f} onPick={p} />;"],
    ["a JSX mount through a renamed local import", 'import Retired from "../components/VlmSuggestions";\nexport const X = () => <Retired />;'],
    ["a call to a retired entry point", "const target = mapAssistantSearchFilters(fields);"],
    ["a grounding transport call", "const go = async () => { await groundReportPhoto({ imageUri }); };"],
    // CF-070 R2 retry-3 finding 4: the literal and member forms the scan missed.
    ["a template-literal dynamic import", "const p = import(`../services/analyzeReportPhoto`);"],
    ["a template-literal require", "const p = require(`../services/analyzeReportPhoto`);"],
    [
      "a member mount of a retired surface",
      "const Legacy = { VlmSuggestions: () => null };\nexport const X = () => <Legacy.VlmSuggestions/>;",
    ],
    [
      "a member call of a retired entry point",
      "const Legacy = { analyzeReportPhoto: async () => [] };\nvoid Legacy.analyzeReportPhoto();",
    ],
    [
      "an element-access call of a retired entry point",
      'const Legacy = { analyzeReportPhoto: async () => [] };\nvoid Legacy["analyzeReportPhoto"]();',
    ],
    [
      "a retired entry-point name rebound to a local",
      "const analyzeReportPhoto = async () => [];\nconst run = analyzeReportPhoto; void run();",
    ],
    // CF-070 R2 retry-4: the element-access JSX mount the parser rejects, so the
    // token scan has to catch it.
    [
      "an element-access JSX mount of a retired surface",
      'const Legacy = { VlmSuggestions: () => null };\nexport const X = () => <Legacy["VlmSuggestions"]/>;',
    ],
    [
      "an element-access JSX mount with a single-quoted member",
      "const Legacy = { PhotoGrounding: () => null };\nexport const X = () => <Legacy['PhotoGrounding']/>;",
    ],
  ]) {
    it(`catches ${label}`, () => {
      const errors = validateRetiredReportPhotoAi({
        missingFiles: realMissingFiles(),
        shippedSources: [{ file: "apps/mobile/src/screens/Somewhere.tsx", source }],
      });
      ok(errors.length > 0, `${label} -> ${JSON.stringify(errors)}`);
    });
  }

  for (const [label, source] of [
    [
      "a comment that names the removal",
      "// Stale-drop is the caller's job (generation token, like other async seams):\n// the photo path (analyzeReportPhoto / photoGrounding) was removed in CF-020 §12.",
    ],
    [
      "a commented-out retired call",
      "// Old code was: mapAssistantSearchFilters(fields);\nconst unchanged = 1;",
    ],
    [
      "a doc comment naming a retired module path",
      '/* see services/assistant/searchFilterMapping.ts before restoring this */\nexport const unchanged = 1;',
    ],
    [
      "a string that merely names a retired module",
      'const note = "analyzeReportPhoto was removed";\nexport const unchanged = note;',
    ],
    [
      "a template literal that merely names a retired module",
      "const note = `analyzeReportPhoto was removed`;\nexport const unchanged = note;",
    ],
    [
      "a member call on an unrelated object",
      "const tools = { analyze: async () => [] };\nvoid tools.analyze();",
    ],
    [
      "a generic type argument that names a retired surface",
      'type Views = Partial<Record["VlmSuggestions"]>;\nexport const unchanged: Views = {};',
    ],
    [
      "a computed element access on a local",
      'const row: Record<string, number> = { VlmSuggestions: 1 };\nexport const hit = row["VlmSuggestions"];',
    ],
  ]) {
    it(`does not flag ${label}`, () => {
      const errors = validateRetiredReportPhotoAi({
        missingFiles: realMissingFiles(),
        shippedSources: [{ file: "apps/mobile/src/screens/Somewhere.tsx", source }],
      });
      deepStrictEqual(errors, [], JSON.stringify(errors));
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

  it("cannot borrow required fields from unrelated Advanced descriptors", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      descriptorsSource: REAL.descriptorsSource.replace('consumerTitle: "Local text tools",', ""),
    });
    ok(errors.some((e) => e.includes("NEEDLE_DESCRIPTOR") && e.includes("consumerTitle")), `expected per-model field complaint, got: ${errors}`);
  });

  it("accepts the pinned Qwen template URL but refuses a missing or insecure download URL", () => {
    deepStrictEqual(validateDescriptorRegistry(base()), []);
    for (const replacement of ['url: "",', 'url: "http://example.invalid/model",']) {
      const errors = validateDescriptorRegistry({
        ...base(),
        descriptorsSource: REAL.descriptorsSource.replace(/url: `https:[^\n]+/, replacement),
      });
      ok(errors.some((e) => e.includes("QWEN_TEXT_DESCRIPTOR") && e.includes("url")), `expected Qwen URL complaint, got: ${errors}`);
    }
  });

  it("cannot borrow executable ABIs from another model", () => {
    const errors = validateDescriptorRegistry({
      ...base(),
      descriptorsSource: REAL.descriptorsSource.replace('abis: ["arm64-v8a"],', "abis: [],"),
    });
    ok(errors.some((e) => e.includes("NEEDLE_DESCRIPTOR") && e.includes("ABI")), `expected per-model ABI complaint, got: ${errors}`);
  });

  it("fails closed on expressions, spreads, and untyped descriptor metadata", () => {
    const mutations = [
      REAL.descriptorsSource.replace("downloadable: true", "downloadable: (true)").replace('trust: "curated"', 'trust: "imported"'),
      REAL.descriptorsSource.replace('trust: "curated",', 'trust: "curated", ...{ trust: "imported" },'),
      REAL.descriptorsSource.replace('trust: "curated",', 'trust: "curated", ["tr" + "ust"]: "imported",'),
      REAL.descriptorsSource.replace('license: "redistributable-cactus",', 'license: "redistributable-cactus", ["li" + "cense"]: "lfm-1.0-eval-only",'),
      REAL.descriptorsSource.replace('runtimeId: NEEDLE_RUNTIME_ID,', 'runtimeId: (() => "unapproved-runtime")(),'),
      REAL.descriptorsSource.replace('format: "cact",', 'format: (() => "unapproved-format")(),'),
      REAL.descriptorsSource.replace('${QWEN_PIN.revision}', '${untrustedFunction()}'),
      REAL.descriptorsSource.replace('license: "redistributable-cactus"', 'license: ""'),
      REAL.descriptorsSource.replace('license: "redistributable-cactus"', 'license: "redistributable-lfm-1.0"'),
      REAL.descriptorsSource.replace("sha256: NEEDLE_PIN.sha256", 'sha256: ""'),
      REAL.descriptorsSource.replace("NEEDLE_DESCRIPTOR: ModelDescriptor", "NEEDLE_DESCRIPTOR").replace('trust: "curated"', 'trust: "imported"'),
    ];
    for (const descriptorsSource of mutations) {
      const errors = validateDescriptorRegistry({ ...base(), descriptorsSource });
      ok(errors.length > 0, "hostile mutation must fail closed");
    }
  });

  it("never resolves mutable runtime or format aliases as canonical constants", () => {
    for (const kind of ["let", "var"]) {
      for (const [field, original, initial] of [
        ["runtimeId", "NEEDLE_RUNTIME_ID", "needle-cact"],
        ["format", '"cact"', "cact"],
      ]) {
        const descriptorsSource = `${kind} mutableAlias = "${initial}"; mutableAlias = "unapproved";\n` +
          REAL.descriptorsSource.replace(`${field}: ${original},`, `${field}: mutableAlias,`);
        const errors = validateDescriptorRegistry({ ...base(), descriptorsSource });
        ok(errors.some((e) => e.includes("NEEDLE_DESCRIPTOR") && e.includes(field)), `mutable ${kind} ${field} must fail closed`);
      }
    }
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
