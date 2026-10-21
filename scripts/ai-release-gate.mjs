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

/** The identifier a call invokes, parentheses, casts and `!` aside. */
function calleeIdentifierOf(call) {
  const callee = unwrapExpression(call.expression);
  return callee !== undefined && ts.isIdentifier(callee) ? callee.text : null;
}

function callsNamed(scope, name) {
  return collectNodes(scope, (node) => (ts.isCallExpression(node) && calleeIdentifierOf(node) === name ? node : null));
}

/** Iteration methods whose callback's first parameter receives the elements. */
const ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "flatMap",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "sort",
]);

/**
 * The names that resolve to a reviewed setter within `scope`: the setters, any
 * local bound to one (`const wipe = setDescription`), the bindings of a
 * destructuring declaration whose matching value is a setter
 * (`const [wipe] = [setDescription]`, nested patterns included:
 * `const [[wipe]] = [[setDescription]]`), a member read of a literal that holds
 * one (`const wipe = { run: setDescription }.run`), the parameters of an
 * iteration callback invoked on a collection that holds one
 * (`[setDescription].forEach((wipe) => …)`), the bindings of a `for … of` over
 * such a collection (`for (const wipe of [setDescription])`), and a name a
 * setter is assigned to (`let wipe; wipe = setDescription;`). An alias of a
 * setter is still a setter, however it was bound, so a write through it is still
 * a write to a reviewed field (CF-070 R2 retry-9 A4, and the reviewer's A-class
 * spellings; review CF070-GATE-REMEDIATION MINOR-3a).
 *
 * The boundary is honest: a setter handed to an arbitrary helper function is not
 * modelled, because that needs the callee's body, and neither is a bound alias
 * (`.bind`), a `Reflect.apply` or `.call` route, a callee chosen by a
 * conditional, nor a holder declared outside `scope`.
 *
 * The fixed point runs to exhaustion rather than to a round cap, so a long alias
 * chain cannot yield a silently partial set (review CF070-GATE-REMEDIATION
 * NIT-7); it terminates because the set only grows and a scope holds finitely
 * many names.
 */
function namesResolvingToSetters(scope, setterNames) {
  const names = new Set(setterNames);
  const add = (name) => {
    if (names.has(name)) return false;
    names.add(name);
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    walkTree(scope, (node) => {
      if (ts.isVariableDeclaration(node)) {
        for (const boundName of namesBoundToSetters(scope, node, names)) changed = add(boundName) || changed;
        return;
      }
      // A `for … of` over a collection that holds the setter binds it to the
      // loop variable, element by element.
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        for (const boundName of loopBindingNamesOverCollection(scope, node, names)) {
          changed = add(boundName) || changed;
        }
        return;
      }
      // An assignment aliases a setter exactly as a declaration does.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const value = unwrapExpression(node.right);
        if (value !== undefined && resolvesToSetterExpression(scope, value, names)) {
          for (const target of assignmentTargets(unwrapExpression(node.left))) changed = add(target.text) || changed;
        }
        return;
      }
      // A callback parameter of a method that iterates a collection holding the
      // setter receives the setter: `[setDescription].forEach((wipe) => …)`.
      if (ts.isCallExpression(node)) {
        for (const parameter of iterationCallbackParameters(scope, node, names)) changed = add(parameter) || changed;
      }
    });
  }
  return names;
}

/**
 * The names a `for … of` / `for … in` header binds when it iterates a collection
 * that holds a reviewed setter (`for (const wipe of [setDescription])`). The
 * assignment form of the header writes a name rather than binding one, which
 * `isBindingWritten` reports separately; here it is an alias like any other
 * assignment, so its target is returned too.
 */
function loopBindingNamesOverCollection(scope, node, names) {
  if (!collectionMentionsName(scope, node.expression, names)) return [];
  const initializer = node.initializer;
  if (ts.isVariableDeclarationList(initializer)) {
    return initializer.declarations.flatMap((declaration) => bindingNamesOf(declaration.name));
  }
  return assignmentTargets(unwrapExpression(initializer)).map((target) => target.text);
}

/**
 * The names a variable declaration binds to a value that is a reviewed setter.
 * The pattern and its value are matched element-wise, so a sibling binding of
 * the same declaration is not dragged along, and a nested pattern is followed
 * into its matching nested literal (`const [[wipe]] = [[setDescription]]`),
 * which only the flat spellings could see (review CF070-GATE-REMEDIATION
 * MINOR-3a).
 */
function namesBoundToSetters(scope, declaration, names) {
  const initializer = declaration.initializer;
  if (initializer === undefined) return [];
  return namesBoundToValue(scope, declaration.name, initializer, names);
}

/** The names a binding pattern binds when it is matched against `value`. */
function namesBoundToValue(scope, pattern, value, names) {
  const source = unwrapExpression(value);
  if (source === undefined) return [];
  if (ts.isIdentifier(pattern)) {
    return resolvesToSetterExpression(scope, source, names) ? [pattern.text] : [];
  }
  if (ts.isArrayBindingPattern(pattern) && ts.isArrayLiteralExpression(source)) {
    const bound = [];
    pattern.elements.forEach((element, index) => {
      // A rest element collects every remaining element, so it never holds one
      // element — let alone the setter.
      if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined) return;
      const elementValue = source.elements[index];
      if (elementValue === undefined) return;
      bound.push(...namesBoundToValue(scope, element.name, elementValue, names));
    });
    return bound;
  }
  if (ts.isObjectBindingPattern(pattern) && ts.isObjectLiteralExpression(source)) {
    const bound = [];
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined) continue;
      const key = propertyNameOf(element.propertyName ?? element.name);
      if (key === null) continue;
      const propertyValue = payloadPropertyOf(scope, source, key);
      if (propertyValue === undefined) continue;
      bound.push(...namesBoundToValue(scope, element.name, propertyValue, names));
    }
    return bound;
  }
  return [];
}

/** Every identifier a binding name binds (`wipe`, `{ a }`, `[x]`). */
function bindingNamesOf(nameNode) {
  const found = [];
  const visit = (current) => {
    if (ts.isIdentifier(current)) {
      found.push(current.text);
      return;
    }
    if (ts.isArrayBindingPattern(current) || ts.isObjectBindingPattern(current)) {
      for (const child of current.elements) if (ts.isBindingElement(child)) visit(child.name);
    }
  };
  visit(nameNode);
  return found;
}

/**
 * True when an expression evaluates to a reviewed setter: the name itself, or a
 * member read of a literal that holds one
 * (`const wipe = { run: setDescription }.run`, review CF070-GATE-REMEDIATION
 * MINOR-3a).
 */
function resolvesToSetterExpression(scope, expression, names) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isIdentifier(inner)) return names.has(inner.text);
  const member = memberAccessName(inner);
  if (member === null) return false;
  const holder = resolveObjectLiteral(scope, inner.expression);
  if (holder === undefined) return false;
  const value = payloadPropertyOf(scope, holder, member);
  return value !== undefined && resolvesToSetterExpression(scope, value, names);
}

/**
 * True when a call invokes a reviewed setter: directly, through an alias, or
 * through a key of a local object literal that holds one
 * (`const wipe = { run: setDescription }; wipe.run("")`). A setter handed to a
 * function the gate cannot read is not modelled; that needs the callee's body.
 */
function callResolvesToReviewedSetter(scope, call, names) {
  const callee = unwrapExpression(call.expression);
  if (callee === undefined) return false;
  // `(0, setDescription)("")` calls its last operand (review
  // CF070-GATE-REMEDIATION-R5 MINOR-2).
  if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return resolvesToSetterExpression(scope, callee.right, names);
  }
  // `[setDescription][0]("")` calls the element the literal holds.
  if (ts.isElementAccessExpression(callee)) {
    const receiver = unwrapExpression(callee.expression);
    const index = unwrapExpression(callee.argumentExpression);
    if (
      receiver !== undefined && ts.isArrayLiteralExpression(receiver) &&
      index !== undefined && ts.isNumericLiteral(index)
    ) {
      const element = receiver.elements[Number(index.text)];
      return element !== undefined && resolvesToSetterExpression(scope, element, names);
    }
  }
  if (ts.isIdentifier(callee)) return names.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  const member = memberAccessName(callee);
  const receiver = unwrapExpression(callee.expression);
  if (member === null || receiver === undefined || !ts.isIdentifier(receiver)) return false;
  // `setDescription.call(null, "")` / `.apply(null, [""])` call the reviewed
  // setter with the receiver as `this` (review CF070-GATE-REMEDIATION-R5
  // MINOR-2).
  if ((member === "call" || member === "apply") && names.has(receiver.text)) return true;
  const holder = resolveObjectLiteral(scope, receiver);
  if (holder === undefined) return false;
  const value = payloadPropertyOf(scope, holder, member);
  return value !== undefined && resolvesToSetterExpression(scope, value, names);
}

/**
 * The callback parameters that receive a reviewed setter because the call
 * iterates a collection that holds one. Where the collection is known the
 * elements flow into the first parameter; which subset of a collection reaches
 * a later parameter is not modelled, so every parameter is treated as the setter
 * it may be.
 */
function iterationCallbackParameters(scope, call, names) {
  const callee = unwrapExpression(call.expression);
  if (callee === undefined || !ts.isPropertyAccessExpression(callee)) return [];
  if (!ITERATION_METHODS.has(callee.name.text)) return [];
  if (!collectionMentionsName(scope, callee.expression, names)) return [];
  const found = [];
  for (const argument of call.arguments) {
    const inner = unwrapExpression(argument);
    if (inner === undefined) continue;
    if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner)) continue;
    for (const parameter of inner.parameters) found.push(...bindingNamesOf(parameter.name));
  }
  return found;
}

/** True when an expression that names a collection mentions one of `names`. */
function collectionMentionsName(scope, expression, names) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isIdentifier(inner)) {
    const initializer = initializerOf(scope, inner, inner.text);
    return initializer !== undefined && mentionsName(initializer, names);
  }
  return mentionsName(inner, names);
}

/** True when a tree contains an identifier from `names`. */
function mentionsName(node, names) {
  let hit = false;
  walkTree(node, (child) => {
    if (hit) return;
    if (ts.isIdentifier(child) && names.has(child.text)) hit = true;
  });
  return hit;
}

/**
 * Strips parentheses, `as`/`satisfies`/type assertions and `!` to reach the
 * value. `satisfies` is a no-op at run time, so a value written
 * `("Replace …" satisfies string)` is the same string as the bare literal
 * (review CF070-GATE-REMEDIATION MINOR-4: without this arm the reader fell
 * through to "not a literal", both refusing a Keep key that resolves and hiding
 * a fabricated payload behind the same wrapper).
 */
function unwrapExpression(node) {
  let current = node;
  while (current !== undefined) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
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
 *
 * A conditional whose test folds is the taken arm, a template whose
 * substitutions all fold is the concatenated string, and a BigInt reduces to its
 * truthiness (`0n` is the only falsy one). Each closes a spelling of the same
 * dead-branch class beyond the enumerated ones (review CF070-GATE-REMEDIATION
 * MINOR-3b: `while (true ? false : true)`, `while (`${""}`)`, `while (0n)`).
 */
function staticValue(node, locals) {
  const inner = node === undefined ? undefined : unwrapExpression(node);
  if (inner === undefined) return UNKNOWN_STATIC_VALUE;
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (inner.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(inner)) return Number(inner.text);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isBigIntLiteral(inner)) {
    // Only the falsy one matters to a guard, and folding every other BigInt to a
    // number would be a precision claim the gate cannot make.
    return inner.text.replace(/n$/, "") === "0" ? 0 : 1;
  }
  if (ts.isTemplateExpression(inner)) {
    let concatenated = inner.head.text;
    for (const span of inner.templateSpans) {
      const value = staticValue(span.expression, locals);
      if (value === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
      concatenated += String(value) + span.literal.text;
    }
    return concatenated;
  }
  if (ts.isConditionalExpression(inner)) {
    const test = staticValue(inner.condition, locals);
    if (test === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
    return staticValue(test ? inner.whenTrue : inner.whenFalse, locals);
  }
  if (ts.isIdentifier(inner)) {
    // A loop header may bind its own induction variable (`for (let i = 0; i < 0; …)`);
    // folding the condition against that binding is what makes the empty loop
    // statically false (CF-070 R2 retry-9 B5).
    if (locals !== undefined && locals.has(inner.text)) return locals.get(inner.text);
    if (inner.text === "undefined") return undefined;
    // The global constants are values the compiler knows: `while (NaN) { … }` is
    // a loop over a falsy condition, not an unknown one (CF-070 R2 retry-9 B).
    if (inner.text === "NaN") return Number.NaN;
    if (inner.text === "Infinity") return Number.POSITIVE_INFINITY;
    return UNKNOWN_STATIC_VALUE;
  }
  if (ts.isVoidExpression(inner)) {
    // `void <anything>` is `undefined` whatever its operand evaluates to
    // (`while (void 0) { … }`, CF-070 R2 retry-9 B).
    return undefined;
  }
  if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.arguments.length === 1) {
    // `Boolean(<static>)` folds the way the compiler folds it, so a guard behind
    // `while (Boolean(false)) { … }` is the same dead guard (CF-070 R2 retry-9
    // B7); `Number` and `String` are the same fold, and `Number("abc")` folding
    // to NaN is what makes `while (Number("abc"))` a dead guard (review
    // CF070-GATE-REMEDIATION MINOR-3b). A locally shadowed global is not
    // modelled: a name the file rebinds would fold differently.
    const global = inner.expression.text;
    if (global === "Boolean" || global === "Number" || global === "String") {
      const value = staticValue(inner.arguments[0], locals);
      if (value === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
      if (global === "Boolean") return Boolean(value);
      if (global === "Number") return Number(value);
      return String(value);
    }
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
 * empty, so the loop body never runs: `for (const _skip of []) { … }`. The
 * count is folded rather than pattern-matched, so `new Array(0)` and a
 * `concat` of empty operands are the same empty loop as the literal
 * (CF-070 R2 retry-9 B).
 */
function staticallyEmptyIterable(node) {
  return staticIterableLength(node) === 0;
}

/**
 * The element count of a value the compiler can know: a literal array or
 * object, a string, `new Array()` / `new Array(<static n>)`, and a `concat`
 * whose every operand is itself counted. UNKNOWN_STATIC_VALUE when the count is
 * not knowable — an identifier, a call to anything else, a spread of an unknown
 * value.
 */
function staticIterableLength(node, scope) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return UNKNOWN_STATIC_VALUE;
  if (scope !== undefined && scope !== null && ts.isIdentifier(inner)) {
    // A `const` the file never writes and whose initializer is a literal is as
    // knowable as that literal: `const tail = []; [ ...reviewed, ...tail ]` adds
    // nothing (review CF070-GATE-REMEDIATION-R2 NIT-3). One hop only — following
    // an alias chain here would want the write analysis the payload walk does.
    const declaration = trustedConstBinding(scope.getSourceFile(), inner.text, inner);
    if (declaration === null || declaration.initializer === undefined) return UNKNOWN_STATIC_VALUE;
    const resolved = unwrapExpression(declaration.initializer);
    return resolved === undefined ? UNKNOWN_STATIC_VALUE : staticIterableLength(resolved);
  }
  if (ts.isArrayLiteralExpression(inner)) {
    let total = 0;
    for (const element of inner.elements) {
      if (!ts.isSpreadElement(element)) {
        total += 1;
        continue;
      }
      const spread = staticIterableLength(element.expression);
      if (spread === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
      total += spread;
    }
    return total;
  }
  if (ts.isObjectLiteralExpression(inner)) return inner.properties.length;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text.length;
  if (ts.isNewExpression(inner) && ts.isIdentifier(inner.expression)) {
    const built = inner.expression.text;
    if (built === "Array") {
      if (inner.arguments === undefined || inner.arguments.length === 0) return 0;
      if (inner.arguments.length === 1) {
        const count = staticValue(inner.arguments[0]);
        return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : UNKNOWN_STATIC_VALUE;
      }
      return UNKNOWN_STATIC_VALUE;
    }
    // An empty `Set`/`Map` holds no element to iterate. One built from a
    // collection holds as many as that collection does *after* it drops
    // duplicates, which is a count this fold cannot claim.
    if ((built === "Set" || built === "Map") && (inner.arguments === undefined || inner.arguments.length === 0)) {
      return 0;
    }
  }
  if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "Array") {
    // `Array()` is `new Array()`: the same count fold, in the call spelling.
    if (inner.arguments.length === 0) return 0;
    if (inner.arguments.length === 1) {
      const count = staticValue(inner.arguments[0]);
      return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : UNKNOWN_STATIC_VALUE;
    }
    return UNKNOWN_STATIC_VALUE;
  }
  if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
    const method = inner.expression.name.text;
    const receiver = inner.expression.expression;
    if (method === "flat") {
      // Flattening only removes nesting, so an empty receiver is the one result
      // this fold can claim: `[].flat()` never runs a body, while
      // `[[], []].flat()` is empty for a reason the receiver count does not show.
      return staticIterableLength(receiver) === 0 ? 0 : UNKNOWN_STATIC_VALUE;
    }
    if (method === "slice") {
      // `x.slice(a, b)` with static bounds where `b <= a` is empty however long
      // `x` is; a slice that keeps anything is decided by the caller, not here.
      if (inner.arguments.length === 2) {
        const start = staticValue(inner.arguments[0]);
        const end = staticValue(inner.arguments[1]);
        if (typeof start === "number" && typeof end === "number" && end <= start) return 0;
      }
      return staticIterableLength(receiver) === 0 ? 0 : UNKNOWN_STATIC_VALUE;
    }
  }
  if (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    inner.expression.name.text === "concat"
  ) {
    const base = staticIterableLength(inner.expression.expression);
    if (base === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
    let total = base;
    for (const argument of inner.arguments) {
      const part = staticIterableLength(argument);
      if (part === UNKNOWN_STATIC_VALUE) return UNKNOWN_STATIC_VALUE;
      total += part;
    }
    return total;
  }
  return UNKNOWN_STATIC_VALUE;
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
/** The declarations a `for`/`for … of`/`for … in` header binds, or null. */
function loopHeaderDeclarations(statement) {
  if (!ts.isForStatement(statement) && !ts.isForOfStatement(statement) && !ts.isForInStatement(statement)) {
    return null;
  }
  const initializer = statement.initializer;
  if (initializer === undefined || !ts.isVariableDeclarationList(initializer)) return null;
  return initializer.declarations;
}

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

/**
 * True when an assignment operator can change the value a read of the binding
 * sees, given the value the binding was declared with. `??=` writes only a
 * nullish binding and `||=` only a falsy one, so neither can touch a binding
 * declared with a known non-nullish or truthy value
 * (`let KEEP = "categorySuggestion"; KEEP ??= "nope"` hands the reviewed string
 * over unchanged, review CF070-GATE-REMEDIATION MINOR-2). An unreadable declared
 * value leaves both as writes, which is the fail-closed direction.
 */
function assignmentCanChangeValue(kind, declaredValue) {
  if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    return declaredValue === UNKNOWN_STATIC_VALUE || declaredValue === null || declaredValue === undefined;
  }
  if (kind === ts.SyntaxKind.BarBarEqualsToken) {
    return declaredValue === UNKNOWN_STATIC_VALUE || !declaredValue;
  }
  return true;
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
        if (bindingNamesOf(parameter.name).includes(name)) return parameter;
      }
    }
    // A `catch` parameter and a loop header's `let`/`const` bind inside the construct
    // without being a statement list the walk reaches, so a use site inside one used to
    // resolve to the *outer* binding: `catch (built) { … built.suggestions }` read the
    // reviewed builder while the caught error shipped, and so did a shadowing loop
    // header (review CF070-GATE-REMEDIATION-R3 MINOR-1).
    if (ts.isCatchClause(current) && current.variableDeclaration !== undefined) {
      if (bindingNamesOf(current.variableDeclaration.name).includes(name)) return current.variableDeclaration;
    }
    const loopDeclarations = loopHeaderDeclarations(current);
    if (loopDeclarations !== null) {
      for (const declaration of loopDeclarations) {
        if (bindingNamesOf(declaration.name).includes(name)) return declaration;
      }
    }
    const statements = statementListOf(current);
    if (statements !== null) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (bindingNamesOf(declaration.name).includes(name)) return declaration;
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
    ts.isVariableDeclaration(node) && bindingNamesOf(node.name).includes(name) ? node : null,
  );
  return declarations.length === 1 ? declarations[0] : null;
}

/**
 * True when `declaration` is written anywhere: an assignment, a compound
 * assignment or `++`/`--` whose target resolves back to *this* binding, a
 * destructuring assignment that binds this name (`[X] = […]`, `({ X } = …)`)
 * just as a plain one does, and the assignment form of a loop header
 * (`for (X of […])`, `for (X in { … })`), which writes the name without any
 * assignment expression at all. A write that resolves to a nearer binding of the
 * same name (a shadowing parameter or a local re-declaration) is not a write to
 * this one (CF-070 R2 retry-9 E, Q3; review CF070-GATE-REMEDIATION MINOR-3d).
 */
function isBindingWritten(sourceFile, declaration, name) {
  let written = false;
  const declaredValue =
    declaration.initializer === undefined ? UNKNOWN_STATIC_VALUE : staticValue(declaration.initializer);
  walkTree(sourceFile, (node) => {
    if (written) return;
    let targets = [];
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (assignmentCanChangeValue(node.operatorToken.kind, declaredValue)) {
        targets = assignmentTargets(unwrapExpression(node.left));
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      targets = assignmentTargets(unwrapExpression(node.operand));
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      targets = assignmentTargets(unwrapExpression(node.initializer));
    }
    for (const target of targets) {
      if (target.text !== name) continue;
      if (nearestBindingOf(target, name) === declaration) written = true;
    }
  });
  return written;
}

/**
 * The identifiers an assignment target writes: the identifier itself, the
 * elements of an array pattern (`[X] = […]`, `[X, …rest] = …`), or the
 * shorthand and renamed properties of an object pattern
 * (`({ X } = …)`, `({ a: X } = …)`).
 */
