/**
 * Worker E (M2 QA/security) — Sentry privacy battery for AI UI/route fields.
 *
 * Scope: every NEW AI UI/route field B/C add (attempt history, modelId,
 * provider, partial text, catalog price lines, breadcrumb route params) must
 * be scrubbed in beforeSend + beforeSendTransaction + breadcrumbs,
 * fail-closed (null = drop).
 *
 * Method: test through the PUBLIC contracts only —
 * `sanitizeSentryEvent` (the function `initMonitoring` wires to BOTH
 * `beforeSend` and `beforeSendTransaction`), `sanitizeSentryBreadcrumb`
 * (wired to `beforeBreadcrumb`), plus `redactText`/`scrubRequestUrl`/
 * `stripQueryAndFragment`. No implementation files edited; no internals
 * reached into.
 *
 * Tree status at write time (HEAD fb4a5a4): B/C M1 state extension is NOT
 * in tree — `ControllerState` is still {phase,summarized,notice,lastError?}
 * with no partialText/attempt/provider/modelId, and no AI breadcrumb target
 * exists. So B/C-emitted shapes are exercised here as SYNTHETIC payloads
 * through the generic scrub paths (the paths any future field flows
 * through). Where a dedicated B/C contract is missing, the ID is logged
 * BLOCKED in E-wiring.log.md — never tested around via internals.
 *
 * Fixtures are synthetic only (key prefixes assembled at runtime so this
 * file never contains a secret-shaped literal the scanner would flag).
 * No real tokens/keys, no device, no live Sentry.
 */
import { describe, expect, it } from "vitest";
import {
  redactText,
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  scrubRequestUrl,
  stripQueryAndFragment,
} from "./sentry";

// --- Synthetic fixtures (assembled at runtime; never real secrets) --------
const OR_KEY = ["sk", "or"].join("-") + "-v1-synthetic0000000000000000000000";
const SUPA_SECRET = ["sb", "secret"].join("_") + "_synthetic0000000000000000";
const SUPA_PUB = ["sb", "publishable"].join("_") + "_synthetic0000000000000000";
const GOOGLE_KEY = "AIza" + "0".repeat(25);
const GH_PAT = "ghp_" + "a".repeat(24);
const BEARER = "Bearer synthetic-token-12345.abcde";
const JWT_LIKE = ["eyJhbGciOiJIUzI1NiJ9", "cGF5bG9hZA", "c2lnbmF0dXJl"].join(".");
const EMAIL = "synthetic.user@example.test";
const PHONE = "+1 555 010 2030";
const PHOTO_DATA_URL = "data:image/jpeg;base64," + "a".repeat(64);
const BLOB_URL = "blob:https://app.findback.test/uuid-synthetic-1";
const PROMPT_TEXT = "my lost black wallet near central park";
const HEX_TOKEN = "a".repeat(40);
const B64_TOKEN = "z".repeat(50);

function expectClean(serialized: string, label: string): void {
  for (const secret of [OR_KEY, SUPA_SECRET, SUPA_PUB, GOOGLE_KEY, GH_PAT, JWT_LIKE, EMAIL, PHONE, HEX_TOKEN, B64_TOKEN]) {
    expect(serialized, `${label} leaks synthetic secret`).not.toContain(secret);
  }
  expect(serialized, `${label} leaks photo bytes`).not.toContain("base64,");
  expect(serialized, `${label} leaks blob URL`).not.toContain("blob:");
}

