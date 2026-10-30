/**
 * Feedback — the app's own support channel, with the privacy boundary kept in
 * the server and respected here.
 *
 * WHAT THE USER SENDS. A closed category, a message of 1–2000 characters, and
 * an explicit opt-in for technical detail. The technical detail is FOUR NAMED
 * SCALARS (app version, platform, screen, device class) — never a log, never a
 * token, never a free-form blob: the server RPC has no jsonb parameter at all
 * (MC D31), so this service has nothing to serialise and no way to leak one.
 *
 * WHAT THE USER CAN READ BACK. Only their own submission's STATUS columns
 * (`id, category, status, created_at, updated_at`). The message, the technical
 * context and the moderator's note are outside the server grant, so this
 * service does not ask for them: a select that names an ungranted column is a
 * 42501, and a client that never names it cannot accidentally take the whole
 * row (MC D32).
 *
 * The consumer form (settings leaf, category picker, the opt-in switch) is the
 * safety-UI lane's; this file is the small server-shaped service only.
 */
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";

/** The four categories the server accepts. */
export const FEEDBACK_CATEGORIES = ["BUG", "SUGGESTION", "USABILITY", "OTHER"] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** The three statuses the server knows. */
export const FEEDBACK_STATUSES = ["NEW", "REVIEWING", "RESOLVED"] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Human labels. A raw database word is never shown to a reader. */
export const FEEDBACK_CATEGORY_LABELS: Readonly<Record<FeedbackCategory, string>> = {
  BUG: "Something is broken",
  SUGGESTION: "An idea",
  USABILITY: "Hard to use",
  OTHER: "Something else",
};

/** What the user is told their report's state is — not an internal queue word. */
export const FEEDBACK_STATUS_LABELS: Readonly<Record<FeedbackStatus, string>> = {
  NEW: "Received",
  REVIEWING: "Being reviewed",
  RESOLVED: "Resolved",
};

/** The server's message bound. The client refuses too long, never truncates. */
export const FEEDBACK_MESSAGE_MAX = 2000;

/** What the form collects. The scalars are optional and never a blob. */
export interface FeedbackDraft {
  category: FeedbackCategory;
  message: string;
  includeTechnicalInfo: boolean;
  appVersion?: string | null;
  platform?: string | null;
  screen?: string | null;
  deviceClass?: string | null;
}

