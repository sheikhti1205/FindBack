/**
 * Chat controller (packet H1): glue between the per-chat store, per-chat
 * compaction, and R1's assembler/coordinator (all read-only here).
 *
 * - Builds the outgoing context from store turns + checkpoint + current turn:
 *   app-controlled policy and current versioned knowledge are resolved fresh
 *   on EVERY send (never cached, never summarized); the compaction summary
 *   travels only through the assembler's `untrusted-summary` layer and is
 *   never concatenated into system instructions.
 * - Adaptive compaction before send: older turns summarize, recent turns ride
 *   verbatim, the latest user intent is always verbatim. A smaller
 *   `nextWindow` recompacts (or stops with `needs-user-action`) BEFORE the
 *   provider call — never a blind oversized send, never silent truncation or
 *   dropped images.
 * - Observable state for the UI (`subscribe`/`getState`) plus a data-only
 *   {@link CompactionNotice} (copy strings, no markup): whether older context
 *   is summarized, and a recent-only fallback notice when a summary fails.
 * - Failure/cancellation leaves the transcript and checkpoint intact (no
 *   partial assistant turn is persisted). Restoring drafts never resends
 *   them; `restore()` performs zero provider calls. History-off or unknown
 *   chats send transiently without persisting.
 */
import { assembleRequest, buildWireLayers } from "./requestAssembler";
import type { AssemblerInput, VersionedText, WireLayer } from "./requestAssembler";
import { TIMEOUT_ERROR_COPY, coordinate } from "./requestCoordinator";
import { isChatCheckpoint, isSelectionAuthorized } from "./providerContract";
import type {
  AiSelection,
  ChatCheckpoint,
  ChatTurn,
  ModelRecord,
  NormalizedRequest,
  ProviderAdapter,
  ProviderId,
  TaskScope,
} from "./providerContract";
import { resolveSelection } from "./modelPolicy";
import { computeContextBudget, resolveOutputCap } from "./contextBudget";
import type { ContextBudgetInput } from "./contextBudget";
import {
  advanceCheckpoint,
  buildExtractiveSummary,
  estimateTextTokens,
  isSummaryPoisoned,
  planCompaction,
  recompactForModelSwitch,
} from "./compaction";
import { ChatStore, HistoryDisabledError } from "./chatStore";
import { beginCloudChatSpan } from "../monitoring/sentry";
import {
  resolveAssistantIntent,
  type ResolvedAssistantIntent,
} from "./ops/intentRouter";

export class ControllerError extends Error {
  constructor(
    readonly code:
      | "missing-chat"
      | "account-mismatch"
      | "needs-user-action"
      | "cancelled"
      | "send-failed",
    message: string,
    /**
     * The normalized stream code the failure came from, when one exists
     * ("rate-limited", "timeout-first-token", an adapter's own code). The
     * message may carry upstream text; this code is what the UI keys consumer
     * copy on, so no provider string is ever rendered (CF-070 R2 finding 2).
     */
    readonly streamCode?: string,
  ) {
    super(message);
    this.name = "ControllerError";
  }
}

/** Generic line for a failure whose code names nothing actionable. */
const SEND_FAILED_COPY = "The assistant could not answer just now. Try again.";

/**
 * Consumer copy for a failure whose upstream text is diagnostic, not readable.
 *
 * Null-prototype dictionaries on purpose: a plain object literal inherits
 * `Object.prototype`, so `map[code]` returns a function/object for reserved
 * keys (`constructor`, `toString`, `__proto__`) and `??` cannot catch that,
 * because a function is not nullish (CF-070 R2 finding 3).
 */
const TRANSPORT_ERROR_COPY: Record<string, string> = Object.assign(Object.create(null), {
  "auth-invalid": "The saved AI key was rejected. Check it in Chat options → Providers, then try again.",
  "auth-forbidden": "The AI provider refused that key for this model. Check it in Chat options → Providers.",
  "auth-missing": "No AI key is saved for this account yet. Add one in Chat options → Providers.",
  "payment-required": "The AI provider reports no remaining credit for this key.",
  "rate-limited": "Too many requests right now. Try again in a moment.",
  "network-error": "The assistant could not reach the network. Check your connection and try again.",
  "provider-error": "The AI service is having trouble. Try again in a moment.",
  "request-failed": "The assistant could not reach the AI service. Try again.",
  "bad-request": "The assistant could not send that request. Pick another model and try again.",
  "not-found": "That AI model is no longer available. Pick another with the model button above the message box.",
} as Record<string, string>);

