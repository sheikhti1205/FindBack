import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefCallback } from "react";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { ChevronLeft, ChevronRight, ImageOff, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import { usePhotoViewport } from "../hooks/usePhotoViewport";
import {
  backdropTransition,
  dialogVariants,
  motionDurations,
  motionEasings,
  pressFeedback,
  sheetTransition,
  shouldReduceMotion,
} from "./uiMotion";

export interface PhotoLightboxPhoto {
  id: string;
  previewUrl: string;
}

/**
 * Viewport-space rect of the thumbnail that opened the lightbox. The panel
 * scales/translates out of it on the way in and collapses back into it on
 * the way out (FLIP-style shared element). Absent or degenerate rects fall
 * back to the plain centered `dialogVariants` scale.
 */
export interface PhotoLightboxOriginRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhotoLightboxProps {
  photo: PhotoLightboxPhoto | null;
  index?: number;
  total?: number;
  onClose: () => void;
  /** Thumbnail rect for the shared-element travel; omit for a center scale. */
  originRect?: PhotoLightboxOriginRect | null;
  /** Previous/next navigation (parent owns wrap-around). */
  onPrev?: () => void;
  onNext?: () => void;
  /** Full gallery for direct thumbnail selection; optional for single previews. */
  photos?: PhotoLightboxPhoto[];
  onSelect?: (index: number) => void;
  title?: string;
}

/**
 * Live "still open" flag. `AnimatePresence` freezes the exiting child's
 * props, so an exiting element can only learn about a state change through
 * context — this is how the overlay stops capturing pointer input the moment
 * a close begins instead of waiting for the exit animation to finish.
 */
const OpenContext = createContext(true);

const imageStateFade = {
  type: "tween",
  duration: motionDurations.fast,
  ease: motionEasings.inOut,
} as const;

const PANEL_CLASS = "relative flex max-h-full w-full max-w-3xl flex-col items-center gap-3 overflow-y-auto";

/**
 * Full-size preview opened from a media tile (R-047). Tapping a thumbnail
 * must not hide identifying text, so the image is shown at natural size
 * inside a dismissible modal.
 *
 * Motion: the panel grows out of the tapped thumbnail (two-pass FLIP
 * measurement, center scale as the fallback), the backdrop fades with the
 * backdrop token, and closing collapses the panel back into the thumbnail.
 * Photo-to-photo movement is the canonical continuous paging shared with the
 * Home feed carousel: at fit zoom the stage is a native scroll-snap track,
 * so one finger pages through photos with the finger tracked the whole way
 * (swiping can never close or double-navigate). Pinch/double-tap zoom and
 * pan-while-zoomed are retained; while zoomed the track locks so drags pan
 * the photo instead of paging. All values come from `uiMotion` tokens;
 * `<MotionConfig reducedMotion="user">` at the app root collapses travel to
 * instant while keeping the opacity fades.
 */
export function PhotoLightbox({
  photo,
  index,
  total,
  onClose,
  originRect,
  onPrev,
  onNext,
  photos,
  onSelect,
  title,
}: PhotoLightboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const open = photo !== null;
  const setRef = useFocusTrap(containerRef, onClose, open);
  useModalBack(open, onClose);

  // Keep the last photo (and its position) so the exit animation still shows
  // the real image instead of a blank overlay.
  const lastRef = useRef<{ photo: PhotoLightboxPhoto; index?: number; total?: number } | null>(null);
  if (photo) lastRef.current = { photo, index, total };
  const active = photo ?? lastRef.current?.photo ?? null;
  const activeIndex = photo ? index : lastRef.current?.index;
  const activeTotal = photo ? total : lastRef.current?.total;

  // The pager gallery: the full `photos` array when one is provided,
  // otherwise the single photo under inspection. Swiping pages only when
  // there is more than one photo; single previews keep discrete nav.
  const gallery = photos && photos.length > 0 ? photos : active ? [active] : [];
  const pagerIndex =
    activeIndex === undefined
      ? 0
      : Math.max(0, Math.min(gallery.length - 1, activeIndex));

  const caption =
    activeIndex !== undefined && activeTotal !== undefined
      ? `Photo ${activeIndex + 1} of ${activeTotal}`
      : "Full size photo";
  const showNav = (onPrev !== undefined || onNext !== undefined) && (activeTotal ?? 0) > 1;

  return (
    <OpenContext.Provider value={open}>
      <AnimatePresence>
        {open && active ? (
          <LightboxShell
            key="photo-lightbox"
            caption={caption}
            photo={active}
            gallery={gallery}
            pagerIndex={pagerIndex}
            originRect={originRect}
            onClose={onClose}
            onPrev={onPrev}
            onNext={onNext}
            showNav={showNav}
            photos={photos}
            selectedIndex={activeIndex}
            onSelect={onSelect}
            title={title}
            setDialogRef={setRef}
          />
        ) : null}
      </AnimatePresence>
    </OpenContext.Provider>
  );
}

/** Restores `document.body.style.overflow` when the overlay unmounts. */
function BodyScrollLock(): null {
  useLayoutEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  return null;
}

interface LightboxShellProps {
  caption: string;
  photo: PhotoLightboxPhoto;
  /** Full pager gallery (single entry when no `photos` array is provided). */
  gallery: PhotoLightboxPhoto[];
  /** Parent-driven page position, clamped by the caller. */
  pagerIndex: number;
  originRect?: PhotoLightboxOriginRect | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  showNav: boolean;
  setDialogRef: RefCallback<HTMLElement | null>;
  photos?: PhotoLightboxPhoto[];
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  title?: string;
}

function LightboxShell(props: LightboxShellProps): ReactNode {
  const open = useContext(OpenContext);
  return (
    <motion.div
      data-testid="photo-lightbox"
      className="fb-photo-overlay fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4"
      style={{ pointerEvents: open ? "auto" : "none" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={backdropTransition}
    >
      <BodyScrollLock />
      <LightboxPanel {...props} />
    </motion.div>
  );
}

function LightboxPanel({
  caption,
  photo,
  gallery,
  pagerIndex,
  originRect,
  onClose,
  onPrev,
  onNext,
  showNav,
  setDialogRef,
  photos,
  selectedIndex,
  onSelect,
  title,
}: LightboxShellProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number; scale: number } | null>(null);
  const [measured, setMeasured] = useState(originRect == null);

  // Continuous paging (C1): at fit zoom the stage is a native scroll-snap
  // track — the same one-finger paging behavior as the Home feed carousel.
  // The scroll position drives navigation through `onSelect`; the parent owns
  // the index, so buttons, keys, thumbnails, and dots all converge on the
  // same position and the track syncs to it without fighting the finger.
  const pagerMode = gallery.length > 1;
  const pagerTrackRef = useRef<HTMLDivElement | null>(null);
  const [uncontrolledIndex, setUncontrolledIndex] = useState(pagerIndex);
  const viewIndex = onSelect ? pagerIndex : Math.max(0, Math.min(gallery.length - 1, uncontrolledIndex));
  const safeViewIndex = Math.max(0, Math.min(gallery.length - 1, viewIndex));
  const activePhoto = gallery[safeViewIndex] ?? photo;

  const inspection = usePhotoViewport(activePhoto.id, activePhoto.previewUrl, onPrev, onNext, {
    // Pager-owned swipes navigate through scroll. Stepping on release too
    // would advance twice per swipe; explicit controls still navigate.
    swipeNav: !pagerMode,
  });
  const zoomed = inspection.viewport.scale > 1;

  const onPagerScroll = () => {
    if (!pagerMode) return;
    const el = pagerTrackRef.current;
    if (!el) return;
    const width = el.clientWidth || 1;
    const next = Math.max(0, Math.min(gallery.length - 1, Math.round(el.scrollLeft / width)));
    if (next === safeViewIndex) return;
    if (onSelect) onSelect(next);
    else setUncontrolledIndex(next);
  };

  const firstSyncRef = useRef(true);
  useLayoutEffect(() => {
    const first = firstSyncRef.current;
    firstSyncRef.current = false;
    if (!pagerMode) return;
    const el = pagerTrackRef.current;
    if (!el) return;
    const width = el.clientWidth || 0;
    if (width <= 0) return;
    const want = safeViewIndex * width;
    // The user's own scroll already sits on the target page: the threshold
    // turns that into a no-op instead of fighting the snap.
    if (Math.abs(el.scrollLeft - want) > width / 2) {
      const behavior: ScrollBehavior = first || shouldReduceMotion() ? "auto" : "smooth";
      if (typeof el.scrollTo === "function") el.scrollTo({ left: want, behavior });
      else el.scrollLeft = want;
    }
  }, [pagerMode, safeViewIndex, gallery.length]);

  // Two-pass measurement: while the origin is unknown the panel renders as an
  // invisible stand-in, its rect is read in a layout effect (before paint),
  // and the motion panel then mounts with the FLIP transform already applied
  // — so the first painted frame is the thumbnail, never a flash of the final
  // position. The panel unmounts with the shell, so each open re-measures.
  useLayoutEffect(() => {
    if (!originRect || measured) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || originRect.width <= 0) {
      setOrigin(null);
      setMeasured(true);
      return;
    }
    setOrigin({
      x: originRect.x - rect.left,
      y: originRect.y - rect.top,
      scale: originRect.width / rect.width,
    });
    setMeasured(true);
  }, [originRect, measured]);

  if (originRect && !measured) {
    return (
      <div
        ref={panelRef}
        className={PANEL_CLASS}
        style={{ visibility: "hidden" }}
        aria-hidden="true"
      />
    );
  }

  const shared = origin
    ? { opacity: 0, x: origin.x, y: origin.y, scale: origin.scale }
    : null;

  return (
    <motion.div
      ref={(element: HTMLDivElement | null) => {
        panelRef.current = element;
        setDialogRef(element);
      }}
      role="dialog"
      aria-modal="true"
      aria-label={caption}
      className={PANEL_CLASS}
      data-testid="photo-lightbox-panel"
      initial={shared ?? dialogVariants.hidden}
      // With a shared origin the target must restate `x` explicitly — a
      // property missing from `animate` stays pinned at its initial value.
      animate={shared ? { opacity: 1, x: 0, y: 0, scale: 1 } : dialogVariants.visible}
      exit={shared ?? dialogVariants.exit}
      transition={sheetTransition}
      style={{ transformOrigin: origin ? "top left" : "center center" }}
      onKeyDown={inspection.onKeyDown}
    >
      <header className="flex w-full shrink-0 items-center gap-3 text-white">
        <button type="button" aria-label="Close photo preview" onClick={onClose} className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface"><ChevronLeft size={24} aria-hidden /></button>
        <div className="min-w-0 flex-1 text-center">
          <p className="font-semibold" role="status">{caption}</p>
          {title && <p className="truncate text-sm text-white/80">{title}</p>}
        </div>
        <span className="w-12" aria-hidden />
      </header>
      <div className="relative h-[55dvh] min-h-40 w-full shrink-0">
        <div
          ref={(element: HTMLDivElement | null) => {
            pagerTrackRef.current = element;
            inspection.stageRef.current = element;
          }}
          className={
            pagerMode
              ? `flex h-full w-full rounded-m3-lg ${
                  zoomed ? "overflow-hidden" : "snap-x snap-mandatory overflow-x-auto"
                }`
              : "relative h-full w-full overflow-hidden rounded-m3-lg"
          }
          // At fit zoom the browser owns horizontal paging (pinch-zoom stays
          // owned by the hook: pan-x/pan-y admits scroll, never page zoom).
          // Zoomed — or the discrete single mode — the hook owns every touch.
          style={{ touchAction: pagerMode && !zoomed ? "pan-x pan-y" : "none", scrollbarWidth: "none" }}
          data-testid="lightbox-stage"
          role={pagerMode ? "group" : undefined}
          aria-label={pagerMode ? "Report photos" : undefined}
          onScroll={pagerMode ? onPagerScroll : undefined}
          {...inspection.handlers}
        >
          {pagerMode ? (
            gallery.map((entry, i) => {
              const isActive = i === safeViewIndex;
              return (
                <div
                  key={entry.id}
                  data-testid="lightbox-slide"
                  className="flex h-full w-full shrink-0 snap-center items-center justify-center"
                >
                  <div
                    {...(isActive ? { "data-testid": "lightbox-zoom-content" } : {})}
                    className="flex h-full w-full items-center justify-center"
                    style={
                      isActive
                        ? {
                            transform: `translate(${inspection.viewport.x}px, ${inspection.viewport.y}px) scale(${inspection.viewport.scale})`,
                          }
                        : undefined
                    }
                  >
                    <LightboxImage
                      src={entry.previewUrl}
                      alt={`Photo ${i + 1} of ${gallery.length}`}
                    />
                  </div>
                </div>
              );
            })
          ) : (
            <div
              data-testid="lightbox-zoom-content"
              className="absolute inset-0"
              style={{
                transform: `translate(${inspection.viewport.x}px, ${inspection.viewport.y}px) scale(${inspection.viewport.scale})`,
              }}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <LightboxImage src={photo.previewUrl} alt={caption} />
              </div>
            </div>
          )}
        </div>
        {showNav && onPrev && (
          <div className="absolute inset-y-0 left-0 flex items-center">
            <motion.button
              type="button"
              aria-label="Previous photo"
              onClick={onPrev}
              whileTap={pressFeedback.iconButton}
              className="ml-1 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface shadow"
            >
              <ChevronLeft size={20} aria-hidden />
            </motion.button>
          </div>
        )}
        {showNav && onNext && (
          <div className="absolute inset-y-0 right-0 flex items-center">
            <motion.button
              type="button"
              aria-label="Next photo"
              onClick={onNext}
              whileTap={pressFeedback.iconButton}
              className="mr-1 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface shadow"
            >
              <ChevronRight size={20} aria-hidden />
            </motion.button>
          </div>
        )}
      </div>
      {photos && onSelect && photos.length > 1 && (
        <>
          <div className="flex gap-2" aria-hidden="true">{photos.map((p, i) => <span key={p.id} className={`h-2 w-2 rounded-full border border-white/70 ${i === selectedIndex ? "bg-white" : "bg-transparent"}`} />)}</div>
          <div role="group" aria-label="Photo thumbnails" className="fb-scroll-row flex w-full shrink-0 justify-start gap-2">
            {photos.map((p, i) => (
              <button key={p.id} type="button" aria-label={`View photo ${i + 1}`} aria-pressed={i === selectedIndex} onClick={() => onSelect(i)} className={`h-16 w-16 shrink-0 overflow-hidden rounded-m3-md border-2 ${i === selectedIndex ? "border-white" : "border-transparent opacity-70"}`}>
                <img src={p.previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </>
      )}
      <div role="group" aria-label="Photo zoom" className="flex shrink-0 items-center gap-2 rounded-m3-lg bg-surface p-1 text-on-surface">
        <button type="button" aria-label="Zoom out" disabled={inspection.viewport.scale <= 1} onClick={inspection.zoomOut} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm disabled:opacity-40"><ZoomOut size={20} aria-hidden /></button>
        <span className="min-w-12 text-center text-xs tabular-nums" role="status">{Math.round(inspection.viewport.scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" disabled={inspection.viewport.scale >= 4} onClick={inspection.zoomIn} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm disabled:opacity-40"><ZoomIn size={20} aria-hidden /></button>
        <button type="button" aria-label="Reset zoom" onClick={inspection.reset} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm"><RotateCcw size={18} aria-hidden /></button>
      </div>
      <p className="shrink-0 text-center text-xs text-white/80">{zoomed ? "Drag to pan · Reset zoom to swipe photos" : pagerMode ? "Swipe to browse photos · Pinch or double-tap to zoom" : "Pinch or double-tap to zoom · Swipe to browse"}</p>
    </motion.div>
  );
}

type ImageState = "loading" | "loaded" | "failed";

/**
 * One photo layer: shimmer while loading, fade in on load, fade the
 * failure fallback in (and the shimmer out) on error. The frame exposes
 * `data-state` so tests never have to time opacity frames.
 */
function LightboxImage({ src, alt }: { src: string; alt: string }): ReactNode {
  const present = useIsPresent();
  const [state, setState] = useState<ImageState>("loading");
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Cached images can finish before React attaches the load listener.
  useLayoutEffect(() => {
    const element = imgRef.current;
    if (element?.complete && element.naturalWidth > 0) setState("loaded");
  }, []);

  return (
    <div
      className="relative flex h-full w-full items-center justify-center"
      data-testid="lightbox-image-frame"
      data-state={state}
      aria-hidden={!present || undefined}
    >
      <motion.span
        aria-hidden
        data-testid="lightbox-shimmer"
        className="absolute h-40 w-40 rounded-m3-sm bg-white/10 animate-pulse motion-reduce:animate-none"
        initial={{ opacity: 1 }}
        animate={{ opacity: state === "loading" ? 1 : 0 }}
        transition={imageStateFade}
      />
      <motion.img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        className="max-h-full max-w-full rounded-m3-sm object-contain"
        initial={{ opacity: 0 }}
        animate={{ opacity: state === "loaded" ? 1 : 0 }}
        transition={imageStateFade}
        onLoad={() => setState("loaded")}
        onError={() => setState("failed")}
      />
      {state === "failed" && (
        <motion.div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/80"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={imageStateFade}
        >
          <ImageOff size={24} aria-hidden />
          <span>Photo unavailable</span>
        </motion.div>
      )}
    </div>
  );
}
