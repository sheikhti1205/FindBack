/**
 * Moderation — the ONE client owner of the report → review → outcome path.
 *
 * THE TABLES ARE NOT READABLE. `content_reports`, `account_sanctions` and
 * `appeals` carry row level security with NO policy and no grant to any client
 * role; every read and every write is a SECURITY DEFINER RPC. That is why this
 * file has no table query in it at all: a client that wants a receipt asks
 * `findback_my_reports()`, and a client that wants the queue asks
 * `findback_moderation_queue()`.
 *
 * THE SERVER IS THE AUTHORITY. Nothing here decides whether the caller may
 * moderate: `findback_apply_moderation` re-checks the capability that
 * authorizes each action on every call, and refuses with 42501. The maps below
 * exist so a console can hide what the account cannot do — never so the client
 * can authorize anything itself.
 *
 * WHAT A CONSUMER MAY SEE. A report receipt is FIVE fields — id, target type,
 * reason, status, created_at. There is no target id, no evidence snapshot, no
 * internal note and no moderator in any consumer read. A moderator's target
 * reader returns the live row (or an honest null once it is deleted), its
 * reports and its decision history; reporter identity is never projected.
 *
 * THE VOCABULARIES ARE CLOSED and are spelled out here as well as in the
 * database, because a client that cannot name a reason cannot offer it. The
 * test beside this file reads the migration and fails if the two lists drift.
 */
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";
import type { ModeratorCapability } from "./roles";

