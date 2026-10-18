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
 *                        channel (FindBack packaging policy, not an upstream
 *                        prohibition on conditional acquisition)
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
 *   12. application-integration — a shipped AI seam is disconnected (startup,
 *                        provider registry, model routes, matching, timing,
 *                        native bridge), the retained §11 text→fields helper
 *                        loses its reviewable Apply/Keep/confirm/released-
 *                        category behaviour, or the report-photo AI and
 *                        assistant→search handoff removed by CF-020 §12 and
 *                        CF-070 R1 come back in any form (module file, import,
 *                        JSX mount or call) anywhere under apps/mobile/src
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseModelProfiles, validateProfiles } from "./check-ai-manifest.mjs";
import { validatePromotion, validateModelBundlePolicy } from "./check-ai-promotion.mjs";
import { checkModelNoticesFile } from "./check-model-notices.mjs";

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
      // catalogOnly preserves lab qualification; packaging is checked below.
      if (profile.catalogOnly !== true) {
        errors.push(`license-bundle: LFM arm ${profile.id} lost its lab qualification marker`);
      }
    }
  }
  errors.push(...validateModelBundlePolicy(licenseSource).map((error) => `license-bundle: ${error}`));
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
// Qwen's native text bridge is wired through the shared residency owner.
// This allowlist approves wiring, not physical-device qualification.
const DESCRIPTOR_RUNTIME_ALLOWLIST = ["needle-cact", "smolvlm2-litertlm", "qwen3-litertlm-text"];
const DESCRIPTOR_FORMAT_ALLOWLIST = ["cact", "litertlm", "gguf", "tflite"];
const DESCRIPTOR_ABI_ALLOWLIST = ["armeabi-v7a", "arm64-v8a", "x86_64"];
const DESCRIPTOR_DOWNLOAD_LICENSE_ALLOWLIST = ["redistributable-cactus", "redistributable-apache-2.0"];

export function validateDescriptorRegistry({ descriptorsSource, serviceSource, modelsSource, runtimesSource, orchestratorSource, interpretersSource, routeValidationSource }) {
  const errors = [];
  for (const [label, source] of [["service", serviceSource], ["models", modelsSource]]) {
    if (/DOWNLOAD_MODELS\[[01]\]/.test(source ?? "")) {
      errors.push(`descriptor-registry: ${label} identifies a model by catalogue position (use the descriptor registry)`);
    }
  }
  const descriptors = descriptorsSource ?? "";
  const source = ts.createSourceFile("modelDescriptors.ts", descriptors, ts.ScriptTarget.Latest, true);
  // Descriptors reference `*_RUNTIME_ID` constants: resolve them from the
  // same source before allowlisting, so an unapproved runtime cannot hide
  // behind an identifier.
  const constStrings = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let init = declaration.initializer;
      if (init && ts.isAsExpression(init)) init = init.expression;
      if (init && ts.isStringLiteral(init) && ts.isIdentifier(declaration.name)) {
        constStrings.set(declaration.name.text, init.text);
      }
    }
  }
  const resolveString = (node) => node && ts.isStringLiteral(node) ? node.text :
    node && ts.isIdentifier(node) ? constStrings.get(node.text) : undefined;
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
  // Parse, do not execute, the source. Global field/trust counts let unrelated
  // Advanced rows compensate for a missing field or an untrusted download.
  const blocks = [];
  const pinBindings = new Map();
  // A pin reference may only come from the canonical profilePin(modelId)
  // binding, never an executable expression supplied as descriptor metadata.
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) &&
          init.expression.text === "profilePin" && init.arguments.length === 1 &&
          ts.isIdentifier(init.arguments[0])) {
        pinBindings.set(declaration.name.getText(source), init.arguments[0].getText(source));
      }
    }
  }
  const isPinReference = (node, field, modelId) => node && ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) && node.name.text === field &&
    pinBindings.get(node.expression.text) === modelId;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(source);
      if (declaration.type?.getText(source) !== "ModelDescriptor" && !name.endsWith("_DESCRIPTOR")) continue;
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
        errors.push(`descriptor-registry: ${name} is not an inspectable descriptor literal`);
        continue;
      }
      const properties = new Map(declaration.initializer.properties.filter(ts.isPropertyAssignment)
        .map((property) => [property.name.getText(source).replace(/^['"]|['"]$/g, ""), property.initializer]));
      if (properties.size !== declaration.initializer.properties.length) {
        errors.push(`descriptor-registry: ${name} has spread, duplicate, or unresolved descriptor metadata`);
      }
      if (declaration.initializer.properties.some((property) => !ts.isPropertyAssignment(property) ||
          (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)))) {
        errors.push(`descriptor-registry: ${name} property names must be literal, not computed`);
      }
      blocks.push({ name, properties });
    }
  }
  if (source.parseDiagnostics.length > 0) errors.push("descriptor-registry: descriptor source does not parse");
  if (blocks.length === 0) {
    errors.push("descriptor-registry: no production descriptors found (registry gutted?)");
  }
  let downloadable = 0;
  for (const { name, properties } of blocks) {
    for (const field of ["modelId", "runtimeId", "format", "revision", "sha256", "url", "fileName", "bytes", "capabilities", "taskRoles", "minRamMb", "maturity", "license", "consumerTitle", "consumerDetail", "downloadable", "trust", "abis"]) {
      if (!properties.has(field)) errors.push(`descriptor-registry: ${name} descriptor field "${field}" missing`);
    }
    const runtime = resolveString(properties.get("runtimeId"));
    if (!DESCRIPTOR_RUNTIME_ALLOWLIST.includes(runtime)) {
      errors.push(`descriptor-registry: ${name} runtimeId is not an approved literal or canonical constant`);
    }
    const format = resolveString(properties.get("format"));
    if (!DESCRIPTOR_FORMAT_ALLOWLIST.includes(format)) {
      errors.push(`descriptor-registry: ${name} format is not an approved artifact format`);
    }
    const flag = properties.get("downloadable");
    if (flag?.kind !== ts.SyntaxKind.TrueKeyword && flag?.kind !== ts.SyntaxKind.FalseKeyword) {
      errors.push(`descriptor-registry: ${name} downloadable must be an inspectable boolean literal`);
    }
    const license = properties.get("license");
    if (!license || !ts.isStringLiteral(license) || !license.text.trim()) {
      errors.push(`descriptor-registry: ${name} license is missing or unresolved`);
    }
    if (flag?.kind !== ts.SyntaxKind.TrueKeyword) continue;
    downloadable++;
    if (!license || !ts.isStringLiteral(license) || !DESCRIPTOR_DOWNLOAD_LICENSE_ALLOWLIST.includes(license.text)) {
      errors.push(`descriptor-registry: ${name} download requires an approved redistributable license`);
    }
    const modelId = properties.get("modelId")?.getText(source);
    if (!modelId) errors.push(`descriptor-registry: ${name} modelId is missing`);
    for (const field of ["sha256", "revision"]) {
      const pin = properties.get(field);
      const literal = pin && ts.isStringLiteral(pin) && (field === "sha256" ? /^[a-f0-9]{64}$/i : /^[a-f0-9]{40}$/i).test(pin.text);
      if (!literal && !isPinReference(pin, field, modelId)) {
        errors.push(`descriptor-registry: ${name} ${field} is not an immutable artifact pin`);
      }
    }
    const trust = properties.get("trust");
    if (!trust || !ts.isStringLiteral(trust) || trust.text !== "curated") {
      errors.push(`descriptor-registry: ${name} downloadable entry is not curated (untrusted models must never ride the catalogue)`);
    }
    const url = properties.get("url");
    // Pinned template URLs and quoted URLs are both valid. No arbitrary
    // executable expression may masquerade as a download identity.
    const urlHead = url && (ts.isStringLiteral(url) || ts.isNoSubstitutionTemplateLiteral(url))
      ? url.text : url && ts.isTemplateExpression(url) ? url.head.text : "";
    if (!urlHead.startsWith("https://")) errors.push(`descriptor-registry: ${name} url must identify an HTTPS download`);
    if (url && ts.isTemplateExpression(url) && url.templateSpans.some((span) =>
      !isPinReference(span.expression, "revision", modelId))) {
      errors.push(`descriptor-registry: ${name} url template may interpolate only its validated revision pin`);
    }
    const abis = properties.get("abis");
    if (!abis || !ts.isArrayLiteralExpression(abis) || abis.elements.length === 0 ||
        abis.elements.some((abi) => !ts.isStringLiteral(abi) || !DESCRIPTOR_ABI_ALLOWLIST.includes(abi.text))) {
      errors.push(`descriptor-registry: ${name} has no verified executable ABI list`);
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
  if (downloadable === 0) {
    errors.push("descriptor-registry: production catalogue is empty (nothing downloadable)");
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
  // boundary in this method; import/evaluation calls elsewhere must not mask
  // a disconnected download check. Parse syntax so comments cannot satisfy it.
  const serviceAst = ts.createSourceFile("applicationAi.ts", service, ts.ScriptTarget.Latest, true);
  let downloadChecksAbi = false;
  for (const statement of serviceAst.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== "ApplicationAiService") continue;
    for (const method of statement.members) {
      if (!ts.isMethodDeclaration(method) || !ts.isIdentifier(method.name) || method.name.text !== "download" || !method.body) continue;
      const visit = (node) => {
        if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) &&
            node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.expression.name.text === "requireCompatible") downloadChecksAbi = true;
        ts.forEachChild(node, visit);
      };
      visit(method.body);
    }
  }
  if (!downloadChecksAbi || !/supportedAbis/.test(service)) {
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
  aiConnectionSource: "apps/mobile/src/screens/AiConnection.tsx",
  aiPreferencesSource: "apps/mobile/src/services/ai/aiPreferences.ts",
  searchScreenSource: "apps/mobile/src/screens/SearchScreen.tsx",
  nlFiltersSource: "apps/mobile/src/services/search/nlFilters.ts",
  createReportSource: "apps/mobile/src/screens/CreateReport.tsx",
  reportFieldSuggestionsSource: "apps/mobile/src/services/reportFieldSuggestions.ts",
  categorySuggestionSource: "apps/mobile/src/services/categorySuggestion.ts",
  actionGateSource: "apps/mobile/src/services/ai/orchestrator/actionGate.ts",
  routeIntentSource: "apps/mobile/src/services/ai/ops/routeIntent.ts",
  intentRouterSource: "apps/mobile/src/services/ai/ops/intentRouter.ts",
  chatControllerSource: "apps/mobile/src/services/ai/chatController.ts",
  chatStoreSource: "apps/mobile/src/services/ai/chatStore.ts",
};

/**
 * Report-photo AI and the assistant→search handoff were removed on purpose
 * (CF-020 §12 removed the consumer-facing report-photo analysis flow and the
 * assistant handoff; CF-070 R1 removed the guided report/search workflow and
 * chat app actions). Their modules are gone, so a tripwire that reads them can
 * only throw — which is what it did, for weeks, while the gate stayed red and
 * unread. The removal is instead asserted as an invariant.
 */
export const RETIRED_REPORT_PHOTO_AI_FILES = [
  "apps/mobile/src/services/analyzeReportPhoto.ts",
  "apps/mobile/src/services/analyzeReportPhotoLocal.ts",
  "apps/mobile/src/components/VlmSuggestions.tsx",
  "apps/mobile/src/services/photoGrounding.ts",
  "apps/mobile/src/components/PhotoGrounding.tsx",
  "apps/mobile/src/services/livePhotoGrounding.ts",
  "apps/mobile/src/services/assistant/searchFilterMapping.ts",
];

/**
 * Retired-module detection, parsed rather than pattern-matched (CF-070 R2
 * retry-2 finding 3).
 *
 * The previous regexes missed a dynamic `import(...)`, a side-effect
 * `import "..."` and a default-imported component, while flagging a call that
 * only appeared in a comment. The TypeScript parser is already a dependency, so
 * the scan reads module specifiers, JSX tags and call expressions from the AST:
 * every import form is seen, and comments are not code.
 */
const RETIRED_AI_MODULE_BASENAMES = new Set([
  "analyzeReportPhoto",
  "analyzeReportPhotoLocal",
  "VlmSuggestions",
  "PhotoGrounding",
  "photoGrounding",
  "livePhotoGrounding",
  "searchFilterMapping",
  "groundObjects",
]);

/** Retired export names: a mount or a call proves the module came back. */
const RETIRED_AI_SURFACE_NAMES = new Set(["VlmSuggestions", "PhotoGrounding"]);
const RETIRED_AI_FUNCTION_NAMES = new Set([
  "mapAssistantSearchFilters",
  "navigateToAssistantSearch",
  "analyzeReportPhoto",
  "analyzeReportPhotoLocally",
  "groundReportPhoto",
  "groundObjects",
]);

function specifierBasename(specifier) {
  const cleaned = specifier.split("?")[0].replace(/\/+$/, "");
  const last = cleaned.split("/").pop() ?? "";
  return last.replace(/\.(tsx?|jsx?|json)$/, "");
}

/**
 * The literal forms of a retired reference this scan reads.
 *
 * In scope: a plain or non-interpolated-template module specifier on a static
 * import/export, `import()`, `require()` or import-equals; a bare identifier,
 * `object.member` or `object["member"]` callee; a JSX mount or `<Namespace.X/>`
 * mount naming a retired surface; and a local binding that reuses a retired
 * entry-point name. Direct forms (aliased, namespace, type-only, side-effect,
 * re-export) are caught at the specifier even when the later use is not
 * understood.
 *
 * Out of scope, and not claimed: a name computed at runtime (`obj[name]`, a
 * concatenated or interpolated specifier, `eval`), aliasing through several
 * local reassignments, and re-export chains buried behind another module. The
 * independent backstop for those is `validateRetiredReportPhotoAi`'s
 * file-existence check: restoring the retired file itself cannot be hidden by
 * how a caller refers to it.
 */
/**
 * JSX element-access mounts (`<Legacy["VlmSuggestions"]/>`) are not valid TSX,
 * so the parser rejects the file and the syntax walk never reaches them. Scan
 * the token stream instead: `<` `Name` `[` `"retired"` `]` `>` (or `/>`). The
 * trailing `>` keeps generic type arguments (`Record["VlmSuggestions"]`) out.
 */
function elementAccessJsxMounts(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source);
  const tokens = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    tokens.push({
      token,
      start: scanner.getTokenStart(),
      value: token === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : null,
    });
    token = scanner.scan();
  }
  const findings = [];
  for (let index = 0; index + 5 < tokens.length; index += 1) {
    if (tokens[index].token !== ts.SyntaxKind.LessThanToken) continue;
    if (tokens[index + 1].token !== ts.SyntaxKind.Identifier) continue;
    if (tokens[index + 2].token !== ts.SyntaxKind.OpenBracketToken) continue;
    if (tokens[index + 3].token !== ts.SyntaxKind.StringLiteral) continue;
    if (tokens[index + 4].token !== ts.SyntaxKind.CloseBracketToken) continue;
    const closing = tokens[index + 5].token;
    if (closing !== ts.SyntaxKind.GreaterThanToken && closing !== ts.SyntaxKind.SlashToken) continue;
    // A generic type argument (`Partial<Record["VlmSuggestions"]>`) is preceded
    // by the generic name; a JSX mount never follows an identifier or a dot.
    const before = tokens[index - 1];
    if (before !== undefined && (before.token === ts.SyntaxKind.Identifier || before.token === ts.SyntaxKind.DotToken)) {
      continue;
    }
    const name = tokens[index + 3].value;
    if (name !== null && RETIRED_AI_SURFACE_NAMES.has(name)) {
      findings.push({ kind: "mount", detail: name, start: tokens[index].start });
    }
  }
  return findings;
}

