/**
 * GenerationGuard (Task 22): loop/R3 detection, output classification,
 * generation deadlines, single-retry policy, and per-session model health.
 *
 * Evidence grounding:
 * - Task-29 desktop runs: deterministic repetition loops (phone.fixb
 *   14683 B `coffee cup lid` enumeration, book.fixb 12874 B `<main object>`
 *   repetition, both byte-identical on repeat), loop wall times 88-102 s vs
 *   typical 6-11 s/photo, peak litert RSS ~1.79 GB.
 * - SmolVLM2 text+vision loops + VL array-loops motivate the R3 runaway
 *   enumeration caps (repeated array items, zero-runs, single-key xN,
 *   low-novelty streams).
 * - Output-pattern taxonomy: sentence_loop = same sentence 3+ times,
 *   paragraph_loop = same block 2+ times.
 *
 * The guard owns the generation deadline, but the production timeout budget
 * is an explicit TBD (Task-20/29 measurements + ModelProfile): `deadlineMs`
 * has NO default and must be supplied by the caller. SLOW is latency only,
 * never an error.
 */
import { GuardError, errorClassForMode } from "./errors";
import type { AiErrorClass } from "./testing/FakeAiProvider";
import { FakeAiError, REFUSAL_TEXT, diagnosticCodeForMode, extractSingleJsonObject } from "./testing/FakeAiProvider";
import type { FaultMode } from "./testing/FakeAiProvider";

/**
 * TODO(21A): rewire to services/ai/types.ts when Task 21 lands.
 * Minimal local seam for the action allowlist the coordinator contract will
 * own. Absent a policy the guard fails closed: any `action` field the
 * caller cannot vouch for is UNSUPPORTED_ACTION with no side effects.
 */
export interface GuardActionPolicy {
  isSupportedAction(action: string): boolean;
}

