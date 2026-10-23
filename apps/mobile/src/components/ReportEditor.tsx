import { useRef, useState } from "react";
import { extractYouTubeId } from "@findback/shared";
import { isValidPostYouTubeUrl } from "../utils/youtubeUrl";
import type { Attachment, Category, PostItem, PostType } from "@findback/shared";
import type { Editor } from "@tiptap/react";
import { TextField } from "./Fields";
import { Segmented } from "./Segmented";
import { CategoryField } from "./CategoryField";
import { RichTextEditor } from "./RichTextEditor";
import { ReportDatePicker } from "./ReportDatePicker";
import { LocationPicker, type LocationValue } from "./LocationPicker";
import { PhotoLightbox } from "./PhotoLightbox";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { ImageOff } from "lucide-react";

/**
 * The report fields, in one place.
 *
 * These bounds mirror the server validator
 * (`public.findback_validate_post_fields`): a title is 3-120 characters, a
 * description is 10-3000 characters, a place label is at most 200
 * characters. The client checks them so the owner is told before the round
 * trip; the server still has the final word.
 */
export const REPORT_TITLE_MIN = 3;
export const REPORT_TITLE_MAX = 120;
export const REPORT_DESCRIPTION_MIN = 10;
export const REPORT_DESCRIPTION_MAX = 3000;
export const REPORT_LOCATION_LABEL_MAX = 200;

/** The editor's own state: everything the owner can change about a report. */
export interface ReportEditorValues {
  type: PostType;
  title: string;
  description: string;
  category: Category | "";
  eventDate: string;
  location: LocationValue;
  /** Optional YouTube link. Clearing a published value removes it on save. */
  youtubeUrl: string;
}

export type ReportEditorField = keyof ReportEditorValues;

export type ReportEditorErrors = Partial<Record<ReportEditorField, string>>;

export interface ReportEditorProps {
  values: ReportEditorValues;
  /** One patch at a time — the editor never owns the values. */
  onChange: (patch: Partial<ReportEditorValues>) => void;
  errors?: ReportEditorErrors;
  /**
   * Photos already attached to the report. They are shown READ-ONLY: the
   * report-update RPC writes the report's metadata only, so a photo can be
   * neither added, removed nor reordered here. The editor says so instead
   * of pretending the photos are editable.
   */
  photos?: readonly Attachment[];
  /**
   * The original published location, not the current draft. It lets a
   * clear-then-retype restore the pin visibly, rather than silently keeping
   * it only on the server (where null arguments mean keep).
   *
   * A report that already carries a map pin must not lose it because the
   * owner retyped the place name: the picker cannot resolve free text to
   * coordinates, so a text edit arrives with no coordinates at all. When
   * this is supplied, the editor keeps the stored coordinates and the owner
   * removes the pin by clearing the place.
   */
  publishedLocation?: LocationValue;
  /** Disable every control (a save is in flight). */
  disabled?: boolean;
}

/** The values a stored report hydrates into. */
export function reportEditorValuesFromPost(post: PostItem): ReportEditorValues {
  return {
    type: post.type,
    title: post.title,
    description: post.description,
    category: post.category,
    eventDate: post.eventDate,
    location: {
      label: post.locationLabel ?? "",
      latitude: post.latitude,
      longitude: post.longitude,
    },
    youtubeUrl: post.youtubeUrl ?? "",
  };
}

function sameLocation(a: LocationValue, b: LocationValue): boolean {
  return (
    (a.label ?? "").trim() === (b.label ?? "").trim() &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude
  );
}

/**
 * Keep the published pin when the place text is retyped.
 *
 * The picker cannot turn free text into coordinates, so typing a place name
 * arrives with no coordinates. For a DRAFT that is right — the pin no longer
 * matches the place. For a report that already carries a published pin it
 * is wrong: the owner changed the wording of the place, not the place
 * itself, and the published pin must survive.
 *
 * The owner removes the pin by CLEARING the place: an empty label means
 * "no place", and the coordinates go with it.
 */