function assignmentTargets(target) {
  if (target === undefined) return [];
  if (ts.isIdentifier(target)) return [target];
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      assignmentTargets(ts.isSpreadElement(element) ? element.expression : element),
    );
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      if (ts.isPropertyAssignment(property)) return assignmentTargets(unwrapExpression(property.initializer));
      if (ts.isSpreadAssignment(property)) return assignmentTargets(unwrapExpression(property.expression));
      return [];
    });
  }
  return [];
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
 * writes, a read of such a literal out of the object or array that holds it
 * (`HOLDER.KEEP_KEY`, `KEEP[0]`), or an imported binding whose readable module
 * exports the same. Returns null when the value is not a static string.
 */
function stringLiteralValue(sourceFile, node, seen) {
  const inner = unwrapExpression(node);
  if (inner === undefined) return null;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    return literalReadStringValue(sourceFile, inner, seen);
  }
  if (!ts.isIdentifier(inner)) return null;
  const declaration = trustedConstBinding(sourceFile, inner.text, node);
  if (declaration !== null) return boundStringValue(sourceFile, declaration, inner.text, seen);
  return importedStringLiteralValue(sourceFile, inner.text);
}

/**
 * The string a literal holding it hands over when one of its own members is read:
 * `HOLDER.KEEP_KEY`, `HOLDER["KEEP_KEY"]`, `KEEP[0]`. The holder is a literal, or
 * a binding the file holds a literal in. Both spellings put the reviewed string
 * in play exactly as the bare constant does, so refusing them was a false
 * positive (review CF070-GATE-REMEDIATION MINOR-2, N9).
 *
 * A member of the holder that is written somewhere in the file no longer holds
 * what the literal gave it (`HOLDER.KEEP_KEY = "nope"`), and the gate does not
 * follow the write, so the read does not resolve — the fail-closed direction
 * (review CF070-GATE-REMEDIATION-R2 MINOR-3).
 */
function literalReadStringValue(sourceFile, expression, seen) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return null;
  if (ts.isPropertyAccessExpression(inner)) {
    if (spreadPropertyWrites(sourceFile, inner.expression, inner.name.text).length > 0) return null;
    const holder = resolveObjectLiteral(sourceFile, inner.expression);
    if (holder === undefined) return null;
    const value = payloadPropertyOf(sourceFile, holder, inner.name.text);
    return value === undefined ? null : resolveStringExpression(sourceFile, value, seen);
  }
  if (!ts.isElementAccessExpression(inner)) return null;
  const argument = unwrapExpression(inner.argumentExpression);
  if (argument !== undefined && ts.isStringLiteral(argument)) {
    if (spreadPropertyWrites(sourceFile, inner.expression, argument.text).length > 0) return null;
    const holder = resolveObjectLiteral(sourceFile, inner.expression);
    if (holder === undefined) return null;
    const value = payloadPropertyOf(sourceFile, holder, argument.text);
    return value === undefined ? null : resolveStringExpression(sourceFile, value, seen);
  }
  const index = argument === undefined ? UNKNOWN_STATIC_VALUE : staticValue(argument);
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  const array = resolveArrayLiteral(sourceFile, inner.expression);
  const element = array === undefined ? undefined : array.elements[index];
  return element === undefined ? null : resolveStringExpression(sourceFile, element, seen);
}

/** The array literal an expression evaluates to, directly or through a local binding. */
function resolveArrayLiteral(scope, expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return undefined;
  if (ts.isArrayLiteralExpression(inner)) return inner;
  if (!ts.isIdentifier(inner)) return undefined;
  const initializer = initializerOf(scope, inner, inner.text);
  if (initializer === undefined) return undefined;
  const resolved = unwrapExpression(initializer);
  return resolved !== undefined && ts.isArrayLiteralExpression(resolved) ? resolved : undefined;
}

/**
 * The static string a declaration gives one of the names it binds: the
 * initializer itself for a plain binding, or the matching value for a
 * destructuring binding (`const { KEEP_KEY } = { KEEP_KEY: "…" }`,
 * `const [KEEP_KEY] = ["…"]`). A Keep key written that way resolves the same
 * reviewed key at run time, so refusing it was a false positive
 * (CF-070 R2 retry-9 P-1).
 */
function boundStringValue(sourceFile, declaration, name, seen) {
  const initializer = declaration.initializer;
  if (initializer === undefined) return null;
  if (ts.isIdentifier(declaration.name)) {
    const resolved = unwrapExpression(initializer);
    if (resolved !== undefined && (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved))) {
      return resolved.text;
    }
    if (resolved !== undefined && ts.isIdentifier(resolved)) {
      // One binding may hold another (`const KEEP_ALIAS = KEEP_KEY`); follow the
      // alias chain as long as it cannot cycle (CF-070 R2 retry-9 Q2).
      const guard = seen ?? new Set();
      if (guard.has(name)) return null;
      guard.add(name);
      return stringLiteralValue(sourceFile, resolved, guard);
    }
    return null;
  }
  for (const value of valuesBoundByName(sourceFile, declaration, name)) {
    const resolved = resolveStringExpression(sourceFile, value, seen);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * The initializer expressions a destructuring declaration gives one bound name:
 * the element at the matching index of an array literal, or the property of the
 * matching name in an object literal. Descends nested patterns while the source
 * stays a literal, and yields nothing where it does not.
 */
function valuesBoundByName(scope, declaration, name) {
  const found = [];
  if (declaration.initializer === undefined) return found;
  const visit = (pattern, source) => {
    // The source may be a literal, or a binding the file holds one in
    // (`const { KEEP_KEY } = HOLDER`, review CF070-GATE-REMEDIATION-R2 NIT-4).
    const arraySource = source === undefined ? undefined : resolveArrayLiteral(scope, source);
    const objectSource = source === undefined ? undefined : resolveObjectLiteral(scope, source);
    if (ts.isArrayBindingPattern(pattern) && arraySource !== undefined) {
      source = arraySource;
      pattern.elements.forEach((element, index) => {
        if (!ts.isBindingElement(element)) return;
        const value = source.elements[index];
        if (value === undefined) {
          // An element the literal does not reach is `undefined` at run time, so
          // the element's own default is what the name holds
          // (`const [K = "…"] = []`).
          if (element.initializer !== undefined) visit(element.name, element.initializer);
          return;
        }
        visit(element.name, value);
      });
      return;
    }
    if (ts.isObjectBindingPattern(pattern) && objectSource !== undefined) {
      source = objectSource;
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        const key = propertyNameOf(element.propertyName ?? element.name);
        if (key === null) continue;
        const property = source.properties.find(
          (candidate) => ts.isPropertyAssignment(candidate) && propertyNameOf(candidate.name) === key,
        );
        // An absent property is `undefined` at run time, so the element's own
        // default is what the name holds (`const { KEEP_KEY = "…" } = {}`,
        // review CF070-GATE-REMEDIATION MINOR-2). A property that IS there
        // decides, however unreadable it is: falling back to the default would
        // read a value the code does not use.
        if (property === undefined) {
          if (element.initializer !== undefined) visit(element.name, element.initializer);
          continue;
        }
        visit(element.name, ts.isPropertyAssignment(property) ? property.initializer : undefined);
      }
      return;
    }
    if (ts.isIdentifier(pattern) && pattern.text === name && source !== undefined) {
      const resolved = unwrapExpression(source);
      if (resolved !== undefined) found.push(resolved);
      return;
    }
    if (ts.isArrayBindingPattern(pattern) || ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (ts.isBindingElement(element)) visit(element.name, undefined);
      }
    }
  };
  visit(declaration.name, declaration.initializer);
  return found;
}

/** The static string an expression evaluates to, following one alias chain. */
function resolveStringExpression(sourceFile, expression, seen) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return null;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (!ts.isIdentifier(inner)) return null;
  const guard = seen ?? new Set();
  if (guard.has(inner.text)) return null;
  guard.add(inner.text);
  return stringLiteralValue(sourceFile, inner, guard);
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

/**
 * Per-scope memoization for the subtree walks below. The tree does not change
 * while a check runs, so a question several readers ask of the same scope is
 * walked once; without it the alias fixed point re-walked the scope for every
 * call expression on every round (review CF070-GATE-REMEDIATION NIT-7).
 */
const scopeWalkCache = new WeakMap();

function memoizedWalk(scope, key, compute) {
  let perScope = scopeWalkCache.get(scope);
  if (perScope === undefined) {
    perScope = new Map();
    scopeWalkCache.set(scope, perScope);
  }
  if (!perScope.has(key)) perScope.set(key, compute());
  return perScope.get(key);
}

/**
 * The initializer of the binding that `name` resolves to *at this use site*, or
 * undefined when it has none (a parameter, an import, an uninitialized `let`).
 *
 * Resolution is by binding, not by name: a name an inner scope re-declares is
 * that scope's binding, so a read of it is not a read of the outer reviewed value
 * (`const built = build…(fields); { const built = { suggestions: [] }; return {
 * suggestions: built.suggestions } }` shipped the empty list while the name-keyed
 * first-wins map resolved the reviewed one — found by this pass's own
 * falsification of the payload resolution, and closed here).
 */
function initializerOf(_scope, node, name) {
  const declaration = nearestBindingOf(node, name);
  if (declaration === null || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
    return undefined;
  }
  return declaration.initializer;
}

/**
 * The values a write gives each written name anywhere in `scope`, in source
 * order (`built = { … }`), including a destructuring target (`[built] = […]`).
 * Each entry records the value and whether the write was a plain `=`: a compound
 * write (`built += []`) leaves a value the walk does not model, so it is recorded
 * as a write and answered false rather than skipped (review
 * CF070-GATE-REMEDIATION-R2 MINOR-3).
 *
 * Two writes are not writes at all and are left out:
 *
 * - a self-assignment (`built = built`), which cannot change what the name holds;
 * - one that cannot run, because it sits in a branch the compiler folds away or
 *   after a statement that already left the list (`if (false) built = …`,
 *   `while (1 === 2) built = …`, `return …; built = …`, review
 *   CF070-GATE-REMEDIATION-R2 MINOR-4).
 *
 * A write replaces what the binding held, so a read of a name is worth the writes
 * as much as the declaration: `let built = <reviewed>; built = { suggestions: []
 * };` shipped the fabricated one while only the declaration was read (review
 * CF070-GATE-REMEDIATION MINOR-3c).
 */
function assignmentsByName(scope) {
  return memoizedWalk(scope, "assignments", () => {
    const writes = new Map();
    walkTree(scope, (node) => {
      if (!ts.isBinaryExpression(node) || !isAssignmentOperator(node.operatorToken.kind)) return;
      if (hasStaticallyFalseAncestor(node)) return;
      const value = unwrapExpression(node.right);
      if (value === undefined) return;
      const plain = node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      for (const target of assignmentTargets(unwrapExpression(node.left))) {
        const declaration = nearestBindingOf(target, target.text);
        if (declaration === null) continue;
        if (plain && ts.isIdentifier(value) && nearestBindingOf(value, value.text) === declaration) continue;
        const list = writes.get(declaration);
        const write = { value, plain };
        if (list === undefined) writes.set(declaration, [write]);
        else list.push(write);
      }
    });
    return writes;
  });
}

/**
 * The writes `assignmentsByName` recorded for the binding that `name` resolves to
 * at `node`, or undefined when that binding is never written. Keying by the
 * declaration is what keeps a write to a *different* binding of the same name
 * from being read as a write to this one (review CF070-GATE-REMEDIATION-R2
 * NIT-1).
 */
function writesForName(scope, node, name) {
  const declaration = nearestBindingOf(node, name);
  if (declaration === null) return undefined;
  return assignmentsByName(scope).get(declaration);
}

/** The innermost identifier of an access chain, or undefined. */
function accessChainRootNode(expression) {
  let current = unwrapExpression(expression);
  while (
    current !== undefined &&
    (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
  ) {
    current = unwrapExpression(current.expression);
  }
  return current;
}

/**
 * True when a write to a binding hands the reviewed result on rather than
 * replacing it: its value derives from the reviewed result, or it is a call that
 * reads it. That second case is the producer called again on another branch
 * (`let built = buildReportFieldSuggestions(opResult.value.fields);
 * if (…) built = buildReportFieldSuggestions(opResult.value.fields);`), which
 * hands back the same computation and is as good as the declaration it replaces
 * (review CF070-GATE-REMEDIATION-R2 MINOR-4).
 *
 * Only a *call* is read that way. A literal that merely mentions the reviewed
 * name somewhere else in itself is still a literal, and the value it gives the
 * property that matters is decided by `derivesFromReviewed` above it.
 */
function writeReadsReviewed(scope, write, names, seen, producer) {
  if (!write.plain) return false;
  if (derivesFromReviewed(scope, write.value, names, seen)) return true;
  // The producer called again — the same callee expression, called on the same
  // arguments — hands back the same computation, so the declaration's value still
  // stands (`let built = buildReportFieldSuggestions(opResult.value.fields); if (…)
  // built = buildReportFieldSuggestions(opResult.value.fields);`, review
  // CF070-GATE-REMEDIATION-R2 MINOR-4). A call that merely *mentions* the reviewed
  // value in an argument is not that: `built = fabricate(opResult.value.fields)` was
  // accepted while shipping whatever `fabricate` returned (review
  // CF070-GATE-REMEDIATION-R3 MINOR-2).
  const value = unwrapExpression(write.value);
  const source = unwrapExpression(producer);
  if (value === undefined || source === undefined) return false;
  if (!ts.isCallExpression(value) || !ts.isCallExpression(source)) return false;
  // Compare the callee's *binding*, not its spelling: a catch parameter or a
  // local declaration with the producer's name shadows it, and the shadow's
  // return value is not the reviewed computation (review
  // CF070-GATE-REMEDIATION-R5 MINOR-4).
  const valueCallee = unwrapExpression(value.expression);
  const sourceCallee = unwrapExpression(source.expression);
  if (valueCallee === undefined || sourceCallee === undefined) return false;
  if (valueCallee.getText() !== sourceCallee.getText()) return false;
  if (ts.isIdentifier(valueCallee) && ts.isIdentifier(sourceCallee)) {
    if (
      nearestBindingOf(valueCallee, valueCallee.text) !==
      nearestBindingOf(sourceCallee, sourceCallee.text)
    ) return false;
  }
  return (
    value.arguments.length === source.arguments.length &&
    value.arguments.every((argument, index) => argument.getText() === source.arguments[index].getText())
  );
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
 *
 * A binding written anywhere in the scope no longer holds what it was declared
 * with, so the declaration is not evidence of the value that runs: `let built =
 * <reviewed>; built = { suggestions: [] }; return { …, suggestions:
 * built.suggestions }` reads as the reviewed list while shipping the empty one
 * (review CF070-GATE-REMEDIATION MINOR-3c). What the writes do say is asked of
 * them instead — see `writeReadsReviewed` (review CF070-GATE-REMEDIATION-R2
 * MINOR-4).
 *
 * A *mentioned* local that is written is not followed at all: the walk is asking
 * whether the reviewed value is in play, and a name holding something else is not
 * evidence that it is.
 */
function readsReviewedValue(scope, expression, names) {
  const root = accessChainRoot(expression);
  if (root === null) return false;
  if (names.has(root)) return true;
  const writes = writesForName(scope, accessChainRootNode(expression) ?? expression, root);
  if (writes !== undefined) {
    // The binding holds what its writes gave it. A write that hands the reviewed
    // computation on (`built = build…(fields)` on a second branch) leaves the
    // declaration's value standing; one that puts anything else there does not
    // (review CF070-GATE-REMEDIATION-R2 MINOR-4).
    return writes.every((write) =>
      writeReadsReviewed(
        scope,
        write,
        names,
        new Set([root]),
        initializerOf(scope, accessChainRootNode(expression) ?? expression, root),
      ),
    );
  }
  const queue = [initializerOf(scope, accessChainRootNode(expression) ?? expression, root)];
  const visited = new Set([root]);
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    let hit = false;
    walkTree(current, (node) => {
      if (!ts.isIdentifier(node)) return;
      if (names.has(node.text)) hit = true;
      if (writesForName(scope, node, node.text) !== undefined) return;
      const initializer = initializerOf(scope, node, node.text);
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
  // A computed key whose expression is itself a literal names the same property,
  // in the object it is written in and in a read of that object
  // (`{ ["KEEP_KEY"]: "categorySuggestion" }`, review CF070-GATE-REMEDIATION-R2
  // NIT-4). A computed key it cannot fold still answers null.
  if (ts.isComputedPropertyName(nameNode)) {
    const expression = unwrapExpression(nameNode.expression);
    if (expression === undefined) return null;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNumericLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return expression.text;
    }
  }
  return null;
}

/**
 * The dotted path of an expression this reader can name (`built.suggestions`,
 * `built["suggestions"]` → `built.suggestions`, `list[0]` → `list[]`), or null
 * when the expression is not a plain chain. Used to ask whether a write touches
 * the shipped value or a part of it, without matching on raw source spelling.
 */
function chainPathOf(expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return null;
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) {
    const base = chainPathOf(inner.expression);
    return base === null ? null : `${base}.${inner.name.text}`;
  }
  if (ts.isElementAccessExpression(inner)) {
    const base = chainPathOf(inner.expression);
    if (base === null) return null;
    if (ts.isStringLiteral(inner.argumentExpression)) return `${base}.${inner.argumentExpression.text}`;
    return `${base}[]`;
  }
  if (ts.isCallExpression(inner)) {
    const base = chainPathOf(inner.expression);
    return base === null ? null : `${base}()`;
  }
  return null;
}

/**
 * The scope a variable declaration binds into: its own block for a statement-level
 * `let`/`const`, the loop statement for a `let`/`const` loop-head binding, and the
 * nearest function body for `var` (which is function-scoped). Returns undefined
 * when the scope cannot be named.
 *
 * A loop-head binding must not be mistaken for a helper-level one: for
 * `for (let s = 0; …)` the declaration's grandparent is the `ForStatement`, whose
 * own parent is the helper body, so keying the shadow test on
 * `declaration.parent.parent.parent` deletes a live helper-level holder and lets a
 * later write through it ship (review CF070-GATE-REMEDIATION-R15 BLOCKER-1).
 */
function bindingScopeOf(declaration) {
  const list = declaration.parent;
  if (list === undefined || !ts.isVariableDeclarationList(list)) return undefined;
  const container = list.parent;
  if (container === undefined) return undefined;
  // A loop-head binding belongs to the loop, never to the helper body. (A `var`
  // loop head cannot legitimately redeclare a block-scoped helper holder — that
  // source is a syntax error — and otherwise names a distinct binding, so the
  // conservative answer is the loop too.)
  if (ts.isForStatement(container) || ts.isForInStatement(container) || ts.isForOfStatement(container)) {
    return container;
  }
  return ts.isVariableStatement(container) ? container.parent : undefined;
}

/** Array methods that change the receiver in place. */
const IN_PLACE_ARRAY_METHODS = new Set([
  "copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift",
]);

/**
 * In-place array methods that hand their receiver back, so the elements they
 * reorder or fill are the same element objects (`[...chain].sort(by)` is a copy
 * of chain's elements, and a write through it reaches a reviewed record — review
 * CF070-GATE-REMEDIATION-R11 MAJOR-1).
 */
const RETURNS_RECEIVER_METHODS = new Set(["copyWithin", "fill", "reverse", "sort"]);

/** Methods that hand their first callback each element of the receiver. */
const ELEMENT_ITERATION_METHODS = new Set([
  "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flatMap",
  "forEach", "map", "reduce", "reduceRight", "some",
]);

/** Methods that return a shallow copy of the receiver's element objects. */
const SHALLOW_COPY_METHODS = new Set([
  "concat", "entries", "filter", "flatMap", "map", "slice", "toReversed", "toSorted",
  "toSpliced", "values", "with",
]);

/** The local function a call names, if it names one. */
function localFunctionOf(call) {
  const callee = unwrapExpression(call.expression);
  if (callee === undefined) return undefined;
  // An immediately-invoked function expression is its own local function.
  if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) return callee;
  // Everything else is the declaration form, whatever form that is: a function
  // declaration, a variable initialised with a function, aliased (`const g =
  // make`), conditional (`const g = flag ? f : null`) or assigned later
  // (`let g; g ||= f`). One resolver, so no call form is outside it by
  // construction (review CF070-GATE-REMEDIATION-R16G BLOCKER-1, H3/H4/H27/H31).
  return functionNamedBy(callee);
}

/** Every expression the function returns, a concise arrow body included. */
function returnExpressionsOf(fn) {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  return collectNodes(fn, (node) =>
    ts.isReturnStatement(node) && node.expression !== undefined && !isInsideNestedFunction(node, fn)
      ? node.expression
      : null,
  );
}

/**
 * The function an expression names, when it names one — call or callback form.
 *
 * Resolution is transitive and union-valued, because the ordinary forms do not
 * stop at one hop or one branch: `const g = make`, `const h = g`, a conditional
 * or logical initializer (`flag ? () => chain : null`, `flag && (() => chain)`),
 * and an assignment expression (`(g = make)`) all name what they point at
 * (review CF070-GATE-REMEDIATION-R16G BLOCKER-1, H3/H4/H27/H31).
 */
function functionNamedBy(expression, seen = new Set()) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return undefined;
  if (seen.has(inner)) return undefined;
  seen.add(inner);
  const done = (value) => {
    seen.delete(inner);
    return value;
  };
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isFunctionDeclaration(inner)) {
    return done(inner);
  }
  if (ts.isConditionalExpression(inner)) {
    return done(functionNamedBy(inner.whenTrue, seen) ?? functionNamedBy(inner.whenFalse, seen));
  }
  if (ts.isBinaryExpression(inner)) {
    const kind = inner.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.CommaToken
    ) {
      // Either operand can be the value; a function in either makes the result
      // a function candidate.
      return done(functionNamedBy(inner.left, seen) ?? functionNamedBy(inner.right, seen));
    }
    if (kind === ts.SyntaxKind.EqualsToken) return done(functionNamedBy(inner.right, seen));
    return done(undefined);
  }
  // `obj.get` names the function written in that object literal slot
  // (review CF070-GATE-REMEDIATION-R16D BLOCKER-1, N2).
  if (ts.isPropertyAccessExpression(inner)) return done(functionFromPropertyAccess(inner, seen));
  if (!ts.isIdentifier(inner)) return done(undefined);
  const declaration = nearestBindingOf(inner, inner.text);
  if (declaration === undefined || declaration === null) return done(undefined);
  if (ts.isFunctionDeclaration(declaration)) return done(declaration);
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.initializer !== undefined) {
      // `const g = make; const h = g;` — follow the alias chain.
      return done(functionNamedBy(declaration.initializer, seen));
    }
    // `let g; g = () => chain; g()` — an assignment-form binding names the
    // function its definite assignment gives it (review R16D BLOCKER-2, N1).
    return done(assignedFunctionNamedBy(inner));
  }
  return done(undefined);
}

