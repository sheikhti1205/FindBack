/**
 * Privacy-safe crash reporting for the Capacitor mobile app.
 *
 * Design notes:
 * - The Sentry DSN is a public client value read from `VITE_SENTRY_DSN`.
 *   Without it, every function below is a no-op: the app runs unchanged.
 * - Session replay stays disabled and request bodies are never attached.
 * - Sentry Logs are enabled (`enableLogs: true`); every log passes through
 *   the same fail-closed sanitize path (`beforeSendLog` ->
 *   `sanitizeSentryLog`) as events and breadcrumbs, so the privacy posture
 *   below is unchanged by maximum logging.
 * - BYOK key material, chat text, photo bytes, precise location and auth
 *   tokens are redacted/withheld before anything leaves the device.
 * - The Sentry SDK is loaded with a dynamic import inside `initMonitoring`
 *   so unit tests and DSN-less runs never touch native code.
 */
import { resolveSentryRelease } from "./release";

export const SENTRY_DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const REDACTED = "[redacted]";
const REDACTED_IMAGE = "[redacted-image]";
const WITHHELD = "[withheld-privacy]";

// Built from parts so this shipped module never contains a secret-shaped
// literal of its own.
const OR_KEY_HEAD = ["sk", "or"].join("-") + "-";
const SUPA_SECRET_HEAD = ["sb", "secret"].join("_") + "_";
const SUPA_PUBLISHABLE_HEAD = ["sb", "publishable"].join("_") + "_";
const GOOGLE_API_KEY_HEAD = "AIza";
const GITHUB_PAT_HEAD = "ghp_";
const GITHUB_OAUTH_HEAD = "gho_";

const SECRET_PATTERNS: RegExp[] = [
  new RegExp(`${OR_KEY_HEAD}[A-Za-z0-9_.-]{8,}`, "g"),
  new RegExp(`${SUPA_SECRET_HEAD}[A-Za-z0-9_-]{8,}`, "g"),
  new RegExp(`${SUPA_PUBLISHABLE_HEAD}[A-Za-z0-9_-]{8,}`, "g"),
  new RegExp(`${GOOGLE_API_KEY_HEAD}[A-Za-z0-9_-]{20,}`, "g"),
  new RegExp(`${GITHUB_PAT_HEAD}[A-Za-z0-9]{20,}`, "g"),
  new RegExp(`${GITHUB_OAUTH_HEAD}[A-Za-z0-9]{20,}`, "g"),
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g,
  /blob:\S+/g,
  // postgres://user:pass@host/db — redact the password segment
  /postgres:\/\/[^:]+:[^@]+@/g,
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // E.164-ish phone numbers (+ followed by 10-15 digits, optional spaces/dashes)
  /\+\d[\d\s-]{8,14}\d/g,
  // High-entropy hex tokens (32+ hex chars)
  /\b[0-9a-f]{32,}\b/g,
  // High-entropy base64-ish tokens (43+ chars, alphanumeric + _ -)
  /\b[A-Za-z0-9_-]{43,}\b/g,
];

const WITHHELD_KEY =
  /(photo|image|picture|audio|video|camera|location|latitude|longitude|\blat\b|\blng\b|\blon\b|coord|latlng|position|coordinates?|transcript|chat|conversation|history|credential|passphrase|password|secret|token|api[_-]?key|auth|prompt|response|completion|report|description|content|body|address|phone|email|userName|owner|deviceId|sessionId|ip)/i;

/** Fixed label for the synthetic monitoring self-test signal (device proof). */
export const MONITORING_TEST_SIGNAL_MESSAGE =
  "FindBack monitoring test signal (synthetic self-test)";
export const MONITORING_TEST_SIGNAL_TAG_VALUE = "findback-monitoring-self-test";

/**
 * Sentry Logs switch (maximum logging). Spread as `enableLogs` into
 * `Sentry.init` next to `getSentryPrivacyDefaults()` so enabling logs can
 * never silently weaken the privacy posture asserted by tests.
 */
export const SENTRY_LOGS_ENABLED = true as const;

/**
 * Levels allowed for `reportLogToMonitoring`. Deliberately limited to
 * info/warn/error — no verbose/trace/debug levels that invite PII-prone
 * free-text dumping.
 */