/** What a report can point at (MC D1). */
export const REPORT_TARGET_TYPES = ["POST", "COMMENT", "USER"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** The seven report reasons (MC D2). Never free text, never extended here. */
export const REPORT_REASONS = [
  "SCAM_OR_MISLEADING",
  "SPAM_OR_DUPLICATE",
  "HARASSMENT",
  "INAPPROPRIATE_CONTENT",
  "PRIVATE_INFORMATION",
  "SUSPECTED_STOLEN_OR_ILLEGAL",
  "OTHER",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** The four states a report can hold. */
export const REPORT_STATUSES = ["OPEN", "UNDER_REVIEW", "ACTIONED", "DISMISSED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** The closed moderation vocabulary (MC D39). */
export const MODERATION_ACTIONS = [
  "NO_ACTION",
  "PUBLISH",
  "HIDE",
  "REMOVE",
  "WARN",
  "PROBATION",
  "RESTRICT_POSTING",
  "SUSPEND",
  "BAN",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** The five sanction kinds a member action writes (MC D28). */
export const SANCTION_KINDS = ["WARNING", "PROBATION", "RESTRICTED", "SUSPENDED", "BANNED"] as const;
export type SanctionKind = (typeof SANCTION_KINDS)[number];

/** The visibility atom a content action replaces (unchanged by B2a). */
export const MODERATION_VISIBILITIES = [
  "PUBLISHED",
  "PENDING_REVIEW",
  "HIDDEN",
  "REMOVED",
] as const;
export type ModerationVisibility = (typeof MODERATION_VISIBILITIES)[number];

/**
 * Which capability authorizes each action (CONTRACT-ROLES-ADMIN §A2.1).
 *
 * FOR HIDING A CONTROL ONLY. `findback_apply_moderation` holds the same map and
 * re-checks it server-side; a client that ignored this map would collect 42501.
 */
export const ACTION_CAPABILITIES: Readonly<Record<ModerationAction, ModeratorCapability>> = {
  NO_ACTION: "reports_review",
  PUBLISH: "content_hide",
  HIDE: "content_hide",
  REMOVE: "content_remove",
  WARN: "members_warn",
  PROBATION: "members_warn",
  RESTRICT_POSTING: "members_restrict",
  SUSPEND: "members_suspend",
  BAN: "members_suspend",
};

/** The sanction kind each member action writes (MC A2.1). */
export const ACTION_SANCTION_KINDS: Readonly<Partial<Record<ModerationAction, SanctionKind>>> = {
  WARN: "WARNING",
  PROBATION: "PROBATION",
  RESTRICT_POSTING: "RESTRICTED",
  SUSPEND: "SUSPENDED",
  BAN: "BANNED",
};

/** The subject kinds an appeal can name (MC D15). */
export const APPEAL_SUBJECT_KINDS = ["MODERATION_ACTION", "SANCTION"] as const;
export type AppealSubjectKind = (typeof APPEAL_SUBJECT_KINDS)[number];

/** One consumer receipt. Deliberately five fields; nothing else is sent. */
export interface ReportReceipt {
  id: string;
  targetType: ReportTargetType;
  reason: ReportReason;
  status: ReportStatus;
  createdAt: string;
}

/** One derived case in the moderator queue (no case table exists, MC D38). */
export interface ModerationQueueEntry {
  targetType: ReportTargetType;
  targetId: string;
  reportCount: number;
  reasons: ReportReason[];
  firstReportedAt: string;
  lastReportedAt: string;
  currentVisibility: ModerationVisibility | null;
  targetExists: boolean;
  status: ReportStatus;
}

/** One report as a moderator sees it, with its bounded evidence. */
export interface ModerationCaseReport {
  id: string;
  reason: ReportReason;
  detail: string | null;
  status: ReportStatus;
  createdAt: string;
  reviewedAt: string | null;
  evidence: Record<string, unknown> | null;
}

/** One decision in a target's history. */
export interface ModerationDecision {
  action: ModerationAction;
  reason: ReportReason;
  createdAt: string;
}

/** The current decision generation that owns a case (owner policy 2026-10-23). */
export interface ModerationDecisionSummary {
  action: ModerationAction;
  generation: number;
  decidedAt: string;
  reopenedAt: string | null;
}

/** A consumer re-evaluation request that reopened the case. */
export interface ModerationReopenRequest {
  appealId: string;
  message: string;
  submittedAt: string;
}

/** The moderator's target reader: the live row, its reports, its decisions. */
export interface ModerationTarget {
  targetType: ReportTargetType;
  targetId: string;
  targetExists: boolean;
  target: Record<string, unknown> | null;
  reports: ModerationCaseReport[];
  decisions: ModerationDecision[];
  /** The current decision owner state, or null before the first decision. */
  decision?: ModerationDecisionSummary | null;
  /** The open re-evaluation request, or null when the case is not reopened. */
  reopen?: ModerationReopenRequest | null;
}

/** One outcome for the author ("your post was hidden"), never who or why. */
export interface ModerationOutcome {
  targetType: ReportTargetType;
  targetId: string;
  action: ModerationAction;
  reason: ReportReason;
  createdAt: string;
}

/** The author's own row state. A state reader, not a visibility predicate. */
export interface MyPostModeration {
  postId: string;
  visibility: ModerationVisibility;
  updatedAt: string;
}

/** The result of one moderated action: the audit row it appended. */
export interface ModerationResult {
  auditId: string;
}

/** The result of one appeal: its id. */
export interface AppealResult {
  appealId: string;
}

export type AppealStatus = "SUBMITTED" | "UNDER_REVIEW" | "RESOLVED";
export interface AppealReceipt {
  id: string;
  subjectKind: AppealSubjectKind;
  subjectId: string;
  status: AppealStatus;
  submittedAt: string;
  resolvedAt: string | null;
}
export interface AppealSubject {
  subjectKind: AppealSubjectKind;
  subjectId: string;
  targetType: ReportTargetType;
  targetId: string;
  action: ModerationAction;
  reason: ReportReason;
  createdAt: string;
  openAppealId: string | null;
}
export interface AppealReceiptCursor { submittedAt: string; id: string }
export interface AppealSubjectCursor { createdAt: string; subjectKind: AppealSubjectKind; subjectId: string }
export interface AppealPage<T, C> { items: T[]; nextCursor: C | null }

/** Input for `submitReport`. `detail` is optional and bounded to 2000. */
export interface SubmitReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  detail?: string | null;
}

/** Input for `applyModeration`. Every sanction field is optional. */
export interface ApplyModerationInput {
  targetType: ReportTargetType;
  targetId: string;
  action: ModerationAction;
  reasonCode: ReportReason;
  note?: string | null;
  sanctionKind?: SanctionKind | null;
  sanctionEndsAt?: string | null;
}

/**
 * The server's refusal is a real answer.
 *
 * `42501` is "you may not do this" (403), `28000` is "you are not signed in"
 * (401), `22023` is a bad request (400) and `P0002` is the one neutral "target
 * unavailable" (404). `P0001` carries stable tokens: a refused report is
 * REPORT_LIMIT_REACHED (429, come back later), a second open appeal is
 * APPEAL_ALREADY_OPEN (409, already done) and a second moderator acting on a
 * final decision is MODERATION_DECISION_FINAL (409, the original decider must
 * change it or the author must ask for re-evaluation). Anything else — a missing function
 * before the migration is applied, a transport failure, a schema mismatch — is
 * a server trouble (500), because reporting it as "bad request" would tell the
 * caller their own request was wrong.
 */
function moderationError(message: string, code?: string): ApiError {
  if (code === "42501") return new ApiError(message, 403, code);
  if (code === "28000") return new ApiError(message, 401, code);
  if (code === "22023") return new ApiError(message, 400, code);
  if (code === "P0002") return new ApiError(message, 404, code);
  if (code === "P0001") {
    if (message === "REPORT_LIMIT_REACHED") return new ApiError(message, 429, message);
    if (message === "APPEAL_ALREADY_OPEN") return new ApiError(message, 409, message);
    if (message === "MODERATION_DECISION_FINAL") return new ApiError(message, 409, message);
  }
  return new ApiError(message, 500, code);
}

function isReason(value: unknown): value is ReportReason {
  return typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
}

function isTargetType(value: unknown): value is ReportTargetType {
  return typeof value === "string" && (REPORT_TARGET_TYPES as readonly string[]).includes(value);
}

function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);
}

function isAction(value: unknown): value is ModerationAction {
  return typeof value === "string" && (MODERATION_ACTIONS as readonly string[]).includes(value);
}

function isVisibility(value: unknown): value is ModerationVisibility {
  return typeof value === "string" && (MODERATION_VISIBILITIES as readonly string[]).includes(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function reasons(value: unknown): ReportReason[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isReason);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRows(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
}

/**
 * A receipt the client cannot label is DROPPED, never invented.
 *
 * The reason, the target type and the status are closed vocabularies. A row
 * carrying anything else came from a server newer than this build; showing it
 * as "OPEN" or "OTHER" would state a fact the client does not have.
 */
function parseReceipt(row: Record<string, unknown>): ReportReceipt | null {
  const id = text(row.id);
  const createdAt = text(row.created_at);
  if (!id || !createdAt) return null;
  if (!isTargetType(row.target_type) || !isReason(row.reason) || !isReportStatus(row.status)) return null;
  return {
    id,
    targetType: row.target_type,
    reason: row.reason,
    status: row.status,
    createdAt,
  };
}

/**
 * File one report. Returns the surviving receipt id.
 *
 * The call is idempotent for one (caller, target): a retry — and a genuine
 * duplicate — answer the SAME id rather than an error. The target is validated
 * server-side against the one visibility decision, so a hidden, deleted and
 * nonexistent target all answer the same neutral "unavailable".
 */
export async function submitReport(input: SubmitReportInput): Promise<{ reportId: string }> {
  if (!isTargetType(input.targetType)) {
    throw new ApiError("Choose what you are reporting.", 400, "UNKNOWN_TARGET_TYPE");
  }
  if (!isReason(input.reason)) {
    throw new ApiError("Choose a reason from the list.", 400, "UNKNOWN_REASON");
  }
  const targetId = input.targetId.trim();
  if (targetId === "") {
    throw new ApiError("Choose what you are reporting.", 400, "MISSING_TARGET");
  }
  const detail = text(input.detail);
  if (detail !== null && detail.length > 2000) {
    throw new ApiError("Keep the note under 2000 characters.", 400, "DETAIL_TOO_LONG");
  }

  const { data, error } = await getSupabase().rpc("findback_submit_report", {
    p_target_type: input.targetType,
    p_target_id: targetId,
    p_reason: input.reason,
    p_detail: detail,
  });
  if (error) throw moderationError(error.message, error.code);
  const reportId = text(data);
  if (!reportId) throw new ApiError("The server did not return a receipt.", 500, "UNEXPECTED_SHAPE");
  return { reportId };
}

/** The caller's own receipts, newest first. There is no other read path. */
export async function listMyReports(): Promise<ReportReceipt[]> {
  const { data, error } = await getSupabase().rpc("findback_my_reports", {});
  if (error) throw moderationError(error.message, error.code);
  return asRows(data)
    .map(parseReceipt)
    .filter((row): row is ReportReceipt => row !== null);
}

/**
 * The open cases, grouped by the stable (target_type, target_id) key.
 *
 * Moderator-only: the server refuses an ordinary account with 42501. The queue
 * is an index — the target reader is the detail.
 */
export async function fetchModerationQueue(limit = 50): Promise<ModerationQueueEntry[]> {
  const { data, error } = await getSupabase().rpc("findback_moderation_queue", { p_limit: limit });
  if (error) throw moderationError(error.message, error.code);
  return asRows(data)
    .map((row) => {
      const targetType = isTargetType(row.target_type) ? row.target_type : null;
      const targetId = text(row.target_id);
      const first = text(row.first_reported_at);
      const last = text(row.last_reported_at);
      if (!targetType || !targetId || !first || !last) return null;
      const status = isReportStatus(row.status) ? row.status : null;
      if (!status) return null;
      return {
        targetType,
        targetId,
        reportCount: count(row.report_count),
        reasons: reasons(row.reasons),
        firstReportedAt: first,
        lastReportedAt: last,
        currentVisibility: isVisibility(row.current_visibility) ? row.current_visibility : null,
        targetExists: row.target_exists === true,
        status,
      } satisfies ModerationQueueEntry;
    })
    .filter((row): row is ModerationQueueEntry => row !== null);
}

/** One case in full: the live target (or null), its reports, its decisions. */
export async function fetchModerationTarget(
  targetType: ReportTargetType,
  targetId: string,
): Promise<ModerationTarget> {
  if (!isTargetType(targetType) || targetId.trim() === "") {
    throw new ApiError("Choose a case to review.", 400, "UNKNOWN_TARGET");
  }
  const { data, error } = await getSupabase().rpc("findback_moderation_target", {
    p_target_type: targetType,
    p_target_id: targetId.trim(),
  });
  if (error) throw moderationError(error.message, error.code);
  const payload = asRecord(data);
  if (!payload) throw new ApiError("The server did not return a case.", 500, "UNEXPECTED_SHAPE");

  const reports = Array.isArray(payload.reports) ? payload.reports : [];
  const decisions = Array.isArray(payload.outcomes) ? payload.outcomes : [];

  const decisionPayload = asRecord(payload.decision);
  const reopenPayload = asRecord(payload.reopen);
  const decisionAction =
    decisionPayload && isAction(decisionPayload.action) ? decisionPayload.action : null;
  const decisionDecidedAt = decisionPayload ? text(decisionPayload.decided_at) : null;
  const reopenAppealId = reopenPayload ? text(reopenPayload.appeal_id) : null;
  const reopenMessage = reopenPayload ? text(reopenPayload.message) : null;
  const reopenSubmittedAt = reopenPayload ? text(reopenPayload.submitted_at) : null;

  return {
    targetType,
    targetId: text(payload.target_id) ?? targetId.trim(),
    targetExists: payload.target_exists === true,
    target: asRecord(payload.target),
    decision:
      decisionAction && decisionDecidedAt
        ? {
            action: decisionAction,
            generation: count(decisionPayload?.generation),
            decidedAt: decisionDecidedAt,
            reopenedAt: decisionPayload ? text(decisionPayload.reopened_at) : null,
          }
        : null,
    reopen:
      reopenAppealId && reopenMessage && reopenSubmittedAt
        ? {
            appealId: reopenAppealId,
            message: reopenMessage,
            submittedAt: reopenSubmittedAt,
          }
        : null,
    reports: reports
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row) => {
        const id = text(row.id);
        const createdAt = text(row.created_at);
        if (!id || !createdAt || !isReason(row.reason) || !isReportStatus(row.status)) return null;
        return {
          id,
          reason: row.reason,
          detail: text(row.detail),
          status: row.status,
          createdAt,
          reviewedAt: text(row.reviewed_at),
          evidence: asRecord(row.evidence),
        } satisfies ModerationCaseReport;
      })
      .filter((row): row is ModerationCaseReport => row !== null),
    decisions: decisions
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row) => {
        const createdAt = text(row.created_at);
        if (!createdAt || !isAction(row.action) || !isReason(row.reason)) return null;
        return { action: row.action, reason: row.reason, createdAt } satisfies ModerationDecision;
      })
      .filter((row): row is ModerationDecision => row !== null),
  };
}

