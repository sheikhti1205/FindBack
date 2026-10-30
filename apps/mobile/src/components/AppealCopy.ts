import type { AppealReceipt, AppealSubject, ModerationAction } from "../services/moderation";
import { ApiError } from "../services/session";
import { friendlyError } from "../utils/friendlyErrors";
import { isMissingServerFunction } from "../utils/safetyService";

export function appealSubjectLabel(subject: Pick<AppealReceipt, "subjectKind">): string {
  return subject.subjectKind === "SANCTION" ? "Account decision" : "Content decision";
}
export function appealOutcome(receipt: AppealReceipt): string {
  if (receipt.status === "RESOLVED" && receipt.decision === "GRANTED" && receipt.changeApplied === false) return "Reviewed — no change";
  if (receipt.status === "RESOLVED") return { GRANTED: "Granted", DENIED: "Denied", EXPIRED: "Expired" }[receipt.decision!] ?? "Resolved";
  return receipt.status === "UNDER_REVIEW" ? "Being reviewed" : "Waiting for review";
}
export function adverseDecisionLabel(subject: AppealSubject): string {
  if (subject.targetType === "POST") return subject.action === "REMOVE" ? "Your report was removed" : "Your report was hidden";
  if (subject.targetType === "COMMENT") return subject.action === "REMOVE" ? "Your comment was removed" : "Your comment was hidden";
  const labels: Partial<Record<ModerationAction, string>> = { WARN: "Account warning", PROBATION: "Account probation", RESTRICT_POSTING: "Posting restricted", SUSPEND: "Account suspended", BAN: "Account banned" };
  return labels[subject.action] ?? "Account decision";
}
export function safetyReviewError(error: unknown, feature: "appeals" | "feedback"): string {
  if (isMissingServerFunction(error)) return `${feature === "appeals" ? "Appeals" : "Feedback review"} is not available right now. Try again later.`;
  if (error instanceof ApiError) {
    if (error.code === "APPEAL_ALREADY_OPEN") return "An appeal is already open for this decision. Refresh to see it.";
    if (error.code === "APPEAL_ALREADY_RESOLVED") return "This appeal has already been resolved. Refresh to see the outcome.";
    if (error.code === "APPEAL_EXPIRED") return "This appeal has expired. Refresh to see its status.";
    if (error.code === "FEEDBACK_CHANGED") return "This feedback changed during your review. Refresh before saving another decision.";
  }
  return friendlyError(error).message;
}
