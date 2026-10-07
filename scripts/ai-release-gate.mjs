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
 *   11. descriptor-registry — shipped code indexes the model catalogue by
 *                        position, a descriptor names an unapproved runtime /
 *                        format / ABI, a pin/identity/capability field is
 *                        missing, a downloadable entry is not curated, model
 *                        removal lacks a fail-closed unknown-runtime default,
 *                        heavy switches bypass the residency coordinator,
 *                        declared ABIs go unenforced, taskRoles never gate
 *                        selection, the text runtime parses JSON, a routable
 *                        task lacks an interpreter, or catalogue order picks
 *                        the default model
 *   7. endpoint-pin   — the generic endpoint invents a default (unpinned)
 *                        endpoint instead of failing closed with
 *                        GENERIC_ENDPOINT_MISSING_COPY
 *   8. needle-telemetry — Needle telemetry defaults ON or bypasses the global
 *                        diag gate (must be off unless BOTH the global diag
 *                        gate and the explicit per-seam opt-in are set)
 *   9. photo-analysis-truth — the shipped Analyze-photo capability copy
 *                        (client + server) still carries the stale cloud-only
 *                        claim, or lost the local-first / engine truth
 *                        (local-first, automatic fallback, on-device-only,
 *                        cloud-only); the same truth is required on the
 *                        user-facing surfaces (About + Help privacy copy),
 *                        which must not carry cloud-only photo phrasing
 *   10. secrets        — delegates to scripts/scan-secrets.mjs (non-zero fails)
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
  "apps/mobile/src/services/ai/orchestrator/routeValidation.ts",
  "apps/mobile/src/services/ai/modelDescriptors.ts",
  "apps/mobile/src/services/ai/residencyCoordinator.ts",
  "apps/mobile/src/services/ai/applicationAi.ts",
  "apps/mobile/src/services/ai/providerRegistry.ts",
  "apps/mobile/src/services/ai/vision/native.ts",
  "apps/mobile/src/services/ai/download/driver.ts",
  "apps/mobile/src/screens/AiModelsRoute.tsx",
  "apps/mobile/android/app/src/main/java/com/findback/app/vlm/RuntimeTimingRunner.kt",
  "apps/mobile/android/app/src/main/java/com/findback/app/vlm/SmolVlmPlugin.kt",
  "apps/mobile/android/app/src/main/java/com/findback/app/vlm/DeviceProbe.kt",
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

/**
 * Photo-analysis truth detector for the Analyze-photo capability copy.
 * Fails when either truth source (client `appCapabilities.ts` or server
 * `supabase/functions/ai-help/capabilities.ts`):
 * - still carries the stale cloud-only claim (the "never claim offline
 *   inference" instruction or the connected-cloud-provider-as-the-photo-path
 *   copy), or
 * - lost the local-first / engine truth: Analyze photo is local-first on
 *   Android when the verified SmolVLM2 runtime is available; automatic mode
 *   may fall back to the connected provider after local failure;
 *   on-device-only never sends the photo to cloud; cloud-only skips local.
 */
export const STALE_PHOTO_ANALYSIS_CLAIM_RES = [
  /never claim[^.]{0,200}offline inference/i,
  /consented path is the connected cloud provider/i,
  /selected photo is sent to (your connected|the connected) AI provider/i,
];

export const REQUIRED_PHOTO_ANALYSIS_TRUTH_RES = [
  /local-first/i,
  /on-device-only/i,
  /cloud-only/i,
  /fall\s?back/i,
];

