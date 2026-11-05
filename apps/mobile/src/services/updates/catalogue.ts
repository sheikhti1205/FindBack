/**
 * S7 catalogue: validation, selection and a bounded public fetch.
 *
 * The catalogue is public metadata (never a Supabase credential dependency).
 * Two rules shape everything here:
 *
 * 1. A tag is not a release. `v0.10.0-beta.1` exists with NO assets; offering
 *    it would send a reader to a 404. Selection therefore requires an accepted
 *    release with at least one artifact that actually matches the installation.
 * 2. "Could not check" is not "up to date". A failed fetch keeps the last
 *    known-good catalogue for history and reports the failure, never a clean
 *    bill of health.
 *
 * SHA-256 verifies bytes against metadata; it does not authenticate metadata.
 * Trust comes from the pinned origin, and the native installer independently
 * verifies the signing identity against the installed app.
 */
import type { AndroidArtifact, AndroidCatalogue, AndroidRelease, Installation, ReleaseHistoryRecord } from "./types";
import { parseFeatureAnnouncements } from "./availability";

/** ABIs the Android product actually ships (mirrors verify-release-apks.sh). */
export const SUPPORTED_ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64"] as const;

/** Android's own ceiling for a versionCode. */
const MAX_VERSION_CODE = 2_100_000_000;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const HTTPS = /^https:\/\//i;

export const DEFAULT_TRUSTED_HOSTS = ["github.com", "objects.githubusercontent.com"] as const;

export class CatalogueError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`catalogue: ${path} ${message}`);
    this.name = "CatalogueError";
    this.path = path;
  }
}

export interface CataloguePolicy {
  /** The application id every artifact must carry. */
  readonly packageName: string;
  /** Public host allowlist for artifact URLs (exact host or a subdomain). */
  readonly trustedHosts: readonly string[];
}

export const DEFAULT_CATALOGUE_POLICY: CataloguePolicy = {
  packageName: "com.findback.app",
  trustedHosts: DEFAULT_TRUSTED_HOSTS,
};

function fail(path: string, message: string): never {
  throw new CatalogueError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value.trim();
}

function requireInteger(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(path, `must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

/** HTTPS, no credentials in the URL, and an owner-approved host. */
function requireTrustedUrl(value: unknown, path: string, policy: CataloguePolicy): string {
  const raw = requireString(value, path);
  if (!HTTPS.test(raw)) fail(path, "must be https");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(path, "is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") fail(path, "must not embed credentials");
  if (url.hash !== "") fail(path, "must not carry a fragment");
  const host = url.hostname.toLowerCase();
  const trusted = policy.trustedHosts.some(
    (allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`),
  );
  if (!trusted) fail(path, "is not on a trusted release host");
  return raw;
}

function parseArtifact(raw: unknown, path: string, policy: CataloguePolicy): AndroidArtifact {
  if (!isRecord(raw)) fail(path, "must be an object");
  const abis = requireArray(raw.abis, `${path}.abis`).map((abi, index) => {
    const value = requireString(abi, `${path}.abis[${index}]`);
    if (!(SUPPORTED_ABIS as readonly string[]).includes(value)) {
      fail(`${path}.abis[${index}]`, `is not a supported ABI (${value})`);
    }
    return value;
  });
  if (abis.length === 0) fail(`${path}.abis`, "must name at least one ABI");
  if (new Set(abis).size !== abis.length) fail(`${path}.abis`, "must not repeat an ABI");

  const minSdk = requireInteger(raw.minSdk, `${path}.minSdk`, 21, 100);
  const targetSdk = requireInteger(raw.targetSdk, `${path}.targetSdk`, minSdk, 100);
  const signerSha256 = requireString(raw.signerSha256, `${path}.signerSha256`);
  if (!SHA256_HEX.test(signerSha256)) fail(`${path}.signerSha256`, "must be 64 hex characters");

  return Object.freeze({
    url: requireTrustedUrl(raw.url, `${path}.url`, policy),
    bytes: requireInteger(raw.bytes, `${path}.bytes`, 1),
    sha256: requireSha256(raw.sha256, `${path}.sha256`),
    packageName: requirePackage(raw.packageName, `${path}.packageName`, policy),
    signingChannel: requireString(raw.signingChannel, `${path}.signingChannel`),
    signerSha256: signerSha256.toLowerCase(),
    abis: Object.freeze(abis),
    minSdk,
    targetSdk,
  });
}

