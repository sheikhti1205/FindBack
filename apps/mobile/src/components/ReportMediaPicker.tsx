import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { motionDurations, motionEasings, pressFeedback, scaleInVariants } from "./uiMotion";
import type { PhotoLightboxOriginRect } from "./PhotoLightbox";

/**
 * Narrow-report layout switch: below ~420px two 152px tiles no longer fit,
 * and the square grid degrades into a tall single column of large photos.
 * Narrow screens get compact rows (56px thumb + meta + full-width 48px
 * action row) so five-photo management stays short. Visible icons may
 * shrink; the 48px minimum hit areas never do.
 */
const NARROW_QUERY = "(max-width: 420px)";

function useNarrowTiles(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

function formatLabel(format?: string): string {
  const normalized = (format ?? "").trim().toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "JPEG";
  if (normalized === "png") return "PNG";
  if (normalized === "webp") return "WEBP";
  if (normalized === "gif") return "GIF";
  if (normalized === "heic" || normalized === "heif") return "HEIC";
  return normalized ? normalized.toUpperCase() : "PHOTO";
}

/** Minimal structural view of a selected photo; PickedPhoto satisfies it. */
export interface ReportMediaPhoto {
  id: string;
  webPath: string;
  format?: string;
  motionPhoto?: boolean;
}

export interface ReportMediaPickerProps {
  photos: readonly ReportMediaPhoto[];
  onAddCamera: () => void;
  onAddGallery: (remaining: number) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "earlier" | "later") => void;
  /** `origin` is the tapped thumbnail's viewport rect (shared-element start). */
  onPreview: (id: string, origin?: PhotoLightboxOriginRect) => void;
  disabled?: boolean;
}

const MAX_PHOTOS = 5;

/** Tile enter/exit: anchored pop, transform/opacity only. */
const tileTransition = {
  type: "tween",
  duration: motionDurations.fast,
  ease: motionEasings.out,
} as const;

/** Press acknowledgement for the camera/gallery hand-off buttons. */
const pressTransition = {
  type: "tween",
  duration: motionDurations.instant,
  ease: motionEasings.out,
} as const;

/** Viewport rect of the tapped thumbnail, for the lightbox FLIP origin. */
function originOf(element: HTMLElement): PhotoLightboxOriginRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

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

function ChevronLeftIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function TrashIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function MotionDisclosure() {
  return (
    <p style={styles.motionDisclosure}>
      Motion photo: still image will be posted; motion clip is not included
    </p>
  );
}

export function ReportMediaPicker({
  photos,
  onAddCamera,
  onAddGallery,
  onRemove,
  onMove,
  onPreview,
  disabled = false,
}: ReportMediaPickerProps) {
  const remaining = useMemo(() => MAX_PHOTOS - photos.length, [photos.length]);
  const atLimit = photos.length >= MAX_PHOTOS;
  const showReorder = photos.length > 1;
  const narrow = useNarrowTiles();

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

  const handlePreview = useCallback(
    (id: string, origin?: PhotoLightboxOriginRect) => {
      if (!disabled) onPreview(id, origin);
    },
    [disabled, onPreview]
  );

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h2 style={styles.headerTitle}>Photos</h2>
        <span style={styles.headerCount}>{photos.length}/{MAX_PHOTOS}</span>
        <div style={styles.headerActions}>
          <motion.button
            type="button"
            style={{ ...styles.iconButton, ...(disabled || atLimit ? styles.iconButtonDisabled : {}) }}
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
            style={{ ...styles.iconButton, ...(disabled || atLimit ? styles.iconButtonDisabled : {}) }}
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
        <p style={styles.limitNotice}>Maximum of 5 photos reached</p>
      )}

      <div style={narrow ? styles.rows : styles.grid} role="list" aria-label="Selected photos">
        <AnimatePresence initial={false}>
        {photos.map((photo, index) => (
          narrow ? (
            <CompactPhotoRow
              key={photo.id}
              photo={photo}
              index={index}
              total={photos.length}
              onRemove={handleRemove}
              onMove={handleMove}
              onPreview={handlePreview}
              showReorder={showReorder}
              disabled={disabled}
            />
          ) : (
            <PhotoTile
              key={photo.id}
              photo={photo}
              index={index}
              total={photos.length}
              onRemove={handleRemove}
              onMove={handleMove}
              onPreview={handlePreview}
              showReorder={showReorder}
              disabled={disabled}
            />
          )
        ))}
        </AnimatePresence>
      </div>

      {photos.some((p) => p.motionPhoto) && (
        <MotionDisclosure />
      )}
    </div>
  );
}