export function retiredAiReferences(file, source) {
  const findings = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  /** A string literal or a template literal with no interpolation. */
  const literalText = (node) => {
    if (node === undefined) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
  };

  const moduleSpecifierOf = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return literalText(node.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      return literalText(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        return literalText(node.arguments[0]);
      }
    }
    return null;
  };

  /** The retired name a member or element access is spelled with, if any. */
  const accessedName = (node) => {
    if (node === undefined) return null;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return literalText(node.argumentExpression);
    return null;
  };

  const visit = (node) => {
    const specifier = moduleSpecifierOf(node);
    if (specifier !== null && RETIRED_AI_MODULE_BASENAMES.has(specifierBasename(specifier))) {
      findings.push({ kind: "import", detail: specifier });
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      if (RETIRED_AI_SURFACE_NAMES.has(tag)) {
        findings.push({ kind: "mount", detail: tag, start: node.getStart(sourceFile) });
      } else {
        const member = accessedName(node.tagName);
        if (member !== null && RETIRED_AI_SURFACE_NAMES.has(member)) {
          findings.push({ kind: "mount", detail: member, start: node.getStart(sourceFile) });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : accessedName(callee);
      if (name !== null && RETIRED_AI_FUNCTION_NAMES.has(name)) {
        findings.push({ kind: "call", detail: name });
      }
    }
    // A local that reuses a retired entry-point name is the alias form
    // (`const analyzeReportPhoto = async () => []; const run = analyzeReportPhoto;`).
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (RETIRED_AI_FUNCTION_NAMES.has(node.name.text)) {
        findings.push({ kind: "call", detail: `${node.name.text} (rebound locally)` });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  // The token scan adds the element-access mounts the parser cannot represent;
  // one already reported at the same position is not reported twice.
  const seen = new Set(findings.map((finding) => `${finding.kind}:${finding.start ?? "?"}`));
  for (const finding of elementAccessJsxMounts(source)) {
    if (seen.has(`${finding.kind}:${finding.start}`)) continue;
    seen.add(`${finding.kind}:${finding.start}`);
    findings.push(finding);
  }
  return findings;
}

/**
 * Every shipped (non-test) mobile source under a directory, so a new importer of
 * a retired module is caught wherever it is added.
 */
export function collectShippedSources(rootDir, baseDir = rootDir) {
  const out = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const absolute = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectShippedSources(absolute, baseDir));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push({ file: relative(baseDir, absolute), source: readFileSync(absolute, "utf8") });
  }
  return out;
}

/**
 * Fails closed when the retired report-photo AI or assistant→search handoff
 * comes back, in any form: the module file reappearing, a new import of it, a
 * JSX mount, or a call to a retired entry point.
 */
export function validateRetiredReportPhotoAi({ missingFiles = [], shippedSources = [] } = {}) {
  const errors = [];
  for (const { file, present } of missingFiles) {
    if (present) {
      errors.push(`retired-report-photo-ai: ${file} is back in the tree (CF-020 §12 removal regressed)`);
    }
  }
  const messages = {
    import: "imports a retired report-photo AI module",
    mount: "mounts a retired report-photo AI surface",
    call: "calls a retired report-photo AI entry point",
  };
  for (const { file, source } of shippedSources) {
    for (const finding of retiredAiReferences(file, source)) {
      errors.push(
        `retired-report-photo-ai: ${file} ${messages[finding.kind]} (${finding.detail})`,
      );
    }
  }
  return errors;
}

/** The field each reviewed patch applies to, and the state setter that owns it. */
const REPORT_FIELD_SETTERS = {
  title: "setTitle",
  description: "setDescription",
  date: "setEventDate",
  category: "setCategory",
};

function parseGatedSource(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Every node in the subtree, the root included. */
function walkTree(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walkTree(child, visit));
}

/** Nodes the picker returns for, collected over the whole subtree. */
function collectNodes(node, pick) {
  const out = [];
  walkTree(node, (candidate) => {
    const hit = pick(candidate);
    if (hit !== undefined && hit !== null) out.push(hit);
  });
  return out;
}

function findNamedFunction(sourceFile, name) {
  let found = null;
  walkTree(sourceFile, (node) => {
    if (found === null && ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === name) {
      found = node;
    }
  });
  return found;
}

function callsNamed(scope, name) {
  return collectNodes(scope, (node) =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name ? node : null,
  );
}

/**
 * The names that resolve to a reviewed setter within `scope`: the setters and
 * any local bound to one (`const wipe = setDescription`). An alias of a setter
 * is still a setter, so a write through it is still a write to a reviewed field
 * (CF-070 R2 retry-9 A4).
 */
function namesResolvingToSetters(scope, setterNames) {
  const names = new Set(setterNames);
  let changed = true;
  while (changed) {
    changed = false;
    walkTree(scope, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return;
      if (names.has(node.name.text)) return;
      const inner = unwrapExpression(node.initializer);
      if (inner !== undefined && ts.isIdentifier(inner) && names.has(inner.text)) {
        names.add(node.name.text);
        changed = true;
      }
    });
  }
  return names;
}

