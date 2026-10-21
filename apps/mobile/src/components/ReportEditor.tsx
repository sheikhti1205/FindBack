import { useRef, useState } from "react";
import type { Attachment, Category, PostItem, PostType } from "@findback/shared";
import type { Editor } from "@tiptap/react";
import { TextField } from "./Fields";
import { Segmented } from "./Segmented";
import { CategoryField } from "./CategoryField";
import { RichTextEditor } from "./RichTextEditor";
import { ReportDatePicker } from "./ReportDatePicker";
import { LocationPicker, type LocationValue } from "./LocationPicker";
import { PhotoLightbox } from "./PhotoLightbox";
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
   * Keep a published map pin when the place text is edited.
   *
   * A report that already carries a map pin must not lose it because the
   * owner retyped the place name: the picker cannot resolve free text to
   * coordinates, so a text edit arrives with no coordinates at all. When
   * this is on, the editor keeps the stored coordinates and the owner
   * removes the pin by clearing the place.
   */
  keepPinOnLabelEdit?: boolean;
  /** Disable every control (a save is in flight). */
  disabled?: boolean;
}

const inputCls =
  "w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none";

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
export function keepPublishedPin(current: LocationValue, next: LocationValue): LocationValue {
  const nextLabel = (next.label ?? "").trim();
  // The place was removed: the pin goes with it.
  if (nextLabel === "") return next;
  // The owner picked a new point: the new pin wins.
  if (next.latitude != null && next.longitude != null) return next;
  // There is no published pin to keep.
  if (current.latitude == null || current.longitude == null) return next;
  return { ...next, latitude: current.latitude, longitude: current.longitude };
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
  keepPinOnLabelEdit = false,
}: ReportEditorProps) {
  const editorRef = useRef<Editor | null>(null);

  return (
    <div className="flex flex-col gap-5" data-testid="report-editor">
      <Segmented<PostType>
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
        value={values.category}
        onChange={(category) => onChange({ category })}
        error={errors.category}
      />

      <div className="block">
        <span id="report-event-date-label" className="mb-1 block text-sm font-medium">
          {values.type === "LOST" ? "Date lost" : "Date found"}
        </span>
        <ReportDatePicker
          value={values.eventDate}
          expected={values.type}
          aria-describedby="report-event-date-label"
          error={errors.eventDate}
          onChange={(eventDate) => onChange({ eventDate })}
        />
      </div>

      <LocationPicker
        value={values.location}
        onChange={(location) =>
          onChange({
            location: keepPinOnLabelEdit
              ? keepPublishedPin(values.location, location)
              : location,
          })
        }
        maxLength={REPORT_LOCATION_LABEL_MAX}
      />
      {errors.location && (
        <span className="mt-1 block text-xs text-error">{errors.location}</span>
      )}
      <p className="mt-1 text-xs text-on-surface-variant">
        {keepPinOnLabelEdit
          ? "Editing the place name keeps the map pin that is already published. Clearing the place removes the name and the pin."
          : "Clearing the place removes the place name and the map pin."}
      </p>
    </div>
  );
}

/**
 * A read-only line for content the editor does not write.
 *
 * The report's YouTube link is preserved by the update RPC (the editor
 * never sends it), so it is shown as it stands instead of quietly
 * disappearing from the owner's view of their own report.
 */
export function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1" data-testid="report-editor-readonly">
      <span className="text-sm font-medium">{label}</span>
      <p className={`${inputCls} text-on-surface-variant`}>{value}</p>
    </div>
  );
}