function requireSha256(value: unknown, path: string): string {
  const raw = requireString(value, path).toLowerCase();
  if (!SHA256_HEX.test(raw)) fail(path, "must be 64 hex characters");
  return raw;
}

function requirePackage(value: unknown, path: string, policy: CataloguePolicy): string {
  const raw = requireString(value, path);
  if (raw !== policy.packageName) fail(path, `must be ${policy.packageName}`);
  return raw;
}

function parseRelease(raw: unknown, path: string, policy: CataloguePolicy): AndroidRelease {
  if (!isRecord(raw)) fail(path, "must be an object");
  if (raw.platform !== "android") fail(`${path}.platform`, "must be android");

  const versionName = requireString(raw.versionName, `${path}.versionName`);
  if (!SEMVER.test(versionName)) fail(`${path}.versionName`, "is not a SemVer version");

  const gitSha = requireString(raw.gitSha, `${path}.gitSha`);
  if (!COMMIT_SHA.test(gitSha)) fail(`${path}.gitSha`, "must be a full 40-char commit SHA");

  const tag = requireString(raw.tag, `${path}.tag`);
  if (/\s/.test(tag)) fail(`${path}.tag`, "must not contain whitespace");

  const publishedAt = requireString(raw.publishedAt, `${path}.publishedAt`);
  if (Number.isNaN(Date.parse(publishedAt))) fail(`${path}.publishedAt`, "must be an ISO-8601 timestamp");

  if (typeof raw.accepted !== "boolean") fail(`${path}.accepted`, "must be a boolean");

  const artifacts = requireArray(raw.artifacts, `${path}.artifacts`).map((artifact, index) =>
    parseArtifact(artifact, `${path}.artifacts[${index}]`, policy),
  );

  // A release's artifacts describe ONE build. Mixed channels or SDK levels
  // would let the catalogue claim two different builds under one identity.
  const channel = artifacts[0]?.signingChannel;
  const minSdk = artifacts[0]?.minSdk;
  const targetSdk = artifacts[0]?.targetSdk;
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.signingChannel !== channel) {
      fail(`${path}.artifacts[${index}].signingChannel`, "differs from its sibling variants");
    }
    if (artifact.minSdk !== minSdk || artifact.targetSdk !== targetSdk) {
      fail(`${path}.artifacts[${index}]`, `SDK levels differ from its sibling variants`);
    }
  }

  return Object.freeze({
    id: requireString(raw.id, `${path}.id`),
    platform: "android" as const,
    versionName,
    versionCode: requireInteger(raw.versionCode, `${path}.versionCode`, 1, MAX_VERSION_CODE),
    gitSha: gitSha.toLowerCase(),
    tag,
    publishedAt,
    summary: requireString(raw.summary, `${path}.summary`),
    accepted: raw.accepted,
    artifacts: Object.freeze(artifacts),
  });
}

/**
 * Validate an untrusted catalogue payload. Throws `CatalogueError` on anything
 * that could make selection lie — malformed or duplicate identities, a wrong
 * package/channel, an unsupported ABI/SDK, or an unsafe URL. It never repairs a
 * partial record: a bad catalogue is not a smaller catalogue.
 */
