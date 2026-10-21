import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { RESOLVED_STATUSES, type PostItem } from "@findback/shared";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { announce } from "../components/LiveRegion";
import { registerBackInterceptor } from "../components/backNavigation";
import { ErrorView } from "../components/uiPrimitives";
import {
  ReadOnlyField,
  ReportEditor,
  reportEditorIsDirty,
  reportEditorValuesFromPost,
  validateReportEditorValues,
  type ReportEditorErrors,
  type ReportEditorValues,
} from "../components/ReportEditor";
import {
  fetchPost,
  updatePost,
  type ClearablePostField,
  type UpdatePostInput,
} from "../services/posts";
import { friendlyError } from "../utils/friendlyErrors";

export interface EditReportProps {
  /**
   * The report to edit. Optional: when it is omitted the id is read from the
   * route (`/my/:id/edit`), which is how the app mounts this screen. A
   * caller that owns the route differently can pass the id explicitly.
   */
  postId?: string;
}

/**
 * What a user loses when they leave with unsaved edits.
 *
 * The repo's confirmation idiom is `window.confirm` (the same one the
 * create flow and the report detail use), so this screen uses it too rather
 * than inventing a parallel dialog.
 */
export const UNSAVED_CHANGES_MESSAGE =
  "You have unsaved changes to this report. Leave without saving them?";

/**
 * Build the update payload from the editor values and the baseline the
 * editor was hydrated with.
 *
 * The ONLY thing that decides a clear is the BASELINE: a field is emptied
 * because the owner emptied it, never because a value happens to be empty.
 * That is what makes the server's explicit clear request safe to send.
 */
export function buildUpdateInput(
  values: ReportEditorValues,
  baseline: ReportEditorValues,
): UpdatePostInput {
  const clearFields: ClearablePostField[] = [];
  const baselineLabel = (baseline.location.label ?? "").trim();
  const nextLabel = (values.location.label ?? "").trim();
  const hadCoords = baseline.location.latitude != null && baseline.location.longitude != null;
  const hasCoords = values.location.latitude != null && values.location.longitude != null;

  if (baselineLabel !== "" && nextLabel === "") clearFields.push("location_label");
  if (hadCoords && !hasCoords) clearFields.push("latitude", "longitude");

  return {
    type: values.type,
    title: values.title.trim(),
    description: values.description.trim(),
    category: values.category === "" ? undefined : values.category,
    eventDate: values.eventDate,
    latitude: values.location.latitude,
    longitude: values.location.longitude,
    locationLabel: nextLabel === "" ? null : nextLabel,
    clearFields,
  };
}

/**
 * Edit one of the caller's own reports.
 *
 * The screen owns three things and nothing else: the loaded report, the
 * editor's values, and the unsaved-changes guard. Everything else is the
 * canonical editor component, the canonical update path
 * (`findback_update_post_client`) and the canonical error copy
 * (`friendlyError`).
 *
 * What it refuses, and says so:
 *   * a report that is not the caller's — the server refuses it too, and the
 *     screen never pretends otherwise;
 *   * a report that is already resolved (recovered or closed) — its details
 *     are locked, and the screen says what unlocks them.
 *
 * The photos are shown read-only: the update RPC writes the report's
 * metadata only, so a photo cannot be added, removed or reordered here.
 */
