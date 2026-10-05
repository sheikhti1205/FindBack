#!/usr/bin/env node
/**
 * ai-release-gate: single on-device-AI release gate (WS-D).
 *
 * Fails closed (exit 1, naming every violation) when ANY of these hold:
 *   1. stale-markers  — TODO/FIXME/"not wired" work markers in the shipped AI
 *                        scope (no allowlist: honest-refusal strings must not
 *                        look like work markers)
 *   2. manifest-pins  — a model profile lacks a revision or sha256 pin, or an
 *                        LFM arm is not catalogOnly (delegates to
 *                        check-ai-manifest.mjs validators)
 *   3. license-bundle — an LFM-licensed (lfm1.0) arm could ship on the bundle
 *                        channel (catalogOnly + licenseGate bundle/download
 *                        block both required)
 *   4. abi-artifacts  — the Android ABI split config is missing a supported
 *                        ABI (armeabi-v7a, arm64-v8a, x86_64)
 *   5. vision-truth   — the production vision seam or its local-vision
 *                        registration is absent (text-only skeleton tree), OR
 *                        shipped capability copy claims ready vision without
 *                        device measurement
 *   6. runtime-wiring — a task-spec runtime has no production adapter, a
 *                        foreign (lab) runtime is registered as routable, or
 *                        the orchestrator lets deterministic-local shadow
 *                        model runtimes on the model path
 *   7. endpoint-pin   — the generic endpoint invents a default (unpinned)
 *                        endpoint instead of failing closed with
 *                        GENERIC_ENDPOINT_MISSING_COPY
 *   8. needle-telemetry — Needle telemetry defaults ON or bypasses the global
 *                        diag gate (must be off unless BOTH the global diag
 *                        gate and the explicit per-seam opt-in are set)
 *   9. secrets        — delegates to scripts/scan-secrets.mjs (non-zero fails)
 *
 * Lab/challenger/test skeletons (needle bench, testing fakes,
 * generationGuard rewire note) are deliberately OUTSIDE the
 * shipped scope: they never enter the APK through a production path, and the
 * lab-only policy confining them is enforced by check-ai-promotion.mjs.
 * The llama.cpp challenger additionally must never appear as a routable
 * runtime: runtime-wiring fails closed on any such registration.
 *
 * Usage:
 *   node scripts/ai-release-gate.mjs [--json]
 *   node scripts/ai-release-gate.mjs --help
 *
 * Exit codes: 0 pass, 1 gate failure, 2 usage error.
 * checkAiReleaseGate() is exported for node --test suites. Importing this
 * module has no side effects; the CLI runs only on direct execution.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelProfiles, validateProfiles } from "./check-ai-manifest.mjs";
import { validatePromotion } from "./check-ai-promotion.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** AI-scope files whose contents ship (or gate what ships) in prod builds. */
export const SHIPPED_AI_FILES = [
  "apps/mobile/src/services/ai/modelProfiles.ts",
  "apps/mobile/src/services/ai/providers/offline.ts",
  "apps/mobile/src/services/ai/vision/backendSelector.ts",
  "apps/mobile/src/services/ai/genericEndpoint.ts",
  "apps/mobile/src/services/appCapabilities.ts",
  "apps/mobile/src/services/ai/uiGates.ts",
  "apps/mobile/src/services/ai/llama/licenseGate.ts",
  "apps/mobile/src/services/ai/llama/promotionPolicy.ts",
  "apps/mobile/src/services/ai/needle/telemetryGate.ts",
  "apps/mobile/src/services/ai/orchestrator/taskRegistry.ts",
  "apps/mobile/src/services/ai/orchestrator/runtimeRegistry.ts",
  "apps/mobile/src/services/ai/orchestrator/productionRuntimes.ts",
  "apps/mobile/src/services/ai/orchestrator/AiOrchestrator.ts",
  "apps/mobile/src/services/ai/applicationAi.ts",
  "apps/mobile/src/services/ai/providerRegistry.ts",
  "apps/mobile/src/services/ai/vision/native.ts",
  "apps/mobile/src/services/ai/download/driver.ts",
  "apps/mobile/src/screens/AiModelsRoute.tsx",
  "apps/mobile/android/app/src/main/java/com/findback/app/vlm/RuntimeTimingRunner.kt",
];

