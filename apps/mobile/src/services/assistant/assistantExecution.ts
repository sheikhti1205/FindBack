/**
 * Execution layer for the guided assistant sheet.
 *
 * Pipeline for one free-form message:
 * message → `classifyIntent` → deterministic controller → narrow operation
 * (`answerHelp` / `extractSearchFilters` / `extractReportFields`) →
 * `GenerationGuard` → normalized result → controller state.
 *
 * Every model call runs through a guard-wrapped generator: raw output is
 * judged by `guardedGenerate` (loop/refusal/empty/multi-JSON, one repair
 * retry) before the op normalizes it. Guard failures land in the
 * controller's `recovering` state with the frozen recovery copy. The model
 * never determines actions: intents map to flows and narrow ops in code,
 * and every state change is a controller transition.
 *
 * No model installed (no `generate`): the sheet stays usable through
 * deterministic local routing. App questions fall back to the grounded
 * built-in Help path (server built-in answer, local capability answers when
 * the server is unreachable). Report flows collect into a review-ready
 * snapshot only — the "Review report" action stays held and nothing here
 * populates or modifies the report form.
 */
import { CATEGORIES, type Category } from "@findback/shared";
import { resolveAssistantCategory, resolveReportTurn } from "./reportTurnResolver";
import { answerHelp } from "../ai/ops/answerHelp";
import { classifyIntent } from "../ai/ops/classifyIntent";
import { extractReportFields } from "../ai/ops/extractReportFields";
import { extractSearchFilters } from "../ai/ops/extractSearchFilters";
import { APP_CAPABILITIES } from "../appCapabilities";
import { DEFAULT_CLARIFICATION_QUESTIONS } from "../ai/clarificationCopy";
import { guardedGenerate, type GuardProvider } from "../ai/generationGuard";
import { GuardError } from "../ai/errors";
import { profileFor, type ModelProfile } from "../ai/modelProfiles";
import type {
  AiError,
  GenerateFn,
  Intent,
  ReportSlotFields,
  SearchFilterFields,
} from "../ai/types";
import { askAiHelp } from "../auth";
import {
  applyReportFields,
  applySearchFields,
  chooseLocation,
  failWith,
  nextMissingQuestion,
  snapshotForIntent,
  startFlow,
  type GuidedSnapshot,
} from "./guidedAssistantController";

export interface AssistantHelpAnswer {
  readonly text: string;
  readonly source: "llm" | "fallback";
}

export interface AssistantExecutionRuntime {
  /** Model text generator. Absent means no model is installed: grounded local routing applies. */
  readonly generate?: GenerateFn;
  /** Model profile for narrow ops. Required only when `generate` is present. */
  readonly profile?: ModelProfile;
  /**
   * Honest display label for the resident model behind `generate`
   * (e.g. "Qwen3 0.6B", "LFM2.5 1.2B"). Set by the injector that knows
   * the active entry (`resolveLocalTextRuntime` always sets it); the
   * sheet labels the session from this instead of assuming Qwen.
   */
  readonly modelLabel?: string;
  /** Guard-owned generation deadline, forwarded to `guardedGenerate`. Omitted means no guard timeout. */
  readonly deadlineMs?: number;
  /** Grounded app-question answerer. Defaults to the server Help path with a local capability fallback. */
  readonly answerAppQuestion?: (question: string) => Promise<AssistantHelpAnswer>;
}

export interface AssistantExecutionResult {
  readonly snapshot: GuidedSnapshot;
  /** Assistant message to display for this turn. */
  readonly reply: string;
  /** "model" when the reply text came from a model op, "grounded" for code-owned replies. */
  readonly replySource: "model" | "grounded";
  /** True when a report flow collected to ready: held for review, never applied to the report form. */
  readonly reviewHeld: boolean;
}

const INPUT_MAX = 500;

const CLARIFICATION_REPLY =
  "I couldn't tell whether you want to report an item, search listings, or ask about the app. " +
  "Pick one of the shortcuts above, or rephrase with a little more detail.";