/** Minimal provider surface the guard drives (satisfied by FakeAiProvider). */
export interface GuardTextRequest {
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GuardPhotoRequest {
  imageUri: string;
  instruction: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GuardResult {
  text: string;
  modelId: string;
}

export interface GuardProvider {
  generateText(request: GuardTextRequest, signal?: AbortSignal): Promise<GuardResult>;
  analyzePhoto(request: GuardPhotoRequest, signal?: AbortSignal): Promise<GuardResult>;
}

/** Per-session model health. In-memory only; never persists across sessions. */
export type SessionHealth = "HEALTHY" | "DEGRADED" | "UNSTABLE_THIS_SESSION";

function normalizeSentence(sentence: string): string {
  return sentence.toLowerCase().replace(/\s+/g, " ").replace(/["'`_*\-.!?;:]+$/g, "").trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\]\s,;|/\\()[{}<>"]+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((token) => token.length > 0);
}

/** Same normalized sentence appearing 3+ times (sentence-loop evidence). */
export function detectSentenceRepetition(text: string): boolean {
  const sentences = splitSentences(text).map(normalizeSentence).filter((s) => s.length > 0);
  if (sentences.length < 3) return false;
  const counts = new Map<string, number>();
  let run = 1;
  for (let i = 0; i < sentences.length; i++) {
    const current = sentences[i] as string;
    counts.set(current, (counts.get(current) ?? 0) + 1);
    if (i > 0 && current === sentences[i - 1]) {
      run += 1;
      if (run >= 3) return true;
    } else {
      run = 1;
    }
  }
  for (const count of counts.values()) {
    if (count >= 3) return true;
  }
  return false;
}

/** Same normalized multi-sentence block appearing 2+ times (paragraph loop). */
export function detectParagraphRepetition(text: string): boolean {
  const sentences = splitSentences(text).map(normalizeSentence).filter((s) => s.length > 0);
  if (sentences.length < 4) return false;
  for (const width of [3, 2]) {
    const seen = new Set<string>();
    for (let i = 0; i + width <= sentences.length; i++) {
      const block = sentences.slice(i, i + width).join(" | ");
      if (seen.has(block)) return true;
      seen.add(block);
    }
  }
  return false;
}

/**
 * Repeated word n-gram (default 6-gram, 4+ occurrences). Catches
 * sub-sentence loops the sentence splitter misses, e.g. `;`-separated
 * Task-29 enumeration streams (`coffee cup lid` x~40, `<main object>` x~800).
 */
export function detectRepeatedNgrams(text: string, n = 6, minOccurrences = 4): boolean {
  const words = tokenizeWords(text);
  if (words.length < n * 2) return false;
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= words.length; i++) {
    const gram = words.slice(i, i + n).join(" ");
    const next = (counts.get(gram) ?? 0) + 1;
    if (next >= minOccurrences) return true;
    counts.set(gram, next);
  }
  return false;
}

/** Extremely low novelty: unique/total word ratio below threshold on long outputs. */
export function detectLowNovelty(text: string, minWords = 40, minUniqueRatio = 0.25): boolean {
  const words = tokenizeWords(text);
  if (words.length < minWords) return false;
  return new Set(words).size / words.length < minUniqueRatio;
}

function topFrequency(items: string[]): number {
  const counts = new Map<string, number>();
  let top = 0;
  for (const item of items) {
    const next = (counts.get(item) ?? 0) + 1;
    counts.set(item, next);
    if (next > top) top = next;
  }
  return top;
}

/**
 * R3 runaway cap for parsed arrays: length >= 10 with the top item covering
 * >= max(5, half). Covers repeated array items and zero-runs.
 */
export function detectArrayRunaway(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length < 10) return false;
  const keys = value.map((item) => JSON.stringify(item) ?? "?");
  return topFrequency(keys) >= Math.max(5, Math.ceil(value.length / 2));
}

/** Share of a raw enumeration stream dominated by one value before it counts as runaway (Task-29 streams sit near one half). */
const ENUMERATION_RUNAWAY_SHARE = 0.4;

/**
 * R3 runaway cap for raw enumeration streams (`;`/`,`/`|`/newline
 * separated, e.g. Task-29 OBJECT tag-soup): 10+ items with one value
 * covering >= max(5, half). Zero-runs (>= 8 bare `0` tokens) also match.
 */
export function detectRawEnumerationRunaway(text: string): boolean {
  const items = text
    .split(/[;\n|]+/)
    .flatMap((chunk) => chunk.split(/,(?![^{]*})/))
    .map((item) => item.toLowerCase().replace(/[\s._\-*]+/g, " ").trim())
    .filter((item) => item.length > 0);
  if (items.length >= 10 && topFrequency(items) >= Math.max(5, items.length * ENUMERATION_RUNAWAY_SHARE)) {
    return true;
  }
  const zeroRuns = tokenizeWords(text).filter((token) => /^0+(\.0+)?$/.test(token)).length;
  return zeroRuns >= 8;
}

/**
 * R3 single-key xN cap: 15+ `"key":` occurrences dominated by <= 2 distinct
 * keys signals a runaway single-key object stream.
 */
export function detectSingleKeyRunaway(text: string): boolean {
  const keys: string[] = [];
  for (const match of text.matchAll(/"([^"]+)"\s*:/g)) {
    const key = match[1];
    if (key !== undefined) keys.push(key);
  }
  return keys.length >= 15 && new Set(keys).size <= 2;
}

/**
 * R3 character-level runaway cap for whitespace-free mega-token loops
 * (T24-SmolVLM2 `'0'x~98` in 2034 chars / 9 tokens; BV10-vision 2501 chars /
 * 6 tokens): a single unsplittable token evades every word/sentence
 * detector. Flags 32+ identical non-space chars in a row, or a
 * char-vs-token anomaly (256+ chars averaging 64+ chars per token).
 */
export function detectCharacterRunaway(text: string, minRun = 32, minChars = 256, minCharsPerToken = 64): boolean {
  let run = 1;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch !== undefined && ch === text[i - 1]) {
      run += 1;
      if (run >= minRun && !/\s/.test(ch)) return true;
    } else {
      run = 1;
    }
  }
  if (text.length >= minChars) {
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length > 0 && text.length / tokens.length >= minCharsPerToken) return true;
  }
  return false;
}

export interface LoopFinding {
  loop: boolean;
  reasons: string[];
}

