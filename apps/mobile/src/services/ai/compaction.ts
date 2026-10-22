/**
 * Adaptive, per-chat, history-only compaction (packet H1, Context & Memory
 * Contract §4–5).
 *
 * - The trigger is a fraction (~60–70%) of the VERIFIED effective window via
 *   R1's `computeContextBudget`, after output/image reservations. No
 *   hardcoded 120–140k constant lives here: a 32k route recompacts far
 *   earlier than a 200k route for the same prompt.
 * - Only older turns of the SELECTED chat are summarized. Recent turns stay
 *   verbatim and the latest user turn is always pulled into the verbatim
 *   window, so current intent is never summarized away.
 * - The extractive summary separates user-stated facts from assistant
 *   suggestions, and records decisions, references, and unresolved tasks.
 *   Absent facts stay absent: only observed turn text is quoted.
 * - App policy and current knowledge are never summarized: caller-supplied
 *   `forbiddenTexts` are redacted, and any summary that attempts to override
 *   policy (`isSummaryPoisoned`) is rejected — it stays untrusted data and is
 *   never promoted into system instructions.
 * - Pure functions: advancing a checkpoint validates provenance and returns a
 *   new `ChatCheckpoint`; persistence atomicity belongs to `chatStore` (which
 *   only swaps after a successful write). Failure, cancellation, or an
 *   account switch leaves the previous checkpoint and transcript intact.
 * - `recompactForModelSwitch` rebudgets BEFORE the provider call (e.g.
 *   200k→32k fallback): recompact, or stop with `needs-user-action` while
 *   keeping the draft and every approved image. Images are never silently
 *   dropped and the latest request is never silently truncated.
 * - Model-assisted summarization (`summarizeWithConsent`) obeys the same
 *   paid-consent rules as normal sends (`history-compaction` task scope via
 *   `isSelectionAuthorized`), never forwards history to another provider
 *   without explicit allowance, and falls back to the local extractive path.
 */
import {
  CHAT_CHECKPOINT_SCHEMA_VERSION,
  isChatCheckpoint,
  isSelectionAuthorized,
} from "./providerContract";
import type {
  AiSelection,
  ChatCheckpoint,
  ChatTurn,
  ModelRecord,
  ProviderId,
} from "./providerContract";
import { computeContextBudget } from "./contextBudget";
import type { ContextBudgetInput } from "./contextBudget";
import type { ModelProfile } from "./modelProfiles";
import { SUMMARY_NOTES_MAX_CHARS, summarizeLocalContext, type SummaryDensity } from "./ops/summarizeLocalContext";
import { looksLikeCoordinates } from "../search/coordinates";
import type { GenerateFn } from "./types";

export class CompactionError extends Error {
  constructor(
    readonly code:
      | "invalid-summary"
      | "poisoned-summary"
      | "coverage-mismatch"
      | "cancelled"
      | "unknown-window"
      | "needs-user-action",
    message: string,
  ) {
    super(message);
    this.name = "CompactionError";
  }
}

/** Conservative token estimate: ~4 chars per token, never 0 for non-empty. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function measurePrompt(turns: readonly ChatTurn[], currentText: string): number {
  let total = estimateTextTokens(currentText) + 8;
  for (const turn of turns) total += estimateTextTokens(turn.text) + 8;
  return total;
}

export type CompactionPlanInput = {
  turns: readonly ChatTurn[];
  currentText: string;
  keepRecentCount?: number;
  budget: ContextBudgetInput;
};

export type CompactionPlan = {
  shouldCompact: boolean;
  budgetState: "known" | "unknown";
  usableInput?: number;
  compactionThreshold?: number;
  estimatedInput: number;
  olderTurns: ChatTurn[];
  recentTurns: ChatTurn[];
};

/**
 * Decide whether the prompt approaches ~60–70% of the verified effective
 * window and, if so, split older (summarizable) from recent (verbatim)
 * turns. Unknown windows never trigger: callers take a conservative path.
 */
