import { describe, expect, it } from "vitest";
import {
  buildMonitoringTestSignalEvent,
  getSentryPrivacyDefaults,
  MONITORING_TEST_SIGNAL_MESSAGE,
  MONITORING_TEST_SIGNAL_TAG_VALUE,
  redactText,
  resolveSentryDsn,
  resolveSentryEnvironment,
  resolveTracePropagationTargets,
  resolveTracesSampleRate,
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  scrubBreadcrumbData,
  scrubRequestUrl,
} from "./sentry";

// Assembled at runtime so this file never contains a secret-shaped literal
// that the repository secret scanner would flag.
const SUPA_SECRET_PREFIX = ["sb", "secret"].join("_") + "_";
const OR_KEY_PREFIX = ["sk", "or"].join("-") + "-v1-";
const JWT_LIKE = ["eyJhbGciOiJIUzI1NiJ9", "cGF5bG9hZA", "c2lnbmF0dXJl"].join(".");

describe("resolveSentryDsn", () => {
  it("accepts an https DSN and rejects blanks/non-https", () => {
    expect(resolveSentryDsn("https://abc123@o123.ingest.sentry.io/456")).toBe(
      "https://abc123@o123.ingest.sentry.io/456",
    );
    expect(resolveSentryDsn("")).toBeNull();
    expect(resolveSentryDsn(undefined)).toBeNull();
    expect(resolveSentryDsn("http://abc123@o123.ingest.sentry.io/456")).toBeNull();
    expect(resolveSentryDsn("not-a-url")).toBeNull();
  });
});

describe("resolveSentryEnvironment", () => {
  it("prefers the explicit env value, then mode, then production", () => {
    expect(resolveSentryEnvironment("staging", "development")).toBe("staging");
    expect(resolveSentryEnvironment("", "development")).toBe("development");
    expect(resolveSentryEnvironment(undefined, undefined)).toBe("production");
  });
});

describe("resolveTracesSampleRate", () => {
  it("defaults to 0.1 and clamps out-of-range input", () => {
    expect(resolveTracesSampleRate(undefined)).toBe(0.1);
    expect(resolveTracesSampleRate("")).toBe(0.1);
    expect(resolveTracesSampleRate("junk")).toBe(0.1);
    expect(resolveTracesSampleRate("0.5")).toBe(0.5);
    expect(resolveTracesSampleRate("2")).toBe(1);
    expect(resolveTracesSampleRate("-1")).toBe(0);
  });
});

describe("redactText", () => {
  it("redacts provider key material but keeps ordinary wording", () => {
    expect(redactText("my reports list")).toBe("my reports list");
    expect(redactText(`key is ${OR_KEY_PREFIX}abcdef1234567890`)).not.toContain(
      OR_KEY_PREFIX,
    );
    expect(redactText(`token ${SUPA_SECRET_PREFIX}abc123def456`)).not.toContain(
      SUPA_SECRET_PREFIX,
    );
    expect(redactText("header Bearer abcdefghijklmnop")).not.toContain(
      "abcdefghijklmnop",
    );
    expect(redactText(`jwt ${JWT_LIKE} here`)).not.toContain("c2lnbmF0dXJl");
  });

  it("redacts embedded photo data URLs", () => {
    const dirty = "see data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ== end";
    expect(redactText(dirty)).not.toContain("/9j/4AAQSkZJRgABAQ");
    expect(redactText(dirty)).toContain("[redacted-image]");
  });
});

describe("scrubRequestUrl", () => {
  it("keeps origin and path but drops query and fragment", () => {
    expect(scrubRequestUrl("https://example.supabase.co/rest/v1/posts?lat=23.8&key=abc#frag")).toBe(
      "https://example.supabase.co/rest/v1/posts",
    );
    expect(scrubRequestUrl("not a url")).toBe("[redacted-url]");
  });
});