/**
 * Descriptor-registry detector (Phase A Steps 2/3/8/10). Fails when:
 * - shipped app code identifies a model by catalogue position
 *   (`DOWNLOAD_MODELS[0]`/`[1]`) instead of the descriptor registry, or
 * - a shipped descriptor names a runtime outside the production allowlist
 *   (a third runtime — including llama-cpp — needs explicit gate review,
 *   never a silent catalogue entry), an unknown artifact format, an ABI
 *   outside the known Android set, or an empty ABI list, or
 * - a shipped descriptor lacks an immutable pin field (revision/sha256),
 *   download identity (url/fileName/bytes), capability/task-role lists, or
 *   RAM bounds, or
 * - a downloadable entry is not curated (imported/untrusted models must
 *   never ride the production catalogue), or
 * - model removal can fall through to the wrong engine (the unload path
 *   must fail closed on unknown runtimes), or
 * - the app service bypasses the residency coordinator for heavy switches,
 *   or
 * - declared descriptor ABIs are never enforced (download/run must consult
 *   device ABIs through the compatibility boundary), or
 * - model taskRoles never gate runtime selection (roles must decide
 *   eligibility, not sit as documentation), or
 * - the generic text runtime hardcodes structured JSON semantics
 *   (JSON.parse at the runtime boundary is Needle-shaped; parsing belongs
 *   to task interpreters), or
 * - a routable task lacks an explicit interpreter, or unlisted tasks fall
 *   through to success, or
 * - the default model is chosen by catalogue order instead of explicit
 *   policy.
 */
const DESCRIPTOR_RUNTIME_ALLOWLIST = ["needle-cact", "smolvlm2-litertlm"];
const DESCRIPTOR_FORMAT_ALLOWLIST = ["cact", "litertlm", "gguf", "tflite"];
const DESCRIPTOR_ABI_ALLOWLIST = ["armeabi-v7a", "arm64-v8a", "x86_64"];