/**
 * Apply ONE moderated action and return the audit row it appended.
 *
 * The server holds the authority: it checks the capability for this action,
 * writes one state change, closes the report group, appends exactly one audit
 * row and notifies the author with a NULL actor. A refusal (42501) means the
 * account may not perform THIS action, whatever else it may do.
 */
export async function applyModeration(input: ApplyModerationInput): Promise<ModerationResult> {
  if (!isTargetType(input.targetType)) {
    throw new ApiError("Choose a case to review.", 400, "UNKNOWN_TARGET_TYPE");
  }
  if (!isAction(input.action)) {
    throw new ApiError("That action is not one the app may request.", 400, "UNKNOWN_ACTION");
  }
  if (!isReason(input.reasonCode)) {
    throw new ApiError("Choose a reason from the list.", 400, "UNKNOWN_REASON");
  }
  const targetId = input.targetId.trim();
  if (targetId === "") {
    throw new ApiError("Choose a case to review.", 400, "MISSING_TARGET");
  }
  const note = text(input.note);
  if (note !== null && note.length > 2000) {
    throw new ApiError("Keep the note under 2000 characters.", 400, "NOTE_TOO_LONG");
  }

  const { data, error } = await getSupabase().rpc("findback_apply_moderation", {
    p_target_type: input.targetType,
    p_target_id: targetId,
    p_action: input.action,
    p_reason_code: input.reasonCode,
    p_note: note,
    p_sanction_kind: input.sanctionKind ?? null,
    p_sanction_ends_at: text(input.sanctionEndsAt),
  });
  if (error) throw moderationError(error.message, error.code);
  const auditId = text(data);
  if (!auditId) throw new ApiError("The server did not return an audit id.", 500, "UNEXPECTED_SHAPE");
  return { auditId };
}