export type MonitoringLogLevel = "info" | "warn" | "error";

export function resolveSentryDsn(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("https://")) return null;
  try {
    const url = new URL(trimmed);
    if (!url.username || !url.hostname) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function resolveSentryEnvironment(
  raw: string | undefined,
  mode: string | undefined,
): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed) return trimmed;
  if (mode) return mode;
  return "production";
}

/**
 * Closed Sentry `dist` map (SYNC-9).
 *
 * INVARIANT: the SDK `dist` below must match the `--dist` values the
 * CI/release/web sourcemap uploads use (`android-debug`,
 * `android-release`, `web-production`); the closed map additionally covers
 * `android-signeddev` (signed-dev APK lane) and `docker-reference`
 * (reference web image). Unknown/empty input resolves to `undefined` (SDK
 * default) — never a placeholder — so a misconfigured env cannot mint a
 * dist that can never match an upload.
 */
const SENTRY_DIST_VALUES = [
  "android-debug",
  "android-signeddev",
  "android-release",
  "web-production",
  "docker-reference",
] as const;

export type SentryDist = (typeof SENTRY_DIST_VALUES)[number];

export function resolveSentryDist(
  raw: string | undefined | null,
): SentryDist | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return (SENTRY_DIST_VALUES as readonly string[]).includes(trimmed)
    ? (trimmed as SentryDist)
    : undefined;
}

export function resolveTracesSampleRate(raw: string | number | undefined): number {
  const fallback = SENTRY_DEFAULT_TRACES_SAMPLE_RATE;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = typeof raw === "number" ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

export function resolveTracePropagationTargets(
  backendUrl: string | undefined,
): string[] {
  const targets = ["localhost"];
  if (!backendUrl) return targets;
  try {
    const host = new URL(backendUrl).hostname;
    if (host && !targets.includes(host)) targets.push(host);
  } catch {
    // Unparseable backend URL: localhost only.
  }
  return targets;
}

/** Redact key material, tokens and embedded photo payloads from free text. */
export function redactText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) =>
      match.startsWith("data:image") ? REDACTED_IMAGE : REDACTED,
    );
  }
  return out;
}

/** Keep origin + path; drop query strings and fragments (tokens, coords). */
export function scrubRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[redacted-url]";
  }
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value === "object" && value !== null) {
    return scrubBreadcrumbData(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Withhold private media/location/chat payloads by key name; redact secret
 * shapes inside every remaining string. Numbers/booleans pass through.
 */
export function scrubBreadcrumbData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (WITHHELD_KEY.test(key)) {
      out[key] = WITHHELD;
      continue;
    }
    if (key === "body" || key === "request_body") {
      out[key] = WITHHELD;
      continue;
    }
    out[key] = scrubValue(value);
  }
  return out;
}

/**
 * Privacy posture asserted by tests: no default PII, no session replay.
 * Spread into `Sentry.init` so the posture cannot drift silently.
 */
export function getSentryPrivacyDefaults(): {
  sendDefaultPii: false;
  replaysSessionSampleRate: 0;
  replaysOnErrorSampleRate: 0;
} {
  return {
    sendDefaultPii: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  };
}

/** Cut `?query` and `#fragment` (tokens, coordinates) from any path/URL. */
export function stripQueryAndFragment(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON deep clone. Throws on circular/unserializable input (fail closed). */
function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const UNSAFE_SUBSTRINGS: string[] = [OR_KEY_HEAD, SUPA_SECRET_HEAD, SUPA_PUBLISHABLE_HEAD, GOOGLE_API_KEY_HEAD, GITHUB_PAT_HEAD, GITHUB_OAUTH_HEAD];
const UNSAFE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /data:image\/[a-zA-Z+]+;base64,/,
  /blob:\S+/,
  // Broader than SECRET_PATTERNS: catch email that might survive redaction
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  // Broader: catch query/fragment in URL-like fields (any ? or # in a value that looks like a URL)
  /https?:\/\/[^?#\s]*[?#]/,
  // Broader: catch high-entropy hex tokens (32+ chars)
  /\b[0-9a-f]{32,}\b/,
  // Broader: catch high-entropy base64-ish tokens (43+ chars)
  /\b[A-Za-z0-9_-]{43,}\b/,
  // Broader: catch credential-in-URL pattern (://user:pass@)
  /:\/\/[^:]+:[^@]+@/,
];

/**
 * Post-scrub tripwire: true when a protected shape survived sanitization.
 * Callers must DISCARD the event/breadcrumb (return null), never forward raw.
 */
function containsUnsafeValue(serialized: string): boolean {
  for (const head of UNSAFE_SUBSTRINGS) {
    if (head && serialized.includes(head)) return true;
  }
  for (const pattern of UNSAFE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(serialized)) return true;
  }
  return false;
}

