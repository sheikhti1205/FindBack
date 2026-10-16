import { useState } from "react";
import type { MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ImageOff } from "lucide-react";
import { usePagerTap, useSnapPager } from "./photoPager";
import { motionDurations, motionEasings } from "./uiMotion";
import type { PhotoLightboxOriginRect } from "./PhotoLightbox";

/**
 * Narrow structural view of a selected report photo; `PickedPhoto` satisfies it.
 * The object URL (`webPath`) is the composer's own preview; it is never the
 * uploaded object.
 */
export interface ReportMediaPhoto {
  id: string;
  webPath: string;
  format?: string;
  motionPhoto?: boolean;
}

export interface ReportPhotoCarouselProps {
  photos: readonly ReportMediaPhoto[];
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "earlier" | "later") => void;
  onMakeCover: (id: string) => void;
  /** `origin` is the tapped slide's viewport rect (lightbox shared element). */
  onPreview: (id: string, origin?: PhotoLightboxOriginRect) => void;
  disabled: boolean;
  /**
   * §8: with the on-screen keyboard up the composer narrows the box so a photo
   * keeps roughly two fifths of the area left above the IME. The parent owns the
   * budget because only the parent can see the visual viewport; omitted means the
   * standalone default ({@link MAX_SLIDE_HEIGHT}).
   */
  maxHeightPx?: number;
}

/**
 * Minimum/maximum slide box. The photo is measured on load and its OWN ratio
 * drives the box, so nothing is ever cropped; the clamps only bound how much
 * vertical room one photo may take (a panorama must not collapse to a sliver,
 * a tall portrait must not push the rest of the form off-screen). Before the
 * first paint the box holds the default 4:3 ratio — the same
 * "absent pair means default ratio" rule the attachment read model uses.
 */
const MIN_SLIDE_HEIGHT_PX = 180;
/** Default box bound; see `maxHeightPx` for the composer's keyboard-up budget. */
const MAX_SLIDE_HEIGHT = "min(58vh, 460px)";
const DEFAULT_SLIDE_RATIO = "4 / 3";

/** Dot visual size inside a 24px minimum target (WCAG 2.2 target size). */
const DOT_TARGET_PX = 24;
const DOT_VISUAL_PX = 8;

const slideTransition = { duration: motionDurations.fast, ease: motionEasings.out } as const;

/**
 * Composer carousel for the selected report photos (packet 05 §4/§6).
 *
 * One large swipeable slide per photo on the shared continuous-paging track
 * (`useSnapPager`/`usePagerTap`) — the same gesture mechanics as the canonical
 * feed carousel, WITHOUT its fixed 4:3 crop. Swiping only changes the visible
 * photo; a tap opens the canonical `PhotoLightbox` at that photo's index. The
 * action row below the track always acts on the ACTIVE photo ("Make cover",
 * "Move left", "Move right", "Remove"), which is the non-drag reorder path and
 * the screen-reader path — no tiny permanent arrows.
 */