describe("scrubBreadcrumbData", () => {
  it("withholds private media/location/chat payloads and redacts strings", () => {
    const out = scrubBreadcrumbData({
      photoBytes: "data:image/png;base64,iVBORw0KGgo=",
      latitude: 23.81,
      chatTranscript: "hello",
      note: `key ${OR_KEY_PREFIX}abcdef1234567890`,
      page: 2,
    }) as Record<string, unknown>;
    expect(out["photoBytes"]).toBe("[withheld-privacy]");
    expect(out["latitude"]).toBe("[withheld-privacy]");
    expect(out["chatTranscript"]).toBe("[withheld-privacy]");
    expect(String(out["note"])).not.toContain(OR_KEY_PREFIX);
    expect(out["page"]).toBe(2);
  });
});

describe("resolveTracePropagationTargets", () => {
  it("always includes localhost plus the configured backend host", () => {
    const targets = resolveTracePropagationTargets("https://example.supabase.co");
    expect(targets).toContain("localhost");
    expect(targets).toContain("example.supabase.co");
    expect(resolveTracePropagationTargets(undefined)).toEqual(["localhost"]);
  });
});

// --- S2 synthetic privacy fixtures (fail-closed hardening) ---
// Assembled at runtime so this file never contains a secret-shaped literal.
const FIX_OR_KEY = `${OR_KEY_PREFIX}abcdef1234567890`;
const FIX_SUPA_SECRET = `${SUPA_SECRET_PREFIX}abc123def456ghi789`;
const FIX_JWT = JWT_LIKE;
const FIX_BEARER = "Bearer zzz9yyy8xxx7www6vvv5";
const FIX_LAT = 23.810331;
const FIX_LNG = 90.412521;

function buildAdversarialEvent(): Record<string, unknown> {
  return {
    message: `request failed with ${FIX_OR_KEY} retried`,
    exception: {
      values: [
        {
          type: "Error",
          value: `boom ${FIX_SUPA_SECRET} jwt=${FIX_JWT} auth=${FIX_BEARER}`,
          stacktrace: {
            frames: [
              {
                filename: `https://cdn.example.com/bundle.js?token=${FIX_OR_KEY}#frag`,
                abs_path: `https://cdn.example.com/bundle.js?key=${FIX_SUPA_SECRET}`,
                module: "app",
                function: "onTap",
              },
            ],
          },
        },
      ],
    },
    request: {
      url: `https://example.supabase.co/rest/v1/reports?api_key=${FIX_OR_KEY}&lat=${FIX_LAT}#frag`,
      method: "POST",
      headers: { Authorization: FIX_BEARER, "X-Api-Key": FIX_OR_KEY },
      cookies: "session=abc",
      query_string: `api_key=${FIX_OR_KEY}`,
      data: { prompt: "summarize my private chat", body: "photo bytes here" },
    },
    user: { id: "user-1", email: "someone@example.com" },
    tags: { route: `home?token=${FIX_OR_KEY}` },
    transaction: `open?key=${FIX_SUPA_SECRET}`,
    contexts: {
      app: { app_name: "FindBack" },
      custom: { note: `leaked ${FIX_JWT}` },
    },
    extra: {
      nested: { deep: { token: FIX_BEARER } },
      coords: { lat: FIX_LAT, lng: FIX_LNG },
      aiPrompt: "my secret prompt text",
      aiResponse: "model answer text",
      chatHistory: [{ role: "user", text: "private chat line" }],
      photoBlob: "blob:https://example.com/uuid-photo-bytes",
      reportBody: "sensitive report content",
      plainCount: 7,
    },
    breadcrumbs: [
      {
        message: `navigated with ${FIX_OR_KEY}`,
        data: { url: `https://example.com/page?token=${FIX_JWT}`, note: "ok" },
      },
    ],
  };
}

function serialized(result: unknown): string {
  return JSON.stringify(result ?? null);
}