/** One of the caller's own submissions, as far as the server exposes it. */
export interface MyFeedback {
  id: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * The server's answer, mapped honestly.
 *
 *   42501  not yours to do / to read (403)
 *   22023  the category, the message or a scalar is outside the bound (400)
 *   28000  no signed-in account (401)
 *   P0001  a rate-limit refusal; the message names it (429)
 */
function feedbackError(message: string, code?: string): ApiError {
  if (code === "42501") return new ApiError(message, 403, code);
  if (code === "22023") return new ApiError(message, 400, code);
  if (code === "28000") return new ApiError(message, 401, code);
  if (code === "P0002") return new ApiError(message, 404, code);
  if (code === "P0001" && message === "FEEDBACK_CHANGED") return new ApiError(message, 409, message);
  if (code === "P0001" || code === "FEEDBACK_LIMIT_REACHED") return new ApiError(message, 429, code);
  return new ApiError(message, 500, code);
}

function isCategory(value: unknown): value is FeedbackCategory {
  return typeof value === "string" && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is FeedbackStatus {
  return typeof value === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

function optionalScalar(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Submit feedback and return the row id the server stored.
 *
 * The category and the message are refused HERE as well as on the server: a
 * form that offers a category the server does not know, or sends an empty
 * message, would otherwise spend a round trip to learn what the app already
 * knows.
 */
export async function submitFeedback(draft: FeedbackDraft): Promise<string> {
  if (!isCategory(draft.category)) {
    throw new ApiError("Choose a feedback category.", 400, "UNKNOWN_CATEGORY");
  }
  const message = draft.message.trim();
  if (message.length < 1) {
    throw new ApiError("Write something before sending feedback.", 400, "EMPTY_MESSAGE");
  }
  if (message.length > FEEDBACK_MESSAGE_MAX) {
    throw new ApiError(`Feedback must be at most ${FEEDBACK_MESSAGE_MAX} characters.`, 400, "MESSAGE_TOO_LONG");
  }

  const { data, error } = await getSupabase().rpc("findback_submit_feedback", {
    p_category: draft.category,
    p_message: message,
    p_include_technical_info: draft.includeTechnicalInfo,
    p_app_version: optionalScalar(draft.appVersion),
    p_platform: optionalScalar(draft.platform),
    p_screen: optionalScalar(draft.screen),
    p_device_class: optionalScalar(draft.deviceClass),
  });
  if (error) throw feedbackError(error.message, error.code);
  if (typeof data !== "string" || !data.trim()) {
    throw new ApiError("The server did not confirm the feedback.", 500, "UNEXPECTED_SHAPE");
  }
  return data;
}

/**
 * The caller's own submissions, newest first.
 *
 * The column list is the grant, deliberately: `message`, `technical_context`
 * and `admin_note` are NOT selected because the server does not grant them.
 * Rows whose category or status the app does not know are dropped rather than
 * shown with a raw database word.
 */
export async function listMyFeedback(): Promise<MyFeedback[]> {
  const { data, error } = await getSupabase()
    .from("feedback")
    .select("id, category, status, created_at, updated_at")
    .order("created_at", { ascending: false });
  if (error) throw feedbackError(error.message, error.code);
  return ((data ?? []) as Record<string, unknown>[])
    .map((row) => {
      if (!isCategory(row.category) || !isStatus(row.status)) return null;
      return {
        id: String(row.id ?? ""),
        category: row.category,
        status: row.status,
        createdAt: String(row.created_at ?? ""),
        updatedAt: String(row.updated_at ?? ""),
      } satisfies MyFeedback;
    })
    .filter((row): row is MyFeedback => row !== null && row.id !== "");
}

export interface FeedbackCursor { createdAt: string; id: string }
export interface StaffFeedbackDetail extends MyFeedback {
  message: string;
  adminNote: string | null;
  technicalContext: Partial<Record<"captured_at" | "app_version" | "platform" | "screen" | "device_class", string>> | null;
}

function exactId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
function feedbackTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function feedbackShapeError(): ApiError { return new ApiError("The server did not return feedback to review.", 500, "UNEXPECTED_SHAPE"); }
function staffFeedbackSummary(value: unknown): MyFeedback | null {
  const row = record(value);
  if (!row || !exactId(row.id) || !isCategory(row.category) || !isStatus(row.status) || !feedbackTime(row.created_at) || !feedbackTime(row.updated_at)) return null;
  return { id: row.id, category: row.category, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Default pending queue; raw keyset continuation never depends on client filtering. */
export async function listStaffFeedback(options: { status?: FeedbackStatus; limit?: number; before?: FeedbackCursor } = {}): Promise<{ items: MyFeedback[]; nextCursor: FeedbackCursor | null }> {
  if ((options.status && !isStatus(options.status)) || (options.before && (!exactId(options.before.id) || !feedbackTime(options.before.createdAt)))) throw new ApiError("Choose a valid feedback page.", 400, "INVALID_CURSOR");
  const limit = options.limit ?? 25;
  const { data, error } = await getSupabase().rpc("findback_staff_feedback", {
    p_status: options.status ?? null, p_limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 25,
    p_before_created_at: options.before?.createdAt ?? null, p_before_id: options.before?.id ?? null,
  });
  if (error) throw feedbackError(error.message, error.code);
  const envelope = record(data);
  if (!envelope || !Array.isArray(envelope.items)) throw feedbackShapeError();
  const cursor = record(envelope.next_cursor);
  if (envelope.next_cursor !== null && (!cursor || !exactId(cursor.id) || !feedbackTime(cursor.created_at))) throw feedbackShapeError();
  return { items: envelope.items.flatMap(value => { const row = staffFeedbackSummary(value); return row ? [row] : []; }),
    nextCursor: cursor ? { id: cursor.id as string, createdAt: cursor.created_at as string } : null };
}

export async function fetchStaffFeedback(id: string): Promise<StaffFeedbackDetail> {
  if (!exactId(id)) throw new ApiError("Choose feedback to review.", 400, "MISSING_TARGET");
  const { data, error } = await getSupabase().rpc("findback_staff_feedback_detail", { p_feedback_id: id });
  if (error) throw feedbackError(error.message, error.code);
  const row = record(data);
  const summary = staffFeedbackSummary(row);
  if (!row || !summary || summary.id !== id || typeof row.message !== "string" || row.message.length < 1 || row.message.length > 2000
    || (row.admin_note !== null && (typeof row.admin_note !== "string" || row.admin_note.length > 2000))) throw feedbackShapeError();
  let technicalContext: StaffFeedbackDetail["technicalContext"] = null;
  if (row.technical_context !== null) {
    const context = record(row.technical_context);
    if (!context) throw feedbackShapeError();
    technicalContext = {};
    for (const key of ["captured_at", "app_version", "platform", "screen", "device_class"] as const) {
      if (typeof context[key] === "string" && context[key].length <= 80) technicalContext[key] = context[key];
    }
  }
  return { ...summary, message: row.message, adminNote: row.admin_note as string | null, technicalContext };
}

/** One conflict-fenced transition; all capability/row checks stay server-side. */
export async function reviewFeedback(id: string, status: FeedbackStatus, expectedStatus: FeedbackStatus, note?: string): Promise<void> {
  const adminNote = optionalScalar(note);
  if (!exactId(id) || !isStatus(status) || !isStatus(expectedStatus) || (adminNote?.length ?? 0) > 2000) throw new ApiError("Choose feedback and a valid review status.", 400, "INVALID_REVIEW");
  const { error } = await getSupabase().rpc("findback_review_feedback", {
    p_feedback_id: id, p_status: status, p_expected_status: expectedStatus, p_admin_note: adminNote,
  });
  if (error) throw feedbackError(error.message, error.code);
}
