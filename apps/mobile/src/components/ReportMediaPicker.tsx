import { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { motionDurations, motionEasings, pressFeedback } from "./uiMotion";
import { ReportPhotoCarousel } from "./ReportPhotoCarousel";
import type { ReportMediaPhoto } from "./ReportPhotoCarousel";
import type { PhotoLightboxOriginRect } from "./PhotoLightbox";

export type { ReportMediaPhoto };

export interface ReportMediaPickerProps {
  photos: readonly ReportMediaPhoto[];
  onAddCamera: () => void;
  onAddGallery: (remaining: number) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "earlier" | "later") => void;
  /** Move one photo to the front, which is what makes it the cover. */
  onMakeCover: (id: string) => void;
  /** `origin` is the tapped slide's viewport rect (shared-element start). */
  onPreview: (id: string, origin?: PhotoLightboxOriginRect) => void;
  disabled?: boolean;
}

const MAX_PHOTOS = 5;

/** Press acknowledgement for the camera/gallery hand-off buttons. */
const pressTransition = {
  type: "tween",
  duration: motionDurations.instant,
  ease: motionEasings.out,
} as const;

function CameraIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

function GalleryIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M4 12h16" />
      <path d="M8 17h8" />
      <path d="M12 17v-5" />
    </svg>
  );
}

function MotionDisclosure() {
  return (
    <p className="text-xs text-on-surface-variant">
      Motion photo: still image will be posted; motion clip is not included
    </p>
  );
}

/**
 * The composer's Photos section (packet 05 §2/§4/§5/§6).
 *
 * Presentation only: the section owns the header, the add affordances and the
 * disclosures, and delegates the selected photos to `ReportPhotoCarousel`
 * (one large swipeable slide each, action row on the active photo). Photo
 * intake, ordering and draft persistence stay with the form, so the same
 * camera/gallery handlers serve the empty state and the populated state
 * without a second code path.
 */
export function ReportMediaPicker({
  photos,
  onAddCamera,
  onAddGallery,
  onRemove,
  onMove,
  onMakeCover,
  onPreview,
  disabled = false,
}: ReportMediaPickerProps) {
  const remaining = useMemo(() => MAX_PHOTOS - photos.length, [photos.length]);
  const atLimit = photos.length >= MAX_PHOTOS;

  const handleCameraClick = useCallback(() => {
    if (!disabled && !atLimit) onAddCamera();
  }, [disabled, atLimit, onAddCamera]);

  const handleGalleryClick = useCallback(() => {
    if (!disabled && !atLimit) onAddGallery(remaining);
  }, [disabled, atLimit, remaining, onAddGallery]);

  const handleRemove = useCallback(
    (id: string) => {
      if (!disabled) onRemove(id);
    },
    [disabled, onRemove]
  );

  const handleMove = useCallback(
    (id: string, direction: "earlier" | "later") => {
      if (!disabled) onMove(id, direction);
    },
    [disabled, onMove]
  );

  const handleMakeCover = useCallback(
    (id: string) => {
      if (!disabled) onMakeCover(id);
    },
    [disabled, onMakeCover]
  );

  const handlePreview = useCallback(
    (id: string, origin?: PhotoLightboxOriginRect) => {
      if (!disabled) onPreview(id, origin);
    },
    [disabled, onPreview]
  );

  return (
    <div className="flex flex-col gap-3" data-testid="report-media-picker">
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-on-surface">Photos</h2>
        <span className="text-xs text-on-surface-variant">{photos.length}/{MAX_PHOTOS}</span>
        <div className="ml-auto flex items-center gap-2">
          <motion.button
            type="button"
            className={`flex items-center justify-center rounded-m3-sm bg-surface-container text-on-surface ${
              disabled || atLimit ? "opacity-40" : ""
            }`}
            style={{ width: 48, height: 48 }}
            onClick={handleCameraClick}
            disabled={disabled || atLimit}
            aria-label="Take photo"
            aria-disabled={disabled || atLimit}
            whileTap={pressFeedback.iconButton}
            transition={pressTransition}
          >
            <CameraIcon size={24} />
          </motion.button>
          <motion.button
            type="button"
            className={`flex items-center justify-center rounded-m3-sm bg-surface-container text-on-surface ${
              disabled || atLimit ? "opacity-40" : ""
            }`}
            style={{ width: 48, height: 48 }}
            onClick={handleGalleryClick}
            disabled={disabled || atLimit}
            aria-label={`Choose up to ${remaining} photos`}
            aria-disabled={disabled || atLimit}
            whileTap={pressFeedback.iconButton}
            transition={pressTransition}
          >
            <GalleryIcon size={24} />
          </motion.button>
        </div>
      </header>

      {atLimit && (
        <p className="text-xs text-on-surface-variant">Maximum of 5 photos reached</p>
      )}

      {photos.length > 0 ? (
        <ReportPhotoCarousel
          photos={photos}
          onRemove={handleRemove}
          onMove={handleMove}
          onMakeCover={handleMakeCover}
          onPreview={handlePreview}
          disabled={disabled}
        />
      ) : (
        <p className="text-xs text-on-surface-variant">
          Add up to 5 photos. The first photo is the cover.
        </p>
      )}

      {photos.some((p) => p.motionPhoto) && (
        <MotionDisclosure />
      )}
    </div>
  );
}