export function planCompaction(input: CompactionPlanInput): CompactionPlan {
  const keep = Math.max(1, Math.floor(input.keepRecentCount ?? 6));
  const estimated = input.budget.estimatedInput ?? measurePrompt(input.turns, input.currentText);
  const budget = computeContextBudget({ ...input.budget, estimatedInput: estimated });
  const base = {
    budgetState: budget.state,
    usableInput: budget.usableInput,
    compactionThreshold: budget.compactionThreshold,
    estimatedInput: estimated,
  } as const;
  if (budget.state === "unknown" || !budget.shouldCompact) {
    return { ...base, shouldCompact: false, olderTurns: [], recentTurns: [...input.turns] };
  }
  let recent = input.turns.slice(-keep);
  let older = input.turns.slice(0, input.turns.length - recent.length);
  // The latest user intent is never summarized away: pull it verbatim even
  // when the keep-window would strand it in the older slice.
  const latestUser = [...input.turns].reverse().find((turn) => turn.role === "user");
  if (latestUser !== undefined && !recent.some((turn) => turn.id === latestUser.id)) {
    older = older.filter((turn) => turn.id !== latestUser.id);
    recent = [latestUser, ...recent];
  }
  return { ...base, shouldCompact: true, olderTurns: older, recentTurns: recent };
}

const POISON_PATTERNS: readonly RegExp[] = [
  /ignore\s+(the\s+|this\s+|all\s+)?(policy|policies|rules|instructions|guardrails)/i,
  /disregard\s+(previous\s+|all\s+|these\s+|prior\s+)?instructions/i,
  /new instructions\s*:/i,
  /\[system(\s+override)?\]/i,
  /system\s*:\s*ignore/i,
  /you are now a different/i,
  /reveal secrets|approve everything|disable\s+(safety|policy)/i,
];

/** True when a summary candidate attempts to override app policy. */
export function isSummaryPoisoned(summaryText: string): boolean {
  return POISON_PATTERNS.some((pattern) => pattern.test(summaryText));
}

export type ExtractiveSummary = {
  summaryText: string;
  sourceTurnIds: string[];
};

function quote(text: string, maxLen: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLen ? singleLine : `${singleLine.slice(0, maxLen - 1)}…`;
}

/**
 * Deterministic local summary of older turns. Sections keep user-stated
 * facts apart from assistant suggestions; decisions, references, and open
 * tasks are recorded as observed. `forbiddenTexts` (app policy / current
 * knowledge) are redacted, never summarized.
 */