export function keepPublishedPin(
  current: LocationValue,
  next: LocationValue,
  published: LocationValue = current,
): LocationValue {
  const nextLabel = (next.label ?? "").trim();
  // The place was removed: the pin goes with it.
  if (nextLabel === "") return next;
  // The owner picked a new point: the new pin wins.
  if (next.latitude != null && next.longitude != null) return next;
  // Preserve a newly picked draft pin first, otherwise the published pin.
  // Keep even legacy half-pins explicit rather than hiding a stored value.
  const pin = current.latitude != null || current.longitude != null ? current : published;
  return { ...next, latitude: pin.latitude, longitude: pin.longitude };
}

/**
 * True when the values differ from the baseline the editor was hydrated
 * with. The baseline is a snapshot, never the live values, so a save that
 * writes the same values back is not "dirty".
 */
export function reportEditorIsDirty(values: ReportEditorValues, baseline: ReportEditorValues): boolean {
  return (
    values.type !== baseline.type ||
    values.title !== baseline.title ||
    values.description !== baseline.description ||
    values.category !== baseline.category ||
    values.eventDate !== baseline.eventDate ||
    values.youtubeUrl.trim() !== baseline.youtubeUrl.trim() ||
    !sameLocation(values.location, baseline.location)
  );
}

/**
 * Client-side validation, mirroring the server validator's bounds on the
 * values you send. The server validates the MERGED row — the values the row
 * will have once your arguments are coalesced with the stored ones — so
 * these are the same bounds it applies to what you type.
 */
export function validateReportEditorValues(values: ReportEditorValues): ReportEditorErrors {
  const errors: ReportEditorErrors = {};
  const title = values.title.trim();
  if (title.length < REPORT_TITLE_MIN || title.length > REPORT_TITLE_MAX) {
    errors.title = `The title needs ${REPORT_TITLE_MIN}-${REPORT_TITLE_MAX} characters.`;
  }
  const description = values.description.trim();
  if (description.length < REPORT_DESCRIPTION_MIN || description.length > REPORT_DESCRIPTION_MAX) {
    errors.description = `The description needs ${REPORT_DESCRIPTION_MIN}-${REPORT_DESCRIPTION_MAX} characters.`;
  }
  if (!values.category) {
    errors.category = "Choose a category.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.eventDate)) {
    errors.eventDate = "Pick the date this happened.";
  }
  if ((values.location.label ?? "").length > REPORT_LOCATION_LABEL_MAX) {
    errors.location = "That place name is too long.";
  }
  // URL acceptance is the deployed server rule, not best-effort extraction.
  // A blank link is valid and can explicitly remove a published one.
  const youtubeUrl = values.youtubeUrl.trim();
  if (youtubeUrl && !isValidPostYouTubeUrl(youtubeUrl)) {
    errors.youtubeUrl = "That doesn't look like a YouTube link.";
  }
  return errors;
}

/**
 * Read-only photos with an honest explanation.
 *
 * The report-update RPC writes the report's metadata only — it has no
 * attachment argument — so a photo cannot be added, removed or reordered
 * from the editor. The line below says exactly that, rather than showing
 * dead controls that look like they work.
 */
