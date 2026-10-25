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
  modelsSource: read("apps/mobile/src/screens/DownloadedModels.tsx"),
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

  for (const [label, key, mutate, expected] of [
    ["legacy catalogue mounting", "appSource", (s) => s.replace('path="/ai-models" element={<Navigate to="/settings/local-intelligence" replace />}', 'path="/ai-models" element={<AiModelsRoute />}'), "legacy models routes must redirect to Local intelligence"],
    ["missing canonical manager route", "appSource", (s) => s.replace("<DownloadedModels />", "<AiModelsRoute />"), "downloaded models route must mount its canonical manager"],
    ["disconnected helper lifecycle", "modelsSource", (s) => s.replace("service[action](modelId)", "fakeService[action](modelId)"), "helper actions must use the canonical service"],
    ["disconnected removal", "modelsSource", (s) => s.replace("service.remove(target.modelId)", "fakeService.remove(target.modelId)"), "removal must use the canonical service"],
  ]) {
    it(`rejects ${label} for its own concrete reason`, () => {
      const changed = mutate(REAL[key]);
      ok(changed !== REAL[key], `${label} mutation did not apply`);
      const errors = validateApplicationIntegration({ ...REAL, [key]: changed });
      ok(errors.some((error) => error.includes(expected)), `${label}: ${errors.join("\n")}`);
    });
  }
});