/** The function written into an object literal slot: `{ get: () => chain }.get`. */
function functionFromPropertyAccess(access, seen = new Set()) {
  const propertyName = ts.isIdentifier(access.name) ? access.name.text : null;
  if (propertyName === null) return undefined;
  const base = unwrapExpression(access.expression);
  if (base === undefined) return undefined;
  const candidate = ts.isObjectLiteralExpression(base) ? base : objectLiteralBoundTo(base);
  if (candidate === undefined) return undefined;
  for (const property of candidate.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameOf(property.name) !== propertyName) continue;
    // The slot's own value goes through the same resolver, so an alias, a
    // conditional or a nested property access in the slot resolves too.
    return functionNamedBy(property.initializer, seen);
  }
  return undefined;
}

/**
 * The object literal a name is bound to: by declaration, by a parameter
 * default, or by assignment (`let obj; obj = { get: … }`). The assignment form
 * is an ordinary way to build the holder and must be followed
 * (review CF070-GATE-REMEDIATION-R16G BLOCKER-2, H5).
 */
function objectLiteralBoundTo(expression) {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return undefined;
  const declaration = nearestBindingOf(expression, expression.text);
  if (declaration !== undefined && declaration !== null) {
    if (declaration.initializer !== undefined) {
      const initializer = unwrapExpression(declaration.initializer);
      if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) return initializer;
    }
  }
  // The assignment that builds the object belongs to the scope the *binding*
  // lives in, which need not be the scope of the use: a parameter default
  // (`const get = ({ list } = obj) => list`) is inside the arrow, while
  // `obj = { … }` ran in the helper
  // (review CF070-GATE-REMEDIATION-R16G BLOCKER-2, H7).
  const bindingScope =
    declaration !== undefined && declaration !== null ? enclosingFunctionOf(declaration) : undefined;
  const scope = bindingScope ?? enclosingFunctionOf(expression);
  if (scope === undefined) return undefined;
  let found;
  let foundPos = -1;
  walkTree(scope, (node) => {
    if (!ts.isBinaryExpression(node) || !isAssignmentOperator(node.operatorToken.kind)) return;
    if (node.getStart() > expression.getStart()) return;
    if (enclosingFunctionOf(node) !== scope) return;
    const left = unwrapExpression(node.left);
    if (left === undefined || !ts.isIdentifier(left) || left.text !== expression.text) return;
    const right = unwrapExpression(node.right);
    if (right === undefined || !ts.isObjectLiteralExpression(right)) return;
    if (node.getStart() > foundPos) {
      found = right;
      foundPos = node.getStart();
    }
  });
  return found;
}

/**
 * The conditional constructs a node is reached through, walking out to
 * `boundary`. Two nodes are influenced by the *same* conditional only when they
 * share that ancestor, which is what makes a rebind definite for a use inside
 * the same branch and conditional for a use outside it
 * (review CF070-GATE-REMEDIATION-R16F BLOCKER-1/BLOCKER-3).
 */
function conditionalAncestorsOf(node, boundary) {
  const conditionals = new Set();
  for (let parent = node.parent; parent !== undefined && parent !== boundary; parent = parent.parent) {
    if (isFunctionLike(parent)) break;
    if (
      ts.isIfStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isForStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isTryStatement(parent) ||
      ts.isCatchClause(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isCaseClause(parent) ||
      ts.isDefaultClause(parent) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(parent.operatorToken.kind))
    ) {
      conditionals.add(parent);
    }
  }
  return conditionals;
}

/**
 * True when `statement` reaches `use` through a branch `use` itself is not in,
 * so the statement may not have run by the time the use executes.
 */
function maySkipBefore(statement, use, boundary) {
  const useConditionals = conditionalAncestorsOf(use, boundary);
  for (const conditional of conditionalAncestorsOf(statement, boundary)) {
    if (!useConditionals.has(conditional)) return true;
  }
  return false;
}

/** A function declaration of this name written in the helper (hoisted). */
function hoistedFunctionDeclaration(boundary, name) {
  let found;
  const visit = (node) => {
    if (found !== undefined) return;
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === name) {
      found = node;
      return;
    }
    if (node !== boundary && isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(boundary);
  return found;
}

/**
 * The function a bare identifier holds at a *use site*, when it is assigned in
 * the same function body (`let g; g = () => chain; g()`).
 *
 * Only a **definite** assignment decides: one written on a path the use itself
 * takes. A later `g = null` inside an `if` the use is outside of never decides
 * for that use, because the branch may not run — which is how the position-only
 * rule failed open (review CF070-GATE-REMEDIATION-R16F BLOCKER-1, M-J1). The
 * right-hand side is resolved through the same function resolver callbacks use,
 * so `g = obj.get` and `g = make` (a declared function) name their function
 * (M-J2/M-J3). When the latest definite assignment yields a fresh value, the
 * name is not a function even if an earlier assignment was.
 */
function assignedFunctionNamedBy(identifier) {
  const scope = enclosingFunctionOf(identifier);
  if (scope === undefined) return undefined;
  const binding = nearestBindingOf(identifier, identifier.text);
  if (binding === undefined || binding === null) return undefined;
  const use = identifier;
  let seenDefinite = false;
  let definite;
  let conditional;
  // The right-hand side of the most recent assignment to this name, as far as
  // the scan can see it. A compound assignment (`||=`, `&&=`, `??=`) rebinds
  // only when that value is falsy / truthy / nullish, so a provably truthy
  // earlier assignment means the compound form cannot run
  // (review CF070-GATE-REMEDIATION-R16G BLOCKER-1, H1).
  let prior;
  const resolve = (right) => {
    const inner = unwrapExpression(right);
    if (inner === undefined) return undefined;
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isFunctionDeclaration(inner)) {
      return inner;
    }
    // A self-assignment names nothing and would recurse forever.
    if (ts.isIdentifier(inner)) {
      if (inner.text === identifier.text) return undefined;
      return functionNamedBy(inner) ?? hoistedFunctionDeclaration(scope, inner.text);
    }
    // A conditional, logical, comma or property-access right-hand side goes
    // through the same resolver a declaration initializer uses, so
    // `g = flag ? () => chain : null`, `g = () => chain` through an alias and
    // `g = obj.get` all name their function (R16G BLOCKER-1, H2/H3/H4).
    return functionNamedBy(inner);
  };
  walkTree(scope, (node) => {
    if (!ts.isBinaryExpression(node) || !isAssignmentOperator(node.operatorToken.kind)) return;
    if (node.end > use.getStart()) return;
    // A nested function's assignment does not run before this use.
    if (enclosingFunctionOf(node) !== scope) return;
    const left = unwrapExpression(node.left);
    if (left === undefined) return;
    let right;
    if (ts.isIdentifier(left)) {
      if (left.text !== identifier.text) return;
      if (nearestBindingOf(left, left.text) !== binding) return;
      right = node.right;
    } else if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) {
      // `({ g } = { g: () => chain })` and `[g] = [() => chain]` bind the name
      // through the pattern target (review R16G BLOCKER-2, H6).
      right = assignedValueOfTarget(left, node.right, identifier.text);
      if (right === undefined) return;
    } else {
      return;
    }
    const kind = node.operatorToken.kind;
    if (kind !== ts.SyntaxKind.EqualsToken) {
      // `g ||= make`: when the current value is provably truthy the operator
      // never evaluates its right-hand side and cannot install the function.
      if (
        (kind === ts.SyntaxKind.BarBarEqualsToken && prior !== undefined && isDefinitelyTruthy(prior)) ||
        (kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken && prior !== undefined && isDefinitelyFalsy(prior)) ||
        (kind === ts.SyntaxKind.QuestionQuestionEqualsToken && prior !== undefined && isDefinitelyNonNullish(prior))
      ) {
        prior = undefined;
        return;
      }
      const resolved = resolve(right);
      // The operator may leave the old value in place, so the name may still be
      // whatever it was before — and that may be the function.
      if (resolved !== undefined) conditional = resolved;
      if (prior !== undefined) {
        const previous = resolve(prior);
        if (previous !== undefined) conditional = previous;
      }
      prior = undefined;
      return;
    }
    const resolved = resolve(right);
    prior = right;
    if (maySkipBefore(node, use, scope)) {
      // The branch may not run, so the name may still be whatever it was.
      if (resolved !== undefined) conditional = resolved;
      return;
    }
    seenDefinite = true;
    definite = resolved;
  });
  if (seenDefinite) return definite;
  return conditional;
}

/**
 * The value an assignment pattern binds to `name` from `value`:
 * `({ g } = { g: fn })`, `({ a: { g } } = obj)`, `[g] = [fn]`. Recursive because
 * patterns nest, and the reviewer's shapes nested them
 * (review CF070-GATE-REMEDIATION-R16G BLOCKER-2, H6).
 */
function assignedValueOfTarget(target, value, name) {
  const inner = unwrapExpression(target);
  if (inner === undefined) return undefined;
  if (ts.isIdentifier(inner)) return inner.text === name ? value : undefined;
  if (ts.isObjectLiteralExpression(inner)) {
    for (const property of inner.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text !== name) continue;
        return propertyValueExpression(value, property.name.text);
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const propertyName = propertyNameOf(property.name);
      if (propertyName === null) continue;
      const nested = assignedValueOfTarget(
        property.initializer,
        propertyValueExpression(value, propertyName),
        name,
      );
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (ts.isArrayLiteralExpression(inner)) {
    const slots = elementExpressionsOf(value);
    let index = 0;
    for (const element of inner.elements) {
      if (ts.isOmittedExpression(element)) {
        index += 1;
        continue;
      }
      const slotValue = ts.isSpreadElement(element) ? value : slots[index];
      index += 1;
      const nested = assignedValueOfTarget(
        ts.isSpreadElement(element) ? element.expression : element,
        slotValue,
        name,
      );
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** A value that is provably truthy, so `||=` cannot rebind it. */
function isDefinitelyTruthy(expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  return (
    ts.isArrowFunction(inner) ||
    ts.isFunctionExpression(inner) ||
    ts.isFunctionDeclaration(inner) ||
    ts.isObjectLiteralExpression(inner) ||
    ts.isArrayLiteralExpression(inner) ||
    ts.isClassExpression(inner) ||
    ts.isNewExpression(inner) ||
    ts.isRegularExpressionLiteral(inner) ||
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    (ts.isStringLiteralLike(inner) && inner.text.length > 0) ||
    (ts.isNumericLiteral(inner) && Number(inner.text) !== 0)
  );
}

/** A value that is provably falsy. */
function isDefinitelyFalsy(expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  return (
    inner.kind === ts.SyntaxKind.FalseKeyword ||
    inner.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(inner) && inner.text === "undefined") ||
    (ts.isStringLiteralLike(inner) && inner.text.length === 0) ||
    (ts.isNumericLiteral(inner) && Number(inner.text) === 0)
  );
}

/** A value that is provably neither `null` nor `undefined`, so `??=` cannot rebind it. */
function isDefinitelyNonNullish(expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (inner.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(inner) && inner.text === "undefined") return false;
  return isDefinitelyTruthy(inner) || isDefinitelyFalsy(inner);
}

/**
 * A mapping result holds its callback values; a filtering result holds the
 * receiver's elements, NOT its predicate values. Neither fresh outer array is
 * itself the shipped chain. Array.from's mapper follows map's value semantics.
 */
function iterationCarriesChain(call, isChainPath, seen) {
  const callee = unwrapExpression(call.expression);
  if (callee === undefined || !ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === "filter") return valueCarriesChain(callee.expression, isChainPath, seen);
  const from = arrayFromSource(call) !== undefined;
  if (!from && callee.name.text !== "map" && callee.name.text !== "flatMap") return false;
  const callback = call.arguments[from ? 1 : 0];
  if (callback === undefined) return false;
  const fn = functionNamedBy(callback);
  if (fn === undefined) return false;
  // flatMap flattens the callback's array by one level. A returned chain puts
  // its records in the output (a shallow copy), not the chain array as a slot.
  if (callee.name.text === "flatMap") {
    if (seen.has(fn)) return false;
    seen.add(fn);
    const carries = returnExpressionsOf(fn).some((value) => valueCarriesChain(value, isChainPath, seen));
    seen.delete(fn);
    return carries;
  }
  return functionYieldsChain(fn, isChainPath, seen);
}

/** flatMap of a chain-returning callback copies the chain's element identities. */
function flatMapCopiesChain(call, isChainPath) {
  const callee = unwrapExpression(call.expression);
  if (callee === undefined || !ts.isPropertyAccessExpression(callee) || callee.name.text !== "flatMap") return false;
  const callback = call.arguments[0];
  if (callback === undefined) return false;
  const fn = functionNamedBy(callback);
  return fn !== undefined && functionYieldsChain(fn, isChainPath);
}

/**
 * The expressions that can be an **element** of a container, one level down.
 * Bounded to what the helper writes: an array literal's slots, a `map`/`flatMap`/
 * `Array.from` callback's returned value, a filtering receiver's elements, and a
 * name bound to any of them (`review CF070-GATE-REMEDIATION-R16D BLOCKER-1`: a
 * mapper returning a container, `arr.at(0)`, `arr.pop()` and `arr[0][0]` were all
 * outside the old rules).
 */
function elementExpressionsOf(expression, depth = 0) {
  // A stated bound, not an accident: beyond sixteen container levels the scan
  // stops descending. Five and seven levels are covered by durable cases, and
  // level twelve — the deepest the reviewer's probe reaches — is covered too;
  // deeper than sixteen is not claimed (review R16F NIT-1: the old bound said
  // twelve and was measured to stop one level short).
  if (depth > 16) return [];
  const inner = unwrapExpression(expression);
  if (inner === undefined) return [];
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.map((element) => (ts.isSpreadElement(element) ? element.expression : element));
  }
  if (ts.isIdentifier(inner)) {
    const declaration = nearestBindingOf(inner, inner.text);
    if (declaration === undefined || declaration === null) return [];
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return elementExpressionsOf(declaration.initializer, depth + 1);
    }
    if (ts.isParameter(declaration) && declaration.initializer !== undefined) {
      return elementExpressionsOf(declaration.initializer, depth + 1);
    }
    return [];
  }
  // `arr[0]` is one element of `arr`; its own elements are one level deeper, so
  // `arr[0][0]` of a mapper that returned `[chain]` is the chain itself.
  if (ts.isElementAccessExpression(inner)) {
    return elementExpressionsOf(inner.expression, depth + 1).flatMap((element) =>
      elementExpressionsOf(element, depth + 1),
    );
  }
  if (!ts.isCallExpression(inner)) return [];
  const callee = unwrapExpression(inner.expression);
  if (callee === undefined || !ts.isPropertyAccessExpression(callee)) return [];
  const method = callee.name.text;
  if (arrayFromSource(inner) !== undefined) {
    const mapper = functionNamedBy(inner.arguments[1]);
    return mapper === undefined ? [] : returnExpressionsOf(mapper);
  }
  if (method === "map" || method === "flatMap") {
    const mapper = functionNamedBy(inner.arguments[0]);
    if (mapper === undefined) return [];
    const returned = returnExpressionsOf(mapper);
    return method === "flatMap"
      ? returned.flatMap((value) => elementExpressionsOf(value, depth + 1))
      : returned;
  }
  if (SHALLOW_COPY_METHODS.has(method) || RETURNS_RECEIVER_METHODS.has(method)) {
    return elementExpressionsOf(callee.expression, depth + 1);
  }
  return [];
}

/** Whether this expression is a container whose elements are the shipped chain itself. */
function elementsAreChain(expression, isChainPath, seen = new Set()) {
  if (seen.has(expression)) return false;
  seen.add(expression);
  const result = elementExpressionsOf(expression).some((element) =>
    expressionYieldsChain(element, isChainPath, seen),
  );
  seen.delete(expression);
  return result;
}

/** An array/object literal that holds the chain in one of its slots. */
function containerHoldsChain(expression, isChainPath, seen) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.some((element) =>
      expressionYieldsChain(ts.isSpreadElement(element) ? element.expression : element, isChainPath, seen),
    );
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return expressionYieldsChain(property.expression, isChainPath, seen);
      if (ts.isShorthandPropertyAssignment(property)) return expressionYieldsChain(property.name, isChainPath, seen);
      return ts.isPropertyAssignment(property)
        ? expressionYieldsChain(property.initializer, isChainPath, seen)
        : false;
    });
  }
  return false;
}

/**
 * Whether an expression is a container that holds the chain, or a call that
 * builds one (an iteration callback returning the chain), or a name bound to
 * either. Used for the *base* of a read: `[chain][0]` and `arr[0]` where
 * `arr = [1].map(get)` both hand back the shipped array itself
 * (review R16B BLOCKER-2, J2/J4). A base that IS the chain is deliberately not
 * included — `chain[0]` is an element, not the chain.
 */
function valueCarriesChain(expression, isChainPath, seen) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isArrayLiteralExpression(inner) || ts.isObjectLiteralExpression(inner)) {
    return containerHoldsChain(inner, isChainPath, seen);
  }
  if (ts.isCallExpression(inner)) return iterationCarriesChain(inner, isChainPath, seen);
  if (!ts.isIdentifier(inner)) return false;
  const declaration = nearestBindingOf(inner, inner.text);
  if (declaration === undefined || declaration === null) return false;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
  if (seen.has(declaration)) return false;
  seen.add(declaration);
  const resolved = valueCarriesChain(declaration.initializer, isChainPath, seen);
  seen.delete(declaration);
  return resolved;
}

/**
 * A parameter with a chain default is the chain inside its own body
 * (`(x = chain) => x`, `({ list } = { list: chain }) => list`)
 * (review CF070-GATE-REMEDIATION-R16D BLOCKER-2, N10/N11).
 */
function parameterDefaultYieldsChain(identifier, isChainPath, seen) {
  const declaration = nearestBindingOf(identifier, identifier.text);
  if (declaration === undefined || declaration === null) return false;
  if (seen.has(declaration)) return false;
  seen.add(declaration);
  let result = false;
  if (ts.isParameter(declaration)) {
    // The parameter's own default: `(x = chain) => x`.
    if (declaration.initializer !== undefined) {
      result = ts.isIdentifier(declaration.name)
        ? expressionYieldsChain(declaration.initializer, isChainPath, seen)
        : patternBindsChain(declaration.name, declaration.initializer, identifier.text, isChainPath, seen);
    } else if (!ts.isIdentifier(declaration.name)) {
      // A default written inside the pattern instead of on the parameter:
      // `({ list = chain } = {}) => list`, `([first] = [chain]) => first`
      // (review CF070-GATE-REMEDIATION-R16E BLOCKER-2).
      result = patternBindsChain(declaration.name, undefined, identifier.text, isChainPath, seen);
    }
  }
  seen.delete(declaration);
  return result;
}

/**
 * Whether one name of a binding pattern denotes the chain, considering the
 * element's own default and, when there is one, the value being destructured.
 *
 * Nested patterns are the same rule one level down: `({ a: { list } })` reads
 * `a` and then `list` from it, and a nested element default applies exactly like
 * a top-level one. Skipping a pattern element whose name is not an identifier
 * left every nested form accepted (review CF070-GATE-REMEDIATION-R16F
 * BLOCKER-2, M-K1/M-K2/M-K3).
 */
function patternBindsChain(pattern, initializer, name, isChainPath, seen) {
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const property = boundElementPropertyName(element);
      const value =
        element.initializer !== undefined
          ? element.initializer
          : initializer === undefined || property === null
            ? undefined
            : propertyValueExpression(initializer, property);
      if (ts.isIdentifier(element.name)) {
        if (element.name.text !== name) continue;
        return value !== undefined && expressionYieldsChain(value, isChainPath, seen);
      }
      // `{ data: { list } }` descends with the value that element receives.
      if (patternBindsChain(element.name, value, name, isChainPath, seen)) return true;
    }
    return false;
  }
  if (ts.isArrayBindingPattern(pattern)) {
    let index = 0;
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) {
        index += 1;
        continue;
      }
      const slot =
        element.initializer !== undefined
          ? element.initializer
          : initializer === undefined
            ? undefined
            : elementExpressionsOf(initializer)[index];
      index += 1;
      if (ts.isIdentifier(element.name)) {
        if (element.name.text !== name) continue;
        return slot !== undefined && expressionYieldsChain(slot, isChainPath, seen);
      }
      // `([[first]] = [[chain]])` descends into the nested array pattern.
      if (patternBindsChain(element.name, slot, name, isChainPath, seen)) return true;
    }
  }
  return false;
}