describe("redactText — synthetic key/prompt/phone shapes", () => {
  it("redacts every synthetic secret shape while keeping benign AI metadata", () => {
    const input = [
      `key=${OR_KEY}`,
      `secret=${SUPA_SECRET}`,
      `pub=${SUPA_PUB}`,
      `g=${GOOGLE_KEY}`,
      `gh=${GH_PAT}`,
      `auth ${BEARER}`,
      `jwt ${JWT_LIKE}`,
      `mail ${EMAIL}`,
      `tel ${PHONE}`,
      `hex ${HEX_TOKEN}`,
      `tok ${B64_TOKEN}`,
      `photo ${PHOTO_DATA_URL}`,
      `file ${BLOB_URL}`,
      `provider openrouter model openrouter/free attempt 2`,
    ].join(" | ");
    const out = redactText(input);
    expectClean(out, "redactText");
    expect(out).toContain("[redacted]");
    expect(out).toContain("[redacted-image]");
    // Benign AI metadata is NOT secret-shaped and passes through for triage.
    expect(out).toContain("openrouter");
    expect(out).toContain("attempt 2");
  });

  it("keeps plain prompt text that carries no secret shape", () => {
    expect(redactText(PROMPT_TEXT)).toBe(PROMPT_TEXT);
  });
});

describe("URL/query scrubbing — route params and catalog price lines", () => {
  it("scrubRequestUrl keeps origin+path, drops query/fragment (tokens, coords)", () => {
    expect(scrubRequestUrl("https://api.openrouter.ai/api/v1/chat?key=abc&lat=1.1")).toBe(
      "https://api.openrouter.ai/api/v1/chat",
    );
    expect(scrubRequestUrl("not a url")).toBe("[redacted-url]");
  });

  it("stripQueryAndFragment cuts ? and # from route/transaction names", () => {
    expect(stripQueryAndFragment("/posts/abc123?preview=true")).toBe("/posts/abc123");
    expect(stripQueryAndFragment("Help#faq")).toBe("Help");
    expect(stripQueryAndFragment("/help")).toBe("/help");
  });
});

describe("sanitizeSentryBreadcrumb — AI + navigation crumbs, fail-closed", () => {
  it("withholds chat/prompt/photo keys, strips route queries, keeps model metadata", () => {
    const crumb = {
      message: `user asked ${PROMPT_TEXT} contact ${EMAIL}`,
      category: "ai.chat",
      data: {
        provider: "openrouter",
        modelId: "openrouter/free",
        attempt: 2,
        partialText: `delta one, reach me at ${EMAIL}`,
        prompt: PROMPT_TEXT,
        userEmail: EMAIL,
        photoDataUrl: PHOTO_DATA_URL,
        from: "https://app.findback.test/help?code=synthetic123",
        to: "/posts/abc123?preview=true#top",
        priceLines: "prompt 0 USD/token, completion 0 USD/token",
      },
    };
    const clean = sanitizeSentryBreadcrumb(crumb);
    expect(clean).not.toBeNull();
    const serialized = JSON.stringify(clean);
    expectClean(serialized, "breadcrumb");
    expect(serialized).not.toContain("?");
    expect(serialized).not.toContain("#top");
    expect(serialized).toContain("[withheld-privacy]");
    // Benign routing/model metadata survives for triage.
    expect(serialized).toContain("openrouter");
    const data = (clean as Record<string, unknown>)["data"] as Record<string, unknown>;
    expect(data["provider"]).toBe("openrouter");
    expect(data["modelId"]).toBe("openrouter/free");
    expect(data["attempt"]).toBe(2);
  });

  it("drops non-object input (null) instead of forwarding raw", () => {
    expect(sanitizeSentryBreadcrumb(null)).toBeNull();
    expect(sanitizeSentryBreadcrumb("ai breadcrumb")).toBeNull();
    expect(sanitizeSentryBreadcrumb(42)).toBeNull();
  });

  it("drops circular input (fail-closed on sanitization throw)", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(sanitizeSentryBreadcrumb(circular)).toBeNull();
  });

  it("does not mutate the caller's object", () => {
    const crumb = { message: EMAIL, data: { prompt: PROMPT_TEXT } };
    sanitizeSentryBreadcrumb(crumb);
    expect(crumb.message).toBe(EMAIL);
  });
});

