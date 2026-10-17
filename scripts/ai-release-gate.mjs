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
      if (RETIRED_AI_SURFACE_NAMES.has(tag)) findings.push({ kind: "mount", detail: tag });
      else {
        const member = accessedName(node.tagName);
        if (member !== null && RETIRED_AI_SURFACE_NAMES.has(member)) {
          findings.push({ kind: "mount", detail: member });
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

function containsReturn(node) {
  let found = false;
  walkTree(node, (candidate) => {
    if (ts.isReturnStatement(candidate)) found = true;
  });
  return found;
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
 * `if (patch.field === "<field>") { … }`, wherever the comparison sits in the
 * else-if chain. The test must BE the comparison: `false && patch.field === …`
 * is a different shape and is not a reachable branch.
 */
function fieldBranch(handler, field) {
  return collectNodes(handler, (node) => {
    if (!ts.isIfStatement(node)) return null;
    const test = node.expression;
    if (!ts.isBinaryExpression(test)) return null;
    if (test.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
    if (!propertyAccessNamed(test.left, "patch", "field")) return null;
    if (!ts.isStringLiteral(test.right) || test.right.text !== field) return null;
    return node;
  })[0] ?? null;
}

/**
 * `if (!window.confirm("<label> …")) return;` — a reachable guard whose refusal
 * stops the apply. A bare `window.confirm(…)` call, or a `false &&` wrapper,
 * is not this shape, so neither counts as confirmation.
 */
function confirmGuard(scope, label) {
  return collectNodes(scope, (node) => {
    if (!ts.isIfStatement(node)) return null;
    const test = node.expression;
    if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken) return null;
    const call = test.operand;
    if (!ts.isCallExpression(call) || call.arguments.length === 0) return null;
    if (!propertyAccessNamed(call.expression, "window", "confirm")) return null;
    const text = call.arguments[0];
    if (!ts.isStringLiteral(text) || !text.text.includes(label)) return null;
    if (!containsReturn(node.thenStatement)) return null;
    return node;
  })[0] ?? null;
}

/**
 * `if (!isReleasedCategory(<argument>)) return;` — the guard that keeps an
 * unreleased value out of the form. `argumentText` pins the argument when the
 * call site's value is known, and is null when any argument will do.
 */
function releasedCategoryGuard(scope, argumentText) {
  return collectNodes(scope, (node) => {
    if (!ts.isIfStatement(node)) return null;
    const test = node.expression;
    if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken) return null;
    const call = test.operand;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
    if (call.expression.text !== "isReleasedCategory") return null;
    if (argumentText !== null && call.arguments[0]?.getText() !== argumentText) return null;
    if (!containsReturn(node.thenStatement)) return null;
    return node;
  })[0] ?? null;
}

/**
 * Every `onClick` in the file whose arrow body actually performs a call, with
 * the callee name, the argument texts, and the arrow's declared parameters.
 *
 * A disconnected tap (`() => false && apply(…)`), a tap that returns a function
 * (`() => () => apply(…)`) and an emptied tap (`() => {}`) each produce no
 * entry, which is what makes a tap requirement mean "tapping this applies it".
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
    const statements = ts.isBlock(arrow.body) ? arrow.body.statements : [arrow.body];
    const calls = [];
    for (const statement of statements) {
      const expression = ts.isExpressionStatement(statement) ? statement.expression : statement;
      if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        calls.push({
          callee: expression.expression.text,
          args: expression.arguments.map((argument) => argument.getText()),
          argNodes: expression.arguments,
        });
      }
    }
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

/** The visible "Keep mine" controls, with the calls their own `onClick` makes. */
function keepControls(sourceFile) {
  const controls = [];
  walkTree(sourceFile, (node) => {
    if (!ts.isJsxElement(node)) return;
    const labelled = node.children.some(
      (child) => ts.isJsxText(child) && child.text.trim() === "Keep mine",
    );
    if (!labelled) return;
    const onClick = node.openingElement.attributes.properties
      .filter(ts.isJsxAttribute)
      .find((attribute) => attribute.name.getText() === "onClick");
    const calls = [];
    if (onClick !== undefined && onClick.initializer !== undefined && ts.isJsxExpression(onClick.initializer)) {
      const arrow = onClick.initializer.expression;
      if (arrow !== undefined && ts.isArrowFunction(arrow)) {
        const statements = ts.isBlock(arrow.body) ? arrow.body.statements : [arrow.body];
        for (const statement of statements) {
          const expression = ts.isExpressionStatement(statement) ? statement.expression : statement;
          if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
            calls.push(expression.expression.text);
          }
        }
      }
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

/**
 * True when `setterName(…)` is called with a property path rooted at `prefix`
 * (`setAiFieldPatches([...fieldsResult.value.suggestions])`), which is what
 * makes the operation's result reach the rendered state instead of dying in a
 * local.
 */
function feedsSetter(sourceFile, setterName, prefix) {
  return callsNamed(sourceFile, setterName).some((call) =>
    call.arguments.some((argument) => {
      let hit = false;
      walkTree(argument, (node) => {
        if (!ts.isPropertyAccessExpression(node)) return;
        let root = node;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && root.text === prefix) hit = true;
      });
      return hit;
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
 * The reviewed narrow task must be invoked AND its result used: a call whose
 * value is dropped (`void extractReportFields(…)`), nested in a conditional the
 * compiler can fold away, or left in a comment, does not count. Returns the
 * message to report, or null when the call is consumed.
 */
function extractorConsumptionError(helper) {
  const calls = callsNamed(helper, "extractReportFields");
  if (calls.length === 0) {
    return "report-field helper must actually invoke the reviewed narrow task";
  }
  const consumed = calls.some((call) => {
    const declaration = call.parent;
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return false;
    if (declaration.initializer !== call) return false;
    if (!ts.isIdentifier(declaration.name)) return false;
    const name = declaration.name.text;
    return collectNodes(helper, (node) =>
      ts.isIdentifier(node) && node.text === name && node !== declaration.name && !isInTypePosition(node)
        ? node
        : null,
    ).length > 0;
  });
  return consumed
    ? null
    : "report-field helper must use the reviewed narrow task's result, not merely mention the call";
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
  const createReport = parseGatedSource("CreateReport.tsx", sources?.createReportSource ?? "");
  const helper = parseGatedSource("reportFieldSuggestions.ts", sources?.reportFieldSuggestionsSource ?? "");

  const applyField = findNamedFunction(createReport, "aiSuggestApplyField");
  if (applyField === null) {
    errors.push(`${prefix}CreateReport must keep the reviewed per-field apply handler`);
  } else {
    for (const [field, setter] of Object.entries(REPORT_FIELD_SETTERS)) {
      const branch = fieldBranch(applyField, field);
      if (branch === null) {
        errors.push(`${prefix}the ${field} suggestion must have its own reachable apply branch`);
        continue;
      }
      const body = branch.thenStatement;
      const guard = confirmGuard(body, `Replace the existing ${field}`);
      if (guard === null) {
        errors.push(`${prefix}replacing an existing ${field} must be confirmed by a reachable guard that refuses`);
      }
      const setters = callsNamed(body, setter);
      if (setters.length === 0) {
        errors.push(`${prefix}the ${field} suggestion must apply through ${setter}`);
      } else if (guard !== null && setters.some((call) => call.getStart() < guard.getEnd())) {
        errors.push(`${prefix}the ${field} suggestion must not write ${field} before its confirmation guard`);
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
    const guard = confirmGuard(applyCategory, "Replace the existing category");
    if (guard === null) {
      errors.push(
        `${prefix}replacing an existing category from its own suggestion must be confirmed by a reachable guard that refuses`,
      );
    }
    const setters = callsNamed(applyCategory, "setCategory");
    if (setters.length === 0) {
      errors.push(`${prefix}the category suggestion must apply through setCategory`);
    } else {
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
  } else if (keeps.some((control) => !control.calls.includes("aiSuggestResolve"))) {
    errors.push(`${prefix}each Keep control must resolve its own suggestion`);
  }

  const fieldBinding = promiseAllBinding(createReport, "suggestReportFields");
  if (fieldBinding === null) {
    errors.push(`${prefix}CreateReport must reach the reviewed field suggester`);
  } else if (!feedsSetter(createReport, "setAiFieldPatches", fieldBinding)) {
    errors.push(`${prefix}the reviewed field suggester's result must reach the rendered patch state`);
  }
  const categoryBinding = promiseAllBinding(createReport, "suggestCategoryForText");
  if (categoryBinding === null) {
    errors.push(`${prefix}CreateReport must reach the reviewed category suggester`);
  } else if (!feedsSetter(createReport, "setAiCatSuggestion", categoryBinding)) {
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
