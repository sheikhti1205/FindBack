/**
 * Consumer copy for the safety surfaces — ONE place, so no two screens can
 * call the same thing two different ways.
 *
 * WHAT THIS MODULE IS. A translation layer from the closed vocabularies the
 * server speaks (`REPORT_REASONS`, `REPORT_STATUSES`, `MODERATION_ACTIONS`,
 * `REPORT_TARGET_TYPES`) into words a reader can picture. A database word is
 * never rendered raw: `SCAM_OR_MISLEADING` is a column value, "Scam or
 * misleading" is a thing a person did.
 *
 * WHAT THIS MODULE IS NOT. It is not a place to invent vocabulary. Every list
 * here is keyed by a type the server already defined, so a value the server
 * sends that is not in these tables has NO label and is therefore never shown
 * (the services drop such a row rather than guess — see `services/moderation.ts`).
 *
 * THE VOCABULARY IS CLOSED IN BOTH DIRECTIONS. The moderation vocabulary
 * (MC D39) has nine actions and the reason vocabulary (MC D2) has seven; a
 * surface that offered a tenth reason or a tenth action would be offering the
 * server something it will refuse. The tables below are the whole vocabulary.
 */
import type {
  ModerationAction,
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from "../services/moderation";
import type { ReputationTier, Standing } from "../services/trust";

/** The seven report reasons, in words. */
export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  SCAM_OR_MISLEADING: "Scam or misleading",
  SPAM_OR_DUPLICATE: "Spam or a duplicate",
  HARASSMENT: "Harassment",
  INAPPROPRIATE_CONTENT: "Inappropriate content",
  PRIVATE_INFORMATION: "Shares private information",
  SUSPECTED_STOLEN_OR_ILLEGAL: "Suspected stolen or illegal item",
  OTHER: "Something else",
};

/** One line under each reason, so the reader can tell two apart. */
export const REPORT_REASON_HINTS: Readonly<Record<ReportReason, string>> = {
  SCAM_OR_MISLEADING: "Asks for money, or describes something that isn't real.",
  SPAM_OR_DUPLICATE: "Repeated, or posted many times.",
  HARASSMENT: "Targets a person, or is abusive.",
  INAPPROPRIATE_CONTENT: "Not appropriate for FindBack.",
  PRIVATE_INFORMATION: "Shows an address, a phone number, or a document.",
  SUSPECTED_STOLEN_OR_ILLEGAL: "Looks like it was taken, or is not allowed to be sold.",
  OTHER: "Tell us in your own words.",
};

/** The four report states, in words. */
export const REPORT_STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  OPEN: "Waiting to be looked at",
  UNDER_REVIEW: "Being looked at now",
  ACTIONED: "We took action",
  DISMISSED: "Closed without action",
};

/**
 * What a report can point at, in words.
 *
 * `POST` is a lost & found report, so it is called "report" here — the same
 * word the app already uses for it. `USER` is a person, never "user".
 */
export const REPORT_TARGET_LABELS: Readonly<Record<ReportTargetType, string>> = {
  POST: "report",
  COMMENT: "comment",
  USER: "person",
};

/** The subject phrase used in a sentence: "this report", "this comment". */
export const REPORT_TARGET_SUBJECTS: Readonly<Record<ReportTargetType, string>> = {
  POST: "this report",
  COMMENT: "this comment",
  USER: "this person",
};

/** The nine moderation actions, in words a moderator can picture. */
export const MODERATION_ACTION_LABELS: Readonly<Record<ModerationAction, string>> = {
  NO_ACTION: "Close without action",
  PUBLISH: "Make it visible again",
  HIDE: "Hide it",
  REMOVE: "Remove it",
  WARN: "Warn the person",
  PROBATION: "Put on probation",
  RESTRICT_POSTING: "Stop them posting",
  SUSPEND: "Suspend the account",
  BAN: "Ban the account",
};

/** One line under each action, so two similar actions can be told apart. */
export const MODERATION_ACTION_HINTS: Readonly<Record<ModerationAction, string>> = {
  NO_ACTION: "Nothing is changed. The report is closed.",
  PUBLISH: "It becomes visible to everyone again.",
  HIDE: "Only the people involved can still see it.",
  REMOVE: "It is taken down.",
  WARN: "The person is told to be careful.",
  PROBATION: "The person can post less for a while.",
  RESTRICT_POSTING: "The person cannot post any more.",
  SUSPEND: "The person cannot use the account for a while.",
  BAN: "The person cannot use the account at all.",
};

/** The four visibilities a moderated item can hold, in words. */
export const MODERATION_VISIBILITY_LABELS = {
  PUBLISHED: "Visible to everyone",
  PENDING_REVIEW: "Waiting to be looked at",
  HIDDEN: "Hidden",
  REMOVED: "Removed",
} as const;

/** A date, in the app's own way: "22 October 2026". */
export function formatSafetyDate(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * The five standings, as a sentence.
 *
 * A standing is a fact about the reader's own account, so it is written as a
 * whole sentence — a fragment such as "Restricted" on its own tells the reader
 * nothing about what it means for them.
 */
export const STANDING_SENTENCES: Readonly<Record<Standing, string>> = {
  GOOD: "Your account is in good standing.",
  PROBATION: "Your account is on probation — you can post less for a while.",
  RESTRICTED: "Your account cannot post at the moment.",
  SUSPENDED: "Your account is suspended for a while.",
  BANNED: "Your account has been closed.",
};

/**
 * The three reputation tiers, as a sentence.
 *
 * A tier is a LABEL the server derives — never a number and never a score, so
 * no screen may show "4.2 out of 5" or a star count for it.
 */
export const REPUTATION_TIER_SENTENCES: Readonly<Record<ReputationTier, string>> = {
  NEW: "You are a new member.",
  NORMAL: "You are an established member.",
  TRUSTED: "You are a trusted member.",
};

/**
 * What a refused rating is called, in the client's own words.
 *
 * The server owns the reason (it refuses with 23505, 22023 and 42501) and the
 * client owns the sentence. The words are written here rather than echoed from
 * the server, so no database text can reach a reader and the wording survives
 * a change on the server.
 */
export const RATING_REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  "23505": "You have already rated this recovery.",
  "22023": "This recovery has no FindBack person to rate.",
  "42501": "Only the people in this recovery can rate it.",
};

/**
 * Why a safety feature is not in this build yet.
 *
 * One sentence per feature, so a reader is told WHICH thing is missing and
 * not merely that something went wrong. An unavailable feature and an empty
 * one are different facts and must never look the same.
 */
export const UNAVAILABLE_SENTENCES = {
  report: "Reporting is not available in this build yet — the server does not have the reporting function yet.",
  block: "Blocking is not available in this build yet — the server does not have the blocking function yet.",
  blockedList: "Your blocked accounts are not available in this build yet — the server does not have them yet.",
  feedback: "Sending feedback is not available in this build yet — the server does not have the feedback function yet.",
  myReports: "Your reports are not available in this build yet — the server does not have them yet.",
  queue: "The review queue is not available in this build yet — the server does not have it yet.",
} as const;