export function parseAndroidCatalogue(
  raw: unknown,
  policy: CataloguePolicy = DEFAULT_CATALOGUE_POLICY,
): AndroidCatalogue {
  if (!isRecord(raw)) fail("root", "must be an object");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) fail("schemaVersion", "is unsupported");
  const releases = requireArray(raw.releases, "releases").map((release, index) =>
    parseRelease(release, `releases[${index}]`, policy),
  );

  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const [index, release] of releases.entries()) {
    if (ids.has(release.id)) fail(`releases[${index}].id`, `duplicates ${release.id}`);
    ids.add(release.id);
    for (const [artifactIndex, artifact] of release.artifacts.entries()) {
      if (urls.has(artifact.url)) {
        fail(`releases[${index}].artifacts[${artifactIndex}].url`, "duplicates another artifact");
      }
      urls.add(artifact.url);
    }
  }

  const history = raw.history === undefined ? undefined : requireArray(raw.history, "history").map((entry, index): ReleaseHistoryRecord => {
    const path = `history[${index}]`;
    if (!isRecord(entry)) fail(path, "must be an object");
    const id = requireString(entry.id, `${path}.id`);
    if (ids.has(id)) fail(`${path}.id`, "duplicates a release");
    ids.add(id);
    const versionName = requireString(entry.versionName, `${path}.versionName`);
    if (!SEMVER.test(versionName)) fail(`${path}.versionName`, "is not a version");
    const publishedAt = requireString(entry.publishedAt, `${path}.publishedAt`);
    if (Number.isNaN(Date.parse(publishedAt))) fail(`${path}.publishedAt`, "is not a date");
    if (entry.downloadStatus !== "none" && entry.downloadStatus !== "unverified") fail(`${path}.downloadStatus`, "is unsupported");
    return Object.freeze({ id, versionName, publishedAt, summary: requireString(entry.summary, `${path}.summary`), downloadStatus: entry.downloadStatus });
  });
  const features = raw.features === undefined ? undefined : parseFeatureAnnouncements(raw.features);
  if (features?.some(feature => !ids.has(feature.releaseId))) fail("features", "references an unknown release");
  return Object.freeze({ releases: Object.freeze(releases),
    ...(history === undefined ? {} : { history: Object.freeze(history) }),
    ...(features === undefined ? {} : { features: Object.freeze(features) }),
  });
}

function usableInstallation(installation: Installation): boolean {
  return (
    typeof installation.packageName === "string" &&
    installation.packageName.trim() !== "" &&
    Number.isInteger(installation.versionCode) &&
    installation.versionCode > 0 &&
    typeof installation.signingChannel === "string" &&
    installation.signingChannel.trim() !== "" &&
    typeof installation.abi === "string" &&
    installation.abi.trim() !== "" &&
    Number.isInteger(installation.sdk) &&
    installation.sdk >= 1
  );
}

/**
 * The artifact can be installed on this device: same package, same owner
 * channel, an ABI the artifact really carries, and a minSdk the device meets.
 * Unknown/blank authority facts never match (fail closed).
 */
function compatibleArtifact(artifact: AndroidArtifact, installation: Installation): boolean {
  return (
    artifact.packageName === installation.packageName &&
    artifact.signingChannel === installation.signingChannel &&
    artifact.abis.includes(installation.abi) &&
    artifact.minSdk <= installation.sdk
  );
}

/**
 * The newest accepted release this installation may move to.
 *
 * Returns null for: a non-positive/unknown installation, an assetless tag, a
 * downgrade or same-code release, a wrong package/channel, an incompatible
 * ABI/SDK, and an unaccepted release. A release with no usable artifact is not
 * an update, however new its version string looks.
 */
export function selectInstallableRelease(
  catalogue: AndroidCatalogue,
  installation: Installation,
): AndroidRelease | null {
  if (!usableInstallation(installation)) return null;
  let best: AndroidRelease | null = null;
  for (const release of catalogue.releases) {
    if (!release.accepted) continue;
    if (release.versionCode <= installation.versionCode) continue;
    if (!release.artifacts.some((artifact) => compatibleArtifact(artifact, installation))) continue;
    if (best === null || release.versionCode > best.versionCode) best = release;
  }
  return best;
}

/**
 * Bind the exact bytes to a native job. Prefer a single-ABI artifact over the
 * universal one (same build, a third of the download); among equals take the
 * smallest, then the URL, so the choice is deterministic.
 */
export function selectArtifact(
  release: AndroidRelease,
  installation: Installation,
): AndroidArtifact | null {
  if (!usableInstallation(installation)) return null;
  const candidates = release.artifacts.filter((artifact) =>
    compatibleArtifact(artifact, installation),
  );
  if (candidates.length === 0) return null;
  const exact = candidates.filter((artifact) => artifact.abis.length === 1);
  const pool = exact.length > 0 ? exact : candidates;
  return (
    [...pool].sort((a, b) => a.bytes - b.bytes || a.url.localeCompare(b.url))[0] ?? null
  );
}

