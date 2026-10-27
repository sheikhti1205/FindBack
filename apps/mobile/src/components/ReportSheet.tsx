import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";
import { TextAreaField } from "./Fields";
import { PreferenceRadioRow } from "./settings";
import { announce } from "./LiveRegion";
import { friendlyError } from "../utils/friendlyErrors";
import {
  REPORT_REASONS,
  submitReport,
  type ReportReason,
  type ReportTargetType,
} from "../services/moderation";
import {
  REPORT_REASON_HINTS,
  REPORT_REASON_LABELS,
  REPORT_TARGET_SUBJECTS,
  UNAVAILABLE_SENTENCES,
} from "../utils/safetyCopy";
import { isMissingServerFunction } from "../utils/safetyService";

/** What is being reported. One shape for all three kinds. */
export type ReportTarget = { targetId: string } & (
  | { targetType: Exclude<ReportTargetType, "MESSAGE"> }
  | { targetType: "MESSAGE"; accountId: string; body: string }
);

export interface ReportSheetProps {
  open: boolean;
  onClose: () => void;
  /** The thing being reported. Null while the sheet is closed. */
  target: ReportTarget | null;
  /** Called once the server has confirmed the report. */
  onReported?: (reportId: string) => void;
}

/** The server's own bound on the note. The client refuses longer, never truncates. */
const DETAIL_MAX = 2000;

/**
 * ONE report sheet for a post, a comment and a person.
 *
 * There is no "report a post" sheet, no "report a comment" sheet and no
 * "report a user" sheet: they are three doors into the same room, and a
 * reader who reports a comment and a reader who reports a person fill in the
 * same form for the same reasons. The three kinds differ only in the target
 * and the sentence that names it.
 *
 * THE VOCABULARY IS CLOSED. The seven reasons are the server's (MC D2) and
 * they are the only ones offered — no free text reason, no "other" that
 * swallows the six real ones. The note is optional and bounded; it is the
 * detail, not the reason.
 *
 * THE RECEIPT IS HONEST. A success is only shown after the server confirmed
 * the report; a refusal is shown as a sentence and the form stays open with
 * the reader's answer still in it. The reader's own reports and their status
 * live on their own screen (Settings → Privacy → Reports you sent) — this
 * sheet never pretends to be a case tracker.
 */
export function ReportSheet({ open, onClose, target, onReported }: ReportSheetProps) {
  const { user } = useAuth();
  const alive = useSafetyLifetime();
  const generation = useRef(0);
  const requestScope = useRef<AbortController | null>(null);
  const [reason, setReason] = useState<ReportReason | "">("");
  const [detail, setDetail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const groupName = useId();

  // Invalidate requests at the committed account/target/open boundary, before
  // paint. Keep the canonical sheet mounted so its exit motion is preserved.
  useLayoutEffect(() => {
    generation.current += 1;
    const controller = new AbortController();
    requestScope.current = controller;
    if (open) {
      setReason("");
      setDetail("");
      setError(null);
      setSent(false);
      setSending(false);
    }
    return () => { controller.abort(); generation.current += 1; };
  }, [open, target?.targetType, target?.targetId, user?.id]);

  if (!target) return null;

  const subject = REPORT_TARGET_SUBJECTS[target.targetType];

  const send = async (): Promise<void> => {
    if (sending) return;
    const requestGeneration = generation.current;
    const isCurrent = () => alive.current && generation.current === requestGeneration;
    if (reason === "") {
      setError("Choose what is wrong so we know where to look.");
      announce("Choose what is wrong so we know where to look.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { reportId } = await submitReport({
        ...target,
        reason,
        detail: detail.trim() === "" ? null : detail.trim(),
      }, requestScope.current?.signal);
      if (!isCurrent()) return;
      setSent(true);
      announce("Report sent.");
      onReported?.(reportId);
    } catch (err) {
      if (!isCurrent()) return;
      const message = reportFailure(err);
      setError(message);
      announce(message);
    } finally {
      if (isCurrent()) setSending(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Report a problem"
      description={`Tell us what is wrong with ${subject}.`}
      height="large"
    >
      {sent ? (
        <div className="flex flex-col gap-3 py-2" data-testid="report-receipt">
          <p role="status" className="text-base font-semibold text-on-surface">
            Report sent.
          </p>
          <p className="text-sm text-on-surface-variant">
            We have logged your report about {subject}. You can follow what happens to it in
            Settings → Privacy.
          </p>
          <Button variant="outline" onClick={onClose} className="self-start">
            Done
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 py-2">
          <fieldset className="fb-choice-fieldset flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-on-surface">What is wrong?</legend>
            <div className="fb-choice-list flex flex-col">
              {REPORT_REASONS.map((value) => (
                <PreferenceRadioRow
                  key={value}
                  name={groupName}
                  value={value}
                  title={REPORT_REASON_LABELS[value]}
                  description={REPORT_REASON_HINTS[value]}
                  checked={reason === value}
                  onChange={() => {
                    setReason(value);
                    setError(null);
                  }}
                />
              ))}
            </div>
          </fieldset>

          <TextAreaField
            label="Anything else we should know? (optional)"
            hint={`Up to ${DETAIL_MAX} characters.`}
            value={detail}
            maxLength={DETAIL_MAX}
            onChange={(event) => setDetail(event.target.value)}
          />

          {error ? (
            <p role="alert" data-testid="report-error" className="text-sm text-error">
              {error}
            </p>
          ) : null}

          <Button onClick={() => void send()} loading={sending} disabled={sent}>
            Send report
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}

/**
 * The server's refusal, in a sentence a reader can act on.
 *
 * The report limit has its own sentence (the server names the refusal
 * `REPORT_LIMIT_REACHED`), and an unavailable target gets the same neutral
 * wording whatever the server's reason was, so a hidden, a deleted and a
 * never-existed item all read identically.
 *
 * A server that has not got the reporting function at all is a different
 * fact again, and it says so: the feature is not in this build, rather than
 * "something went wrong".
 */
function reportFailure(err: unknown): string {
  if (isMissingServerFunction(err)) {
    return UNAVAILABLE_SENTENCES.report;
  }
  const code = err instanceof Error && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  if (code === "REPORT_LIMIT_REACHED") {
    return "You have sent a lot of reports today. Please try again tomorrow.";
  }
  const friendly = friendlyError(err);
  if (friendly.code === "NOT_FOUND") {
    return "That item is no longer available to report.";
  }
  return friendly.message;
}