const CONTROLLER_FAILURE_COPY: Record<string, string> = Object.assign(Object.create(null), {
  "missing-chat": "Open a chat first, then send again.",
  "account-mismatch": "The active account changed. Open Help again and send again.",
  "needs-user-action": "The assistant needs something from you first. Check the prompt and try again.",
  cancelled: "Send stopped. Your message was kept.",
} as Record<string, string>);

/** Own-property, string-valued lookup; never an inherited member. */
function ownCopy(map: Record<string, string>, key: string | undefined): string | null {
  if (key === undefined || !Object.hasOwn(map, key)) return null;
  const copy = map[key];
  return typeof copy === "string" ? copy : null;
}

/**
 * Consumer copy for a failed send.
 *
 * Provider and network failures carry text written by the remote service
 * ("max_tokens exceeds context_length"); that text stays on the controller's
 * scrubbed `lastError` for diagnostics and is never rendered. Every rendered
 * line is resolved from the normalized CODE, including the timeout codes: the
 * coordinator forwards adapter error events unchanged, so an adapter can claim
 * a timeout code with arbitrary text, and code alone is not proof that a
 * message was written here (CF-070 R2 findings 2 and 2-retry). The timeout
 * codes resolve to the same lines the coordinator emits.
 */
export function consumerSendErrorCopy(error: unknown): string {
  if (!(error instanceof ControllerError)) return SEND_FAILED_COPY;
  if (error.code !== "send-failed") {
    return ownCopy(CONTROLLER_FAILURE_COPY, error.code) ?? SEND_FAILED_COPY;
  }
  const code = error.streamCode;
  return (
    ownCopy(TIMEOUT_ERROR_COPY as Record<string, string>, code) ??
    ownCopy(TRANSPORT_ERROR_COPY, code) ??
    SEND_FAILED_COPY
  );
}

/**
 * Clip bound for surfaced error text. Provider messages are untrusted data:
 * they may echo user input or credential-like strings, so they are clipped
 * and scrubbed before reaching state.
 */
const ERROR_CLIP_CHARS = 300;

const KEY_LIKE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9\-_]+/g,
  /bearer\s+[^\s]+/gi,
  /api[_-]?key\s*[:=]\s*[^\s]+/gi,
  /data:[^\s]+/gi,
];

/**
 * Scrub a raw error message for UI state: redact key-like material, strip
 * caller-supplied secrets (e.g. the prompt text a provider echoed back), and
 * clip. Never pass prompt text, keys, or query content through unscanned.
 */
export function sanitizeControllerError(message: string, secrets: readonly string[] = []): string {
  let out = message;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 3 && out.includes(trimmed)) {
      out = out.split(trimmed).join("[redacted-input]");
    }
  }
  for (const pattern of KEY_LIKE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted-key]");
  }
  if (out.length > ERROR_CLIP_CHARS) out = out.slice(0, ERROR_CLIP_CHARS) + "…";
  return out;
}

/** UI-facing compaction state: data (copy strings), never markup. */
export type CompactionNotice = {
  summarized: boolean;
  summarizedTurnCount: number;
  fallbackRecentOnly: boolean;
  message: string;
};

export type ControllerPhase = "idle" | "sending" | "streaming" | "complete" | "failed" | "cancelled";

/**
 * UI-facing controller state (frozen M1 contract, owned by C, consumed by B).
 *
 * - `partialText` is the accumulated in-flight delta only: it is reset on
 *   every send, grows while `streaming`, and is NEVER persisted (only the
 *   final answer is appended to the store on `complete`). A cancelled or
 *   failed send persists nothing, including its partial text.
 * - `attempt` mirrors the coordinator's 1-based attempt for the in-flight
 *   request (`0` when idle, before the first event).
 * - `provider`/`modelId` echo the selection EFFECTIVE for the in-flight (or
 *   last) request — a per-request override, never the constructor default.
 */