/** Strips parentheses, `as`/type assertions and `!` to reach the value. */
function unwrapExpression(node) {
  let current = node;
  while (current !== undefined) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

/**
 * A value expression that reads state without changing any: an identifier, a
 * literal, or a member read whose object is itself one of those. Calls,
 * assignments, `++`/`--`, `new` and `await` all change or depend on state a
 * later statement can observe, so none of them is one (CF-070 R2 retry-7
 * R6-2/K6).
 */
function isSideEffectFreeExpression(node) {
  const inner = node === undefined ? undefined : unwrapExpression(node);
  if (inner === undefined) return false;
  if (
    ts.isIdentifier(inner) ||
    ts.isNumericLiteral(inner) ||
    ts.isStringLiteral(inner) ||
    ts.isNoSubstitutionTemplateLiteral(inner) ||
    ts.isRegularExpressionLiteral(inner)
  ) {
    return true;
  }
  if (
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    inner.kind === ts.SyntaxKind.FalseKeyword ||
    inner.kind === ts.SyntaxKind.NullKeyword ||
    inner.kind === ts.SyntaxKind.ThisKeyword ||
    inner.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(inner)) return isSideEffectFreeExpression(inner.expression);
  if (ts.isElementAccessExpression(inner)) {
    return (
      isSideEffectFreeExpression(inner.expression) &&
      (inner.argumentExpression === undefined || isSideEffectFreeExpression(inner.argumentExpression))
    );
  }
  if (ts.isTemplateExpression(inner)) {
    return inner.templateSpans.every((span) => isSideEffectFreeExpression(span.expression));
  }
  return false;
}

/**
 * A statement that changes nothing a later statement can observe: a discarded
 * literal, or a `void` discard whose operand is a pure read. Used to see through
 * the padding a formatter or a lint rule can add in front of a refusal
 * (CF-070 R2 retry-5 N6/N7).
 *
 * The `void` arm was any expression at all, so `{ void setDescription(""); return; }`
 * read as an instantaneous refusal and a title-cancel that cleared an unrelated
 * field stayed green (CF-070 R2 retry-7 R6-2/K6). A discarded write is not a
 * no-op: only a provably side-effect-free operand counts.
 */
function isNoOpStatement(statement) {
  if (!ts.isExpressionStatement(statement)) return false;
  const inner = unwrapExpression(statement.expression);
  if (inner === undefined) return false;
  if (ts.isVoidExpression(inner)) return isSideEffectFreeExpression(inner.expression);
  return (
    ts.isNumericLiteral(inner) ||
    ts.isStringLiteral(inner) ||
    ts.isNoSubstitutionTemplateLiteral(inner) ||
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    inner.kind === ts.SyntaxKind.FalseKeyword ||
    inner.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * A refusal that stops the enclosing statement at once: a bare `return;`, or a
 * block whose last top-level statement is a bare `return;` and whose earlier
 * statements are no-ops (`{ void 0; return; }`, `{ 0; return; }`).
 *
 * A return buried inside a nested function
 * (`{ (function () { return; })(); }`), a `throw`, a block whose return is not
 * last, or the same block followed by more work (`{ return; } setTitle(…)`)
 * does not refuse the guard it appears under, so none counts (CF-070 R2
 * retry-4 finding 3, mutant M1; retry-5 N6 false positive).
 */
function refusesAtOnce(statement) {
  if (statement === undefined) return false;
  if (ts.isReturnStatement(statement)) return statement.expression === undefined;
  if (ts.isBlock(statement)) {
    const statements = statement.statements;
    if (statements.length === 0) return false;
    const last = statements[statements.length - 1];
    if (!ts.isReturnStatement(last) || last.expression !== undefined) return false;
    return statements.slice(0, -1).every(isNoOpStatement);
  }
  return false;
}

/**
 * True when the statement list this node lives in has already left the function
 * before the node: a bare `return`/`throw` statement appears earlier in the same
 * list. Such a node is dead code, so a use of a reviewed result placed after a
 * fabricated return cannot count as that result being consumed (CF-070 R2
 * retry-5 N3).
 *
 * Deliberately shallow: it walks up to the nearest statement list and looks for
 * an earlier statement that unconditionally exits. It does not claim control-flow
 * analysis — a conditional exit (`if (x) return;`) is not one.
 */
function precededByUnconditionalExit(node) {
  let current = node;
  while (
    current.parent !== undefined &&
    !ts.isBlock(current.parent) &&
    !ts.isSourceFile(current.parent) &&
    !ts.isModuleBlock(current.parent) &&
    !ts.isCaseClause(current.parent) &&
    !ts.isDefaultClause(current.parent)
  ) {
    current = current.parent;
  }
  const statements = current.parent?.statements;
  if (statements === undefined) return false;
  for (const statement of statements) {
    if (statement === current) break;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  }
  return false;
}

/**
 * A value a later statement could observe: not an assignment target, a
 * declaration name, the operand of `void`, or a statement on its own. A
 * reference that survives this test is the reviewed result being read
 * (CF-070 R2 retry-5 N3).
 */
function isDiscardedReference(node) {
  const parent = node.parent;
  if (parent === undefined) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node) {
    return true;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isVoidExpression(parent)) return true;
  if (ts.isExpressionStatement(parent)) return true;
  return false;
}

/** Returned by `staticValue` when a node's value is not knowable statically. */
const UNKNOWN_STATIC_VALUE = Symbol("unknown-static-value");

/**
 * The value a node folds to when the compiler can know it: literals, `!x`,
 * `-x`, and a comparison or logical combination of two such values
 * (`1 === 2`, `true && false`, `"a" !== "a"`).
 *
 * The retry-4 evaluator only knew bare literals, so `if (1 === 2) { … }` was an
 * unreachable branch the gate could not see (CF-070 R2 retry-5 N2).
 */
function staticValue(node, locals) {
  const inner = node === undefined ? undefined : unwrapExpression(node);
  if (inner === undefined) return UNKNOWN_STATIC_VALUE;
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (inner.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(inner)) return Number(inner.text);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isIdentifier(inner)) {
    // A loop header may bind its own induction variable (`for (let i = 0; i < 0; …)`);
    // folding the condition against that binding is what makes the empty loop
    // statically false (CF-070 R2 retry-9 B5).
    if (locals !== undefined && locals.has(inner.text)) return locals.get(inner.text);
    if (inner.text === "undefined") return undefined;
    return UNKNOWN_STATIC_VALUE;
  }
  if (
    ts.isCallExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "Boolean" &&
    inner.arguments.length === 1
  ) {
    // `Boolean(<static>)` folds the way the compiler folds it, so a guard behind
    // `while (Boolean(false)) { … }` is the same dead guard (CF-070 R2 retry-9 B7).
    const value = staticValue(inner.arguments[0], locals);
    return value === UNKNOWN_STATIC_VALUE ? UNKNOWN_STATIC_VALUE : Boolean(value);
  }
  if (ts.isPrefixUnaryExpression(inner)) {
    if (inner.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = staticValue(inner.operand, locals);
      return operand === UNKNOWN_STATIC_VALUE ? UNKNOWN_STATIC_VALUE : !operand;
    }
    if (inner.operator === ts.SyntaxKind.MinusToken) {
      const operand = staticValue(inner.operand, locals);
      return operand === UNKNOWN_STATIC_VALUE ? UNKNOWN_STATIC_VALUE : -Number(operand);
    }
    return UNKNOWN_STATIC_VALUE;
  }
  if (ts.isBinaryExpression(inner)) {
    const op = inner.operatorToken.kind;
    const left = staticValue(inner.left, locals);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
      return left ? staticValue(inner.right, locals) : left;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      if (left === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
      return left ? left : staticValue(inner.right, locals);
    }
    const right = staticValue(inner.right, locals);
    if (left === UNKNOWN_STATIC_VALUE || right === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
    switch (op) {
      // Arithmetic the compiler folds. Without it, `while (1 - 1) { … }` is an
      // unknown condition the walk cannot see through (CF-070 R2 retry-9 B6).
      case ts.SyntaxKind.MinusToken:
        return Number(left) - Number(right);
      case ts.SyntaxKind.AsteriskToken:
        return Number(left) * Number(right);
      case ts.SyntaxKind.PlusToken:
        if (typeof left === "number" && typeof right === "number") return left + right;
        if (typeof left === "string" || typeof right === "string") return String(left) + String(right);
        return UNKNOWN_STATIC_VALUE;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return left !== right;
      case ts.SyntaxKind.LessThanToken:
        return left < right;
      case ts.SyntaxKind.GreaterThanToken:
        return left > right;
      case ts.SyntaxKind.LessThanEqualsToken:
        return left <= right;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return left >= right;
      default:
        return UNKNOWN_STATIC_VALUE;
    }
  }
  return UNKNOWN_STATIC_VALUE;
}

/** A literal the compiler can fold to `false` (`false`, `0`, `""`, `null`, `1 === 2`, …). */
function isStaticallyFalsy(node) {
  const value = staticValue(node);
  return value !== UNKNOWN_STATIC_VALUE && !value;
}

/**
 * True when an iterable in a `for … of` / `for … in` header is statically
 * empty, so the loop body never runs: `for (const _skip of []) { … }`. A
 * non-empty literal, an identifier or a call is not statically empty.
 */
function staticallyEmptyIterable(node) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return false;
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.length === 0;
  if (ts.isObjectLiteralExpression(inner)) return inner.properties.length === 0;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text.length === 0;
  return false;
}

/** The loop header's induction bindings whose values are static (`let i = 0`). */
function loopInitializerConstants(initializer) {
  const locals = new Map();
  if (initializer === undefined || !ts.isVariableDeclarationList(initializer)) return locals;
  for (const declaration of initializer.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
    const value = staticValue(declaration.initializer);
    if (value !== UNKNOWN_STATIC_VALUE) locals.set(declaration.name.text, value);
  }
  return locals;
}

/** True when a `for` header's condition folds false once its bindings are known. */
function forLoopConditionFalsy(node) {
  const condition = node.condition;
  if (condition === undefined) return false;
  if (isStaticallyFalsy(condition)) return true;
  const locals = loopInitializerConstants(node.initializer);
  if (locals.size === 0) return false;
  const value = staticValue(condition, locals);
  return value !== UNKNOWN_STATIC_VALUE && !value;
}

/**
 * True when a loop never runs: `while (false)`, `for (; false; )`, a `for … of`
 * / `for … in` over a literal empty iterable, or a counted `for` whose condition
 * folds false at its own initial value. A `do … while` is deliberately absent —
 * its body runs once, so a guard there is live.
 */
function staticallyFalseLoop(node) {
  if (ts.isWhileStatement(node)) return isStaticallyFalsy(node.expression);
  if (ts.isForStatement(node)) return forLoopConditionFalsy(node);
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return staticallyEmptyIterable(node.expression);
  }
  return false;
}

/** A statement that leaves the statement list holding it whatever the values are. */
function isUnconditionalExit(statement) {
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  );
}

/** The statements a node holds in order, when it holds any. */
function statementListOf(node) {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) return node.statements ?? null;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements ?? null;
  return null;
}

/**
 * True when the node sits after an unconditional `return`/`throw`/`break`/
 * `continue` in the statement list that holds it, at any level of its ancestry.
 * A loop body and a `switch` case are statement lists like any other, so
 * `while (true) { break; … }` and `for (;;) { break; … }` both spell a guard the
 * walk cannot fold away by condition while the list it lives in never reaches it
 * (CF-070 R2 retry-8 F-1/B, B2).
 */