const SEARCH_HELD_NOTE = "Collected search filters. They stay here until you run the search from the Search tab.";

const REVIEW_HELD_NOTE =
  "Review report stays held here for now — the report form is never filled in automatically.";

/**
 * Fallback profile chain for runtimes that provide `generate` without an
 * explicit profile (legacy injectors and tests). Every id must resolve via
 * `profileFor`: a prior revision referenced the non-existent
 * `"qwen3-0.6b-text"` (the Qwen profile id carries its quantization
 * suffix), which silently resolved to `undefined`. Unknown ids are
 * skipped; an empty chain fails closed to grounded routing.
 */
export const DEFAULT_ASSISTANT_PROFILE_IDS: readonly string[] = [
  "smolvlm2-500m-text",
  "qwen3-0.6b-dynamic-int4",
];

function defaultAssistantProfile(): ModelProfile | undefined {
  for (const id of DEFAULT_ASSISTANT_PROFILE_IDS) {
    const profile = profileFor(id);
    if (profile !== undefined) return profile;
  }
  return undefined;
}

/**
 * Guard seam for narrow ops: raw model text passes `guardedGenerate`
 * (loop/refusal/empty/multi-JSON verdicts, at most one repair retry) before
 * the op's own normalization sees it. Guard failures throw `GuardError`.
 */
function throughGuard(generate: GenerateFn, profile: ModelProfile, deadlineMs?: number): GenerateFn {
  return async (prompt, options) => {
    const provider: GuardProvider = {
      generateText: async (request) => ({
        text: await generate(request.prompt, {
          maxOutputTokens: request.maxOutputTokens ?? options.maxOutputTokens,
          temperature: request.temperature ?? options.temperature,
        }),
        modelId: profile.id,
      }),
      analyzePhoto: async () => {
        throw new GuardError({
          errorClass: "UNSUPPORTED_REQUEST",
          diagnosticCode: "EXECUTION_TEXT_ONLY",
          modelId: profile.id,
        });
      },
    };
    const guarded = await guardedGenerate({
      provider,
      kind: "text",
      prompt,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      deadlineMs,
      expectStructured: false,
    });
    return guarded.text;
  };
}

function guardErrorToAiError(error: unknown): AiError {
  if (error instanceof GuardError) {
    return { errorClass: error.errorClass, diagnostic: error.diagnosticCode };
  }
  return { errorClass: "RUNTIME_ERROR", diagnostic: "EXECUTION_UNEXPECTED_THROW" };
}

function guessCategory(text: string): Category | undefined {
  return resolveAssistantCategory(text);
}

function guessDateText(text: string): string | undefined {
  const match = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match?.[1];
}

