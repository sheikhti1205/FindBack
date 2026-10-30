import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { SelectField, TextAreaField } from "../components/Fields";
import { announce } from "../components/LiveRegion";
import { RequireCapability } from "../components/RequireCapability";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";
import { safetyReviewError } from "../components/AppealCopy";
import { FEEDBACK_CATEGORY_LABELS, fetchStaffFeedback, listStaffFeedback, reviewFeedback, type FeedbackStatus, type FeedbackCursor } from "../services/feedback";
import { ApiError } from "../services/session";
import { formatSafetyDate } from "../utils/safetyCopy";
import { useSafetyPages, useSafetyResource } from "../utils/useSafetyResource";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import "../components/AdminConsole.css";
import "../components/SafetyReview.css";

const STAFF_STATUS = { NEW: "New", REVIEWING: "Being reviewed", RESOLVED: "Resolved" };
export function StaffFeedback() {
  const { user } = useAuth();
  return <RequireCapability capability="feedback_read"><FeedbackQueue key={user?.id} /></RequireCapability>;
}
function FeedbackQueue() {
  const [status, setStatus] = useState<FeedbackStatus | "">("");
  return <SettingsPage title="Feedback to review" backTo="/settings" description="Read feedback and keep its review status up to date.">
    <SelectField label="Feedback status" value={status} onChange={event => setStatus(event.target.value as FeedbackStatus | "")} options={[
      { value: "", label: "Waiting for review" }, ...(["NEW", "REVIEWING", "RESOLVED"] as const).map(value => ({ value, label: STAFF_STATUS[value] })),
    ]} /><FeedbackQueueRows key={status} status={status} />
  </SettingsPage>;
}
function FeedbackQueueRows({ status }: { status: FeedbackStatus | "" }) {
  const load = useCallback((before?: FeedbackCursor) => listStaffFeedback({ ...(status ? { status } : {}), ...(before ? { before } : {}) }), [status]);
  const page = useSafetyPages(load);
  return <SettingsGroup title="Feedback">
    {page.error != null && <div role="alert" className="fb-safety-copy"><p>{safetyReviewError(page.error, "feedback")}</p><button className="fb-safety-read-action" onClick={() => void page.refresh()}>Retry feedback</button></div>}
    {page.items === null && !page.error && <p role="status" className="fb-safety-copy">Loading feedback…</p>}
    {page.items?.length === 0 && !page.error && !page.cursor && <p className="fb-safety-copy">No feedback is waiting for review.</p>}
    <ol className="fb-admin-list">{page.items?.map(row => <li key={row.id}><SettingsRow title={FEEDBACK_CATEGORY_LABELS[row.category]} description={`${STAFF_STATUS[row.status]} · ${formatSafetyDate(row.createdAt)}`} route={`/settings/moderation/feedback/${encodeURIComponent(row.id)}`} /></li>)}</ol>
    {page.cursor && <button className="fb-safety-read-action" disabled={page.loading} onClick={() => void page.more()}>More feedback</button>}
  </SettingsGroup>;
}
export function StaffFeedbackDetail() {
  const { user } = useAuth(); const { feedbackId } = useParams();
  return <RequireCapability capability="feedback_read"><FeedbackDetail key={`${user?.id}:${feedbackId}`} id={feedbackId ?? ""} /></RequireCapability>;
}
function FeedbackDetail({ id }: { id: string }) {
  const load = useCallback(() => fetchStaffFeedback(id), [id]);
  const resource = useSafetyResource(load);
  const alive = useSafetyLifetime(); const pending = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false); const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); const [error, setError] = useState<unknown>(null);
  const row = resource.value;
  const review = async (status: FeedbackStatus) => {
    if (pending.current || !row || stale) return;
    pending.current = true; setSaving(true); setError(null); setNotice(null);
    try {
      await reviewFeedback(id, status, row.status, (note ?? row.adminNote ?? "").trim());
      if (!alive.current) return;
      setNotice("Review saved."); announce("Review saved."); setStale(true);
      const refreshed = await resource.refresh();
      if (alive.current && refreshed) { setStale(false); setNote(null); }
    } catch (err) {
      if (!alive.current) return;
      setError(err); setStale(true);
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) resource.clear();
    } finally { pending.current = false; if (alive.current) setSaving(false); }
  };
  const refresh = async () => { setError(null); const refreshed = await resource.refresh(); if (alive.current && refreshed) { setStale(false); setNote(null); } };
  const fault = error ?? resource.error;
  const disabled = saving || stale || resource.loading;
  return <SettingsPage title="Review feedback" backTo="/settings/moderation/feedback" backLabel="Back to feedback">
    <div className="fb-safety-toolbar"><button className="fb-safety-read-action" disabled={saving || resource.loading} onClick={() => void refresh()}>Refresh feedback</button>{notice && <p role="status" className="fb-admin-note">{notice}</p>}</div>
    {fault != null && <p role="alert" className="fb-admin-error">{safetyReviewError(fault, "feedback")}</p>}
    {!row && !fault && <p role="status" className="fb-safety-copy">Loading feedback…</p>}
    {row && <>
      <SettingsGroup title={FEEDBACK_CATEGORY_LABELS[row.category]}><div className="fb-safety-copy"><StatusPill tone={row.status === "RESOLVED" ? "success" : "neutral"}>{STAFF_STATUS[row.status]}</StatusPill><p className="fb-admin-note">Sent {formatSafetyDate(row.createdAt)} · Updated {formatSafetyDate(row.updatedAt)}</p></div></SettingsGroup>
      <SettingsGroup title="Message"><p className="fb-safety-copy fb-safety-text">{row.message}</p></SettingsGroup>
      <SettingsGroup title="Technical details">
        {row.technicalContext ? <dl className="fb-safety-facts">{([
          ["app_version", "App version"], ["platform", "Platform"], ["screen", "Screen"], ["device_class", "Device type"],
        ] as const).map(([key, label]) => row.technicalContext?.[key] ? <div key={key}><dt>{label}</dt><dd>{row.technicalContext[key]}</dd></div> : null)}</dl> : <p className="fb-safety-copy">No technical details were included.</p>}
      </SettingsGroup>
      <SettingsGroup title="Review status"><div className="fb-safety-form">
        <TextAreaField label="Staff note (optional)" value={note ?? row.adminNote ?? ""} maxLength={2000} disabled={saving} onChange={event => setNote(event.target.value)} hint="Kept with the feedback, not shown in its consumer receipt." />
        <div className="fb-admin-actions">
          {row.status !== "REVIEWING" && <Button variant="outline" disabled={disabled} onClick={() => void review("REVIEWING")}>{row.status === "RESOLVED" ? "Reopen review" : "Start review"}</Button>}
          {row.status !== "RESOLVED" && <Button disabled={disabled} onClick={() => void review("RESOLVED")}>Mark resolved</Button>}
        </div>{saving && <p role="status" className="fb-admin-note">Saving review…</p>}
      </div></SettingsGroup>
    </>}
  </SettingsPage>;
}
