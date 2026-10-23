import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate, useParams, type BlockerFunction } from "react-router";
import { RESOLVED_STATUSES, type PostItem } from "@findback/shared";
import { ArrowLeft } from "lucide-react";
import { useIsPresent } from "framer-motion";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { announce } from "../components/LiveRegion";
import { ErrorView } from "../components/uiPrimitives";
import {
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
 * Compare the baseline and the draft: an already-empty field is not a
 * removal, and a coordinate still present in the draft must never also be
 * named in the clear request.
 *
 * THE MAP PIN IS NOT A CLEAR ON A TEXT EDIT. The picker cannot turn free
 * text into coordinates, so retyping the place name arrives with no
 * coordinates at all. A report that already carries a published pin must not
 * lose it because the owner changed the wording: the pin goes only when the
 * owner CLEARS the place, which removes the name and the pin together.
 *
 * Clearing a previously published YouTube link explicitly names youtube_url.
 * An already-empty field sends no clear, preserving ordinary partial updates.
 */
export function buildUpdateInput(
  values: ReportEditorValues,
  baseline: ReportEditorValues,
): UpdatePostInput {
  const clearFields: ClearablePostField[] = [];
  const baselineLabel = (baseline.location.label ?? "").trim();
  const nextLabel = (values.location.label ?? "").trim();
  // A half-pin (a legacy row with only one coordinate) is a pin too.
  const hadPin = baseline.location.latitude != null || baseline.location.longitude != null;
  if (nextLabel === "" && baselineLabel !== "") clearFields.push("location_label");
  if (nextLabel === "" && hadPin &&
      values.location.latitude == null && values.location.longitude == null) {
    clearFields.push("latitude", "longitude");
  }
  const youtubeUrl = values.youtubeUrl.trim();
  if (youtubeUrl === "" && baseline.youtubeUrl.trim() !== "") clearFields.push("youtube_url");

  return {
    type: values.type,
    title: values.title.trim(),
    description: values.description.trim(),
    category: values.category === "" ? undefined : values.category,
    eventDate: values.eventDate,
    latitude: values.location.latitude,
    longitude: values.location.longitude,
    locationLabel: nextLabel === "" ? null : nextLabel,
    youtubeUrl: youtubeUrl === "" ? null : youtubeUrl,
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
  const params = useParams();
  const id = postId ?? params.id ?? "";
  const isPresent = useIsPresent();
  const wasPresent = useRef(isPresent);
  const [entry, setEntry] = useState(0);
  // AnimatePresence can reuse an exiting route when Back reverses its exit.
  // That is a fresh visit, not revival of the discarded draft/pending writes.
  useLayoutEffect(() => {
    if (isPresent && !wasPresent.current) setEntry((value) => value + 1);
    wasPresent.current = isPresent;
  }, [isPresent]);
  // A draft belongs to one account/report lifetime, including its local controls.
  return <EditReportSession key={JSON.stringify([user?.id ?? null, id, entry])} id={id} userId={user?.id} />;
}

function EditReportSession({ id, userId }: { id: string; userId?: string }) {
  const navigate = useNavigate();

  const [post, setPost] = useState<PostItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<ReportEditorValues | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReportEditorErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // The baseline the editor was hydrated with. It is a SNAPSHOT, so "dirty"
  // compares against what the server had, not against the live values.
  const baselineRef = useRef<ReportEditorValues | null>(null);
  const dirtyRef = useRef(false);
  const activeRef = useRef(false);
  const saveInFlightRef = useRef(false);

  useLayoutEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

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
    () => (!saved && values && baselineRef.current ? reportEditorIsDirty(values, baselineRef.current) : false),
    [values, saved],
  );
  dirtyRef.current = dirty;

  const askToLeave = useCallback((): boolean => {
    if (!dirtyRef.current) return true;
    return window.confirm(UNSAVED_CHANGES_MESSAGE);
  }, []);

  // One guard for shell links, deep-link navigation, header/discard and POP.
  // Native back still lets topmost dialogs consume it first; when it reaches
  // router navigation this blocker asks exactly once, like browser Back.
  const blocker = useBlocker(useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
    // Search/state changes do not unmount this report's draft. Confirm before
    // admitting a route departure, and fence pending writes synchronously:
    // AnimatePresence keeps the departing editor mounted during its exit.
    if (!activeRef.current || !dirtyRef.current || currentLocation.pathname === nextLocation.pathname) return false;
    if (!askToLeave()) return true;
    activeRef.current = false;
    return false;
  }, [askToLeave]));
  useEffect(() => {
    if (blocker.state === "blocked") blocker.reset();
  }, [blocker]);

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
    if (!activeRef.current || saveInFlightRef.current) return;
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
    if (!activeRef.current || saveInFlightRef.current || !post || !values || !baselineRef.current ||
        post.userId !== userId || RESOLVED_STATUSES.includes(post.status) || !dirtyRef.current) return;
    const errors = validateReportEditorValues(values);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      announce("Fix the highlighted fields before saving.");
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveHint(null);
    try {
      await updatePost(post.id, buildUpdateInput(values, baselineRef.current));
      if (!activeRef.current) return;
      baselineRef.current = values;
      dirtyRef.current = false;
      setSaved(true);
      announce("Report updated.");
      navigate("/my");
    } catch (err) {
      if (!activeRef.current) return;
      // The server's own refusal is shown as it is. The edits stay on screen:
      // a failed save never discards what the owner typed.
      const friendly = friendlyError(err);
      setSaveError(friendly.message);
      // The server validates the MERGED row, so a refusal can be about a
      // value that was already saved rather than about what was just typed.
      setSaveHint(
        friendly.code === "VALIDATION"
          ? "If you did not change that field, the value already saved on the report may be what the server refused."
          : null,
      );
      announce(friendly.message);
    } finally {
      saveInFlightRef.current = false;
      if (activeRef.current) setSaving(false);
    }
  }, [post, values, userId, navigate]);

  const leave = useCallback(() => {
    navigate("/my");
  }, [navigate]);

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

  const isOwner = userId === post.userId;
  const isResolved = RESOLVED_STATUSES.includes(post.status);

  return (
    <div className="flex min-h-full flex-col gap-4 px-4 py-5" data-testid="edit-report">
      <header className="sticky top-0 z-20 -mx-4 flex shrink-0 items-center gap-2 bg-surface px-4">
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
            A resolved report cannot be edited here. Set it back to Open on My Reports to change the details.
          </p>
        </div>
      )}

      {saveError && (
        <div role="alert" className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          <p>{saveError}</p>
          {saveHint && <p className="mt-1 text-on-surface-variant">{saveHint}</p>}
        </div>
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
            publishedLocation={baselineRef.current?.location}
          />
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
