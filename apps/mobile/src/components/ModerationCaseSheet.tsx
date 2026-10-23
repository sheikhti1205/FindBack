import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";
import { SelectField, TextAreaField, TextField } from "./Fields";
import { announce } from "./LiveRegion";
import { friendlyError } from "../utils/friendlyErrors";
import {
  ACTION_CAPABILITIES,
  ACTION_SANCTION_KINDS,
  MODERATION_ACTIONS,
  REPORT_REASONS,
  applyModeration,
  fetchModerationTarget,
  type ModerationAction,
  type ModerationQueueEntry,
  type ModerationTarget,
  type ReportReason,
  type ReportTargetType,
} from "../services/moderation";
import {
  MODERATION_ACTION_HINTS,
  MODERATION_ACTION_LABELS,
  MODERATION_VISIBILITY_LABELS,
  REPORT_REASON_LABELS,
  REPORT_TARGET_LABELS,
  UNAVAILABLE_SENTENCES,
  formatSafetyDate,
} from "../utils/safetyCopy";
import { isMissingServerFunction } from "../utils/safetyService";

/** One readable line about the target. */
export interface TargetLine {
  label: string;
  value: string;
}

/**
 * The target, in words — never in ids.
 *
 * The server returns the live row (MC D5's bounded shape), which contains the
 * target's id and its author's id. Those are never rendered: a moderator
 * reads the CONTENT, and the ids are what the console already uses to act.
 * Every field below is picked by name from a fixed list, so a field the
 * server adds later is ignored rather than dumped.
 */
