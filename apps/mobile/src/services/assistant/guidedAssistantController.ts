/**
 * Deterministic controller for the guided assistant sheet.
 *
 * The controller owns intent, missing fields, conversation state, allowed
 * actions, and the report-draft patch. The model performs only narrow
 * implemented operations (classify-intent, extract-report-fields,
 * extract-search-filters, answer-help); every state change here is
 * code-owned and every snapshot is a plain value.
 *
 * Photo and location steps are request seams: the controller records which
 * choice the user picked but wires nothing — the report form consumes the
 * patch and the choices later. Incident location is never inferred: the
 * patch carries a location note only from explicitly typed text.
 */
import { makeAskUserPrompt } from "../ai/clarificationCopy";
import { RECOVERY_COPY } from "../ai/errors";
import type {
  Action,
  AiError,
  AiErrorClass,
  AskUserPrompt,
  ClarificationField,
  Intent,
  ReportSlotFields,
  SearchFilterFields,
} from "../ai/types";
import {
  buildReportDraftPatch,
  mergeReportDraftPatch,
  type ReportDraftPatch,
} from "./reportDraftPatch";

export type GuidedFlow = "lost" | "found" | "search" | "ask";

export type ConversationState =
  | "idle"
  | "collecting"
  | "awaitingPhoto"
  | "awaitingLocation"
  | "ready"
  | "recovering";

export type PhotoChoice = "take" | "choose" | "none";

export type LocationChoice = "map" | "current" | "typed" | "skip";

export const GUIDED_FLOWS: readonly GuidedFlow[] = ["lost", "found", "search", "ask"];

export const PHOTO_CHOICES: readonly PhotoChoice[] = ["take", "choose", "none"];

export const LOCATION_CHOICES: readonly LocationChoice[] = ["map", "current", "typed", "skip"];

export interface PhotoStepRequest {
  readonly step: "photo";
  readonly choices: readonly PhotoChoice[];
}

export interface LocationStepRequest {
  readonly step: "location";
  readonly choices: readonly LocationChoice[];
}

export const GUIDED_RECOVERY_CLASSES: readonly AiErrorClass[] = [
  "LOOP_DETECTED",
  "TIMEOUT",
  "LOW_MEMORY",
  "INVALID_OUTPUT",
  "MODEL_UNAVAILABLE",
  "MODEL_CORRUPT",
  "UNSUPPORTED_REQUEST",
];

export interface GuidedRecovery {
  readonly errorClass: AiErrorClass;
  readonly message: string;
  readonly actions: readonly string[];
  readonly diagnostic: string;
  readonly returnTo: ConversationState;
}

export interface GuidedSnapshot {
  readonly flow: GuidedFlow;
  readonly intent: Intent;
  readonly state: ConversationState;
  readonly missingFields: readonly ClarificationField[];
  readonly allowedActions: readonly Action[];
  readonly patch: ReportDraftPatch;
  readonly searchFilters?: SearchFilterFields;
  readonly photoChoice?: PhotoChoice;
  readonly locationChoice?: LocationChoice;
  readonly photoRequest?: PhotoStepRequest;
  readonly locationRequest?: LocationStepRequest;
  readonly recovery?: GuidedRecovery;
}

const REPORT_FLOWS: readonly GuidedFlow[] = ["lost", "found"];

function isReportFlow(flow: GuidedFlow): boolean {
  return REPORT_FLOWS.includes(flow);
}

export function intentForFlow(flow: GuidedFlow): Intent {
  switch (flow) {
    case "lost":
      return "REPORT_LOST";
    case "found":
      return "REPORT_FOUND";
    case "search":
      return "SEARCH";
    case "ask":
      return "OPEN_QUESTION";
  }
}

export function flowForIntent(intent: Intent): GuidedFlow {
  switch (intent) {
    case "REPORT_LOST":
      return "lost";
    case "REPORT_FOUND":
      return "found";
    case "SEARCH":
      return "search";
    case "APP_QUESTION":
    case "OPEN_QUESTION":
    case "UNKNOWN":
      return "ask";
  }
}

export function allowedActions(flow: GuidedFlow, state: ConversationState): readonly Action[] {
  switch (state) {
    case "recovering":
      return [];
    case "awaitingPhoto":
      return ["PICK_PHOTO", "TAKE_PHOTO"];
    case "awaitingLocation":
      return ["OPEN_MAP"];
    case "ready":
      if (isReportFlow(flow)) return ["APPLY_REPORT_DRAFT"];
      if (flow === "search") return ["OPEN_SEARCH"];
      return ["NONE"];
    case "idle":
    case "collecting":
      return ["ASK_USER"];
  }
}

function reportMissingFor(
  patch: ReportDraftPatch,
  photoChoice: PhotoChoice | undefined,
  locationChoice: LocationChoice | undefined,
): ClarificationField[] {
  const missing: ClarificationField[] = [];
  if (patch.category === undefined) missing.push("category");
  if (patch.eventDate === undefined) missing.push("date");
  if (patch.locationNote === undefined && locationChoice === undefined) missing.push("location");
  if (photoChoice === undefined) missing.push("photo");
  return missing;
}