interface PhotoTileProps {
  photo: ReportMediaPhoto;
  index: number;
  total: number;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "earlier" | "later") => void;
  onPreview: (id: string, origin?: PhotoLightboxOriginRect) => void;
  showReorder: boolean;
  disabled: boolean;
}

/**
 * Narrow-screen row: 56px thumbnail + "Photo N of M · FORMAT · Primary"
 * meta, then one full-width row of 48px actions. Same handlers, labels and
 * hit areas as the square tile — roughly a third of the height.
 */
function CompactPhotoRow({
  photo,
  index,
  total,
  onRemove,
  onMove,
  onPreview,
  showReorder,
  disabled,
}: PhotoTileProps) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const meta = `${formatLabel(photo.format)}${index === 0 ? " · Primary" : ""}${photo.motionPhoto ? " · Motion still" : ""}`;
  return (
    <motion.div
      style={styles.row}
      role="listitem"
      layout
      variants={scaleInVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={tileTransition}
    >
      <div style={styles.rowTop}>
        <button
          type="button"
          style={styles.rowThumb}
          onClick={(event) => onPreview(photo.id, originOf(event.currentTarget))}
          disabled={disabled}
          aria-label={`View photo ${index + 1} of ${total} full size`}
        >
          <img
            src={photo.webPath}
            alt={`Photo ${index + 1} of ${total}`}
            style={styles.tileImage}
          />
        </button>
        <div style={styles.rowMeta}>
          <span style={styles.rowTitle}>Photo {index + 1} of {total}</span>
          <span style={styles.rowSubtitle}>{meta}</span>
        </div>
      </div>
      <div style={styles.rowActions}>
        {showReorder && (
          <>
            <button
              type="button"
              style={{ ...styles.rowAction, ...(isFirst ? styles.controlButtonDisabled : {}) }}
              onClick={() => onMove(photo.id, "earlier")}
              disabled={disabled || isFirst}
              aria-label={`Move photo ${index + 1} earlier`}
              aria-disabled={disabled || isFirst}
            >
              <ChevronLeftIcon size={20} />
            </button>
            <button
              type="button"
              style={{ ...styles.rowAction, ...(isLast ? styles.controlButtonDisabled : {}) }}
              onClick={() => onMove(photo.id, "later")}
              disabled={disabled || isLast}
              aria-label={`Move photo ${index + 1} later`}
              aria-disabled={disabled || isLast}
            >
              <ChevronRightIcon size={20} />
            </button>
          </>
        )}
        <button
          type="button"
          style={styles.rowAction}
          onClick={() => onRemove(photo.id)}
          disabled={disabled}
          aria-label={`Remove photo ${index + 1}`}
          aria-disabled={disabled}
        >
          <TrashIcon size={20} />
        </button>
      </div>
    </motion.div>
  );
}