export type ControllerState = {
  phase: ControllerPhase;
  partialText: string;
  attempt: number;
  provider: ProviderId;
  modelId: string;
  summarized: boolean;
  notice: CompactionNotice | null;
  lastError?: string;
};

/** Override that must itself pass checkpoint validation + poison screening. */
export type SummaryProvider = () => ChatCheckpoint | undefined;

export type ControllerOptions = {
  store: ChatStore;
  selection: AiSelection;
  adapter: ProviderAdapter;
  systemPolicy: VersionedText | (() => VersionedText);
  knowledge: VersionedText | (() => VersionedText);
  budget: ContextBudgetInput;
  keepRecentCount?: number;
  summaryProvider?: SummaryProvider;
  /**
   * Catalogue used to validate per-request selection overrides via
   * `resolveSelection`. Absent (legacy callers) ⇒ only the minimal gates
   * (account match, paid-explicit carries consent) apply.
   */
  catalog?: readonly ModelRecord[];
  fingerprintOf?: (record: ModelRecord) => string;
};

export type BuildOptions = {
  signal?: AbortSignal;
  nextWindow?: number;
  approvedImageIds?: readonly string[];
  authorizedResultIds?: readonly string[];
  maxOutputTokens?: number;
  task?: TaskScope;
};

/**
 * Per-request send options (frozen M1 contract). `selection`/`adapter`
 * override the constructor binding for ONE send: the override is validated
 * via `resolveSelection`/`isSelectionAuthorized` (unknown/blocked/unconsented
 * ⇒ `ControllerError`, no send), the in-flight attempt is cancelled, and
 * context is rebuilt + rebudgeted for the new window. Absent ⇒ the
 * constructor binding is used (legacy behavior).
 */
export type SendOptions = BuildOptions & {
  selection?: AiSelection;
  adapter?: ProviderAdapter;
};

export type BuiltContext = {
  request: NormalizedRequest;
  layers: WireLayer[];
  notice: CompactionNotice;
  /** True when the chat is unknown/history-off: send without persisting. */
  transient: boolean;
};

export type SendResult = {
  request: NormalizedRequest;
  layers: WireLayer[];
  answer: string;
  notice: CompactionNotice;
};

function resolveText(source: VersionedText | (() => VersionedText)): VersionedText {
  return typeof source === "function" ? source() : source;
}

function plainNotice(): CompactionNotice {
  return {
    summarized: false,
    summarizedTurnCount: 0,
    fallbackRecentOnly: false,
    message: "Full recent history fits; nothing was summarized.",
  };
}

function fallbackNotice(): CompactionNotice {
  return {
    summarized: false,
    summarizedTurnCount: 0,
    fallbackRecentOnly: true,
    message:
      "Summary unavailable — showing recent messages only. " +
      "The earlier messages were not sent anywhere; nothing was fabricated.",
  };
}

export class ChatController {
  private readonly store: ChatStore;
  private readonly selection: AiSelection;
  private readonly adapter: ProviderAdapter;
  private readonly systemPolicy: VersionedText | (() => VersionedText);
  private readonly knowledge: VersionedText | (() => VersionedText);
  private readonly budget: ContextBudgetInput;
  private readonly keepRecentCount: number;
  private readonly summaryProvider?: SummaryProvider;
  private readonly catalog?: readonly ModelRecord[];
  private readonly fingerprintOf?: (record: ModelRecord) => string;
  private state: ControllerState;
  private readonly listeners = new Set<(state: ControllerState) => void>();
  /**
   * Stale-turn guard: incremented on every send and every cancel. Stream
   * events captured under an older generation are ignored (late chunks after
   * cancel or after a superseding send never reach state or the store).
   */
  private generation = 0;
  private inFlightAbort: AbortController | null = null;

  constructor(options: ControllerOptions) {
    this.store = options.store;
    this.selection = options.selection;
    this.adapter = options.adapter;
    this.systemPolicy = options.systemPolicy;
    this.knowledge = options.knowledge;
    this.budget = options.budget;
    this.keepRecentCount = options.keepRecentCount ?? 6;
    this.summaryProvider = options.summaryProvider;
    this.catalog = options.catalog;
    this.fingerprintOf = options.fingerprintOf;
    this.state = {
      phase: "idle",
      partialText: "",
      attempt: 0,
      provider: options.selection.provider,
      modelId: options.selection.modelId,
      summarized: false,
      notice: null,
    };
  }