/** Scrub one stack frame: strip query/fragment from paths, redact strings. */
function scrubStackFrame(frame: Record<string, unknown>): void {
  for (const key of ["filename", "abs_path"]) {
    const raw = frame[key];
    if (typeof raw === "string") {
      frame[key] = redactText(stripQueryAndFragment(raw));
    }
  }
  for (const [key, value] of Object.entries(frame)) {
    if (key === "filename" || key === "abs_path") continue;
    if (typeof value === "string") frame[key] = redactText(value);
  }
}

/** Visit every stack frame in exception/thread `values` lists. */
function eachStackFrame(
  values: unknown,
  visit: (frame: Record<string, unknown>) => void,
): void {
  if (!Array.isArray(values)) return;
  for (const item of values) {
    if (!isRecord(item)) continue;
    const stacktrace = item["stacktrace"];
    if (!isRecord(stacktrace)) continue;
    const frames = stacktrace["frames"];
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (isRecord(frame)) visit(frame);
    }
  }
}

/**
 * Fail-closed event sanitizer used by `beforeSend`. Returns a scrubbed clone,
 * or `null` when the input is not an object, sanitization throws, or a
 * protected shape survives scrubbing. `null` tells Sentry to DISCARD the
 * event — the original is never forwarded.
 */
export function sanitizeSentryEvent(
  event: unknown,
): Record<string, unknown> | null {
  try {
    if (!isRecord(event)) return null;
    const clean = deepCloneJson(event);
    if (typeof clean["message"] === "string") {
      clean["message"] = redactText(clean["message"]);
    }
    const logentry = clean["logentry"];
    if (isRecord(logentry)) {
      for (const key of ["message", "formatted"]) {
        if (typeof logentry[key] === "string") {
          logentry[key] = redactText(logentry[key] as string);
        }
      }
    }
    if (typeof clean["transaction"] === "string") {
      clean["transaction"] = redactText(
        stripQueryAndFragment(clean["transaction"] as string),
      );
    }
    if (typeof clean["release"] === "string") {
      clean["release"] = redactText(clean["release"] as string);
    }
    const exception = clean["exception"];
    if (isRecord(exception)) {
      const values = exception["values"];
      if (Array.isArray(values)) {
        for (const item of values) {
          if (!isRecord(item)) continue;
          if (typeof item["value"] === "string") {
            item["value"] = redactText(item["value"]);
          }
          if (typeof item["type"] === "string") {
            item["type"] = redactText(item["type"]);
          }
          // M4: scrub exception[].module (code_file can carry query strings)
          const module = item["module"];
          if (isRecord(module)) {
            for (const [key, value] of Object.entries(module)) {
              if (typeof value === "string") {
                // Strip query/fragment from code_file and similar path fields
                if (key === "code_file" || key === "filename" || key === "abs_path") {
                  module[key] = redactText(stripQueryAndFragment(value));
                } else {
                  module[key] = redactText(value);
                }
              }
            }
          }
        }
      }
      eachStackFrame(exception["values"], scrubStackFrame);
    }
    const threads = clean["threads"];
    if (isRecord(threads)) {
      const threadValues = threads["values"];
      if (Array.isArray(threadValues)) {
        for (const thread of threadValues) {
          if (!isRecord(thread)) continue;
          if (typeof thread["name"] === "string") {
            thread["name"] = redactText(thread["name"]);
          }
        }
      }
      eachStackFrame(threads["values"], scrubStackFrame);
    }
    // M3: Handle transaction events — spans carry url.full, http.query, http.fragment
    const spans = clean["spans"];
    if (Array.isArray(spans)) {
      for (const span of spans) {
        if (!isRecord(span)) continue;
        if (typeof span["description"] === "string") {
          span["description"] = redactText(stripQueryAndFragment(span["description"]));
        }
        const data = span["data"];
        if (isRecord(data)) {
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === "string") {
              // http.query and http.fragment are already just the query/fragment parts — redact entirely
              // url.full is a full URL — strip query/fragment then redact
              if (key === "http.query" || key === "http.fragment") {
                data[key] = REDACTED;
              } else if (key === "url.full") {
                data[key] = redactText(stripQueryAndFragment(value));
              } else {
                data[key] = redactText(value);
              }
            }
          }
        }
      }
    }
    const request = clean["request"];
    if (isRecord(request)) {
      if (typeof request["url"] === "string") {
        request["url"] = scrubRequestUrl(request["url"]);
      }
      // Bodies, headers, cookies and raw query strings never leave the device.
      delete request["headers"];
      delete request["cookies"];
      delete request["query_string"];
      delete request["data"];
      if (typeof request["method"] === "string") {
        request["method"] = redactText(request["method"] as string);
      }
    }
    // Identity is never attached.
    delete clean["user"];
    const tags = clean["tags"];
    if (isRecord(tags)) {
      for (const [key, value] of Object.entries(tags)) {
        if (typeof value === "string") {
          tags[key] = redactText(stripQueryAndFragment(value));
        }
      }
    }
    if (isRecord(clean["contexts"])) {
      clean["contexts"] = scrubValue(clean["contexts"]);
    }
    if (isRecord(clean["extra"])) {
      clean["extra"] = scrubBreadcrumbData(clean["extra"]);
    }
    if (Array.isArray(clean["breadcrumbs"])) {
      const kept: Record<string, unknown>[] = [];
      for (const crumb of clean["breadcrumbs"]) {
        const sanitized = sanitizeSentryBreadcrumb(crumb);
        if (sanitized) kept.push(sanitized);
      }
      clean["breadcrumbs"] = kept;
    }
    if (containsUnsafeValue(JSON.stringify(clean))) return null;
    return clean;
  } catch {
    return null;
  }
}

