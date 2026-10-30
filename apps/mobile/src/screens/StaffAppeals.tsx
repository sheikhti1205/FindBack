import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { SelectField, TextAreaField } from "../components/Fields";
import { announce } from "../components/LiveRegion";
import { RequireCapability } from "../components/RequireCapability";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";
import { appealOutcome, appealSubjectLabel, safetyReviewError } from "../components/AppealCopy";
import { describeEvidence } from "../components/ModerationCaseSheet";
import { fetchStaffAppeal, listStaffAppeals, resolveAppeal, type AppealReceiptCursor, type AppealStatus } from "../services/moderation";
import { ApiError } from "../services/session";
import { formatSafetyDate, MODERATION_ACTION_LABELS, MODERATION_VISIBILITY_LABELS, REPORT_REASON_LABELS } from "../utils/safetyCopy";
import { useSafetyPages, useSafetyResource } from "../utils/useSafetyResource";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import "../components/AdminConsole.css";
import "../components/SafetyReview.css";

export function StaffAppeals() {
  const { user } = useAuth();
  return <RequireCapability capability="appeals_review"><AppealQueue key={user?.id} /></RequireCapability>;
}
function AppealQueue() {
  const [status, setStatus] = useState<AppealStatus | "">("");
  return <SettingsPage title="Appeals to review" backTo="/settings" description="Review appeals about account and content decisions.">
    <SelectField label="Appeal status" value={status} onChange={event => setStatus(event.target.value as AppealStatus | "")} options={[
      { value: "", label: "Waiting for review" }, { value: "SUBMITTED", label: "Submitted" }, { value: "UNDER_REVIEW", label: "Being reviewed" }, { value: "RESOLVED", label: "Resolved" },
    ]} />
    <AppealQueueRows key={status} status={status} />
  </SettingsPage>;
}
function AppealQueueRows({ status }: { status: AppealStatus | "" }) {
  const load = useCallback((before?: AppealReceiptCursor) => listStaffAppeals({ ...(status ? { status } : {}), ...(before ? { before } : {}) }), [status]);
  const page = useSafetyPages(load);
  return <SettingsGroup title={status === "RESOLVED" ? "Resolved appeals" : "Appeals"}>
    {page.error != null && <div role="alert" className="fb-safety-copy"><p>{safetyReviewError(page.error, "appeals")}</p><button className="fb-safety-read-action" onClick={() => void page.refresh()}>Retry appeals</button></div>}
    {page.items === null && !page.error && <p role="status" className="fb-safety-copy">Loading appeals…</p>}
    {page.items?.length === 0 && !page.error && !page.cursor && <p className="fb-safety-copy">No appeals are waiting in this view.</p>}
    <ol className="fb-admin-list">{page.items?.map(row => <li key={row.id}><SettingsRow title={appealSubjectLabel(row)} description={`${appealOutcome(row)} · ${formatSafetyDate(row.submittedAt)}`} route={`/settings/moderation/appeals/${encodeURIComponent(row.id)}`} /></li>)}</ol>
    {page.cursor && <button className="fb-safety-read-action" disabled={page.loading} onClick={() => void page.more()}>More appeals</button>}
  </SettingsGroup>;
}
export function StaffAppeal() {
  const { user } = useAuth();
  const { appealId } = useParams();
  return <RequireCapability capability="appeals_review"><AppealDetail key={`${user?.id}:${appealId}`} id={appealId ?? ""} /></RequireCapability>;
}
function AppealDetail({ id }: { id: string }) {
  const load = useCallback(() => fetchStaffAppeal(id), [id]);
  const resource = useSafetyResource(load);
  const alive = useSafetyLifetime();
  const pending = useRef(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const review = async (decision: "GRANTED" | "DENIED") => {
    if (pending.current || stale || !reason.trim() || resource.value?.status === "RESOLVED") return;
    pending.current = true; setSaving(true); setError(null); setNotice(null);
    try {
      await resolveAppeal(id, decision, reason.trim());
      if (!alive.current) return;
      setNotice("Review saved."); announce("Review saved."); setStale(true);
      await resource.refresh();
    } catch (err) {
      if (!alive.current) return;
      setError(err); setStale(true);
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) resource.clear();
    } finally { pending.current = false; if (alive.current) setSaving(false); }
  };
  const refresh = async () => { setError(null); const refreshed = await resource.refresh(); if (alive.current && refreshed) setStale(false); };
  const row = resource.value;
  const fault = error ?? resource.error;
  return <SettingsPage title="Review appeal" backTo="/settings/moderation/appeals" backLabel="Back to appeals">
    <div className="fb-safety-toolbar">
      <button className="fb-safety-read-action" disabled={saving || resource.loading} onClick={() => void refresh()}>Refresh appeal</button>
      {notice && <p role="status" className="fb-admin-note">{notice}</p>}
    </div>
    {fault != null && <p role="alert" className="fb-admin-error">{safetyReviewError(fault, "appeals")}</p>}
    {!row && !fault && <p role="status" className="fb-safety-copy">Loading appeal…</p>}
    {row && <>
      <SettingsGroup title={appealSubjectLabel(row)}>
        <div className="fb-safety-copy"><StatusPill tone={row.decision === "GRANTED" && row.changeApplied !== false ? "success" : "neutral"}>{appealOutcome(row)}</StatusPill>
          <p className="fb-admin-note">Sent {formatSafetyDate(row.submittedAt)}{row.resolvedAt && ` · Resolved ${formatSafetyDate(row.resolvedAt)}`}</p>
          {row.expiresAt && row.status !== "RESOLVED" && <p className="fb-admin-note">Review by {formatSafetyDate(row.expiresAt)}</p>}
        </div>
      </SettingsGroup>
      <SettingsGroup title="Appeal message"><p className="fb-safety-text fb-safety-copy">{row.message}</p></SettingsGroup>
      <SettingsGroup title="Original decision">
        {row.originalAction ? <dl className="fb-safety-facts">
          <div><dt>Action</dt><dd>{MODERATION_ACTION_LABELS[row.originalAction.action]}</dd></div>
          <div><dt>Reason</dt><dd>{REPORT_REASON_LABELS[row.originalAction.reason as keyof typeof REPORT_REASON_LABELS] ?? "Staff review"}</dd></div>
          <div><dt>Decided</dt><dd>{formatSafetyDate(row.originalAction.createdAt)}</dd></div>
          {row.originalAction.nextVisibility && <div><dt>Content visibility</dt><dd>{MODERATION_VISIBILITY_LABELS[row.originalAction.nextVisibility]}</dd></div>}
          {row.originalAction.sanctionEndsAt && <div><dt>Restriction ends</dt><dd>{formatSafetyDate(row.originalAction.sanctionEndsAt)}</dd></div>}
        </dl> : <p className="fb-safety-copy">The original decision details are no longer available.</p>}
      </SettingsGroup>
      <SettingsGroup title="Saved evidence" description="The context captured when the content was reported.">
        {row.evidence.length === 0 && <p className="fb-safety-copy">No saved evidence is attached to this decision.</p>}
        {row.evidence.map(item => <div key={item.id} className="fb-safety-evidence fb-safety-copy">
          <p className="fb-admin-note">{REPORT_REASON_LABELS[item.reason]} · {formatSafetyDate(item.capturedAt)}</p>
          {item.snapshot === null ? <p className="fb-admin-note">The saved evidence is no longer available.</p> : <dl className="fb-safety-facts">{describeEvidence(item.snapshot).map(line => <div key={line.label}><dt>{line.label}</dt><dd className="fb-safety-text">{line.value}</dd></div>)}</dl>}
        </div>)}
      </SettingsGroup>
      {row.status === "RESOLVED" ? row.reviewerNote && <SettingsGroup title="Review reason"><p className="fb-safety-text fb-safety-copy">{row.reviewerNote}</p></SettingsGroup> : <SettingsGroup title="Your decision" description="Grant reverses the original action only where it is still applicable. Later decisions and deleted content are not overwritten.">
        <div className="fb-safety-form"><TextAreaField label="Review reason" value={reason} maxLength={2000} disabled={saving} onChange={event => setReason(event.target.value)} hint="Required. This staff note is not shown in the consumer receipt." />
          <div className="fb-admin-actions"><Button disabled={!reason.trim() || stale || resource.loading || saving} onClick={() => void review("GRANTED")}>Grant appeal</Button><Button variant="outline" disabled={!reason.trim() || stale || resource.loading || saving} onClick={() => void review("DENIED")}>Deny appeal</Button></div>
          {saving && <p role="status" className="fb-admin-note">Saving review…</p>}
        </div>
      </SettingsGroup>}
    </>}
  </SettingsPage>;
}