describe("validateReportFieldHelperWired", () => {
  it("passes on the retained §11 text→fields helper", () => {
    deepStrictEqual(validateReportFieldHelperWired(REAL), []);
  });

  describe("R5 bounded callback effects and exits", () => {
  const SUCCESS_ANCHOR = "      suggestions: built.suggestions,";
  const DISCARDED = "report-field helper must use the reviewed narrow task's result, not merely mention the call";
  const onHelper = (label, from, to) => (sources) => {
    equal(sources.reportFieldSuggestionsSource.split(from).length - 1, 1, `${label}: unique anchor`);
    return { ...sources, reportFieldSuggestionsSource: sources.reportFieldSuggestionsSource.replace(from, to) };
  };
  // R5: each refusal is a hole in R4's exit/value/effect reasoning, not a source-text pin.
  for (const [label, callback] of [
    ["R5-1 trailing empty switch clause", '(s) => { switch (s.field) { default: return s; case "title": } }'],
    ["R5-2 sparse array has no for-in keys", '(s) => { for (const key in [,]) { return s; } }'],
    ["R5-3 later for-of entry is fabricated", '(s) => { for (const x of [s, { ...s, suggestedValue: "REPLACED" }]) { if (x.suggestedValue === "REPLACED") return x; } return s; }'],
    ["R5-4 aggregate argument aliases element", '(s) => { const alter = ({ row }) => { row.suggestedValue = "REPLACED"; }; alter({ row: s }); return s; }'],
    ["R5-5 local aggregate aliases element", '(s) => { const box = { row: s }; box.row.suggestedValue = "REPLACED"; return s; }'],
    ["R5-6 array destructuring aliases element", '(s) => { const [row] = [s]; row.suggestedValue = "REPLACED"; return s; }'],
    ["R5-7 unread call in condition closes over element", '(s) => { const alter = () => { const box = [s]; box[0].suggestedValue = "REPLACED"; }; if (alter()) return s; return s; }'],
    ["R5-8 new expression can mutate aggregate argument", '(s) => { new Alter({ row: s }); return s; }'],
    ["R5-9 tagged template can mutate aggregate argument", '(s) => { alter`${{ row: s }}`; return s; }'],
    ["R5-10 property increment through aggregate alias", '(s) => { const box = { row: s }; box.row.confidence++; return s; }'],
    ["R5-11 property delete through aggregate alias", '(s) => { const box = { row: s }; delete box.row.suggestedValue; return s; }'],
    ["R5-12 assign target hides alias", '(s) => { const box = { row: s }; Object.assign(box.row, { suggestedValue: "REPLACED" }); return s; }'],
    ["R5-13 shadowed Object.assign is not the builtin", '(s) => { const Object = { assign: (_target, row) => { row.suggestedValue = "REPLACED"; } }; Object.assign({}, s); return s; }'],
    ["R5-14 concise body also checks effects", '(s) => Object.assign({ ...s }, { suggestedValue: (mutate({ row: s }), s.suggestedValue) })'],
    ["R5-15 for-of ordinary object is not iterable", '(s) => { for (const key of { row: s }) { return s; } }'],
    ["R5-16 for-of writes an existing holder", '(s) => { for (s of [s, { ...s, suggestedValue: "REPLACED" }]) {} return s; }'],
    ["R5-17 for-in writes an existing holder", '(s) => { for (s in { row: s }) {} return s; }'],
    ["R5-18 async callback returns a promise not the record", 'async (s) => s'],
    ["R5-19 generator callback returns an iterator not the record", 'function* (s) { return s; }'],
    ["R5-20 destructured parameter write changes rebuilt record", '({ suggestedValue, ...rest }) => { suggestedValue = "REPLACED"; return { suggestedValue, ...rest }; }'],
    ["R5-21 destructured part shadow is not the parameter", '({ suggestedValue, ...rest }) => { { const suggestedValue = "REPLACED"; return { suggestedValue, ...rest }; } }'],
  ]) {
    it(`refuses the fresh survivor: ${label}`, () => {
      const rewritten = onHelper(label, SUCCESS_ANCHOR, `      suggestions: built.suggestions.map(${callback}),`)(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.includes(`application-integration: ${DISCARDED}`), JSON.stringify(errors));
    });
  }

  for (const [label, callback] of [
    ["R5-A1 direct identity", '(s) => s'],
    ["R5-A2 one holder loop", '(s) => { for (const x of [s]) { return x; } }'],
    ["R5-A3 all reachable loop entries preserve value", '(s) => { for (const x of [s, s]) { if (x.field === "title") return x; } return s; }'],
    ["R5-A4 empty leading switch clause falls forward", '(s) => { switch (s.field) { case "title": default: return s; } }'],
    ["R5-A5 dense for-in enters body", '(s) => { for (const key in [s]) { return s; } }'],
    ["R5-A6 nonempty object for-in enters body", '(s) => { for (const key in { row: s }) { return s; } }'],
    ["R5-A7 discarded fresh target copy", '(s) => { Object.assign({}, s, { suggestedValue: "REPLACED" }); return s; }'],
    ["R5-A8 local primitive increment is not a property write", '(s) => { let count = 0; count++; return s; }'],
    ["R5-A9 unchanged destructured parameter round trip", '({ suggestedValue, ...rest }) => ({ suggestedValue, ...rest })'],
  ]) {
    it(`accepts the behaviour-preserving rewrite: ${label}`, () => {
      const rewritten = onHelper(label, SUCCESS_ANCHOR, `      suggestions: built.suggestions.map(${callback}),`)(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
    });
  }

  });

  // R5 review fix-forward (REVIEW-CF070-GATE-REMEDIATION-R5): the effect contract
  // read callback bodies only, so a write made in the helper around the callback
  // could change the reviewed records and still ship. These cases hold the
  // helper-level route to the same standard.
  describe("R6 helper-level reviewed-record mutations and unreadable payloads", () => {
    const SUCCESS_START = "  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {";
    const SUCCESS_BLOCK = [
      "  return {",
      "    ok: true,",
      "    value: {",
      "      suggestions: built.suggestions,",
      "      droppedCategory: built.droppedCategory,",
      "      action: opResult.value.action,",
      "    },",
      "  };",
    ].join("\n");
    const MUTATED = "report-field helper must not modify the reviewed suggestions after computing them";
    const onHelperWhere = (label, edits) => (sources) => {
      let text = sources.reportFieldSuggestionsSource;
      for (const [from, to] of edits) {
        equal(text.split(from).length - 1, 1, `${label}: unique anchor`);
        text = text.replace(from, to);
      }
      ok(text !== sources.reportFieldSuggestionsSource, `${label}: mutation must change its input`);
      return { ...sources, reportFieldSuggestionsSource: text };
    };
    const withWrites = (label, writes) =>
      onHelperWhere(label, [[SUCCESS_START, SUCCESS_START.replace("\n  return {", `\n${writes}\n  return {`)]]);

    for (const [label, writes] of [
      ["R6-1 zeroes the reviewed array length", "  built.suggestions.length = 0;"],
      ["R6-2 replaces the array through a string-key write", '  built["suggestions"] = [];'],
      ["R6-3 assigns onto the reviewed result", "  Object.assign(built, { suggestions: [] });"],
      ["R6-4 element write into the reviewed array", '  built.suggestions[0] = { field: "title", suggestedValue: "REPLACED", source: REPORT_FIELD_SOURCE };'],
      ["R6-5 element property write through for-of", '  for (const item of built.suggestions) {\n    if (item.suggestedValue.length > 30) item.suggestedValue = "REPLACED";\n  }'],
      ["R6-6 element property write through forEach", '  built.suggestions.forEach((item) => { item.suggestedValue = "REPLACED"; });'],
      ["R6-7 in-place sort of the reviewed array", "  built.suggestions.sort();"],
      ["R6-8 in-place splice of a shipped copy", "  const list = built.suggestions.map((s) => s);\n  list.splice(0, list.length);"],
    ]) {
      it(`refuses the helper-level mutation: ${label}`, () => {
        const rewritten = writes.includes("const list =")
          ? onHelperWhere(label, [
              [SUCCESS_START, SUCCESS_START.replace("\n  return {", `\n${writes}\n  return {`)],
              ["      suggestions: built.suggestions,", "      suggestions: list,"],
            ])(REAL)
          : withWrites(label, writes)(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    it("refuses a success payload returned from a local helper", () => {
      const rewritten = onHelperWhere("R6-9 payload helper", [
        [
          SUCCESS_BLOCK,
          "  const okPayload = (suggestions: readonly ReportFieldSuggestion[]) => ({ ok: true as const, value: { suggestions, droppedCategory: false, action: opResult.value.action } });\n  return okPayload([]);",
        ],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.length > 0, JSON.stringify(errors));
    });

    it("refuses a success payload whose ok is computed", () => {
      const rewritten = onHelperWhere("R6-10 computed ok", [
        ["    ok: true,", "    ok: opResult.value.fields.title !== undefined,"],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.length > 0, JSON.stringify(errors));
    });

    it("refuses a producer re-assigned through a shadowing catch parameter", () => {
      const rewritten = onHelperWhere("R6-11 shadowed producer", [
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          '  let built = buildReportFieldSuggestions(opResult.value.fields);\n  try { throw (_f: never) => ({ suggestions: [] as never }); } catch (buildReportFieldSuggestions) {\n    built = buildReportFieldSuggestions(opResult.value.fields);\n  }',
        ],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.length > 0, JSON.stringify(errors));
    });

    it("refuses a nested array instead of the reviewed list", () => {
      const rewritten = onHelperWhere("R6-12 nested array", [
        ["      suggestions: built.suggestions,", "      suggestions: [built.suggestions],"],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.length > 0, JSON.stringify(errors));
    });

    for (const [label, writes, edits] of [
      ["R6-A1 mutates a discarded copy", "  const copy = [...built.suggestions];\n  copy.sort();", []],
      ["R6-A2 reads and counts the reviewed list", "  const total = built.suggestions.length;\n  void total;", []],
    ]) {
      it(`accepts the preserving helper body: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, SUCCESS_START.replace("\n  return {", `\n${writes}\n  return {`)],
          ...edits,
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
      });
    }

    it("accepts a `map` whose arms both hand the element back", () => {
      const rewritten = onHelperWhere("R6-A5 both arms", [
        [
          "      suggestions: built.suggestions,",
          `      suggestions: built.suggestions.map((s) => ((s.suggestedValue ?? "") === "" ? s : s)),`,
        ],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], "both arms");
    });

    it("accepts a copy spread beside a statically empty literal", () => {
      const rewritten = onHelperWhere("R6-A6 empty spread beside holder", [
        [
          "      suggestions: built.suggestions,",
          `      suggestions: built.suggestions.map((s) => ({ ...s, ...{} })),`,
        ],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], "empty spread beside holder");
    });

    it("accepts a flatMap over a const-bound empty spread", () => {
      const rewritten = onHelperWhere("R6-A3 const empty spread", [
        [SUCCESS_START, "  const EMPTY: never[] = [];\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {"],
        ["      suggestions: built.suggestions,", "      suggestions: built.suggestions.flatMap((s) => [s, ...EMPTY]),"],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], "flatMap const empty spread");
    });

    it("accepts a flatMap over a module-scoped const empty spread", () => {
      const rewritten = onHelperWhere("R6-A4 module const empty spread", [
        [
          "export function buildReportFieldSuggestions",
          "const EMPTY: never[] = [];\n\nexport function buildReportFieldSuggestions",
        ],
        ["      suggestions: built.suggestions,", "      suggestions: built.suggestions.flatMap((s) => [s, ...EMPTY]),"],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], "flatMap module const empty spread");
    });

    // R6 review fix-forward (REVIEW-CF070-GATE-REMEDIATION-R6 MAJOR-1, MINOR-2):
    // the scan followed declaration aliases one hop and property accesses only,
    // so a callee handed the chain, a destructured/assignment alias, a
    // `Reflect.set`/`Object.defineProperty` call, an element-access method, a
    // prototype method through `.call`, or a nested payload binding could still
    // change what shipped. These hold those routes to the same standard.
    for (const [label, writes] of [
      ["R7-1 destructured alias truncates", "  const { suggestions } = built;\n  suggestions.length = 0;"],
      ["R7-2 assignment alias truncates", "  let list: ReportFieldSuggestion[] = [];\n  list = built.suggestions;\n  list.length = 0;"],
      ["R7-3 unknown callee is handed the chain", "  shrink(built.suggestions);"],
      [
        "R7-4 local callee mutates its parameter",
        '  const shrink = (arr: ReportFieldSuggestion[]) => {\n    for (const item of arr) item.suggestedValue = "REPLACED";\n  };\n  shrink(built.suggestions);',
      ],
      ["R7-5 Reflect.set truncates the chain", '  Reflect.set(built.suggestions, "length", 0);'],
      ["R7-6 Object.defineProperty rewrites an element", '  Object.defineProperty(built.suggestions, "0", { value: null });'],
      ["R7-7 element-access method splices", '  built.suggestions["splice"](0);'],
      ["R7-8 prototype method through call", "  Array.prototype.splice.call(built.suggestions, 0);"],
    ]) {
      it(`refuses the helper-level route: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, SUCCESS_START.replace("\n  return {", `\n${writes}\n  return {`)],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    it("refuses a write through the nested payload binding", () => {
      const rewritten = onHelperWhere("R7-9 payload binding chain", [
        [
          SUCCESS_BLOCK,
          [
            "  const payload = {",
            "    ok: true as const,",
            "    value: {",
            "      suggestions: built.suggestions,",
            "      droppedCategory: built.droppedCategory,",
            "      action: opResult.value.action,",
            "    },",
            "  };",
            '  payload.value.suggestions.push({ field: "title", suggestedValue: "REPLACED", source: REPORT_FIELD_SOURCE });',
            "  return payload;",
          ].join("\n"),
        ],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
    });

    it("refuses an iteration callback passed by identifier", () => {
      const rewritten = onHelperWhere("R7-10 callback by identifier", [
        [
          SUCCESS_START,
          "  const clamp = (item: ReportFieldSuggestion) => { item.suggestedValue = \"REPLACED\"; };\n  built.suggestions.forEach(clamp);\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {",
        ],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
    });

    // R7 review fix-forward (REVIEW-CF070-GATE-REMEDIATION-R7 MAJOR-1): the scan was
    // seeded from the shipped expression only, so a copied payload made it vacuous,
    // and a spread/new argument, an element alias, an assignment destructuring and a
    // nested destructuring were not followed. Each case below is one the reviewer
    // measured as admitted on the R7 bytes.
    for (const [label, edits] of [
      [
        "R8-1 copied payload with a truncated chain",
        [
          [SUCCESS_START, "  const built = buildReportFieldSuggestions(opResult.value.fields);\n  built.suggestions.length = 0;\n  return {"],
          ["      suggestions: built.suggestions,", "      suggestions: [...built.suggestions],"],
        ],
      ],
      [
        "R8-2 identity-map payload with a clamped chain",
        [
          [SUCCESS_START, "  const built = buildReportFieldSuggestions(opResult.value.fields);\n  for (const item of built.suggestions) {\n    if (item.suggestedValue.length > 30) item.suggestedValue = \"REPLACED\";\n  }\n  return {"],
          ["      suggestions: built.suggestions,", "      suggestions: built.suggestions.map((s) => s),"],
        ],
      ],
      [
        "R8-3 spread argument",
        [
          [SUCCESS_START, "  scrub(...built.suggestions);\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {"],
        ],
      ],
      [
        "R8-4 constructed argument",
        [
          [SUCCESS_START, "  new Holder(built.suggestions);\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {"],
        ],
      ],
      [
        "R8-5 element alias in a for-of",
        [
          [SUCCESS_START, "  for (const item of built.suggestions) {\n    const target = item;\n    if (target.suggestedValue.length > 30) target.suggestedValue = \"REPLACED\";\n  }\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {"],
        ],
      ],
      [
        "R8-6 destructuring assignment",
        [
          [SUCCESS_START, "  let list: ReportFieldSuggestion[] = [];\n  ({ suggestions: list } = built);\n  list.length = 0;\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {"],
        ],
      ],
      [
        "R8-7 nested destructuring",
        [
          [SUCCESS_START, "  const { suggestions: [first] } = built;\n  first.suggestedValue = \"REPLACED\";\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {"],
        ],
      ],
    ]) {
      it(`refuses the copied or aliased route: ${label}`, () => {
        const rewritten = onHelperWhere(label, edits)(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    for (const [label, line] of [
      ["R8-A1 slice payload", "      suggestions: built.suggestions.slice(),"],
      ["R8-A2 Array.from payload", "      suggestions: Array.from(built.suggestions),"],
    ]) {
      it(`accepts the copying payload: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          ["      suggestions: built.suggestions,", line],
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
      });
    }

    it("accepts a copy made with Object.assign that does not ship", () => {
      const rewritten = onHelperWhere("R8-A3 assign copy", [
        [SUCCESS_START, "  const box = Object.assign({}, { list: built.suggestions });\n  void box;\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {"],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], "assign copy");
    });

    // R8 review fix-forward (REVIEW-CF070-GATE-REMEDIATION-R8 MAJOR-1): a shallow
    // copy shares its element objects; an element-wise iteration over the copy, an
    // `Array.from` mapper, a property/element assignment target, and a tagged
    // template, `await` or class expression carrying the chain were admitted. The
    // red evidence for these routes is the reviewer's own r8c farm, not an author
    // red run (the durable cases were written after the instrument measured them).
    for (const [label, body] of [
      [
        "R9-1 spread copy element write",
        '  const list = [...built.suggestions];\n  list.forEach((s) => { if (s.suggestedValue.length > 30) s.suggestedValue = "REPLACED"; });',
      ],
      [
        "R9-2 Array.from mutating mapper",
        '  const scratch = Array.from(built.suggestions, (s) => { s.suggestedValue = "REPLACED"; return s; });\n  void scratch;',
      ],
      [
        "R9-3 property assignment holder",
        '  const holder: { list: ReportFieldSuggestion[] } = { list: [] };\n  holder.list = built.suggestions;\n  holder.list.length = 0;',
      ],
      [
        "R9-4 computed property holder",
        '  const holder: { list: ReportFieldSuggestion[] } = { list: [] };\n  holder["list"] = built.suggestions;\n  holder.list.length = 0;',
      ],
      ["R9-5 tagged template", '  tag`${built.suggestions}`;'],
      ["R9-6 await argument", "  take(await built.suggestions);"],
      ["R9-7 class expression argument", "  take(class { list = built.suggestions; });"],
      ["R9-8 custom receiver slice", "  parts.slice(built.suggestions);"],
      ["R9-9 custom receiver concat", "  parts.concat(built.suggestions);"],
    ]) {
      it(`refuses the copied-element route: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    // R9 review fix-forward (REVIEW-CF070-GATE-REMEDIATION-R9 MAJOR-1/MINOR-1):
    // element identity through iterators and copies, `reduce`'s element parameter,
    // and copies stored on an assignment target or property. The red evidence is
    // the reviewer's r9c farm; these cases were written after it measured them.
    for (const [label, body] of [
      [
        "R10-1 entries iterator element write",
        '  for (const [, s] of [...built.suggestions].entries()) { if (s.suggestedValue.length > 30) s.suggestedValue = "REPLACED"; }',
      ],
      [
        "R10-2 index write through an Array.from copy",
        '  const list = Array.from(built.suggestions);\n  list[0].suggestedValue = "REPLACED";',
      ],
      [
        "R10-3 reduce element parameter write",
        '  built.suggestions.reduce((acc, s) => { if (s.suggestedValue.length > 30) s.suggestedValue = "REPLACED"; return acc; }, 0);',
      ],
      [
        "R10-4 copy stored on a property then written",
        '  const holder: { list: ReportFieldSuggestion[] } = { list: [] };\n  holder.list = [...built.suggestions];\n  holder.list[0].suggestedValue = "REPLACED";',
      ],
      [
        "R10-5 copy of a copy element write",
        '  const list = [...built.suggestions];\n  const second = [...list];\n  second.forEach((s) => { s.suggestedValue = "REPLACED"; });',
      ],
      [
        "R11-1 copy inside an object returned by a local function",
        '  const make = () => ({ list: [...built.suggestions] });\n  const box = make();\n  box.list[0].suggestedValue = "REPLACED";',
      ],
      [
        "R11-2 copy returned by an IIFE",
        '  const list = (() => { const inner = [...built.suggestions]; return inner; })();\n  list.forEach((s) => { s.suggestedValue = "REPLACED"; });',
      ],
      [
        "R11-3 alias of a copy",
        '  const list = [...built.suggestions];\n  const same = list;\n  same[0].suggestedValue = "REPLACED";',
      ],
      [
        "R11-4 copy reached through an object property alias",
        '  const box = { list: [...built.suggestions] };\n  const l = box.list;\n  l[0].suggestedValue = "REPLACED";',
      ],
      [
        "R11-5 reduce accumulator rebound to the element",
        '  built.suggestions.reduce((acc, s) => { acc = s; acc.suggestedValue = "REPLACED"; return acc; }, null);',
      ],
      [
        "R11-6 sort comparator mutates its element",
        '  const copy = built.suggestions.slice();\n  copy.sort((a, b) => { a.suggestedValue = "REPLACED"; return b.suggestedValue.length - a.suggestedValue.length; });\n  void copy;',
      ],
      [
        "R10-7 copy returned from a local function",
        '  const makeCopy = () => [...built.suggestions];\n  const list = makeCopy();\n  list.forEach((s) => { s.suggestedValue = "REPLACED"; });',
      ],
      [
        "R10-6 shipped slice copy sorted",
        '  const copy = built.suggestions.slice();\n  copy.sort();',
      ],
    ]) {
      it(`refuses the element-identity route: ${label}`, () => {
        const edits = [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ];
        if (label === "R10-6 shipped slice copy sorted") {
          edits.push(["      suggestions: built.suggestions,", "      suggestions: copy,"]);
        }
        const rewritten = onHelperWhere(label, edits)(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    for (const [label, body] of [
      ["R10-A1 unshipped spread copy sorted", '  const copy = [...built.suggestions];\n  copy.sort();\n  void copy;'],
      ["R10-A2 unshipped slice copy length reset", '  const copy = built.suggestions.slice();\n  copy.length = 0;\n  void copy;'],
      ["R10-A3 reduce accumulator written", '  built.suggestions.reduce((acc, s) => { void s; acc.count += 1; return acc; }, { count: 0 });'],
      ["R10-A4 read-only copy from a local function", '  const makeCopy = () => [...built.suggestions];\n  const list = makeCopy();\n  list.forEach((s) => { void s.suggestedValue; });'],
      ["R11-A1 copy slot replaced immutably", '  const copy = built.suggestions.slice();\n  copy[0] = { ...copy[0], suggestedValue: "x" };\n  void copy;'],
      ["R11-A2 comparator only reads its elements", '  const copy = built.suggestions.slice();\n  copy.sort((a, b) => a.suggestedValue.length - b.suggestedValue.length);\n  void copy;'],
    ]) {
      it(`accepts the copy-local write: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
      });
    }

    // R11 review fix-forward: an in-place call on a copy returns the same
    // elements (`[...chain].sort(by).forEach(...)`), so it is a copy too; and a
    // comparator that only reads a *property* of its elements must stay accepted.
    for (const [label, body] of [
      [
        "R12-1 spread copy sorted then written",
        '  const sorted = [...built.suggestions].sort((a, b) => a.suggestedValue.localeCompare(b.suggestedValue));\n  sorted[0].suggestedValue = "REPLACED";',
      ],
      [
        "R12-2 Array.from copy sorted then written",
        '  const sorted = Array.from(built.suggestions).sort((a, b) => a.suggestedValue.localeCompare(b.suggestedValue));\n  sorted[0].suggestedValue = "REPLACED";',
      ],
    ]) {
      it(`refuses the in-place-call copy route: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    it("refuses a copy stored in a container and written through it", () => {
      const label = "R12-3 copy round-tripped through a Map";
      const body = [
        "  const store = new Map();",
        "  const copy = [...built.suggestions];",
        '  store.set("list", copy);',
        '  const list = store.get("list");',
        '  if (list) list[0].suggestedValue = "REPLACED";',
      ].join("\n");
      const rewritten = onHelperWhere(label, [
        [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
    });

    // R12 verdict routes: a fresh container over a copy, a container
    // constructor, and values/entries projections.
    for (const [label, body] of [
      ["R13-8 object spread of a copy", "  const copy = built.suggestions.slice();\n  const box = { ...copy };\n  box[0].suggestedValue = \"REPLACED\";"],
      ["R13-9 copy in a Map entry literal", "  const copy = built.suggestions.slice();\n  const m = new Map([[\"a\", copy]]);\n  void m;"],
    ]) {
      it(`refuses the container route: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    it("refuses an element write through Object.values", () => {
      const label = "R13-10 element through Object.values";
      const rewritten = onHelperWhere(label, [
        [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n  const copy = built.suggestions.slice();\n  Object.values(copy)[0].suggestedValue = "REPLACED";\n  return {`],
      ])(REAL);
      const errors = validateReportFieldHelperWired(rewritten);
      ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
    });

    it("accepts a read-only Object.values projection", () => {
      const label = "R13-A4 Object.values projection";
      const rewritten = onHelperWhere(label, [
        [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n  const copy = built.suggestions.slice();\n  const values = Object.values(copy);\n  void values;\n  return {`],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
    });

    // R14c: accessor returns that are conditional, nullable or recursive.
    for (const [label, tail] of [
      [
        "R15-1 conditional accessor",
        '  const head = (useFirst: boolean) => (useFirst ? built.suggestions[0] : built.suggestions[1]);\n  const picked = head(true);\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R15-2 early return undefined",
        '  const head = () => { if (built.suggestions.length === 0) return undefined; return built.suggestions[0]; };\n  const picked = head();\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R15-3 nullish accessor",
        '  const head = () => built.suggestions[0] ?? undefined;\n  const picked = head();\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R15-4 recursive accessor",
        '  const head = (n: number): (typeof built.suggestions)[0] | undefined => (n > 0 ? head(n - 1) : built.suggestions[0]);\n  const picked = head(1);\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R15-A1 nested block shadow keeps the outer holder live",
        '  built.suggestions.forEach((elem) => {\n    { const elem = 5; void elem; }\n    elem.suggestedValue = "REPLACED";\n  });',
      ],
    ]) {
      it(`classifies the accessor return: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${tail}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    // R15 verdict: three routes survived the R15 tests themselves, so these
    // cases are the durable form of the reviewer's own instruments
    // (`r15c-shadow-forhead2`, `r15c-mixed-branches`, `r15c-neutral-void`,
    // `r14c-ordinary`). A green suite that does not contain the measured shapes
    // is exactly what allowed the R15 PARTIAL.
    for (const [label, tail] of [
      [
        "R16-1 loop-head let cannot shadow a live holder",
        '  const copy = built.suggestions.slice();\n  const s = copy.at(0);\n  for (let s = 0; s < 1; s += 1) { void s; }\n  if (s) s.suggestedValue = "REPLACED";',
      ],
      [
        "R16-2 loop-head let cannot shadow an accessor holder",
        '  const first = () => built.suggestions.at(0);\n  const s = first();\n  for (let s = 0; s < 1; s += 1) { void s; }\n  if (s) s.suggestedValue = "REPLACED";',
      ],
      [
        "R16-3 nested block cannot shadow a live holder",
        '  const copy = built.suggestions.slice();\n  const s = copy.at(0);\n  { const s = 5; void s; }\n  if (s) s.suggestedValue = "REPLACED";',
      ],
      [
        "R16-4 mixed-branch conditional accessor",
        '  const pick = (f: boolean) => (f ? built.suggestions[0] : "none");\n  const picked = pick(true);\n  if (typeof picked !== "string") picked.suggestedValue = "REPLACED";',
      ],
      [
        "R16-5 mixed-branch nullish accessor",
        '  const pick = (f: string | undefined) => (f ?? built.suggestions[0]);\n  const picked = pick(undefined);\n  if (typeof picked !== "string") picked.suggestedValue = "REPLACED";',
      ],
      [
        "R16-6 mixed-branch or/and accessors",
        '  const pickOr = (f: string | undefined) => (f || built.suggestions[0]);\n  const pickAnd = (f: string | undefined) => (f && built.suggestions[0]);\n  const a = pickOr(undefined);\n  const b = pickAnd("x");\n  if (typeof a !== "string") a.suggestedValue = "REPLACED";\n  if (typeof b !== "string") b.suggestedValue = "REPLACED";',
      ],
      [
        "R16-7 void 0 branch is the absent value",
        '  const pick = (f: boolean) => (f ? built.suggestions[0] : void 0);\n  const picked = pick(true);\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R16-8 statement return void 0",
        '  const pick = (f: boolean) => {\n    if (!f) return void 0;\n    return built.suggestions[0];\n  };\n  const picked = pick(true);\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R16-9 comma-expression undefined",
        '  const pick = (f: boolean) => (f ? built.suggestions[0] : (0, undefined));\n  const picked = pick(true);\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R16-11 accessor returns a local name bound to an element",
        '  const pick = () => { const first = built.suggestions[0]; return first; };\n  const s = pick();\n  s.suggestedValue = "REPLACED";',
      ],
      [
        "R16-12 neutral name in one scope, element in another",
        '  { const X = null; void X; }\n  const X = built.suggestions[0];\n  const pick = () => X;\n  const s = pick();\n  s.suggestedValue = "REPLACED";',
      ],
      [
        "R16-13 an array literal boxes an element",
        '  const first = built.suggestions[0];\n  const box = [first];\n  box[0].suggestedValue = "REPLACED";',
      ],
      [
        "R16-14 an array literal index is the element",
        '  const first = built.suggestions[0];\n  const box = [first];\n  const s = box[0];\n  s.suggestedValue = "REPLACED";',
      ],
      [
        "R16-15 a shorthand object boxes an element",
        '  const first = built.suggestions[0];\n  const t = { first };\n  t.first.suggestedValue = "REPLACED";',
      ],
      [
        "R16-16 a function that returns the chain is the chain",
        '  const get = () => built.suggestions;\n  get().length = 0;',
      ],
      [
        "R16-17 function expression returning the chain, spliced",
        '  const get = function () { return built.suggestions; };\n  get().splice(0, 1);',
      ],
      [
        "R16-18 alias of a chain-returning call is the chain",
        '  const get = () => built.suggestions;\n  const alias = get();\n  alias.splice(0, 1);',
      ],
      [
        "R16-19 chain-returning call sorted in place",
        '  const get = () => built.suggestions;\n  get().sort((a, b) => 0);',
      ],
      [
        "R16B-1 element reached through an assignment-form binding",
        '  const copy = [...built.suggestions];\n  let picked: any = null;\n  picked = copy.at(0);\n  const get = () => picked;\n  const s = get();\n  s.suggestedValue = "REPLACED";',
      ],
      [
        "R16B-2 element reached through a container property",
        '  const first = built.suggestions[0];\n  const t = { first };\n  const get = () => t.first;\n  const s = get();\n  s.suggestedValue = "REPLACED";',
      ],
      [
        "R16B-3 element reached through a parameter default",
        '  const get = (x: any = built.suggestions[0]) => x;\n  const s = get();\n  s.suggestedValue = "REPLACED";',
      ],
      [
        "R16B-4 comma-return accessor is the chain",
        '  const get = () => (0, built.suggestions);\n  get().length = 0;',
      ],
      [
        "R16B-5 container-literal index is the chain",
        '  const get = () => [built.suggestions][0];\n  get().splice(0, 1);',
      ],
      [
        "R16B-6 container-literal property is the chain",
        '  const get = () => ({ list: built.suggestions }).list;\n  get().length = 0;',
      ],
      [
        "R16B-7 iteration callback hands the chain into the result array",
        '  const get = () => built.suggestions;\n  const arr = [1].map(get);\n  arr[0].length = 0;',
      ],
      [
        "R16B-8 comma-return accessor pushed into",
        '  const get = () => (0, built.suggestions);\n  get().push({ field: "title", suggestedValue: "x" } as never);',
      ],
      [
        "R16D-1 Array.from mapper returns the original chain",
        '  const get = () => built.suggestions;\n  const arr = Array.from([1], get);\n  arr[0].length = 0;',
      ],
      [
        "R16D-2 filter selects the original chain from a box",
        '  const arr = [built.suggestions].filter(() => true);\n  arr[0].length = 0;',
      ],
      [
        "R16D-3 find selects the original chain from a box",
        '  const arr = [built.suggestions].find(() => true);\n  arr.length = 0;',
      ],
      [
        "R16D-4 flatMap copies records, not their identities",
        '  const get = () => built.suggestions;\n  const arr = [1].flatMap(get);\n  arr[0].suggestedValue = "REPLACED";',
      ],
      [
        "R16D-5 findLast selects the original chain from a box",
        '  const arr = [built.suggestions].findLast(() => true);\n  arr.length = 0;',
      ],
      [
        "R16E-1 a chain passed to a mapper parameter is written in place",
        '  [built.suggestions].map((list) => { list.length = 0; return 0; });',
      ],
      [
        "R16E-2 a filter callback writes the chain it receives",
        '  [built.suggestions].filter((list) => { list.length = 0; return true; });',
      ],
      [
        "R16E-3 a flatMap callback writes the chain it receives",
        '  [built.suggestions].flatMap((list) => { list.length = 0; return []; });',
      ],
      [
        "R16E-4 a method of a literal object is the chain-returning callback",
        '  const obj = { get: () => built.suggestions };\n  [1].map(obj.get)[0].length = 0;',
      ],
      [
        "R16E-5 at() unwraps a mapper result to the chain",
        '  const arr = [1].map(() => built.suggestions);\n  arr.at(0)!.length = 0;',
      ],
      [
        "R16E-6 pop() unwraps a mapper result to the chain",
        '  const arr = [1].map(() => built.suggestions);\n  arr.pop()!.length = 0;',
      ],
      [
        "R16E-7 a mapper that returns an array container is two levels deep",
        '  const arr = [1].map(() => [built.suggestions]);\n  arr[0][0].length = 0;',
      ],
      [
        "R16E-8 a mapper that returns an object container exposes the chain by property",
        '  const arr = [1].map(() => ({ list: built.suggestions }));\n  arr[0].list.length = 0;',
      ],
      [
        "R16E-9 a reduce accumulator is its callback's return",
        '  const out: any = [1].reduce((): any => built.suggestions, null);\n  out.length = 0;',
      ],
      [
        "R16E-10 a reduce call is its callback's return, through a cast",
        '  ([1].reduce((): any => built.suggestions, null) as any[]).length = 0;',
      ],
      [
        "R16E-11 a function bound by assignment is the chain-returning accessor",
        '  let g: any;\n  g = () => built.suggestions;\n  g().length = 0;',
      ],
      [
        "R16E-12 a parameter default is the chain",
        '  const get = (x: any = built.suggestions) => x;\n  get().length = 0;',
      ],
      [
        "R16E-13 a destructured parameter default holds the chain",
        '  const get = ({ list }: any = { list: built.suggestions }) => list;\n  get().length = 0;',
      ],
      [
        "R16E-14 an alias of a mapper slot is the chain",
        '  const arr = [1].map(() => built.suggestions);\n  const x = arr[0];\n  x.length = 0;',
      ],
      [
        "R16F-1 a later non-function assignment does not disarm the accessor",
        '  let g: any;\n  g = () => built.suggestions;\n  g().length = 0;\n  g = null;',
      ],
      [
        "R16F-2 a nested-function assignment does not disarm the accessor",
        '  let g: any;\n  const reset = (): void => { g = null; };\n  g = () => built.suggestions;\n  g().length = 0;\n  void reset;',
      ],
      [
        "R16F-3 two function assignments still name one accessor",
        '  let g: any;\n  g = () => built.suggestions;\n  g = () => built.suggestions;\n  g().length = 0;',
      ],
      [
        "R16F-4 an assigned function identifier is the accessor",
        '  const make = () => built.suggestions;\n  let g: any;\n  g = make;\n  g().length = 0;',
      ],
      [
        "R16F-5 a binding-element default is the chain",
        '  const get = ({ list = built.suggestions }: any = {}) => list;\n  get().length = 0;',
      ],
      [
        "R16F-6 a renamed binding-element default is the chain",
        '  const get = ({ list: l = built.suggestions }: any = {}) => l;\n  get().length = 0;',
      ],
      [
        "R16F-7 an array-pattern default element is the chain",
        '  const get = ([first]: any = [built.suggestions]) => first;\n  get().length = 0;',
      ],
      [
        "R16F-8 five container levels inside a mapper are still the chain",
        '  const arr = [1].map(() => [[[[[built.suggestions]]]]]);\n  arr[0][0][0][0][0][0].length = 0;',
      ],
      [
        "R16F-9 seven container levels inside a mapper are still the chain",
        '  const arr = [1].map(() => [[[[[[[built.suggestions]]]]]]]);\n  arr[0][0][0][0][0][0][0][0].length = 0;',
      ],
      // R16F verdict: every shape below emptied the shipped array or changed a
      // shipped record when the reviewer executed it; each sat in a mechanism
      // R16F itself added.
      [
        "R16G-1 a branch that may not run does not disarm the accessor",
        '  let flag = false;\n  let g: any;\n  g = () => built.suggestions;\n  if (flag) { g = null; }\n  g().length = 0;',
      ],
      [
        "R16G-2 a property-access assignment names its function",
        '  const obj = { get: () => built.suggestions };\n  let g: any;\n  g = obj.get;\n  g().length = 0;',
      ],
      [
        "R16G-3 a function-declaration assignment names its function",
        '  function make() { return built.suggestions; }\n  let g: any;\n  g = make;\n  g().length = 0;',
      ],
      [
        "R16G-4 a function-expression assignment names its function",
        '  const make = function () { return built.suggestions; };\n  let g: any;\n  g = make;\n  g().length = 0;',
      ],
      [
        "R16G-5 a nested binding-element default is the chain",
        '  const get = ({ a: { list = built.suggestions } = {} }: any = {}) => list;\n  get().length = 0;',
      ],
      [
        "R16G-6 a nested destructuring from the parameter default is the chain",
        '  const get = ({ a: { list } }: any = { a: { list: built.suggestions } }) => list;\n  get().length = 0;',
      ],
      [
        "R16G-7 a nested array pattern is the chain",
        '  const get = ([[first]]: any = [[built.suggestions]]) => first;\n  get().length = 0;',
      ],
      [
        "R16G-8 a conditional parameter rebind does not release the owner",
        '  const flag = false;\n  [built.suggestions].map((list) => { if (flag) list = []; list.length = 0; return 0; });',
      ],
      [
        "R16G-9 a parameter copy rebind still holds the shipped records (spread)",
        '  [built.suggestions].map((list) => { list = [...list]; list[0].suggestedValue = "REPLACED"; return 0; });',
      ],
      [
        "R16G-10 a parameter copy rebind still holds the shipped records (slice)",
        '  [built.suggestions].map((list) => { list = list.slice(); list[0].suggestedValue = "REPLACED"; return 0; });',
      ],
      [
        "R16G-11 an alias copy rebind still holds the shipped records (spread)",
        '  let list: any = built.suggestions;\n  list = [...list];\n  list[0].suggestedValue = "REPLACED";',
      ],
      [
        "R16G-12 an alias copy rebind still holds the shipped records (slice)",
        '  let list: any = built.suggestions;\n  list = list.slice();\n  list[0].suggestedValue = "REPLACED";',
      ],
      [
        "R16G-13 a write before the rebind is still a write",
        '  [built.suggestions].map((list) => { list.length = 0; list = []; return 0; });',
      ],
      [
        "R16G-14 a rebind does not disarm a second alias",
        '  let alias: any = built.suggestions;\n  const alias2: any = alias;\n  alias = [];\n  alias2[0].suggestedValue = "REPLACED";',
      ],
      [
        "R16G-15 a sibling block binding is still the chain",
        '  { let g: any = () => built.suggestions; g().length = 0; }',
      ],
      [
        "R16G-16 a use before the loop's later assignment still owns the chain",
        '  let g: any;\n  for (let i = 0; i < 1; i += 1) {\n    g = () => built.suggestions;\n    g().length = 0;\n    g = null;\n  }',
      ],
      [
        "R16G-17 twelve container levels are covered",
        '  const arr = [1].map(() => [[[[[[[[[[[[built.suggestions]]]]]]]]]]]]);\n  arr[0][0][0][0][0][0][0][0][0][0][0][0][0].length = 0;',
      ],
      // R16G verdict: the resolver and the copy rule were each still only as wide
      // as the forms they enumerated. These thirteen shapes were executed by the
      // reviewer and each emptied the shipped array or changed a shipped record.
      [
        "R16H-1 a logical-or assignment names its function",
        '  let g: any;\n  g ||= () => built.suggestions;\n  g().length = 0;',
      ],
      [
        "R16H-2 a nullish assignment names its function",
        '  let g: any;\n  g ??= () => built.suggestions;\n  g().length = 0;',
      ],
      [
        "R16H-3 a conditional initializer names its function",
        '  const flag = true;\n  const g: any = flag ? () => built.suggestions : null;\n  g().length = 0;',
      ],
      [
        "R16H-4 a logical initializer names its function",
        '  const flag = true;\n  const g: any = flag && (() => built.suggestions);\n  g().length = 0;',
      ],
      [
        "R16H-5 an object built by assignment exposes its function",
        '  let obj: any;\n  obj = { get: () => built.suggestions };\n  let g: any;\n  g = obj.get;\n  g().length = 0;',
      ],
      [
        "R16H-6 a destructuring assignment binds the function",
        '  let g: any;\n  ({ g } = { g: () => built.suggestions });\n  g().length = 0;',
      ],
      [
        "R16H-7 a nested default reads an object built by assignment",
        '  let obj: any;\n  obj = { a: { list: built.suggestions } };\n  const get = ({ a: { list } }: any = obj) => list;\n  get().length = 0;',
      ],
      [
        "R16H-8 a local helper copy in a callback still shares the records",
        '  [built.suggestions].map((list) => { const cp = (xs: any) => [...xs]; list = cp(list); list[0].suggestedValue = "REPLACED"; return 0; });',
      ],
      [
        "R16H-9 a local helper copy at helper level still shares the records",
        '  let list: any = built.suggestions;\n  const cp = (xs: any) => [...xs];\n  list = cp(list);\n  list[0].suggestedValue = "REPLACED";',
      ],
      [
        "R16H-10 a nested spread in a callback still shares the records",
        '  [built.suggestions].map((list) => { list = [...[...list]]; list[0].suggestedValue = "REPLACED"; return 0; });',
      ],
      [
        "R16H-11 a nested spread at helper level still shares the records",
        '  let list: any = built.suggestions;\n  list = [...[...list]];\n  list[0].suggestedValue = "REPLACED";',
      ],
      [
        "R16H-12 a declaration alias names the function",
        '  const make = () => built.suggestions;\n  const g: any = make;\n  g().length = 0;',
      ],
      [
        "R16H-13 a double declaration alias names the function",
        '  const make = () => built.suggestions;\n  const g = make;\n  const h = g;\n  h().length = 0;',
      ],
      [
        "R16-10 null alias is the absent value",
        '  const MISSING = null;\n  const pick = (f: boolean) => (f ? built.suggestions[0] : MISSING);\n  const picked = pick(true);\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
    ]) {
      it(`classifies the R15 route: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${tail}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    // R15 MAJOR-1: an in-place method on a *fresh container the chain flowed
    // into* only reorders that container's own slots. Ordinary projection code
    // must not be refused (`r14c-ordinary` O1/O3 measured the opposite).
    for (const [label, tail] of [
      [
        "R16-A1 slice copy sorted",
        '  const ordered = built.suggestions.slice().sort((a, b) => a.field.localeCompare(b.field));\n  void ordered;',
      ],
      [
        "R16-A2 slice copy reversed",
        '  const reversed = built.suggestions.slice().reverse();\n  void reversed;',
      ],
      [
        "R16-A3 read-only mixed-branch accessor",
        '  const pick = (f: string | undefined) => (f ?? built.suggestions[0]);\n  void pick(undefined)?.field;',
      ],
      [
        "R16-A5 read-only accessor through a local name",
        '  const pick = () => { const first = built.suggestions[0]; return first; };\n  void pick().field;',
      ],
      [
        "R16-A6 read-only array box",
        '  const first = built.suggestions[0];\n  const box = [first];\n  void box[0].field;',
      ],
      [
        "R16-A7 read-only call of a chain-returning accessor",
        '  const get = () => built.suggestions;\n  void get()[0]?.field;',
      ],
      [
        "R16B-A1 read-only comma-return accessor element",
        '  const get = () => (0, built.suggestions);\n  void get()[0]?.field;',
      ],
      [
        "R16B-A2 read-only element through a container property",
        '  const first = built.suggestions[0];\n  const t = { first };\n  void t.first.field;',
      ],
      [
        "R16B-A3 read-only element through an iteration result",
        '  const get = () => built.suggestions;\n  const arr = [1].map(get);\n  void arr[0][0]?.field;',
      ],
      [
        "R16B-A4 read-only element through a parameter default",
        '  const get = (x: any = built.suggestions[0]) => x;\n  void get()?.field;',
      ],
      [
        "R16D-A1 filter predicate return is not an output value",
        '  const get = () => built.suggestions;\n  const arr = [[1, 2]].filter(get);\n  arr[0].length = 0;',
      ],
      [
        "R16D-A2 find predicate return is not an output value",
        '  const get = () => built.suggestions;\n  const arr = [[1, 2]].find(get);\n  arr.length = 0;',
      ],
      [
        "R16D-A3 findLast predicate return is not an output value",
        '  const get = () => built.suggestions;\n  const arr = [[1, 2]].findLast(get);\n  arr.length = 0;',
      ],
      [
        "R16D-A4 map fresh outer slots are not the shipped chain",
        '  const get = () => built.suggestions;\n  const arr = [1].map(get);\n  arr.length = 0;',
      ],
      [
        "R16D-A5 Array.from fresh outer slots are not the shipped chain",
        '  const get = () => built.suggestions;\n  const arr = Array.from([1], get);\n  arr.length = 0;',
      ],
      [
        "R16D-A6 filter fresh outer slots are not the shipped chain",
        '  const arr = [built.suggestions].filter(() => true);\n  arr.length = 0;',
      ],
      [
        "R16D-A7 flatMap fresh outer slots are not the shipped chain",
        '  const get = () => built.suggestions;\n  const arr = [1].flatMap(get);\n  arr.length = 0;',
      ],
      [
        "R16E-A1 reading a mapper slot is not a write",
        '  const arr = [1].map(() => built.suggestions);\n  void arr[0]?.length;',
      ],
      [
        "R16E-A2 at() read without a write is accepted",
        '  const arr = [1].map(() => built.suggestions);\n  void arr.at(0)?.length;',
      ],
      [
        "R16E-A3 a one-level container slot is cleared, not the chain",
        '  const arr = [1].map(() => [built.suggestions]);\n  arr[0].length = 0;',
      ],
      [
        "R16E-A4 a container property object is fresh",
        '  const arr = [1].map(() => ({ list: built.suggestions }));\n  arr[0] = { list: [] };',
      ],
      [
        "R16E-A5 a reducer that returns a count keeps its accumulator fresh",
        '  const total = [1, 2].reduce((sum: number, n: number) => sum + n, 0);\n  void total;',
      ],
      [
        "R16E-A6 a mapper parameter over a record copy is not the chain",
        '  const arr = built.suggestions.map((s) => s.field);\n  void arr.length;',
      ],
      [
        "R16F-A1 a reducer over an empty receiver returns its initial value",
        '  const out: any = ([] as any[]).reduce((): any => built.suggestions, []);\n  out.length = 0;',
      ],
      [
        "R16F-A2 a mapper parameter rebound to a fresh array is not the chain",
        '  [built.suggestions].map((list) => { list = []; list.push("x"); return 0; });',
      ],
      [
        "R16F-A3 a mapper parameter copied before writing is accepted",
        '  [built.suggestions].map((list) => { const copy = [...list]; copy.length = 0; return 0; });',
      ],
      [
        "R16F-A4 a slot alias rebound to a fresh array is not the chain",
        '  let list: any = [built.suggestions][0];\n  list = [];\n  list.push("x");',
      ],
      [
        "R16F-A5 an under-indexed mapper container is a fresh array, not the chain",
        // The map result wraps the returned container once, so five brackets
        // need six indexes; five indexes land on the fresh `[chain]` container.
        '  const arr = [1].map(() => [[[[[built.suggestions]]]]]);\n  arr[0][0][0][0][0].length = 0;',
      ],
      // R16F verdict, release side: a release must be real before it is
      // accepted, and a copy may be pruned as long as its records are not.
      [
        "R16G-A1 a parameter copy may clear its own array",
        '  [built.suggestions].map((list) => { const copy = list.slice(); copy.length = 0; return 0; });',
      ],
      [
        "R16G-A2 a rebind to a fresh array may be filled",
        '  [built.suggestions].map((list) => { list = []; list.push("x"); return 0; });',
      ],
      [
        "R16G-A3 a rebind and its write inside one branch are safe",
        '  const flag = false;\n  [built.suggestions].map((list) => { if (flag) { list = []; list.length = 0; } return 0; });',
      ],
      [
        "R16G-A4 a copy rebind may clear the copy's array",
        '  [built.suggestions].map((list) => { list = [...list]; list.length = 0; return 0; });',
      ],
      [
        "R16G-A5 a slot alias rebind may be filled with a fresh value",
        '  let alias: any = built.suggestions;\n  alias = [];\n  alias.push("x");',
      ],
      [
        "R16G-A6 a shallow-copied alias may be pruned as an array",
        '  let list: any = built.suggestions;\n  list = list.slice();\n  list.length = 0;',
      ],
      // R16H over-refusal controls: the wider resolver and the wider copy rule
      // must not refuse these, which were accepted before R16H.
      [
        "R16H-A1 a copy rebind may clear the copy's array",
        '  [built.suggestions].map((list) => { list = [...list]; list.length = 0; return 0; });',
      ],
      [
        "R16H-A2 a helper-level copy may clear its own array",
        '  let list: any = built.suggestions;\n  list = [...list];\n  list.length = 0;',
      ],
      [
        "R16H-A3 a copy then fresh rebind in a callback is safe",
        '  [built.suggestions].map((list) => { list = [...list]; list = []; list.push("x"); return 0; });',
      ],
      [
        "R16H-A4 a copy then fresh rebind at helper level is safe",
        '  let list: any = built.suggestions;\n  list = [...list];\n  list = [];\n  list.push("x");',
      ],
      [
        "R16-A4 read-only void 0 accessor",
        '  const pick = (f: boolean) => (f ? built.suggestions[0] : void 0);\n  void pick(true)?.field;',
      ],
    ]) {
      it(`accepts the ordinary read-only form: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${tail}\n  return {`],
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
      });
    }

    // R13 verdict: element identity must be symmetric with copy identity.
    for (const [label, tail] of [
      [
        "R14-1 local find accessor",
        '  const findByField = (field: string) => built.suggestions.find((s) => s.field === field);\n  const found = findByField("title");\n  if (found) found.suggestedValue = "REPLACED";',
      ],
      [
        "R14-2 immediately-invoked accessor",
        '  const found = (() => built.suggestions[0])();\n  found.suggestedValue = "REPLACED";',
      ],
      [
        "R14-3 element boxed in a fresh object",
        '  const copy = built.suggestions.slice();\n  const box = { s: copy.at(0) };\n  if (box.s) box.s.suggestedValue = "REPLACED";',
      ],
      [
        "R14-4 reduce to one of its own parameters",
        '  const copy = built.suggestions.slice();\n  const picked = copy.reduce<typeof copy[0] | undefined>((best, s) => (best === undefined ? s : best), undefined);\n  if (picked) picked.suggestedValue = "REPLACED";',
      ],
      [
        "R14-5 object accessor",
        '  const pick = () => ({ first: built.suggestions[0] });\n  const box = pick();\n  if (box.first) box.first.suggestedValue = "REPLACED";',
      ],
    ]) {
      it(`refuses the accessor route: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${tail}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    for (const [label, body] of [
      ["R14-A1 substr", '  const any = built.suggestions.some((s) => s.suggestedValue.substr(0, 3) === "Bl");\n  void any;'],
      ["R14-A2 toLocaleLowerCase", '  const any = built.suggestions.some((s) => s.suggestedValue.toLocaleLowerCase() === "x");\n  void any;'],
      ["R14-A3 isWellFormed", '  const any = built.suggestions.some((s) => s.suggestedValue.isWellFormed());\n  void any;'],
      ["R14-A4 nested array read-only copies", '  built.suggestions.forEach((s) => { void s.tags.toSorted(); void s.tags.flat(); });'],
      [
        "R14-A5 fresh local shadows a callback parameter",
        '  built.suggestions.forEach((s) => { void s.field; });\n  const s: { field: string; suggestedValue: string; source: string } = { field: "title", suggestedValue: "x", source: "user" };\n  s.suggestedValue = "y";',
      ],
      ["R14-A6 Object.keys projection", '  const copy = built.suggestions.slice();\n  const keys = Object.keys(copy);\n  void keys;'],
    ]) {
      it(`accepts the read-only spelling: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
      });
    }

    // R12 review fix-forward: an element reached through a method result on a
    // copy is still a shared record, and the comparator/iteration guards must
    // run for a copy receiver too.
    const COPY = "  const copy = built.suggestions.slice();\n";
    for (const [label, tail] of [
      ["R13-1 element through at()", '  copy.at(-1)!.suggestedValue = "REPLACED";'],
      ["R13-2 element through slice()[]", '  copy.slice(1)[0].suggestedValue = "REPLACED";'],
      ["R13-3 element through filter()[]", '  copy.filter((s) => s.suggestedValue.length > 0)[0].suggestedValue = "REPLACED";'],
      ["R13-4 element through reverse()[]", '  copy.reverse()[0].suggestedValue = "REPLACED";'],
      ["R13-7 element through an object-literal holder", '  ({ list: copy }).list[0].suggestedValue = "REPLACED";'],
    ]) {
      it(`refuses the method-result element write: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${COPY}${tail}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    for (const [label, tail] of [
      ["R13-5 copy sorted by an unreadable comparator", "  copy.sort(moduleComparator);"],
      ["R13-6 copy handed an unreadable callback", "  copy.forEach(opaqueHandler);"],
    ]) {
      it(`refuses a copy receiver's unread callback: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${COPY}${tail}\n  return {`],
        ])(REAL);
        const errors = validateReportFieldHelperWired(rewritten);
        ok(errors.includes(`application-integration: ${MUTATED}`), JSON.stringify(errors));
      });
    }

    for (const [label, body] of [
      ["R13-A1 element holder rebound to another element", "  let best = built.suggestions[0];\n  best = built.suggestions[1];\n  void best;"],
      ["R13-A2 copy serialized", "  const copy = built.suggestions.slice();\n  JSON.stringify(copy);"],
      ["R13-A3 element logged", "  console.log(built.suggestions[0]);"],
    ]) {
      it(`accepts the read-only spelling: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
      });
    }

    for (const [label, body] of [
      [
        "R12-A1 pure comparator calling a method on a property",
        '  const sorted = [...built.suggestions].sort((a, b) => a.suggestedValue.localeCompare(b.suggestedValue));\n  void sorted;',
      ],
      [
        "R12-A2 element predicate calling a method on a property",
        '  built.suggestions.some((s) => s.suggestedValue.trim().length === 0);',
      ],
      [
        "R12-A3 spread copy slot replaced",
        '  const copy = [...built.suggestions];\n  copy[0] = { ...copy[0], suggestedValue: "x" };\n  void copy;',
      ],
      [
        "R12-A4 index search handed an element",
        '  built.suggestions.lastIndexOf(built.suggestions[0]);',
      ],
    ]) {
      it(`accepts the read-only spelling: ${label}`, () => {
        const rewritten = onHelperWhere(label, [
          [SUCCESS_START, `  const built = buildReportFieldSuggestions(opResult.value.fields);\n${body}\n  return {`],
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], label);
      });
    }

    it("accepts a read-only iteration over a copy", () => {
      const rewritten = onHelperWhere("R9-A1 copy read", [
        [SUCCESS_START, '  const list = [...built.suggestions];\n  list.forEach((s) => { void s.suggestedValue; });\n  const built = buildReportFieldSuggestions(opResult.value.fields);\n  return {'],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], "copy read");
    });

    it("accepts a failure payload built by a local helper", () => {
      const rewritten = onHelperWhere("R7-A1 failure helper", [
        [
          "  if (!opResult.ok) return opResult;",
          "  const failure = (error: unknown) => ({ ok: false as const, error });\n  if (!opResult.ok) return failure(opResult.error);",
        ],
      ])(REAL);
      deepStrictEqual(validateReportFieldHelperWired(rewritten), [], "failure helper");
    });

    it("keeps accepting a receiver-position call on the chain", () => {
      for (const line of [
        "      suggestions: built.suggestions.slice(),",
        "      suggestions: [...built.suggestions],",
        "      suggestions: built.suggestions.map((s) => s),",
      ]) {
        const rewritten = onHelperWhere(`R7-A2 receiver ${line.slice(20, 32)}`, [
          ["      suggestions: built.suggestions,", line],
        ])(REAL);
        deepStrictEqual(validateReportFieldHelperWired(rewritten), [], line);
      }
    });
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
  const KEEP_RESOLVES = "each Keep control must resolve its own suggestion";

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
    [
      "A5 the title branch writes a reviewed field through a parenthesised callee before its guard",
      onForm("A5 parenthesised callee", TITLE_GUARD, `(setDescription)("");\n        ${TITLE_GUARD}`),
      WRITE_BEFORE_GUARD,
    ],
    [
      "A6 the title branch writes a reviewed field through an array-destructured alias before its guard",
      onForm(
        "A6 array-destructured alias",
        TITLE_GUARD,
        `const [wipe] = [setDescription];\n        wipe("");\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "A7 the title branch writes a reviewed field through an iteration callback before its guard",
      onForm(
        "A7 iteration callback alias",
        TITLE_GUARD,
        `[setDescription].forEach((wipe) => { wipe(""); });\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "A8 the title branch writes a reviewed field through a two-hop alias before its guard",
      onForm(
        "A8 two-hop alias",
        TITLE_GUARD,
        `const w1 = setDescription;\n        const w2 = w1;\n        w2("");\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "A9 the title branch writes a reviewed field held on a local object key before its guard",
      onForm(
        "A9 object-key alias",
        TITLE_GUARD,
        `const wipe = { run: setDescription };\n        wipe.run("");\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "B10 the confirmation sits in `while (NaN)`",
      onForm("B10 while NaN", TITLE_GUARD, `while (NaN) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B11 the confirmation sits in `while (void 0)`",
      onForm("B11 while void", TITLE_GUARD, `while (void 0) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B12 the confirmation sits in a `for … of` over `new Array(0)`",
      onForm("B12 for-of new Array(0)", TITLE_GUARD, `for (const _s of new Array(0)) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B13 the confirmation sits in a `for … of` over a concatenation of empty arrays",
      onForm("B13 for-of empty concat", TITLE_GUARD, `for (const _s of [].concat([])) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "C7 the payload maps the reviewed suggestions onto fabricated elements",
      onHelper(
        "C7 map fabricate",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map(() => ({} as never)),",
      ),
      DISCARDED,
    ],
    [
      "C8 the payload maps the reviewed suggestions, substituting a value",
      onHelper(
        "C8 map substitute",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => ({ field: s.field, suggestedValue: "REPLACED", source: s.source })),',
      ),
      DISCARDED,
    ],
    [
      "D6 the fabricated payload is one arm of a conditional return",
      onHelper(
        "D6 conditional fabricated return",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  return opResult.ok",
          "    ? { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } }",
          "    : built;",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "D7 the fabricated payload is returned through `Object.assign`",
      onHelper(
        "D7 object assign fabricated",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  const manufactured = { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } };",
          "  return Object.assign({}, manufactured);",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "D8 the payload's suggestion element only reads a reviewed field",
      onHelper(
        "D8 element embeds reviewed",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          '  const manufactured = { ok: true as const, value: { suggestions: [{ field: "title", suggestedValue: "hacked", source: opResult.value.action }], droppedCategory: false, action: opResult.value.action } };',
          "  void built;",
          "  return manufactured;",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "D9 the fabricated payload is returned through a comma expression",
      onHelper(
        "D9 comma fabricated return",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  const manufactured = { ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } };",
          "  return (void 0, manufactured);",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "E3 the Keep key is written by an array destructuring assignment",
      declared(
        "E3 array destructuring write",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'let CAT_KEEP_KEY = "categorySuggestion";\n[CAT_KEEP_KEY] = ["nope"];',
      ),
      KEEP_RESOLVES,
    ],
    [
      "E4 the Keep key is written by an object destructuring assignment",
      declared(
        "E4 object destructuring write",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'let CAT_KEEP_KEY = "categorySuggestion";\n({ CAT_KEEP_KEY } = { CAT_KEEP_KEY: "nope" });',
      ),
      KEEP_RESOLVES,
    ],
    [
      "A10 the title branch writes through a `for … of` binding over a collection holding a setter",
      onForm(
        "A10 for-of setter binding",
        TITLE_GUARD,
        `for (const wipe of [setDescription]) { wipe(""); }\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "A11 the title branch writes through a setter read out of an object literal",
      onForm(
        "A11 member extract setter",
        TITLE_GUARD,
        `const wipe = { run: setDescription }.run;\n        wipe("");\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "A12 the title branch writes through a nested destructuring of a setter",
      onForm(
        "A12 nested destructure setter",
        TITLE_GUARD,
        `const [[wipe]] = [[setDescription]];\n        wipe("");\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "A13 the title branch writes through a name assigned a setter after declaration",
      onForm(
        "A13 assigned alias setter",
        TITLE_GUARD,
        `let wipe: (value: string) => void;\n        wipe = setDescription;\n        wipe("");\n        ${TITLE_GUARD}`,
      ),
      WRITE_BEFORE_GUARD,
    ],
    [
      "B14 the confirmation sits in `while (true ? false : true)`",
      onForm("B14 folded while conditional", TITLE_GUARD, `while (true ? false : true) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B15 the confirmation sits in a `while` over an empty template",
      onForm("B15 while empty template", TITLE_GUARD, 'while (`${""}`) { ' + TITLE_GUARD + " }"),
      UNREACHABLE_GUARD,
    ],
    [
      "B16 the confirmation sits in `while (0n)`",
      onForm("B16 while zero bigint", TITLE_GUARD, `while (0n) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B17 the confirmation sits in `while (Number(0))`",
      onForm("B17 while folded Number", TITLE_GUARD, `while (Number(0)) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "B18 the confirmation sits in a `for … of` over an empty `Set`",
      onForm("B18 for-of empty Set", TITLE_GUARD, `for (const _s of new Set()) { ${TITLE_GUARD} }`),
      UNREACHABLE_GUARD,
    ],
    [
      "C9 the payload's `map` substitutes a value on a branch the callback returns through",
      onHelper(
        "C9 map branch substitute",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { if (s.field === "title") return { ...s, suggestedValue: "REPLACED" }; return s; }),',
      ),
      DISCARDED,
    ],
    [
      "C9b the payload's `map` fabricates from inside a loop the callback returns through",
      onHelper(
        "C9b map loop fabricate",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((s) => { for (let i = 0; i < 1; i += 1) { return {} as never; } return s; }),",
      ),
      DISCARDED,
    ],
    [
      "C10 the payload reads a binding that a later assignment replaced with an empty list",
      onHelper(
        "C10 reassigned fabricated",
        SUCCESS_PAYLOAD,
        [
          "  let built = buildReportFieldSuggestions(opResult.value.fields);",
          "  built = { suggestions: [] as never, droppedCategory: false };",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: built.suggestions,",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "C11 the fabricated payload is returned behind a `satisfies` cast",
      onHelper(
        "C11 satisfies fabricated",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  return ({ ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } } satisfies Record<string, unknown>);",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "C12 the fabricated payload is returned through `Object.freeze`",
      onHelper(
        "C12 freeze fabricated",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  return Object.freeze({ ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } });",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "C13 the fabricated payload is returned from an immediately-invoked function",
      onHelper(
        "C13 iife fabricated",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  void built;",
          "  return (() => ({ ok: true as const, value: { suggestions: [], droppedCategory: false, action: opResult.value.action } }))();",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "C14 an unreadable spread written after the reviewed list overrides it",
      onHelper(
        "C14 unreadable spread override",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  return {",
          "    ok: true,",
          "    value: { suggestions: built.suggestions, ...make() },",
          "  };",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "C15 the payload concatenates the reviewed list onto itself",
      onHelper(
        "C15 concat doubled",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.concat(built.suggestions as never),",
      ),
      DISCARDED,
    ],
    [
      "E5 the Keep key is written by a `for … of` assignment header",
      declared(
        "E5 for-of write",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'let CAT_KEEP_KEY = "categorySuggestion";\nfor (CAT_KEEP_KEY of ["nope"]) { void CAT_KEEP_KEY; }',
      ),
      KEEP_RESOLVES,
    ],
    [
      "E6 the Keep key is written by a `for … in` assignment header",
      declared(
        "E6 for-in write",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        "let CAT_KEEP_KEY = \"categorySuggestion\";\nfor (CAT_KEEP_KEY in { nope: 1 }) { void CAT_KEEP_KEY; }",
      ),
      KEEP_RESOLVES,
    ],
    [
      "R3-1 the payload's `map` mutates the element it is handed and returns it",
      onHelper(
        "R3-1 map in-place mutation",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { s.suggestedValue = "REPLACED"; return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R3-2 the payload's `map` falls off the end of its body on a branch",
      onHelper(
        "R3-2 map fall-off",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { if (s.field === "title") return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R3-3 the payload's `map` returns a name it re-declared over the element",
      onHelper(
        "R3-3 map shadowed name",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { { const s = {} as never; return s; } }),',
      ),
      DISCARDED,
    ],
    [
      "R3-4 the payload's spread holder has its suggestions overwritten after it is built",
      onHelper(
        "R3-4 written spread holder",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  const extra = { suggestions: built.suggestions };",
          "  extra.suggestions = [];",
          "  return {",
          "    ok: true,",
          "    value: { ...built, ...extra, action: opResult.value.action },",
          "  };",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "R3-5 the payload's builder is appended to with a compound write",
      onHelper(
        "R3-5 compound write",
        SUCCESS_PAYLOAD,
        [
          "  let built = buildReportFieldSuggestions(opResult.value.fields);",
          "  built += [] as never;",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: built.suggestions,",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "R3-6 the Keep key's holder has the property overwritten after it is declared",
      declared(
        "R3-6 holder property written",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(HOLDER.KEEP_KEY)}",
        'const HOLDER = { KEEP_KEY: "categorySuggestion" };\nHOLDER.KEEP_KEY = "nope";',
      ),
      KEEP_RESOLVES,
    ],
    [
      "R3-7 the payload's `map` takes the element out of a rest parameter and rebuilds it",
      onHelper(
        "R3-7 rest rebuild",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((...args: never[]) => ({ ...args[0], suggestedValue: "R3" })),',
      ),
      DISCARDED,
    ],
    [
      "R3-8 the payload's `flatMap` hands the element back twice beside an empty spread",
      onHelper(
        "R3-8 flatMap twice",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.flatMap((s) => [s, s, ...[]]),",
      ),
      DISCARDED,
    ],
    [
      "R3-9 the payload's `map` writes the element through `Object.assign`",
      onHelper(
        "R3-9 object assign mutation",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { Object.assign(s, { suggestedValue: "X" }); return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R3-10 the payload's `map` deletes one of the element's own properties",
      onHelper(
        "R3-10 delete mutation",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { delete s.suggestedValue; return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R3-11 the payload's `map` mutates the element inside a nested function it calls",
      onHelper(
        "R3-11 nested mutation",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { const wipe = () => { s.suggestedValue = "X"; }; wipe(); return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R3-12 the payload reads a name an inner scope re-declared over the reviewed builder",
      onHelper(
        "R3-12 inner shadow read",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  {",
          "    const built = { suggestions: [] as never, droppedCategory: false };",
          "    return {",
          "      ok: true,",
          "      value: {",
          "        suggestions: built.suggestions,",
          "        droppedCategory: built.droppedCategory,",
          "        action: opResult.value.action,",
          "      },",
          "    };",
          "  }",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "R4-1 the payload's builder is replaced by a different producer that is handed the reviewed result",
      onHelper(
        "R4-1 fabricated producer",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  built = fabricate(opResult.value.fields);",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: built.suggestions,",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "R4-2 the payload reads a `catch` parameter that shadows the reviewed builder",
      onHelper(
        "R4-2 catch param shadow",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  try {",
          '    throw new Error("boom");',
          "  } catch (built) {",
          "    return { ok: true, value: { suggestions: (built as { suggestions: never[] }).suggestions, droppedCategory: false, action: opResult.value.action } };",
          "  }",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "R4-3 the payload reads a loop header that shadows the reviewed builder",
      onHelper(
        "R4-3 for header shadow",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  for (let built = { suggestions: [] as never, droppedCategory: false } as never; ; ) {",
          "    return { ok: true, value: { suggestions: (built as { suggestions: never[] }).suggestions, droppedCategory: false, action: opResult.value.action } };",
          "  }",
        ].join("\n"),
      ),
      DISCARDED,
    ],
    [
      "R4-4 the payload's `map` writes the element through `Object.defineProperty`",
      onHelper(
        "R4-4 define property",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { Object.defineProperty(s, "suggestedValue", { value: "X", enumerable: true }); return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R4-5 the payload's `map` writes the element through `Reflect.set`",
      onHelper(
        "R4-5 reflect set",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { Reflect.set(s, "suggestedValue", "X"); return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R4-6 the payload's `map` calls a mutating method on a property of the element",
      onHelper(
        "R4-6 method push",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { (s as unknown as { list: string[] }).list.push("x"); return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R4-7 the payload's `map` hands the element to a callee the gate cannot read",
      onHelper(
        "R4-7 unread callee",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((s) => { mutate(s); return s; }),",
      ),
      DISCARDED,
    ],
    [
      "R4-8 the payload's `map` replaces the element through the reviewed collection it came from",
      onHelper(
        "R4-8 mutation via the source index",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s, i) => { (built.suggestions[i] as { suggestedValue: string }).suggestedValue = "X"; return s; }),',
      ),
      DISCARDED,
    ],
    [
      "R4-9 the payload's `map` can leave its `switch` without returning",
      onHelper(
        "R4-9 switch case break",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { switch (s.field) { default: { if (s.field === "title") { break; } return s; } } }),',
      ),
      DISCARDED,
    ],
    [
      "R4-10 the payload's `map` breaks out of its `switch` and then falls off the end",
      onHelper(
        "R4-10 break then return",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { switch (s.field) { default: { if (s.field === "title") { break; } } } return s; }),',
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
    [
      "P11 the payload copies the reviewed suggestions through `[].concat(...)`",
      onHelper("P11 concat copy", SUCCESS_ANCHOR, "      suggestions: [].concat(built.suggestions as never),"),
    ],
    [
      "P12 the payload copies the reviewed suggestions through `slice()`",
      onHelper("P12 slice copy", SUCCESS_ANCHOR, "      suggestions: built.suggestions.slice(),"),
    ],
    [
      "P13 the payload copies the reviewed suggestions through `Array.from(...)`",
      onHelper("P13 array from copy", SUCCESS_ANCHOR, "      suggestions: Array.from(built.suggestions),"),
    ],
    [
      "P14 the payload spreads the reviewed result and adds its own field",
      onHelper(
        "P14 spread plus action",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  return {",
          "    ok: true,",
          "    value: { ...built, action: opResult.value.action },",
          "  };",
        ].join("\n"),
      ),
    ],
    [
      "P15 the payload spreads the reviewed result over an own empty list",
      onHelper(
        "P15 spread overrides own",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  return {",
          "    ok: true,",
          "    value: { suggestions: [], ...built, action: opResult.value.action },",
          "  };",
        ].join("\n"),
      ),
    ],
    [
      "Q4 the Keep key resolves the reviewed literal through an object destructuring `const`",
      declared(
        "Q4 destructured const",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(KEEP_KEY)}",
        'const { KEEP_KEY } = { KEEP_KEY: "categorySuggestion" };',
      ),
    ],
    [
      "P16 the payload's `map` returns the element and ignores the index",
      onHelper("P16 map two params", SUCCESS_ANCHOR, "      suggestions: built.suggestions.map((s, _i) => s),"),
    ],
    [
      "P17 the payload's `map` returns the element through a local",
      onHelper(
        "P17 map local alias",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((s) => { const copy = s; return copy; }),",
      ),
    ],
    [
      "P18 the payload copies the reviewed list out of a `flatMap` that wraps each element once",
      onHelper(
        "P18 flatMap identity",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.flatMap((s) => [s]),",
      ),
    ],
    [
      "P19 the payload copies the reviewed list through an identity `Array.from` mapper",
      onHelper(
        "P19 array from identity mapper",
        SUCCESS_ANCHOR,
        "      suggestions: Array.from(built.suggestions, (s) => s),",
      ),
    ],
    [
      "P20 the payload copies the reviewed list through `slice(undefined)`",
      onHelper("P20 slice undefined", SUCCESS_ANCHOR, "      suggestions: built.suggestions.slice(undefined),"),
    ],
    [
      "P21 the payload spreads the reviewed list and an empty tail",
      onHelper("P21 spread empty tail", SUCCESS_ANCHOR, "      suggestions: [ ...built.suggestions, ...[] ],"),
    ],
    [
      "P22 the payload's `map` takes the element apart and puts every part back",
      onHelper(
        "P22 map destructured round trip",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map(({ field, suggestedValue, source, ...rest }) => ({ field, suggestedValue, source, ...rest })),",
      ),
    ],
    [
      "P23 the payload's value is built by `Object.assign` over the reviewed result",
      onHelper(
        "P23 nested object assign value",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  return { ok: true as const, value: Object.assign({ suggestions: [] }, built, { action: opResult.value.action }) };",
        ].join("\n"),
      ),
    ],
    [
      "P24 the Keep key is a `satisfies` cast of the reviewed literal",
      declared(
        "P24 satisfies keep key",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(KEEP_KEY)}",
        'const KEEP_KEY = "categorySuggestion" satisfies string;',
      ),
    ],
    [
      "P25 the confirmation label is a `satisfies` cast of the reviewed copy",
      onForm(
        "P25 satisfies confirm label",
        TITLE_GUARD,
        'if (!window.confirm(("Replace the existing title with this suggestion?" satisfies string))) return;',
      ),
    ],
    [
      "P26 the Keep key is read out of the object that holds the reviewed literal",
      declared(
        "P26 holder property keep key",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(HOLDER.KEEP_KEY)}",
        'const HOLDER = { KEEP_KEY: "categorySuggestion" };',
      ),
    ],
    [
      "P27 the Keep key is read out of the array that holds the reviewed literal",
      declared(
        "P27 element read keep key",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(KEEP[0])}",
        'const KEEP = ["categorySuggestion"];',
      ),
    ],
    [
      "P28 the Keep key is a `let` a nullish assignment cannot change",
      declared(
        "P28 nullish assign preserves",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(CAT_KEEP_KEY)}",
        'let CAT_KEEP_KEY = "categorySuggestion";\nCAT_KEEP_KEY ??= "nope";',
      ),
    ],
    [
      "P29 the Keep key is a destructuring default an absent property hands over",
      declared(
        "P29 default destructure keeps",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(KEEP_KEY)}",
        'const { KEEP_KEY = "categorySuggestion" } = {} as { KEEP_KEY?: string };',
      ),
    ],
    [
      "R3-A1 the payload's builder is assigned the same reviewed call again on a branch",
      onHelper(
        "R3-A1 reassign same builder",
        SUCCESS_PAYLOAD,
        [
          "  let built = buildReportFieldSuggestions(opResult.value.fields);",
          "  if (opResult.value.fields.length > 0) built = buildReportFieldSuggestions(opResult.value.fields);",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: built.suggestions,",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
    ],
    [
      "R3-A2 the payload's builder is assigned itself",
      onHelper(
        "R3-A2 self assign",
        SUCCESS_PAYLOAD,
        [
          "  let built = buildReportFieldSuggestions(opResult.value.fields);",
          "  built = built;",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: built.suggestions,",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
    ],
    [
      "R3-A3 the payload's `map` reads the element out of a rest parameter",
      onHelper(
        "R3-A3 rest param element",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((...args: never[]) => args[0]),",
      ),
    ],
    [
      "R3-A4 the payload's `map` binds the element to a `let` written only with the element",
      onHelper(
        "R3-A4 let self write",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((s) => { let copy = s; copy = s; return copy; }),",
      ),
    ],
    [
      "R3-A5 the payload's `map` binds the element out of an object-rest pattern",
      onHelper(
        "R3-A5 object rest identity",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map(({ ...s }) => s),",
      ),
    ],
    [
      "R3-A6 the payload's `map` returns the element through both arms of an `if`/`else`",
      onHelper(
        "R3-A6 if else returns",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { if (s.field === "title") { return s; } else { return s; } }),',
      ),
    ],
    [
      "R3-A7 the payload's `flatMap` wraps the element once beside a statically empty spread",
      onHelper(
        "R3-A7 flatMap empty extra",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.flatMap((s) => [s, ...[]]),",
      ),
    ],
    [
      "R3-A8 the payload spreads the reviewed list and an empty tail held in a `const`",
      onHelper(
        "R3-A8 bound empty tail",
        SUCCESS_PAYLOAD,
        [
          "  const tail: never[] = [];",
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: [ ...built.suggestions, ...tail ],",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
    ],
    [
      "R3-A9 the Keep key's holder names the property with a computed literal key",
      declared(
        "R3-A9 computed key holder",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(HOLDER.KEEP_KEY)}",
        'const HOLDER = { ["KEEP_KEY"]: "categorySuggestion" };',
      ),
    ],
    [
      "R3-A10 the Keep key is destructured out of a holder binding",
      declared(
        "R3-A10 destructure holder",
        CAT_KEEP,
        "onClick={() => aiSuggestResolve(KEEP_KEY)}",
        'const HOLDER = { KEEP_KEY: "categorySuggestion" };\nconst { KEEP_KEY } = HOLDER;',
      ),
    ],
    [
      "R3-A11 the payload's `map` copies the element through `Object.assign` into a fresh object",
      onHelper(
        "R3-A11 object assign copy",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((s) => Object.assign({}, s)),",
      ),
    ],
    [
      "R3-A12 the payload reads the reviewed builder after an inner scope declared the same name",
      onHelper(
        "R3-A12 inner declaration beside the read",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  if (opResult.value.fields.length > 0) {",
          "    const built = { suggestions: [] as never, droppedCategory: false };",
          "    void built;",
          "  }",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: built.suggestions,",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
    ],
    [
      "R3-A13 the payload's builder is untouched by a write to another binding that aliased it",
      onHelper(
        "R3-A13 aliased write",
        SUCCESS_PAYLOAD,
        [
          "  const built = buildReportFieldSuggestions(opResult.value.fields);",
          "  let alias = built;",
          "  alias = { suggestions: [] as never, droppedCategory: false } as never;",
          "  return {",
          "    ok: true,",
          "    value: {",
          "      suggestions: built.suggestions,",
          "      droppedCategory: built.droppedCategory,",
          "      action: opResult.value.action,",
          "    },",
          "  };",
        ].join("\n"),
      ),
    ],
    [
      "R4-A1 the payload's `map` returns the element from a `switch` whose clauses fall through",
      onHelper(
        "R4-A1 switch fallthrough",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { switch (s.field) { case "a": case "b": return s; default: return s; } }),',
      ),
    ],
    [
      "R4-A2 the payload's `map` returns the element from a `do … while` body",
      onHelper(
        "R4-A2 do while",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { do { return s; } while (s.field === "x"); }),',
      ),
    ],
    [
      "R4-A3 the payload's `map` returns the element it walks a literal list for",
      onHelper(
        "R4-A3 for of literal",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((s) => { for (const x of [s]) { return x; } }),",
      ),
    ],
    [
      "R4-A4 the payload's `map` returns the element from a labelled block",
      onHelper(
        "R4-A4 labelled block",
        SUCCESS_ANCHOR,
        "      suggestions: built.suggestions.map((s) => { L: { return s; } }),",
      ),
    ],
    [
      "R4-A5 the payload's `map` builds a copy of the element and does not return it",
      onHelper(
        "R4-A5 discarded copy",
        SUCCESS_ANCHOR,
        '      suggestions: built.suggestions.map((s) => { Object.assign({}, s, { suggestedValue: "X" }); return s; }),',
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