/**
 * Fail-closed breadcrumb sanitizer used by `beforeBreadcrumb` and event
 * scrubbing. Returns a scrubbed clone, or `null` when the input is not an
 * object, sanitization throws, or a protected shape survives. `null` DROPS
 * the breadcrumb — it is never forwarded raw.
 */
export function sanitizeSentryBreadcrumb(
  crumb: unknown,
): Record<string, unknown> | null {
  try {
    if (!isRecord(crumb)) return null;
    const clean = deepCloneJson(crumb);
    if (typeof clean["message"] === "string") {
      clean["message"] = redactText(clean["message"]);
    }
    if (typeof clean["category"] === "string") {
      clean["category"] = redactText(clean["category"] as string);
    }
    if (typeof clean["type"] === "string") {
      clean["type"] = redactText(clean["type"] as string);
    }
    if (isRecord(clean["data"])) {
      const data = scrubBreadcrumbData(clean["data"]);
      // B1: SDK navigation breadcrumbs use data.from / data.to with full URL (query + fragment)
      // Also defensively strip query/fragment from ANY string value in breadcrumb data
      // since query strings are never needed for crash triage.
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string") {
          // First redact secrets, then strip query/fragment
          data[key] = stripQueryAndFragment(redactText(value));
        }
      }
      clean["data"] = data;
    }
    if (containsUnsafeValue(JSON.stringify(clean))) return null;
    return clean;
  } catch {
    return null;
  }
}

/**
 * Fail-closed log sanitizer used by `beforeSendLog`. Returns a scrubbed
 * clone, or `null` when the input is not an object, sanitization throws, or
 * a protected shape survives scrubbing. `null` DISCARDS the log — the
 * original is never forwarded. Mirrors `sanitizeSentryBreadcrumb`: message
 * and body are redacted, `attributes` go through the same
 * WITHHELD-key/redactText scrubbing plus query/fragment stripping.
 */
