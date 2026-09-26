import React, { useCallback, useMemo } from "react";

/** Minimal structural view of a selected photo; PickedPhoto satisfies it. */
export interface ReportMediaPhoto {
  id: string;
  webPath: string;
  format?: string;
}

export interface ReportMediaPickerProps {
  photos: readonly ReportMediaPhoto[];
  onAddCamera: () => void;
  onAddGallery: (remaining: number) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "earlier" | "later") => void;
  onPreview: (id: string) => void;
  disabled?: boolean;
}

const MAX_PHOTOS = 5;

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
    (id: string) => {
      if (!disabled) onPreview(id);
    },
    [disabled, onPreview]
  );

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h2 style={styles.headerTitle}>Photos</h2>
        <span style={styles.headerCount}>{photos.length}/{MAX_PHOTOS}</span>
        <div style={styles.headerActions}>
          <button
            type="button"
            style={{ ...styles.iconButton, ...(disabled || atLimit ? styles.iconButtonDisabled : {}) }}
            onClick={handleCameraClick}
            disabled={disabled || atLimit}
            aria-label="Take photo"
            aria-disabled={disabled || atLimit}
          >
            <CameraIcon size={24} />
          </button>
          <button
            type="button"
            style={{ ...styles.iconButton, ...(disabled || atLimit ? styles.iconButtonDisabled : {}) }}
            onClick={handleGalleryClick}
            disabled={disabled || atLimit}
            aria-label={`Choose up to ${remaining} photos`}
            aria-disabled={disabled || atLimit}
          >
            <GalleryIcon size={24} />
          </button>
        </div>
      </header>

      {atLimit && (
        <p style={styles.limitNotice}>Maximum of 5 photos reached</p>
      )}

      <div style={styles.grid} role="list" aria-label="Selected photos">
        {photos.map((photo, index) => (
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
        ))}
      </div>

      {photos.some((p) => p.format === "heic" || p.format === "heif") && (
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
  onPreview: (id: string) => void;
  showReorder: boolean;
  disabled: boolean;
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
    <div style={styles.tile} role="listitem">
      <button
        type="button"
        style={styles.tileImageWrapper}
        onClick={() => onPreview(photo.id)}
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
    </div>
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
    color: "#666",
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
    backgroundColor: "#f0f0f0",
    color: "#333",
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
    color: "#d32f2f",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(88px, 112px))",
    gap: 12,
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
    backgroundColor: "#f5f5f5",
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
    fontSize: 11,
    fontWeight: 500,
    color: "#fff",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
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
    width: 36,
    height: 36,
    border: "none",
    borderRadius: 6,
    backgroundColor: "#f0f0f0",
    color: "#333",
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
    color: "#666",
    fontStyle: "italic",
  },
};

export default ReportMediaPicker;