function followsUnconditionalExit(node) {
  let current = node;
  while (current !== undefined && current.parent !== undefined) {
    const parent = current.parent;
    const statements = statementListOf(parent);
    if (statements !== null) {
      const index = statements.indexOf(current);
      if (index > 0 && statements.slice(0, index).some(isUnconditionalExit)) return true;
    }
    current = parent;
  }
  return false;
}

/**
 * True when the node sits in a branch the compiler folds away: inside
 * `if (false) { … }`, in the taken-when-true arm of a conditional whose
 * condition is a literal falsy, or inside a loop whose condition is one
 * (`while (1 === 2) { … }`, `for (; false; )`). Such a branch never runs, so a
 * guard there is not a guard (CF-070 R2 retry-4 finding 3, mutants A4/A5/A9).
 *
 * The loop arm closes the retry-5 spelling hole: the walk knew constant-false
 * `if`, and a constant-false `while` smuggled the same dead guard through
 * (CF-070 R2 retry-7 R6-2/K2). A `do … while (false)` is deliberately NOT one:
 * its body runs once, so a guard there is live.
 *
 * The reachability arm closes the retry-7 hole: a guard the walk cannot fold by
 * its condition (`while (true) { break; … }`, `for (;;) { break; … }`) is still
 * dead when the statement list that holds it already left — by an unconditional
 * `return`, `throw`, `break` or `continue` written above it (CF-070 R2 retry-8
 * F-1/B, B2).
 */
function hasStaticallyFalseAncestor(node) {
  if (followsUnconditionalExit(node)) return true;
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isIfStatement(current) && isStaticallyFalsy(current.expression)) return true;
    if (
      ts.isWhileStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isForInStatement(current)
    ) {
      // `WhileStatement.expression` is its condition; `ForStatement.condition`
      // is its own. Reading `.condition` for both silently missed the `while`
      // spelling (CF-070 R2 retry-7 R6-2/K2). The header test also folds a
      // counted `for` whose condition is false at its own initial value, and a
      // `for … of` / `for … in` over a literal empty iterable (retry-9 B4-B7).
      if (staticallyFalseLoop(current)) return true;
    }
    if (ts.isConditionalExpression(current) && isStaticallyFalsy(current.condition)) {
      let child = node;
      while (child.parent !== undefined && child.parent !== current) child = child.parent;
      if (child === current.whenTrue) return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * True when the node sits inside a function nested within `scope`.
 *
 * A guard's `return` must leave the handler that owns the write. A refusal
 * buried in a function the handler merely calls (`(() => { if (!confirm(…))
 * return; })();`, `const askConfirm = () => { … }; askConfirm();`) returns from
 * that function, so the write it was supposed to stop still runs
 * (CF-070 R2 retry-7 R6-2/K1, K3).
 */
function isInsideNestedFunction(node, scope) {
  let current = node.parent;
  while (current !== undefined && current !== scope) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function propertyAccessNamed(node, objectName, propertyName) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === objectName &&
    node.name.text === propertyName
  );
}

/**
 * `object.member` or `object["member"]` — the two spellings of the same access.
 * Routing both through one predicate keeps a hijack through element access
 * (`window["confirm"] = () => true`) as visible as the dot spelling
 * (CF-070 R2 retry-5 N5).
 */
function accessesMember(node, objectName, propertyName) {
  if (propertyAccessNamed(node, objectName, propertyName)) return true;
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === objectName &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === propertyName
  );
}

/**
 * The member a property/element access chain bottoms out at, or null:
 * `patch["field"]` and `patch.field` both name `{ object: "patch", member: "field" }`.
 */
function memberAccessOf(node) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return null;
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
    return { object: inner.expression.text, member: inner.name.text };
  }
  if (
    ts.isElementAccessExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    ts.isStringLiteral(inner.argumentExpression)
  ) {
    return { object: inner.expression.text, member: inner.argumentExpression.text };
  }
  return null;
}

/**
 * `if (patch.field === "<field>") { … }`, wherever the comparison sits in the
 * else-if chain. The test must BE the comparison: `false && patch.field === …`
 * is a different shape and is not a reachable branch. The right side may be the
 * literal itself, a cast of it (`("title" as const)`), or a typed constant that
 * resolves to the literal (`const TITLE_FIELD = "title" as const`), which are
 * behaviour-preserving spellings of the same branch.
 */
function fieldBranch(handler, field, sourceFile) {
  return collectNodes(handler, (node) => {
    if (!ts.isIfStatement(node)) return null;
    const test = node.expression;
    if (!ts.isBinaryExpression(test)) return null;
    if (test.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
    if (!propertyAccessNamed(test.left, "patch", "field")) return null;
    const right = stringLiteralValue(sourceFile, test.right);
    if (right === null || right !== field) return null;
    return node;
  })[0] ?? null;
}

/** True for the assignment operators that write their left-hand side. */
function isAssignmentOperator(kind) {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

/**
 * The `const` binding a name resolves to, when the value it holds at run time is
 * still the declared one: exactly one declaration of that name, declared with
 * `const`, and no write to it anywhere in the file (`=`, a compound assignment,
 * `++`/`--`).
 *
 * Reading a name to its *declaration* literal is not the same as knowing its
 * value. `let CAT_KEEP_KEY = "categorySuggestion"; CAT_KEEP_KEY = "nope";` reads
 * as the reviewed key while the value that runs is another one, so the gate kept
 * a Keep key that resolves nothing and shipped it green through the whole mobile
 * suite (CF-070 R2 retry-8 F-1/E). A binding that can be written is therefore
 * not resolved at all — this is the only static defence for the class, so it errs
 * closed.
 */
/** True for the nodes that open a parameter scope. */
function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * The binding of `name` visible at `node`: the nearest enclosing parameter or
 * `let`/`const`/`var` declaration in a statement list, walking outward. This is
 * what makes an alias of a setter still a setter and an unrelated same-named
 * parameter not one, without matching on text alone (CF-070 R2 retry-9 A4, Q1,
 * Q3).
 */
function nearestBindingOf(node, name) {
  let current = node.parent;
  while (current !== undefined) {
    if (isFunctionLike(current)) {
      for (const parameter of current.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return parameter;
      }
    }
    const statements = statementListOf(current);
    if (statements !== null) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
        }
      }
    }
    current = current.parent;
  }
  return null;
}

/** The one declaration of `name` in a file, or null when there are none or many. */
function soleDeclarationNamed(sourceFile, name) {
  const declarations = collectNodes(sourceFile, (node) =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name ? node : null,
  );
  return declarations.length === 1 ? declarations[0] : null;
}

/**
 * True when `declaration` is written anywhere: an assignment, a compound
 * assignment or `++`/`--` whose target resolves back to *this* binding. A write
 * that resolves to a nearer binding of the same name (a shadowing parameter or
 * a local re-declaration) is not a write to this one (CF-070 R2 retry-9 E, Q3).
 */
function isBindingWritten(sourceFile, declaration, name) {
  let written = false;
  walkTree(sourceFile, (node) => {
    if (written) return;
    let target = null;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      target = unwrapExpression(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      target = unwrapExpression(node.operand);
    }
    if (target === null || target === undefined) return;
    if (!ts.isIdentifier(target) || target.text !== name) return;
    if (nearestBindingOf(target, name) === declaration) written = true;
  });
  return written;
}

/**
 * The binding a name resolves to when the value it holds at run time is still
 * the declared one: the binding visible at the use site (or, for an imported
 * export with no use site in this file, the file's only declaration of that
 * name), with an initializer and no write to *that* binding anywhere in the
 * file (`=`, a compound assignment, `++`/`--`).
 *
 * Reading a name to its *declaration* literal is not the same as knowing its
 * value. `let CAT_KEEP_KEY = "categorySuggestion"; CAT_KEEP_KEY = "nope";` reads
 * as the reviewed key while the value that runs is another one, so the gate kept
 * a Keep key that resolves nothing and shipped it green through the whole mobile
 * suite (CF-070 R2 retry-8 F-1/E).
 *
 * The resolution is by binding, not by text: a `let`/`var` that is bound to the
 * literal and never written is honest and resolves (retry-9 P5, P8); a write to
 * a *shadowing* parameter or re-declaration of the same name is not a write to
 * this binding, so it neither forges nor breaks resolution (retry-9 Q1, Q3).
 * When no binding of the name is visible at the use site the file's only
 * declaration is used, which is the retry-8 behaviour a use site in another
 * function still expects (and which cannot be a real harm: a name visible
 * nowhere would not compile). This is the class's only static defence, so it
 * errs closed on a real write.
 */
function trustedConstBinding(sourceFile, name, atNode) {
  const declaration =
    atNode !== undefined
      ? nearestBindingOf(atNode, name) ?? soleDeclarationNamed(sourceFile, name)
      : soleDeclarationNamed(sourceFile, name);
  if (declaration === null || !ts.isVariableDeclaration(declaration)) return null;
  if (declaration.initializer === undefined) return null;
  if (isBindingWritten(sourceFile, declaration, name)) return null;
  return declaration;
}

/** The named import a local identifier is bound to, when the file imports one. */
function namedImportOf(sourceFile, localName) {
  let found = null;
  walkTree(sourceFile, (node) => {
    if (found !== null || !ts.isImportDeclaration(node)) return;
    const clause = node.importClause;
    if (clause === undefined || clause.namedBindings === undefined) return;
    if (!ts.isNamedImports(clause.namedBindings)) return;
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.name.text !== localName) continue;
      found = {
        module: ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null,
        exported: specifier.propertyName === undefined ? specifier.name.text : specifier.propertyName.text,
      };
    }
  });
  return found;
}

/**
 * The literal an imported binding resolves to, when the gate can read the module
 * it comes from: a relative specifier whose target exists in the repo, holding an
 * `export const NAME = "…"` that passes the same const/never-written rule.
 *
 * A label written once in a sibling copy module is behaviour-preserving, so
 * refusing it is a false positive (CF-070 R2 retry-7 R6-3/P-4). Where the target
 * cannot be read (a bare specifier, a generated file, a module that is not in the
 * tree) the gate keeps refusing and the residual is recorded: refusing a
 * behaviour-preserving spelling is a nit, accepting an unread one would be a hole.
 */