  /**
   * Subscribe to state snapshots. No replay: the listener receives only
   * emissions after subscribing — call `getState()` first for the initial
   * paint. Returns an unsubscribe function; call it on unmount.
   */
  subscribe(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Abort the in-flight send, if any. Late chunks arriving after cancel are
   * ignored; no partial turn is persisted. No-op when idle.
   */
  cancel(): void {
    if (this.inFlightAbort === null) return;
    this.generation += 1;
    this.inFlightAbort.abort();
    this.inFlightAbort = null;
    if (this.state.phase === "sending" || this.state.phase === "streaming") {
      this.update({ phase: "cancelled", partialText: "", lastError: "Send was cancelled." });
    }
  }

  getState(): ControllerState {
    return { ...this.state };
  }

  getNotice(): CompactionNotice | null {
    return this.state.notice === null ? null : { ...this.state.notice };
  }

  private update(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener({ ...snapshot });
  }

  /** Restore persisted chats. Never sends: zero provider calls. */
  async restore(...accountIds: string[]): Promise<void> {
    await this.store.restore(...accountIds);
    this.update({ phase: "idle" });
  }

  buildOutgoingContext(
    chatId: string,
    currentText: string,
    options: BuildOptions & { selection?: AiSelection } = {},
  ): BuiltContext {
    const selection = options.selection ?? this.selection;
    const accountId = selection.accountId;
    let turns: ChatTurn[];
    let storedCheckpoint: ChatCheckpoint | undefined;
    let transient = false;
    try {
      const chat = this.store.continueChat(accountId, chatId);
      if (chat.accountId !== accountId) {
        throw new ControllerError("account-mismatch", "Chat belongs to another account.");
      }
      turns = [...chat.turns];
      storedCheckpoint = this.store.getCheckpoint(accountId, chatId);
    } catch (error) {
      if (error instanceof ControllerError) throw error;
      // Unknown chat or history disabled: send transiently, persist nothing.
      transient = true;
      turns = [];
      storedCheckpoint = undefined;
    }

    const systemPolicy = resolveText(this.systemPolicy);
    const knowledge = resolveText(this.knowledge);
    const signal = options.signal ?? new AbortController().signal;
    const approvedImageIds = [...(options.approvedImageIds ?? [])];
    const authorizedResultIds = [...(options.authorizedResultIds ?? [])];

    const plan = planCompaction({
      turns,
      currentText,
      keepRecentCount: this.keepRecentCount,
      budget: { ...this.budget },
    });

    let summary: ChatCheckpoint | undefined;
    let recentTurns: ChatTurn[] = plan.recentTurns;
    let notice: CompactionNotice = plainNotice();

    if (plan.shouldCompact && plan.olderTurns.length > 0) {
      try {
        summary = this.buildSummary(plan.olderTurns);
        recentTurns = plan.recentTurns;
        notice = {
          summarized: true,
          summarizedTurnCount: plan.olderTurns.length,
          fallbackRecentOnly: false,
          message:
            `Older messages are summarized (${plan.olderTurns.length} of ${turns.length}); ` +
            "recent messages are sent verbatim. Originals stay on this device.",
        };
      } catch {
        summary = undefined;
        recentTurns = plan.recentTurns;
        notice = fallbackNotice();
      }
    } else if (
      storedCheckpoint !== undefined &&
      isChatCheckpoint(storedCheckpoint) &&
      !isSummaryPoisoned(storedCheckpoint.summaryText)
    ) {
      // A valid earlier checkpoint still covers a prefix: send it plus only
      // the newer verbatim turns.
      const covered = new Set(storedCheckpoint.sourceTurnIds);
      const allCovered = storedCheckpoint.sourceTurnIds.every(
        (id, index) => turns[index]?.id === id,
      );
      if (allCovered && covered.has(storedCheckpoint.coveredThroughTurnId)) {
        summary = storedCheckpoint;
        recentTurns = turns.slice(storedCheckpoint.sourceTurnIds.length);
        notice = {
          summarized: true,
          summarizedTurnCount: storedCheckpoint.sourceTurnIds.length,
          fallbackRecentOnly: false,
          message:
            `Older messages are summarized (${storedCheckpoint.sourceTurnIds.length} of ${turns.length}); ` +
            "recent messages are sent verbatim. Originals stay on this device.",
        };
      }
    }

    if (options.nextWindow !== undefined && options.nextWindow !== this.budget.verifiedContextWindow) {
      const switched = recompactForModelSwitch({
        turns,
        currentText,
        keepRecentCount: this.keepRecentCount,
        approvedImageIds,
        baseBudget: { ...this.budget, estimatedInput: plan.estimatedInput },
        nextWindow: options.nextWindow,
      });
      if (switched.action === "needs-user-action") {
        throw new ControllerError(
          "needs-user-action",
          `${switched.reason} Your draft is kept; reduce context or pick a verified compatible model.`,
        );
      }
      if (switched.action === "recompacted") {
        summary = switched.checkpoint;
        recentTurns = [...switched.recentTurns];
        notice = {
          summarized: true,
          summarizedTurnCount: turns.length - switched.recentTurns.length,
          fallbackRecentOnly: false,
          message:
            "Recompacted for the smaller model before sending; " +
            "recent messages stay verbatim and images are kept.",
        };
      }
    }

    const assemblerInput: AssemblerInput = {
      selection,
      task: options.task ?? "general",
      systemPolicy,
      knowledge,
      ...(summary === undefined ? {} : { summary }),
      recentTurns,
      currentText,
      approvedImageIds,
      authorizedResultIds,
      maxOutputTokens: options.maxOutputTokens ?? resolveOutputCap({}),
      signal,
    };
    const request = assembleRequest(assemblerInput);
    const layers = buildWireLayers(assemblerInput);
    this.update({ summarized: notice.summarized, notice });
    return { request, layers, notice: { ...notice }, transient };
  }

  /**
   * Build a fresh checkpoint for older turns. An injected summaryProvider
   * override must pass the same validation + poison screening; anything
   * suspicious throws and the caller falls back to recent-only.
   */
  private buildSummary(olderTurns: ChatTurn[]): ChatCheckpoint {
    if (this.summaryProvider !== undefined) {
      const candidate = this.summaryProvider();
      if (candidate === undefined) throw new ControllerError("send-failed", "No summary produced.");
      if (!isChatCheckpoint(candidate) || isSummaryPoisoned(candidate.summaryText)) {
        throw new ControllerError(
          "send-failed",
          "Injected summary failed validation; treating it as untrusted data.",
        );
      }
      const olderIds = olderTurns.map((turn) => turn.id);
      const coversExactly =
        candidate.sourceTurnIds.length === olderIds.length &&
        candidate.sourceTurnIds.every((id, index) => olderIds[index] === id);
      if (!coversExactly) {
        throw new ControllerError("send-failed", "Injected summary coverage mismatch.");
      }
      return candidate;
    }
    const { summaryText, sourceTurnIds } = buildExtractiveSummary(olderTurns);
    return advanceCheckpoint({
      previous: undefined,
      olderTurns,
      coveredThroughTurnId: sourceTurnIds[sourceTurnIds.length - 1]!,
      summaryText,
      generatedBy: "local-extractive",
    });
  }

  /**
   * Resolve the selection + adapter effective for one send. An override is
   * validated via `resolveSelection`/`isSelectionAuthorized` against the
   * controller catalogue: unknown models, blocked routes, unconsented paid
   * models, and consent mismatches (changed price, wrong task) throw
   * `ControllerError` and NOTHING is sent. The provider must also match the
   * catalogue record — a display-label typo never silently switches provider.
   */
  private resolveEffective(input: {
    selection?: AiSelection;
    adapter?: ProviderAdapter;
    task?: TaskScope;
  }): { selection: AiSelection; adapter: ProviderAdapter } {
    const adapter = input.adapter ?? this.adapter;
    if (input.selection === undefined) return { selection: this.selection, adapter };
    const requested = input.selection;
    if (requested.accountId !== this.selection.accountId) {
      throw new ControllerError("account-mismatch", "Selection belongs to another account.");
    }
    const task = input.task ?? "general";
    if (this.catalog !== undefined) {
      const fingerprintOf = this.fingerprintOf ?? ((): string => "");
      const resolved = resolveSelection({
        accountId: requested.accountId,
        catalog: this.catalog,
        task,
        desiredModelId: requested.modelId,
        mode: requested.mode,
        ...(requested.paidConsent === undefined ? {} : { paidConsent: requested.paidConsent }),
        fingerprintOf,
      });
      if (!resolved.ok) {
        if (resolved.error === "consent-required") {
          throw new ControllerError(
            "needs-user-action",
            "That model may cost money. Review its price and confirm explicit consent first. Your draft is kept.",
          );
        }
        if (resolved.error === "consent-invalid") {
          throw new ControllerError(
            "needs-user-action",
            "Saved consent no longer matches the current price or task. Review and confirm again. Your draft is kept.",
          );
        }
        if (resolved.error === "blocked-model") {
          throw new ControllerError(
            "send-failed",
            "That provider route is blocked on this device. Your draft is kept.",
          );
        }
        throw new ControllerError(
          "send-failed",
          "That model is not in the loaded catalogue. Your draft is kept; pick a listed model.",
        );
      }
      if (resolved.selection.provider !== requested.provider) {
        throw new ControllerError(
          "send-failed",
          "Selection provider does not match the catalogue record. Your draft is kept.",
        );
      }
      if (!isSelectionAuthorized(resolved.selection, resolved.record, fingerprintOf(resolved.record), task)) {
        throw new ControllerError(
          "needs-user-action",
          "Selection is not authorized for this task. Review consent and try again. Your draft is kept.",
        );
      }
      return { selection: resolved.selection, adapter };
    }
    // No catalogue (legacy callers): minimal gates only.
    if (requested.mode === "paid-explicit" && requested.paidConsent === undefined) {
      throw new ControllerError(
        "needs-user-action",
        "That model may cost money. Review its price and confirm explicit consent first. Your draft is kept.",
      );
    }
    return { selection: requested, adapter };
  }

  async send(chatId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    let effective: { selection: AiSelection; adapter: ProviderAdapter };
    try {
      effective = this.resolveEffective(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Selection rejected.";
      this.update({
        phase: "failed",
        partialText: "",
        attempt: 0,
        lastError: sanitizeControllerError(message),
      });
      throw error;
    }

    // A new send supersedes any in-flight attempt: abort it and invalidate
    // its generation so late chunks can never land in state or the store.
    this.inFlightAbort?.abort();
    this.generation += 1;
    const generation = this.generation;
    const linked = new AbortController();
    if (options.signal !== undefined) {
      if (options.signal.aborted) linked.abort();
      else options.signal.addEventListener("abort", () => linked.abort(), { once: true });
    }
    this.inFlightAbort = linked;

    this.update({
      phase: "sending",
      partialText: "",
      attempt: 0,
      provider: effective.selection.provider,
      modelId: effective.selection.modelId,
      lastError: undefined,
    });
    let built: BuiltContext;
    try {
      built = this.buildOutgoingContext(chatId, text, {
        ...options,
        selection: effective.selection,
        signal: linked.signal,
      });
    } catch (error) {
      if (generation !== this.generation) throw new ControllerError("cancelled", "Superseded by a newer send.");
      const message = error instanceof Error ? error.message : "Context build failed.";
      this.update({ phase: "failed", partialText: "", lastError: sanitizeControllerError(message, [text]) });
      throw error;
    }

    let answer = "";
    let attempt = 0;
    let activeAttempt = 0;
    let stopReason: "complete" | "cancelled" | "error" = "complete";
    let lastErrorMessage = "";
    let lastErrorCode = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const monitoring = beginCloudChatSpan({
      owner: this,
      accountId: effective.selection.accountId,
      chatId,
      provider: effective.selection.provider,
      modelId: effective.selection.modelId,
      signal: linked.signal,
    });
    try {
      for await (const event of coordinate(built.request, { adapter: effective.adapter })) {
        // Stale turn or abort: ignore everything late, including text that
        // arrives after cancel. Never accumulate hallucinated output.
        if (generation !== this.generation || linked.signal.aborted) {
          stopReason = "cancelled";
          break;
        }
        // The coordinator normalizes attempt identity on EVERY event. A newer
        // outer attempt is a clean slate: discard any text a failed attempt
        // accumulated so retry output can never blend into the final answer.
        if (event.attempt > activeAttempt) {
          activeAttempt = event.attempt;
          answer = "";
          inputTokens = undefined;
          outputTokens = undefined;
          this.update({
            phase: "sending",
            partialText: "",
            attempt: activeAttempt,
            provider: effective.selection.provider,
            modelId: effective.selection.modelId,
          });
        }
        if (event.kind === "text") {
          answer += event.delta;
          attempt = activeAttempt;
          this.update({
            phase: "streaming",
            partialText: answer,
            attempt,
            provider: effective.selection.provider,
            modelId: effective.selection.modelId,
          });
        } else if (event.kind === "usage") {
          if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
          if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
        } else if (event.kind === "error") {
          lastErrorMessage = event.message;
          lastErrorCode = event.code;
          attempt = activeAttempt;
        } else if (event.kind === "done") {
          stopReason = event.stopReason;
          attempt = activeAttempt;
        }
      }
    } catch (error) {
      stopReason = "error";
      if (generation !== this.generation) throw new ControllerError("cancelled", "Superseded by a newer send.");
      const message = error instanceof Error ? error.message : "Send failed.";
      this.update({ phase: "failed", partialText: "", lastError: sanitizeControllerError(message, [text]) });
      throw error;
    } finally {
      monitoring.finish(linked.signal.aborted || generation !== this.generation ? "cancelled" : stopReason, { inputTokens, outputTokens });
    }

    if (generation !== this.generation) {
      // Superseded (cancel() or a newer send already set the state).
      throw new ControllerError("cancelled", "Send was cancelled; transcript and checkpoint unchanged.");
    }
    this.inFlightAbort = null;

    if (stopReason === "cancelled" || built.request.signal.aborted) {
      this.update({ phase: "cancelled", partialText: "", lastError: "Send was cancelled." });
      throw new ControllerError("cancelled", "Send was cancelled; transcript and checkpoint unchanged.");
    }
    if (stopReason === "error") {
      const message = lastErrorMessage || "Provider reported an error.";
      this.update({ phase: "failed", partialText: "", lastError: sanitizeControllerError(message, [text]) });
      throw new ControllerError(
        "send-failed",
        sanitizeControllerError(message, [text]),
        lastErrorCode === "" ? undefined : lastErrorCode,
      );
    }

    if (!built.transient) {
      try {
        const accountId = effective.selection.accountId;
        this.store.appendTurn(accountId, chatId, { role: "user", text });
        if (answer.trim() !== "") {
          this.store.appendTurn(accountId, chatId, { role: "assistant", text: answer });
        }
        if (this.store.getDraft(accountId, chatId) === text) {
          this.store.takeDraftForSend(accountId, chatId);
        }
        await this.store.flushDrafts();
      } catch (error) {
        if (error instanceof HistoryDisabledError) {
          // History off: the send already succeeded transiently.
        } else {
          const message = error instanceof Error ? error.message : "Persist failed.";
          this.update({ phase: "failed", partialText: "", lastError: sanitizeControllerError(message, [text]) });
          throw error;
        }
      }
    }
    this.update({
      phase: "complete",
      // partialText is in-flight streaming ONLY. The final answer already
      // lives in SendResult.answer (and the persisted assistant turn), so a
      // completed send must NEVER leave a rendered partial behind — that dual
      // ownership is what produced the original two-bubble defect.
      partialText: "",
      attempt,
      provider: effective.selection.provider,
      modelId: effective.selection.modelId,
    });
    return { request: built.request, layers: built.layers, answer, notice: built.notice };
  }
}

/** Re-export for callers that budget around the controller. */
export { computeContextBudget, estimateTextTokens };
export type { ContextBudgetInput };

/**
 * Lane B intent-routing seam: classify-intent → route-intent → validated app
 * action CTA. Pure and side-effect free: it proposes a visible CTA (or a
 * clarification when ambiguous) and never navigates, sends, or persists.
 * The send() path is untouched — this seam only advises the UI.
 */
export type IntentProposal = ResolvedAssistantIntent;

export function proposeIntentAction(
  text: string,
  options?: { readonly hasLocation?: boolean },
): IntentProposal {
  return resolveAssistantIntent(text, options);
}
