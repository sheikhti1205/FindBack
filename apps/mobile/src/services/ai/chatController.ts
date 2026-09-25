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
import { coordinate } from "./requestCoordinator";
import { isChatCheckpoint } from "./providerContract";
import type {
  AiSelection,
  ChatCheckpoint,
  ChatTurn,
  NormalizedRequest,
  ProviderAdapter,
  TaskScope,
} from "./providerContract";
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

export class ControllerError extends Error {
  constructor(
    readonly code:
      | "missing-chat"
      | "account-mismatch"
      | "needs-user-action"
      | "cancelled"
      | "send-failed",
    message: string,
  ) {
    super(message);
    this.name = "ControllerError";
  }
}

/** UI-facing compaction state: data (copy strings), never markup. */
export type CompactionNotice = {
  summarized: boolean;
  summarizedTurnCount: number;
  fallbackRecentOnly: boolean;
  message: string;
};

export type ControllerPhase = "idle" | "sending" | "streaming" | "complete" | "failed" | "cancelled";

export type ControllerState = {
  phase: ControllerPhase;
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
};

export type BuildOptions = {
  signal?: AbortSignal;
  nextWindow?: number;
  approvedImageIds?: readonly string[];
  authorizedResultIds?: readonly string[];
  maxOutputTokens?: number;
  task?: TaskScope;
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
      "Full history stays on this device; nothing was fabricated.",
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
  private state: ControllerState = { phase: "idle", summarized: false, notice: null };
  private readonly listeners = new Set<(state: ControllerState) => void>();

  constructor(options: ControllerOptions) {
    this.store = options.store;
    this.selection = options.selection;
    this.adapter = options.adapter;
    this.systemPolicy = options.systemPolicy;
    this.knowledge = options.knowledge;
    this.budget = options.budget;
    this.keepRecentCount = options.keepRecentCount ?? 6;
    this.summaryProvider = options.summaryProvider;
  }

  subscribe(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

  buildOutgoingContext(chatId: string, currentText: string, options: BuildOptions = {}): BuiltContext {
    const accountId = this.selection.accountId;
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
      selection: this.selection,
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

  async send(chatId: string, text: string, options: BuildOptions = {}): Promise<SendResult> {
    this.update({ phase: "sending", lastError: undefined });
    let built: BuiltContext;
    try {
      built = this.buildOutgoingContext(chatId, text, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Context build failed.";
      this.update({ phase: "failed", lastError: message });
      throw error;
    }

    let answer = "";
    let stopReason: "complete" | "cancelled" | "error" = "complete";
    let lastErrorMessage = "";
    try {
      for await (const event of coordinate(built.request, { adapter: this.adapter })) {
        if (event.kind === "text") {
          answer += event.delta;
          this.update({ phase: "streaming" });
        } else if (event.kind === "error") {
          lastErrorMessage = event.message;
        } else if (event.kind === "done") {
          stopReason = event.stopReason;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Send failed.";
      this.update({ phase: "failed", lastError: message });
      throw error;
    }

    if (stopReason === "cancelled" || built.request.signal.aborted) {
      this.update({ phase: "cancelled", lastError: "Send was cancelled." });
      throw new ControllerError(
        "cancelled",
        "Send was cancelled; transcript and checkpoint unchanged.",
      );
    }
    if (stopReason === "error") {
      this.update({ phase: "failed", lastError: lastErrorMessage });
      throw new ControllerError("send-failed", lastErrorMessage || "Provider reported an error.");
    }

    if (!built.transient) {
      try {
        const accountId = this.selection.accountId;
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
          this.update({ phase: "failed", lastError: message });
          throw error;
        }
      }
    }
    this.update({ phase: "complete" });
    return { request: built.request, layers: built.layers, answer, notice: built.notice };
  }
}

/** Re-export for callers that budget around the controller. */
export { computeContextBudget, estimateTextTokens };
export type { ContextBudgetInput };