export function describeTarget(
  targetType: ReportTargetType,
  row: Record<string, unknown> | null,
): TargetLine[] {
  if (!row) return [];
  const read = (key: string): string | null => {
    const value = row[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const lines: TargetLine[] = [];
  const push = (label: string, value: string | null): void => {
    if (value) lines.push({ label, value });
  };

  if (targetType === "POST") {
    push("Title", read("title"));
    push("Details", read("description_excerpt"));
    push("Kind", read("type") === "FOUND" ? "Found item" : read("type") === "LOST" ? "Lost item" : null);
    push("Report status", read("status"));
    const visibility = read("moderation_visibility");
    push(
      "Visibility",
      visibility && visibility in MODERATION_VISIBILITY_LABELS
        ? MODERATION_VISIBILITY_LABELS[visibility as keyof typeof MODERATION_VISIBILITY_LABELS]
        : null,
    );
    push("Posted", formatSafetyDate(read("created_at")) || null);
    return lines;
  }

  if (targetType === "COMMENT") {
    push("Comment", read("body_excerpt"));
    push("Posted", formatSafetyDate(read("created_at")) || null);
    return lines;
  }

  push("Name", read("display_name"));
  push("Username", read("username"));
  push("Joined", formatSafetyDate(read("created_at")) || null);
  return lines;
}

/**
 * The evidence snapshot, in words.
 *
 * The snapshot is what the report was about, captured when the report was
 * filed (MC D5), so an author editing the content afterwards cannot erase
 * it. It is bounded to a few hundred characters and it expires: after 90
 * days the server stops serving it (MC §13.11), and a case whose snapshot has
 * expired says so rather than showing an empty box.
 */
export function describeEvidence(evidence: Record<string, unknown> | null): TargetLine[] {
  if (!evidence) return [];
  const read = (key: string): string | null => {
    const value = evidence[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const lines: TargetLine[] = [];
  const push = (label: string, value: string | null): void => {
    if (value) lines.push({ label, value });
  };
  push("Title", read("title"));
  push("Details", read("description_excerpt"));
  push("Comment", read("body_excerpt"));
  push("Name", read("display_name"));
  push("Username", read("username"));
  return lines;
}

export interface ModerationCaseSheetProps {
  open: boolean;
  /** The queue row being reviewed. Null while the sheet is closed. */
  entry: ModerationQueueEntry | null;
  /** The capabilities the signed-in account holds. */
  capabilities: readonly string[];
  /** True for an admin, who holds every capability. */
  isAdmin: boolean;
  onClose: () => void;
  /** Called after the server confirmed an action. */
  onApplied: () => void;
}

/**
 * One case: the target, the reports about it, what has already been done,
 * and the one action a moderator may take.
 *
 * THE SERVER IS THE AUTHORITY FOR EVERY ACTION. The client hides an action
 * the account's permissions do not cover — a moderator with `content_hide`
 * may hide but is not offered a suspension — but the hiding is a courtesy:
 * `findback_apply_moderation` re-checks the permission on every call and
 * refuses with 42501. A refusal is shown as a sentence.
 *
 * THE ACTION LIST IS CLOSED. The nine actions are the server's nine (MC
 * D39), and the reason code is one of the server's seven report reasons.
 */
export function ModerationCaseSheet({
  open,
  entry,
  capabilities,
  isAdmin,
  onClose,
  onApplied,
}: ModerationCaseSheetProps) {
  const { user } = useAuth();
  const generation = useRef(0);
  const readRequest = useRef(0);
  const targetType = entry?.targetType;
  const targetId = entry?.targetId;
  const [target, setTarget] = useState<ModerationTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ModerationAction | "">("");
  const [reasonCode, setReasonCode] = useState<ReportReason | "">("");
  const [note, setNote] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [applying, setApplying] = useState(false);

  const allowedActions = MODERATION_ACTIONS.filter((value) => {
    const capability = ACTION_CAPABILITIES[value];
    return isAdmin || capabilities.includes(capability);
  });

  const load = useCallback(async () => {
    if (!open || !user?.id || !targetType || !targetId) return;
    const version = generation.current;
    const request = ++readRequest.current;
    const isCurrent = () => generation.current === version && readRequest.current === request;
    setLoading(true);
    setError(null);
    setTarget(null);
    try {
      const result = await fetchModerationTarget(targetType, targetId);
      if (!isCurrent()) return;
      if (result.targetType !== targetType || result.targetId !== targetId) {
        throw new Error("The server did not return this case.");
      }
      setTarget(result);
    } catch (err) {
      if (!isCurrent()) return;
      setTarget(null);
      setError(isMissingServerFunction(err) ? UNAVAILABLE_SENTENCES.queue : friendlyError(err).message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [open, user?.id, targetType, targetId]);

  // Account/case/open boundaries invalidate reads AND mutation callbacks before
  // paint. Keep the shared sheet mounted so its exit animation still runs.
  useLayoutEffect(() => {
    generation.current += 1;
    setTarget(null);
    setAction("");
    setReasonCode("");
    setNote("");
    setEndsAt("");
    setError(null);
    setLoading(false);
    setApplying(false);
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  if (!entry) return null;

  const targetLines = describeTarget(entry.targetType, target?.target ?? null);
  const sanctionKind = action === "" ? null : ACTION_SANCTION_KINDS[action] ?? null;

  const apply = async (): Promise<void> => {
    if (applying || loading || !target || !open || !user) return;
    const version = generation.current;
    const isCurrent = () => generation.current === version;
    if (action === "") {
      setError("Choose what to do.");
      announce("Choose what to do.");
      return;
    }
    if (reasonCode === "") {
      setError("Choose the reason for this action.");
      announce("Choose the reason for this action.");
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await applyModeration({
        targetType: entry.targetType,
        targetId: entry.targetId,
        action,
        reasonCode,
        note: note.trim() === "" ? null : note.trim(),
        sanctionKind,
        sanctionEndsAt: endsAt === "" ? null : new Date(`${endsAt}T00:00:00Z`).toISOString(),
      });
      if (!isCurrent()) return;
      const outcome = "Action recorded.";
      announce(outcome);
      onApplied();
    } catch (err) {
      if (!isCurrent()) return;
      const sentence = err instanceof Error && err.message === "MODERATION_DECISION_FINAL"
        ? "Another moderator already decided this case. Only that moderator can change it, unless the author asks for re-evaluation."
        : isMissingServerFunction(err)
          ? UNAVAILABLE_SENTENCES.queue
          : friendlyError(err).message;
      setError(sentence);
      announce(sentence);
    } finally {
      if (isCurrent()) setApplying(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Review this case" height="full">
      <div className="flex flex-col gap-4 py-2">
        <p className="text-sm text-on-surface-variant">
          {entry.reportCount === 1 ? "1 report" : `${entry.reportCount} reports`} about a{" "}
          {REPORT_TARGET_LABELS[entry.targetType]}. First reported {formatSafetyDate(entry.firstReportedAt)}.
        </p>

        {loading ? (
          <p role="status" className="fb-admin-note">
            Loading the case…
          </p>
        ) : null}

        {error ? (
          <p role="alert" data-testid="moderation-case-error" className="fb-admin-error">
            {error}
          </p>
        ) : null}

        {target && !target.targetExists ? (
          <p role="status" data-testid="moderation-case-missing" className="fb-admin-note">
            The thing that was reported no longer exists. You can still close the report.
          </p>
        ) : null}

        {target?.reopen ? (
          <section
            aria-label="Re-evaluation requested"
            data-testid="moderation-case-reopen"
            className="flex flex-col gap-1 rounded-m3-sm border border-outline-variant bg-surface-container p-3"
          >
            <h3 className="text-sm font-semibold text-on-surface">
              The author asked for re-evaluation
            </h3>
            <p className="fb-admin-log-detail">{target.reopen.message}</p>
            <p className="text-xs text-on-surface-variant">
              Asked {formatSafetyDate(target.reopen.submittedAt)}. Deciding it now starts a new
              decision.
            </p>
          </section>
        ) : null}

        {target?.decision ? (
          <p className="fb-admin-log-detail" data-testid="moderation-case-decision">
            Current decision: {MODERATION_ACTION_LABELS[target.decision.action]} · round{" "}
            {target.decision.generation}
          </p>
        ) : null}

        {targetLines.length > 0 ? (
          <section aria-label="What was reported" className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-on-surface">What was reported</h3>
            {targetLines.map((line) => (
              <p key={line.label} className="fb-admin-log-detail">
                <span className="font-medium text-on-surface">{line.label}:</span> {line.value}
              </p>
            ))}
          </section>
        ) : null}

        {target && target.reports.length > 0 ? (
          <section aria-label="The reports" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-on-surface">The reports</h3>
            {target.reports.map((report) => {
              const evidence = describeEvidence(report.evidence);
              return (
                <div key={report.id} className="fb-admin-log-row">
                  <p className="fb-admin-log-headline">{REPORT_REASON_LABELS[report.reason]}</p>
                  <p className="fb-admin-log-detail">Reported {formatSafetyDate(report.createdAt)}</p>
                  {report.detail ? (
                    <p className="fb-admin-log-detail">The reporter wrote: “{report.detail}”</p>
                  ) : null}
                  {report.evidence === null ? (
                    <p className="fb-admin-log-detail">
                      The saved snapshot is no longer available — it expires after 90 days.
                    </p>
                  ) : evidence.length > 0 ? (
                    evidence.map((line) => (
                      <p key={line.label} className="fb-admin-log-detail">
                        <span className="font-medium text-on-surface">{line.label}:</span> {line.value}
                      </p>
                    ))
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        {target && target.decisions.length > 0 ? (
          <section aria-label="What has been done" className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-on-surface">What has been done</h3>
            {target.decisions.map((decision) => (
              <p key={`${decision.action}-${decision.createdAt}`} className="fb-admin-log-detail">
                {MODERATION_ACTION_LABELS[decision.action]} — {REPORT_REASON_LABELS[decision.reason]} ·{" "}
                {formatSafetyDate(decision.createdAt)}
              </p>
            ))}
          </section>
        ) : null}

        <section aria-label="Take action" className="fb-admin-form">
          <h3 className="text-sm font-semibold text-on-surface">Take action</h3>
          {allowedActions.length === 0 ? (
            <p className="fb-admin-note">
              Your permissions do not allow any action on this case. An admin can act on it.
            </p>
          ) : (
            <>
              <SelectField
                label="What to do"
                value={action}
                placeholder="Choose an action"
                options={allowedActions.map((value) => ({
                  value,
                  label: `${MODERATION_ACTION_LABELS[value]} — ${MODERATION_ACTION_HINTS[value]}`,
                }))}
                onChange={(event) => {
                  setAction(event.target.value as ModerationAction | "");
                  setError(null);
                }}
              />
              <SelectField
                label="Reason"
                value={reasonCode}
                placeholder="Choose a reason"
                options={REPORT_REASONS.map((value) => ({ value, label: REPORT_REASON_LABELS[value] }))}
                onChange={(event) => {
                  setReasonCode(event.target.value as ReportReason | "");
                  setError(null);
                }}
              />
              {sanctionKind ? (
                <TextField
                  label="Ends on (optional)"
                  type="date"
                  value={endsAt}
                  onChange={(event) => setEndsAt(event.target.value)}
                />
              ) : null}
              <TextAreaField
                label="Note for the record (optional)"
                value={note}
                maxLength={2000}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button onClick={() => void apply()} loading={applying}>
                Apply
              </Button>
            </>
          )}
        </section>
      </div>
    </BottomSheet>
  );
}