/* ------------------------------------------------------------------------- */
/* Bounded, cached, public fetch                                             */
/* ------------------------------------------------------------------------- */

export interface CatalogueCache {
  /** The last written payload (an untrusted value: it is re-validated). */
  read(): Promise<unknown>;
  write(raw: unknown): Promise<void>;
}

export interface CatalogueSourceOptions {
  readonly url: string;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly cache?: CatalogueCache;
  /** Shipped history is readable offline; never count it as a network check. */
  readonly fallback?: AndroidCatalogue;
  readonly now?: () => number;
  /** Minimum gap between successful checks. */
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
  /** First retry delay after a failure; doubles per consecutive failure. */
  readonly backoffBaseMs?: number;
  readonly maxBackoffMs?: number;
  readonly policy?: CataloguePolicy;
}

/** Cached record; `checkedAt` is when the payload was actually fetched. */
interface CachedCatalogue {
  readonly checkedAt: number;
  readonly catalogue: AndroidCatalogue;
}

export type CatalogueCheck =
  /** Freshly fetched and validated. */
  | { readonly status: "ok"; readonly catalogue: AndroidCatalogue; readonly checkedAt: number }
  /** Too soon (or backing off); the last known-good catalogue is all we know. */
  | {
      readonly status: "cached";
      readonly catalogue: AndroidCatalogue;
      readonly checkedAt: number;
      readonly reason: "rate-limited" | "backoff";
    }
  /** The check itself failed. `catalogue` is the last known-good (if any). */
  | {
      readonly status: "error";
      readonly code: "offline" | "http" | "invalid" | "untrusted" | "timeout" | "backoff";
      readonly catalogue: AndroidCatalogue | null;
      readonly checkedAt: number | null;
    };

const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * A public, bounded catalogue source. It never throws from `check()` — an
 * unreadable catalogue is a reported state, because the Updates surface must
 * keep showing the last known-good history offline.
 */