export function ReportPhotoCarousel({
  photos,
  onRemove,
  onMove,
  onMakeCover,
  onPreview,
  disabled,
  maxHeightPx,
}: ReportPhotoCarouselProps) {
  const { trackRef, active, onScroll, goTo } = useSnapPager(photos.length);
  const { pressStart, isTap } = usePagerTap();
  const [ratios, setRatios] = useState<Record<string, number>>({});

  const activeIndex = Math.min(active, Math.max(0, photos.length - 1));
  const current = photos[activeIndex];
  const isFirst = activeIndex === 0;
  const isLast = activeIndex === photos.length - 1;

  const originOf = (element: HTMLElement): PhotoLightboxOriginRect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };

  const onSlideClick = (id: string, index: number, event: MouseEvent<HTMLButtonElement>) => {
    // A swipe pages and must never open the viewer; only a real tap opens it.
    if (!isTap(event)) return;
    onPreview(id, originOf(event.currentTarget));
    void index;
  };

  const measure = (id: string, element: HTMLImageElement) => {
    const { naturalWidth, naturalHeight } = element;
    if (!naturalWidth || !naturalHeight) return;
    setRatios((previous) =>
      previous[id] === undefined ? { ...previous, [id]: naturalWidth / naturalHeight } : previous,
    );
  };

  return (
    <div className="flex flex-col gap-2" data-testid="report-photo-carousel">
      <div className="relative w-full">
        <div
          ref={trackRef}
          data-testid="report-photo-track"
          role="list"
          aria-label="Selected photos"
          onScroll={onScroll}
          className="flex w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
          style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
        >
          <AnimatePresence initial={false}>
            {photos.map((photo, index) => (
              <motion.div
                key={photo.id}
                data-testid="report-photo-slide"
                data-photo-id={photo.id}
                data-active={index === activeIndex ? "true" : undefined}
                role="listitem"
                className="w-full shrink-0 snap-center"
                variants={{ hidden: { opacity: 0, scale: 0.98 }, visible: { opacity: 1, scale: 1 } }}
                initial="hidden"
                animate="visible"
                exit={{ opacity: 0 }}
                transition={slideTransition}
              >
                <button
                  type="button"
                  data-testid="report-photo-slide-button"
                  aria-label={`View photo ${index + 1} of ${photos.length} full size`}
                  disabled={disabled}
                  onMouseDown={(event) => pressStart(event.clientX, event.clientY)}
                  onTouchStart={(event) => {
                    const touch = event.touches[0];
                    if (touch) pressStart(touch.clientX, touch.clientY);
                  }}
                  onClick={(event) => onSlideClick(photo.id, index, event)}
                  className="relative block w-full overflow-hidden rounded-m3-md border border-outline-variant bg-surface-container-low p-0"
                  style={{
                    aspectRatio: ratios[photo.id] ?? DEFAULT_SLIDE_RATIO,
                    minHeight: MIN_SLIDE_HEIGHT_PX,
                    maxHeight: maxHeightPx ? `${maxHeightPx}px` : MAX_SLIDE_HEIGHT,
                  }}
                >
                  <SlideImage photo={photo} index={index} total={photos.length} onMeasure={measure} />
                  {index === 0 && (
                    <span
                      data-testid="report-photo-cover-badge"
                      className="absolute left-2 top-2 rounded-full bg-on-surface/85 px-2 py-0.5 text-xs font-medium text-surface"
                    >
                      Cover
                    </span>
                  )}
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {photos.length > 1 && (
          <span
            data-testid="report-photo-position"
            className="pointer-events-none absolute right-2 top-2 rounded-full bg-on-surface/75 px-2 py-0.5 text-xs font-medium text-surface"
          >
            {activeIndex + 1} / {photos.length}
          </span>
        )}
      </div>

      {photos.length > 1 && (
        <div className="flex items-center justify-center gap-1" data-testid="report-photo-dots">
          {photos.map((photo, index) => (
            <button
              key={photo.id}
              type="button"
              data-testid="report-photo-dot"
              data-index={index}
              aria-current={index === activeIndex ? "true" : undefined}
              aria-label={`Go to photo ${index + 1}`}
              onClick={() => goTo(index)}
              className="flex items-center justify-center"
              style={{ width: DOT_TARGET_PX, height: DOT_TARGET_PX }}
            >
              <span
                aria-hidden
                className={`block rounded-full transition-all ${
                  index === activeIndex ? "w-4 bg-on-surface" : "bg-on-surface-variant/50"
                }`}
                style={{ height: DOT_VISUAL_PX }}
              />
            </button>
          ))}
        </div>
      )}

      {current && (
        <div className="flex flex-wrap items-center gap-2" data-testid="report-photo-actions">
          {!isFirst && (
            <button
              type="button"
              onClick={() => onMakeCover(current.id)}
              disabled={disabled}
              aria-label={`Make photo ${activeIndex + 1} the cover`}
              className="flex min-h-12 items-center rounded-m3-sm bg-surface-container px-3 text-sm font-medium text-on-surface disabled:opacity-40"
            >
              Make cover
            </button>
          )}
          {photos.length > 1 && (
            <>
              <IconAction
                label={`Move photo ${activeIndex + 1} left`}
                disabled={disabled || isFirst}
                onClick={() => onMove(current.id, "earlier")}
              >
                <ChevronLeftIcon />
              </IconAction>
              <IconAction
                label={`Move photo ${activeIndex + 1} right`}
                disabled={disabled || isLast}
                onClick={() => onMove(current.id, "later")}
              >
                <ChevronRightIcon />
              </IconAction>
            </>
          )}
          <IconAction
            label={`Remove photo ${activeIndex + 1}`}
            disabled={disabled}
            onClick={() => onRemove(current.id)}
          >
            <TrashIcon />
          </IconAction>
        </div>
      )}
    </div>
  );
}

function SlideImage({
  photo,
  index,
  total,
  onMeasure,
}: {
  photo: ReportMediaPhoto;
  index: number;
  total: number;
  onMeasure: (id: string, element: HTMLImageElement) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="flex h-full w-full items-center justify-center text-on-surface-variant">
        <ImageOff size={20} aria-hidden />
        <span className="sr-only">Photo unavailable</span>
      </span>
    );
  }
  return (
    <img
      src={photo.webPath}
      alt={`Photo ${index + 1} of ${total}`}
      loading="lazy"
      draggable={false}
      onLoad={(event) => onMeasure(photo.id, event.currentTarget)}
      onError={() => setFailed(true)}
      className="h-full w-full object-contain"
    />
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-disabled={disabled}
      className="flex items-center justify-center rounded-m3-sm bg-surface-container text-on-surface disabled:opacity-40"
      style={{ width: 48, height: 48 }}
    >
      {children}
    </button>
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

export default ReportPhotoCarousel;