/** The caller's own outcomes, five fields. A deleted target stops resolving. */
export async function listMyModerationOutcomes(): Promise<ModerationOutcome[]> {
  const { data, error } = await getSupabase().rpc("findback_my_moderation_outcomes", {});
  if (error) throw moderationError(error.message, error.code);
  return asRows(data)
    .map((row) => {
      const targetType = isTargetType(row.target_type) ? row.target_type : null;
      const targetId = text(row.target_id);
      const createdAt = text(row.created_at);
      if (!targetType || !targetId || !createdAt) return null;
      if (!isAction(row.action) || !isReason(row.reason)) return null;
      return {
        targetType,
        targetId,
        action: row.action,
        reason: row.reason,
        createdAt,
      } satisfies ModerationOutcome;
    })
    .filter((row): row is ModerationOutcome => row !== null);
}

/** The state of the caller's own rows, in every state, and no one else's. */
export async function fetchMyPostModeration(): Promise<MyPostModeration[]> {
  const { data, error } = await getSupabase().rpc("findback_my_post_moderation", {});
  if (error) throw moderationError(error.message, error.code);
  return asRows(data)
    .map((row) => {
      const postId = text(row.post_id);
      const updatedAt = text(row.updated_at);
      if (!postId || !updatedAt || !isVisibility(row.moderation_visibility)) return null;
      return {
        postId,
        visibility: row.moderation_visibility,
        updatedAt,
      } satisfies MyPostModeration;
    })
    .filter((row): row is MyPostModeration => row !== null);
}