export function validateDescriptorRegistry({ descriptorsSource, serviceSource, modelsSource, runtimesSource, orchestratorSource, interpretersSource, routeValidationSource }) {
  const errors = [];
  for (const [label, source] of [["service", serviceSource], ["models", modelsSource]]) {
    if (/DOWNLOAD_MODELS\[[01]\]/.test(source ?? "")) {
      errors.push(`descriptor-registry: ${label} identifies a model by catalogue position (use the descriptor registry)`);
    }
  }
  const descriptors = descriptorsSource ?? "";
  // Descriptors reference `*_RUNTIME_ID` constants: resolve them from the
  // same source before allowlisting, so an unapproved runtime cannot hide
  // behind an identifier.
  const constStrings = new Map(
    [...descriptors.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]),
  );
  const resolveRuntime = (raw) => {
    if (raw.startsWith('"')) return raw.slice(1, -1);
    const resolved = constStrings.get(raw);
    return resolved ?? `unresolvable:${raw}`;
  };
  // (Interface declarations read `runtimeId: string` — lowercase type
  // names never match the UPPER_CASE-or-quoted value pattern.)
  const runtimeIds = [...descriptors.matchAll(/runtimeId:\s*("[^"]+"|[A-Z][A-Za-z0-9_]*)/g)].map((match) => resolveRuntime(match[1]));
  if (runtimeIds.length === 0) {
    errors.push("descriptor-registry: no descriptor runtimeIds found (registry gutted?)");
  }
  for (const id of runtimeIds) {
    if (!DESCRIPTOR_RUNTIME_ALLOWLIST.includes(id)) {
      errors.push(`descriptor-registry: runtime "${id}" is not an approved production runtime (gate review required)`);
    }
  }
  for (const format of [...descriptors.matchAll(/format:\s*"([^"]+)"/g)].map((match) => match[1])) {
    if (!DESCRIPTOR_FORMAT_ALLOWLIST.includes(format)) {
      errors.push(`descriptor-registry: artifact format "${format}" is not a known model format`);
    }
  }
  const abis = [...descriptors.matchAll(/abis:\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...match[1].matchAll(/"([^"]+)"/g)].map((id) => id[1]),
  );
  if (abis.length === 0) {
    errors.push("descriptor-registry: no descriptor ABIs declared (ABI truth missing)");
  }
  for (const abi of abis) {
    if (!DESCRIPTOR_ABI_ALLOWLIST.includes(abi)) {
      errors.push(`descriptor-registry: ABI "${abi}" is not a known Android ABI`);
    }
  }
  const blocks = (descriptors.match(/_DESCRIPTOR:\s*ModelDescriptor\s*=/g) ?? []).length;
  if (blocks === 0) {
    errors.push("descriptor-registry: no production descriptors found (registry gutted?)");
  }
  for (const field of ["revision:", "sha256:", 'url: "http', "fileName:", "bytes:", "capabilities: [", "taskRoles:", "minRamMb:", 'maturity: "', 'license: "', "consumerTitle:", "consumerDetail:"]) {
    const count = descriptors.split(field).length - 1;
    if (count < blocks) {
      errors.push(`descriptor-registry: descriptor field "${field}" missing on at least one descriptor`);
    }
  }
  // Task roles may be inline or `*_ROLES` constants: every named role must
  // be a real routable task, otherwise the catalogue advertises dead roles.
  const roleArrays = [...descriptors.matchAll(/taskRoles:\s*(\[[^\]]*\]|([A-Za-z0-9_]+))/g)].map((match) => {
    if (match[1].startsWith("[")) return match[1];
    const block = descriptors.match(new RegExp(`const\\s+${match[2]}\\s*[^=]*=\\s*\\[([^\\]]*)\\]`));
    return block ? block[1] : "";
  });
  const knownTasks = ["classify-intent", "extract-report-fields", "answer-help", "extract-search-filters", "analyze-image", "route-intent", "embed-texts", "ground-objects", "classify-category", "summarize-local-context"];
  for (const array of roleArrays) {
    for (const role of [...array.matchAll(/"([^"]+)"/g)].map((match) => match[1])) {
      if (!knownTasks.includes(role)) {
        errors.push(`descriptor-registry: task role "${role}" is not a routable task`);
      }
    }
  }
  const downloadable = (descriptors.match(/downloadable:\s*true/g) ?? []).length;
  const curated = (descriptors.match(/trust:\s*"curated"/g) ?? []).length;
  if (downloadable === 0) {
    errors.push("descriptor-registry: production catalogue is empty (nothing downloadable)");
  }
  if (curated < downloadable) {
    errors.push("descriptor-registry: a downloadable entry is not curated (untrusted models must never ride the catalogue)");
  }
  const service = serviceSource ?? "";
  if (!/default:\s*\n?\s*throw new Error\(`No production runtime adapter/.test(service)) {
    errors.push("descriptor-registry: model removal has no fail-closed default for unknown runtimes (wrong-engine unload risk)");
  }
  if (!/coordinator\.switchTo\("needle"/.test(service) || !/coordinator\.switchTo\("smol-vision"/.test(service)) {
    errors.push("descriptor-registry: heavy switches bypass the residency coordinator (single-resident rule unenforced)");
  }
  // Audit closure: ABI metadata without enforcement is decoration.
  // download() must consult device ABIs through the compatibility
  // boundary (definition + at least one enforcement call site), and the
  // service must actually parse the native ABI facts.
  const compatCalls = (service.match(/requireCompatible\(/g) ?? []).length;
  if (compatCalls < 2 || !/supportedAbis/.test(service)) {
    errors.push("descriptor-registry: download/run ignores declared descriptor ABIs (metadata without enforcement)");
  }
  // Audit closure: taskRoles must decide eligibility. Adapters advertise
  // servesTask and the orchestrator filters candidates by the routed task.
  const runtimes = runtimesSource ?? "";
  if (!/servesTask/.test(runtimes) || !/firstAvailable\([\s\S]{0,200}?taskId/.test(orchestratorSource ?? "")) {
    errors.push("descriptor-registry: model taskRoles never gate runtime selection (roles are documentation-only)");
  }
  // Audit closure: the generic text runtime must stay task-agnostic. Any
  // JSON.parse at the runtime boundary is a Needle-shaped contract that a
  // future prose model could never satisfy; parsing lives in interpreters.
  if (/JSON\.parse/.test(runtimes)) {
    errors.push("descriptor-registry: generic text runtime parses model output (Needle-shaped JSON boundary)");
  }
  // Audit closure: every routable task needs an explicit interpreter, and
  // unlisted tasks must fail instead of succeeding implicitly.
  const interpreters = interpretersSource ?? "";
  for (const task of knownTasks) {
    if (!interpreters.includes(`"${task}"`)) {
      errors.push(`descriptor-registry: routable task "${task}" has no explicit interpreter (implicit success risk)`);
    }
  }
  if (/===\s*undefined\)\s*return \{\s*ok:\s*true/.test(routeValidationSource ?? "")) {
    errors.push("descriptor-registry: unlisted tasks fall through to success (permissive validation hole)");
  }
  // Audit closure: no catalogue order may choose the default model. The
  // registry names its vision default explicitly.
  if (/capabilities\.includes\("vision"\)/.test(descriptors) || !/defaultVisionModelId/.test(descriptors)) {
    errors.push("descriptor-registry: default model chosen by catalogue order instead of explicit policy");
  }
  return errors;
}

function checkDescriptorRegistry() {
  let descriptors;
  let service;
  let models;
  let runtimes;
  let orchestrator;
  let interpreters;
  let routeValidation;
  try {
    descriptors = read("apps/mobile/src/services/ai/modelDescriptors.ts");
    service = read("apps/mobile/src/services/ai/applicationAi.ts");
    models = read("apps/mobile/src/screens/AiModelsRoute.tsx");
    runtimes = read("apps/mobile/src/services/ai/orchestrator/productionRuntimes.ts");
    orchestrator = read("apps/mobile/src/services/ai/orchestrator/AiOrchestrator.ts");
    interpreters = read("apps/mobile/src/services/ai/orchestrator/taskInterpreters.ts");
    routeValidation = read("apps/mobile/src/services/ai/orchestrator/routeValidation.ts");
  } catch (error) {
    return [`descriptor-registry: cannot read registry source (${error.message})`];
  }
  return validateDescriptorRegistry({ descriptorsSource: descriptors, serviceSource: service, modelsSource: models, runtimesSource: runtimes, orchestratorSource: orchestrator, interpretersSource: interpreters, routeValidationSource: routeValidation });
}

export function validatePhotoAnalysisTruth({ clientCapabilitiesSource, serverCapabilitiesSource }) {
  const errors = [];
  for (const [label, source] of [
    ["client", clientCapabilitiesSource],
    ["server", serverCapabilitiesSource],
  ]) {
    for (const pattern of STALE_PHOTO_ANALYSIS_CLAIM_RES) {
      if (pattern.test(source ?? "")) {
        errors.push(`photo-analysis-truth: stale cloud-only photo claim in ${label} capabilities (${pattern})`);
      }
    }
    for (const pattern of REQUIRED_PHOTO_ANALYSIS_TRUTH_RES) {
      if (!pattern.test(source ?? "")) {
        errors.push(`photo-analysis-truth: ${label} capabilities missing required photo truth (${pattern})`);
      }
    }
  }
  return errors;
}

/**
 * User-facing photo-truth detector for the About + Help explainer copy.
 * Fails when either surface:
 * - still carries cloud-only photo phrasing (a selected photo sent straight
 *   to the connected provider as the whole story), or
 * - lost the local-first / engine truth markers (local-first, automatic
 *   fallback, on-device-only, cloud-only).
 */
export const STALE_USER_FACING_PHOTO_CLAIM_RES = [
  /selected (report )?photo is sent to (your connected|the connected) AI provider/i,
  /consented path is the connected cloud provider/i,
];

export const REQUIRED_USER_FACING_PHOTO_TRUTH_RES = [
  /local-first/i,
  /on-device-only/i,
  /cloud-only/i,
  /fall\s?back/i,
];

export function validateUserFacingPhotoTruth({ aboutSource, helpSource }) {
  const errors = [];
  for (const [label, source] of [
    ["About", aboutSource],
    ["Help", helpSource],
  ]) {
    for (const pattern of STALE_USER_FACING_PHOTO_CLAIM_RES) {
      if (pattern.test(source ?? "")) {
        errors.push(`photo-analysis-truth: stale cloud-only photo claim in ${label} copy (${pattern})`);
      }
    }
    for (const pattern of REQUIRED_USER_FACING_PHOTO_TRUTH_RES) {
      if (!pattern.test(source ?? "")) {
        errors.push(`photo-analysis-truth: ${label} copy missing required photo truth (${pattern})`);
      }
    }
  }
  return errors;
}

function checkPhotoAnalysisTruth() {
  let client;
  let server;
  let about;
  let help;
  try {
    client = read("apps/mobile/src/services/appCapabilities.ts");
    server = read("supabase/functions/ai-help/capabilities.ts");
    about = read("apps/mobile/src/screens/About.tsx");
    help = read("apps/mobile/src/screens/Help.tsx");
  } catch (error) {
    return [`photo-analysis-truth: cannot read capability source (${error.message})`];
  }
  return [
    ...validatePhotoAnalysisTruth({
      clientCapabilitiesSource: client,
      serverCapabilitiesSource: server,
    }),
    ...validateUserFacingPhotoTruth({ aboutSource: about, helpSource: help }),
  ];
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
  aiConnectionSource: "apps/mobile/src/screens/AiConnection.tsx",
  aiPreferencesSource: "apps/mobile/src/services/ai/aiPreferences.ts",
  searchScreenSource: "apps/mobile/src/screens/SearchScreen.tsx",
  nlFiltersSource: "apps/mobile/src/services/search/nlFilters.ts",
  searchMappingSource: "apps/mobile/src/services/assistant/searchFilterMapping.ts",
  createReportSource: "apps/mobile/src/screens/CreateReport.tsx",
  categorySuggestionSource: "apps/mobile/src/services/categorySuggestion.ts",
  actionGateSource: "apps/mobile/src/services/ai/orchestrator/actionGate.ts",
  routeIntentSource: "apps/mobile/src/services/ai/ops/routeIntent.ts",
  intentRouterSource: "apps/mobile/src/services/ai/ops/intentRouter.ts",
  chatControllerSource: "apps/mobile/src/services/ai/chatController.ts",
  chatStoreSource: "apps/mobile/src/services/ai/chatStore.ts",
  photoGroundingSource: "apps/mobile/src/services/photoGrounding.ts",
  photoGroundingComponentSource: "apps/mobile/src/components/PhotoGrounding.tsx",
  livePhotoGroundingSource: "apps/mobile/src/services/livePhotoGrounding.ts",
  groundObjectsSource: "apps/mobile/src/services/ai/ops/groundObjects.ts",
};

/**
 * Photo-grounding product-integration invariant (audit FBA-001).
 *
 * Grounding is now a real, reviewed user-facing flow: CreateReport mounts
 * <PhotoGrounding>, which runs a consented item search over the validated
 * ground-objects op through the live local-first transport, then requires
 * explicit selection and separate Apply/Keep review. These tripwires match
 * shipped CALL SITES, not bare imports, so an unwired stub cannot satisfy
 * them. They prove the CODE seam only — device/runtime proof is tracked
 * separately in completion-ledger.json (this gate is not device evidence).
 */
export function validatePhotoGroundingWired(sources) {
  const errors = [];
  const service = sources?.photoGroundingSource ?? "";
  const component = sources?.photoGroundingComponentSource ?? "";
  const transport = sources?.livePhotoGroundingSource ?? "";
  const op = sources?.groundObjectsSource ?? "";
  const createReport = sources?.createReportSource ?? "";

  const required = [
    ["service", service, /from "\.\/ai\/ops\/groundObjects"/, "grounding service must use the validated ground-objects op"],
    ["service", service, /await groundObjects\(/, "grounding service must call the validated op (invented boxes risk)"],
    ["service", service, /input\.imageConsent !== true/, "grounding service must keep its image-consent gate"],
    ["op", op, /CONSENT_REQUIRED:image/, "ground-objects op must refuse without image consent"],
    ["component", component, /groundReportPhoto\(/, "PhotoGrounding must call the live grounding transport"],
    ["component", component, /toCssPercentRect\(/, "PhotoGrounding must render validated boxes as percentage overlays"],
    ["component", component, /Which item are you reporting\?/, "PhotoGrounding must show the disambiguation question"],
    ["component", component, /Apply item title/, "PhotoGrounding must require explicit Apply review"],
    ["component", component, /Keep my title/, "PhotoGrounding must offer Keep (review, never auto-apply)"],
    ["transport", transport, /normalizeImage\(/, "live grounding must normalize the approved image"],
    ["transport", transport, /requestGroundedOptions\(/, "live grounding must route through the validated selector service"],
    ["transport", transport, /transport\.imageUri !== imageUrl/, "live grounding must bind the exact approved image (no URI swap)"],
    ["transport", transport, /resolveAccountOpenRouterKey/, "live grounding must resolve its cloud key through the fail-closed account-bound resolver"],
    ["createReport", createReport, /<PhotoGrounding/, "CreateReport must mount the reviewed grounding component"],
  ];
  for (const [, source, pattern, message] of required) {
    if (!pattern.test(source)) errors.push(`application-integration: ${message}`);
  }
  if (/void\s+input\.imageUri/.test(op)) {
    errors.push("application-integration: ground-objects op discards the image (imageUri voided)");
  }
  return errors;
}

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
    ["matchesSource", /resolveMatchingBackend\([^)]*\)\s*===\s*"needle"[\s\S]{0,200}embedNeedle\(/, "matching must reach selected Needle service"],
    ["visionNativeSource", /registerPlugin<SmolPlugin>\("FindbackSmolVlm"\)/, "Smol TS bridge must bind registered native plugin"],
    ["visionNativeSource", /this\.plugin\(\)\.measureBackend\(args\)/, "TS measurement must invoke native runner"],
    ["probeSource", /override fun timing\(\): TimingRunner\s*=\s*RuntimeTimingRunner\.forInstalledSmol\(appContext\)/, "production timing provider cannot be null"],
    ["timingSource", /conversation\.getBenchmarkInfo\(\)/, "timing must use runtime counters, not synthetic token estimates"],
    ["timingSource", /correctnessPass\s*=\s*correctness/, "timing must report tested correctness"],
    ["pluginSource", /fun measureBackend\([\s\S]+DeviceProbe\.collect(Detailed)?\(/, "native plugin must expose measurement runner"],
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
      /await\s+analyzeLocally\([\s\S]{0,2000}runCloud\(\)/,
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
    // Feature-truth tripwires (v0.6): each fails closed if its product seam
    // is ever disconnected. Patterns match the shipped call sites, not bare
    // imports a stub could satisfy.
    [
      "aiPreferencesSource",
      /export function createAssistantModelBinding/,
      "settings must own a persistent Assistant-model binding (selectedId/onSelectModel)",
    ],
    [
      "aiPreferencesSource",
      /selectedId: load(?:Seeded)?AiPreferences\(accountId\)\.preferredAssistantModel/,
      "binding selectedId must read the persisted per-account default",
    ],
    [
      "aiConnectionSource",
      /load(?:Seeded)?AiPreferences\(account\)\.preferredAssistantModel/,
      "AiConnection must show the persisted default when no explicit selection wins",
    ],
    [
      "aiConnectionSource",
      /selectedId=\{effectiveSelectedId\}/,
      "AiConnection must forward the effective persisted selection to the catalogue sheet",
    ],
    [
      "aiConnectionSource",
      /onSelectModel\?\.\(record\.id\)/,
      "AiConnection must persist the gated selection via onSelectModel",
    ],
    [
      "helpSource",
      /defaultSelection\(accountId\)/,
      "Help must read the persisted default-selection seam (ignoring the default is a regression)",
    ],
    [
      "analyzePhotoSource",
      /CONSENT_REQUIRED/,
      "photo analyzer must require explicit consent before either engine",
    ],
    [
      "analyzePhotoSource",
      /export function getPhotoEngine/,
      "photo analyzer must keep the engine-preference seam (automatic local-first default)",
    ],
    [
      "analyzePhotoSource",
      /resolveAccountOpenRouterKey/,
      "photo analyzer must resolve its cloud key through the fail-closed account-bound resolver (a session lookup at send time retargets on account switch)",
    ],
    [
      "searchScreenSource",
      /from "\.\.\/services\/search\/nlFilters"/,
      "SearchScreen must import the validated nlFilters seam",
    ],
    [
      "searchScreenSource",
      /applyNlFilters/,
      "SearchScreen must route smart search through the validated apply path",
    ],
    [
      "nlFiltersSource",
      /export function toValidatedPatch/,
      "nlFilters must expose the validated-patch composer",
    ],
    [
      "helpSource",
      /mapAssistantSearchFilters\(/,
      "Help NL search must consume validated assistant filters (unvalidated search is a regression)",
    ],
    [
      "searchMappingSource",
      /export function mapAssistantSearchFilters/,
      "validated-filter mapper must exist for NL search",
    ],
    [
      "searchMappingSource",
      /export function navigateToAssistantSearch/,
      "validated-filter navigation must exist for NL search",
    ],
    [
      "searchScreenSource",
      /useUrlParam\("q"\)/,
      "SearchScreen must consume validated query filters from the URL",
    ],
    [
      "suggestionsSource",
      /handleApplyTitle/,
      "report-field AI must apply only through reviewed Apply handlers (bypass is a regression)",
    ],
    [
      "suggestionsSource",
      /handleKeepTitle/,
      "report-field AI must offer Keep (review, never auto-apply)",
    ],
    [
      "suggestionsSource",
      /VLM_CONSENT_COPY/,
      "draft-from-photo consent copy must be mode-derived (static local-first wording lies under pinned modes)",
    ],
    [
      "suggestionsSource",
      /never sent to OpenRouter/,
      "draft-from-photo must carry the on-device-only no-send consent promise",
    ],
    [
      "suggestionsSource",
      /Send this photo to OpenRouter/,
      "draft-from-photo must carry the cloud-only send consent promise",
    ],
    [
      "createReportSource",
      /window\.confirm\("Replace the existing title, description or category/,
      "category suggestions must confirm before overwriting manual fields",
    ],
    [
      "createReportSource",
      /isReleasedCategory\(patch\.suggestedCategory\)/,
      "category suggestions must respect the released-category guard",
    ],
    [
      "categorySuggestionSource",
      /export function resolveCategorySuggestion/,
      "category suggestions must resolve through the confirm-or-override module",
    ],
    [
      "categorySuggestionSource",
      /confirms or overrides/,
      "category suggestions must stay suggestion-only (user confirms or overrides)",
    ],
    [
      "actionGateSource",
      /function validateRouteIntent/,
      "route-intent args must have a validator (unvalidated navigation is a regression)",
    ],
    [
      "routeIntentSource",
      /export function validateRouteIntent/,
      "route-intent op must expose its validator",
    ],
    [
      "intentRouterSource",
      /export function ctaForRoute/,
      "route-intent must resolve only validated CTA targets (unvalidated navigation is a regression)",
    ],
    [
      "intentRouterSource",
      /export function resolveAssistantIntent/,
      "assistant intent chain must stay classify-route-validated-CTA",
    ],
    [
      "chatControllerSource",
      /from "\.\/compaction"/,
      "summary consumer must stay connected to compaction",
    ],
    [
      "chatStoreSource",
      /isSummaryPoisoned/,
      "summary grounding guard must stay connected to compaction",
    ],
  ];
  return requirements.filter(([key, pattern]) => !pattern.test(sources[key] ?? ""))
    .map(([, , message]) => `application-integration: ${message}`);
}

function checkApplicationIntegration() {
  const sources = Object.fromEntries(
    Object.entries(APPLICATION_INTEGRATION_FILES).map(([key, file]) => [key, read(file)]),
  );
  return [
    ...validateApplicationIntegration(sources),
    ...validatePhotoGroundingWired(sources),
  ];
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
  { id: "photo-analysis-truth", run: checkPhotoAnalysisTruth },
  { id: "runtime-wiring", run: checkRuntimeWiring },
  { id: "descriptor-registry", run: checkDescriptorRegistry },
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
   photo-analysis-truth  Analyze-photo copy local-first, no stale cloud-only claim (capabilities + About/Help)
  runtime-wiring    every spec runtime has a production adapter, no lab routes
  descriptor-registry  named descriptors, approved runtimes/formats/ABIs, curated catalogue, fail-closed removal, coordinated residency, enforced ABIs, role-gated selection, raw text boundary, exhaustive interpreters, explicit default
  application-integration  real boot, provider, controls, matching, timing and reviewed grounding path
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