export function EditReport({ postId }: EditReportProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const params = useParams();
  const id = postId ?? params.id ?? "";

  const [post, setPost] = useState<PostItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<ReportEditorValues | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReportEditorErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // The baseline the editor was hydrated with. It is a SNAPSHOT, so "dirty"
  // compares against what the server had, not against the live values.
  const baselineRef = useRef<ReportEditorValues | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!id) {
      setLoading(false);
      setLoadError("That report could not be found.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    void fetchPost(id)
      .then((loaded) => {
        if (cancelled) return;
        const hydrated = reportEditorValuesFromPost(loaded);
        baselineRef.current = hydrated;
        setPost(loaded);
        setValues(hydrated);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(friendlyError(err).message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const dirty = useMemo(
    () => (values && baselineRef.current ? reportEditorIsDirty(values, baselineRef.current) : false),
    [values],
  );
  dirtyRef.current = dirty;

  const askToLeave = useCallback((): boolean => {
    if (!dirtyRef.current) return true;
    return window.confirm(UNSAVED_CHANGES_MESSAGE);
  }, []);

  // The hardware/gesture back button goes through the app's own back
  // interceptor, so an unsaved edit is caught there too — not only by the
  // button in the header.
  useEffect(() => registerBackInterceptor(() => !askToLeave()), [askToLeave]);

  // Leaving the page entirely (tab close, app exit) asks as well.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const onChange = useCallback((patch: Partial<ReportEditorValues>) => {
    setValues((current) => (current ? { ...current, ...patch } : current));
    setFieldErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch) as Array<keyof ReportEditorValues>) {
        delete next[key];
      }
      return next;
    });
  }, []);

  const onSave = useCallback(async () => {
    if (!post || !values || !baselineRef.current) return;
    const errors = validateReportEditorValues(values);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      announce("Fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await updatePost(post.id, buildUpdateInput(values, baselineRef.current));
      setSaved(true);
      announce("Report updated.");
      navigate("/my");
    } catch (err) {
      // The server's own refusal is shown as it is. The edits stay on screen:
      // a failed save never discards what the owner typed.
      const friendly = friendlyError(err);
      setSaveError(friendly.message);
      announce(friendly.message);
    } finally {
      setSaving(false);
    }
  }, [post, values, navigate]);

  const leave = useCallback(() => {
    if (!askToLeave()) return;
    navigate("/my");
  }, [askToLeave, navigate]);

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-4 px-4 py-5" data-testid="edit-report-loading">
        <p className="text-sm text-on-surface-variant">Loading your report…</p>
      </div>
    );
  }

  if (loadError || !post || !values) {
    return (
      <div className="flex h-full flex-col gap-4 px-4 py-5">
        <ErrorView message={loadError ?? "That report could not be found."} onRetry={loadError ? () => window.location.reload() : undefined} />
        <Button type="button" variant="outline" size="md" onClick={() => navigate("/my")}>
          Back to My Reports
        </Button>
      </div>
    );
  }

  const isOwner = user?.id === post.userId;
  const isResolved = RESOLVED_STATUSES.includes(post.status);

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-5" data-testid="edit-report">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={leave}
          aria-label="Back to My Reports"
          className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs text-on-surface hover:bg-surface-container"
        >
          <ArrowLeft size={20} aria-hidden />
        </button>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Edit report</h1>
          <p className="text-sm text-on-surface-variant">
            {saved ? "Saved." : "Change the details of your report."}
          </p>
        </div>
      </header>

      {!isOwner && (
        <p role="alert" className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          This report isn&apos;t yours to edit.
        </p>
      )}

      {isOwner && isResolved && (
        <div role="status" className="rounded-m3-sm border border-outline-variant px-3 py-2 text-sm">
          <p className="font-medium">This report is {post.status === "RECOVERED" ? "recovered" : "closed"}.</p>
          <p className="mt-1 text-on-surface-variant">
            Its details are locked. Set it back to Open on My Reports to change them.
          </p>
        </div>
      )}

      {saveError && (
        <p role="alert" className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          {saveError}
        </p>
      )}

      {isOwner && !isResolved && (
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <ReportEditor
            values={values}
            onChange={onChange}
            errors={fieldErrors}
            photos={post.attachments}
            disabled={saving}
          />
          {post.youtubeUrl && <ReadOnlyField label="YouTube link (not editable here)" value={post.youtubeUrl} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="lg" loading={saving} disabled={!dirty}>
              {dirty ? "Save changes" : "No changes to save"}
            </Button>
            <Button type="button" variant="text" size="md" onClick={leave}>
              {dirty ? "Discard changes" : "Back to My Reports"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