describe("sanitizeSentryEvent — beforeSend path (error events)", () => {
  it("scrubs synthetic AI UI fields: attempt history, model, provider, partial, price lines", () => {
    const event = {
      message: `chat failed for ${EMAIL} using ${OR_KEY}`,
      transaction: "/help?model=openrouter%2Ffree&code=synthetic",
      request: {
        url: "https://api.openrouter.ai/api/v1/chat/completions?key=synthetic",
        method: "POST",
        headers: { Authorization: BEARER },
        cookies: "session=abc",
        query_string: "key=synthetic",
        data: { prompt: PROMPT_TEXT },
      },
      user: { id: "synthetic-user", email: EMAIL },
      tags: { route: "/help?code=synthetic", provider: "openrouter", modelId: "openrouter/free" },
      contexts: { chat: { history: PROMPT_TEXT, phone: PHONE } },
      extra: {
        attemptHistory: [1, 2],
        partialText: `half answer, mail ${EMAIL}`,
        catalogPriceLines: "prompt 0 USD/token",
        photoDataUrl: PHOTO_DATA_URL,
      },
      exception: {
        values: [
          {
            type: "Error",
            value: `bad key ${GOOGLE_KEY}`,
            module: { code_file: "https://cdn.test/app.js?token=synthetic#frag" },
            stacktrace: {
              frames: [{ filename: "https://cdn.test/bundle.js?token=synthetic", function: "send" }],
            },
          },
        ],
      },
      breadcrumbs: [
        { message: `token ${JWT_LIKE}`, data: { prompt: PROMPT_TEXT, attempt: 1 } },
      ],
    };
    const clean = sanitizeSentryEvent(event);
    expect(clean).not.toBeNull();
    const serialized = JSON.stringify(clean);
    expectClean(serialized, "event");
    expect(serialized).not.toContain("?");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("synthetic-user");
    expect(serialized).toContain("[withheld-privacy]");
    // Identity never attached; bodies/headers/cookies/query never leave device.
    const out = clean as Record<string, unknown>;
    expect(out["user"]).toBeUndefined();
    const request = out["request"] as Record<string, unknown>;
    expect(request["headers"]).toBeUndefined();
    expect(request["cookies"]).toBeUndefined();
    expect(request["query_string"]).toBeUndefined();
    expect(request["data"]).toBeUndefined();
    expect(request["url"]).toBe("https://api.openrouter.ai/api/v1/chat/completions");
  });

  it("drops non-object and circular input (null = discard, never raw)", () => {
    expect(sanitizeSentryEvent(null)).toBeNull();
    expect(sanitizeSentryEvent("event")).toBeNull();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(sanitizeSentryEvent(circular)).toBeNull();
  });
});

describe("sanitizeSentryEvent — beforeSendTransaction path (transaction events)", () => {
  it("scrubs spans (url.full, http.query, http.fragment) and transaction name", () => {
    // initMonitoring wires beforeSendTransaction to sanitizeSentryEvent
    // (source-reviewed); transactions bypass beforeSend, so this path
    // must scrub the same leak classes (M3 span fields).
    const transactionEvent = {
      type: "transaction",
      transaction: `/help?code=synthetic&model=openrouter%2Ffree`,
      spans: [
        {
          description: "GET https://api.openrouter.ai/api/v1/models?limit=100",
          data: {
            "url.full": "https://api.openrouter.ai/api/v1/models?limit=100",
            "http.query": "limit=100",
            "http.fragment": "top",
            "http.method": "GET",
          },
        },
      ],
      request: { url: "https://app.findback.test/help?code=synthetic" },
    };
    const clean = sanitizeSentryEvent(transactionEvent);
    expect(clean).not.toBeNull();
    const serialized = JSON.stringify(clean);
    expectClean(serialized, "transaction");
    expect(serialized).not.toContain("?");
    expect(serialized).not.toContain("limit=100");
    expect(serialized).toContain("[redacted]");
    const out = clean as Record<string, unknown>;
    const spans = out["spans"] as Array<Record<string, unknown>>;
    expect(spans.length).toBe(1);
    const first = spans[0] as Record<string, unknown>;
    const data = first["data"] as Record<string, unknown>;
    expect(data["http.query"]).toBe("[redacted]");
    expect(data["http.fragment"]).toBe("[redacted]");
    expect(data["url.full"]).toBe("https://api.openrouter.ai/api/v1/models");
  });
});
