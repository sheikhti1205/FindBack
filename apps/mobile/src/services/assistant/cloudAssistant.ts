import { CATEGORIES, POST_STATUSES, POST_TYPES } from "@findback/shared";
import { createOpenRouterClient } from "../openRouter";
import { getConnectedOpenRouterKey } from "../aiCredentials";
import { builtInHelp } from "../helpFaq";
import { askAiHelp } from "../auth";
import { DEFAULT_CLARIFICATION_QUESTIONS } from "../ai/clarificationCopy";
import {
  MAX_CHAT_INPUT_CHARS,
  PromptBudgetError,
  buildGroundedPrompt,
  groundAppAnswer,
  isInstructionOverride,
} from "../ai/appKnowledge";
import type { ReportSlotFields, SearchFilterFields } from "../ai/types";
import { resolveAssistantCategory, resolveReportTurn } from "./reportTurnResolver";
import {
  applyReportFields,
  applySearchFields,
  chooseLocation,
  nextMissingQuestion,
  snapshotForIntent,
  startFlow,
  type GuidedSnapshot,
} from "./guidedAssistantController";

/**
 * Policy and knowledge first, the message quoted as untrusted data. Knowledge
 * is dropped whole only when the transport budget cannot hold it — nothing is
 * ever cut, and every prompt stays inside `MAX_PROMPT_CHARS`.
 */
function groundedPrompt(input: string): string {
  try {
    return buildGroundedPrompt(input);
  } catch (error) {
    if (error instanceof PromptBudgetError) {
      return buildGroundedPrompt(input, { includeKnowledge: false });
    }
    throw error;
  }
}

/** A greeting that still carries a task ("Hi, I lost my keys") is a task. */
const GREETING_TASK_HINT =
  /\b(?:lost|found|report(?:s|ed|ing)?|search(?:es|ed|ing)?|look\s+(?:for|up)|filter(?:s|ed|ing)?|find(?:s|ing)?|publish(?:es|ed|ing)?)\b/i;

const GREETING_ASK_REPLY =
  "Hello! Ask me about FindBack reports, search, status, comments or photos.";

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/** Unknown fields have no effect; model output is data, never actions or queries. */
export function validatedSearchFields(raw: unknown, userInput: string): SearchFilterFields {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const query = text(value.query, 120) ?? text(userInput, 120);
  const category = text(value.category, 80);
  const status = text(value.status, 40);
  const allowedStatus = [...POST_STATUSES, ...POST_TYPES].find((entry) => entry.toLowerCase() === status?.toLowerCase());
  const allowedCategory = CATEGORIES.find((entry) => entry.toLowerCase() === category?.toLowerCase());
  return {
    ...(query ? { query } : {}),
    ...(allowedCategory ? { category: allowedCategory } : {}),
    ...(allowedStatus ? { status: allowedStatus } : {}),
  };
}

function validatedReportFields(raw: unknown): ReportSlotFields {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const title = text(value.title, 120);
  const description = text(value.description, 3000);
  const category = text(value.category, 80);
  const dateText = text(value.dateText, 10);
  const allowedCategory = CATEGORIES.find((entry) => entry.toLowerCase() === category?.toLowerCase());
  const candidateDate = dateText && /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T00:00:00Z`) : null;
  const validDate = dateText && /^\d{4}-\d{2}-\d{2}$/.test(dateText)
    && candidateDate !== null && Number.isFinite(candidateDate.getTime())
    && candidateDate.toISOString().slice(0, 10) === dateText
    && dateText <= new Date().toISOString().slice(0, 10);
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(allowedCategory ? { category: allowedCategory } : {}),
    ...(validDate ? { dateText } : {}),
    // Location is collected by the user in the guided flow, never fabricated.
  };
}

/** Deterministic no-key report guess: titled, with alias/date extraction. Never invents. */
function localReportGuess(message: string): ReportSlotFields {
  const fields: Record<string, string> = { title: message };
  const category = resolveAssistantCategory(message);
  if (category !== undefined) fields.category = category;
  const dateMatch = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dateMatch?.[1] !== undefined) {
    const check = validatedReportFields({ dateText: dateMatch[1] });
    if (check.dateText !== undefined) fields.dateText = check.dateText;
  }
  return fields;
}

const SEARCH_HELD_NOTE = "Collected search filters. They stay here until you run the search from the Search tab.";
const REVIEW_HELD_NOTE =
  "Review report stays held here for now — the report form is never filled in automatically.";

function replyForState(snapshot: GuidedSnapshot): string {
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

function resumeQuestion(snapshot: GuidedSnapshot): string {
  return nextMissingQuestion(snapshot)?.question ?? DEFAULT_CLARIFICATION_QUESTIONS.other;
}

function categoryMismatchReply(unmatched: string): string {
  return `I couldn't match "${unmatched}" to a category. Choose one: ${CATEGORIES.join(", ")}.`;
}

