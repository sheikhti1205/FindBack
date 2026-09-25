/**
 * Privacy-safe crash reporting for the Capacitor mobile app.
 *
 * Design notes:
 * - The Sentry DSN is a public client value read from `VITE_SENTRY_DSN`.
 *   Without it, every function below is a no-op: the app runs unchanged.
 * - Session replay stays disabled and request bodies are never attached.
 * - BYOK key material, chat text, photo bytes, precise location and auth
 *   tokens are redacted/withheld before anything leaves the device.
 * - The Sentry SDK is loaded with a dynamic import inside `initMonitoring`
 *   so unit tests and DSN-less runs never touch native code.
 */

export const SENTRY_DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const REDACTED = "[redacted]";
const REDACTED_IMAGE = "[redacted-image]";
const WITHHELD = "[withheld-privacy]";

// Built from parts so this shipped module never contains a secret-shaped
// literal of its own.
const OR_KEY_HEAD = ["sk", "or"].join("-") + "-";
const SUPA_SECRET_HEAD = ["sb", "secret"].join("_") + "_";

const SECRET_PATTERNS: RegExp[] = [
  new RegExp(`${OR_KEY_HEAD}[A-Za-z0-9_.-]{8,}`, "g"),
  new RegExp(`${SUPA_SECRET_HEAD}[A-Za-z0-9_-]{8,}`, "g"),
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g,
];

const WITHHELD_KEY = /(photo|image|audio|video|location|latitude|longitude|transcript|chat|conversation|credential|passphrase)/i;

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
          tracesSampleRate,
          tracePropagationTargets,
          // Privacy posture: no identity, no replay integration, no bodies.
          sendDefaultPii: false,
          beforeSend(event) {
            try {
              if (typeof event.message === "string") {
                event.message = redactText(event.message);
              }
              const exceptions = event.exception?.values;
              if (exceptions) {
                for (const item of exceptions) {
                  if (typeof item.value === "string") {
                    item.value = redactText(item.value);
                  }
                }
              }
              if (event.request?.url) {
                event.request.url = scrubRequestUrl(event.request.url);
              }
              if (event.request) {
                delete event.request.headers;
                delete event.request.cookies;
              }
              if (event.breadcrumbs) {
                for (const crumb of event.breadcrumbs) {
                  if (typeof crumb.message === "string") {
                    crumb.message = redactText(crumb.message);
                  }
                  if (crumb.data) {
                    const data = scrubBreadcrumbData(
                      crumb.data as Record<string, unknown>,
                    );
                    if (typeof data["url"] === "string") {
                      data["url"] = scrubRequestUrl(data["url"]);
                    }
                    crumb.data = data;
                  }
                }
              }
              if (event.extra && typeof event.extra === "object") {
                event.extra = scrubBreadcrumbData(
                  event.extra as Record<string, unknown>,
                );
              }
              delete event.user;
            } catch {
              // Scrubbing must never drop the report itself.
            }
            return event;
          },
          beforeBreadcrumb(crumb) {
            try {
              if (typeof crumb.message === "string") {
                crumb.message = redactText(crumb.message);
              }
              if (crumb.data) {
                const data = scrubBreadcrumbData(
                  crumb.data as Record<string, unknown>,
                );
                if (typeof data["url"] === "string") {
                  data["url"] = scrubRequestUrl(data["url"]);
                }
                crumb.data = data;
              }
            } catch {
              // Keep the breadcrumb rather than lose context.
            }
            return crumb;
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
 * Controlled verification signal. Captures a clearly-labelled test message
 * (no user data) so one controlled event can be confirmed in Sentry, e.g.
 * from the installed APK. Returns false when monitoring is off.
 */
export function sendMonitoringTestSignal(): boolean {
  if (!cachedDsn) return false;
  void (async () => {
    try {
      const Sentry = await import("@sentry/capacitor");
      Sentry.captureMessage("FindBack monitoring test signal", "info");
    } catch {
      // Ignore: verification is best-effort outside release builds.
    }
  })();
  return true;
}