function guessLocationNote(text: string, dateText: string | undefined): string | undefined {
  const withoutDate = dateText !== undefined ? text.replace(dateText, " ") : text;
  const match = withoutDate.match(
    /\b(?:at|in|near|nearby|around|from|outside|inside|by|on)\s+([A-Za-z][A-Za-z0-9 .,'-]{2,80})/i,
  );
  const captured = match?.[1]
    ?.trim()
    .replace(/[.,;]+$/, "")
    .replace(/\s+(?:at|on)$/i, "");
  if (captured === undefined || captured === "") return undefined;
  return captured;
}

function normalizeReportCategory(category: string | undefined): Category | undefined {
  if (category === undefined) return undefined;
  if ((CATEGORIES as readonly string[]).includes(category)) return category as Category;
  return resolveAssistantCategory(category);
}

const APP_NOUNS = [
  "app",
  "findback",
  "report",
  "search",
  "filter",
  "sort",
  "categor",
  "status",
  "verif",
  "account",
  "profile",
  "post",
  "publish",
  "rating",
  "comment",
  "photo",
  "location",
  "offline",
  "model",
  "notification",
  "message",
  "tab",
  "email",
  "phone",
  "login",
  "register",
  "password",
  "help",
  "button",
  "screen",
  "feed",
  "home",
];

/**
 * Deterministic local intent routing for the no-model path (code-owned,
 * never model-chosen). Question-shaped input goes to the Help path, lost /
 * found wording to report flows, search verbs to search; anything else
 * statement-like defaults to search, degenerate input to UNKNOWN.
 */
export function guessIntentLocal(text: string): Intent {
  const trimmed = text.trim();
  if (trimmed.length <= 2 || !/[a-z0-9]/i.test(trimmed)) return "UNKNOWN";
  const lower = trimmed.toLowerCase();
  if (/^(hi|hello|hey|yo|salam)\b/.test(lower) && lower.length < 32) return "OPEN_QUESTION";
  if (
    /\bhow (do|can|should) (i|you|we)\b/.test(lower) ||
    /\bhow to\b/.test(lower) ||
    /\bwhat can\b/.test(lower) ||
    /\bhelp (me|with)\b/.test(lower)
  ) {
    return "APP_QUESTION";
  }
  const questionShaped =
    /^(how|what|where|why|when|which|can|could|does|do|is|are|should|help)\b/.test(lower) ||
    /\bhow (do|can|should|to)\b/.test(lower) ||
    trimmed.endsWith("?");
  if (questionShaped && !/\b(lost|lose|losing|found|find|search|looking)\b/.test(lower)) {
    return APP_NOUNS.some((noun) => lower.includes(noun)) ? "APP_QUESTION" : "OPEN_QUESTION";
  }
  if (/\b(lost|lose|losing|missing|misplaced)\b/.test(lower)) return "REPORT_LOST";
  if (/\b(found|picked up|discovered)\b/.test(lower)) return "REPORT_FOUND";
  if (/\b(search|find|look for|looking for|show me|browse)\b/.test(lower)) return "SEARCH";
  if (trimmed.endsWith("?")) return "OPEN_QUESTION";
  return "SEARCH";
}

/** Local report slots for the no-model path. Location comes only from explicit prepositions. */
function localReportGuess(text: string): ReportSlotFields {
  const fields: Record<string, string> = {};
  const category = guessCategory(text);
  if (category !== undefined) fields.category = category;
  const dateText = guessDateText(text);
  if (dateText !== undefined) fields.dateText = dateText;
  const locationNote = guessLocationNote(text, dateText);
  if (locationNote !== undefined) fields.locationNote = locationNote;
  return { title: text, ...fields };
}

/** Local search slots for the no-model path. Status and date range are never invented. */
function localSearchGuess(text: string): SearchFilterFields {
  const category = guessCategory(text);
  return category === undefined ? { query: text } : { query: text, category };
}

function topicLines(question: string): string[] {
  const lower = question.toLowerCase();
  if (/\b(report|publish|lost|found|recover|matched|closed|status)\b/.test(lower)) {
    return [...APP_CAPABILITIES.reportFlow, `Statuses: ${APP_CAPABILITIES.statuses.join(", ")}.`];
  }
  if (/\b(search|filter|feed|sort|scroll|refresh|home)\b/.test(lower)) return APP_CAPABILITIES.searchFilter;
  if (/\b(photo|picture|image|camera|upload)\b/.test(lower)) {
    return [...APP_CAPABILITIES.localVlm.slice(1), APP_CAPABILITIES.privacy[0] as string];
  }
  if (/\b(location|map|gps|address|pin|coordinate)\b/.test(lower)) return APP_CAPABILITIES.location;
  if (/\b(email|verif|otp|code)\b/.test(lower)) return [APP_CAPABILITIES.emailVerification];
  if (/\b(phone|sms)\b/.test(lower)) return [APP_CAPABILITIES.phoneVerification];
  if (/\b(like|dislike|rating|star|comment|reaction)\b/.test(lower)) return APP_CAPABILITIES.social;
  if (/\b(match|similar)\b/.test(lower)) return APP_CAPABILITIES.possibleMatches;
  if (/\b(model|offline|download|gpu|cpu|ai)\b/.test(lower)) {
    return [...APP_CAPABILITIES.localVlm, ...APP_CAPABILITIES.modelModes, ...APP_CAPABILITIES.modelDownload];
  }
  if (/\b(youtube|video)\b/.test(lower)) return [APP_CAPABILITIES.youtube];
  if (/\b(markdown|format|bold|italic)\b/.test(lower)) return APP_CAPABILITIES.markdown;
  if (/\b(privacy|private|data|track)\b/.test(lower)) return APP_CAPABILITIES.privacy;
  if (/\b(tab|navigate|profile|about)\b/.test(lower)) {
    return [`The tabs are ${APP_CAPABILITIES.tabs.join(", ")}.`];
  }
  if (/\b(version|update)\b/.test(lower)) return [`This build is version ${APP_CAPABILITIES.version}.`];
  const unavailable = APP_CAPABILITIES.unavailable.find((item) =>
    lower.includes(item.split(" ")[0] as string),
  );
  if (unavailable !== undefined) {
    return [`${unavailable[0]?.toUpperCase()}${unavailable.slice(1)} is not available in this build.`];
  }
  return [];
}

/** Grounded local answer built only from the versioned capability list. */
export function groundedHelpAnswer(question: string): string {
  const lines = topicLines(question);
  if (lines.length > 0) return lines.join(" ");
  return (
    "FindBack helps you report lost or found items, search listings, and follow up with ratings and comments. " +
    `The tabs are ${APP_CAPABILITIES.tabs.join(", ")}. ` +
    "Open the Report tab and choose Lost or Found to publish, or use the Search tab to filter by category and status."
  );
}

function groundedNonAppAnswer(): string {
  return (
    "I can only help with questions about using FindBack. " +
    "Pick Report a lost item, Report a found item, or Search listings above to get started, " +
    "or ask how reporting, searching, or verification works."
  );
}

async function defaultAnswerAppQuestion(question: string): Promise<AssistantHelpAnswer> {
  try {
    const res = await askAiHelp(question);
    return { text: res.text, source: res.source };
  } catch {
    return { text: groundedHelpAnswer(question), source: "fallback" };
  }
}

function replyForState(snapshot: GuidedSnapshot): string {
  if (snapshot.state === "recovering") {
    return snapshot.recovery?.message ?? "Something went wrong. You can retry or continue manually.";
  }
  if (snapshot.state === "ready") {
    if (snapshot.flow === "search") {
      const query = snapshot.searchFilters?.query ?? "";
      return query === "" ? SEARCH_HELD_NOTE : `Ready to search for "${query}". ${SEARCH_HELD_NOTE}`;
    }
    const kind = snapshot.flow === "found" ? "found" : "lost";
    return `Collected everything for a ${kind} report. ${REVIEW_HELD_NOTE}`;
  }
  if (snapshot.state === "awaitingPhoto") return DEFAULT_CLARIFICATION_QUESTIONS.photo;
  if (snapshot.state === "awaitingLocation") return DEFAULT_CLARIFICATION_QUESTIONS.location;
  return nextMissingQuestion(snapshot)?.question ?? DEFAULT_CLARIFICATION_QUESTIONS.other;
}

function recoverSnapshot(base: GuidedSnapshot, error: AiError): AssistantExecutionResult {
  const snapshot = failWith(base, error);
  return {
    snapshot,
    reply: snapshot.recovery?.message ?? "Something went wrong. You can retry or continue manually.",
    replySource: "grounded",
    reviewHeld: false,
  };
}

async function helpTurn(
  base: GuidedSnapshot,
  message: string,
  runtime: AssistantExecutionRuntime,
  guarded: GenerateFn | undefined,
  profile: ModelProfile | undefined,
  appQuestion: boolean,
): Promise<AssistantExecutionResult> {
  if (guarded !== undefined && profile !== undefined) {
    try {
      const answer = await answerHelp(guarded, message, profile);
      if (!answer.ok) return recoverSnapshot(base, answer.error);
      return { snapshot: base, reply: answer.value.answerText, replySource: "model", reviewHeld: false };
    } catch (error) {
      return recoverSnapshot(base, guardErrorToAiError(error));
    }
  }
  if (!appQuestion) {
    return { snapshot: base, reply: groundedNonAppAnswer(), replySource: "grounded", reviewHeld: false };
  }
  const answerAppQuestion = runtime.answerAppQuestion ?? defaultAnswerAppQuestion;
  try {
    const answer = await answerAppQuestion(message);
    return {
      snapshot: base,
      reply: answer.text,
      replySource: answer.source === "llm" ? "model" : "grounded",
      reviewHeld: false,
    };
  } catch {
    return {
      snapshot: base,
      reply: groundedHelpAnswer(message),
      replySource: "grounded",
      reviewHeld: false,
    };
  }
}

async function searchTurn(
  base: GuidedSnapshot,
  message: string,
  guarded: GenerateFn | undefined,
  profile: ModelProfile | undefined,
): Promise<AssistantExecutionResult> {
  const start = base.flow === "search" && base.state !== "ready" ? base : startFlow("search");
  if (guarded !== undefined && profile !== undefined) {
    try {
      const extracted = await extractSearchFilters(guarded, message, profile);
      if (!extracted.ok) return recoverSnapshot(start, extracted.error);
      const snapshot = applySearchFields(start, extracted.value.fields);
      return { snapshot, reply: replyForState(snapshot), replySource: "model", reviewHeld: false };
    } catch (error) {
      return recoverSnapshot(start, guardErrorToAiError(error));
    }
  }
  const snapshot = applySearchFields(start, localSearchGuess(message));
  return { snapshot, reply: replyForState(snapshot), replySource: "grounded", reviewHeld: false };
}

async function reportTurn(
  intent: Intent,
  message: string,
  guarded: GenerateFn | undefined,
  profile: ModelProfile | undefined,
): Promise<AssistantExecutionResult> {
  const start = snapshotForIntent(intent);
  if (guarded !== undefined && profile !== undefined) {
    try {
      const extracted = await extractReportFields(guarded, message, profile);
      if (!extracted.ok) return recoverSnapshot(start, extracted.error);
      const normalized =
        extracted.value.fields.category === undefined
          ? extracted.value.fields
          : {
              ...extracted.value.fields,
              ...(normalizeReportCategory(extracted.value.fields.category) !== undefined
                ? { category: normalizeReportCategory(extracted.value.fields.category) as string }
                : null),
            };
      const snapshot = applyReportFields(start, normalized);
      const held = snapshot.state === "ready";
      return { snapshot, reply: replyForState(snapshot), replySource: "model", reviewHeld: held };
    } catch (error) {
      return recoverSnapshot(start, guardErrorToAiError(error));
    }
  }
  const snapshot = applyReportFields(start, localReportGuess(message));
  return {
    snapshot,
    reply: replyForState(snapshot),
    replySource: "grounded",
    reviewHeld: snapshot.state === "ready",
  };
}

function resumeQuestion(snapshot: GuidedSnapshot): string {
  return nextMissingQuestion(snapshot)?.question ?? DEFAULT_CLARIFICATION_QUESTIONS.other;
}

function categoryMismatchReply(unmatched: string): string {
  return (
    `I couldn't match "${unmatched}" to a category. ` +
    `Choose one: ${CATEGORIES.join(", ")}.`
  );
}

function greetingReply(snapshot: GuidedSnapshot): string {
  return `Hello! ${resumeQuestion(snapshot)}`;
}

async function answerSideQuestion(
  snapshot: GuidedSnapshot,
  message: string,
  runtime: AssistantExecutionRuntime,
  guarded: GenerateFn | undefined,
  profile: ModelProfile | undefined,
): Promise<AssistantExecutionResult> {
  const resume = resumeQuestion(snapshot);
  if (guarded !== undefined && profile !== undefined) {
    try {
      const answer = await answerHelp(guarded, message, profile);
      if (!answer.ok) return recoverSnapshot(snapshot, answer.error);
      return {
        snapshot,
        reply: `${answer.value.answerText} ${resume}`,
        replySource: "model",
        reviewHeld: false,
      };
    } catch (error) {
      return recoverSnapshot(snapshot, guardErrorToAiError(error));
    }
  }
  const answerAppQuestion = runtime.answerAppQuestion ?? defaultAnswerAppQuestion;
  try {
    const answer = await answerAppQuestion(message);
    return {
      snapshot,
      reply: `${answer.text} ${resume}`,
      replySource: answer.source === "llm" ? "model" : "grounded",
      reviewHeld: false,
    };
  } catch {
    return {
      snapshot,
      reply: `${groundedHelpAnswer(message)} ${resume}`,
      replySource: "grounded",
      reviewHeld: false,
    };
  }
}

async function continueCollection(
  snapshot: GuidedSnapshot,
  message: string,
  runtime: AssistantExecutionRuntime,
  guarded: GenerateFn | undefined,
  profile: ModelProfile | undefined,
): Promise<AssistantExecutionResult> {
  if (snapshot.flow === "search") {
    return searchTurn(snapshot, message, guarded, profile);
  }
  const turn = resolveReportTurn(snapshot, message);
  if (turn.kind === "GREETING") {
    return {
      snapshot,
      reply: greetingReply(snapshot),
      replySource: "grounded",
      reviewHeld: false,
    };
  }
  if (turn.kind === "SIDE_QUESTION") {
    return answerSideQuestion(snapshot, message, runtime, guarded, profile);
  }
  if (turn.kind === "INTENT_SWITCH") {
    if (turn.intent === "SEARCH") return searchTurn(startFlow("search"), message, guarded, profile);
    if (turn.intent === "REPORT_LOST" || turn.intent === "REPORT_FOUND") {
      return reportTurn(turn.intent, message, guarded, profile);
    }
    return helpTurn(snapshot, message, runtime, guarded, profile, true);
  }
  if (turn.kind === "UNRECOGNIZED") {
    if (snapshot.state === "awaitingLocation") {
      const next = chooseLocation(snapshot, "typed", message);
      return {
        snapshot: next,
        reply: replyForState(next),
        replySource: "grounded",
        reviewHeld: next.state === "ready",
      };
    }
    if (turn.unmatchedCategory !== undefined) {
      return {
        snapshot,
        reply: `${categoryMismatchReply(turn.unmatchedCategory)} ${resumeQuestion(snapshot)}`,
        replySource: "grounded",
        reviewHeld: false,
      };
    }
    return {
      snapshot,
      reply: `I didn't catch that. ${resumeQuestion(snapshot)}`,
      replySource: "grounded",
      reviewHeld: false,
    };
  }
  if (snapshot.state === "awaitingLocation") {
    const next = chooseLocation(snapshot, "typed", message);
    return { snapshot: next, reply: replyForState(next), replySource: "grounded", reviewHeld: next.state === "ready" };
  }
  if (snapshot.state === "awaitingPhoto") {
    if (guarded !== undefined && profile !== undefined) {
      try {
        const extracted = await extractReportFields(guarded, message, profile);
        if (!extracted.ok) return recoverSnapshot(snapshot, extracted.error);
        const normalized =
          extracted.value.fields.category === undefined
            ? extracted.value.fields
            : {
                ...extracted.value.fields,
                ...(normalizeReportCategory(extracted.value.fields.category) !== undefined
                  ? { category: normalizeReportCategory(extracted.value.fields.category) as string }
                  : null),
              };
        const next = applyReportFields(snapshot, normalized);
        return { snapshot: next, reply: replyForState(next), replySource: "model", reviewHeld: next.state === "ready" };
      } catch (error) {
        return recoverSnapshot(snapshot, guardErrorToAiError(error));
      }
    }
    if (turn.fields !== undefined) {
      const next = applyReportFields(snapshot, turn.fields);
      return { snapshot: next, reply: replyForState(next), replySource: "grounded", reviewHeld: next.state === "ready" };
    }
    return { snapshot, reply: replyForState(snapshot), replySource: "grounded", reviewHeld: false };
  }
  if (guarded !== undefined && profile !== undefined) {
    try {
      const extracted = await extractReportFields(guarded, message, profile);
      if (!extracted.ok) return recoverSnapshot(snapshot, extracted.error);
      const normalized =
        extracted.value.fields.category === undefined
          ? extracted.value.fields
          : {
              ...extracted.value.fields,
              ...(normalizeReportCategory(extracted.value.fields.category) !== undefined
                ? { category: normalizeReportCategory(extracted.value.fields.category) as string }
                : null),
            };
      const next = applyReportFields(snapshot, normalized);
      return { snapshot: next, reply: replyForState(next), replySource: "model", reviewHeld: next.state === "ready" };
    } catch (error) {
      return recoverSnapshot(snapshot, guardErrorToAiError(error));
    }
  }
  if (turn.fields !== undefined) {
    const next = applyReportFields(snapshot, turn.fields);
    return { snapshot: next, reply: replyForState(next), replySource: "grounded", reviewHeld: next.state === "ready" };
  }
  const missing = snapshot.missingFields;
  let fields: ReportSlotFields = { description: message };
  if (missing.includes("category")) fields = { category: message };
  else if (missing.includes("date")) fields = { dateText: message };
  else if (missing.includes("location")) fields = { locationNote: message };
  const next = applyReportFields(snapshot, fields);
  return { snapshot: next, reply: replyForState(next), replySource: "grounded", reviewHeld: next.state === "ready" };
}

/**
 * Run one free-form assistant turn. Mid-collection report/search snapshots
 * keep collecting (typed location answers stay explicit); ask flows, fresh
 * input, and ready pivots are classified first and routed by intent.
 */
export async function executeAssistantMessage(
  snapshot: GuidedSnapshot | null,
  text: string,
  runtime: AssistantExecutionRuntime,
): Promise<AssistantExecutionResult> {
  const message = text.trim().slice(0, INPUT_MAX);
  if (snapshot !== null && snapshot.state === "recovering") {
    return {
      snapshot,
      reply: snapshot.recovery?.message ?? "Something went wrong. You can retry or continue manually.",
      replySource: "grounded",
      reviewHeld: false,
    };
  }
  if (message === "") {
    const base = snapshot ?? startFlow("ask");
    return {
      snapshot: base,
      reply: nextMissingQuestion(base)?.question ?? DEFAULT_CLARIFICATION_QUESTIONS.other,
      replySource: "grounded",
      reviewHeld: false,
    };
  }
  const generate = runtime.generate;
  const profile = runtime.profile ?? (generate === undefined ? undefined : defaultAssistantProfile());
  const guarded =
    generate !== undefined && profile !== undefined
      ? throughGuard(generate, profile, runtime.deadlineMs)
      : undefined;

  if (snapshot !== null && snapshot.state !== "ready" && snapshot.flow !== "ask") {
    return continueCollection(snapshot, message, runtime, guarded, profile);
  }
  const base = snapshot;

  let intent: Intent;
  if (guarded !== undefined && profile !== undefined) {
    let classified;
    try {
      classified = await classifyIntent(guarded, message, profile);
    } catch (error) {
      return recoverSnapshot(base ?? startFlow("ask"), guardErrorToAiError(error));
    }
    if (!classified.ok) return recoverSnapshot(base ?? startFlow("ask"), classified.error);
    intent = classified.value.intent;
  } else {
    intent = guessIntentLocal(message);
  }

  switch (intent) {
    case "APP_QUESTION":
      return helpTurn(base ?? startFlow("ask"), message, runtime, guarded, profile, true);
    case "OPEN_QUESTION":
      return helpTurn(base ?? startFlow("ask"), message, runtime, guarded, profile, false);
    case "SEARCH":
      return searchTurn(base ?? startFlow("search"), message, guarded, profile);
    case "REPORT_LOST":
    case "REPORT_FOUND":
      return reportTurn(intent, message, guarded, profile);
    case "UNKNOWN":
      break;
  }
  const held = base ?? startFlow("ask");
  return { snapshot: held, reply: CLARIFICATION_REPLY, replySource: "grounded", reviewHeld: false };
}