function importedStringLiteralValue(sourceFile, localName) {
  const binding = namedImportOf(sourceFile, localName);
  if (binding === null || binding.module === null) return null;
  if (!binding.module.startsWith("./") && !binding.module.startsWith("../")) return null;
  const base = sourceFile.fileName;
  if (typeof base !== "string" || !base.includes("/")) return null;
  const target = resolve(REPO_ROOT, dirname(base), binding.module);
  const candidates = [
    `${target}.ts`,
    `${target}.tsx`,
    resolve(target, "index.ts"),
    resolve(target, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const source = readFileSync(candidate, "utf8");
    const parsed = ts.createSourceFile(
      candidate,
      source,
      ts.ScriptTarget.Latest,
      true,
      candidate.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const declaration = trustedConstBinding(parsed, binding.exported);
    if (declaration === null) continue;
    // The exported binding may itself hold another constant
    // (`export const LABEL = COPY.label`); resolve the same alias chain the
    // in-file reader follows.
    const resolved = stringLiteralValue(parsed, declaration.initializer);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * The string a node evaluates to when that is knowable statically: the literal,
 * a cast of it, an identifier bound to such a literal by a `const` the file never
 * writes, or an imported binding whose readable module exports the same. Returns
 * null when the value is not a static string.
 */
function stringLiteralValue(sourceFile, node, seen) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return null;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (!ts.isIdentifier(inner)) return null;
  const declaration = trustedConstBinding(sourceFile, inner.text, node);
  if (declaration !== null) {
    const resolved = unwrapExpression(declaration.initializer);
    if (resolved !== undefined && (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved))) {
      return resolved.text;
    }
    if (resolved !== undefined && ts.isIdentifier(resolved)) {
      // One binding may hold another (`const KEEP_ALIAS = KEEP_KEY`); follow the
      // alias chain as long as it cannot cycle (CF-070 R2 retry-9 Q2).
      const guard = seen ?? new Set();
      if (guard.has(inner.text)) return null;
      guard.add(inner.text);
      return stringLiteralValue(sourceFile, resolved, guard);
    }
    return null;
  }
  return importedStringLiteralValue(sourceFile, inner.text);
}

/**
 * The confirmation copy for `field`: the literal that names it, a typed
 * constant the file binds to that literal (`const TITLE_CONFIRM_LABEL = …`),
 * or a template whose text is anchored on the same phrase and whose
 * interpolation is the patch's own field id (`Replace the existing
 * ${patch.field} …`), which are behaviour-preserving spellings of the same
 * guard.
 */
function confirmLabelMatches(sourceFile, node, field) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return false;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return inner.text.includes(`Replace the existing ${field}`);
  }
  if (ts.isTemplateExpression(inner)) {
    if (!inner.head.text.includes("Replace the existing")) return false;
    return inner.templateSpans.some((span) => {
      const access = memberAccessOf(span.expression);
      return access !== null && access.object === "patch" && access.member === "field";
    });
  }
  const bound = stringLiteralValue(sourceFile, inner);
  return bound !== null && bound.includes(`Replace the existing ${field}`);
}

/**
 * `if (!window.confirm("… <field> …")) return;` — a reachable guard whose refusal
 * stops the apply at once, in either access spelling (`window.confirm(…)` /
 * `window["confirm"](…)`), with the label written inline or bound to a typed
 * constant. A bare `window.confirm(…)` call, a `false &&` wrapper, a
 * folded-away branch, a `throw`, a refusal buried in a nested function, or a
 * return that is not the refusal's last act is not this shape, so none counts
 * as confirmation (CF-070 R2 retry-4 finding 3, retry-7 R6-2/K1, K3).
 */
function confirmGuard(scope, field, sourceFile) {
  return collectNodes(scope, (node) => {
    if (!ts.isIfStatement(node)) return null;
    if (isInsideNestedFunction(node, scope)) return null;
    if (hasStaticallyFalseAncestor(node)) return null;
    const test = node.expression;
    if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken) return null;
    const call = unwrapExpression(test.operand);
    if (call === undefined || !ts.isCallExpression(call) || call.arguments.length === 0) return null;
    if (!accessesMember(call.expression, "window", "confirm")) return null;
    if (!confirmLabelMatches(sourceFile, call.arguments[0], field)) return null;
    if (!refusesAtOnce(node.thenStatement)) return null;
    return node;
  })[0] ?? null;
}

/**
 * `if (!isReleasedCategory(<argument>)) return;` — the guard that keeps an
 * unreleased value out of the form. `argumentText` pins the argument when the
 * call site's value is known, and is null when any argument will do. The guard
 * must be reachable, must not sit in a nested function, and must refuse at once.
 */
function releasedCategoryGuard(scope, argumentText) {
  return collectNodes(scope, (node) => {
    if (!ts.isIfStatement(node)) return null;
    if (isInsideNestedFunction(node, scope)) return null;
    if (hasStaticallyFalseAncestor(node)) return null;
    const test = node.expression;
    if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken) return null;
    const call = unwrapExpression(test.operand);
    if (call === undefined || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
    if (call.expression.text !== "isReleasedCategory") return null;
    if (argumentText !== null && call.arguments[0]?.getText() !== argumentText) return null;
    if (!refusesAtOnce(node.thenStatement)) return null;
    return node;
  })[0] ?? null;
}

/** The call a tap performs, once `void`/`await`/parentheses are stripped. */
function tapCallOf(statement) {
  const expression = ts.isExpressionStatement(statement) ? statement.expression : statement;
  let inner = expression;
  while (
    inner !== undefined &&
    (ts.isVoidExpression(inner) || ts.isAwaitExpression(inner) || ts.isParenthesizedExpression(inner))
  ) {
    inner = inner.expression;
  }
  if (inner === undefined || !ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return null;
  return {
    callee: inner.expression.text,
    args: inner.arguments.map((argument) => argument.getText()),
    argNodes: inner.arguments,
  };
}

/** Every call an arrow body performs, block-bodied or expression-bodied. */
function arrowCalls(arrow) {
  if (arrow === undefined || !ts.isArrowFunction(arrow)) return [];
  const statements = ts.isBlock(arrow.body) ? arrow.body.statements : [arrow.body];
  const calls = [];
  for (const statement of statements) {
    const call = tapCallOf(statement);
    if (call !== null) calls.push(call);
  }
  return calls;
}

/**
 * Every `onClick` in the file whose arrow body actually performs a call, with
 * the callee name, the argument texts, and the arrow's declared parameters.
 *
 * A disconnected tap (`() => false && apply(…)`), a tap that returns a function
 * (`() => () => apply(…)`) and an emptied tap (`() => {}`) each produce no
 * entry, which is what makes a tap requirement mean "tapping this applies it".
 * A `void apply(…)` tap (lint style) does perform the call and counts.
 */
function tapCalls(sourceFile) {
  const taps = [];
  walkTree(sourceFile, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText() !== "onClick") return;
    const initializer = node.initializer;
    if (initializer === undefined || !ts.isJsxExpression(initializer)) return;
    const arrow = initializer.expression;
    if (arrow === undefined || !ts.isArrowFunction(arrow)) return;
    const params = arrow.parameters.map((parameter) => parameter.name.getText());
    const calls = arrowCalls(arrow);
    if (calls.length > 0) taps.push({ params, calls });
  });
  return taps;
}

/**
 * True when `name` is bound by a function the node sits inside — the tap for a
 * field suggestion passes the `patch` its list is rendering, not a fresh value.
 */
function isBoundInEnclosingScope(node, name) {
  let current = node.parent;
  while (current !== undefined) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      if (current.parameters.some((parameter) => parameter.name.getText() === name)) return true;
    }
    current = current.parent;
  }
  return false;
}

/** The plain text a JSX child renders, when it is a literal string. */
function jsxChildText(child) {
  if (ts.isJsxText(child)) return child.text.trim();
  if (ts.isJsxExpression(child) && child.expression !== undefined) {
    const inner = unwrapExpression(child.expression);
    if (inner !== undefined && (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner))) {
      return inner.text.trim();
    }
  }
  return null;
}

/** The visible label of a Keep control: "Keep" or "Keep mine". */
const KEEP_LABEL_RE = /^keep(\s+mine)?$/i;

/**
 * The visible Keep controls, with the calls their own `onClick` makes. The label
 * must be a direct child of the element that carries the tap (so an unrelated
 * string in a nested node cannot stand in for it), and it may be written as
 * plain JSX text or as a string inside a JSX expression container.
 */
function keepControls(sourceFile) {
  const controls = [];
  walkTree(sourceFile, (node) => {
    if (!ts.isJsxElement(node)) return;
    const labelled = node.children.some((child) => {
      const text = jsxChildText(child);
      return text !== null && KEEP_LABEL_RE.test(text);
    });
    if (!labelled) return;
    const onClick = node.openingElement.attributes.properties
      .filter(ts.isJsxAttribute)
      .find((attribute) => attribute.name.getText() === "onClick");
    let calls = [];
    if (onClick !== undefined && onClick.initializer !== undefined && ts.isJsxExpression(onClick.initializer)) {
      calls = arrowCalls(onClick.initializer.expression);
    }
    controls.push({ calls });
  });
  return controls;
}

/**
 * The name a reviewed suggester's result is bound to, read off the
 * `Promise.all([suggestX(…), …])` array literal it is awaited in, so a mention
 * in a comment, a stub or a dead branch cannot satisfy the requirement.
 */
function promiseAllBinding(sourceFile, calleeName) {
  let binding = null;
  walkTree(sourceFile, (node) => {
    if (binding !== null) return;
    if (!ts.isCallExpression(node)) return;
    if (!propertyAccessNamed(node.expression, "Promise", "all") || node.arguments.length !== 1) return;
    const array = node.arguments[0];
    if (!ts.isArrayLiteralExpression(array)) return;
    const index = array.elements.findIndex(
      (element) =>
        ts.isCallExpression(element) && ts.isIdentifier(element.expression) && element.expression.text === calleeName,
    );
    if (index === -1) return;
    let current = node;
    while (current !== undefined && !ts.isVariableDeclaration(current)) current = current.parent;
    if (current === undefined || !ts.isArrayBindingPattern(current.name)) return;
    const element = current.name.elements[index];
    if (element === undefined || !ts.isBindingElement(element) || !ts.isIdentifier(element.name)) return;
    binding = element.name.text;
  });
  return binding;
}

/** True when the property access chain bottoms out at the identifier `prefix`. */
function propertyAccessRootedAt(node, prefix) {
  let root = node;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  return ts.isIdentifier(root) && root.text === prefix;
}

/** The identifier a property access chain bottoms out at, or null. */
function rootIdentifierOf(node) {
  let root = node;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  return ts.isIdentifier(root) ? root.text : null;
}

/**
 * True when `setterName(…)` receives the suggester's own result: the field
 * suggester's binding spread into the patch array (`[...fieldsResult.value.suggestions]`),
 * or the category suggester's binding passed straight through
 * (`categoryResult.value.suggestion`).
 *
 * A transform in between (`setAiFieldPatches(substitutePatches(fieldsResult.value.suggestions))`)
 * means the reviewed result no longer reaches the rendered state, so it does not
 * count (CF-070 R2 retry-4 finding 3, mutants A2/A2b).
 */