function withState(
  snapshot: GuidedSnapshot,
  state: ConversationState,
  missing: readonly ClarificationField[],
): GuidedSnapshot {
  return {
    ...snapshot,
    state,
    missingFields: missing,
    allowedActions: allowedActions(snapshot.flow, state),
    photoRequest:
      state === "awaitingPhoto" ? { step: "photo", choices: PHOTO_CHOICES } : undefined,
    locationRequest:
      state === "awaitingLocation"
        ? { step: "location", choices: LOCATION_CHOICES }
        : undefined,
  };
}

export function startFlow(flow: GuidedFlow): GuidedSnapshot {
  const base: GuidedSnapshot = {
    flow,
    intent: intentForFlow(flow),
    state: "collecting",
    missingFields: [],
    allowedActions: allowedActions(flow, "collecting"),
    patch: {},
  };
  if (isReportFlow(flow)) {
    return {
      ...base,
      missingFields: reportMissingFor(base.patch, undefined, undefined),
    };
  }
  if (flow === "search") {
    return { ...base, missingFields: ["query"] };
  }
  return base;
}

export function snapshotForIntent(intent: Intent): GuidedSnapshot {
  return startFlow(flowForIntent(intent));
}

export function applyReportFields(
  snapshot: GuidedSnapshot,
  fields: ReportSlotFields,
): GuidedSnapshot {
  if (snapshot.state === "recovering") return snapshot;
  const patch = mergeReportDraftPatch(
    snapshot.patch,
    buildReportDraftPatch(fields, snapshot.intent),
  );
  const missing = reportMissingFor(patch, snapshot.photoChoice, snapshot.locationChoice);
  const open = missing.filter((field) => field !== "photo");
  const next: GuidedSnapshot = { ...snapshot, patch, searchFilters: undefined };
  if (open.length === 0) return withState(next, "awaitingPhoto", missing);
  return withState(next, "collecting", missing);
}

export function applySearchFields(
  snapshot: GuidedSnapshot,
  fields: SearchFilterFields,
): GuidedSnapshot {
  if (snapshot.state === "recovering") return snapshot;
  const merged: SearchFilterFields = {
    ...snapshot.searchFilters,
    ...(fields.query !== undefined ? { query: fields.query } : null),
    ...(fields.category !== undefined ? { category: fields.category } : null),
    ...(fields.status !== undefined ? { status: fields.status } : null),
    ...(fields.dateRangeText !== undefined ? { dateRangeText: fields.dateRangeText } : null),
  };
  const missing: ClarificationField[] = merged.query === undefined ? ["query"] : [];
  const next: GuidedSnapshot = { ...snapshot, searchFilters: merged };
  if (missing.length === 0) return withState(next, "ready", missing);
  return withState(next, "collecting", missing);
}

export function choosePhoto(snapshot: GuidedSnapshot, choice: PhotoChoice): GuidedSnapshot {
  if (snapshot.state === "recovering") return snapshot;
  const missing = reportMissingFor(snapshot.patch, choice, snapshot.locationChoice);
  const open = missing.filter((field) => field !== "photo");
  const next: GuidedSnapshot = { ...snapshot, photoChoice: choice };
  if (open.length === 0) return withState(next, "awaitingLocation", missing);
  return withState(next, "collecting", missing);
}

export function chooseLocation(
  snapshot: GuidedSnapshot,
  choice: LocationChoice,
  typedNote?: string,
): GuidedSnapshot {
  if (snapshot.state === "recovering") return snapshot;
  const note = typedNote?.trim();
  const patch =
    choice === "typed" && note !== undefined && note.length > 0
      ? { ...snapshot.patch, locationNote: note }
      : snapshot.patch;
  const missing = reportMissingFor(patch, snapshot.photoChoice, choice);
  const next: GuidedSnapshot = { ...snapshot, patch, locationChoice: choice };
  if (missing.length === 0) return withState(next, "ready", missing);
  return withState(next, "collecting", missing);
}

export function failWith(snapshot: GuidedSnapshot, error: AiError): GuidedSnapshot {
  const plan = RECOVERY_COPY[error.errorClass];
  return {
    ...snapshot,
    state: "recovering",
    missingFields: snapshot.missingFields,
    allowedActions: [],
    photoRequest: undefined,
    locationRequest: undefined,
    recovery: {
      errorClass: error.errorClass,
      message: plan.message,
      actions: [...plan.actions],
      diagnostic: error.diagnostic,
      returnTo: snapshot.state === "recovering" ? "collecting" : snapshot.state,
    },
  };
}

export function retryAfterRecovery(snapshot: GuidedSnapshot): GuidedSnapshot {
  if (snapshot.recovery === undefined) return snapshot;
  const next: GuidedSnapshot = { ...snapshot, recovery: undefined };
  return withState(next, snapshot.recovery.returnTo, snapshot.missingFields);
}

export function nextMissingQuestion(snapshot: GuidedSnapshot): AskUserPrompt | null {
  const field = snapshot.missingFields[0];
  if (field === undefined) return null;
  return makeAskUserPrompt({ field });
}