/** The property a binding element reads, when the pattern names it. */
function boundElementPropertyName(element) {
  if (element.propertyName !== undefined && ts.isIdentifier(element.propertyName)) {
    return element.propertyName.text;
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

/**
 * The expression a named property of `expression` carries, when the scan can
 * see it: an object literal slot, or a name bound to one. A pattern descends
 * through this (`{ a: { list } } = { a: { list: chain } }`).
 */
function propertyValueExpression(expression, propertyName, seen = new Set()) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return undefined;
  if (seen.has(inner)) return undefined;
  seen.add(inner);
  const done = (value) => {
    seen.delete(inner);
    return value;
  };
  if (ts.isObjectLiteralExpression(inner)) {
    for (const property of inner.properties) {
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : ts.isPropertyAssignment(property)
          ? propertyNameOf(property.name)
          : null;
      if (name === null || name !== propertyName) continue;
      return done(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer);
    }
    return done(undefined);
  }
  if (ts.isIdentifier(inner)) {
    const declaration = nearestBindingOf(inner, inner.text);
    if (declaration !== undefined && declaration !== null && declaration.initializer !== undefined) {
      return done(propertyValueExpression(declaration.initializer, propertyName, seen));
    }
    // `let obj; obj = { list: chain }; return obj.list` — the object can arrive
    // by assignment, not only by declaration or parameter default
    // (review CF070-GATE-REMEDIATION-R16G BLOCKER-2, H7).
    const literal = objectLiteralBoundTo(inner);
    return done(literal === undefined ? undefined : propertyValueExpression(literal, propertyName, seen));
  }
  if (ts.isCallExpression(inner)) {
    const local = localFunctionOf(inner);
    if (local === undefined) return done(undefined);
    for (const returned of returnExpressionsOf(local)) {
      const found = propertyValueExpression(returned, propertyName, seen);
      if (found !== undefined) return done(found);
    }
  }
  return done(undefined);
}

/** The named property of an object literal — or of a name bound to one. */
function propertyValueYieldsChain(expression, propertyName, isChainPath, seen) {
  if (seen.has(expression)) return false;
  seen.add(expression);
  const result = propertyValueYieldsChainInner(expression, propertyName, isChainPath, seen);
  seen.delete(expression);
  return result;
}

function propertyValueYieldsChainInner(expression, propertyName, isChainPath, seen) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isObjectLiteralExpression(inner)) {
    for (const property of inner.properties) {
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : ts.isPropertyAssignment(property)
          ? propertyNameOf(property.name)
          : null;
      if (name === null || name !== propertyName) continue;
      const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
      if (expressionYieldsChain(value, isChainPath, seen)) return true;
    }
    return false;
  }
  // `arr[0].list` where the mapper returned `{ list: chain }`
  // (review R16D BLOCKER-1, N6).
  if (ts.isElementAccessExpression(inner)) {
    return elementExpressionsOf(inner.expression).some((element) =>
      propertyValueYieldsChain(element, propertyName, isChainPath, seen),
    );
  }
  // `make().list` where a local function returns the literal.
  if (ts.isCallExpression(inner)) {
    const local = localFunctionOf(inner);
    if (local === undefined) return false;
    return returnExpressionsOf(local).some((returned) =>
      propertyValueYieldsChain(returned, propertyName, isChainPath, seen),
    );
  }
  if (!ts.isIdentifier(inner)) return false;
  const declaration = nearestBindingOf(inner, inner.text);
  if (declaration === undefined || declaration === null) return false;
  if (ts.isParameter(declaration) && declaration.initializer !== undefined) {
    return propertyValueYieldsChain(declaration.initializer, propertyName, isChainPath, seen);
  }
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
  return propertyValueYieldsChain(declaration.initializer, propertyName, isChainPath, seen);
}

/**
 * Whether an expression hands back the shipped chain *itself*: a name or alias of
 * it, a `cond ? chain : …` / `x ?? chain` / `x || chain` / `x && chain` branch,
 * or a call to a local function that returns the chain.
 *
 * A call *on* the chain (`built.suggestions.slice()`) is deliberately not a
 * chain yield here: it hands back a different container, and the callers already
 * decide that case with their own copy rules. Without that split,
 * `built.suggestions.slice()` would count as "the chain" by prefix and the
 * in-place-method exemption would stop working (review R16 BLOCKER-2: a function
 * that returns the chain was named `get()`, and `chainPathOf` named the call
 * `get()`, which no seeded alias ever matched).
 */
function expressionYieldsChain(expression, isChainPath, seen = new Set()) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (!ts.isCallExpression(inner)) {
    const path = chainPathOf(inner);
    if (path !== null && isChainPath(path)) return true;
  }
  // A parameter bound with a chain default is the chain
  // (`(x = chain) => x`, `({ list } = { list: chain }) => list`)
  // (review CF070-GATE-REMEDIATION-R16D BLOCKER-2, N10/N11).
  if (ts.isIdentifier(inner)) {
    const resolved = parameterDefaultYieldsChain(inner, isChainPath, seen);
    if (resolved) return true;
  }
  if (ts.isConditionalExpression(inner)) {
    return (
      expressionYieldsChain(inner.whenTrue, isChainPath, seen) ||
      expressionYieldsChain(inner.whenFalse, isChainPath, seen)
    );
  }
  if (
    ts.isBinaryExpression(inner) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(inner.operatorToken.kind)
  ) {
    return (
      expressionYieldsChain(inner.left, isChainPath, seen) ||
      expressionYieldsChain(inner.right, isChainPath, seen)
    );
  }
  // The comma operator's value is its last operand, so `(0, chain)` is the chain
  // (review R16B BLOCKER-2, J1 and L7: `get().length = 0`, `get().push(…)`).
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return expressionYieldsChain(inner.right, isChainPath, seen);
  }
  // A chain held in a container literal comes back out by index or property:
  // `[chain][0].splice(…)` and `({ list: chain }).list.length = 0`
  // (review R16B BLOCKER-2, J2/J3).
  if (ts.isElementAccessExpression(inner)) {
    if (valueCarriesChain(inner.expression, isChainPath, seen)) return true;
    // A container whose element is a container of the chain hands the chain back
    // one level down: `arr[0][0]` where the mapper returned `[chain]`
    // (review R16D BLOCKER-1, N5).
    if (elementsAreChain(inner.expression, isChainPath, seen)) return true;
  }
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    if (propertyValueYieldsChain(inner.expression, inner.name.text, isChainPath, seen)) return true;
  }
  if (!ts.isCallExpression(inner)) return false;
  // Selection reads the receiver's elements, never its predicate's result.
  // A map/filter/Array.from result can CARRY the chain but remains a fresh
  // container: clearing its own length must not count as clearing the chain.
  const callee = unwrapExpression(inner.expression);
  if (callee !== undefined && ts.isPropertyAccessExpression(callee)) {
    // `find`/`findLast` return the selected element; `at`, `pop` and `shift`
    // return one too. Each is the chain when the receiver's elements are the
    // chain (review R16D BLOCKER-1, N3/N4).
    if (
      (callee.name.text === "find" || callee.name.text === "findLast") &&
      valueCarriesChain(callee.expression, isChainPath, seen)
    ) return true;
    if (
      (callee.name.text === "at" || callee.name.text === "pop" || callee.name.text === "shift") &&
      elementsAreChain(callee.expression, isChainPath, seen)
    ) return true;
    // `reduce`'s value is the callback's return once it runs; with an initial
    // value it always does (review R16D BLOCKER-1, N8/N9).
    if (callee.name.text === "reduce" || callee.name.text === "reduceRight") {
      const reducer = functionNamedBy(inner.arguments[0]);
      // A provably empty receiver never calls the reducer, so the result is the
      // initial value and not the callback's return (review R16E MINOR-1).
      const receiver = unwrapExpression(callee.expression);
      const emptyReceiver =
        receiver !== undefined && ts.isArrayLiteralExpression(receiver) && receiver.elements.length === 0;
      if (
        reducer !== undefined &&
        !emptyReceiver &&
        (inner.arguments.length > 1 || elementsAreChain(callee.expression, isChainPath, seen)) &&
        functionYieldsChain(reducer, isChainPath, seen)
      ) {
        return true;
      }
    }
  }
  const local = localFunctionOf(inner);
  if (local === undefined) return false;
  return functionYieldsChain(local, isChainPath, seen);
}

/** Every return of the local function hands back the chain (co-inductive on cycles). */
function functionYieldsChain(fn, isChainPath, seen = new Set()) {
  if (seen.has(fn)) return false;
  seen.add(fn);
  const returned = returnExpressionsOf(fn);
  return returned.length > 0 && returned.some((value) => expressionYieldsChain(value, isChainPath, seen));
}

/** The source of an `Array.from(source, …)` call, if this is one. */
function arrayFromSource(node) {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrapExpression(node.expression);
  if (callee === undefined || !ts.isPropertyAccessExpression(callee)) return undefined;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "Array") return undefined;
  if (callee.name.text !== "from") return undefined;
  return node.arguments[0];
}

/** Calls whose arguments the callee only reads or copies. */
/**
 * Methods of a primitive value. Called on a property of an element
 * (`a.suggestedValue.localeCompare(b.suggestedValue)`) they neither keep nor
 * change their arguments, so the arguments are not a hand-off of a reviewed
 * record (review CF070-GATE-REMEDIATION-R11 MINOR-1). A method with one of these
 * names defined on a nested object is outside the bounded plain-record contract.
 */
const PRIMITIVE_METHODS = new Set([
  "at", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "includes",
  "indexOf", "lastIndexOf", "localeCompare", "match", "matchAll", "normalize",
  "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice",
  "split", "startsWith", "substring", "toFixed", "toLowerCase", "toPrecision",
  "toString", "toUpperCase", "trim", "trimEnd", "trimStart", "valueOf",
  "isWellFormed", "substr", "toLocaleLowerCase", "toLocaleString", "toLocaleUpperCase",
  "toWellFormed", "trimLeft", "trimRight",
]);

const SAFE_ARGUMENT_METHODS = new Set([
  "at", "concat", "from", "includes", "indexOf", "join", "lastIndexOf", "of", "slice",
]);

/** Array methods that read or copy without changing the receiver. */
const NON_MUTATING_ARRAY_METHODS = new Set([
  "at", "concat", "entries", "every", "filter", "find", "findIndex", "findLast",
  "findLastIndex", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf",
  "map", "reduce", "reduceRight", "slice", "some", "toString", "values",
  "flat", "toReversed", "toSorted", "toSpliced", "with",
]);