function feedsSetter(sourceFile, setterName, prefix, shape) {
  return callsNamed(sourceFile, setterName).some((call) =>
    call.arguments.some((argument) => {
      const inner = unwrapExpression(argument);
      if (inner === undefined) return false;
      if (shape === "array") {
        if (!ts.isArrayLiteralExpression(inner)) return false;
        return inner.elements.some(
          (element) => ts.isSpreadElement(element) && propertyAccessRootedAt(element.expression, prefix),
        );
      }
      return ts.isPropertyAccessExpression(inner) && propertyAccessRootedAt(inner, prefix);
    }),
  );
}

/** True when the identifier sits in a type (`Awaited<typeof opTask>`). */
function isInTypePosition(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isExpressionStatement(current) || ts.isBlock(current) || ts.isSourceFile(current)) return false;
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * The function-like node the node sits in, or the file when none does. Used to
 * read a returned payload in the scope that owns it.
 */
function enclosingFunctionOf(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

/** The identifier an access chain is rooted in, or null when the node is not one. */
function accessChainRoot(node) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return null;
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return accessChainRoot(inner.expression);
  if (ts.isElementAccessExpression(inner)) return accessChainRoot(inner.expression);
  return null;
}

/** First-wins map of a scope's local names to their initializer expressions. */
function localInitializersOf(scope) {
  const locals = new Map();
  walkTree(scope, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      if (!locals.has(node.name.text)) locals.set(node.name.text, node.initializer);
    }
  });
  return locals;
}

/**
 * True when an expression *is* a read of one of `names`: a chain of identifier,
 * property and element accesses whose root resolves, through the scope's own
 * locals, to the reviewed value (`suggestions: built.suggestions` where
 * `built = buildReportFieldSuggestions(opResult.value.fields)`).
 *
 * Inside a local's own initializer any mention still counts, because a call
 * such as `buildReportFieldSuggestions(result)` is how the reviewed value is
 * computed in the first place (CF-070 R2 retry-8 F-1/C, C2).
 */
function readsReviewedValue(scope, expression, names) {
  const locals = localInitializersOf(scope);
  const root = accessChainRoot(expression);
  if (root === null) return false;
  if (names.has(root)) return true;
  const queue = [locals.get(root)];
  const visited = new Set([root]);
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    let hit = false;
    walkTree(current, (node) => {
      if (!ts.isIdentifier(node)) return;
      if (names.has(node.text)) hit = true;
      const initializer = locals.get(node.text);
      if (initializer !== undefined && !visited.has(node.text)) {
        visited.add(node.text);
        queue.push(initializer);
      }
    });
    if (hit) return true;
  }
  return false;
}

/** The member name of a property or element access, or null. */
function memberAccessName(node) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return null;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteral(inner.argumentExpression)) {
    return inner.argumentExpression.text;
  }
  return null;
}

/** The static name of an object-literal property key, or null. */
function propertyNameOf(nameNode) {
  if (nameNode === undefined) return null;
  if (ts.isIdentifier(nameNode)) return nameNode.text;
  if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) return nameNode.text;
  return null;
}

/** The object literal an expression evaluates to, directly or through a local binding. */
function resolveObjectLiteral(scope, expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return undefined;
  if (ts.isObjectLiteralExpression(inner)) return inner;
  if (!ts.isIdentifier(inner)) return undefined;
  const initializer = localInitializersOf(scope).get(inner.text);
  if (initializer === undefined) return undefined;
  const resolved = unwrapExpression(initializer);
  return resolved !== undefined && ts.isObjectLiteralExpression(resolved) ? resolved : undefined;
}

/**
 * The value an object literal gives a property: its own property first, then any
 * spread it copies (`{ ...manufactured }`). The same lookup the runtime does, so
 * a payload hidden behind a spread is still read (CF-070 R2 retry-9 D4).
 */
function payloadPropertyOf(scope, objectLiteral, name) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameOf(property.name) === name) return unwrapExpression(property.initializer);
  }
  for (const property of objectLiteral.properties) {
    if (!ts.isSpreadAssignment(property)) continue;
    const spread = resolveObjectLiteral(scope, property.expression);
    if (spread === undefined) continue;
    const value = payloadPropertyOf(scope, spread, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Methods that copy or transform a list element-wise without dropping it. */
const REVIEWED_COPY_METHODS = new Set(["map"]);

/**
 * True when an expression's *value* derives from one of `names`: the reviewed
 * value itself, a copy or spread of it (`[ ...built.suggestions ]`,
 * `{ ...built }`), an element-wise copy through `map`, or an alias that holds
 * one. An independent literal is not derived, and neither is a call that
 * narrows or empties the reviewed list (`.slice`, `.filter`): a payload that
 * replaces the reviewed suggestions with another value is fabrication, not
 * consumption (CF-070 R2 retry-9 C6, D2-D4), while a defensive copy or a `map`
 * projection stays derived (retry-9 P9, P10).
 */
function derivesFromReviewed(scope, expression, names, seen) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isSpreadElement(inner)) return derivesFromReviewed(scope, inner.expression, names, seen);
  if (ts.isArrayLiteralExpression(inner)) {
    return (
      inner.elements.length > 0 &&
      inner.elements.every((element) => derivesFromReviewed(scope, element, names, seen))
    );
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.some((property) =>
      ts.isSpreadAssignment(property)
        ? derivesFromReviewed(scope, property.expression, names, seen)
        : ts.isPropertyAssignment(property)
          ? derivesFromReviewed(scope, property.initializer, names, seen)
          : false,
    );
  }
  if (ts.isCallExpression(inner)) {
    const callee = inner.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      REVIEWED_COPY_METHODS.has(callee.name.text) &&
      derivesFromReviewed(scope, callee.expression, names, seen)
    ) {
      return true;
    }
    return false;
  }
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    const member = memberAccessName(inner);
    if (member !== null) {
      const receiver = resolveObjectLiteral(scope, inner.expression);
      if (receiver !== undefined) {
        const value = payloadPropertyOf(scope, receiver, member);
        if (value !== undefined) return derivesFromReviewed(scope, value, names, seen);
      }
    }
    return accessChainRoot(inner) !== null && readsReviewedValue(scope, inner, names);
  }
  if (ts.isIdentifier(inner)) {
    if (names.has(inner.text)) return true;
    const initializer = localInitializersOf(scope).get(inner.text);
    if (initializer === undefined) return false;
    const guard = seen ?? new Set();
    if (guard.has(inner.text)) return false;
    guard.add(inner.text);
    return derivesFromReviewed(scope, initializer, names, guard);
  }
  return false;
}

/**
 * The object literal a `return` hands back: the literal itself, or the binding
 * that holds it (`let manufactured = { … }; return manufactured;`). A payload
 * that merely *sits in* a local is still the payload that ships, so it is read
 * like an inline one (CF-070 R2 retry-8 F-1/D, retry-9 D2-D4).
 */
function returnedPayloadOf(expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return undefined;
  if (ts.isObjectLiteralExpression(inner)) return inner;
  if (!ts.isIdentifier(inner)) return undefined;
  const declaration = trustedConstBinding(inner.getSourceFile(), inner.text, inner);
  if (declaration === null || declaration.initializer === undefined) return undefined;
  const resolved = unwrapExpression(declaration.initializer);
  return resolved !== undefined && ts.isObjectLiteralExpression(resolved) ? resolved : undefined;
}

/**
 * True when a statement list keeps going after an unconditional exit in the
 * same list (`return <fabricated>; … reviewed code …`). The code after the exit
 * cannot run, so the reviewed flow is the dead one (CF-070 R2 retry-7 R6-2/K4,
 * K5). Conditional exits are not exits: `if (x) return y;` leaves the list live.
 */
function hasDeadCodeAfterExit(scope) {
  let dead = false;
  walkTree(scope, (node) => {
    if (!ts.isBlock(node) && !ts.isSourceFile(node) && !ts.isModuleBlock(node)) return;
    const statements = node.statements;
    const index = statements.findIndex(
      (statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement),
    );
    if (index !== -1 && index < statements.length - 1) dead = true;
  });
  return dead;
}

/**
 * The reviewed narrow task must be invoked AND its result awaited and used: a
 * call whose value is dropped (`void extractReportFields(…)`), left in a
 * comment, folded away by the compiler, awaited only after being touched
 * (`opTask.catch(…)` first), or assigned to a local that is later overwritten
 * with a fabricated result, does not count. Returns the message to report, or
 * null when the call is consumed.
 *
 * Two more ways to look like consumption while discarding it are refused here
 * as well: a fabricated early return that leaves the reviewed use as dead code,
 * and a "successful" payload whose suggestions do not come from the reviewed
 * result at all — reading `opResult.value.action` while returning
 * `suggestions: []` is a mention, not a use (CF-070 R2 retry-7 R6-2/K4, K5).
 */
