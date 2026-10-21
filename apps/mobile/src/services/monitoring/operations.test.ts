import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the REAL sanitizer; only the dispatch sink is faked so tests can
// capture exactly what the seam would forward.
vi.mock("./sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sentry")>();
  return { ...actual, reportLogToMonitoring: vi.fn() };
});

import { recordOperation } from "./operations";
import { reportLogToMonitoring } from "./sentry";

const mockedReportLog = vi.mocked(reportLogToMonitoring);

// Assembled at runtime so this file never contains a secret-shaped literal
// that the repository secret scanner would flag.
const OR_HEAD = ["sk", "or"].join("-") + "-";
const SUPA_SECRET_HEAD = ["sb", "secret"].join("_") + "_";
const SUPA_PUB_HEAD = ["sb", "publishable"].join("_") + "_";
const GOOGLE_HEAD = "AIza";
const JWT_TAIL = "c2lnbmF0dXJl";
const BEARER_TAIL = "zzz9yyy8xxx7www6vvv5";
const EMAIL_AT = ["aisha.khan", "mail.com"].join("@");
const PHONE_DIGITS = "5551234567";

function maliciousValues(): unknown[] {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "cGF5bG9hZA", JWT_TAIL].join(".");
  return [
    `${OR_HEAD}v1-abcdef1234567890`, // provider key
    `${SUPA_SECRET_HEAD}abc123def456ghi789`, // supabase secret key
    `${SUPA_PUB_HEAD}abcdefghijklmnopqrstuvwxyz`, // supabase publishable key
    `${GOOGLE_HEAD}SyD-abcdefghijklmnopqrstuvwxyz123456`, // google key
    jwt, // id token
    `Bearer ${BEARER_TAIL}`, // auth token
    EMAIL_AT, // email
    `+1${PHONE_DIGITS}`, // phone
    "23.810331", // coordinate (float-shaped)
    "23.810331,90.412521", // coordinate pair
    23.810331, // coordinate as a number
    ["content", "media/external/images/123"].join("://"), // content URI
    "blob:https://example.com/uuid-photo-bytes", // content URI
    "summarize my private chat history please", // prompt
    "receipt total 42.50 thanks for shopping", // OCR text
    "this is my private comment body text", // comment text
  ];
}

function capturedText(): string {
  return JSON.stringify(mockedReportLog.mock.calls);
}

beforeEach(() => {
  mockedReportLog.mockClear();
});

describe("recordOperation (allowlisted seam)", () => {
  it("accepts report attachment kind as a token without any target metadata", () => {
    recordOperation({ name: "social.comment", fields: { ok: true, attachmentCount: 1, attachmentKind: "report" } });
    expect(mockedReportLog).toHaveBeenCalledWith("info", "op:social.comment", {
      op: "social.comment", ok: "true", attachmentCount: "1", attachmentKind: "report",
    });
  });
  it("dispatches allowlisted events with counts/codes/booleans/enums only", () => {
    expect(() =>
      recordOperation({ name: "app.boot", fields: { ok: true } }),
    ).not.toThrow();
    expect(mockedReportLog).toHaveBeenCalledWith(
      "info",
      "op:app.boot",
      expect.objectContaining({ op: "app.boot", ok: "true" }),
    );

    mockedReportLog.mockClear();
    expect(() =>
      recordOperation({
        name: "map.search",
        fields: { resultClass: "few", rateLimited: false },
      }),
    ).not.toThrow();
    expect(mockedReportLog).toHaveBeenCalledWith(
      "info",
      "op:map.search",
      expect.objectContaining({ resultClass: "few", rateLimited: "false" }),
    );

    mockedReportLog.mockClear();
    expect(() =>
      recordOperation({
        name: "social.comment",
        fields: { ok: true, attachmentCount: 2, attachmentKind: "mixed" },
      }),
    ).not.toThrow();
    expect(mockedReportLog).toHaveBeenCalledWith(
      "info",
      "op:social.comment",
      expect.objectContaining({ attachmentCount: "2" }),
    );
  });

  it("throws (fail closed) on unknown event names", () => {
    expect(() =>
      recordOperation({ name: "evil.exfil", fields: {} } as never),
    ).toThrow();
    expect(() =>
      recordOperation({ name: "social.comment.body", fields: {} } as never),
    ).toThrow();
    expect(mockedReportLog).not.toHaveBeenCalled();
  });

  it("throws (fail closed) on off-allowlist fields", () => {
    expect(() =>
      recordOperation({
        name: "social.comment",
        fields: { ok: true, attachmentCount: 0, body: "hi" },
      } as never),
    ).toThrow();
    expect(() =>
      recordOperation({
        name: "map.search",
        fields: { resultClass: "few", rateLimited: false, query: "x" },
      } as never),
    ).toThrow();
    expect(() =>
      recordOperation({
        name: "auth.google.error",
        fields: { mode: "signin", code: "unknown", token: "x" },
      } as never),
    ).toThrow();
    expect(mockedReportLog).not.toHaveBeenCalled();
  });

  it("throws (fail closed) on missing required fields and wrong value shapes", () => {
    expect(() =>
      recordOperation({ name: "social.comment", fields: { ok: true } } as never),
    ).toThrow();
    expect(() =>
      recordOperation({
        name: "social.comment",
        fields: { ok: "yes", attachmentCount: 0 },
      } as never),
    ).toThrow();
    expect(() =>
      recordOperation({
        name: "map.search",
        fields: { resultClass: "everything", rateLimited: false },
      } as never),
    ).toThrow();
    expect(mockedReportLog).not.toHaveBeenCalled();
  });

  it("never forwards email/phone/token/keys/URIs/coords/content/prompt/OCR/body-text", () => {
    for (const value of maliciousValues()) {
      try {
        recordOperation({
          name: "social.comment",
          fields: { ok: false, code: value, attachmentCount: 0 },
        } as never);
      } catch {
        // Fail-closed throw: nothing forwarded.
      }
      try {
        recordOperation({
          name: "auth.google.error",
          fields: { mode: "signin", code: value },
        } as never);
      } catch {
        // Fail-closed throw: nothing forwarded.
      }
    }
    const text = capturedText();
    for (const marker of [
      OR_HEAD,
      SUPA_SECRET_HEAD,
      SUPA_PUB_HEAD,
      GOOGLE_HEAD,
      JWT_TAIL,
      BEARER_TAIL,
      EMAIL_AT,
      PHONE_DIGITS,
      "23.810331",
      "90.412521",
      "content://",
      "blob:https://example.com/uuid-photo-bytes",
      "summarize my private chat",
      "receipt total 42.50",
      "my private comment body",
    ]) {
      expect(text).not.toContain(marker);
    }
  });
});