export function sanitizeSentryLog(
  log: unknown,
): Record<string, unknown> | null {
  try {
    if (!isRecord(log)) return null;
    const clean = deepCloneJson(log);
    if (typeof clean["message"] === "string") {
      clean["message"] = redactText(clean["message"]);
    }
    if (typeof clean["body"] === "string") {
      clean["body"] = redactText(clean["body"]);
    }
    if (typeof clean["level"] === "string") {
      clean["level"] = redactText(clean["level"] as string);
    }
    if (isRecord(clean["attributes"])) {
      const attributes = scrubBreadcrumbData(clean["attributes"]);
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value === "string") {
          attributes[key] = stripQueryAndFragment(redactText(value));
        }
      }
      clean["attributes"] = attributes;
    }
    if (containsUnsafeValue(JSON.stringify(clean))) return null;
    return clean;
  } catch {
    return null;
  }
}

/**
 * Build the synthetic self-test payload: fixed message + fixed tag, no user
 * data. Used by `sendMonitoringTestSignal` for the one-event device proof.
 */
export function buildMonitoringTestSignalEvent(): {
  message: string;
  level: "info";
  tags: Record<string, string>;
  extra: Record<string, string | boolean>;
} {
  return {
    message: MONITORING_TEST_SIGNAL_MESSAGE,
    level: "info",
    tags: {
      monitoringSelfTest: MONITORING_TEST_SIGNAL_TAG_VALUE,
      synthetic: "true",
    },
    extra: {
      synthetic: true,
      source: "monitoring-self-test",
    },
  };
}

function readEnv(key: string): string | undefined {
  try {
    const value = (import.meta.env[key] as string | undefined) ?? undefined;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

let started = false;
let cachedDsn: string | null = null;

function getBackendHost(): string | undefined {
  const url = readEnv("VITE_SUPABASE_URL");
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Initialize crash reporting. Safe to call on every launch: returns
 * immediately when no DSN is configured and never throws.
 */
export function initMonitoring(): void {
  if (started) return;
  started = true;
  const dsn = resolveSentryDsn(readEnv("VITE_SENTRY_DSN"));
  if (!dsn) return;
  cachedDsn = dsn;
  const environment = resolveSentryEnvironment(
    readEnv("VITE_SENTRY_ENVIRONMENT"),
    readEnv("MODE") ?? import.meta.env.MODE,
  );
  const tracesSampleRate = resolveTracesSampleRate(
    readEnv("VITE_SENTRY_TRACES_SAMPLE_RATE"),
  );
  const backendHost = getBackendHost();
  const tracePropagationTargets = backendHost
    ? ["localhost", backendHost]
    : ["localhost"];
  void (async () => {
    try {
      const [Sentry, SentryReact] = await Promise.all([
        import("@sentry/capacitor"),
        import("@sentry/react"),
      ]);
      Sentry.init(
        {
          dsn,
          environment,
          // Release identity (S3): same findback-mobile@version+sha string the
          // release workflow passes to the sourcemap upload, so Sentry can
          // symbolicate. Undefined when not baked (dev/test) — SDK default.
          release: resolveSentryRelease({ VITE_SENTRY_RELEASE: readEnv("VITE_SENTRY_RELEASE") }) ?? undefined,
          // Dist identity (SYNC-9): matches the --dist value the sourcemap
          // upload for this lane passes, so SDK events join the uploaded
          // debug-info. Undefined when absent/unknown — never a placeholder.
          dist: resolveSentryDist(readEnv("VITE_SENTRY_DIST")) ?? undefined,
          tracesSampleRate,
          tracePropagationTargets,
          // Maximum logging: Sentry Logs on. Every log passes through
          // beforeSendLog -> sanitizeSentryLog (same fail-closed scrubbing
          // as events/breadcrumbs), so this does not weaken the posture.
          enableLogs: SENTRY_LOGS_ENABLED,
          // Privacy posture: no identity, no replay, no bodies.
          ...getSentryPrivacyDefaults(),
          beforeSend(event) {
            // Fail closed: unsafe input DISCARDS the event (null), never raw.
            return sanitizeSentryEvent(event) as unknown as typeof event | null;
          },
          beforeSendTransaction(event) {
            // M3: Transactions bypass beforeSend entirely; sanitize them too.
            // Spans carry url.full, http.query, http.fragment — same leak class as B1.
            return sanitizeSentryEvent(event) as unknown as typeof event | null;
          },
          beforeSendLog(log) {
            // Fail closed: unsafe input DISCARDS the log (null), never raw.
            return sanitizeSentryLog(log) as unknown as typeof log | null;
          },
          beforeBreadcrumb(crumb) {
            // Fail closed: unsafe input DROPS the breadcrumb (null).
            return sanitizeSentryBreadcrumb(crumb) as unknown as
              | typeof crumb
              | null;
          },
        },
        SentryReact.init,
      );
    } catch {
      cachedDsn = null;
    }
  })();
}

/** Forward an actionable error. No-op unless monitoring initialized with a DSN. */
export function reportErrorToMonitoring(
  error: unknown,
  context?: Record<string, string>,
): void {
  if (!cachedDsn) return;
  const safeContext: Record<string, string> = {};
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      safeContext[key] = WITHHELD_KEY.test(key) ? WITHHELD : redactText(value);
    }
  }
  void (async () => {
    try {
      const Sentry = await import("@sentry/capacitor");
      Sentry.captureException(error, { extra: safeContext });
    } catch {
      // Monitoring must never break the app.
    }
  })();
}

/**
 * Forward an info/debug-level log via Sentry Logs. No-op unless monitoring
 * initialized with a DSN. Mirrors `reportErrorToMonitoring`: the message is
 * redacted and context keys matching private media/location/chat/credential
 * shapes are withheld before anything leaves the device.
 */
export function reportLogToMonitoring(
  level: MonitoringLogLevel,
  message: string,
  context?: Record<string, string>,
): void {
  if (!cachedDsn) return;
  const safeMessage = redactText(message);
  const safeContext: Record<string, string> = {};
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      safeContext[key] = WITHHELD_KEY.test(key) ? WITHHELD : redactText(value);
    }
  }
  void (async () => {
    try {
      const Sentry = await import("@sentry/capacitor");
      switch (level) {
        case "info":
          Sentry.logger.info(safeMessage, safeContext);
          break;
        case "warn":
          Sentry.logger.warn(safeMessage, safeContext);
          break;
        case "error":
          Sentry.logger.error(safeMessage, safeContext);
          break;
      }
    } catch {
      // Monitoring must never break the app.
    }
  })();
}

