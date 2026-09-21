import { beforeEach, describe, expect, it, vi } from "vitest";

const { logEventMock } = vi.hoisted(() => ({ logEventMock: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ logEvent: logEventMock }),
}));

import {
  clearAmbientTrace,
  clearDiagEvents,
  diag,
  diagModelDigest,
  exportDiagJson,
  getDiagEvents,
  isDiagEnabled,
  setDiagEnabled,
  sha256Hex,
  startActionTrace,
} from "./diag";

beforeEach(() => {
  logEventMock.mockReset();
  logEventMock.mockResolvedValue(undefined);
  setDiagEnabled(false);
  clearDiagEvents();
  clearAmbientTrace();
});

describe("gating", () => {
  it("defaults OFF and records nothing while disabled", () => {
    expect(isDiagEnabled()).toBe(false);
    diag("report.publish.start", { hasPhoto: true }, { traceId: "t-0" });
    expect(getDiagEvents()).toHaveLength(0);
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it("records to ring + native sink only once enabled", () => {
    setDiagEnabled(true);
    diag("report.publish.start", { hasPhoto: true }, { traceId: "t-1" });
    expect(getDiagEvents()).toHaveLength(1);
    expect(logEventMock).toHaveBeenCalledTimes(1);
  });
});

describe("redaction", () => {
  it("never lets PII-shaped values survive in ring or bridge payload", () => {
    setDiagEnabled(true);
    diag(
      "report.publish.error",
      {
        message: "duplicate key value violates constraint",
        card: "4111 1111 1111 1111",
        phone: "+880 1712-345678",
        email: "owner@example.com",
        otp: "OTP 483921",
        note: "black wallet",
      },
      { traceId: "t-pii" },
    );
    const [event] = getDiagEvents();
    expect(event).toBeDefined();
    expect(event!.fields.card).toBe("[redacted]");
    expect(event!.fields.phone).toBe("[redacted]");
    expect(event!.fields.email).toBe("[redacted]");
    expect(event!.fields.otp).toBe("[redacted]");
    expect(event!.fields.note).toBe("black wallet");
    const payload = JSON.stringify(event) + String(logEventMock.mock.calls[0]?.[0]?.json ?? "");
    expect(payload).not.toContain("4111");
    expect(payload).not.toContain("owner@example.com");
  });

  it("redacts secret/token keys regardless of value shape", () => {
    setDiagEnabled(true);
    diag(
      "publish.rpc.start",
      {
        rpc: "findback_create_post_client",
        LLM_API_KEY: "sk-abc123",
        Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        apiKey: "sb_publishable_stuff",
        password: "hunter2",
        category: "Electronics",
      },
      { traceId: "t-keys" },
    );
    const [event] = getDiagEvents();
    expect(event!.fields.LLM_API_KEY).toBe("[redacted]");
    expect(event!.fields.Authorization).toBe("[redacted]");
    expect(event!.fields.apiKey).toBe("[redacted]");
    expect(event!.fields.password).toBe("[redacted]");
    expect(event!.fields.category).toBe("Electronics");
    const payload = String(logEventMock.mock.calls[0]?.[0]?.json ?? "");
    expect(payload).not.toContain("sk-abc123");
    expect(payload).not.toContain("hunter2");
  });

  it("redacts provider-key patterns even under innocent keys", () => {
    setDiagEnabled(true);
    diag("vlm.stage2.result", { detail: "key sk-abcdefghijklmnop leaked" }, { traceId: "t-prov" });
    expect(getDiagEvents()[0]!.fields.detail).toBe("[redacted]");
  });
});

describe("model-output digest", () => {
  it("carries length/hash/verdict ONLY — no raw-text field on the standard path", () => {
    setDiagEnabled(true);
    diag(
      "vlm.stage1.result",
      {
        text: "prose wrapping owner@example.com",
        output: "same prose again",
        Content: "and again",
        outputLength: 31,
        parseVerdict: "unparseable",
        attempt: 1,
      },
      { traceId: "t-model" },
    );
    const [event] = getDiagEvents();
    expect(event).toBeDefined();
    expect(event!.fields).not.toHaveProperty("text");
    expect(event!.fields).not.toHaveProperty("output");
    expect(event!.fields).not.toHaveProperty("Content");
    expect(event!.fields.outputLength).toBe(31);
    expect(event!.fields.parseVerdict).toBe("unparseable");
    const payload = String(logEventMock.mock.calls[0]?.[0]?.json ?? "");
    expect(payload).not.toContain("prose wrapping");
  });

  it("diagModelDigest hashes without storing text", () => {
    setDiagEnabled(true);
    diagModelDigest(
      "vlm.stage1.result",
      '{"objects": [{"objectName": "keys"}]}',
      { parseVerdict: "parsed", attempt: 1, ms: 12 },
      { traceId: "t-digest" },
    );
    const [event] = getDiagEvents();
    expect(event!.fields.outputLength).toBe(37);
    expect(event!.fields.sha256).toBe(sha256Hex('{"objects": [{"objectName": "keys"}]}'));
    expect(event!.fields.parseVerdict).toBe("parsed");
    expect(event!.fields.attempt).toBe(1);
    expect(event!.fields.ms).toBe(12);
    expect(JSON.stringify(event)).not.toContain("keys");
  });

  it("bounds an explicit dev sample to 200 chars and still redacts it", () => {
    setDiagEnabled(true);
    diag("vlm.stage1.result", { parseVerdict: "unparseable" }, {
      traceId: "t-sample",
      devSample: `${"x".repeat(300)} owner@example.com`,
    });
    const sample = String(getDiagEvents()[0]!.fields.sample ?? "");
    expect(sample.length).toBeLessThanOrEqual(200);
    expect(sample).not.toContain("owner@example.com");
  });
});

describe("traceId + ring", () => {
  it("propagates the caller traceId into ring and bridge payload", () => {
    setDiagEnabled(true);
    diag("publish.rpc.start", { rpc: "findback_create_post_client" }, { traceId: "trace-123" });
    const [event] = getDiagEvents();
    expect(event!.traceId).toBe("trace-123");
    expect(String(logEventMock.mock.calls[0]?.[0]?.json ?? "")).toContain("trace-123");
  });

  it("uses one ambient traceId per user action when set", () => {
    setDiagEnabled(true);
    const traceId = startActionTrace();
    expect(traceId).toMatch(/^[0-9a-f-]{8,}$/);
    diag("vlm.discover.start", {});
    diag("vlm.stage1.result", { parseVerdict: "parsed" });
    expect(getDiagEvents().map((e) => e.traceId)).toEqual([traceId, traceId]);
  });

  it("caps the in-memory ring at 2000, dropping oldest first", () => {
    setDiagEnabled(true);
    for (let i = 0; i < 2005; i++) {
      diag("heartbeat", { seq: i }, { traceId: `t-${i}` });
    }
    const events = getDiagEvents();
    expect(events).toHaveLength(2000);
    expect(events[0]!.traceId).toBe("t-5");
    expect(events[events.length - 1]!.traceId).toBe("t-2004");
  });

  it("exports user-triggered JSON without raw text", () => {
    setDiagEnabled(true);
    diagModelDigest("vlm.stage1.result", "secret prose", { parseVerdict: "parsed" }, { traceId: "t-exp" });
    const parsed = JSON.parse(exportDiagJson()) as unknown[];
    expect(parsed).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain("secret prose");
  });
});
