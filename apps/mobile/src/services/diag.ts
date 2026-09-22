import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Structured diagnostic tracing for broken flows.
 *
 * `diag(event, fields)` records one redacted event to an in-memory ring
 * (cap 2000, convenience only) and forwards it to the NATIVE JSONL sink,
 * which is authoritative: if the WebView/process dies during the exact
 * failure under investigation, the ring is the first thing lost.
 *
 * NATIVE BRIDGE CONTRACT (the Kotlin side is implemented against these names):
 * - Capacitor plugin name: `FindBackDiag`
 * - Method: `logEvent(options: { json: string }) => Promise<void>`
 * - `json` is one serialized {@link DiagEvent} (already redacted here).
 * - Native appends one line per call to `cacheDir/diag/*.jsonl` (7-day
 *   rotation) and mirrors via `Log.i("FindBackDiag", json)`.
 * - JS never throws when native is absent (web, old build): ring-only.
 *
 * REDACTION is load-bearing: secrets/PII-shaped values never survive, and
 * model outputs travel as length/hash/verdict ONLY. A redacted BOUNDED
 * sample (<=200 chars, explicit `devSample` opt-in) exists for parser
 * debugging and is never the default.
 *
 * GATING: collection defaults OFF (`setDiagEnabled(true)` to start, wired
 * to Settings -> Diagnostics -> Verbose logging by a later step). Export is
 * user-triggered only (`exportDiagJson`); nothing is ever uploaded.
 */

export const DIAG_RING_CAP = 2000;

export const DIAG_BRIDGE_PLUGIN = "FindBackDiag";
export const DIAG_BRIDGE_METHOD = "logEvent";
export const DIAG_LOGCAT_TAG = "FindBackDiag";

export type DiagScalar = string | number | boolean | null | undefined;
export type DiagFields = Record<string, DiagScalar | Record<string, unknown>>;

export interface DiagOptions {
  traceId?: string;
  /**
   * Explicit dev-diagnostic sample for parser debugging. Redacted and
   * truncated to DIAG_SAMPLE_MAX before storage. Never set by default.
   */
  devSample?: string;
}

export interface DiagEvent {
  v: 1;
  traceId: string;
  ts: string;
  event: string;
  fields: Record<string, string | number | boolean | null>;
}

export interface DiagModelDigest {
  parseVerdict: string;
  attempt?: number;
  ms?: number;
}

/** Value patterns that must never leave the device (mirrors vlmDiscovery/vlmParser). */
const SENSITIVE_VALUE_PATTERNS = [
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // card-like runs
  /\b\+?\d[\d\s().-]{7,}\d\b/, // phone-like runs
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // emails
  /\b(id|passport|license|nid)\b[\s\S]{0,12}?[A-Z0-9-]{4,}/i, // id-like runs
  /\b(?:otp|one[\s-]?time|verification|code|pin)[\s:]*\d{4,8}\b/i, // OTP with keyword
  /\b\d{6}\b/, // bare 6-digit OTP
  /\bhttps?:\/\/\S+/i, // QR URL payloads
  /\bWIFI:[^\s]+/i, // QR Wi-Fi payloads
  /\bBEGIN:(?:VCARD|VEVENT)/i, // QR vCard/event payloads
  /\bsk-[A-Za-z0-9]{8,}\b/, // OpenAI-style provider keys
  /\bxox[abp]-[A-Za-z0-9-]+\b/i, // Slack-style tokens
  /\bghp_[A-Za-z0-9]{8,}/, // GitHub-style tokens
  /\bgsk_[A-Za-z0-9]{8,}/, // Groq-style keys
  /\bsb_publishable_[A-Za-z0-9_-]+\b/, // Supabase publishable keys
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, // JWT-shaped tokens
];

/** Key substrings (lowercased) whose value is always withheld. */
const SENSITIVE_KEY_PARTS = [
  "apikey",
  "api_key",
  "llm_api_key",
  "authorization",
  "sb_publishable",
  "token",
  "secret",
  "password",
  "passwd",
  "private_key",
  "client_secret",
  "access_key",
  "refresh_token",
  "session_key",
];

/** Top-level field names that would carry raw model/user text — dropped on the standard path. */
const RAW_TEXT_KEYS = new Set([
  "text",
  "rawtext",
  "raw_text",
  "raw",
  "output",
  "modeloutput",
  "model_output",
  "content",
  "response",
  "completion",
  "generatedtext",
  "generated_text",
]);