function PhotoTile({
  photo,
  index,
  total,
  onRemove,
  onMove,
  onPreview,
  showReorder,
  disabled,
}: PhotoTileProps) {
  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <motion.div
      style={styles.tile}
      role="listitem"
      layout
      variants={scaleInVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={tileTransition}
    >
      <button
        type="button"
        style={styles.tileImageWrapper}
        onClick={(event) => onPreview(photo.id, originOf(event.currentTarget))}
        disabled={disabled}
        aria-label={`View photo ${index + 1} of ${total} full size`}
      >
        <img
          src={photo.webPath}
          alt={`Photo ${index + 1} of ${total}`}
          style={styles.tileImage}
        />
        <span style={styles.tileBadge}>Photo {index + 1} of {total}</span>
      </button>

      <div style={styles.tileControls}>
        {showReorder && (
          <>
            <button
              type="button"
              style={{
                ...styles.controlButton,
                ...(isFirst ? styles.controlButtonDisabled : {}),
              }}
              onClick={() => onMove(photo.id, "earlier")}
              disabled={disabled || isFirst}
              aria-label={`Move photo ${index + 1} earlier`}
              aria-disabled={disabled || isFirst}
            >
              <ChevronLeftIcon size={20} />
            </button>
            <button
              type="button"
              style={{
                ...styles.controlButton,
                ...(isLast ? styles.controlButtonDisabled : {}),
              }}
              onClick={() => onMove(photo.id, "later")}
              disabled={disabled || isLast}
              aria-label={`Move photo ${index + 1} later`}
              aria-disabled={disabled || isLast}
            >
              <ChevronRightIcon size={20} />
            </button>
          </>
        )}
        <button
          type="button"
          style={styles.controlButton}
          onClick={() => onRemove(photo.id)}
          disabled={disabled}
          aria-label={`Remove photo ${index + 1}`}
          aria-disabled={disabled}
        >
          <TrashIcon size={20} />
        </button>
      </div>
    </motion.div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headerTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
  },
  headerCount: {
    fontSize: 16,
    fontWeight: 500,
    color: "var(--fb-on-surface-variant)",
  },
  headerActions: {
    display: "flex",
    gap: 8,
  },
  iconButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 48,
    height: 48,
    border: "none",
    borderRadius: 8,
    backgroundColor: "var(--fb-surface-container)",
    color: "var(--fb-on-surface)",
    cursor: "pointer",
    transition: "background-color 0.15s",
  },
  iconButtonDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  limitNotice: {
    margin: 0,
    fontSize: 14,
    color: "var(--fb-error)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(152px, 1fr))",
    gap: 12,
  },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: "var(--fb-surface-container-low)",
  },
  rowTop: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  rowThumb: {
    width: 56,
    height: 56,
    flexShrink: 0,
    borderRadius: 8,
    overflow: "hidden",
    border: "none",
    padding: 0,
    cursor: "pointer",
    backgroundColor: "var(--fb-surface-container)",
  },
  rowMeta: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--fb-on-surface)",
  },
  rowSubtitle: {
    fontSize: 12,
    color: "var(--fb-on-surface-variant)",
  },
  rowActions: {
    display: "flex",
    gap: 8,
  },
  rowAction: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    minHeight: 48,
    border: "none",
    borderRadius: 6,
    backgroundColor: "var(--fb-surface-container)",
    color: "var(--fb-on-surface)",
    cursor: "pointer",
  },
  tile: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  tileImageWrapper: {
    position: "relative",
    aspectRatio: "1 / 1",
    borderRadius: 8,
    overflow: "hidden",
    border: "none",
    backgroundColor: "var(--fb-surface-container-low)",
    cursor: "pointer",
    padding: 0,
  },
  tileImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  tileBadge: {
    position: "absolute",
    bottom: 4,
    left: 4,
    padding: "2px 6px",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--fb-surface)",
    backgroundColor: "var(--fb-on-surface)",
    borderRadius: 4,
  },
  tileControls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  controlButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 48,
    height: 48,
    border: "none",
    borderRadius: 6,
    backgroundColor: "var(--fb-surface-container)",
    color: "var(--fb-on-surface)",
    cursor: "pointer",
    transition: "background-color 0.15s",
  },
  controlButtonDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  motionDisclosure: {
    margin: 0,
    fontSize: 12,
    color: "var(--fb-on-surface-variant)",
    fontStyle: "italic",
  },
};

export default ReportMediaPicker;
