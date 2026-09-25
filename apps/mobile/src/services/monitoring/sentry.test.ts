import { describe, expect, it } from "vitest";
import {
  redactText,
  resolveSentryDsn,
  resolveSentryEnvironment,
  resolveTracePropagationTargets,
  resolveTracesSampleRate,
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