const MARKER_RE = /\bTODO\b|\bFIXME\b|not\s+wired/i;

const REQUIRED_ABIS = ["armeabi-v7a", "arm64-v8a", "x86_64"];

/** Capability-copy claims that would lie while the bridge is text-only. */
const VISION_CLAIM_RES = [
  /on-device vision is (ready|available|supported)/i,
  /offline vision (is |is now )?(ready|available|supported)/i,
  /vision (is |is now )?(ready|generally available) for/i,
];

function read(relativePath) {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function checkStaleMarkers() {
  const errors = [];
  for (const file of SHIPPED_AI_FILES) {
    let source;
    try {
      source = read(file);
    } catch {
      errors.push(`stale-markers: cannot read shipped file ${file}`);
      continue;
    }
    source.split("\n").forEach((line, index) => {
      if (!MARKER_RE.test(line)) return;
      errors.push(`stale-markers: ${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return errors;
}

function checkManifestPins() {
  let source;
  try {
    source = read("apps/mobile/src/services/ai/modelProfiles.ts");
  } catch (error) {
    return [`manifest-pins: cannot read modelProfiles.ts (${error.message})`];
  }
  return validateProfiles(parseModelProfiles(source)).map((error) => `manifest-pins: ${error}`);
}

function checkLicenseBundle() {
  const errors = [];
  let profilesSource;
  let licenseSource;
  try {
    profilesSource = read("apps/mobile/src/services/ai/modelProfiles.ts");
    licenseSource = read("apps/mobile/src/services/ai/llama/licenseGate.ts");
  } catch (error) {
    return [`license-bundle: cannot read policy source (${error.message})`];
  }
  for (const profile of parseModelProfiles(profilesSource)) {
    if (typeof profile.license === "string" && /lfm/i.test(profile.license)) {
      // Simulate licenseGate.enforce(profile, "bundle"): LFM + bundle must block.
      if (profile.catalogOnly !== true) {
        errors.push(`license-bundle: LFM arm ${profile.id} would ship on the bundle channel`);
      }
    }
  }
  const bundleBlock =
    /channel\s*===\s*"bundle"\s*\|\|\s*channel\s*===\s*"download"[\s\S]{0,400}?allowed:\s*false/;
  if (!bundleBlock.test(licenseSource)) {
    errors.push("license-bundle: licenseGate does not block the bundle/download channels");
  }
  return errors;
}

function checkAbiArtifacts() {
  const errors = [];
  let gradle;
  try {
    gradle = read("apps/mobile/android/app/build.gradle");
  } catch (error) {
    return [`abi-artifacts: cannot read app/build.gradle (${error.message})`];
  }
  const includeMatch = /include\s+([^;\n]+)/.exec(gradle);
  const declared = includeMatch ? includeMatch[1] : "";
  for (const abi of REQUIRED_ABIS) {
    if (!declared.includes(`"${abi}"`)) {
      errors.push(`abi-artifacts: ABI "${abi}" missing from the splits include list`);
    }
  }
  return errors;
}

/**
 * Skeleton-tree detector for the production vision path. Fails when:
 * - the offline adapter has no image-capable seam (text-only skeleton), or
 * - no local-vision production adapter is registered, or
 * - capability copy claims ready vision (no device measurement has landed).
 *
 * `vision_unsupported` remains a legitimate fail-closed error code; this
 * check asserts the seam exists, not the absence of the refusal string.
 */
export function validateVisionTruth({ offlineSource, runtimesSource, capabilitiesSource }) {
  const errors = [];
  for (const marker of ["OfflineVisionNativeBridge", "visionBridge?:", "completeOfflineVision"]) {
    if (!offlineSource.includes(marker)) {
      errors.push(`vision-truth: offline adapter has no production vision seam (${marker} absent)`);
    }
  }
  if (!runtimesSource.includes("LOCAL_VISION_RUNTIME_ID") || !runtimesSource.includes("visionRuntime(")) {
    errors.push("vision-truth: no local-vision production adapter registered");
  }
  for (const pattern of VISION_CLAIM_RES) {
    if (pattern.test(capabilitiesSource)) {
      errors.push(`vision-truth: capability copy claims ready vision (${pattern})`);
    }
  }
  if (!/hidden/i.test(capabilitiesSource)) {
    errors.push("vision-truth: capability copy lost its hidden-until-measured default");
  }
  return errors;
}

/**
 * Skeleton-tree detector for task routing. Fails when:
 * - a non-deterministic task-spec runtime has no production adapter (every
 *   such route would end in NO_RUNTIME on a real device), or
 * - a foreign (lab) runtime is registered as routable, or
 * - the orchestrator passes unfiltered spec.runtimes to firstAvailable,
 *   letting always-available deterministic-local shadow model runtimes.
 */
export function validateRuntimeWiring({ registrySource, runtimesSource, orchestratorSource }) {
  const errors = [];
  const specIds = new Set(
    [...registrySource.matchAll(/runtimes:\s*\[([^\]]*)\]/g)].flatMap((match) =>
      [...match[1].matchAll(/"([^"]+)"/g)].map((id) => id[1]),
    ),
  );
  const modelIds = [...specIds].filter((id) => id !== "deterministic-local");
  for (const id of modelIds) {
    if (!runtimesSource.includes(`"${id}"`)) {
      errors.push(`runtime-wiring: task-spec runtime "${id}" has no production adapter`);
    }
  }
  const registerCalls = [...runtimesSource.matchAll(/registry\.register\(\s*([A-Za-z0-9_]+)/g)].map(
    (match) => match[1],
  );
  const knownAdapters = new Set(["textRuntime", "embeddingRuntime", "visionRuntime"]);
  for (const call of registerCalls) {
    if (!knownAdapters.has(call)) {
      errors.push(`runtime-wiring: foreign routable runtime registered (${call})`);
    }
  }
  if (!/firstAvailable\(\s*spec\.runtimes\.filter/.test(orchestratorSource)) {
    errors.push(
      "runtime-wiring: orchestrator does not skip deterministic-local on the model path (shadowing)",
    );
  }
  return errors;
}

function checkVisionTruth() {
  let offline;
  let runtimes;
  let capabilities;
  try {
    offline = read("apps/mobile/src/services/ai/providers/offline.ts");
    runtimes = read("apps/mobile/src/services/ai/orchestrator/productionRuntimes.ts");
    capabilities = read("apps/mobile/src/services/appCapabilities.ts");
  } catch (error) {
    return [`vision-truth: cannot read vision source (${error.message})`];
  }
  return validateVisionTruth({ offlineSource: offline, runtimesSource: runtimes, capabilitiesSource: capabilities });
}

function checkRuntimeWiring() {
  let registry;
  let runtimes;
  let orchestrator;
  try {
    registry = read("apps/mobile/src/services/ai/orchestrator/taskRegistry.ts");
    runtimes = read("apps/mobile/src/services/ai/orchestrator/productionRuntimes.ts");
    orchestrator = read("apps/mobile/src/services/ai/orchestrator/AiOrchestrator.ts");
  } catch (error) {
    return [`runtime-wiring: cannot read routing source (${error.message})`];
  }
  return validateRuntimeWiring({ registrySource: registry, runtimesSource: runtimes, orchestratorSource: orchestrator });
}

// Source tripwires complement behavioral service/route/provider tests in the mobile suite.
// Check calls and route ownership, not imports that a disconnected adapter could satisfy.
export const APPLICATION_INTEGRATION_FILES = {
  mainSource: "apps/mobile/src/main.tsx",
  appSource: "apps/mobile/src/App.tsx",
  serviceSource: "apps/mobile/src/services/ai/applicationAi.ts",
  providersSource: "apps/mobile/src/services/ai/providerRegistry.ts",
  modelsSource: "apps/mobile/src/screens/AiModelsRoute.tsx",
  advancedSource: "apps/mobile/src/screens/AiAdvanced.tsx",
  helpSource: "apps/mobile/src/screens/Help.tsx",
  matchesSource: "apps/mobile/src/services/possibleMatches.ts",
  visionNativeSource: "apps/mobile/src/services/ai/vision/native.ts",
  probeSource: "apps/mobile/android/app/src/main/java/com/findback/app/vlm/DeviceProbe.kt",
  timingSource: "apps/mobile/android/app/src/main/java/com/findback/app/vlm/RuntimeTimingRunner.kt",
  pluginSource: "apps/mobile/android/app/src/main/java/com/findback/app/vlm/SmolVlmPlugin.kt",
  analyzePhotoSource: "apps/mobile/src/services/analyzeReportPhoto.ts",
  localAnalyzeSource: "apps/mobile/src/services/analyzeReportPhotoLocal.ts",
  suggestionsSource: "apps/mobile/src/components/VlmSuggestions.tsx",
};

export function validateApplicationIntegration(sources) {
  const requirements = [
    ["mainSource", /(?:void\s+|await\s+)initializeApplicationAi\(\)/, "application startup must initialize shared AI"],
    ["serviceSource", /this\.boot\s*=\s*bootProductionAi\(/, "shared service must boot production runtimes"],
    ...["CapacitorNeedleBridge", "CapacitorSmolVlmBridge", "CapacitorModelDownloadDriver"].map((name) =>
      ["serviceSource", new RegExp(`new ${name}\\(`), `shared service must construct ${name}`]),
    ["serviceSource", /Capacitor\.isNativePlatform\(\)[\s\S]{0,100}===\s*"android"/, "offline service must gate native Android"],
    ["serviceSource", /runManagedDownload\(this\.manager,\s*this\.driver/, "downloads must use shared manager and driver"],
    ["providersSource", /KNOWN_PROVIDERS[^;]+SUPPORTED_AI_PROVIDERS,\s*"offline"/, "provider guard must accept offline"],
    ["providersSource", /case\s*"offline":\s*return\s*\(options\.offlineService\s*\?\?\s*getApplicationAi\(\)\)\.offlineAdapter\(/, "offline provider must reach application service"],
    ["appSource", /path="\/ai-models"\s+element=\{<AiModelsRoute\s*\/>\}/, "product models route must mount its controls owner"],
    ["modelsSource", /run\(service\.(download|pause|remove)\(modelId\)/, "models route must drive download controls through the shared service"],
    ...["download", "pause", "remove"].map((name) =>
      ["modelsSource", new RegExp(`service\\.${name}\\(`), `models route must connect ${name}`]),
    ["advancedSource", /service\.measure\(/, "advanced screen must connect measure"],
    ["helpSource", /createProviderAdapter\("offline",/, "Help must list installed offline models through registry"],
    ["helpSource", /sendProvider\s*===\s*"offline"\s*\?\s*null/, "offline sends must bypass credential lookup"],
    ["matchesSource", /ai\.matchingBackend\s*===\s*"needle"[\s\S]{0,100}ai\.embedNeedle\(/, "matching must reach selected Needle service"],
    ["visionNativeSource", /registerPlugin<SmolPlugin>\("FindbackSmolVlm"\)/, "Smol TS bridge must bind registered native plugin"],
    ["visionNativeSource", /this\.plugin\(\)\.measureBackend\(args\)/, "TS measurement must invoke native runner"],
    ["probeSource", /override fun timing\(\): TimingRunner\s*=\s*RuntimeTimingRunner\.forInstalledSmol\(appContext\)/, "production timing provider cannot be null"],
    ["timingSource", /conversation\.getBenchmarkInfo\(\)/, "timing must use runtime counters, not synthetic token estimates"],
    ["timingSource", /correctnessPass\s*=\s*correctness/, "timing must report tested correctness"],
    ["pluginSource", /fun measureBackend\([\s\S]+DeviceProbe\.collect\(/, "native plugin must expose measurement runner"],
    // On-device-first report-photo wiring (owner decision): the local SmolVLM2
    // analyzer is the DEFAULT engine; cloud is the fallback. These tripwires
    // fail closed if the local attempt, its image transport, or its UI caller
    // is ever disconnected.
    [
      "analyzePhotoSource",
      /analyzeLocally\s*=\s*options\?\.deps\?\.analyzeLocally\s*\?\?\s*analyzeReportPhotoLocally/,
      "photo analyzer must default to the real on-device analyzer",
    ],
    [
      "analyzePhotoSource",
      /const\s+local\s*=\s*await\s+analyzeLocally\([\s\S]*?(?:deps\?\.send|createOpenRouterClient)/,
      "photo analyzer must attempt the on-device analyzer before the cloud path",
    ],
    [
      "localAnalyzeSource",
      /route\(\s*"analyze-image",\s*\{[^}]*imageBase64/,
      "on-device analyzer must route analyze-image with imageBase64",
    ],
    [
      "suggestionsSource",
      /await\s+analyzeReportPhoto\(/,
      "VlmSuggestions must use the local-first analyzeReportPhoto analyzer",
    ],
  ];
  return requirements.filter(([key, pattern]) => !pattern.test(sources[key] ?? ""))
    .map(([, , message]) => `application-integration: ${message}`);
}

function checkApplicationIntegration() {
  return validateApplicationIntegration(Object.fromEntries(
    Object.entries(APPLICATION_INTEGRATION_FILES).map(([key, file]) => [key, read(file)]),
  ));
}

function checkEndpointPin() {
  const errors = [];
  let source;
  try {
    source = read("apps/mobile/src/services/ai/genericEndpoint.ts");
  } catch (error) {
    return [`endpoint-pin: cannot read genericEndpoint.ts (${error.message})`];
  }
  if (!source.includes("No default endpoint is assumed")) {
    errors.push("endpoint-pin: GENERIC_ENDPOINT_MISSING_COPY lost (no-default invariant)");
  }
  if (/DEFAULT\w*ENDPOINT\w*\s*=\s*["'`]https?:/i.test(source)) {
    errors.push("endpoint-pin: hardcoded default endpoint URL present (endpoint unpinned)");
  }
  if (!/return null when none is set|return null;/.test(source)) {
    errors.push("endpoint-pin: unset endpoint no longer resolves to null (fail-closed load)");
  }
  return errors;
}

function checkNeedleTelemetry() {
  const errors = [];
  let source;
  try {
    source = read("apps/mobile/src/services/ai/needle/telemetryGate.ts");
  } catch (error) {
    return [`needle-telemetry: cannot read telemetryGate.ts (${error.message})`];
  }
  if (!/needleTelemetryOptIn\s*=\s*false/.test(source)) {
    errors.push("needle-telemetry: Needle telemetry is not default-OFF");
  }
  if (!/isDiagEnabled\(\)/.test(source)) {
    errors.push("needle-telemetry: Needle telemetry bypasses the global diag gate");
  }
  return errors;
}

function checkSecrets() {
  try {
    execFileSync("node", ["scripts/scan-secrets.mjs"], { cwd: REPO_ROOT, stdio: "pipe" });
    return [];
  } catch {
    return ["secrets: scripts/scan-secrets.mjs reported hits (see its output above)"];
  }
}

export const GATE_CHECKS = [
  { id: "stale-markers", run: checkStaleMarkers },
  { id: "manifest-pins", run: checkManifestPins },
  { id: "license-bundle", run: checkLicenseBundle },
  { id: "abi-artifacts", run: checkAbiArtifacts },
  { id: "vision-truth", run: checkVisionTruth },
  { id: "runtime-wiring", run: checkRuntimeWiring },
  { id: "application-integration", run: checkApplicationIntegration },
  { id: "endpoint-pin", run: checkEndpointPin },
  { id: "needle-telemetry", run: checkNeedleTelemetry },
  { id: "promotion-policy", run: runPromotionPolicy },
  { id: "secrets", run: checkSecrets },
];

function runPromotionPolicy() {
  let policySource;
  let licenseSource;
  let profilesSource;
  try {
    policySource = read("apps/mobile/src/services/ai/llama/promotionPolicy.ts");
    licenseSource = read("apps/mobile/src/services/ai/llama/licenseGate.ts");
    profilesSource = read("apps/mobile/src/services/ai/modelProfiles.ts");
  } catch (error) {
    return [`promotion-policy: cannot read policy source (${error.message})`];
  }
  return validatePromotion({ policySource, licenseSource, profilesSource }).map(
    (error) => `promotion-policy: ${error}`,
  );
}

/** Run every gate check. Returns { passed, results: [{ id, ok, errors }] }. */
export function checkAiReleaseGate() {
  const results = GATE_CHECKS.map(({ id, run }) => {
    let errors;
    try {
      errors = run();
    } catch (error) {
      errors = [`${id}: checker threw (${error.message})`];
    }
    return { id, ok: errors.length === 0, errors };
  });
  return { passed: results.every((result) => result.ok), results };
}

function printHelp() {
  console.log(`ai-release-gate: single on-device-AI release gate

usage:
  node scripts/ai-release-gate.mjs [--json]

checks (any failure exits 1):
  stale-markers     TODO/"not wired" markers in shipped AI scope
  manifest-pins     modelProfiles rev+sha pins, LFM catalogOnly
  license-bundle    lfm1.0 arms blocked on the bundle channel
  abi-artifacts     ABI split config carries every supported ABI
  vision-truth      production vision seam + registration present, copy honest
  runtime-wiring    every spec runtime has a production adapter, no lab routes
  application-integration  real boot, provider, controls, matching and timing path
  endpoint-pin      generic endpoint pinned (no invented default)
  needle-telemetry  Needle telemetry default-OFF behind the diag gate
  promotion-policy  lab-only runtimes never promotable/routable
  secrets           delegates to scripts/scan-secrets.mjs

options:
  --json   emit machine-readable JSON instead of human lines
  --help   print this help and exit 0

exit codes: 0 pass, 1 gate failure, 2 usage error`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const asJson = args.includes("--json");
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--json");
  if (unknown.length > 0) {
    console.error(`ai-release-gate: unknown flag(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  if (!existsSync(resolve(REPO_ROOT, "scripts/scan-secrets.mjs"))) {
    console.error("ai-release-gate: FAIL: scripts/scan-secrets.mjs missing (secrets delegate)");
    process.exit(1);
  }
  const { passed, results } = checkAiReleaseGate();
  if (asJson) {
    console.log(JSON.stringify({ passed, results }, null, 2));
  } else {
    for (const result of results) {
      if (result.ok) {
        console.log(`ai-release-gate: PASS ${result.id}`);
      } else {
        console.error(`ai-release-gate: FAIL ${result.id}`);
        for (const error of result.errors) console.error(`  - ${error}`);
      }
    }
    console.log(
      passed
        ? `ai-release-gate: PASS (all ${results.length} checks green)`
        : `ai-release-gate: FAIL (${results.filter((r) => !r.ok).length} check(s) red)`,
    );
  }
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
