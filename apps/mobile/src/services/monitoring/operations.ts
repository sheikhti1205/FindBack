/**
 * SYNC-9 — typed allowlisted monitoring seam.
 *
 * `recordOperation(event)` is the ONE typed path for operational logs
 * (boot, auth, media, report, AI, map, social, push, realtime). Every event
 * name is a closed union member and every field is allowlisted per event;
 * only counts/codes/booleans/enums cross — never free text, queries,
 * coordinates, URIs, or key material.
 *
 * Fail-closed: unknown names, off-allowlist fields, missing required
 * fields, or malformed values THROW in dev/tests and are DROPPED in
 * production (never silently forwarded). Every payload is additionally run
 * through `sanitizeSentryEvent` before dispatch: a `null` verdict DROPS the
 * payload. Dispatch goes via the existing `reportLogToMonitoring` export —
 * no new transport, no new sink.
 */

import {
  reportLogToMonitoring,
  sanitizeSentryEvent,
  type MonitoringLogLevel,
} from "./sentry";

type AuthMode = "signin" | "signup";
type MediaKind = "photo" | "video" | "gif" | "sticker";
type MediaSource = "camera" | "gallery" | "klipy" | "storage";
type AttachmentKind = "photo" | "video" | "gif" | "sticker" | "mixed" | "none";
type ResultClass = "zero" | "few" | "many";
type MapSource = "nominatim" | "unified";
type AiProvider = "openrouter" | "local" | "none";

export type OperationEvent =
  | { name: "app.boot"; fields: { ok: boolean; ms?: number; cold?: boolean } }
  | { name: "auth.google.success"; fields: { mode: AuthMode } }
  | { name: "auth.google.cancelled"; fields: { mode: AuthMode } }
  | { name: "auth.google.error"; fields: { mode: AuthMode; code: string } }
  | {
      name: "media.pick";
      fields: { kind: MediaKind; count: number; source?: MediaSource };
    }
  | {
      name: "media.upload";
      fields: { kind: MediaKind; count: number; ok: boolean; code?: string };
    }
  | {
      name: "report.create";
      fields: { ok: boolean; code?: string; attachmentCount?: number };
    }
  | { name: "report.update"; fields: { ok: boolean; code?: string } }
  | {
      name: "ai.analyze";
      fields: { ok: boolean; code?: string; provider?: AiProvider };
    }
  | {
      name: "ai.chat";
      fields: { ok: boolean; code?: string; provider?: AiProvider };
    }
  | {
      name: "map.search";
      fields: { resultClass: ResultClass; rateLimited: boolean; source?: MapSource };
    }
  | { name: "map.confirm"; fields: { exact: boolean } }
  | {
      name: "social.comment";
      fields: {
        ok: boolean;
        code?: string;
        attachmentCount: number;
        attachmentKind?: AttachmentKind;
      };
    }
  | {
      name: "social.reaction";
      fields: { ok: boolean; code?: string; kind?: string };
    }
  | { name: "push.register"; fields: { ok: boolean; code?: string } }
  | { name: "realtime.connect"; fields: { ok: boolean; code?: string } }
  | { name: "realtime.disconnect"; fields: { ok: boolean; code?: string } };

export type OperationEventName = OperationEvent["name"];

type FieldValidator = (value: unknown) => boolean;

interface FieldSchema {
  required: boolean;
  validate: FieldValidator;
}

const isBoolean: FieldValidator = (value) => typeof value === "boolean";

function isCount(max: number): FieldValidator {
  return (value) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max;
}

const isMs: FieldValidator = (value) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 3_600_000;

const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const FLOAT_LIKE = /^\d+\.\d+$/;
const LONG_DIGITS = /^\d{7,}$/;

/**
 * Short enum-like result codes only (HTTP statuses, stable kind tokens).
 * Rejects anything shaped like free text, coordinates, phone runs, or URIs
 * — those must throw/drop here, never reach the transport.
 */
const isCode: FieldValidator = (value) =>
  typeof value === "string" &&
  CODE_PATTERN.test(value) &&
  !FLOAT_LIKE.test(value) &&
  !LONG_DIGITS.test(value);

function isEnum<T extends string>(values: readonly T[]): FieldValidator {
  return (value) => typeof value === "string" && (values as readonly string[]).includes(value);
}

const AUTH_MODES = ["signin", "signup"] as const;
const MEDIA_KINDS = ["photo", "video", "gif", "sticker"] as const;
const MEDIA_SOURCES = ["camera", "gallery", "klipy", "storage"] as const;
const ATTACHMENT_KINDS = ["photo", "video", "gif", "sticker", "mixed", "none"] as const;
const RESULT_CLASSES = ["zero", "few", "many"] as const;
const MAP_SOURCES = ["nominatim", "unified"] as const;
const AI_PROVIDERS = ["openrouter", "local", "none"] as const;