/** True when the path names the chain, a part of it, or something that holds it. */
function pathWithinChain(keys, path) {
  if (path === null) return false;
  return [...keys].some((name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`));
}

/** Bind the names a binding pattern gives the value at `path`. */
function collectPatternAliases(keys, pattern, path) {
  if (ts.isIdentifier(pattern)) {
    if (pathWithinChain(keys, path)) keys.add(pattern.text);
    return;
  }
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName ?? element.name;
      if (!ts.isIdentifier(property)) continue;
      collectPatternAliases(keys, element.name, `${path}.${property.text}`);
    }
    return;
  }
  if (ts.isArrayBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      collectPatternAliases(keys, element.name, `${path}[]`);
    }
  }
}

/** Bind the names an assignment pattern writes the value at `path` into. */
function collectAssignmentAliases(keys, target, path) {
  const inner = unwrapExpression(target);
  if (inner === undefined) return;
  if (ts.isIdentifier(inner)) {
    if (pathWithinChain(keys, path)) keys.add(inner.text);
    return;
  }
  if (ts.isObjectLiteralExpression(inner)) {
    for (const property of inner.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        collectAssignmentAliases(keys, property.name, `${path}.${property.name.text}`);
      } else if (ts.isPropertyAssignment(property)) {
        if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
        collectAssignmentAliases(keys, property.initializer, `${path}.${property.name.text}`);
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(inner)) {
    for (const element of inner.elements) {
      if (ts.isSpreadElement(element)) {
        collectAssignmentAliases(keys, element.expression, `${path}[]`);
      } else if (!ts.isOmittedExpression(element)) {
        collectAssignmentAliases(keys, element, `${path}[]`);
      }
    }
  }
}

/** True when the expression holds the chain anywhere inside it. */
function expressionHoldsChain(expression, holds) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isSpreadElement(inner)) return expressionHoldsChain(inner.expression, holds);
  const path = chainPathOf(inner);
  if (path !== null && holds(path)) return true;
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.some((element) =>
      expressionHoldsChain(ts.isSpreadElement(element) ? element.expression : element, holds),
    );
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return expressionHoldsChain(property.expression, holds);
      if (ts.isPropertyAssignment(property)) return expressionHoldsChain(property.initializer, holds);
      if (ts.isShorthandPropertyAssignment(property)) return holds(property.name.text);
      return false;
    });
  }
  if (ts.isAwaitExpression(inner)) return expressionHoldsChain(inner.expression, holds);
  if (ts.isClassExpression(inner)) {
    return inner.members.some(
      (member) =>
        ts.isPropertyDeclaration(member) &&
        member.initializer !== undefined &&
        expressionHoldsChain(member.initializer, holds),
    );
  }
  if (ts.isConditionalExpression(inner)) {
    return expressionHoldsChain(inner.whenTrue, holds) || expressionHoldsChain(inner.whenFalse, holds);
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return expressionHoldsChain(inner.right, holds);
  }
  if ((ts.isCallExpression(inner) || ts.isNewExpression(inner)) && inner.arguments !== undefined) {
    return inner.arguments.some((argument) => expressionHoldsChain(argument, holds));
  }
  return false;
}

/**
 * Add the names a declaration binds to the chain: an identifier initialised from
 * it, a destructuring of it (`const { suggestions } = built`), an object literal
 * that holds it under a nested path (`const payload = { value: { suggestions:
 * built.suggestions } }`), an `Object.assign` whose sources hold it, and an array
 * literal that contains it (review CF070-GATE-REMEDIATION-R6 MAJOR-1, R7 MAJOR-1).
 */
function collectChainAliases(keys, name, initializer) {
  const onChain = (path) => pathWithinChain(keys, path);
  const path = chainPathOf(initializer);
  if (ts.isIdentifier(name)) {
    if (path !== null && onChain(path)) {
      keys.add(name.text);
      return;
    }
    const literal = unwrapExpression(initializer);
    if (literal === undefined) return;
    if (ts.isObjectLiteralExpression(literal)) {
      collectHolderPaths(keys, name.text, literal, onChain);
      return;
    }
    if (ts.isArrayLiteralExpression(literal)) {
      if (literal.elements.some((element) =>
        expressionHoldsChain(ts.isSpreadElement(element) ? element.expression : element, onChain),
      )) {
        keys.add(`${name.text}[]`);
      }
      return;
    }
    if (ts.isCallExpression(literal) && expressionYieldsChain(literal, onChain)) {
      // A local function that returns the chain hands the chain itself back, so
      // its binding is an alias, not a copy (`const alias = get(); alias.splice`)
      // (review R16 BLOCKER-2).
      keys.add(name.text);
      return;
    }
    if (ts.isCallExpression(literal) && objectStaticCallName(literal) === "assign") {
      for (const argument of literal.arguments.slice(1)) {
        const source = unwrapExpression(argument);
        if (source !== undefined && ts.isObjectLiteralExpression(source)) {
          collectHolderPaths(keys, name.text, source, onChain);
        }
      }
    }
    // Anything else that *is* the chain by value, not by spelling: a slot read
    // (`const x = arr[0]` where `arr` is a mapper result), a container index, an
    // element selected through `at`/`pop`, a `reduce` value
    // (review CF070-GATE-REMEDIATION-R16D BLOCKER-1, N19 and its siblings).
    if (expressionYieldsChain(initializer, onChain)) {
      keys.add(name.text);
    }
    return;
  }
  if (path === null) return;
  collectPatternAliases(keys, name, path);
}

/**
 * A shallow copy of the value `isSource` names: `[...x]`, `x.slice()`,
 * `x.map(…)`, `Array.from(x)`, `Object.values(x)`. A copy holds the *same* element
 * objects, so it is not a fresh value even though its array is new
 * (review CF070-GATE-REMEDIATION-R16F BLOCKER-4).
 */
function shallowCopyOfValue(expression, isSource, seen = new Set()) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (seen.has(inner)) return false;
  seen.add(inner);
  let result = false;
  if (ts.isConditionalExpression(inner)) {
    // Either branch can be the value; a copy in either makes the result a copy
    // (review R16G BLOCKER-3 — conditional copies were an unlisted form).
    result =
      shallowCopyOfValue(inner.whenTrue, isSource, seen) ||
      shallowCopyOfValue(inner.whenFalse, isSource, seen);
  } else if (ts.isBinaryExpression(inner)) {
    const kind = inner.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.CommaToken
    ) {
      // `xs ?? []`, `flag && [...xs]`, `(side(), [...xs])`.
      result =
        shallowCopyOfValue(inner.left, isSource, seen) ||
        shallowCopyOfValue(inner.right, isSource, seen);
    }
  } else if (ts.isArrayLiteralExpression(inner)) {
    result = inner.elements.some(
      (element) =>
        ts.isSpreadElement(element) &&
        // `[...[...list]]` copies the same elements one level down, so a nested
        // spread is a copy of its own source (review R16G BLOCKER-3, H9).
        (isSource(element.expression) || shallowCopyOfValue(element.expression, isSource, seen)),
    );
  } else if (ts.isCallExpression(inner)) {
    const callee = unwrapExpression(inner.expression);
    if (callee !== undefined && ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (
        (SHALLOW_COPY_METHODS.has(method) || RETURNS_RECEIVER_METHODS.has(method)) &&
        isSource(callee.expression)
      ) {
        result = true;
      }
    }
    if (!result) {
      const source = arrayFromSource(inner);
      if (source !== undefined && isSource(source)) result = true;
    }
    if (!result) {
      const objectStatic = objectStaticCallName(inner);
      if (
        (objectStatic === "values" || objectStatic === "entries") &&
        inner.arguments[0] !== undefined &&
        isSource(inner.arguments[0])
      ) {
        result = true;
      }
    }
    // `const cp = (xs) => [...xs]; cp(list)` — a local helper that copies its own
    // argument copies the value handed to it (review R16G BLOCKER-3, H10/H11).
    if (!result) result = localFunctionCopiesArgument(inner, isSource, seen);
  }
  seen.delete(inner);
  return result;
}

/**
 * Whether `call` invokes a local function that returns a shallow copy of one of
 * its parameters, and the argument bound to that parameter is a copy source.
 * Handles chained helpers (`cp2(cp1(list))`) by resolving each helper's
 * parameters to the expressions at its call site.
 */
function localFunctionCopiesArgument(call, isSource, seen) {
  const fn = localFunctionOf(call);
  if (fn === undefined) return false;
  if (seen.has(fn)) return false;
  seen.add(fn);
  const parameters = fn.parameters;
  const argumentFor = (candidate) => {
    const inner = unwrapExpression(candidate);
    if (inner === undefined || !ts.isIdentifier(inner)) return undefined;
    const index = parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === inner.text,
    );
    return index === -1 ? undefined : call.arguments[index];
  };
  const argumentIsSource = (argument) =>
    isSource(argument) || shallowCopyOfValue(argument, isSource, seen);
  const copiesParameter = (expression) =>
    shallowCopyOfValue(
      expression,
      (candidate) => {
        const argument = argumentFor(candidate);
        if (argument !== undefined && argumentIsSource(argument)) return true;
        return isSource(candidate);
      },
      seen,
    );
  const result = returnExpressionsOf(fn).some(copiesParameter);
  seen.delete(fn);
  return result;
}

/**
 * How a callback's parameter binding stands at its first use: `"fresh"` when it
 * is definitely rebound to a new value first (the write that follows cannot reach
 * the shipped chain), `"copy"` when it is definitely rebound to a shallow copy of
 * itself (the array is new but the element objects are the shipped records), and
 * `"owner"` otherwise.
 *
 * Only a rebind that is **definite for the next use** counts: one written in a
 * branch the use is outside of may not have run, so the parameter still owns the
 * chain (review CF070-GATE-REMEDIATION-R16F BLOCKER-3, M-L1). A rebind to a
 * shallow copy is not fresh either (BLOCKER-4). A declaration name is not a use,
 * and a nested function's assignment does not run at this point.
 */
function rebindKindBeforeUse(callback, name, isChainPath) {
  const events = [];
  const isParameterPath = (candidate) => {
    const path = chainPathOf(candidate);
    return path !== null && path === name;
  };
  walkTree(callback, (node) => {
    // A nested function's body is a different execution point, so its writes and
    // assignments say nothing about this parameter at this point.
    if (node !== callback && isFunctionLike(node)) return;
    if (enclosingFunctionOf(node) !== callback) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrapExpression(node.left);
      if (left !== undefined && ts.isIdentifier(left) && left.text === name) {
        const holdsChain = expressionYieldsChain(node.right, isChainPath);
        const copiesSelf = !holdsChain && shallowCopyOfValue(node.right, isParameterPath);
        events.push({
          pos: node.getStart(),
          kind: "rebind",
          node,
          fresh: !holdsChain && !copiesSelf,
          copiesSelf,
        });
      }
      return;
    }
    if (ts.isIdentifier(node) && node.text === name && !ts.isParameter(node.parent)) {
      const parent = node.parent;
      // The assignment's own target is not a read of the parameter.
      if (
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === node
      ) {
        return;
      }
      events.push({ pos: node.getStart(), kind: "use", node, fresh: false, copiesSelf: false });
    }
  });
  events.sort((a, b) => a.pos - b.pos);
  const first = events[0];
  if (first === undefined || first.kind !== "rebind") return "owner";
  const nextUse = events.find((event) => event.kind === "use" && event.pos > first.pos);
  // A rebind with no later read says nothing about a write.
  if (nextUse === undefined) return "owner";
  if (maySkipBefore(first.node, nextUse.node, callback)) return "owner";
  return first.copiesSelf ? "copy" : "fresh";
}

/** The first read of `name` after `position`, if the helper has one. */
function nextReadOfName(scope, name, position) {
  let found;
  walkTree(scope, (node) => {
    if (found !== undefined) return;
    if (!ts.isIdentifier(node) || node.text !== name) return;
    if (node.getStart() < position) return;
    if (ts.isParameter(node.parent)) return;
    const parent = node.parent;
    // The target of an assignment is a write, not a read.
    if (
      parent !== undefined &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === node
    ) {
      return;
    }
    found = node;
  });
  return found;
}

/** The paths inside a fresh object literal that still name the shipped chain. */
function collectHolderPaths(keys, base, literal, onChain) {
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      const value = unwrapExpression(property.expression);
      if (value !== undefined && ts.isObjectLiteralExpression(value)) {
        collectHolderPaths(keys, base, value, onChain);
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
    const path = `${base}.${property.name.text}`;
    const value = unwrapExpression(property.initializer);
    if (value === undefined) continue;
    const valuePath = chainPathOf(value);
    if (valuePath !== null && onChain(valuePath)) {
      keys.add(path);
      continue;
    }
    if (ts.isObjectLiteralExpression(value)) collectHolderPaths(keys, path, value, onChain);
  }
}

/**
 * True when the helper changes the records it ships after computing them.
 *
 * The bounded callback effect contract reads callbacks around the reviewed
 * records; it cannot see a write made in the enclosing helper, where the same
 * records are still mutable. `built.suggestions.length = 0`,
 * `Object.assign(built, …)`, `list.splice(…)` and a conditioned
 * `item.suggestedValue = …` inside a `for … of` all change what the payload
 * carries while the payload still reads from the reviewed chain, and none of
 * them is inside a callback (review CF070-GATE-REMEDIATION-R5 MAJOR-1).
 *
 * The scan follows the shipped chain through declaration aliases (identifier,
 * destructuring, and object literals that hold it), assignment-form aliases, and
 * the element holders of `for … of` and iteration callbacks, to a fixed point.
 * A call that receives the chain (or an object that holds it) as an **argument**
 * is refused because its callee's body is not read — the rule §14 already applies
 * to elements inside a callback; so is a call on the chain whose method is not a
 * known non-mutating array method, and every in-place array method, `delete`,
 * `Reflect.set`/`Object.defineProperty` (by the argument rule), and
 * `Object.assign` onto the chain or its holder.
 *
 * Copies are followed by element identity: `[...chain]`, `chain.slice()`,
 * `chain.map(…)`, `Array.from(chain)`, an iterator (`entries`, `values`) over any
 * of them, and a copy stored on a declaration, an assignment target or a property
 * all hold the *same* element objects. Writing one (`list[0].field = …`, a `for … of` over the copy,
 * `reduce`'s element parameter, or a binding made from an element read —
 * `const first = list[0]`, `list.find(…)`, `list.at(-1)`, `const [head] = list`)
 * changes the records the payload carries, even though the array object is new. A
 * write to the copy's own array (`copy.sort()`, `copy.length = 0`,
 * `copy[0] = other`) changes only the copy and is accepted.
 *
 * Scope of this classifier: it follows a *copy* whose producer is visible in the
 * helper. A copy produced by a function this scan cannot read (another module, an
 * unwalked closure), or by a form of copying not listed above, is outside it. That
 * boundary is about **copies only**. It never excuses a value that is the shipped
 * chain itself: a chain handed back through a function return, a comma expression,
 * a container literal, or an iteration callback is the chain, and the returned
 * container is not a copy of it (review CF070-GATE-REMEDIATION-R16B BLOCKER-2).
 */
function shippedValueIsMutated(scope, shipped, reviewed) {
  // Seed from every reviewed `.suggestions` read in the helper, not only from the
  // expression the payload names: a copied payload (`[...built.suggestions]`,
  // `built.suggestions.slice()`, an identity `map`) has no path of its own, and
  // seeding from it alone left the scan vacuous (review CF070-GATE-REMEDIATION-R7
  // MAJOR-1).
  const keys = new Set();
  // Seeded paths are the shipped value itself and are never released. A derived
  // alias (a name handed the chain by a declaration) stops naming the chain once
  // it is rebound to something else (review R16E MINOR-1).
  const rootedKeys = new Set();
  const seed = (expression) => {
    const path = chainPathOf(expression);
    if (path !== null) {
      keys.add(path);
      rootedKeys.add(path);
    }
  };
  seed(shipped);
  walkTree(scope, (node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      memberAccessName(node) === "suggestions" &&
      readsReviewedValue(scope, node, reviewed)
    ) {
      seed(node);
    }
  });
  if (keys.size === 0) return false;
  const onChain = (path) =>
    typeof path === "string" &&
    [...keys].some((name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`));
  const underChain = (path) =>
    typeof path === "string" &&
    [...keys].some((name) => name.startsWith(`${path}.`) || name.startsWith(`${path}[`));

  for (let pass = 0; pass < 4; pass += 1) {
    const before = keys.size;
    walkTree(scope, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        collectChainAliases(keys, node.name, node.initializer);
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const rebound = unwrapExpression(node.left);
        if (
          rebound !== undefined &&
          ts.isIdentifier(rebound) &&
          keys.has(rebound.text) &&
          !rootedKeys.has(rebound.text) &&
          !expressionYieldsChain(node.right, onChain)
        ) {
          // A copy of the chain is not a fresh value: `list = [...list]` and
          // `list = list.slice()` still hold the shipped element objects, so the
          // name keeps its identity and the copy rules track it
          // (review CF070-GATE-REMEDIATION-R16F BLOCKER-4, M-Q1..M-Q4).
          if (
            shallowCopyOfValue(node.right, (candidate) => {
              const candidatePath = chainPathOf(candidate);
              return candidatePath !== null && onChain(candidatePath);
            })
          ) {
            return;
          }
          // A rebind inside a branch the next read is outside of may not run, so
          // the name still holds the chain there
          // (review CF070-GATE-REMEDIATION-R16F BLOCKER-3, same class).
          const nextRead = nextReadOfName(scope, rebound.text, node.end);
          if (nextRead !== undefined && maySkipBefore(node, nextRead, scope)) return;
          // `let list = [chain][0]; list = [];` — the name is a fresh value now,
          // so a later write to it is not a write to the shipped chain.
          keys.delete(rebound.text);
          return;
        }
        const path = chainPathOf(node.right);
        if (path !== null) {
          collectAssignmentAliases(keys, node.left, path);
          // `holder.list = built.suggestions; holder.list.length = 0` names the
          // chain through a property, not a binding (review
          // CF070-GATE-REMEDIATION-R8 MAJOR-1).
          const left = unwrapExpression(node.left);
          if (
            left !== undefined &&
            (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
            onChain(path)
          ) {
            const leftPath = chainPathOf(left);
            if (leftPath !== null && !onChain(leftPath)) keys.add(leftPath);
          }
        }
      }
    });
    if (keys.size === before) break;
  }

  // A shallow copy (`[...chain]`, `chain.slice()`, `chain.map(…)`, `Array.from(chain)`)
  // holds the *same* element objects, so iterating it hands out the chain's records
  // (review CF070-GATE-REMEDIATION-R8 MAJOR-1).
  const copies = new Set();
  const holdsCopy = (path) =>
    typeof path === "string" &&
    [...copies].some((name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`));
  // A path *inside* a copy's element (`list[0].suggestedValue`) names a shared
  // record; a path on the copy itself (`list.sort()`, `list.length = 0`) does not.
  // A slot reference (`list[0]`) *is* the element when it is handed somewhere, but
  // replacing the slot (`list[0] = other`) touches only the copy.
  const copySlot = (path) => {
    if (typeof path !== "string") return false;
    return [...copies].some((name) => {
      if (!path.startsWith(`${name}[`)) return false;
      return path.includes("]", name.length);
    });
  };
  const isCopyElement = (path) => {
    if (typeof path !== "string") return false;
    return [...copies].some((name) => {
      const prefix = `${name}[`;
      if (!path.startsWith(prefix)) return false;
      const close = path.indexOf("]", prefix.length);
      return close !== -1 && close + 1 < path.length;
    });
  };
  const resolving = new Set();
  const resolvingElements = new Set();
  const isCopyOfChain = (expression) => {
    const inner = unwrapExpression(expression);
    if (inner === undefined) return false;
    const path = chainPathOf(inner);
    if (path !== null && (onChain(path) || holdsCopy(path))) return true;
    // A local helper that copies its argument copies the chain when the call
    // hands it the chain, through as many helpers and nested spreads as the
    // source uses (review CF070-GATE-REMEDIATION-R16G BLOCKER-3, H9/H10).
    if (
      shallowCopyOfValue(
        inner,
        (candidate) => {
          const candidatePath = chainPathOf(candidate);
          return typeof candidatePath === "string" && (onChain(candidatePath) || holdsCopy(candidatePath));
        },
        new Set(),
      )
    ) {
      return true;
    }
    if (ts.isArrayLiteralExpression(inner)) {
      return inner.elements.some(
        (element) => ts.isSpreadElement(element) && isCopyOfChain(element.expression),
      );
    }
    if (ts.isPropertyAccessExpression(inner)) {
      // A property of a fresh object literal is the value written there, so
      // `{ list: copy }.list` is the copy (review R12 NIT-2).
      const base = unwrapExpression(inner.expression);
      if (base !== undefined && ts.isObjectLiteralExpression(base)) {
        for (const property of base.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = propertyNameOf(property.name);
          if (name !== null && name === inner.name.text && isCopyOfChain(property.initializer)) return true;
        }
      }
    }
    if (ts.isObjectLiteralExpression(inner)) {
      // `{ ...copy }` and `{ a: copy }` both carry the copy's elements under
      // their own keys (review CF070-GATE-REMEDIATION-R13 NIT-2).
      return inner.properties.some((property) => {
        if (ts.isSpreadAssignment(property)) return isCopyOfChain(property.expression);
        if (ts.isPropertyAssignment(property)) return isCopyOfChain(property.initializer);
        return false;
      });
    }
    if (ts.isCallExpression(inner)) {
      if (flatMapCopiesChain(inner, onChain)) return true;
      const callee = unwrapExpression(inner.expression);
      if (callee !== undefined && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        const method = memberAccessName(callee);
        if (method !== null && SHALLOW_COPY_METHODS.has(method) && isCopyOfChain(callee.expression)) return true;
        if (method !== null && RETURNS_RECEIVER_METHODS.has(method) && isCopyOfChain(callee.expression)) return true;
      }
      const source = arrayFromSource(inner);
      if (source !== undefined) return isCopyOfChain(source);
      // `Object.values(copy)` / `Object.entries(copy)` build a fresh array over the
      // same element objects (review R12 NIT-1, farm A11).
      const objectStatic = objectStaticCallName(inner);
      if (
        (objectStatic === "values" || objectStatic === "entries") &&
        inner.arguments[0] !== undefined &&
        isCopyOfChain(inner.arguments[0])
      ) {
        return true;
      }
      // A local function whose every return is a copy returns a copy
      // (`const makeCopy = () => [...chain]; const list = makeCopy();`).
      const local = localFunctionOf(inner);
      if (local !== undefined && !resolving.has(local)) {
        resolving.add(local);
        const returned = returnExpressionsOf(local);
        const copied = returned.length > 0 && returned.every((expression) => isCopySource(expression));
        resolving.delete(local);
        return copied;
      }
    }
    return false;
  };
  // A *copy* is a new array over the same elements; a plain alias
  // (`list = built.suggestions`) is the chain itself and stays a key.
  const isShallowCopyExpression = (expression) => {
    const inner = unwrapExpression(expression);
    if (inner === undefined) return false;
    // One predicate for both the callback and the helper path: a local helper
    // that copies its argument (`const cp = (xs) => [...xs]; list = cp(list)`)
    // is a shallow copy here too (review CF070-GATE-REMEDIATION-R16G
    // BLOCKER-3, H11).
    if (
      shallowCopyOfValue(
        inner,
        (candidate) => {
          const candidatePath = chainPathOf(candidate);
          return typeof candidatePath === "string" && (onChain(candidatePath) || holdsCopy(candidatePath));
        },
        new Set(),
      )
    ) {
      return true;
    }
    if (ts.isArrayLiteralExpression(inner)) {
      return inner.elements.some(
        (element) => ts.isSpreadElement(element) && isCopyOfChain(element.expression),
      );
    }
    if (ts.isCallExpression(inner)) {
      if (flatMapCopiesChain(inner, onChain)) return true;
      const callee = unwrapExpression(inner.expression);
      if (callee !== undefined && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        const method = memberAccessName(callee);
        if (method !== null && SHALLOW_COPY_METHODS.has(method) && isCopyOfChain(callee.expression)) return true;
        if (method !== null && RETURNS_RECEIVER_METHODS.has(method) && isCopyOfChain(callee.expression)) return true;
      }
      const source = arrayFromSource(inner);
      if (source !== undefined) return isCopyOfChain(source);
      const local = localFunctionOf(inner);
      if (local !== undefined && !resolving.has(local)) {
        resolving.add(local);
        const returned = returnExpressionsOf(local);
        const copied = returned.length > 0 && returned.every((expression) => isCopySource(expression));
        resolving.delete(local);
        return copied;
      }
    }
    return false;
  };
  const isCopySource = (expression) => {
    if (isShallowCopyExpression(expression)) return true;
    // A copy reached through a fresh container is still the same elements:
    // `{ list: copy }.list`, `{ ...copy }` (review R12 NIT-2 / farm V2, V6).
    if (isCopyOfChain(expression) && !onChain(chainPathOf(expression))) return true;
    const path = chainPathOf(expression);
    return typeof path === "string" && !onChain(path) && holdsCopy(path);
  };
  const addCopy = (name, initializer) => {
    const inner = unwrapExpression(initializer);
    if (inner === undefined) return;
    if (isCopySource(inner)) {
      copies.add(name);
      return;
    }
    // A local function that returns an object literal hands back its properties
    // (`const make = () => ({ list: [...chain] }); const box = make();`).
    if (ts.isCallExpression(inner)) {
      const local = localFunctionOf(inner);
      if (local === undefined) return;
      for (const returned of returnExpressionsOf(local)) {
        const value = unwrapExpression(returned);
        if (value === undefined || !ts.isObjectLiteralExpression(value)) continue;
        for (const property of value.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
          addCopy(`${name}.${property.name.text}`, property.initializer);
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(inner)) {
      for (const property of inner.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
        addCopy(`${name}.${property.name.text}`, property.initializer);
      }
    }
  };
  for (let pass = 0; pass < 4; pass += 1) {
    const before = copies.size;
    walkTree(scope, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isIdentifier(node.name)) {
        addCopy(node.name.text, node.initializer);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrapExpression(node.left);
        const leftPath = left === undefined ? null : chainPathOf(left);
        if (leftPath !== null) addCopy(leftPath, node.right);
      }
    });
    if (copies.size === before) break;
  }
  // The copy itself is not the chain: a write to the copy's array (sort, push,
  // length) changes only the copy, so those keys stop naming the chain. Element
  // writes are still refused through isCopyElement (review
  // CF070-GATE-REMEDIATION-R9 MINOR-1).
  const shippedPath = chainPathOf(shipped);
  for (const name of copies) {
    if (name !== shippedPath) {
      keys.delete(name);
      // An array literal that spreads the chain registers an ``alias[]`` marker
      // as well as the name. A copy's array holds the same elements but is not
      // the chain, so replacing one of its slots touches only the copy
      // (review CF070-GATE-REMEDIATION-R11 MINOR-2).
      keys.delete(`${name}[]`);
    }
  }

  const holders = new Set();
  // The function a comparator identifier names, when that function is written
  // inside the helper. Its body is walked below, so registering its parameters as
  // holders both accepts a pure named comparator and catches a mutating one
  // (review CF070-GATE-REMEDIATION-R11 NIT-1). A comparator written outside the
  // helper is a body the scan cannot read.
  const comparatorFunction = (expression) => {
    const inner = unwrapExpression(expression);
    if (inner === undefined) return undefined;
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
    if (!ts.isIdentifier(inner)) return undefined;
    // A function declaration is hoisted, so a comparator written after its call
    // resolves even though the backwards binding walk has not seen it yet
    // (review R12 MINOR-1, farm H1).
    let hoisted;
    const visit = (node) => {
      if (hoisted !== undefined) return;
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === inner.text) {
        hoisted = node;
        return;
      }
      if (node !== scope && isFunctionLike(node)) return;
      ts.forEachChild(node, visit);
    };
    visit(scope);
    if (hoisted !== undefined) return hoisted;
    const declaration = nearestBindingOf(inner, inner.text);
    if (declaration === undefined || declaration === null) return undefined;
    if (declaration.pos < scope.pos || declaration.end > scope.end) return undefined;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const initializer = unwrapExpression(declaration.initializer);
      if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        return initializer;
      }
    }
    return undefined;
  };
  walkTree(scope, (node) => {
    if (ts.isForOfStatement(node)) {
      // `for (const list of [chain])` iterates over the chain itself, so the
      // loop name owns it; over a copy, it holds a shared element
      // (review R16D BLOCKER-2, N7-family).
      const ownsElements = elementsAreChain(node.expression, onChain);
      if (ownsElements || isCopyOfChain(node.expression)) {
        const list = node.initializer;
        if (ts.isVariableDeclarationList(list)) {
          for (const declaration of list.declarations) {
            for (const name of bindingNamesOf(declaration.name)) {
              if (ownsElements) keys.add(name);
              else holders.add(name);
            }
          }
        }
      }
    }
    if (!ts.isCallExpression(node)) return;
    const fromSource = arrayFromSource(node);
    if (fromSource !== undefined) {
      const ownsElements = elementsAreChain(fromSource, onChain);
      if (!ownsElements && !isCopyOfChain(fromSource)) return;
      const mapper = node.arguments[1] === undefined ? undefined : unwrapExpression(node.arguments[1]);
      if (mapper === undefined || (!ts.isArrowFunction(mapper) && !ts.isFunctionExpression(mapper))) return;
      const mapperParameter = mapper.parameters[0];
      if (mapperParameter === undefined) return;
      for (const name of bindingNamesOf(mapperParameter.name)) {
        if (ownsElements) keys.add(name);
        else holders.add(name);
      }
      return;
    }
    const callee = unwrapExpression(node.expression);
    if (callee === undefined || !ts.isPropertyAccessExpression(callee)) return;
    if (callee.name.text === "sort" || callee.name.text === "toSorted") {
      if (!isCopyOfChain(callee.expression)) return;
      const comparator = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0]);
      if (comparator === undefined) return;
      const comparatorBody = comparatorFunction(comparator);
      if (comparatorBody === undefined) return;
      for (const parameter of comparatorBody.parameters) {
        for (const name of bindingNamesOf(parameter.name)) holders.add(name);
      }
      return;
    }
    // A receiver whose ELEMENTS are the chain hands the chain itself to the
    // callback, not a shared record: `[chain].map((list) => { list.length = 0 })`
    // must be refused as a write to the chain
    // (review CF070-GATE-REMEDIATION-R16D BLOCKER-2, N7/N14/N15).
    const ownsElements = elementsAreChain(callee.expression, onChain);
    if (!ELEMENT_ITERATION_METHODS.has(callee.name.text)) return;
    if (!ownsElements && !isCopyOfChain(callee.expression)) return;
    const callback = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0]);
    if (callback === undefined || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    const bindParameter = (parameter) => {
      for (const name of bindingNamesOf(parameter.name)) {
        // The parameter holds the chain only until the callback rebinds it to a
        // fresh value: `(list) => { list = []; list.push(...) }` never writes
        // the shipped array (review CF070-GATE-REMEDIATION-R16E MINOR-1). A
        // rebind to a shallow copy keeps the element objects, so the parameter
        // joins the copy rules instead of owning the chain
        // (review CF070-GATE-REMEDIATION-R16F BLOCKER-4).
        if (!ownsElements) holders.add(name);
        else {
          const kind = rebindKindBeforeUse(callback, name, onChain);
          if (kind === "copy") copies.add(name);
          else if (kind !== "fresh") keys.add(name);
        }
      }
    };
    // `reduce` hands the accumulator first and the element second; without an
    // initial value the accumulator *is* the first element.
    if (callee.name.text === "reduce" || callee.name.text === "reduceRight") {
      const indices = node.arguments.length === 1 ? [0, 1] : [1];
      for (const index of indices) {
        const parameter = callback.parameters[index];
        if (parameter !== undefined) bindParameter(parameter);
      }
      return;
    }
    // A comparator receives two elements.
    if (callee.name.text === "sort" || callee.name.text === "toSorted") {
      for (const parameter of callback.parameters) bindParameter(parameter);
      return;
    }
    const parameter = callback.parameters[0];
    if (parameter === undefined) return;
    bindParameter(parameter);
  });
  // An expression that *reads an element* of the chain or of a copy hands out the
  // shared record: `list[0]`, `list.at(-1)`, `list.find(…)`, `list.pop()`, and a
  // destructuring of the list. Binding one (`const first = list[0]`) makes the
  // binding an element too (review CF070-GATE-REMEDIATION-R10 MAJOR-1).
  // A function declaration (not a const) so the copy classifiers defined above
  // can call it before its textual definition; see carriesElement.

  // A name bound to an absent value (`const MISSING = null`) denotes the same
  // value as the literal, so a `return MISSING` is neutral wherever `return null`
  // would be. A name is neutral only when every binding of it in the helper is
  // neutral: one parameter, assignment, or non-neutral declaration disqualifies it.
  const neutralNames = new Set();
  // Neutrality is decided on the value, not its spelling: `void 0`,
  // `(0, undefined)` and an alias of a null/undefined constant all denote the
  // absent value the literals denote (review R15 BLOCKER-3).
  function isNeutralValue(value) {
    const candidate = unwrapExpression(value);
    if (candidate === undefined) return false;
    if (candidate.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isVoidExpression(candidate)) return true;
    if (ts.isIdentifier(candidate)) {
      return candidate.text === "undefined" || neutralNames.has(candidate.text);
    }
    if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return isNeutralValue(candidate.right);
    }
    return false;
  }
  {
    const candidates = [];
    const notNeutral = new Set();
    walkTree(scope, (node) => {
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
          candidates.push({ name: node.name.text, initializer: node.initializer });
        } else {
          for (const name of bindingNamesOf(node.name)) notNeutral.add(name);
        }
        return;
      }
      if (ts.isParameter(node)) {
        for (const name of bindingNamesOf(node.name)) notNeutral.add(name);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        for (const name of bindingNamesOf(node.left)) notNeutral.add(name);
        return;
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        ts.isIdentifier(node.operand)
      ) {
        notNeutral.add(node.operand.text);
      }
    });
    for (let pass = 0; pass < 3; pass += 1) {
      let changed = false;
      for (const { name, initializer } of candidates) {
        if (!neutralNames.has(name) && isNeutralValue(initializer)) {
          neutralNames.add(name);
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const name of notNeutral) neutralNames.delete(name);
  }

  // A name bound to an element is the element (review R16 BLOCKER-1):
  // `const first = built.suggestions[0]; return first;` used to be invisible to
  // both `mayYieldElement` and the write scan, so an accessor could return the
  // record through a local name and the caller could then write it.
  const resolvingElementIdentifiers = new Set();

  // The value a name was last assigned before a point in the helper
  // (`let x; x = copy.at(0);`). A declaration initializer alone is not enough:
  // the record can arrive by assignment, and `isElementRead` then resolved the
  // name to the *declaration's* value (`null`), so the accessor was not an
  // element source and the caller's write shipped (review R16B BLOCKER-1, K3).
  const assignmentValueBefore = (identifier) => {
    let best;
    walkTree(scope, (node) => {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const left = unwrapExpression(node.left);
      if (left === undefined || !ts.isIdentifier(left) || left.text !== identifier.text) return;
      if (node.pos >= identifier.pos) return;
      if (best === undefined || node.pos > best.pos) best = node;
    });
    return best === undefined ? undefined : best.right;
  };

  const elementInitializerOf = (identifier) => {
    const declaration = nearestBindingOf(identifier, identifier.text);
    // Assignment form wins when it happens before the read: it is the last value
    // written into the name, and it is therefore what the read actually sees.
    const assigned = assignmentValueBefore(identifier);
    if (assigned !== undefined) {
      if (declaration === undefined || declaration === null) return assigned;
      if (ts.isVariableDeclaration(declaration) && declaration.pos <= assigned.pos) return assigned;
    }
    if (declaration === undefined || declaration === null) return undefined;
    if (ts.isVariableDeclaration(declaration)) return declaration.initializer;
    // A parameter default is a binding initializer too:
    // `const get = (x = chain[0]) => x` hands out the element (R16B L3).
    if (ts.isParameter(declaration)) return declaration.initializer;
    return undefined;
  };

  // The object literal a name was bound to, when it was bound to one
  // (`const box = { first }; box.first`). A property read whose base names a
  // literal is the same value as the literal's property (R16B L2).
  const objectLiteralBoundTo = (expression) => {
    const inner = unwrapExpression(expression);
    if (inner === undefined) return undefined;
    if (ts.isObjectLiteralExpression(inner)) return inner;
    if (!ts.isIdentifier(inner)) return undefined;
    const initializer = elementInitializerOf(inner);
    if (initializer === undefined) return undefined;
    if (resolvingElementIdentifiers.has(initializer)) return undefined;
    resolvingElementIdentifiers.add(initializer);
    const resolved = objectLiteralBoundTo(initializer);
    resolvingElementIdentifiers.delete(initializer);
    return resolved;
  };


  // A container that *carries* an element hands that element out by index or
  // property: `[first][0]`, `{ s: first }.s`, and the same through a name bound
  // to such a literal (review R16 BLOCKER-1, G4/G5).
  const carriesElement = (expression) => {
    const inner = unwrapExpression(expression);
    if (inner === undefined) return false;
    if (ts.isArrayLiteralExpression(inner)) {
      return inner.elements.some((element) =>
        isElementRead(ts.isSpreadElement(element) ? element.expression : element),
      );
    }
    if (ts.isObjectLiteralExpression(inner)) {
      return inner.properties.some((property) => {
        if (ts.isSpreadAssignment(property)) return isElementRead(property.expression);
        if (ts.isShorthandPropertyAssignment(property)) return isElementRead(property.name);
        return ts.isPropertyAssignment(property) ? isElementRead(property.initializer) : false;
      });
    }
    if (ts.isIdentifier(inner)) {
      const initializer = elementInitializerOf(inner);
      if (initializer === undefined) return false;
      if (resolvingElementIdentifiers.has(initializer)) return false;
      resolvingElementIdentifiers.add(initializer);
      const resolved = carriesElement(initializer);
      resolvingElementIdentifiers.delete(initializer);
      return resolved;
    }
    return false;
  };

  function isElementRead(expression) {
    const inner = unwrapExpression(expression);
    if (inner === undefined) return false;
    if (ts.isIdentifier(inner)) {
      // The holder pass already knows the names that receive an element (a
      // `for … of` head, an iteration callback's parameter, a comparator's
      // argument). `isElementRead` never consulted it, so an accessor returning
      // such a name was not an element source at all and the caller's write
      // shipped (review R16B BLOCKER-1, K3).
      if (holders.has(inner.text)) return true;
      const initializer = elementInitializerOf(inner);
      if (initializer === undefined) return false;
      if (resolvingElementIdentifiers.has(initializer)) return false;
      resolvingElementIdentifiers.add(initializer);
      const resolved = isElementRead(initializer);
      resolvingElementIdentifiers.delete(initializer);
      return resolved;
    }
    if (ts.isElementAccessExpression(inner)) {
      if (isCopyOfChain(inner.expression) || carriesElement(inner.expression)) return true;
    }
    // `cond ? chain[0] : chain[1]` and `chain[0] ?? fallback` may yield an element.
    if (ts.isConditionalExpression(inner)) return isElementRead(inner.whenTrue) || isElementRead(inner.whenFalse);
    if (
      ts.isBinaryExpression(inner) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]
        .includes(inner.operatorToken.kind)
    ) {
      return isElementRead(inner.left) || isElementRead(inner.right);
    }
    // A fresh object literal that carries an element is a holder of that element
    // (`const pick = () => ({ first: chain[0] })`; review R13 MAJOR-1).
    if (ts.isObjectLiteralExpression(inner)) {
      return inner.properties.some((property) => {
        if (ts.isPropertyAssignment(property)) return isElementRead(property.initializer);
        // `const box = { first }` is the same holder as `{ first: first }`
        // (review R16 BLOCKER-1).
        if (ts.isShorthandPropertyAssignment(property)) return isElementRead(property.name);
        return false;
      });
    }
    // A property of a fresh object literal is the value written there, so
    // `{ s: copy.at(0) }.s` is the element (review R13 NIT-2). The base may also
    // be a *name bound to* such a literal: `const t = { first }; t.first`
    // (review R16B BLOCKER-1, L2).
    if (ts.isPropertyAccessExpression(inner)) {
      const base = objectLiteralBoundTo(inner.expression);
      if (base !== undefined) {
        for (const property of base.properties) {
          const name = ts.isShorthandPropertyAssignment(property)
            ? property.name.text
            : ts.isPropertyAssignment(property)
              ? propertyNameOf(property.name)
              : null;
          if (name === null || name !== inner.name.text) continue;
          const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          if (isElementRead(value)) return true;
        }
      }
    }
    if (ts.isCallExpression(inner)) {
      const callee = unwrapExpression(inner.expression);
      if (callee !== undefined && ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (
          (method === "at" || method === "find" || method === "findLast" || method === "pop" || method === "shift") &&
          isCopyOfChain(callee.expression)
        ) {
          return true;
        }
      }
      // `copy.reduce((a, b) => b)` yields an element; a reducer that returns
      // anything else (an accumulator sum, a field) does not (review R13 MAJOR-1).
      if (
        callee !== undefined &&
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === "reduce" || callee.name.text === "reduceRight") &&
        isCopyOfChain(callee.expression) &&
        inner.arguments[0] !== undefined
      ) {
        const reducer = unwrapExpression(inner.arguments[0]);
        if (reducer !== undefined && (ts.isArrowFunction(reducer) || ts.isFunctionExpression(reducer))) {
          const parameters = new Set(reducer.parameters.flatMap((parameter) => bindingNamesOf(parameter.name)));
          const returnsParameter = (value) => {
            const candidate = unwrapExpression(value);
            if (candidate === undefined) return false;
            if (ts.isIdentifier(candidate)) return parameters.has(candidate.text);
            if (ts.isConditionalExpression(candidate)) {
              return returnsParameter(candidate.whenTrue) && returnsParameter(candidate.whenFalse);
            }
            if (
              ts.isBinaryExpression(candidate) &&
              [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]
                .includes(candidate.operatorToken.kind)
            ) {
              return returnsParameter(candidate.left) && returnsParameter(candidate.right);
            }
            return false;
          };
          const returned = returnExpressionsOf(reducer);
          if (returned.length > 0 && returned.every(returnsParameter)) {
            return true;
          }
        }
      }
      // A local function (or an immediately-invoked one) whose every return is
      // an element read yields an element
      // (`const findBy = (f) => built.suggestions.find(…)`). Symmetric with the
      // local-function rule for copies (review R13 MAJOR-1).
      const local = localFunctionOf(inner);
      if (local !== undefined) {
        // A recursive accessor (`n > 0 ? head(n - 1) : chain[0]`) is resolved
        // co-inductively: while its own body is being classified, its recursive
        // call is assumed to yield the element it is being checked for.
        if (resolvingElements.has(local)) return true;
        resolvingElements.add(local);
        const returned = returnExpressionsOf(local);
        // One union rule, the same rule `isElementRead` applies to a direct
        // expression: a return that *may* be the element makes the function an
        // element source. A mixed branch therefore still protects the element
        // (`f ? chain[0] : "none"`, `f ?? chain[0]`, `f && chain[0]`, and the
        // reversed conditional), because a branch that cannot be the element never
        // cancels the one that may be (review R15 BLOCKER-2). Neutrality is
        // decided on the value (`void 0`, `(0, undefined)`, a null/undefined
        // alias) rather than its spelling (review R15 BLOCKER-3).
        const mayYieldElement = (value) => {
          const candidate = unwrapExpression(value);
          if (candidate === undefined || isNeutralValue(candidate)) return false;
          if (ts.isConditionalExpression(candidate)) {
            return mayYieldElement(candidate.whenTrue) || mayYieldElement(candidate.whenFalse);
          }
          if (ts.isBinaryExpression(candidate)) {
            const operator = candidate.operatorToken.kind;
            if (operator === ts.SyntaxKind.CommaToken) return mayYieldElement(candidate.right);
            if (
              operator === ts.SyntaxKind.QuestionQuestionToken ||
              operator === ts.SyntaxKind.BarBarToken ||
              operator === ts.SyntaxKind.AmpersandAmpersandToken
            ) {
              return mayYieldElement(candidate.left) || mayYieldElement(candidate.right);
            }
          }
          return isElementRead(candidate);
        };
        const readsElement = returned.some(mayYieldElement);
        resolvingElements.delete(local);
        return readsElement;
      }
    }
    return false;
  }
  // A write whose target is a *property of a shared element* reaches a reviewed
  // record even when the element was reached through a method result
  // (`copy.at(-1)!.field`, `copy.slice(1)[0].field`, `copy.filter(…)[0].field`).
  // Replacing a copy's slot (`copy[0] = …`) is not such a write: the written
  // property is on the copy array itself (review CF070-GATE-REMEDIATION-R12 MAJOR-1).
  const sharedElementWriteTarget = (target) => {
    const inner = unwrapExpression(target);
    if (inner === undefined) return false;
    if (!ts.isPropertyAccessExpression(inner) && !ts.isElementAccessExpression(inner)) return false;
    let container = unwrapExpression(inner.expression);
    while (container !== undefined) {
      if (isElementRead(container)) return true;
      if (ts.isPropertyAccessExpression(container) || ts.isElementAccessExpression(container)) {
        container = unwrapExpression(container.expression);
        continue;
      }
      if (ts.isNonNullExpression(container) || ts.isParenthesizedExpression(container)) {
        container = unwrapExpression(container.expression);
        continue;
      }
      break;
    }
    return false;
  };
  // The helper body is the only block a fresh local can shadow a holder from;
  // `bindingScopeOf` decides whether a given declaration binds there.
  const helperBody = ts.isBlock(scope.body) ? scope.body : undefined;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = holders.size;
    walkTree(scope, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const path = chainPathOf(node.initializer);
        if (ts.isIdentifier(node.name)) {
          const elementDerived =
            isElementRead(node.initializer) ||
            (path !== null &&
              [...holders].some((name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`)));
          if (elementDerived) {
            holders.add(node.name.text);
            // An object literal that boxes an element keeps it under its property
            // (`const box = { s: copy.at(0) }`; review R13 MAJOR-1).
            const initializer = unwrapExpression(node.initializer);
            if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) {
              for (const property of initializer.properties) {
                if (!ts.isPropertyAssignment(property)) continue;
                const propertyName = propertyNameOf(property.name);
                if (propertyName !== null && isElementRead(property.initializer)) {
                  holders.add(`${node.name.text}.${propertyName}`);
                }
              }
            }
          } else {
            // A fresh local of this name shadows a callback parameter or holder of
            // the same name (`forEach((s) => …); const s = { … }`; review R13 NIT-1).
            // Only a declaration whose own scope *is* the helper body may shadow:
            // a nested block's local (`{ const s = 5; } s.field = …`) ends with its
            // block (r14c Y1–Y5), and a loop-head `let`/`const` is scoped to the
            // loop, so the helper-level holder is still live after it (review R15
            // BLOCKER-1). `var` is function-scoped and does shadow the body.
            if (helperBody !== undefined && bindingScopeOf(node) === helperBody) {
              holders.delete(node.name.text);
            }
          }
          return;
        }
        // `const [head] = list` / `const { 0: first } = list` bind elements.
        if (isCopyOfChain(node.initializer)) {
          for (const name of bindingNamesOf(node.name)) holders.add(name);
        }
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isCopyOfChain(node.right)) {
          for (const name of bindingNamesOf(node.left)) {
            // A copy *container* is tracked by the copy rules, which catch writes
            // to its elements and accept writes to its own array (`list = [...list];
            // list.length = 0`). Marking it a holder too would refuse that safe
            // array write (review R16F BLOCKER-4 fix-forward).
            if (!copies.has(name)) holders.add(name);
          }
        }
        // `acc = s` rebinds the accumulator to an element.
        const path = chainPathOf(node.right);
        if (
          typeof path === "string" &&
          [...holders].some((name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`))
        ) {
          for (const name of bindingNamesOf(node.left)) holders.add(name);
        }
      }
    });
    if (holders.size === before) break;
  }
  const writesHolder = (path) =>
    typeof path === "string" &&
    [...holders].some((name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`));
  // A path *below* an element (`a.suggestedValue`, `copy[0].field`) names a
  // property of the record, not the record. A call on it cannot reach the element
  // itself; only an in-place array method can change a nested array it reaches
  // (review CF070-GATE-REMEDIATION-R11 MINOR-1).
  const belowElement = (path) => {
    if (typeof path !== "string") return false;
    return [...holders, ...copies].some((name) => {
      if (path === name) return false;
      if (path.startsWith(`${name}.`)) return path.length > name.length + 1;
      if (!path.startsWith(`${name}[`)) return false;
      const close = path.indexOf("]", name.length);
      return close !== -1 && close + 1 < path.length;
    });
  };

  let mutated = false;
  walkTree(scope, (node) => {
    if (mutated) return;
    if (ts.isDeleteExpression(node)) {
      const path = chainPathOf(node.expression);
      if (onChain(path) || writesHolder(path) || isCopyElement(path) || sharedElementWriteTarget(node.expression)) {
        mutated = true;
      }
      return;
    }
    if (writesThroughAssignment(node)) {
      const target = unwrapExpression(ts.isBinaryExpression(node) ? node.left : node.operand);
      if (target === undefined) return;
      const path = chainPathOf(target);
      // A holder may receive another holder through a plain `=` — the same rule the
      // callback contract applies (`let copy = s; copy = s; return copy;`), which
      // does not change the record.
      if (ts.isIdentifier(target) && holders.has(target.text) && ts.isBinaryExpression(node)) {
        // Rebinding an element holder to another element read is a local rename,
        // not a write to the record (`let best = list[0]; best = list[i]`).
        if (isElementRead(node.right)) return;
        const valuePath = chainPathOf(node.right);
        if (
          valuePath !== null &&
          [...holders].some(
            (name) => valuePath === name || valuePath.startsWith(`${name}.`) || valuePath.startsWith(`${name}[`),
          )
        ) return;
      }
      // A write to the shipped chain or a part of it changes what ships. A write
      // to a binding that merely *holds* the chain (`built = build…(fields)`) is
      // read by the derivation rules instead. A property written on a function
      // that returns the chain is a write to the chain itself
      // (`get().length = 0`, review R16 BLOCKER-2).
      const chainYieldTarget =
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        (() => {
          const base = unwrapExpression(target.expression);
          return base !== undefined && expressionYieldsChain(base, onChain);
        })();
      if (
        onChain(path) ||
        writesHolder(path) ||
        isCopyElement(path) ||
        chainYieldTarget ||
        sharedElementWriteTarget(target)
      ) {
        mutated = true;
      }
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const templateHolds = (path) => onChain(path) || underChain(path) || writesHolder(path);
      if (node.template.templateSpans.some((span) => expressionHoldsChain(span.expression, templateHolds))) {
        mutated = true;
      }
      return;
    }
    if (ts.isNewExpression(node)) {
      // A constructed object can keep the reference and write it later; the
      // constructor's body is not read.
      const constructorHolds = (path) =>
        onChain(path) || underChain(path) || writesHolder(path) || copySlot(path) || holdsCopy(path);
      for (const argument of node.arguments ?? []) {
        if (expressionHoldsChain(argument, constructorHolds)) mutated = true;
      }
      return;
    }
    if (!ts.isCallExpression(node)) return;
    {
      const fromSource = arrayFromSource(node);
      const mapper = node.arguments[1] === undefined ? undefined : unwrapExpression(node.arguments[1]);
      if (
        fromSource !== undefined &&
        mapper !== undefined &&
        !ts.isArrowFunction(mapper) &&
        !ts.isFunctionExpression(mapper) &&
        isCopyOfChain(fromSource)
      ) {
        // `Array.from(chain, mapWith)` hands every element to a body that is not
        // read (review CF070-GATE-REMEDIATION-R8 MAJOR-1).
        mutated = true;
        return;
      }
    }
    // Any argument that is the chain (or an object that holds it) is a call the
    // scan cannot read; the callee may keep the reference and write it later.
    // Passing the chain to a call whose body is not read can hand it to a
    // mutator. Two call shapes are exempt because their effect on the argument is
    // known: a copy (`concat`, `slice`, `join`, `Array.from`) and
    // `Object.assign({ …spreads }, source)` with a fresh inline target, which the
    // callback contract already accepts for the element.
    const calleeForArgs = unwrapExpression(node.expression);
    const copyMethod = calleeForArgs !== undefined &&
      (ts.isPropertyAccessExpression(calleeForArgs) || ts.isElementAccessExpression(calleeForArgs))
      ? memberAccessName(calleeForArgs)
      : null;
    // The exemption is only safe when the receiver is known to be an array: a
    // custom `parts.slice(chain)` may do anything with its argument (review
    // CF070-GATE-REMEDIATION-R8 MAJOR-1, T4/T6).
    const receiverForArgs = calleeForArgs !== undefined &&
      (ts.isPropertyAccessExpression(calleeForArgs) || ts.isElementAccessExpression(calleeForArgs))
      ? unwrapExpression(calleeForArgs.expression)
      : undefined;
    const knownArrayReceiver = receiverForArgs !== undefined && (
      ts.isArrayLiteralExpression(receiverForArgs) ||
      onChain(chainPathOf(receiverForArgs)) ||
      (ts.isIdentifier(receiverForArgs) && receiverForArgs.text === 'Array')
    );
    const safeCopy = copyMethod !== null && SAFE_ARGUMENT_METHODS.has(copyMethod) && knownArrayReceiver;
    // The primitive-method exemption applies only to a receiver that is a
    // property below an element; a custom `slice`/`concat` receiving the chain
    // through the helper itself stays refused (R9-8, R9-9).
    const argumentReceiverPath = receiverForArgs === undefined ? null : chainPathOf(receiverForArgs);
    const safePrimitive = copyMethod !== null && PRIMITIVE_METHODS.has(copyMethod) && belowElement(argumentReceiverPath);
    const freshAssign = objectStaticCallName(node) === "assign" && node.arguments[0] !== undefined &&
      (() => {
        const target = unwrapExpression(node.arguments[0]);
        return target !== undefined && ts.isObjectLiteralExpression(target) &&
          target.properties.every((property) => ts.isSpreadAssignment(property));
      })();
    // Callees that provably neither keep nor change their arguments.
    const nonRetainingCallee = (() => {
      if (calleeForArgs === undefined || !ts.isPropertyAccessExpression(calleeForArgs)) return false;
      if (!ts.isIdentifier(calleeForArgs.expression)) return false;
      const root = calleeForArgs.expression.text;
      const name = calleeForArgs.name.text;
      if (root === "JSON" && name === "stringify") return true;
      if (root === "Object" && ["keys", "values", "entries"].includes(name)) return node.arguments.length >= 1;
      return root === "console" && ["log", "info", "warn", "error", "debug"].includes(name);
    })();
    if (!safeCopy && !freshAssign && !safePrimitive && !nonRetainingCallee) {
      // A copy is the same element objects in a new array: handing the copy
      // itself to a callee the scan cannot read lets it keep and write those
      // records (`store.set("list", [...chain]); store.get("list")[0].x = …`),
      // exactly as handing the chain does (review farm M4, R11 fix-forward).
      const holds = (path) =>
        onChain(path) || underChain(path) || writesHolder(path) || copySlot(path) || holdsCopy(path);
      for (const argument of node.arguments) {
        if (expressionHoldsChain(argument, holds)) {
          mutated = true;
          return;
        }
      }
    }
    const callee = unwrapExpression(node.expression);
    if (callee === undefined) return;
    const method = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
      ? memberAccessName(callee)
      : null;
    const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
      ? unwrapExpression(callee.expression)
      : undefined;
    const receiverPath = receiver === undefined ? null : chainPathOf(receiver);
    // A fresh container the chain only flowed into (`chain.slice()`, `chain.map(…)`,
    // `[...chain]`) is not the shipped value: an in-place array method reorders or
    // refills that copy's own slots without touching a reviewed record, so it is an
    // ordinary read-only form (`chain.slice().sort(by)`, `chain.slice().reverse()`).
    // A direct receiver — `built.suggestions` itself, or a binding of it — is still
    // the chain and is still refused (review R15 MAJOR-1).
    const freshReceiver = receiver !== undefined && (() => {
      const inner = unwrapExpression(receiver);
      if (inner === undefined) return false;
      if (!ts.isArrayLiteralExpression(inner) && !ts.isCallExpression(inner)) return false;
      // A function that returns the chain hands back the same array, not a fresh
      // one; `get().sort(by)` must stay refused (review R16 BLOCKER-2).
      if (expressionYieldsChain(inner, onChain)) return false;
      return isCopyOfChain(inner);
    })();
    if (
      method !== null &&
      (onChain(receiverPath) ||
        writesHolder(receiverPath) ||
        copySlot(receiverPath) ||
        // A function that returns the chain is the chain: `get().splice(0, 1)`
        // (review R16 BLOCKER-2).
        (receiver !== undefined && expressionYieldsChain(receiver, onChain)))
    ) {
      if (IN_PLACE_ARRAY_METHODS.has(method)) {
        if (!freshReceiver) {
          mutated = true;
          return;
        }
      } else if (!NON_MUTATING_ARRAY_METHODS.has(method) && !(belowElement(receiverPath) && PRIMITIVE_METHODS.has(method))) {
        mutated = true;
        return;
      }
    }
    // A copy's own receiver (`copy.sort(by)`) is not a chain path, so these two
    // guards must not be nested inside the receiver-identity branch above
    // (review CF070-GATE-REMEDIATION-R12 MINOR-1).
    const calleeIsCopy = isCopyOfChain(unwrapExpression(callee.expression));
    if ((method === "sort" || method === "toSorted") && calleeIsCopy) {
      const comparator = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0]);
      if (comparator !== undefined && comparatorFunction(comparator) === undefined) {
        mutated = true;
        return;
      }
    }
    // An iteration callback the scan cannot see (`chain.forEach(clamp)`) can
    // change every element it is handed; the callee's body is not read
    // (review CF070-GATE-REMEDIATION-R6 MAJOR-1). Inline functions are covered
    // by the holder rule instead.
    if (method !== null && ELEMENT_ITERATION_METHODS.has(method) && calleeIsCopy) {
      const callback = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0]);
      if (callback === undefined || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
        mutated = true;
        return;
      }
    }
    if (objectStaticCallName(node) === "assign") {
      const target = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0]);
      const path = target === undefined ? null : chainPathOf(target);
      // Assigning onto the shipped value, or onto the object that holds it
      // (`Object.assign(built, { suggestions: [] })`), replaces what the payload
      // reads.
      if (onChain(path) || underChain(path) || writesHolder(path)) mutated = true;
    }
  });
  return mutated;
}