function extractorConsumptionError(helper) {
  const discarded = "report-field helper must use the reviewed narrow task's result, not merely mention the call";
  const calls = callsNamed(helper, "extractReportFields").filter((call) => !isInTypePosition(call));
  if (calls.length === 0) {
    return "report-field helper must actually invoke the reviewed narrow task";
  }

  const tasks = [];
  for (const call of calls) {
    const declaration = call.parent;
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return discarded;
    if (declaration.initializer !== call) return discarded;
    if (!ts.isIdentifier(declaration.name)) return discarded;
    tasks.push({ declaration, name: declaration.name.text });
  }

  for (const { declaration, name } of tasks) {
    const references = collectNodes(helper, (node) =>
      ts.isIdentifier(node) && node.text === name && node !== declaration.name && !isInTypePosition(node)
        ? node
        : null,
    );
    if (references.length === 0) return discarded;
    // The very first thing the helper does with the task must be to await it.
    const first = references[0];
    if (!ts.isAwaitExpression(first.parent) || first.parent.expression !== first) return discarded;

    const awaitingNames = new Set();
    for (const reference of references) {
      if (!ts.isAwaitExpression(reference.parent) || reference.parent.expression !== reference) continue;
      // `opResult = await opTask` and `opResult = (await opTask)` bind the same
      // value; step out of any parentheses to find the binding it feeds
      // (CF-070 R2 retry-5 N10).
      let awaited = reference.parent;
      while (awaited.parent !== undefined && ts.isParenthesizedExpression(awaited.parent)) {
        awaited = awaited.parent;
      }
      const current = awaited.parent;
      if (current !== undefined && ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken && current.right === awaited) {
        if (ts.isIdentifier(current.left)) awaitingNames.add(current.left.text);
      } else if (current !== undefined && ts.isVariableDeclaration(current) && current.initializer === awaited) {
        if (ts.isIdentifier(current.name)) awaitingNames.add(current.name.text);
      }
    }
    for (const awaitingName of awaitingNames) {
      let overwritten = false;
      walkTree(helper, (node) => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (ts.isIdentifier(node.left) && node.left.text === awaitingName && !isAwaitExpressionValue(node.right)) {
            overwritten = true;
          }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === awaitingName && node.initializer !== undefined) {
          if (!isAwaitExpressionValue(node.initializer)) overwritten = true;
        }
      });
      if (overwritten) return discarded;
      // The awaited result must be READ on a path that runs: a reference that is
      // stored, `void`-ed, or left after a bare return is not consumption, and a
      // fabricated result returned ahead of the reviewed use is what mutant N3
      // does (CF-070 R2 retry-5 N3).
      const genuineUse = collectNodes(helper, (node) =>
        ts.isIdentifier(node) && node.text === awaitingName && !isInTypePosition(node) ? node : null,
      ).some((reference) => !isDiscardedReference(reference) && !precededByUnconditionalExit(reference));
      if (!genuineUse) return discarded;

      // The function that awaited the task is the one whose returned payload the
      // caller renders, so both checks read that function: no statement may
      // survive an unconditional exit in the same list (dead reviewed flow), and
      // every payload it reports as successful must carry the reviewed
      // result's suggestions.
      const scope = enclosingFunctionOf(references[0]);
      if (hasDeadCodeAfterExit(scope)) return discarded;
      const reviewed = new Set([awaitingName]);
      const fabricated = collectNodes(scope, (node) => {
        if (!ts.isReturnStatement(node) || node.expression === undefined) return null;
        const payload = returnedPayloadOf(node.expression);
        if (payload === undefined) return null;
        const ok = payloadPropertyOf(scope, payload, "ok");
        if (ok === undefined || staticValue(ok) !== true) return null;
        const value = payloadPropertyOf(scope, payload, "value");
        if (value === undefined) return node;
        const valueLiteral = resolveObjectLiteral(scope, value);
        if (valueLiteral === undefined) return node;
        const suggestions = payloadPropertyOf(scope, valueLiteral, "suggestions");
        if (suggestions === undefined) return node;
        return derivesFromReviewed(scope, suggestions, reviewed) ? null : node;
      });
      if (fabricated.length > 0) return discarded;
    }
  }
  return null;
}

/** True when the node is an `await` expression, parentheses and casts aside. */
function isAwaitExpressionValue(node) {
  const inner = node === undefined ? undefined : unwrapExpression(node);
  return inner !== undefined && ts.isAwaitExpression(inner);
}

/**
 * `call(…)` or `!call(…)`, with the callee's identifier when it has one. Used to
 * read a guard's two operands without matching on their text.
 */
function callSignatureOf(node) {
  const inner = node === undefined ? undefined : unwrapExpression(node);
  if (inner === undefined) return null;
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
    const call = unwrapExpression(inner.operand);
    if (call === undefined || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
    return { name: call.expression.text, negated: true };
  }
  if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return null;
  return { name: inner.expression.text, negated: false };
}

/**
 * The date patch's own validation: `if (!isValidCalendarDate(value) || isFutureDate(value)) return;`
 * must be a reachable refusal that refuses for exactly those two reasons.
 *
 * Read structurally, because the retry-4 check matched the two callee *names*
 * anywhere in the test text: `if (!(isValidCalendarDate(value) || isFutureDate(value))) return;`
 * keeps both names and inverts the sense, letting a future date through
 * (CF-070 R2 retry-5 N1). The test must therefore be a plain disjunction of one
 * negated `isValidCalendarDate(…)` and one plain `isFutureDate(…)`, with no
 * top-level `!` around the disjunction.
 */
function dateValidationGuards(body) {
  return collectNodes(body, (node) => {
    if (!ts.isIfStatement(node)) return null;
    if (isInsideNestedFunction(node, body)) return null;
    if (hasStaticallyFalseAncestor(node)) return null;
    const test = unwrapExpression(node.expression);
    if (test === undefined || !ts.isBinaryExpression(test)) return null;
    if (test.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return null;
    const left = callSignatureOf(test.left);
    const right = callSignatureOf(test.right);
    if (left === null || right === null) return null;
    const invalid = left.name === "isValidCalendarDate" ? left : right.name === "isValidCalendarDate" ? right : null;
    const future = left.name === "isFutureDate" ? left : right.name === "isFutureDate" ? right : null;
    if (invalid === null || future === null) return null;
    if (!invalid.negated || future.negated) return null;
    if (!refusesAtOnce(node.thenStatement)) return null;
    return node;
  });
}

/** True when the code reassigns `window.confirm`, so the dialog is a stub. */
function assignsWindowConfirm(sourceFile) {
  let found = false;
  walkTree(sourceFile, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (accessesMember(node.left, "window", "confirm")) found = true;
    }
  });
  return found;
}

/**
 * The Keep key a field card builds for its own suggestion: a template or a
 * concatenation that names the patch's own `field`, however that access is
 * spelled (`patch.field`, `patch["field"]`, `"field:" + patch.field`). A literal
 * key that is not the patch's own field is not this (CF-070 R2 retry-5 N8/N9).
 */
function keepKeyNamesPatchField(node) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return false;
  const namesField = (candidate) => {
    const access = memberAccessOf(candidate);
    return access !== null && access.object === "patch" && access.member === "field";
  };
  if (ts.isTemplateExpression(inner)) return inner.templateSpans.some((span) => namesField(span.expression));
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [inner.left, inner.right].some((operand) => namesField(operand));
  }
  return false;
}

/**
 * The category Keep key: the reviewed `"categorySuggestion"` key, however the
 * same string is spelled (`("categorySuggestion" as const)`, or a typed
 * constant the file binds to it). Read as the string it resolves to rather than
 * as the source text of the argument, so a cast or a named constant does not
 * read as a different key (CF-070 R2 retry-5 L9, retry-7 R6-3/P2).
 */
function isCategoryKeepKey(sourceFile, node) {
  const inner = unwrapExpression(node);
  if (
    inner !== undefined &&
    (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner))
  ) {
    return inner.text === "categorySuggestion";
  }
  return stringLiteralValue(sourceFile, node) === "categorySuggestion";
}

/**
 * The suggestion cards, read as the JSX that renders them: a card is an element
 * whose subtree performs exactly one Apply call and renders at least one
 * suggested value. Each card must apply the suggestion it renders, and its own
 * Keep must resolve the same suggestion (CF-070 R2 retry-4 finding 3, mutants
 * M2/A7/A8/B12).
 */
function suggestionCards(sourceFile) {
  const cards = [];
  walkTree(sourceFile, (node) => {
    if (!ts.isJsxElement(node)) return;
    const applies = collectNodes(node, (candidate) => {
      if (!ts.isCallExpression(candidate) || !ts.isIdentifier(candidate.expression)) return null;
      const callee = candidate.expression.text;
      return callee === "aiSuggestApplyField" || callee === "aiSuggestApplyCategory" ? candidate : null;
    });
    if (applies.length !== 1) return;
    const renderedValues = collectNodes(node, (candidate) => {
      if (!ts.isPropertyAccessExpression(candidate)) return null;
      if (candidate.name.text !== "suggestedValue" && candidate.name.text !== "suggestedCategory") return null;
      const root = rootIdentifierOf(candidate);
      return root === null ? null : { root, node: candidate };
    });
    if (renderedValues.length === 0) return;
    const keepCalls = collectNodes(node, (candidate) =>
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === "aiSuggestResolve"
        ? candidate
        : null,
    );
    cards.push({ apply: applies[0], renderedValues, keepCalls });
  });
  return cards;
}

/**
 * Report-field apply wiring, read as syntax rather than as text (CF-070 R2
 * retry-3 finding 3).
 *
 * The retry-2 requirements were token presence: `patch.field === "title"` and
 * `window.confirm("Replace the existing title` appearing anywhere in the file
 * satisfied them. The retry-3 review then ran the full gate against 29 source
 * mutations and 23 stayed green — an unreachable branch (`false && …`), a
 * deleted setter, an ignored Cancel, a title that writes to `setDescription`,
 * a disconnected Apply tap, a Keep that resolves nothing, a category path that
 * lost its own confirmation, and a reviewed op whose result is discarded or
 * made unreachable. None of that changes the tokens.
 *
 * These checks read the shipped syntax instead: each field's branch must be the
 * reachable comparison, it must call the setter that owns that field, its
 * confirmation must be a guard whose refusal returns before any setter runs,
 * the released-category guard must precede the category write, each Apply tap
 * must be a call that passes the suggestion it renders, each visible Keep must
 * resolve its own suggestion, and the reviewed ops' results must reach the
 * state the suggestions render from. This is a bounded structural binding, not
 * a proof of runtime behaviour: the behavioural seam it stands for lives in the
 * focused CreateReport tests.
 */