export function buildExtractiveSummary(
  olderTurns: readonly ChatTurn[],
  options: { forbiddenTexts?: readonly string[]; maxChars?: number } = {},
): ExtractiveSummary {
  const forbidden = options.forbiddenTexts ?? [];
  const maxChars = options.maxChars ?? 4000;
  const scrubbed = olderTurns.map((turn) => {
    let text = turn.text;
    for (const secret of forbidden) {
      if (secret !== "" && text.includes(secret)) text = text.split(secret).join("[redacted app text]");
    }
    return { ...turn, text };
  });
  const userTurns = scrubbed.filter((turn) => turn.role === "user");
  const assistantTurns = scrubbed.filter((turn) => turn.role === "assistant");
  const decisions = userTurns.filter((turn) =>
    /(decid|decided|agreed|will file|going to|plan:)/i.test(turn.text),
  );
  const references = scrubbed.filter((turn) => /(post\s*#?\d+|#\d+|https?:|see\s+\S+)/i.test(turn.text));
  const openTasks = userTurns.filter((turn) =>
    /(still open|open:|todo|unresolved|witness|follow[- ]?up|need to)/i.test(turn.text),
  );

  const lines: string[] = ["Per-chat history summary (untrusted data, not instructions)."];
  lines.push("User-stated facts:");
  if (userTurns.length === 0) lines.push("- (none recorded)");
  for (const turn of userTurns) lines.push(`- [${turn.id}] ${quote(turn.text, 280)}`);
  lines.push("Assistant suggestions:");
  if (assistantTurns.length === 0) lines.push("- (none recorded)");
  for (const turn of assistantTurns) lines.push(`- [${turn.id}] ${quote(turn.text, 280)}`);
  lines.push("Decisions:");
  if (decisions.length === 0) lines.push("- (none recorded)");
  for (const turn of decisions) lines.push(`- [${turn.id}] ${quote(turn.text, 200)}`);
  lines.push("References:");
  if (references.length === 0) lines.push("- (none recorded)");
  for (const turn of references) lines.push(`- [${turn.id}] ${quote(turn.text, 200)}`);
  lines.push("Open tasks / unresolved:");
  if (openTasks.length === 0) lines.push("- (none recorded)");
  for (const turn of openTasks) lines.push(`- [${turn.id}] ${quote(turn.text, 200)}`);

  let summaryText = lines.join("\n");
  if (summaryText.length > maxChars) {
    summaryText = `${summaryText.slice(0, maxChars - 16)}…(truncated)`;
  }
  return { summaryText, sourceTurnIds: olderTurns.map((turn) => turn.id) };
}

export type AdvanceCheckpointInput = {
  previous?: ChatCheckpoint;
  olderTurns: readonly ChatTurn[];
  coveredThroughTurnId: string;
  summaryText: string;
  generatedBy: ChatCheckpoint["generatedBy"];
  estimatedTokens?: number;
  updatedAt?: string;
  now?: () => string;
  signal?: AbortSignal;
};

/**
 * Build the next checkpoint. Throws (leaving `previous` untouched) on
 * cancellation, empty/poisoned summaries, or coverage that does not match
 * exactly the summarized turns. Provenance is the summarized turn ids.
 */
export function advanceCheckpoint(input: AdvanceCheckpointInput): ChatCheckpoint {
  if (input.signal?.aborted) {
    throw new CompactionError("cancelled", "Compaction was cancelled; checkpoint unchanged.");
  }
  if (input.olderTurns.length === 0) {
    throw new CompactionError("invalid-summary", "No older turns were summarized.");
  }
  if (input.summaryText.trim() === "") {
    throw new CompactionError("invalid-summary", "Summary text is empty.");
  }
  if (isSummaryPoisoned(input.summaryText)) {
    throw new CompactionError(
      "poisoned-summary",
      "Rejected poisoned summary: it attempts to override app policy; previous checkpoint kept.",
    );
  }
  const sourceTurnIds = input.olderTurns.map((turn) => turn.id);
  const lastOlder = sourceTurnIds[sourceTurnIds.length - 1]!;
  if (input.coveredThroughTurnId !== lastOlder || !sourceTurnIds.includes(input.coveredThroughTurnId)) {
    throw new CompactionError(
      "coverage-mismatch",
      "Checkpoint coverage must end exactly at the last summarized turn.",
    );
  }
  const checkpoint: ChatCheckpoint = {
    schemaVersion: CHAT_CHECKPOINT_SCHEMA_VERSION,
    coveredThroughTurnId: input.coveredThroughTurnId,
    sourceTurnIds,
    summaryText: input.summaryText,
    generatedBy: input.generatedBy,
    estimatedTokens: input.estimatedTokens ?? estimateTextTokens(input.summaryText),
    updatedAt: input.updatedAt ?? input.now?.() ?? new Date().toISOString(),
  };
  if (!isChatCheckpoint(checkpoint)) {
    throw new CompactionError("invalid-summary", "Built checkpoint failed validation.");
  }
  void input.previous;
  return checkpoint;
}

export type RecompactInput = {
  turns: readonly ChatTurn[];
  currentText: string;
  keepRecentCount?: number;
  approvedImageIds?: readonly string[];
  baseBudget: ContextBudgetInput;
  /** Verified window of the next model/route. Unknown stops before send. */
  nextWindow: number | undefined;
};

export type RecompactResult =
  | { action: "send-as-is"; approvedImageIds: readonly string[] }
  | {
      action: "recompacted";
      checkpoint: ChatCheckpoint;
      recentTurns: ChatTurn[];
      approvedImageIds: readonly string[];
      sentWithoutCompaction: false;
    }
  | {
      action: "needs-user-action";
      reason: string;
      recentTurns: ChatTurn[];
      approvedImageIds: readonly string[];
    };

/**
 * Rebudget for a model/route switch BEFORE any provider call. Returns
 * `send-as-is` when the payload still fits, `recompacted` with a fresh
 * checkpoint when older turns must shrink, or `needs-user-action` (keep the
 * draft, suggest manual reduction or a compatible model) when even the
 * compacted prompt cannot fit. Approved images always ride along untouched.
 */
export function recompactForModelSwitch(input: RecompactInput): RecompactResult {
  const images = [...(input.approvedImageIds ?? [])];
  if (input.nextWindow === undefined) {
    return {
      action: "needs-user-action",
      reason: "Next model window is unknown; choose a verified route or reduce context.",
      recentTurns: [...input.turns],
      approvedImageIds: images,
    };
  }
  const measured = measurePrompt(input.turns, input.currentText);
  const estimated = Math.max(input.baseBudget.estimatedInput ?? 0, measured);
  const next = computeContextBudget({
    ...input.baseBudget,
    verifiedContextWindow: input.nextWindow,
    estimatedInput: estimated,
  });
  if (next.state === "unknown" || next.usableInput === undefined) {
    return {
      action: "needs-user-action",
      reason: "Next model budget is unknown; choose a verified route or reduce context.",
      recentTurns: [...input.turns],
      approvedImageIds: images,
    };
  }
  if (!next.shouldCompact) {
    return { action: "send-as-is", approvedImageIds: images };
  }
  const plan = planCompaction({
    turns: input.turns,
    currentText: input.currentText,
    keepRecentCount: input.keepRecentCount,
    budget: { ...input.baseBudget, verifiedContextWindow: input.nextWindow, estimatedInput: estimated },
  });
  if (!plan.shouldCompact || plan.olderTurns.length === 0) {
    return {
      action: "needs-user-action",
      reason: "Prompt exceeds the next model window even recent-only; reduce context or pick a larger route.",
      recentTurns: plan.recentTurns,
      approvedImageIds: images,
    };
  }
  const { summaryText, sourceTurnIds } = buildExtractiveSummary(plan.olderTurns);
  const checkpoint = advanceCheckpoint({
    previous: undefined,
    olderTurns: plan.olderTurns,
    coveredThroughTurnId: sourceTurnIds[sourceTurnIds.length - 1]!,
    summaryText,
    generatedBy: "local-extractive",
  });
  const compactedEstimate =
    measurePrompt(plan.recentTurns, input.currentText) + estimateTextTokens(summaryText);
  if (compactedEstimate <= next.usableInput) {
    return {
      action: "recompacted",
      checkpoint,
      recentTurns: plan.recentTurns,
      approvedImageIds: images,
      sentWithoutCompaction: false,
    };
  }
  return {
    action: "needs-user-action",
    reason: "Prompt exceeds the next model window even compacted; reduce context or pick a larger route.",
    recentTurns: plan.recentTurns,
    approvedImageIds: images,
  };
}

function nonEmptyText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}

export interface LongChatCompactionRequest {
  /** Older turns eligible for summarization (recent turns stay verbatim). */
  readonly olderTurns: readonly ChatTurn[];
  readonly generate: GenerateFn;
  readonly profile: ModelProfile;
  readonly density?: SummaryDensity;
  /** Current draft: carried verbatim alongside the summary, never summarized. */
  readonly draftText?: string;
  /** Latest user request: carried verbatim, never summarized away. */
  readonly latestRequestText?: string;
  /** App policy / current knowledge: redacted before the model sees them. */
  readonly forbiddenTexts?: readonly string[];
}

export type LongChatCompactionOutcome =
  | { readonly action: "skipped"; readonly reason: string }
  | {
      readonly action: "compacted";
      readonly summaryText: string;
      readonly generatedBy: "local-model" | "local-extractive";
      readonly sourceTurnIds: readonly string[];
      readonly preservedDraft?: string;
      readonly preservedLatestRequest?: string;
    }
  | { readonly action: "failed"; readonly reason: string };

/**
 * Invisible long-chat compaction through the summarize-local-context op.
 *
 * Bounds: notes longer than SUMMARY_NOTES_MAX_CHARS take the local
 * extractive path without calling the model; op output is coordinate- and
 * poison-scanned defense-in-depth (the op enforces its own max
 * input/output plus coordinate rejection first). The current draft and the
 * latest request ride along verbatim and are never summarized. Fail-closed:
 * when no safe summary exists the transcript is left intact (`failed`),
 * never a leaky or poisoned checkpoint.
 */
export async function compactLongChatLocal(
  request: LongChatCompactionRequest,
): Promise<LongChatCompactionOutcome> {
  if (request.olderTurns.length === 0) {
    return { action: "skipped", reason: "no-older-turns" };
  }
  const forbidden = request.forbiddenTexts ?? [];
  const sourceTurnIds = request.olderTurns.map((turn) => turn.id);
  const preservedDraft = nonEmptyText(request.draftText);
  const preservedLatestRequest = nonEmptyText(request.latestRequestText);
  const preserved = {
    ...(preservedDraft !== undefined ? { preservedDraft } : {}),
    ...(preservedLatestRequest !== undefined ? { preservedLatestRequest } : {}),
  };

  const extractiveFallback = (): LongChatCompactionOutcome => {
    const { summaryText } = buildExtractiveSummary(request.olderTurns, { forbiddenTexts: forbidden });
    if (isSummaryPoisoned(summaryText) || looksLikeCoordinates(summaryText)) {
      return { action: "failed", reason: "no-safe-summary" };
    }
    return {
      action: "compacted",
      summaryText,
      generatedBy: "local-extractive",
      sourceTurnIds,
      ...preserved,
    };
  };

  const scrub = (text: string): string => {
    let next = text;
    for (const secret of forbidden) {
      if (secret !== "" && next.includes(secret)) next = next.split(secret).join("[redacted app text]");
    }
    return next;
  };
  const notes = request.olderTurns.map((turn) => `[${turn.id} ${turn.role}] ${scrub(turn.text)}`).join("\n");
  if (notes.length > SUMMARY_NOTES_MAX_CHARS) return extractiveFallback();

  let summaryText: string;
  try {
    const result = await summarizeLocalContext(
      request.generate,
      { notes, density: request.density ?? "short" },
      request.profile,
    );
    if (!result.ok) return extractiveFallback();
    summaryText = result.value.summaryText;
  } catch {
    return extractiveFallback();
  }
  if (isSummaryPoisoned(summaryText) || looksLikeCoordinates(summaryText)) {
    return extractiveFallback();
  }
  return {
    action: "compacted",
    summaryText,
    generatedBy: "local-model",
    sourceTurnIds,
    ...preserved,
  };
}

export type SummarizerFn = (olderTurns: readonly ChatTurn[]) => Promise<string> | string;

export type ConsentSummaryInput = {
  selection: AiSelection;
  record?: ModelRecord;
  priceFingerprint?: string;
  olderTurns: readonly ChatTurn[];
  /** Provider that owns this chat's history. Summaries never cross providers silently. */
  chatProvider: ProviderId;
  summarizer?: SummarizerFn;
  allowCrossProvider?: boolean;
};

export type ConsentSummary = {
  summaryText: string;
  sourceTurnIds: string[];
  generatedBy: ChatCheckpoint["generatedBy"];
  estimatedTokens: number;
};

/**
 * Model-assisted summarization under the same paid-consent and privacy rules
 * as normal sends: `history-compaction`-scoped consent plus same-provider
 * routing, otherwise the local extractive path. A poisoned or empty provider
 * summary falls back to extractive — never into the checkpoint.
 */
export async function summarizeWithConsent(input: ConsentSummaryInput): Promise<ConsentSummary> {
  const sources = input.olderTurns.map((turn) => turn.id);
  const fallback = (): ConsentSummary => {
    const { summaryText } = buildExtractiveSummary(input.olderTurns);
    return {
      summaryText,
      sourceTurnIds: sources,
      generatedBy: "local-extractive",
      estimatedTokens: estimateTextTokens(summaryText),
    };
  };
  const authorized =
    input.record !== undefined &&
    input.priceFingerprint !== undefined &&
    isSelectionAuthorized(input.selection, input.record, input.priceFingerprint, "history-compaction");
  const sameProvider = input.selection.provider === input.chatProvider;
  if (input.summarizer === undefined || !authorized || (!sameProvider && input.allowCrossProvider !== true)) {
    return fallback();
  }
  const text = await input.summarizer(input.olderTurns);
  if (typeof text !== "string" || text.trim() === "" || isSummaryPoisoned(text)) {
    return fallback();
  }
  return {
    summaryText: text,
    sourceTurnIds: sources,
    generatedBy: "consented-provider",
    estimatedTokens: estimateTextTokens(text),
  };
}