export const DIAG_SAMPLE_MAX = 200;
export const REDACTED = "[redacted]";

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(value));
}

function redactField(key: string, value: string | number | boolean | null | undefined): string | number | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (RAW_TEXT_KEYS.has(key.toLowerCase())) return undefined;
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value !== "string") return value;
  return isSensitiveValue(value) ? REDACTED : value;
}

function sanitizeFields(fields: DiagFields | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    const flat = value !== null && typeof value === "object" ? JSON.stringify(value) : value;
    const redacted = redactField(key, flat as string | number | boolean | null | undefined);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Synchronous SHA-256 hex (WebView-safe; no async subtle-crypto in a fire-and-forget path). */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 2 ** 32), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

interface NativeDiagBridge {
  logEvent(options: { json: string }): Promise<void>;
}

let nativeDiag: NativeDiagBridge | null | undefined;
let diagEnabled = false;
let ambientTraceId: string | null = null;
const ring: DiagEvent[] = [];

export function createTraceId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `trace-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

/** One traceId per user action; hooks without an explicit traceId inherit it. */
export function startActionTrace(): string {
  ambientTraceId = createTraceId();
  return ambientTraceId;
}

export function getAmbientTrace(): string | null {
  return ambientTraceId;
}

export function clearAmbientTrace(): void {
  ambientTraceId = null;
}

export function setDiagEnabled(value: boolean): void {
  diagEnabled = value;
}

export function isDiagEnabled(): boolean {
  return diagEnabled;
}

function getNativeDiag(): NativeDiagBridge | null {
  if (nativeDiag !== undefined) return nativeDiag;
  try {
    if (!Capacitor.isNativePlatform()) {
      nativeDiag = null;
      return null;
    }
    nativeDiag = registerPlugin<NativeDiagBridge>(DIAG_BRIDGE_PLUGIN);
    return nativeDiag;
  } catch {
    nativeDiag = null;
    return null;
  }
}

/**
 * Record one redacted diagnostic event. Never throws; no-ops while disabled.
 * Raw-text-carrying field names are dropped; secrets/PII-shaped values are
 * replaced with `[redacted]` before anything reaches the ring or native.
 */
export function diag(event: string, fields?: DiagFields, opts?: DiagOptions): void {
  if (!diagEnabled) return;
  try {
    const clean = sanitizeFields(fields);
    if (opts?.devSample !== undefined) {
      const sample = isSensitiveValue(opts.devSample) ? REDACTED : opts.devSample;
      clean.sample = sample.slice(0, DIAG_SAMPLE_MAX);
    }
    const entry: DiagEvent = {
      v: 1,
      traceId: opts?.traceId ?? ambientTraceId ?? createTraceId(),
      ts: new Date().toISOString(),
      event,
      fields: clean,
    };
    ring.push(entry);
    if (ring.length > DIAG_RING_CAP) ring.splice(0, ring.length - DIAG_RING_CAP);
    const bridge = getNativeDiag();
    if (bridge) {
      void bridge.logEvent({ json: JSON.stringify(entry) }).catch(() => undefined);
    }
  } catch {
    return;
  }
}

/**
 * Model-output digest: length + sha256 + parse verdict + attempt + timing.
 * The raw text is hashed, never stored — use this for every VLM stage event.
 */
export function diagModelDigest(
  event: string,
  outputText: string,
  digest: DiagModelDigest,
  extra?: DiagFields,
  opts?: DiagOptions,
): void {
  if (!diagEnabled) return;
  diag(
    event,
    {
      ...extra,
      outputLength: outputText.length,
      sha256: sha256Hex(outputText),
      parseVerdict: digest.parseVerdict,
      ...(digest.attempt !== undefined ? { attempt: digest.attempt } : {}),
      ...(digest.ms !== undefined ? { ms: digest.ms } : {}),
    },
    opts,
  );
}

export function getDiagEvents(): DiagEvent[] {
  return [...ring];
}

export function clearDiagEvents(): void {
  ring.length = 0;
}

/** User-triggered export only; payload is already redacted at record time. */
export function exportDiagJson(): string {
  return JSON.stringify([...ring]);
}