export function reportFieldWiringFindings(sources) {
  const prefix = "application-integration: ";
  const errors = [];
  const createReport = parseGatedSource(
    sources?.createReportPath ?? APPLICATION_INTEGRATION_FILES.createReportSource,
    sources?.createReportSource ?? "",
  );
  const helper = parseGatedSource(
    APPLICATION_INTEGRATION_FILES.reportFieldSuggestionsSource,
    sources?.reportFieldSuggestionsSource ?? "",
  );

  if (assignsWindowConfirm(createReport)) {
    errors.push(
      `${prefix}confirmation must come from the platform dialog, not a window.confirm reassigned to always accept`,
    );
  }

  const applyField = findNamedFunction(createReport, "aiSuggestApplyField");
  if (applyField === null) {
    errors.push(`${prefix}CreateReport must keep the reviewed per-field apply handler`);
  } else {
    for (const [field, setter] of Object.entries(REPORT_FIELD_SETTERS)) {
      const branch = fieldBranch(applyField, field, createReport);
      if (branch === null) {
        errors.push(`${prefix}the ${field} suggestion must have its own reachable apply branch`);
        continue;
      }
      const body = branch.thenStatement;
      const guard = confirmGuard(body, field, createReport);
      if (guard === null) {
        errors.push(`${prefix}replacing an existing ${field} must be confirmed by a reachable guard that refuses`);
      }
      const setters = callsNamed(body, setter);
      if (setters.length === 0) {
        errors.push(`${prefix}the ${field} suggestion must apply through ${setter}`);
      } else {
        const appliesSuggestedValue = setters.some((call) =>
          call.arguments.some((argument) => unwrapExpression(argument)?.getText() === "patch.suggestedValue"),
        );
        if (!appliesSuggestedValue) {
          errors.push(`${prefix}the ${field} suggestion must apply the suggested value, not another one`);
        }
        if (guard !== null) {
          // The confirmation must precede *any* write to a reviewed field, not
          // just the field this branch applies: `setDescription("")` ahead of a
          // still-valid title guard clobbers another reviewed field and slipped
          // through a check that only looked for the branch's own setter
          // (CF-070 R2 retry-8 F-1/A). A local bound to a setter is the same
          // write under another name (retry-9 A4).
          const settersAndAliases = [...namesResolvingToSetters(body, Object.values(REPORT_FIELD_SETTERS))];
          const beforeGuard = settersAndAliases.flatMap((name) => callsNamed(body, name));
          if (beforeGuard.some((call) => call.getStart() < guard.getEnd())) {
            errors.push(
              `${prefix}the ${field} suggestion must not write a reviewed field before its confirmation guard`,
            );
          }
        }
      }
      if (field === "date") {
        const validations = dateValidationGuards(body);
        if (validations.length === 0) {
          errors.push(`${prefix}the date suggestion must keep its calendar validation before applying`);
        } else if (
          validations.some((validation) => setters.some((call) => call.getStart() < validation.getEnd()))
        ) {
          errors.push(`${prefix}the date suggestion must not write the date before its calendar validation`);
        }
      }
      if (field === "category") {
        const released = releasedCategoryGuard(body, "patch.suggestedValue");
        if (released === null) {
          errors.push(`${prefix}the category patch must respect the released-category guard before applying`);
        } else if (setters.some((call) => call.getStart() < released.getEnd())) {
          errors.push(`${prefix}the category patch must not write the category before the released-category guard`);
        }
      }
    }
  }

  const applyCategory = findNamedFunction(createReport, "aiSuggestApplyCategory");
  if (applyCategory === null) {
    errors.push(`${prefix}CreateReport must keep the reviewed separate category apply handler`);
  } else {
    const released = releasedCategoryGuard(applyCategory, null);
    if (released === null) {
      errors.push(`${prefix}the category suggestion must respect the released-category guard before applying`);
    }
    const guard = confirmGuard(applyCategory, "category", createReport);
    if (guard === null) {
      errors.push(
        `${prefix}replacing an existing category from its own suggestion must be confirmed by a reachable guard that refuses`,
      );
    }
    const setters = callsNamed(applyCategory, "setCategory");
    if (setters.length === 0) {
      errors.push(`${prefix}the category suggestion must apply through setCategory`);
    } else {
      const appliesSuggestedValue = setters.some((call) =>
        call.arguments.some((argument) => unwrapExpression(argument)?.getText() === "suggestion.suggestedCategory"),
      );
      if (!appliesSuggestedValue) {
        errors.push(`${prefix}the category suggestion must apply the suggested category, not another one`);
      }
      const latestGuardEnd = Math.max(guard?.getEnd() ?? 0, released?.getEnd() ?? 0);
      if (latestGuardEnd > 0 && setters.some((call) => call.getStart() < latestGuardEnd)) {
        errors.push(`${prefix}the category suggestion must not write the category before its guards`);
      }
    }
  }

  const taps = tapCalls(createReport);
  const fieldTapBound = taps.some((tap) =>
    tap.calls.some(
      (call) =>
        call.callee === "aiSuggestApplyField" &&
        call.argNodes.length === 1 &&
        ts.isIdentifier(call.argNodes[0]) &&
        isBoundInEnclosingScope(call.argNodes[0], call.argNodes[0].text),
    ),
  );
  if (!fieldTapBound) {
    errors.push(
      `${prefix}report-field suggestions must apply only from an explicit per-suggestion tap that passes the suggestion it renders`,
    );
  }
  const categoryTapBound = taps.some((tap) =>
    tap.calls.some((call) => call.callee === "aiSuggestApplyCategory" && call.args.length === 1),
  );
  if (!categoryTapBound) {
    errors.push(`${prefix}the category suggestion must apply only from its own explicit tap`);
  }

  const keeps = keepControls(createReport);
  if (keeps.length < 2) {
    errors.push(`${prefix}report-field suggestions must offer Keep (review, never auto-apply)`);
  } else if (keeps.some((control) => !control.calls.some((call) => call.callee === "aiSuggestResolve"))) {
    errors.push(`${prefix}each Keep control must resolve its own suggestion`);
  }

  const cards = suggestionCards(createReport);
  const fieldCards = cards.filter((card) => card.apply.expression.getText() === "aiSuggestApplyField");
  const categoryCards = cards.filter((card) => card.apply.expression.getText() === "aiSuggestApplyCategory");
  if (fieldCards.length === 0) {
    errors.push(`${prefix}report-field suggestions must render the suggestion they apply`);
  }
  for (const card of fieldCards) {
    const argument = card.apply.arguments.length === 1 ? card.apply.arguments[0] : undefined;
    const name = argument !== undefined && ts.isIdentifier(argument) ? argument.text : null;
    const rendersItself = name !== null && card.renderedValues.some((value) => value.root === name);
    if (name === null || !rendersItself || !isBoundInEnclosingScope(argument, name)) {
      errors.push(`${prefix}report-field suggestions must render the suggestion they apply`);
    }
    const keepsItsOwn = card.keepCalls.some((call) => keepKeyNamesPatchField(call.arguments[0]));
    if (!keepsItsOwn) errors.push(`${prefix}each Keep control must resolve its own suggestion`);
  }
  for (const card of categoryCards) {
    const argument = card.apply.arguments.length === 1 ? card.apply.arguments[0] : undefined;
    const name = argument !== undefined && ts.isIdentifier(argument) ? argument.text : null;
    const rendersItself = name !== null && card.renderedValues.some((value) => value.root === name);
    if (!rendersItself) {
      errors.push(`${prefix}the category suggestion must apply the category it renders`);
    }
    const keepsItsOwn = card.keepCalls.some((call) => isCategoryKeepKey(createReport, call.arguments[0]));
    if (!keepsItsOwn) errors.push(`${prefix}each Keep control must resolve its own suggestion`);
  }

  const fieldBinding = promiseAllBinding(createReport, "suggestReportFields");
  if (fieldBinding === null) {
    errors.push(`${prefix}CreateReport must reach the reviewed field suggester`);
  } else if (!feedsSetter(createReport, "setAiFieldPatches", fieldBinding, "array")) {
    errors.push(`${prefix}the reviewed field suggester's result must reach the rendered patch state`);
  }
  const categoryBinding = promiseAllBinding(createReport, "suggestCategoryForText");
  if (categoryBinding === null) {
    errors.push(`${prefix}CreateReport must reach the reviewed category suggester`);
  } else if (!feedsSetter(createReport, "setAiCatSuggestion", categoryBinding, "value")) {
    errors.push(`${prefix}the reviewed category suggester's result must reach the rendered suggestion state`);
  }

  const extractorError = extractorConsumptionError(helper);
  if (extractorError !== null) errors.push(`${prefix}${extractorError}`);

  return errors;
}

/**
 * Report-field helper invariant (§11 retained narrow assistance).
 *
 * CF-020 §12 removed the consumer-facing report-photo analysis flow and the
 * assistant handoff; what remains is the text→fields helper in CreateReport:
 * two reviewed narrow tasks (fields, category) applied only from an explicit
 * per-suggestion tap, with Keep, confirm-before-overwrite and the
 * released-category guard. The wiring itself is checked on the syntax tree by
 * `reportFieldWiringFindings`, so a stub, a dead branch or a disconnected
 * helper cannot satisfy it, and the pair is closed by
 * `validateRetiredReportPhotoAi`, which fails closed if the removed photo flow
 * comes back anywhere under apps/mobile/src.
 */
export function validateReportFieldHelperWired(sources) {
  const errors = [];
  const helper = sources?.reportFieldSuggestionsSource ?? "";
  const createReport = sources?.createReportSource ?? "";

  const required = [
    ["helper", helper, /export async function suggestReportFields/, "report-field helper must expose the reviewed field suggester"],
    ["helper", helper, /export function isReleasedCategoryPatch/, "report-field helper must keep the released-category guard"],
    ["helper", helper, /REPORT_FIELD_SOURCE\s*=\s*"extract-report-fields"/, "report-field helper must stay bound to its reviewed narrow task"],
  ];
  for (const [, source, pattern, message] of required) {
    if (!pattern.test(source)) errors.push(`application-integration: ${message}`);
  }
  errors.push(...reportFieldWiringFindings(sources));

  // The retained helper takes TEXT. Photo bytes in this path would reintroduce
  // the removed photo analysis under another name.
  for (const [label, source] of [["helper", helper], ["createReport", createReport]]) {
    if (/imageBase64|data:image\//.test(source)) {
      errors.push(
        `application-integration: ${label} passes image bytes into report-field suggestions (report-photo analysis was removed in CF-020 §12)`,
      );
    }
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
    // CF-020 §12 removed the consumer-facing report-photo analysis flow and the
    // assistant→search handoff; CF-070 R1 removed the guided report/search
    // workflow. Their modules are gone (see RETIRED_REPORT_PHOTO_AI_FILES and
    // validateRetiredReportPhotoAi), so the requirements that referenced them
    // were stale assertions about deleted files, not product invariants. What
    // survives is the retained §11 text→fields helper, asserted by
    // validateReportFieldHelperWired.
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
      "searchScreenSource",
      /useUrlParam\("q"\)/,
      "SearchScreen must consume validated query filters from the URL",
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
  const missingFiles = RETIRED_REPORT_PHOTO_AI_FILES.map((file) => ({
    file,
    present: existsSync(resolve(REPO_ROOT, file)),
  }));
  const shippedSources = collectShippedSources(resolve(REPO_ROOT, "apps/mobile/src")).map((entry) => ({
    file: `apps/mobile/src/${entry.file}`,
    source: entry.source,
  }));
  return [
    ...validateApplicationIntegration(sources),
    ...validateReportFieldHelperWired(sources),
    ...validateRetiredReportPhotoAi({ missingFiles, shippedSources }),
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
  { id: "model-notices", run: checkModelNoticesFile },
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
  model-notices     exact source-linked license/attribution/NOTICE text and artifact digests
  abi-artifacts     ABI split config carries every supported ABI
   vision-truth      production vision seam + registration present, copy honest
   photo-analysis-truth  Analyze-photo copy local-first, no stale cloud-only claim (capabilities + About/Help)
  runtime-wiring    every spec runtime has a production adapter, no lab routes
  descriptor-registry  named descriptors, approved runtimes/formats/ABIs, curated catalogue, fail-closed removal, coordinated residency, enforced ABIs, role-gated selection, raw text boundary, exhaustive interpreters, explicit default
  application-integration  real boot, provider, controls, matching, timing, retained report-field helper, retired photo AI stays removed
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
