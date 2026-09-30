import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Variants } from "framer-motion";
import { ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import { resolveHorizontalSwipe } from "../utils/detailSwipe";
import {
  backdropTransition,
  dialogVariants,
  motionDurations,
  motionEasings,
  pageBackwardVariants,
  pageForwardVariants,
  pressFeedback,
  sheetTransition,
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
}

type Direction = "forward" | "backward";

/**
 * Live "still open" flag. `AnimatePresence` freezes the exiting child's
 * props, so an exiting element can only learn about a state change through
 * context — this is how the overlay stops capturing pointer input the moment
 * a close begins instead of waiting for the exit animation to finish.
 */
const OpenContext = createContext(true);

/** Photo-to-photo crossfade: enters from the leading edge, leaves the other. */
const photoCrossfadeVariants: Variants = {
  hidden: (direction: Direction) =>
    direction === "backward" ? pageBackwardVariants.hidden : pageForwardVariants.hidden,
  visible: (direction: Direction) =>
    direction === "backward" ? pageBackwardVariants.visible : pageForwardVariants.visible,
  exit: (direction: Direction) =>
    direction === "backward" ? pageBackwardVariants.exit : pageForwardVariants.exit,
};

const photoCrossfade = {
  type: "tween",
  duration: motionDurations.standard,
  ease: motionEasings.out,
} as const;

const imageStateFade = {
  type: "tween",
  duration: motionDurations.fast,
  ease: motionEasings.inOut,
} as const;

const PANEL_CLASS = "relative flex max-h-full w-full max-w-3xl flex-col items-center gap-3";

/**
 * Full-size preview opened from a media tile (R-047). Tapping a thumbnail
 * must not hide identifying text, so the image is shown at natural size
 * inside a dismissible modal.
 *
 * Motion (Wave B): the panel grows out of the tapped thumbnail (two-pass
 * FLIP measurement, center scale as the fallback), the backdrop fades with
 * the backdrop token, adjacent photos crossfade with a directional nudge,
 * and closing collapses the panel back into the thumbnail. All values come
 * from `uiMotion` tokens; `<MotionConfig reducedMotion="user">` at the app
 * root collapses the travel to instant while keeping the opacity fades.
 */
export function PhotoLightbox({
  photo,
  index,
  total,
  onClose,
  originRect,
  onPrev,
  onNext,
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

  // Direction of the current photo-to-photo change; resolved by the entering
  // layer itself and handed to exiting layers through AnimatePresence's
  // `custom`, so both sides of the crossfade always agree.
  const directionRef = useRef<Direction>("forward");
  const lastIndexRef = useRef<number | undefined>(undefined);
  if (photo && index !== undefined) {
    const previous = lastIndexRef.current;
    lastIndexRef.current = index;
    if (previous !== undefined && previous !== index) {
      directionRef.current = index > previous ? "forward" : "backward";
    }
  }
  const direction = directionRef.current;

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
            direction={direction}
            originRect={originRect}
            onClose={onClose}
            onPrev={onPrev}
            onNext={onNext}
            showNav={showNav}
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
  direction: Direction;
  originRect?: PhotoLightboxOriginRect | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  showNav: boolean;
  setDialogRef: RefCallback<HTMLElement | null>;
}

function LightboxShell(props: LightboxShellProps): ReactNode {
  const open = useContext(OpenContext);
  return (
    <motion.div
      data-testid="photo-lightbox"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4"
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
  direction,
  originRect,
  onClose,
  onPrev,
  onNext,
  showNav,
  setDialogRef,
}: LightboxShellProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number; scale: number } | null>(null);
  const [measured, setMeasured] = useState(originRect == null);
  // Touch swipe: horizontal flicks change photo, vertical/small drags ignored.
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function handleTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (t) touchStart.current = { x: t.clientX, y: t.clientY };
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    const end = e.changedTouches[0];
    if (!start || !end) return;
    const dir = resolveHorizontalSwipe(end.clientX - start.x, end.clientY - start.y, 0);
    if (dir === "next") onNext?.();
    else if (dir === "prev") onPrev?.();
  }

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
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && onPrev) {
          event.preventDefault();
          onPrev();
        } else if (event.key === "ArrowRight" && onNext) {
          event.preventDefault();
          onNext();
        }
      }}
    >
      <div
        className="relative h-[70vh] w-full"
        data-testid="lightbox-stage"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <AnimatePresence initial={false} custom={direction}>
          <motion.div
            key={photo.id}
            data-testid="photo-layer"
            custom={direction}
            variants={photoCrossfadeVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={photoCrossfade}
            className="absolute inset-0 flex items-center justify-center"
          >
            <LightboxImage src={photo.previewUrl} alt={caption} />
          </motion.div>
        </AnimatePresence>
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
      <p className="text-sm text-white/90">{caption}</p>
      <motion.button
        type="button"
        aria-label="Close photo preview"
        onClick={onClose}
        whileTap={pressFeedback.iconButton}
        className="absolute right-0 top-0 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface shadow"
      >
        <X size={18} aria-hidden />
      </motion.button>
    </motion.div>
  );
}

type ImageState = "loading" | "loaded" | "failed";

/**
 * One photo layer: shimmer while loading, crossfade in on load, fade the
 * failure fallback in (and the shimmer out) on error. The frame exposes
 * `data-state` so tests never have to time opacity frames.
 */
function LightboxImage({ src, alt }: { src: string; alt: string }): ReactNode {
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