/**
 * Appeal one decision or one sanction.
 *
 * The caller must OWN the subject: a sanction of their own account, or a
 * decision against a row of theirs. Every failure is the same neutral
 * "unavailable", and a second open appeal answers APPEAL_ALREADY_OPEN (409).
 *
 * The affordance is not shown in the UI yet: CF-080 owns the appeals queue and
 * the resolver, and an appeal that cannot be resolved is a broken promise.
 * This function exists so the promise is one screen away, not one migration
 * away.
 */
export async function submitAppeal(
  subjectKind: AppealSubjectKind,
  subjectId: string,
  message: string,
): Promise<AppealResult> {
  if (!(APPEAL_SUBJECT_KINDS as readonly string[]).includes(subjectKind)) {
    throw new ApiError("Choose what you are appealing.", 400, "UNKNOWN_SUBJECT_KIND");
  }
  const id = subjectId.trim();
  if (id === "") throw new ApiError("Choose what you are appealing.", 400, "MISSING_SUBJECT");
  const body = message.trim();
  if (body.length < 1 || body.length > 2000) {
    throw new ApiError("Write between 1 and 2000 characters.", 400, "MESSAGE_LENGTH");
  }

  const { data, error } = await getSupabase().rpc("findback_submit_appeal", {
    p_target_kind: subjectKind,
    p_target_id: id,
    p_message: body,
  });
  if (error) throw moderationError(error.message, error.code);
  const appealId = text(data);
  if (!appealId) throw new ApiError("The server did not return an appeal id.", 500, "UNEXPECTED_SHAPE");
  return { appealId };
}

function isAppealKind(value: unknown): value is AppealSubjectKind {
  return value === "MODERATION_ACTION" || value === "SANCTION";
}

function exactText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** Validate UTC timestamps, but keep the exact string: it is a SQL sort key. */
function appealTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function appealPayloadError(): ApiError {
  return new ApiError("The server did not return an appeal page.", 500, "UNEXPECTED_SHAPE");
}