/**
 * The writes to `name` on the binding a spread names, when the spread is a bare
 * identifier (`{ ...extra }` where `extra.suggestions = []`). The spread copies
 * what the binding holds when it runs, so those writes — not the literal it was
 * declared with — decide the value (review CF070-GATE-REMEDIATION-R2 MINOR-3).
 */
function spreadPropertyWrites(scope, expression, name) {
  const inner = unwrapExpression(expression);
  if (inner === undefined || !ts.isIdentifier(inner)) return [];
  return bindingPropertyWrites(scope, inner.text, name);
}

/**
 * The object literal an expression evaluates to, directly or through a local binding.
 */
function resolveObjectLiteral(scope, expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return undefined;
  if (ts.isObjectLiteralExpression(inner)) return inner;
  if (!ts.isIdentifier(inner)) return undefined;
  const initializer = initializerOf(scope, inner, inner.text);
  if (initializer === undefined) return undefined;
  const resolved = unwrapExpression(initializer);
  return resolved !== undefined && ts.isObjectLiteralExpression(resolved) ? resolved : undefined;
}

/**
 * The object literal an expression's value *is*, following the shapes the payload
 * walk already reads: a literal, a binding holding one, the merge
 * `Object.assign` performs, and the object `Object.freeze` hands back
 * (`value: Object.assign({ suggestions: [] }, built, …)` hands the reviewed list
 * over and was refused only because the reader stopped at the call, review
 * CF070-GATE-REMEDIATION MINOR-2).
 */