export function createCatalogueSource(options: CatalogueSourceOptions) {
  const policy = options.policy ?? DEFAULT_CATALOGUE_POLICY;
  // Fail at construction, not on the first check: an untrusted or non-HTTPS
  // endpoint is a configuration defect, not a transient network state.
  const url = requireTrustedUrl(options.url, "url", policy);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let failures = 0;
  let retryAt = 0;

  async function cached(): Promise<CachedCatalogue | null> {
    if (options.cache === undefined) return null;
    try {
      const record = await options.cache.read();
      if (!isRecord(record)) return null;
      const checkedAt = record.checkedAt;
      if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
      return { checkedAt, catalogue: parseAndroidCatalogue(record.catalogue, policy) };
    } catch {
      // A corrupted cache is not last-known-good.
      return null;
    }
  }

  async function check(): Promise<CatalogueCheck> {
    const previous = await cached() ?? (options.fallback ? { checkedAt: 0, catalogue: options.fallback } : null);
    const at = now();

    if (previous !== null && previous.checkedAt > 0 && at - previous.checkedAt < minIntervalMs) {
      return { status: "cached", catalogue: previous.catalogue, checkedAt: previous.checkedAt, reason: "rate-limited" };
    }
    if (at < retryAt) {
      return {
        status: "error",
        code: "backoff",
        catalogue: previous?.catalogue ?? null,
        checkedAt: previous?.checkedAt ?? null,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const finalUrl = response.url === "" ? url : response.url;
      // A redirect off the pinned origin is a trust failure, not a network
      // failure: report it as such so the surface does not retry it as offline.
      if (!HTTPS.test(finalUrl) || !onTrustedHost(finalUrl, policy)) {
        failWith("untrusted");
      }
      if (!response.ok) {
        failWith("http");
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        failWith("invalid");
      }
      let catalogue: AndroidCatalogue;
      try {
        catalogue = parseAndroidCatalogue(payload, policy);
      } catch {
        failWith("invalid");
      }
      const checkedAt = now();
      failures = 0;
      retryAt = 0;
      await options.cache?.write({ checkedAt, catalogue: payload }).catch(() => undefined);
      return { status: "ok", catalogue, checkedAt };
    } catch (error) {
      const code = error instanceof CheckFailure ? error.code : controller.signal.aborted ? "timeout" : "offline";
      failures += 1;
      retryAt = now() + Math.min(maxBackoffMs, backoffBaseMs * 2 ** (failures - 1));
      return {
        status: "error",
        code,
        catalogue: previous?.catalogue ?? null,
        checkedAt: previous?.checkedAt ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { check, cached };
}

class CheckFailure extends Error {
  readonly code: Extract<CatalogueCheck, { status: "error" }>["code"];

  constructor(code: Extract<CatalogueCheck, { status: "error" }>["code"]) {
    super(code);
    this.name = "CheckFailure";
    this.code = code;
  }
}

function failWith(code: Extract<CatalogueCheck, { status: "error" }>["code"]): never {
  throw new CheckFailure(code);
}

function onTrustedHost(raw: string, policy: CataloguePolicy): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return policy.trustedHosts.some(
      (allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`),
    );
  } catch {
    return false;
  }
}

/**
 * Browser storage cache. Public metadata only; a corrupt or unreadable entry is
 * treated as absent, never as a catalogue.
 */
export function localStorageCatalogueCache(
  key = "norfold.android-catalogue.v1",
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): CatalogueCache {
  if (storage === undefined) {
    try { storage = typeof localStorage === "undefined" ? null : localStorage; } catch { storage = null; }
  }
  return {
    async read() {
      if (storage === null) return null;
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    async write(raw) {
      if (storage === null) return;
      storage.setItem(key, JSON.stringify(raw));
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Verified manifest -> catalogue release                                    */
/* ------------------------------------------------------------------------- */

export interface VerifiedManifestRelease {
  /** Stable catalogue id; usually the tag. */
  readonly id: string;
  /** Human summary shown in history. */
  readonly summary: string;
  /** Explicit acceptance for this platform/build. */
  readonly accepted: boolean;
  /** GitHub release asset directory for this tag. */
  readonly downloadBaseUrl: string;
  /** Publication timestamp the manifest itself does not carry. */
  readonly publishedAt: string;
}

/**
 * Turn a generated release manifest into ONE catalogue release.
 *
 * The manifest is produced from signed bytes (`generate-release-manifest.mjs`)
 * and its APK entries carry the facts verified by `verify-release-apks.sh`.
 * Anything else — a hand-written entry, an older manifest without verified
 * facts, a manifest whose only artifact is the AAB — is refused, because the
 * catalogue must reference artifacts that really exist and really install.
 */
export function releaseFromManifest(
  manifest: unknown,
  input: VerifiedManifestRelease,
  policy: CataloguePolicy = DEFAULT_CATALOGUE_POLICY,
): AndroidRelease {
  if (!isRecord(manifest)) fail("manifest", "must be an object");
  const artifactsRaw = requireArray(manifest.artifacts, "manifest.artifacts");
  const base = input.downloadBaseUrl.replace(/\/+$/, "");
  const artifacts: unknown[] = [];
  for (const [index, entry] of artifactsRaw.entries()) {
    if (!isRecord(entry)) fail(`manifest.artifacts[${index}]`, "must be an object");
    if (entry.kind === "bundle") continue;
    const file = requireString(entry.file, `manifest.artifacts[${index}].file`);
    artifacts.push({
      url: `${base}/${encodeURIComponent(file)}`,
      bytes: entry.bytes,
      sha256: entry.sha256,
      packageName: entry.packageName,
      signingChannel: entry.signingChannel,
      signerSha256: entry.signerSha256,
      abis: entry.abis,
      minSdk: entry.minSdk,
      targetSdk: entry.targetSdk,
    });
  }
  if (artifacts.length === 0) fail("manifest.artifacts", "has no verified APK to install");

  const candidate = {
    releases: [
      {
        id: input.id,
        platform: "android",
        versionName: manifest.versionName,
        versionCode: manifest.versionCode,
        gitSha: manifest.gitSha,
        tag: manifest.tag,
        publishedAt: input.publishedAt,
        summary: input.summary,
        accepted: input.accepted,
        artifacts,
      },
    ],
  };
  return parseAndroidCatalogue(candidate, policy).releases[0]!;
}
