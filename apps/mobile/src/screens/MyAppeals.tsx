import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextAreaField } from "../components/Fields";
import { announce } from "../components/LiveRegion";
import { SettingsGroup, SettingsPage, StatusPill } from "../components/settings";
import { adverseDecisionLabel, appealOutcome, appealSubjectLabel, safetyReviewError } from "../components/AppealCopy";
import { listMyAppeals, listMyAppealSubjects, submitAppeal, type AppealSubject, type AppealReceiptCursor, type AppealSubjectCursor } from "../services/moderation";
import { REPORT_REASON_LABELS, formatSafetyDate } from "../utils/safetyCopy";
import { useSafetyPages } from "../utils/useSafetyResource";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import "../components/AdminConsole.css";
import "../components/SafetyReview.css";

export function MyAppeals() {
  const { user } = useAuth();
  return user ? <ScopedAppeals key={user.id} /> : null;
}
function ScopedAppeals() {
  const loadMine = useCallback((before?: AppealReceiptCursor) => listMyAppeals(before ? { before } : {}), []);
  const loadSubjects = useCallback((before?: AppealSubjectCursor) => listMyAppealSubjects(before ? { before } : {}), []);
  const mine = useSafetyPages(loadMine);
  const subjects = useSafetyPages(loadSubjects);
  const alive = useSafetyLifetime();
  const [selected, setSelected] = useState<AppealSubject | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const cancel = () => { setSelected(null); origin.current?.focus(); };
  return <SettingsPage title="Your appeals" backTo="/settings/privacy" backLabel="Back to Privacy" description="Ask us to review a decision affecting your account or content.">
    {notice && <p role="status" className="fb-admin-note">{notice}</p>}
    <SettingsGroup title="Decisions you can appeal">
      {subjects.error ? <div className="fb-safety-copy" role="alert"><p>{safetyReviewError(subjects.error, "appeals")}</p><button className="fb-safety-read-action" onClick={() => void subjects.refresh()}>Retry decisions</button></div> : null}
      {subjects.items === null && !subjects.error && <p role="status" className="fb-safety-copy">Loading decisions…</p>}
      {subjects.items?.length === 0 && !subjects.error && !subjects.cursor && <p className="fb-safety-copy">There are no decisions to appeal right now.</p>}
      <ol className="fb-admin-list">{subjects.items?.map(subject => <li key={`${subject.subjectKind}:${subject.subjectId}`} className="fb-admin-log-row">
        <h3 className="fb-admin-log-headline">{adverseDecisionLabel(subject)}</h3>
        <p className="fb-admin-log-detail">{REPORT_REASON_LABELS[subject.reason]} · {formatSafetyDate(subject.createdAt)}</p>
        {subject.openAppealId ? <p className="fb-admin-note">An appeal is already open for this decision.</p> : <button className="fb-safety-read-action" type="button" onClick={event => { origin.current = event.currentTarget; setNotice(null); setSelected(subject); }}>Appeal this decision</button>}
      </li>)}</ol>
      {subjects.cursor && <button className="fb-safety-read-action" disabled={subjects.loading} onClick={() => void subjects.more()}>More decisions</button>}
    </SettingsGroup>
    {selected && <AppealComposer key={`${selected.subjectKind}:${selected.subjectId}`} subject={selected} cancel={cancel} sent={async () => {
      if (!alive.current) return;
      setSelected(null); setNotice("Your appeal was sent."); announce("Your appeal was sent."); origin.current?.focus();
      await Promise.all([mine.refresh(), subjects.refresh()]);
    }} />}
    <SettingsGroup title="Appeals you sent" description="Outcomes stay here even if the original content is no longer available.">
      {mine.error ? <div role="alert" data-testid="appeal-history-error" className="fb-safety-copy"><p>{safetyReviewError(mine.error, "appeals")}</p><button className="fb-safety-read-action" onClick={() => void mine.refresh()}>Retry appeals</button></div> : null}
      {mine.items === null && !mine.error && <p role="status" className="fb-safety-copy">Loading appeals…</p>}
      {mine.items?.length === 0 && !mine.error && !mine.cursor && <p className="fb-safety-copy">You haven’t sent an appeal yet.</p>}
      <ol className="fb-admin-list">{mine.items?.map(receipt => <li key={receipt.id} className="fb-admin-log-row">
        <p className="fb-admin-log-headline">{appealSubjectLabel(receipt)}</p>
        <p className="fb-admin-log-detail">Sent {formatSafetyDate(receipt.submittedAt)}{receipt.resolvedAt && ` · Resolved ${formatSafetyDate(receipt.resolvedAt)}`}</p>
        <StatusPill tone={receipt.decision === "GRANTED" && receipt.changeApplied !== false ? "success" : "neutral"}>{appealOutcome(receipt)}</StatusPill>
      </li>)}</ol>
      {mine.cursor && <button className="fb-safety-read-action" disabled={mine.loading} onClick={() => void mine.more()}>More appeals</button>}
    </SettingsGroup>
  </SettingsPage>;
}
function AppealComposer({ subject, cancel, sent }: { subject: AppealSubject; cancel: () => void; sent: () => Promise<void> }) {
  const alive = useSafetyLifetime();
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { form.current?.querySelector("textarea")?.focus(); }, []);
  const send = async () => {
    if (pending.current || !message.trim()) return;
    pending.current = true; setSending(true); setError(null);
    try {
      await submitAppeal(subject.subjectKind, subject.subjectId, message.trim());
      if (alive.current) await sent();
    } catch (err) { if (alive.current) setError(safetyReviewError(err, "appeals")); }
    finally { pending.current = false; if (alive.current) setSending(false); }
  };
  return <SettingsGroup title={adverseDecisionLabel(subject)} description="Explain what we should consider. Sending an appeal does not change the decision until it is reviewed.">
    <form ref={form} className="fb-safety-form" onSubmit={event => { event.preventDefault(); void send(); }}>
      <TextAreaField label="Why should we review this?" value={message} maxLength={2000} disabled={sending} onChange={event => setMessage(event.target.value)} hint={`${message.length}/2000 characters`} />
      {error && <p role="alert" className="fb-admin-error">{error}</p>}
      <div className="fb-admin-actions"><Button type="submit" disabled={!message.trim()} loading={sending}>Send appeal</Button><button type="button" className="fb-safety-read-action" disabled={sending} onClick={cancel}>Cancel</button></div>
    </form>
  </SettingsGroup>;
}