function objectLiteralValueOf(scope, expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return undefined;
  if (ts.isObjectLiteralExpression(inner)) return inner;
  if (ts.isCallExpression(inner)) {
    const objectStatic = objectStaticCallName(inner);
    if (objectStatic === "assign") return mergedObjectLiteral(inner.arguments);
    if (objectStatic === "freeze" && inner.arguments.length === 1) {
      return objectLiteralValueOf(scope, inner.arguments[0]);
    }
  }
  return resolveObjectLiteral(scope, inner);
}

/**
 * The value an object literal gives a property, read the way the runtime reads
 * it: its properties in source order, the last writer of the name winning. A
 * later spread therefore overrides an earlier own property
 * (`{ suggestions: [], ...built }` hands back the reviewed list), which reading
 * every own property before any spread got backwards (CF-070 R2 retry-9 NIT-6).
 * A spread the gate cannot read may carry the property or override it, so it
 * clears whatever the earlier writer gave — the read cannot say which value runs
 * (review CF070-GATE-REMEDIATION NIT-6 residual). Whether a spread carries the
 * reviewed value is decided by `payloadPropertyDerives`.
 */
function payloadPropertyOf(scope, objectLiteral, name) {
  let answer;
  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property)) {
      if (propertyNameOf(property.name) === name) answer = unwrapExpression(property.initializer);
      continue;
    }
    if (!ts.isSpreadAssignment(property)) continue;
    const spreadWrites = spreadPropertyWrites(scope, property.expression, name);
    if (spreadWrites.length > 0) {
      answer = spreadWrites[spreadWrites.length - 1];
      continue;
    }
    const spread = resolveObjectLiteral(scope, property.expression);
    if (spread === undefined) {
      answer = undefined;
      continue;
    }
    const value = payloadPropertyOf(scope, spread, name);
    if (value !== undefined) answer = value;
  }
  return answer;
}

/**
 * Whether an object literal's property `name` carries the reviewed value,
 * decided the same way in source order. An own property decides by its value; a
 * spread decides by the literal it resolves to, or — where that literal cannot
 * be read but the spread expression itself derives from the reviewed result — by
 * the reviewed value it copies (`{ ...built, action }`, retry-9 P-2). A spread
 * that can be neither read nor derived clears the answer for the same reason it
 * does in `payloadPropertyOf`. Returns undefined when the literal does not give
 * the property, or when no reader can say which value wins.
 */
function payloadPropertyDerives(scope, objectLiteral, name, names, seen) {
  let answer;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadWrites = spreadPropertyWrites(scope, property.expression, name);
      if (spreadWrites.length > 0) {
        // The spread copies what the binding holds when it runs, so the writes
        // decide, not the literal it was declared with
        // (`const extra = { suggestions: built.suggestions };
        // extra.suggestions = [];`, review CF070-GATE-REMEDIATION-R2 MINOR-3).
        answer = spreadWrites.every((write) => derivesFromReviewed(scope, write, names, seen));
        continue;
      }
      const spread = resolveObjectLiteral(scope, property.expression);
      if (spread !== undefined) {
        const inner = payloadPropertyDerives(scope, spread, name, names, seen);
        if (inner !== undefined) answer = inner;
        continue;
      }
      if (
        derivesFromReviewed(scope, property.expression, names, seen) ||
        readsReviewedValue(scope, property.expression, names)
      ) {
        answer = true;
        continue;
      }
      answer = undefined;
      continue;
    }
    if (ts.isPropertyAssignment(property) && propertyNameOf(property.name) === name) {
      answer = derivesFromReviewed(scope, property.initializer, names, seen);
    }
  }
  return answer;
}

/**
 * The values assigned to `binding.property` anywhere in `scope`. A write after
 * the copy changes what the read hands back — `const shipped = { ...built };
 * shipped.suggestions = [];` ships the empty list — so the read is worth the
 * writes, never the literal alone (CF-070 R2 retry-9 C).
 */
function bindingPropertyWrites(scope, binding, property) {
  const writes = [];
  walkTree(scope, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const target = unwrapExpression(node.left);
    if (target === undefined || !ts.isPropertyAccessExpression(target)) return;
    if (target.name.text !== property) return;
    if (!ts.isIdentifier(target.expression) || target.expression.text !== binding) return;
    const value = unwrapExpression(node.right);
    if (value !== undefined) writes.push(value);
  });
  return writes;
}

/**
 * True when an expression's *value* derives from one of `names`: the reviewed
 * value itself, a copy that keeps every element exactly once (`[ ...reviewed ]`,
 * `<reviewed>.slice()`, `Array.from(<reviewed>)`, `[].concat(<reviewed>)`, a
 * `map` that hands its element back on every return path), a spread of it
 * (`{ ...built }`), or an alias that holds one. An independent literal is not
 * derived, and neither is a call that narrows, empties, duplicates or transforms
 * the reviewed list (`.filter`, a narrowing `.slice`, `a.concat(a)`, a `map`
 * whose callback builds or swaps another value): a payload that replaces the
 * reviewed suggestions with another value is fabrication, not consumption
 * (CF-070 R2 retry-9 C6, D2-D4; review CF070-GATE-REMEDIATION NIT-8).
 */
function derivesFromReviewed(scope, expression, names, seen) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isSpreadElement(inner)) return derivesFromReviewed(scope, inner.expression, names, seen);
  if (ts.isArrayLiteralExpression(inner)) {
    // Exactly one element carries the reviewed list and every other element adds
    // nothing whatever (`[ ...reviewed ]`, `[ ...reviewed, ...[] ]`); a second
    // carrier would hand every reviewed element back twice, which no copy of the
    // reviewed list does (`[ ...a, ...a ]`, review CF070-GATE-REMEDIATION NIT-8).
    // The carrier must be spread: `[reviewed]` is a list holding the reviewed
    // list as its only element, which is a different shape (review
    // CF070-GATE-REMEDIATION-R5 MINOR-1).
    let carriers = 0;
    for (const element of inner.elements) {
      if (ts.isSpreadElement(element) && derivesFromReviewed(scope, element.expression, names, seen)) {
        carriers += 1;
        continue;
      }
      if (ts.isSpreadElement(element) && staticIterableLength(element.expression, scope) === 0) continue;
      return false;
    }
    return carriers === 1;
  }
  if (ts.isObjectLiteralExpression(inner)) {
    // A spread copies the reviewed value's own properties; a hand-written
    // property list that merely *reads* a reviewed field inside is a new object,
    // not the reviewed one (CF-070 R2 retry-9 D3).
    return inner.properties.some(
      (property) => ts.isSpreadAssignment(property) && derivesFromReviewed(scope, property.expression, names, seen),
    );
  }
  if (ts.isCallExpression(inner)) return callPreservesReviewed(scope, inner, names, seen);
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    const member = memberAccessName(inner);
    const receiver = unwrapExpression(inner.expression);
    if (member !== null && receiver !== undefined && ts.isIdentifier(receiver)) {
      const writes = bindingPropertyWrites(scope, receiver.text, member);
      if (writes.length > 0) return writes.every((write) => derivesFromReviewed(scope, write, names, seen));
      const valueWrites = writesForName(scope, receiver, receiver.text);
      if (valueWrites !== undefined) {
        // The binding holds what its writes gave it, so the property is asked of
        // each write's value instead of the declaration
        // (`built = buildReportFieldSuggestions(opResult.value.fields)` on a
        // second branch, review CF070-GATE-REMEDIATION-R2 MINOR-4).
        const guard = seen ?? new Set();
        if (guard.has(receiver.text)) return false;
        guard.add(receiver.text);
        const producer = initializerOf(scope, receiver, receiver.text);
        return valueWrites.every((write) => writeReadsReviewed(scope, write, names, guard, producer));
      }
    }
    if (member !== null) {
      const literal = resolveObjectLiteral(scope, inner.expression);
      if (literal !== undefined) {
        const derived = payloadPropertyDerives(scope, literal, member, names, seen);
        if (derived !== undefined) return derived;
      }
    }
    return accessChainRoot(inner) !== null && readsReviewedValue(scope, inner, names);
  }
  if (ts.isIdentifier(inner)) {
    if (names.has(inner.text)) return true;
    const guard = seen ?? new Set();
    if (guard.has(inner.text)) return false;
    guard.add(inner.text);
    // A written binding holds what its writes gave it, not what it was declared
    // with (review CF070-GATE-REMEDIATION MINOR-3c).
    const writes = writesForName(scope, inner, inner.text);
    if (writes !== undefined) {
      return writes.every((write) =>
        writeReadsReviewed(scope, write, names, guard, initializerOf(scope, inner, inner.text)),
      );
    }
    const initializer = initializerOf(scope, inner, inner.text);
    if (initializer === undefined) return false;
    return derivesFromReviewed(scope, initializer, names, guard);
  }
  return false;
}

/**
 * True when a call's value still carries the reviewed list: a copy that cannot
 * drop an element, or an element-wise `map` whose callback hands its own
 * parameter back. The old allowlist accepted a method by *name* alone, so
 * `map(() => ({}))` and `map((s) => ({ field: s.field, suggestedValue:
 * "REPLACED" }))` were read as copies; what matters is what the callee does
 * with the elements (CF-070 R2 retry-9 C).
 */
function callPreservesReviewed(scope, call, names, seen) {
  const callee = unwrapExpression(call.expression);
  if (callee === undefined || !ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (method === "from" && ts.isIdentifier(callee.expression) && callee.expression.text === "Array") {
    if (call.arguments.length === 1) return derivesFromReviewed(scope, call.arguments[0], names, seen);
    // `Array.from(<reviewed>, (s) => s)` maps each element to itself, which is
    // the copy the one-argument call already is (review CF070-GATE-REMEDIATION
    // MINOR-2).
    return (
      call.arguments.length === 2 &&
      derivesFromReviewed(scope, call.arguments[0], names, seen) &&
      callbackKeepsElement(call.arguments[1])
    );
  }
  if (method === "slice") {
    // `slice()` and `slice(undefined)` both start at index 0, so a start that
    // folds to 0 or to `undefined` is the same whole-list copy (review
    // CF070-GATE-REMEDIATION MINOR-2).
    const start = call.arguments[0] === undefined ? 0 : staticValue(call.arguments[0]);
    const startsAtZero = start === 0 || start === undefined;
    return call.arguments.length <= 1 && startsAtZero && derivesFromReviewed(scope, callee.expression, names, seen);
  }
  if (method === "concat") {
    // `[].concat(reviewed)` is a copy: exactly one operand carries the reviewed
    // list and every other operand adds nothing whatever. A second carrier would
    // hand every reviewed element back twice, which no copy of the reviewed list
    // does (`a.concat(a)`, review CF070-GATE-REMEDIATION NIT-8).
    const operands = [callee.expression, ...call.arguments];
    let carriers = 0;
    for (const operand of operands) {
      if (derivesFromReviewed(scope, operand, names, seen)) carriers += 1;
      else if (staticIterableLength(operand, scope) !== 0) return false;
    }
    return carriers === 1;
  }
  if (method === "map" || method === "flatMap") {
    // `flatMap` flattens one level, so its callback must hand back an array
    // holding the element exactly once (`(s) => [s]`, review
    // CF070-GATE-REMEDIATION MINOR-2).
    const keeps = method === "map" ? callbackKeepsElement : flatMapCallbackKeepsElement;
    return (
      call.arguments.length === 1 &&
      derivesFromReviewed(scope, callee.expression, names, seen) &&
      keeps(call.arguments[0], scope)
    );
  }
  return false;
}

/**
 * True when a `map` callback hands back the element it was given on *every* path
 * it can return through: the parameter itself, a local that holds it
 * (`const copy = s`), a literal that only spreads it, or — for a callback that
 * takes the element apart — a literal that puts back every name it took.
 *
 * Only the block's last statement was inspected before, so a callback that
 * fabricated on an early branch
 * (`if (s.field === "title") return { ...s, suggestedValue: "REPLACED" };
 * return s;`) read as a copy while the value it shipped was another one, and no
 * test in the mobile suite asserted the value (review CF070-GATE-REMEDIATION
 * MAJOR-1). A callback that builds an object from the element's fields
 * substitutes values the gate cannot read, so it is a transformation rather than
 * a copy (CF-070 R2 retry-9 C).
 */
function callbackKeepsElement(callback) {
  return callbackReturnsOnly(callback, (expression, holders, parts, rest) => {
    const value = unwrapExpression(expression);
    if (value === undefined) return false;
    if (holders !== null && spreadsNameOnly(value, holders, rest)) return true;
    return parts !== null && destructuredRoundTrip(parts, value);
  });
}

/**
 * True when a `flatMap` callback hands back an array holding the element exactly
 * once, possibly beside statically empty spreads (`(s) => [s]`,
 * `(s) => [s, ...[]]`), which flattens to the reviewed list itself. Any other
 * array — two entries, a rebuilt one, an unreadable extra — duplicates, drops or
 * replaces elements (review CF070-GATE-REMEDIATION MINOR-2).
 */
function flatMapCallbackKeepsElement(callback, scope) {
  return callbackReturnsOnly(callback, (expression, holders, _parts, rest) => {
    const value = unwrapExpression(expression);
    if (value === undefined || !ts.isArrayLiteralExpression(value)) return false;
    let carriers = 0;
    for (const element of value.elements) {
      if (!ts.isSpreadElement(element) && holders !== null && spreadsNameOnly(element, holders, rest)) {
        carriers += 1;
        continue;
      }
      if (ts.isSpreadElement(element) && staticIterableLength(element.expression, scope) === 0) continue;
      return false;
    }
    return carriers === 1;
  });
}

/**
 * True when every path a `map`-like callback can return through hands back a
 * value `keeps` accepts for the element it was given, **and** the callback leaves
 * that element alone.
 *
 * Three requirements, each closing a way a value other than the element could
 * ship:
 *
 * - **every** return of the callback is inspected, a return nested in a branch or
 *   a loop included (review CF070-GATE-REMEDIATION MAJOR-1);
 * - no path falls off the end of the body, where the call hands `undefined` on as
 *   the element (`(s) => { if (s.field === "title") return s; }`, review
 *   CF070-GATE-REMEDIATION-R2 MINOR-1) — the last statement must leave the body
 *   through every arm of it;
 * - the bounded effect contract below admits no write to an existing property,
 *   because a callback that
 *   *mutates* the element hands the same reference back holding another value
 *   (`(s) => { s.suggestedValue = "REPLACED"; return s; }`, review
 *   CF070-GATE-REMEDIATION-R2 MINOR-1). Unknown effects are refused; ordinary data
 *   and unmodified builtins are assumptions, not a claim of arbitrary-JS purity.
 *
 * Names are resolved by binding, not by text, so a name the callback re-declares
 * shadows the element rather than being read as it (review
 * CF070-GATE-REMEDIATION-R2 MINOR-2).
 */
function callbackReturnsOnly(callback, keeps) {
  const inner = unwrapExpression(callback);
  if (inner === undefined) return false;
  if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner)) return false;
  const parameter = inner.parameters[0];
  if (parameter === undefined) return false;
  const identity = identityHoldersOf(inner, parameter);
  const holders = identity === null ? null : identity.holders;
  const rest = identity === null ? false : identity.rest;
  const parts = ts.isObjectBindingPattern(parameter.name) ? destructuredPartsOf(parameter.name) : null;
  if (holders === null && parts === null) return false;
  const handsBack = (expression) => keeps(expression, holders, parts, rest);
  const body = unwrapExpression(inner.body);
  if (body === undefined) return false;
  if (!callbackEffectsAreReadable(inner, holders, rest)) return false;
  if (!ts.isBlock(body)) return handsBack(body);
  // A `break`/`continue` leaves a construct the exit model cannot place, so a callback
  // that contains one is refused rather than read (review CF070-GATE-REMEDIATION-R3
  // MAJOR-2).
  const jumps = collectNodes(body, (node) =>
    (ts.isBreakStatement(node) || ts.isContinueStatement(node)) && !isInsideNestedFunction(node, inner)
      ? node
      : null,
  );
  if (jumps.length > 0) return false;
  const statements = body.statements;
  const last = statements[statements.length - 1];
  if (last === undefined || !alwaysExits(last)) return false;
  const returns = collectNodes(body, (node) =>
    ts.isReturnStatement(node) && !isInsideNestedFunction(node, inner) ? node : null,
  );
  return returns.every((statement) => statement.expression !== undefined && handsBack(statement.expression));
}

/**
 * Bounded effect contract for callbacks over the reviewed plain-data records.
 * Do not infer purity from an access-chain root: an aggregate can hide any alias.
 * Scan parameters, concise/block bodies and nested functions alike. Only writes to
 * callback-local identifier bindings are understood; a holder may only receive
 * another holder via plain `=`. All property/destructuring writes are refused,
 * even writes to a genuinely fresh local object (a conservative refusal).
 *
 * Calls are refused irrespective of their arguments, except the unshadowed builtin
 * Object.assign with an inline fresh, data-only target. That call cannot write an
 * existing alias. Return-value identity is still checked separately by `keeps`;
 * discarding a copy that replaces fields does not change the original record.
 * Assignment-form loop headers, constructors, tags, async/generator callbacks
 * and suspension are not modelled. This is not a proof of
 * arbitrary JavaScript purity: records/builtins are assumed ordinary, with no
 * externally installed getters, proxies or patched prototypes.
 */
function callbackEffectsAreReadable(callback, holders, rest) {
  return collectNodes(callback, (node) => {
    if (isFunctionLike(node) && (
      node.asteriskToken !== undefined ||
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )) return node;
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && (
      !ts.isVariableDeclarationList(node.initializer) || node.awaitModifier !== undefined
    )) return node;
    if (writesThroughAssignment(node)) {
      const target = unwrapExpression(ts.isBinaryExpression(node) ? node.left : node.operand);
      if (target === undefined || !ts.isIdentifier(target)) return node;
      const binding = nearestBindingOf(target, target.text);
      if (binding === null || !isWithin(binding, callback)) return node;
      if (holders !== null && isElementHolder(target, target.text, holders)) {
        return ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          spreadsNameOnly(node.right, holders, rest) ? null : node;
      }
      // A destructured parameter part can be put back under the same spelling
      // after being changed; textual round-trip identity does not prove its value.
      if (callback.parameters.includes(binding)) return node;
      return null;
    }
    if (
      ts.isDeleteExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) ||
      ts.isAwaitExpression(node) || ts.isYieldExpression(node)
    ) return node;
    if (!ts.isCallExpression(node)) return null;
    if (objectStaticCallName(node) !== "assign" || node.arguments.some(ts.isSpreadElement)) return node;
    const callee = unwrapExpression(node.expression);
    if (nearestBindingOf(callee.expression, "Object") !== null) return node;
    const target = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0]);
    if (target === undefined || !ts.isObjectLiteralExpression(target)) return node;
    // Methods/accessors or __proto__ in the target can install setters. Spreading
    // an ordinary data record into a fresh object cannot install a setter.
    return target.properties.every((property) => ts.isSpreadAssignment(property)) ? null : node;
  }).length === 0;
}