describe("sanitizeSentryEvent (fail-closed)", () => {
  it("strips every excluded class from adversarial placements", () => {
    const result = sanitizeSentryEvent(buildAdversarialEvent());
    expect(result).not.toBeNull();
    const text = serialized(result);
    for (const secret of [OR_KEY_PREFIX, SUPA_SECRET_PREFIX, "c2lnbmF0dXJl", "zzz9yyy8xxx7www6vvv5"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("someone@example.com");
    expect(text).not.toContain("summarize my private chat");
    expect(text).not.toContain("private chat line");
    expect(text).not.toContain("sensitive report content");
    expect(text).not.toContain("blob:https://example.com/uuid-photo-bytes");
    expect(text).not.toContain(String(FIX_LAT));
    expect(text).not.toContain(String(FIX_LNG));
    expect(text).not.toContain("api_key=");
    expect(text).not.toContain("#frag");
    expect(text).not.toContain("session=abc");
  });

  it("keeps origin+path allowlist shape for request/frame URLs", () => {
    const result = sanitizeSentryEvent(buildAdversarialEvent()) as Record<string, unknown>;
    const request = result["request"] as Record<string, unknown>;
    expect(request["url"]).toBe("https://example.supabase.co/rest/v1/reports");
    expect(request["method"]).toBe("POST");
    expect(request).not.toHaveProperty("headers");
    expect(request).not.toHaveProperty("cookies");
    expect(request).not.toHaveProperty("query_string");
    expect(request).not.toHaveProperty("data");
    expect(result).not.toHaveProperty("user");
    const values = (
      result["exception"] as { values: { stacktrace: { frames: { filename: string }[] } }[] }
    ).values;
    const first = values[0] as { stacktrace: { frames: { filename: string }[] } };
    const frame = first.stacktrace.frames[0] as { filename: string };
    expect(frame.filename).not.toContain("?");
    expect(frame.filename).not.toContain("#");
    expect(result["plainCount"]).toBeUndefined();
    expect((result["extra"] as Record<string, unknown>)["plainCount"]).toBe(7);
  });

  it("returns null (DISCARD) when sanitization throws", () => {
    const evil: Record<string, unknown> = {};
    evil["self"] = evil; // circular: deep clone throws -> must discard, never forward raw
    expect(sanitizeSentryEvent({ extra: evil })).toBeNull();
    expect(sanitizeSentryEvent(null)).toBeNull();
    expect(sanitizeSentryEvent("not-an-event")).toBeNull();
  });
});

describe("sanitizeSentryBreadcrumb (fail-closed)", () => {
  it("redacts secrets and drops unsafe breadcrumbs (never raw)", () => {
    const clean = sanitizeSentryBreadcrumb({
      message: `tap ${FIX_JWT} done`,
      data: { url: `https://example.com/x?token=${FIX_OR_KEY}`, note: "ok" },
    }) as Record<string, unknown>;
    expect(clean).not.toBeNull();
    const text = serialized(clean);
    expect(text).not.toContain("c2lnbmF0dXJl");
    expect(text).not.toContain(OR_KEY_PREFIX);
    expect((clean["data"] as Record<string, unknown>)["url"]).toBe("https://example.com/x");
  });

  it("returns null when breadcrumb sanitization throws", () => {
    const evil: Record<string, unknown> = {};
    evil["self"] = evil;
    expect(sanitizeSentryBreadcrumb({ data: evil })).toBeNull();
    expect(sanitizeSentryBreadcrumb(null)).toBeNull();
  });
});

describe("sentry privacy posture", () => {
  it("keeps default PII off and session replay disabled", () => {
    expect(getSentryPrivacyDefaults()).toEqual({
      sendDefaultPii: false,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
  });

  it("labels the synthetic test signal with a fixed tag and no user data", () => {
    const signal = buildMonitoringTestSignalEvent();
    expect(signal.message).toBe(MONITORING_TEST_SIGNAL_MESSAGE);
    expect(signal.tags["monitoringSelfTest"]).toBe(MONITORING_TEST_SIGNAL_TAG_VALUE);
    expect(serialized(signal)).not.toContain("@");
    expect(signal).not.toHaveProperty("user");
  });
});