function appealEnvelope(data: unknown): { items: Record<string, unknown>[]; cursor: Record<string, unknown> | null } {
  const envelope = asRecord(data);
  if (!envelope || !Array.isArray(envelope.items)) throw appealPayloadError();
  const cursor = asRecord(envelope.next_cursor);
  if (envelope.next_cursor !== null && !cursor) throw appealPayloadError();
  return { items: asRows(envelope.items), cursor };
}

function appealPageLimit(limit = 50): number {
  return Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
}

/** Durable history, independent of live target availability. No local cache. */
export async function listMyAppeals(options: { limit?: number; before?: AppealReceiptCursor } = {}): Promise<AppealPage<AppealReceipt, AppealReceiptCursor>> {
  const before = options.before;
  if (before && (!appealTime(before.submittedAt) || !exactText(before.id))) {
    throw new ApiError("Choose a valid appeal page.", 400, "INVALID_CURSOR");
  }
  const { data, error } = await getSupabase().rpc("findback_my_appeals", {
    p_limit: appealPageLimit(options.limit),
    p_before_submitted_at: before?.submittedAt ?? null,
    p_before_id: before?.id ?? null,
  });
  if (error) throw moderationError(error.message, error.code);
  const { items, cursor } = appealEnvelope(data);
  let nextCursor: AppealReceiptCursor | null = null;
  if (cursor) {
    if (!appealTime(cursor.submitted_at) || !exactText(cursor.id)) throw appealPayloadError();
    nextCursor = { submittedAt: cursor.submitted_at, id: cursor.id };
  }
  return {
    nextCursor,
    items: items.flatMap((row): AppealReceipt[] => {
      if (!exactText(row.id) || !isAppealKind(row.subject_kind) || !exactText(row.subject_id) || !appealTime(row.submitted_at)) return [];
      if (row.status !== "SUBMITTED" && row.status !== "UNDER_REVIEW" && row.status !== "RESOLVED") return [];
      if (row.status === "RESOLVED" ? !appealTime(row.resolved_at) : row.resolved_at !== null) return [];
      return [{ id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, status: row.status, submittedAt: row.submitted_at, resolvedAt: row.resolved_at as string | null }];
    }),
  };
}

/** Discovery is not authorization; submitAppeal rechecks the referenced owner. */
export async function listMyAppealSubjects(options: { limit?: number; before?: AppealSubjectCursor } = {}): Promise<AppealPage<AppealSubject, AppealSubjectCursor>> {
  const before = options.before;
  if (before && (!appealTime(before.createdAt) || !isAppealKind(before.subjectKind) || !exactText(before.subjectId))) {
    throw new ApiError("Choose a valid appeal page.", 400, "INVALID_CURSOR");
  }
  const { data, error } = await getSupabase().rpc("findback_my_appeal_subjects", {
    p_limit: appealPageLimit(options.limit),
    p_before_created_at: before?.createdAt ?? null,
    p_before_subject_kind: before?.subjectKind ?? null,
    p_before_subject_id: before?.subjectId ?? null,
  });
  if (error) throw moderationError(error.message, error.code);
  const { items, cursor } = appealEnvelope(data);
  let nextCursor: AppealSubjectCursor | null = null;
  if (cursor) {
    if (!appealTime(cursor.created_at) || !isAppealKind(cursor.subject_kind) || !exactText(cursor.subject_id)) throw appealPayloadError();
    nextCursor = { createdAt: cursor.created_at, subjectKind: cursor.subject_kind, subjectId: cursor.subject_id };
  }
  return {
    nextCursor,
    items: items.flatMap((row): AppealSubject[] => {
      if (!isAppealKind(row.subject_kind) || !exactText(row.subject_id) || !exactText(row.target_id) || !appealTime(row.created_at) || !isReason(row.reason) || !isAction(row.action)) return [];
      if (row.open_appeal_id !== null && !exactText(row.open_appeal_id)) return [];
      const content = row.subject_kind === "MODERATION_ACTION" && (row.target_type === "POST" || row.target_type === "COMMENT") && (row.action === "HIDE" || row.action === "REMOVE");
      const sanction = row.subject_kind === "SANCTION" && row.target_type === "USER" && ACTION_SANCTION_KINDS[row.action] !== undefined;
      if (!content && !sanction) return [];
      return [{ subjectKind: row.subject_kind, subjectId: row.subject_id, targetType: row.target_type as ReportTargetType, targetId: row.target_id, action: row.action, reason: row.reason, createdAt: row.created_at, openAppealId: row.open_appeal_id as string | null }];
    }),
  };
}