/** True when a node writes through an assignment or a `++`/`--`. */
function writesThroughAssignment(node) {
  if (ts.isBinaryExpression(node)) return isAssignmentOperator(node.operatorToken.kind);
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

/**
 * True when a statement leaves the statement list holding it whichever arm of it
 * runs: a `return`, a `throw`, a block whose last statement does, an `if`/`else`
 * where both arms do, a labelled statement whose statement does, a `do … while`
 * whose body does (the body runs at least once), a `for … of`/`for … in` over a
 * literal proven to have an element/key whose body does, or a `switch` with a
 * `default` every clause of which does — a clause that falls through has no
 * statement of its own, so it takes the verdict of the clause it falls into.
 *
 * A `break`/`continue` is never an exit here and is refused by the caller: it
 * leaves a construct this model cannot place, so a `switch` clause that breaks
 * from a position that is not its last statement would otherwise read as exiting
 * (`switch (s.field) { default: { if (c) { break; } return s; } }` returns for one
 * input and falls off the end for another, review CF070-GATE-REMEDIATION-R3
 * MAJOR-2). A `try` is not modelled either: a `finally` can return in its place.
 */
function alwaysExits(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return last !== undefined && alwaysExits(last);
  }
  if (ts.isLabeledStatement(statement)) return alwaysExits(statement.statement);
  if (ts.isDoStatement(statement)) return alwaysExits(statement.statement);
  if (ts.isIfStatement(statement)) {
    return (
      statement.elseStatement !== undefined &&
      alwaysExits(statement.thenStatement) &&
      alwaysExits(statement.elseStatement)
    );
  }
  if (ts.isSwitchStatement(statement)) return switchExits(statement);
  if (
    (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) &&
    statement.statement !== undefined
  ) {
    // A loop over a literal it must walk at least once exits if its body does
    // (`for (const x of [s]) { return x; }`, review CF070-GATE-REMEDIATION-R3
    // MINOR-3).
    return loopMustEnter(statement) && alwaysExits(statement.statement);
  }
  return false;
}

/** Literal-only lower bound: for-in enumerates keys, not an array's length. */
function loopMustEnter(statement) {
  const value = unwrapExpression(statement.expression);
  if (value === undefined) return false;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.length > 0;
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some((element) =>
      !ts.isSpreadElement(element) && (ts.isForOfStatement(statement) || !ts.isOmittedExpression(element)),
    );
  }
  if (!ts.isForInStatement(statement) || !ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some((property) =>
    ts.isShorthandPropertyAssignment(property) ||
    (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) &&
      propertyNameOf(property.name) !== "__proto__"),
  );
}

/**
 * True when a `switch` leaves the list holding it whichever clause runs: it has a
 * `default`, and every clause exits — a clause with no statements of its own
 * falling through into the clause after it, which is what `case "a": case "b":
 * return s;` is (review CF070-GATE-REMEDIATION-R3 MINOR-3).
 */
function switchExits(statement) {
  const clauses = statement.caseBlock.clauses;
  if (!clauses.some((clause) => ts.isDefaultClause(clause))) return false;
  let verdict = false;
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const statements = clauses[index].statements;
    if (statements.length > 0) verdict = alwaysExits(statements[statements.length - 1]);
    if (!verdict) return false;
  }
  return verdict;
}

/**
 * True when a name at a use site is still bound to the holder the callback
 * registered for it. Resolution is by binding, not by text, so a name the
 * callback re-declares shadows the element rather than being read as it
 * (`(s) => { { const s = {}; return s; } }`, review CF070-GATE-REMEDIATION-R2
 * MINOR-2).
 */
function isElementHolder(node, name, holders) {
  const expected = holders.get(name);
  if (expected === undefined) return false;
  return nearestBindingOf(node, name) === expected;
}

/**
 * The names inside a `map` callback that hold the element it was handed, as a map
 * from the name to the binding that carries it: its first parameter, the element
 * of a rest parameter (`(...args) => args[0]`) or the rest object of an
 * object-rest pattern (`({ ...s }) => s`), and any local the callback binds to
 * one of those names whose own writes only ever put one back
 * (`const copy = s`, `let copy; copy = s;`). Followed to a fixed point so a chain
 * of aliases resolves. `null` when the parameter is neither of those — taking the
 * element apart is decided by the round trip instead (review CF070-GATE-
 * REMEDIATION MINOR-2).
 *
 * A local written anything else is not a holder: after that write the name may
 * hold another value (`let copy = s; copy = {};`). A local a nested function
 * declares is not this scope's, either.
 */
function identityHoldersOf(callback, parameter) {
  const pattern = parameter.name;
  const holders = new Map();
  let rest = false;
  if (ts.isIdentifier(pattern)) {
    holders.set(pattern.text, parameter);
    // A rest parameter collects the call's arguments, so its first entry is the
    // element (`(...args) => args[0]`).
    rest = parameter.dotDotDotToken !== undefined;
  } else if (ts.isArrayBindingPattern(pattern) && pattern.elements.length === 1) {
    const element = pattern.elements[0];
    if (
      !ts.isBindingElement(element) ||
      element.dotDotDotToken === undefined ||
      !ts.isIdentifier(element.name)
    ) {
      return null;
    }
    // A rest parameter collects the call's arguments, so its first entry is the
    // element (`(...args) => args[0]`).
    rest = true;
    holders.set(element.name.text, parameter);
  } else if (ts.isObjectBindingPattern(pattern) && pattern.elements.length === 1) {
    const element = pattern.elements[0];
    if (
      !ts.isBindingElement(element) ||
      element.dotDotDotToken === undefined ||
      !ts.isIdentifier(element.name)
    ) {
      return null;
    }
    // An object-rest pattern with nothing beside it takes every property, so
    // what it bound *is* the element (`({ ...s }) => s`).
    holders.set(element.name.text, parameter);
  } else {
    return null;
  }
  let changed = true;
  while (changed) {
    changed = false;
    walkTree(callback.body, (node) => {
      // Every entry that can reach a return through this loop binding must hold
      // the element, not merely the first entry. A branch can skip that first entry
      // (`map((s) => { for (const x of [s]) { return x; } })`, review
      // CF070-GATE-REMEDIATION-R3 MINOR-3). The binding must be `const`: a loop
      // variable the body can write is not the element any more.
      if (ts.isForOfStatement(node)) {
        if (ts.isVariableDeclarationList(node.initializer) && (node.initializer.flags & ts.NodeFlags.Const) !== 0) {
          const iterable = unwrapExpression(node.expression);
          const elements =
            iterable !== undefined && ts.isArrayLiteralExpression(iterable) ? iterable.elements : [];
          if (elements.length > 0 && elements.every((element) =>
            !ts.isSpreadElement(element) && spreadsNameOnly(element, holders, rest),
          )) {
            for (const declaration of node.initializer.declarations) {
              if (ts.isIdentifier(declaration.name) && !holders.has(declaration.name.text)) {
                holders.set(declaration.name.text, declaration);
                changed = true;
              }
            }
          }
        }
        return;
      }
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || holders.has(node.name.text)) return;
      if (isInsideNestedFunction(node, callback)) return;
      const writes = writesForName(callback, node, node.name.text) ?? [];
      const initializerHolds =
        node.initializer !== undefined && spreadsNameOnly(node.initializer, holders, rest);
      const writesHold = writes.every((write) => write.plain && spreadsNameOnly(write.value, holders, rest));
      if ((!initializerHolds && writes.length === 0) || !writesHold) return;
      holders.set(node.name.text, node);
      changed = true;
    });
  }
  return { holders, rest };
}

/**
 * The parts of an object-pattern parameter, or null when the parameter is not one
 * this round trip can follow. A rest element is its own part: spreading it back
 * is how the remainder is put back.
 */
function destructuredPartsOf(pattern) {
  if (!ts.isObjectBindingPattern(pattern) || pattern.elements.length === 0) return null;
  const parts = [];
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) return null;
    if (element.dotDotDotToken !== undefined) {
      parts.push({ name: element.name.text, key: null, binding: pattern.parent });
      continue;
    }
    const key = propertyNameOf(element.propertyName ?? element.name);
    if (key === null) return null;
    parts.push({ name: element.name.text, key, binding: pattern.parent });
  }
  return parts;
}

/**
 * True when an object literal puts back every name a destructured parameter took
 * apart, unmodified: each part as a shorthand or under its own key, and any rest
 * part spread. Anything else — a renamed part, a computed value, an extra
 * property — is a rebuild the gate cannot read as a copy.
 *
 * A pattern without a rest element is refused even when it puts every name back:
 * the gate cannot read the element's own property list, so it cannot know that
 * nothing was left out. That is the fail-closed direction, because a dropped
 * property loses a reviewed value exactly as a substituted one does (review
 * CF070-GATE-REMEDIATION MINOR-2).
 */
function destructuredRoundTrip(parts, expression) {
  if (!ts.isObjectLiteralExpression(expression)) return false;
  const putBack = new Set();
  let spreadRest = false;
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      // `{ field }` writes key and value alike, so it only puts back a part the
      // pattern bound under that same name.
      const part = parts.find(
        (candidate) => candidate.name === property.name.text && candidate.key === property.name.text,
      );
      if (part === undefined || nearestBindingOf(property, part.name) !== part.binding) return false;
      putBack.add(part.name);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const value = unwrapExpression(property.initializer);
      const key = propertyNameOf(property.name);
      if (value === undefined || !ts.isIdentifier(value) || key === null) return false;
      const part = parts.find((candidate) => candidate.name === value.text);
      if (part === undefined || part.key !== key || nearestBindingOf(value, part.name) !== part.binding) return false;
      putBack.add(part.name);
      continue;
    }
    if (ts.isSpreadAssignment(property)) {
      const value = unwrapExpression(property.expression);
      const part =
        value !== undefined && ts.isIdentifier(value)
          ? parts.find((candidate) => candidate.key === null && candidate.name === value.text)
          : undefined;
      if (part === undefined || nearestBindingOf(value, part.name) !== part.binding) return false;
      spreadRest = true;
      continue;
    }
    return false;
  }
  if (!spreadRest) return false;
  return parts.filter((part) => part.key !== null).every((part) => putBack.has(part.name));
}

/**
 * True when spreading the expression into a copy adds no property at all: an
 * empty object or array literal (`{ ...s, ...{} }`, `[s, ...[]]`). The spread
 * still spreads the element itself, so the copy is the element's own properties
 * either way (review CF070-GATE-REMEDIATION-R5 MINOR-3).
 */
function addsNothingToTheCopy(expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.length === 0;
  if (ts.isObjectLiteralExpression(inner)) return inner.properties.length === 0;
  return false;
}

/**
 * True when the expression is one of the element's holders, a literal that only
 * spreads it, or — for a rest parameter — the element of it (`args[0]`). Holder
 * names are resolved by binding (`isElementHolder`), so a name the callback
 * re-declares is not one.
 */
function spreadsNameOnly(expression, holders, rest) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return false;
  if (ts.isIdentifier(inner)) return isElementHolder(inner, inner.text, holders);
  if (ts.isElementAccessExpression(inner)) {
    // The first element of a rest parameter is the element the call was made
    // with (`(...args) => args[0]`).
    const index = unwrapExpression(inner.argumentExpression);
    if (!rest || index === undefined || !ts.isNumericLiteral(index) || index.text !== "0") return false;
    const receiver = unwrapExpression(inner.expression);
    return receiver !== undefined && ts.isIdentifier(receiver) && isElementHolder(receiver, receiver.text, holders);
  }
  if (ts.isConditionalExpression(inner)) {
    // Whichever arm runs hands the element back, so both must (review
    // CF070-GATE-REMEDIATION-R5 MINOR-3).
    return (
      spreadsNameOnly(inner.whenTrue, holders, rest) && spreadsNameOnly(inner.whenFalse, holders, rest)
    );
  }
  if (ts.isArrayLiteralExpression(inner)) {
    return (
      inner.elements.length > 0 &&
      inner.elements.every(
        (element) =>
          (ts.isSpreadElement(element) && spreadsNameOnly(element.expression, holders, rest)) ||
          (ts.isSpreadElement(element) && addsNothingToTheCopy(element.expression)),
      )
    );
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return (
      inner.properties.length > 0 &&
      inner.properties.every(
        (property) =>
          ts.isSpreadAssignment(property) &&
          (spreadsNameOnly(property.expression, holders, rest) ||
            addsNothingToTheCopy(property.expression)),
      )
    );
  }
  return objectAssignCopyValue(inner, holders, rest) !== null;
}

/**
 * The fresh object an `Object.assign({ … }, s, …)` builds when every source is the
 * element or another holder and the target carries no own property, or `null`. That
 * call is the same shallow copy as `{ ...s }` (review CF070-GATE-REMEDIATION-R2
 * MINOR-1), and it is the one call form the mutation scan does not refuse — a holder
 * in target position is a write to the element, which the scan refuses before it ever
 * asks this question.
 */
function objectAssignCopyValue(call, holders, rest) {
  if (objectStaticCallName(call) !== "assign") return null;
  const target = call.arguments[0] === undefined ? undefined : unwrapExpression(call.arguments[0]);
  if (target === undefined || !ts.isObjectLiteralExpression(target)) return null;
  if (target.properties.some((property) => !ts.isSpreadAssignment(property))) return null;
  const sources = call.arguments.slice(1);
  if (sources.length === 0) return null;
  if (!sources.every((source) => spreadsNameOnly(source, holders, rest))) return null;
  if (!target.properties.every((property) => spreadsNameOnly(property.expression, holders, rest))) return null;
  return target;
}

/** True when `node` is `container` or sits inside it. */
function isWithin(node, container) {
  let current = node;
  while (current !== undefined) {
    if (current === container) return true;
    current = current.parent;
  }
  return false;
}

/**
 * True when the call returns a payload that only ever reports failure, read from
 * the local function it names. `return failure(opResult.error)` is the ordinary
 * failure path; treating it as an unreadable success payload refused a preserving
 * helper (review CF070-GATE-REMEDIATION-R6 MINOR-2). A local builder that can
 * report success is not accepted here — that is the case the provenance check
 * exists to refuse.
 */
function callIsFailurePayload(scope, call) {
  const callee = unwrapExpression(call.expression);
  if (callee === undefined || !ts.isIdentifier(callee)) return false;
  const declaration = nearestBindingOf(callee, callee.text);
  if (declaration === undefined || declaration === null) return false;
  let fn = declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    fn = unwrapExpression(declaration.initializer);
  }
  if (fn === undefined || (!ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) {
    return false;
  }
  if (fn.body === undefined) return false;
  if (!ts.isBlock(fn.body)) {
    // A concise arrow body is the returned payload; it has no return statement.
    const candidates = payloadCandidatesOf(fn.body);
    return (
      candidates.length > 0 &&
      candidates.every((payload) => {
        const ok = payloadPropertyOf(scope, payload, "ok");
        return ok !== undefined && staticValue(ok) === false;
      })
    );
  }
  const returns = collectNodes(fn, (node) =>
    ts.isReturnStatement(node) && node.expression !== undefined && !isInsideNestedFunction(node, fn)
      ? node
      : null,
  );
  if (returns.length === 0) return false;
  return returns.every((statement) => {
    const candidates = payloadCandidatesOf(statement.expression);
    return (
      candidates.length > 0 &&
      candidates.every((payload) => {
        const ok = payloadPropertyOf(scope, payload, "ok");
        return ok !== undefined && staticValue(ok) === false;
      })
    );
  });
}

/**
 * Every object literal a returned expression can hand back: the literal itself,
 * the binding that holds it (`let manufactured = { … }; return manufactured;`),
 * each arm of a conditional, the merge `Object.assign(target, …sources)`
 * performs (later sources win, in order), the object `Object.freeze` hands back,
 * and what an immediately-invoked function with no arguments returns. A payload
 * the walk cannot see is exactly how a fabricated one escaped, so the shapes are
 * enumerated rather than skipped (CF-070 R2 retry-8 F-1/D, retry-9 D2-D4;
 * review CF070-GATE-REMEDIATION MINOR-3c).
 */
function payloadCandidatesOf(expression) {
  const inner = unwrapExpression(expression);
  if (inner === undefined) return [];
  if (ts.isObjectLiteralExpression(inner)) return [inner];
  if (ts.isConditionalExpression(inner)) {
    return [...payloadCandidatesOf(inner.whenTrue), ...payloadCandidatesOf(inner.whenFalse)];
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    // `(sideEffect(), manufactured)` hands back its last operand.
    return payloadCandidatesOf(inner.right);
  }
  if (ts.isCallExpression(inner)) {
    const objectStatic = objectStaticCallName(inner);
    if (objectStatic === "assign") return [mergedObjectLiteral(inner.arguments)];
    if (objectStatic === "freeze" && inner.arguments.length === 1) return payloadCandidatesOf(inner.arguments[0]);
    const callee = unwrapExpression(inner.expression);
    if (
      inner.arguments.length === 0 &&
      callee !== undefined &&
      (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee))
    ) {
      const body = unwrapExpression(callee.body);
      if (body === undefined) return [];
      if (!ts.isBlock(body)) return payloadCandidatesOf(body);
      const returns = collectNodes(body, (node) =>
        ts.isReturnStatement(node) && !isInsideNestedFunction(node, callee) ? node : null,
      );
      return returns.flatMap((statement) =>
        statement.expression === undefined ? [] : payloadCandidatesOf(statement.expression),
      );
    }
    return [];
  }
  if (!ts.isIdentifier(inner)) return [];
  const declaration = trustedConstBinding(inner.getSourceFile(), inner.text, inner);
  if (declaration === null || declaration.initializer === undefined) return [];
  return payloadCandidatesOf(declaration.initializer);
}

/** The `Object.<member>(…)` static a call invokes, or null. */
function objectStaticCallName(call) {
  const callee = unwrapExpression(call.expression);
  if (
    callee === undefined ||
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object"
  ) {
    return null;
  }
  return callee.name.text;
}

/**
 * The literal `Object.assign(target, …sources)` returns: its arguments as
 * successive spreads, which is the same last-writer-wins lookup the property
 * reader already implements.
 */
function mergedObjectLiteral(argumentList) {
  return ts.factory.createObjectLiteralExpression(
    argumentList.map((argument) => ts.factory.createSpreadAssignment(argument)),
    false,
  );
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
  const mutationMessage = "report-field helper must not modify the reviewed suggestions after computing them";
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
        if (isInsideNestedFunction(node, scope)) return null;
        const candidates = payloadCandidatesOf(node.expression);
        if (candidates.length === 0) {
          // The failure path hands the task's own result back (`if (!opResult.ok)
          // return opResult;`) or builds a failure payload with a local helper
          // (`return failure(opResult.error)`). Any other expression whose payload
          // this reader cannot see — a local success builder, an unknown call — is
          // unreadable, not exempt (review CF070-GATE-REMEDIATION-R5 MINOR-1,
          // R6 MINOR-2).
          const returned = unwrapExpression(node.expression);
          if (returned !== undefined && ts.isIdentifier(returned) && reviewed.has(returned.text)) return null;
          if (returned !== undefined && ts.isCallExpression(returned) && callIsFailurePayload(scope, returned)) {
            return null;
          }
          return node;
        }
        for (const payload of candidates) {
          const ok = payloadPropertyOf(scope, payload, "ok");
          if (ok === undefined) return node;
          const okValue = staticValue(ok);
          // A payload that reports failure carries no reviewed suggestions; one
          // that reports success must say so statically, or the reader cannot
          // tell which branch runs (review CF070-GATE-REMEDIATION-R5 MINOR-1).
          if (okValue === false) continue;
          if (okValue !== true) return node;
          const value = payloadPropertyOf(scope, payload, "value");
          if (value === undefined) return node;
          const valueLiteral = objectLiteralValueOf(scope, value);
          if (valueLiteral === undefined) return node;
          // Every candidate payload that reports success must carry the reviewed
          // suggestions: undefined means the payload does not give them at all,
          // which is unreadable and therefore refused.
          if (payloadPropertyDerives(scope, valueLiteral, "suggestions", reviewed) !== true) return node;
        }
        return null;
      });
      if (fabricated.length > 0) return discarded;

      // The payload may still be changed after it is read: the callback contract
      // sees callbacks only, so ask the enclosing helper about writes to the
      // chain it ships (review CF070-GATE-REMEDIATION-R5 MAJOR-1).
      const shipped = collectNodes(scope, (node) => {
        if (!ts.isReturnStatement(node) || node.expression === undefined) return null;
        if (isInsideNestedFunction(node, scope)) return null;
        for (const payload of payloadCandidatesOf(node.expression)) {
          const ok = payloadPropertyOf(scope, payload, "ok");
          if (ok === undefined || staticValue(ok) !== true) continue;
          const value = payloadPropertyOf(scope, payload, "value");
          if (value === undefined) continue;
          const valueLiteral = objectLiteralValueOf(scope, value);
          if (valueLiteral === undefined) continue;
          const suggestions = payloadPropertyOf(scope, valueLiteral, "suggestions");
          if (suggestions !== undefined && shippedValueIsMutated(scope, suggestions, reviewed)) return node;
        }
        return null;
      });
      if (shipped.length > 0) return mutationMessage;
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
          const settersAndAliases = namesResolvingToSetters(body, Object.values(REPORT_FIELD_SETTERS));
          const beforeGuard = collectNodes(body, (node) =>
            ts.isCallExpression(node) && callResolvesToReviewedSetter(body, node, settersAndAliases) ? node : null,
          );
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