/**
 * Controlled verification signal. Captures a clearly-labelled synthetic test
 * message (fixed tag, no user data) so one controlled event can be confirmed
 * in Sentry, e.g. from the installed APK. Returns false when monitoring is off.
 */
export function sendMonitoringTestSignal(): boolean {
  if (!cachedDsn) return false;
  const signal = buildMonitoringTestSignalEvent();
  void (async () => {
    try {
      const Sentry = await import("@sentry/capacitor");
      Sentry.captureMessage(signal.message, {
        level: signal.level,
        tags: signal.tags,
        extra: signal.extra,
      });
    } catch {
      // Ignore: verification is best-effort outside release builds.
    }
  })();
  return true;
}

/**
 * Checks whether the monitoring self-test UI should be enabled.
 * Only returns true when VITE_MONITORING_SELFTEST is exactly "true".
 */
export function monitoringSelfTestEnabled(
  env?: { VITE_MONITORING_SELFTEST?: string },
): boolean {
  return env?.VITE_MONITORING_SELFTEST === "true";
}

/**
 * Async variant of the monitoring test signal that returns the Sentry event ID.
 * Resolves to the event ID string when `captureMessage` returns one, or `null`
 * when monitoring is uninitialized (no DSN) or the SDK throws.
 * Reuses `buildMonitoringTestSignalEvent()` and `cachedDsn`.
 */
export async function sendMonitoringTestSignalAsync(): Promise<
  string | null
> {
  if (!cachedDsn) return null;
  const signal = buildMonitoringTestSignalEvent();
  try {
    const Sentry = await import("@sentry/capacitor");
    const eventId = await Sentry.captureMessage(signal.message, {
      level: signal.level,
      tags: signal.tags,
      extra: signal.extra,
    });
    return eventId ?? null;
  } catch {
    return null;
  }
}
