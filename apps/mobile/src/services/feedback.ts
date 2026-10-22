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