/** Master loop check: prose repetition, n-grams, novelty, and R3 caps. */
export function detectLoop(text: string, options?: { truncatedAtLimit?: boolean }): LoopFinding {
  const reasons: string[] = [];
  if (detectSentenceRepetition(text)) reasons.push("SENTENCE_REPETITION");
  if (detectParagraphRepetition(text)) reasons.push("PARAGRAPH_REPETITION");
  if (detectRepeatedNgrams(text)) reasons.push("REPEATED_NGRAM");
  if (detectLowNovelty(text)) reasons.push("LOW_NOVELTY");
  if (detectArrayRunaway(tryParseJson(text))) reasons.push("ARRAY_RUNAWAY");
  if (detectRawEnumerationRunaway(text)) reasons.push("ENUMERATION_RUNAWAY");
  if (detectSingleKeyRunaway(text)) reasons.push("SINGLE_KEY_RUNAWAY");
  if (detectCharacterRunaway(text)) reasons.push("CHARACTER_RUNAWAY");
  if (reasons.length > 0 && options?.truncatedAtLimit === true) {
    reasons.push("OUTPUT_LIMIT_REACHED_WHILE_LOOPING");
  }
  return { loop: reasons.length > 0, reasons };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Well-formed refusal prose (not malformed output): UNSUPPORTED_REQUEST. */
export function isRefusal(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === REFUSAL_TEXT.toLowerCase() || normalized.includes("i can't help with that request");
}

export interface ClassifyOptions {
  /** True for photo/structured requests expecting one JSON object. */
  expectStructured: boolean;
  /** Strict schema/enum check on the extracted object (Task-21 shape TBD). */
  validate?: (value: unknown) => boolean;
  /** Action allowlist seam; absent fails closed (TODO(21A) above). */
  actionPolicy?: GuardActionPolicy;
}

export interface TextVerdict {
  ok: boolean;
  errorClass: AiErrorClass | null;
  diagnosticCode: string;
}

/**
 * Composition contract (Task 24 / coordinator): the guard judges post-R2
 * text. R2 strips Qwen `[thought]...[/thought]` envelopes before any other
 * rule, and the contract's loopCheck seam runs on stripped text — so loop
 * verdicts are only valid on stripped text. This mirrors that strip
 * defensively (idempotent for pre-stripped input): callers SHOULD pass
 * post-R2 text and MUST NOT depend on thought content for verdicts.
 */
export function stripGuardThoughtEnvelopes(text: string): string {
  const openMarker = "[thought]";
  const closeMarker = "[/thought]";
  let stripped = text;
  for (;;) {
    const open = stripped.indexOf(openMarker);
    if (open < 0) break;
    const close = stripped.indexOf(closeMarker, open + openMarker.length);
    stripped = close < 0 ? stripped.slice(0, open) : stripped.slice(0, open) + stripped.slice(close + closeMarker.length);
  }
  return stripped.split(closeMarker).join("").trim();
}

/**
 * Classify completed output text. Throwing modes (TIMEOUT/OOM/crash/...)
 * never reach here; they are mapped from the provider rejection instead.
 * Judges post-R2 text (thought envelopes stripped first).
 */
export function classifyTextOutput(text: string, options: ClassifyOptions): TextVerdict {
  const judged = stripGuardThoughtEnvelopes(text);
  if (judged.trim().length === 0) {
    return { ok: false, errorClass: "INVALID_OUTPUT", diagnosticCode: "EMPTY_OUTPUT" };
  }
  if (isRefusal(judged)) {
    return { ok: false, errorClass: "UNSUPPORTED_REQUEST", diagnosticCode: "REFUSAL_POLICY" };
  }
  const loop = detectLoop(judged);
  if (loop.loop) {
    return { ok: false, errorClass: "LOOP_DETECTED", diagnosticCode: loop.reasons[0] as string };
  }
  const extracted = extractSingleJsonObject(judged);
  if (extracted.count > 1) {
    return { ok: false, errorClass: "INVALID_OUTPUT", diagnosticCode: "MULTIPLE_JSON_OBJECTS" };
  }
  if (extracted.count === 1 && extracted.json !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(extracted.json);
    } catch {
      return { ok: false, errorClass: "INVALID_OUTPUT", diagnosticCode: "UNPARSEABLE_JSON" };
    }
    if (typeof parsed === "object" && parsed !== null && "action" in parsed) {
      const action = (parsed as { action: unknown }).action;
      const supported = typeof action === "string" && (options.actionPolicy?.isSupportedAction(action) === true);
      if (!supported) {
        return { ok: false, errorClass: "UNSUPPORTED_ACTION", diagnosticCode: `ACTION_REJECTED:${String(action)}` };
      }
      return { ok: true, errorClass: null, diagnosticCode: "OK" };
    }
    if (options.expectStructured && options.validate !== undefined && !options.validate(parsed)) {
      return { ok: false, errorClass: "INVALID_OUTPUT", diagnosticCode: "SCHEMA_MISMATCH" };
    }
    return { ok: true, errorClass: null, diagnosticCode: "OK" };
  }
  if (options.expectStructured || /[{}[\]]/.test(judged)) {
    return { ok: false, errorClass: "INVALID_OUTPUT", diagnosticCode: "MALFORMED_STRUCTURED_OUTPUT" };
  }
  return { ok: true, errorClass: null, diagnosticCode: "OK" };
}