const SCHEMAS: Record<string, Record<string, FieldSchema>> = {
  "app.boot": {
    ok: { required: true, validate: isBoolean },
    ms: { required: false, validate: isMs },
    cold: { required: false, validate: isBoolean },
  },
  "auth.google.success": {
    mode: { required: true, validate: isEnum(AUTH_MODES) },
  },
  "auth.google.cancelled": {
    mode: { required: true, validate: isEnum(AUTH_MODES) },
  },
  "auth.google.error": {
    mode: { required: true, validate: isEnum(AUTH_MODES) },
    code: { required: true, validate: isCode },
  },
  "media.pick": {
    kind: { required: true, validate: isEnum(MEDIA_KINDS) },
    count: { required: true, validate: isCount(100) },
    source: { required: false, validate: isEnum(MEDIA_SOURCES) },
  },
  "media.upload": {
    kind: { required: true, validate: isEnum(MEDIA_KINDS) },
    count: { required: true, validate: isCount(100) },
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
  },
  "report.create": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
    attachmentCount: { required: false, validate: isCount(100) },
  },
  "report.update": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
  },
  "ai.analyze": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
    provider: { required: false, validate: isEnum(AI_PROVIDERS) },
  },
  "ai.chat": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
    provider: { required: false, validate: isEnum(AI_PROVIDERS) },
  },
  "map.search": {
    resultClass: { required: true, validate: isEnum(RESULT_CLASSES) },
    rateLimited: { required: true, validate: isBoolean },
    source: { required: false, validate: isEnum(MAP_SOURCES) },
  },
  "map.confirm": {
    exact: { required: true, validate: isBoolean },
  },
  "social.comment": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
    attachmentCount: { required: true, validate: isCount(100) },
    attachmentKind: { required: false, validate: isEnum(ATTACHMENT_KINDS) },
  },
  "social.reaction": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
    kind: { required: false, validate: isCode },
  },
  "push.register": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
  },
  "realtime.connect": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
  },
  "realtime.disconnect": {
    ok: { required: true, validate: isBoolean },
    code: { required: false, validate: isCode },
  },
};

/** True only in production builds — everywhere else violations throw. */
function failClosedThrows(): boolean {
  try {
    const env =
      (import.meta as unknown as { env?: Record<string, unknown> }).env ??
      undefined;
    if (env?.["PROD"] === true) return false;
    if (env?.["MODE"] === "test") return true;
    if (typeof process !== "undefined" && process.env) {
      if (process.env["NODE_ENV"] === "production") return false;
      return true;
    }
    return true;
  } catch {
    return true;
  }
}

function reject(reason: string): false {
  if (failClosedThrows()) throw new Error(`recordOperation: ${reason}`);
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Validate + dispatch one allowlisted operational event. Returns true when
 * dispatched, false when dropped in production. Throws in dev/tests on any
 * allowlist violation (unknown name, unknown field, missing required field,
 * malformed value) or when the fail-closed sanitizer discards the payload.
 */
export function recordOperation(event: OperationEvent): boolean {
  const input = asRecord(event);
  const rawName = input?.["name"];
  const eventName = typeof rawName === "string" ? rawName : null;
  const fields = asRecord(input?.["fields"]);
  const schema = eventName ? SCHEMAS[eventName] : undefined;
  if (!schema || !fields || !eventName) {
    reject(`refusing unknown event ${JSON.stringify(rawName ?? null)}`);
    return false;
  }
  for (const key of Object.keys(fields)) {
    if (!schema[key]) {
      reject(`refusing off-allowlist field ${eventName}.${key}`);
      return false;
    }
  }
  const stringified: Record<string, string> = { op: eventName };
  for (const [key, spec] of Object.entries(schema)) {
    const value = fields[key];
    if (value === undefined) {
      if (spec.required) {
        reject(`refusing ${eventName}: missing required field ${key}`);
        return false;
      }
      continue;
    }
    if (!spec.validate(value)) {
      reject(`refusing ${eventName}: malformed value for ${key}`);
      return false;
    }
    stringified[key] = String(value);
  }
  // Fail-closed privacy gate: the exact payload shape must survive the same
  // sanitizer Sentry.init wires to beforeSend — and the SANITIZED copy is
  // what gets dispatched, so a redacted shape can never leak its raw form.
  // A null verdict drops the payload entirely.
  const candidate = { message: `op:${eventName}`, level: "info", extra: stringified };
  const clean = sanitizeSentryEvent(candidate);
  const cleanExtra = clean ? asRecord(clean["extra"]) : null;
  if (!cleanExtra) {
    return reject(`discarded by sanitizer: ${eventName}`);
  }
  const dispatch: Record<string, string> = {};
  for (const [key, value] of Object.entries(cleanExtra)) {
    dispatch[key] = String(value);
  }
  const failed =
    dispatch["ok"] === "false" || dispatch["rateLimited"] === "true";
  const level: MonitoringLogLevel = failed ? "warn" : "info";
  reportLogToMonitoring(level, `op:${eventName}`, dispatch);
  return true;
}