const generateCloud = (prompt: string) => createOpenRouterClient(getConnectedOpenRouterKey).text(prompt);

export type CloudGenerate = (prompt: string) => Promise<string>;

export interface CloudAssistantResult {
  snapshot: GuidedSnapshot;
  reply: string;
  replySource: "model" | "grounded";
  reviewHeld: boolean;
}

async function modelReportFields(generate: CloudGenerate, flow: string, input: string): Promise<{
  ok: boolean;
  fields: ReportSlotFields;
}> {
  try {
    const answer = await generate(
      `Extract a JSON object with only title, description, category, dateText (YYYY-MM-DD) from this ${flow} item report. Do not invent location and do not publish.\n\n${groundedPrompt(input)}`,
    );
    const raw = JSON.parse(answer) as Record<string, unknown>;
    if (typeof raw.category === "string") {
      // Model category spellings go through the same alias map the
      // deterministic path uses; unresolvable values are dropped by validation.
      const canonical = resolveAssistantCategory(raw.category);
      if (canonical !== undefined) raw.category = canonical;
    }
    return { ok: true, fields: validatedReportFields(raw) };
  } catch {
    return { ok: false, fields: {} };
  }
}

async function modelSearchFields(generate: CloudGenerate, input: string): Promise<{
  ok: boolean;
  fields: SearchFilterFields;
}> {
  try {
    const answer = await generate(
      `Extract a JSON object with only query, category, status from this FindBack search intent. Do not invent listings and do not execute a query.\n\n${groundedPrompt(input)}`,
    );
    return { ok: true, fields: validatedSearchFields(JSON.parse(answer), input) };
  } catch {
    return { ok: false, fields: {} };
  }
}

async function reportTurnFromStart(
  flow: "lost" | "found",
  input: string,
  generate: CloudGenerate,
): Promise<CloudAssistantResult> {
  const start = snapshotForIntent(flow === "lost" ? "REPORT_LOST" : "REPORT_FOUND");
  const model = await modelReportFields(generate, flow, input);
  const snapshot = applyReportFields(start, model.ok ? model.fields : localReportGuess(input));
  return {
    snapshot,
    reply: replyForState(snapshot),
    replySource: model.ok ? "model" : "grounded",
    reviewHeld: snapshot.state === "ready",
  };
}

async function searchTurnFrom(
  base: GuidedSnapshot,
  input: string,
  generate: CloudGenerate,
): Promise<CloudAssistantResult> {
  const start = base.flow === "search" && base.state !== "ready" ? base : startFlow("search");
  const model = await modelSearchFields(generate, input);
  const fields = model.ok
    ? model.fields
    : validatedSearchFields({ category: resolveAssistantCategory(input) }, input);
  const snapshot = applySearchFields(start, fields);
  return { snapshot, reply: replyForState(snapshot), replySource: model.ok ? "model" : "grounded", reviewHeld: false };
}

async function askTurn(base: GuidedSnapshot, input: string, generate: CloudGenerate): Promise<CloudAssistantResult> {
  try {
    const answer = await generate(
      `Answer this FindBack question briefly. If you do not know, say so. Do not claim to query the database.\n\n${groundedPrompt(input)}`,
    );
    const grounded = groundAppAnswer(answer);
    if (!grounded.safe) {
      return { snapshot: base, reply: grounded.reply, replySource: "grounded", reviewHeld: false };
    }
    return { snapshot: base, reply: grounded.text, replySource: "model", reviewHeld: false };
  } catch {
    return { snapshot: base, reply: builtInHelp(input), replySource: "grounded", reviewHeld: false };
  }
}

async function answerSideQuestion(
  snapshot: GuidedSnapshot,
  input: string,
): Promise<CloudAssistantResult> {
  const resume = resumeQuestion(snapshot);
  try {
    const answer = await askAiHelp(input);
    return {
      snapshot,
      reply: `${answer.text} ${resume}`,
      replySource: answer.source === "llm" ? "model" : "grounded",
      reviewHeld: false,
    };
  } catch {
    return {
      snapshot,
      reply: `${builtInHelp(input)} ${resume}`,
      replySource: "grounded",
      reviewHeld: false,
    };
  }
}