/** Map a provider rejection to its GuardError, preserving diagnostics. */
export function guardErrorFromRejection(error: unknown, options?: { modelId?: string; attempts?: number }): GuardError {
  if (error instanceof GuardError) return error;
  if (error instanceof FakeAiError) {
    return new GuardError({
      errorClass: error.errorClass,
      diagnosticCode: error.detail,
      message: error.message,
      modelId: options?.modelId,
      attempts: options?.attempts,
    });
  }
  if (error instanceof Error && /abort/i.test(error.message)) {
    return new GuardError({
      errorClass: "CANCELLED",
      diagnosticCode: "ABORT_SIGNAL",
      message: error.message,
      modelId: options?.modelId,
      attempts: options?.attempts,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) {
    return new GuardError({
      errorClass: "TIMEOUT",
      diagnosticCode: "TIMEOUT",
      message,
      modelId: options?.modelId,
      attempts: options?.attempts,
    });
  }
  if (/out of memory|oom|low memory|insufficient memory/i.test(message)) {
    return new GuardError({
      errorClass: "LOW_MEMORY",
      diagnosticCode: "OOM_RUNTIME",
      message,
      modelId: options?.modelId,
      attempts: options?.attempts,
    });
  }
  return new GuardError({
    errorClass: "RUNTIME_ERROR",
    diagnosticCode: "RUNTIME_CRASH",
    message,
    modelId: options?.modelId,
    attempts: options?.attempts,
  });
}

function guardErrorFromVerdict(
  verdict: TextVerdict,
  options?: { modelId?: string; attempts?: number; faultMode?: FaultMode },
): GuardError {
  const errorClass = verdict.errorClass as AiErrorClass;
  let diagnosticCode = verdict.diagnosticCode;
  if (options?.faultMode !== undefined && errorClassForMode(options.faultMode) === errorClass) {
    diagnosticCode = diagnosticCodeForMode(options.faultMode);
  }
  return new GuardError({ errorClass, diagnosticCode, modelId: options?.modelId, attempts: options?.attempts });
}

/**
 * Interrupt handle for R3: aborts the in-flight generation where the
 * runtime honors AbortSignal (FakeAiProvider and the native bridge both do).
 */
export function createGuardController(linked?: AbortSignal): { signal: AbortSignal; interrupt: () => void } {
  const controller = new AbortController();
  if (linked !== undefined) {
    if (linked.aborted) controller.abort();
    else linked.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, interrupt: () => controller.abort() };
}

export interface GuardedCallOptions extends ClassifyOptions {
  provider: GuardProvider;
  kind: "text" | "photo";
  prompt?: string;
  imageUri?: string;
  instruction?: string;
  /**
   * Generation policy. Defaults restore the Task-20/29 evidence envelope
   * (all 129 rows ran at temperature 0.0 under 256/512-token caps); callers
   * may override per call. Always forwarded to the provider.
   */
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Guard-owned generation deadline. No default: the production budget is
   * TBD (Task-20/29 measurements + ModelProfile) — callers pass it
   * explicitly. Omitted means no guard timeout.
   */
  deadlineMs?: number;
  signal?: AbortSignal;
  faultMode?: FaultMode;
}

export interface GuardedSuccess extends GuardResult {
  attempts: number;
  retried: boolean;
}

/** Default generation policy: the Task-20/29 evidence envelope. */
export const GUARD_DEFAULT_TEMPERATURE = 0.0;
export const GUARD_DEFAULT_MAX_OUTPUT_TOKENS_TEXT = 256;
export const GUARD_DEFAULT_MAX_OUTPUT_TOKENS_PHOTO = 512;

function withDeadline<T>(task: Promise<T>, ms: number, onDeadline: () => void): Promise<T> {
  void task.then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the verdict is deterministically TIMEOUT: the abort
      // below makes abort-aware providers reject (CANCELLED-shaped), which
      // must not win the race — it is our own interrupt, not user intent.
      reject(new GuardError({ errorClass: "TIMEOUT", diagnosticCode: "GUARD_DEADLINE_EXCEEDED" }));
      onDeadline();
    }, ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function runOnce(options: GuardedCallOptions, signal: AbortSignal | undefined): Promise<GuardedSuccess> {
  if (signal !== undefined && signal.aborted) {
    throw new GuardError({ errorClass: "CANCELLED", diagnosticCode: "ABORT_BEFORE_START", attempts: 1 });
  }
  // The guard owns the deadline: a linked controller lets the deadline path
  // interrupt the runaway instead of leaving it live while a retry starts.
  const guard = createGuardController(signal);
  const maxOutputTokens =
    options.maxOutputTokens ?? (options.kind === "photo" ? GUARD_DEFAULT_MAX_OUTPUT_TOKENS_PHOTO : GUARD_DEFAULT_MAX_OUTPUT_TOKENS_TEXT);
  const temperature = options.temperature ?? GUARD_DEFAULT_TEMPERATURE;
  let raw: GuardResult;
  try {
    const task =
      options.kind === "text"
        ? options.provider.generateText({ prompt: options.prompt ?? "", maxOutputTokens, temperature }, guard.signal)
        : options.provider.analyzePhoto(
            { imageUri: options.imageUri ?? "", instruction: options.instruction ?? "", maxOutputTokens, temperature },
            guard.signal,
          );
    raw = options.deadlineMs === undefined ? await task : await withDeadline(task, options.deadlineMs, () => guard.interrupt());
  } catch (error) {
    throw guardErrorFromRejection(error, { attempts: 1 });
  }
  if (signal !== undefined && signal.aborted) {
    throw new GuardError({
      errorClass: "CANCELLED",
      diagnosticCode: "ABORT_MID_GENERATION",
      modelId: raw.modelId,
      attempts: 1,
    });
  }
  const verdict = classifyTextOutput(raw.text, options);
  if (!verdict.ok) {
    throw guardErrorFromVerdict(verdict, { modelId: raw.modelId, attempts: 1, faultMode: options.faultMode });
  }
  return { text: raw.text, modelId: raw.modelId, attempts: 1, retried: false };
}

/**
 * Guarded generation with at most ONE automatic repair/retry on retryable
 * classes, then the user chooses (recovery copy on the thrown GuardError).
 * No hidden loops: a second failure always surfaces.
 */
export async function guardedGenerate(options: GuardedCallOptions): Promise<GuardedSuccess> {
  try {
    return await runOnce(options, options.signal);
  } catch (error) {
    const first = guardErrorFromRejection(error);
    // A guard-deadline TIMEOUT already spent the caller's budget (and aborted
    // the runaway): no immediate second CPU-bound run. Provider-thrown
    // TIMEOUTs stay retryable via isRetryableClass.
    if (!first.retryable || first.diagnosticCode === "GUARD_DEADLINE_EXCEEDED" || (options.signal !== undefined && options.signal.aborted)) throw first;
    try {
      const retry = await runOnce(options, options.signal);
      return { ...retry, attempts: 2, retried: true };
    } catch (retryError) {
      const second = guardErrorFromRejection(retryError);
      throw new GuardError({
        errorClass: second.errorClass,
        diagnosticCode: second.diagnosticCode,
        message: second.message,
        modelId: second.modelId ?? first.modelId,
        attempts: 2,
      });
    }
  }
}

/**
 * Session health tracker. One malformed response only degrades; repeated
 * loops/runtime failures mark the model unstable for this session only.
 * Successes never heal within a session (failures stay visible to the UI).
 */
export class SessionHealthTracker {
  private readonly loopOrRuntime = new Map<string, number>();
  private readonly faults = new Map<string, number>();

  record(modelId: string, outcome: AiErrorClass | "OK"): SessionHealth {
    if (outcome === "OK") return this.health(modelId);
    this.faults.set(modelId, (this.faults.get(modelId) ?? 0) + 1);
    if (outcome === "LOOP_DETECTED" || outcome === "RUNTIME_ERROR") {
      this.loopOrRuntime.set(modelId, (this.loopOrRuntime.get(modelId) ?? 0) + 1);
    }
    return this.health(modelId);
  }

  health(modelId: string): SessionHealth {
    if ((this.loopOrRuntime.get(modelId) ?? 0) >= 2 || (this.faults.get(modelId) ?? 0) >= 3) {
      return "UNSTABLE_THIS_SESSION";
    }
    if ((this.faults.get(modelId) ?? 0) >= 1) return "DEGRADED";
    return "HEALTHY";
  }
}