function ReadOnlyPhotos({ photos, title }: { photos: readonly Attachment[]; title: string }) {
  const images = photos.filter((photo) => photo.mimeType.startsWith("image/"));
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (images.length === 0) return null;
  const lightboxPhotos = images.map((photo) => ({ id: photo.id, previewUrl: photo.fileUrl }));
  return (
    <section className="flex flex-col gap-2" data-testid="report-editor-photos">
      <div className="flex flex-wrap gap-2">
        {images.map((photo, index) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setOpenIndex(index)}
            aria-label={`Open photo ${index + 1} of ${images.length} fullscreen`}
            className="block h-20 w-20 overflow-hidden rounded-m3-sm border border-outline-variant"
          >
            <img src={photo.fileUrl} alt={`Photo for ${title}`} className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-on-surface-variant" data-testid="report-editor-photos-note">
        <ImageOff size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>
          Photos can&apos;t be added, removed or reordered after a report is posted. Only the
          details below can be changed.
        </span>
      </p>
      {openIndex !== null && (
        <PhotoLightbox
          photo={lightboxPhotos[Math.min(openIndex, lightboxPhotos.length - 1)]!}
          index={Math.min(openIndex, lightboxPhotos.length - 1)}
          total={lightboxPhotos.length}
          photos={lightboxPhotos}
          title={title}
          onSelect={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          onPrev={
            lightboxPhotos.length > 1
              ? () => setOpenIndex((current) =>
                  current === null ? current : (current - 1 + lightboxPhotos.length) % lightboxPhotos.length,
                )
              : undefined
          }
          onNext={
            lightboxPhotos.length > 1
              ? () => setOpenIndex((current) =>
                  current === null ? current : (current + 1) % lightboxPhotos.length,
                )
              : undefined
          }
        />
      )}
    </section>
  );
}

/**
 * The canonical report fields.
 *
 * Both the create flow and the edit flow use the SAME field components
 * (`Segmented`, `TextField`, `RichTextEditor`, `CategoryField`,
 * `ReportDatePicker`, `LocationPicker`), so a report looks and behaves the
 * same wherever it is written. The component is fully controlled: it owns
 * no state of its own beyond the photo viewer, which is a view concern.
 */
export function ReportEditor({
  values,
  onChange,
  errors = {},
  photos = [],
  disabled = false,
  publishedLocation,
}: ReportEditorProps) {
  const editorRef = useRef<Editor | null>(null);
  const draftYoutubeUrl = values.youtubeUrl.trim();
  const youtubeId = isValidPostYouTubeUrl(draftYoutubeUrl) ? extractYouTubeId(draftYoutubeUrl) : null;

  return (
    <div className="flex flex-col gap-5" data-testid="report-editor">
      <Segmented<PostType>
        wrapLongLabels
        ariaLabel="Lost or found"
        value={values.type}
        onChange={(type) => onChange({ type })}
        disabled={disabled}
        options={[
          { value: "LOST", label: "I lost something" },
          { value: "FOUND", label: "I found something" },
        ]}
      />

      <ReadOnlyPhotos photos={photos} title={values.title} />

      <TextField
        label={values.type === "LOST" ? "What did you lose?" : "What did you find?"}
        value={values.title}
        onChange={(event) => onChange({ title: event.target.value })}
        placeholder="e.g. Scientific calculator near the Science Faculty"
        error={errors.title}
        required
        maxLength={REPORT_TITLE_MAX}
        disabled={disabled}
      />

      <div data-testid="report-description">
        <RichTextEditor
          disabled={disabled}
          label="Description"
          value={values.description}
          onChange={(description) => onChange({ description })}
          placeholder="Colour, brand, markings, when and where it happened…"
          error={errors.description}
          required
          maxLength={REPORT_DESCRIPTION_MAX}
          editorRef={editorRef}
        />
      </div>

      <CategoryField
        disabled={disabled}
        value={values.category}
        onChange={(category) => onChange({ category })}
        error={errors.category}
      />

      <div className="block">
        <span id="report-event-date-label" className="mb-1 block text-sm font-medium">
          {values.type === "LOST" ? "Date lost" : "Date found"}
        </span>
        <ReportDatePicker
          disabled={disabled}
          value={values.eventDate}
          expected={values.type}
          aria-describedby="report-event-date-label"
          error={errors.eventDate}
          onChange={(eventDate) => onChange({ eventDate })}
        />
      </div>

      <LocationPicker
        disabled={disabled}
        value={values.location}
        onChange={(location) =>
          onChange({
            location: publishedLocation
              ? keepPublishedPin(values.location, location, publishedLocation)
              : location,
          })
        }
        maxLength={REPORT_LOCATION_LABEL_MAX}
      />
      {errors.location && (
        <span className="mt-1 block text-xs text-error">{errors.location}</span>
      )}
      {publishedLocation && (
        <p className="mt-1 text-xs text-on-surface-variant">
          Editing the place name keeps the map pin that is already published. Clearing the place removes the name and the pin when you save.
        </p>
      )}

      <TextField
        label="YouTube link (optional)"
        type="url"
        inputMode="url"
        autoComplete="url"
        value={values.youtubeUrl}
        onChange={(event) => onChange({ youtubeUrl: event.target.value })}
        placeholder="https://www.youtube.com/watch?v=…"
        error={errors.youtubeUrl}
        hint="Clear this field to remove the video when you save."
        disabled={disabled}
      />
      {youtubeId && (
        <div className="flex flex-col gap-1">
          <YouTubeEmbed url={draftYoutubeUrl} />
        </div>
      )}
    </div>
  );
}