async function continueReportCollection(
  snapshot: GuidedSnapshot,
  input: string,
  generate: CloudGenerate,
): Promise<CloudAssistantResult> {
  if (snapshot.flow === "search") {
    return searchTurnFrom(snapshot, input, generate);
  }
  const turn = resolveReportTurn(snapshot, input);
  if (turn.kind === "GREETING") {
    return { snapshot, reply: `Hello! ${resumeQuestion(snapshot)}`, replySource: "grounded", reviewHeld: false };
  }
  if (turn.kind === "SIDE_QUESTION") {
    return answerSideQuestion(snapshot, input);
  }
  if (turn.kind === "INTENT_SWITCH") {
    if (turn.intent === "SEARCH") return searchTurnFrom(startFlow("search"), input, generate);
    if (turn.intent === "REPORT_LOST" || turn.intent === "REPORT_FOUND") {
      return reportTurnFromStart(turn.intent === "REPORT_LOST" ? "lost" : "found", input, generate);
    }
    return askTurn(snapshot, input, generate);
  }
  if (turn.kind === "UNRECOGNIZED") {
    if (snapshot.state === "awaitingLocation") {
      const next = chooseLocation(snapshot, "typed", input);
      return { snapshot: next, reply: replyForState(next), replySource: "grounded", reviewHeld: next.state === "ready" };
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
    const next = chooseLocation(snapshot, "typed", input);
    return { snapshot: next, reply: replyForState(next), replySource: "grounded", reviewHeld: next.state === "ready" };
  }
  if (snapshot.state === "awaitingPhoto") {
    const model = await modelReportFields(generate, snapshot.flow, input);
    if (model.ok) {
      const next = applyReportFields(snapshot, model.fields);
      return {
        snapshot: next,
        reply: replyForState(next),
        replySource: "model",
        reviewHeld: next.state === "ready",
      };
    }
    if (turn.fields === undefined) {
      return { snapshot, reply: replyForState(snapshot), replySource: "grounded", reviewHeld: false };
    }
    const next = applyReportFields(snapshot, turn.fields);
    return {
      snapshot: next,
      reply: replyForState(next),
      replySource: "grounded",
      reviewHeld: next.state === "ready",
    };
  }
  const model = await modelReportFields(generate, snapshot.flow, input);
  if (model.ok) {
    const next = applyReportFields(snapshot, model.fields);
    return {
      snapshot: next,
      reply: replyForState(next),
      replySource: "model",
      reviewHeld: next.state === "ready",
    };
  }
  const missing = snapshot.missingFields;
  let fields: ReportSlotFields = turn.fields ?? { description: input };
  if (turn.fields === undefined) {
    if (missing.includes("category")) fields = { category: input };
    else if (missing.includes("date")) fields = { dateText: input };
    else if (missing.includes("location")) fields = { locationNote: input };
  }
  const next = applyReportFields(snapshot, fields);
  return {
    snapshot: next,
    reply: replyForState(next),
    replySource: "grounded",
    reviewHeld: next.state === "ready",
  };
}

export async function executeCloudAssistantMessage(
  snapshot: GuidedSnapshot | null,
  message: string,
  generate: CloudGenerate = generateCloud,
): Promise<CloudAssistantResult> {
  const input = message.trim();
  if (!input) throw new Error("Enter a message.");
  if (snapshot !== null && snapshot.state === "recovering") {
    return {
      snapshot,
      reply: snapshot.recovery?.message ?? "Something went wrong. You can retry or continue manually.",
      replySource: "grounded",
      reviewHeld: false,
    };
  }

  // Over the chat bound: honest answer, no model call, nothing collected.
  if (input.length > MAX_CHAT_INPUT_CHARS) {
    return {
      snapshot: snapshot ?? startFlow("ask"),
      reply: `That message is longer than the ${MAX_CHAT_INPUT_CHARS}-character chat limit. Please shorten it and send it again.`,
      replySource: "grounded",
      reviewHeld: false,
    };
  }

  const current = snapshot ?? startFlow(inferFlow(input));

  // Instruction-override phrasing is ordinary text: no model call, no state.
  if (isInstructionOverride(input)) {
    return {
      snapshot: current,
      reply: builtInHelp(input),
      replySource: "grounded",
      reviewHeld: false,
    };
  }

  // A greeting with no task in it never reaches the model and never moves state.
  const turn = resolveReportTurn(current, input);
  if (turn.kind === "GREETING" && !GREETING_TASK_HINT.test(input)) {
    const reply =
      current.flow === "ask"
        ? GREETING_ASK_REPLY
        : current.state === "ready"
          ? `Hello! ${replyForState(current)}`
          : `Hello! ${resumeQuestion(current)}`;
    return {
      snapshot: current,
      reply,
      replySource: "grounded",
      reviewHeld: current.state === "ready",
    };
  }

  if (snapshot !== null && snapshot.state !== "ready" && snapshot.flow !== "ask") {
    return continueReportCollection(snapshot, input, generate);
  }
  if (current.flow === "ask") return askTurn(current, input, generate);
  if (current.flow === "search") return searchTurnFrom(current, input, generate);
  return reportTurnFromStart(current.flow, input, generate);
}

/** Same flow inference the fresh-chat route has always used. */
function inferFlow(input: string): "search" | "found" | "lost" | "ask" {
  return /\bsearch|find|look for\b/i.test(input)
    ? "search"
    : /\b(found|find owner)\b/i.test(input)
      ? "found"
      : /\b(lost|report)\b/i.test(input)
        ? "lost"
        : "ask";
}
