import { useState } from "react";
import type { MouseEvent } from "react";
import { motion } from "framer-motion";
import { ImageOff } from "lucide-react";
import { fadeVariants, motionDurations, motionEasings } from "./uiMotion";
import { usePagerTap, useSnapPager } from "./photoPager";

export interface FeedCarouselImage {
  id: string;
  fileUrl: string;
  alt: string;
}

interface FeedMediaCarouselProps {
  images: FeedCarouselImage[];
  /**
   * Shared-element layout id applied to the first (index 0) frame so the
   * Home card ⇄ Post Detail media pair travels together. Undefined when the
   * shared element is disabled (stray cards must never duplicate a layoutId).
   */
  sharedMediaId?: string;
  /** Open the canonical PhotoLightbox at the tapped image's index. */
  onOpenImage: (index: number) => void;
}

type ImageState = "loading" | "loaded" | "failed";

/** Above this many images the dots collapse to a window around the active one. */
const MAX_VISIBLE_DOTS = 7;

const imageFade = { duration: motionDurations.fast, ease: motionEasings.inOut } as const;

/**
 * Home-feed media carousel: a full/wide 4:3 viewport with native horizontal
 * scroll-snap for one-finger swiping. Dots live INSIDE the media area, are
 * omitted for a single image, and collapse to a compact window when there are
 * many. Tapping a photo opens the canonical PhotoLightbox at that photo's
 * index; a swipe only changes the visible photo and can never navigate the
 * post because the media region is a sibling of the detail link, never inside
 * it. The active index lives here and survives ordinary parent rerenders.
 */
export function FeedMediaCarousel({ images, sharedMediaId, onOpenImage }: FeedMediaCarouselProps) {
  // Canonical continuous paging: native scroll-snap track; the active index
  // is derived from scroll position and survives ordinary parent rerenders.
  const { trackRef, active, onScroll, goTo } = useSnapPager(images.length);
  const { pressStart, isTap } = usePagerTap();

  const onSlideClick = (index: number, event: MouseEvent<HTMLButtonElement>) => {
    if (!isTap(event)) return;
    onOpenImage(index);
  };

  return (
    <div
      data-testid="feed-media-viewport"
      className="fb-home-media-viewport relative w-full overflow-hidden"
      style={{ aspectRatio: "4 / 3" }}
    >
      <div
        ref={trackRef}
        data-testid="feed-media-track"
        role="group"
        aria-label="Report photos"
        onScroll={onScroll}
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
      >
        {images.map((image, index) => (
          <button
            key={image.id}
            type="button"
            data-testid="feed-slide"
            aria-label={image.alt}
            onMouseDown={(e) => pressStart(e.clientX, e.clientY)}
            onTouchStart={(e) => {
              const t = e.touches[0];
              if (t) pressStart(t.clientX, t.clientY);
            }}
            onClick={(e) => onSlideClick(index, e)}
            className="relative block h-full w-full shrink-0 snap-center overflow-hidden p-0"
          >
            <CarouselImage
              image={image}
              sharedId={index === 0 ? sharedMediaId : undefined}
            />
          </button>
        ))}
      </div>

      {images.length > 1 && (
        <div
          data-testid="feed-media-dots"
          className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/35 px-2 py-1"
        >
          {windowedDots(active, images.length).map((entry, position) =>
            entry === "gap" ? (
              <span
                key={`gap-${position}`}
                data-testid="carousel-dots-ellipsis"
                aria-hidden
                className="px-0.5 text-[10px] leading-none text-white/70"
              >
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                data-testid="carousel-dot"
                data-index={entry}
                aria-current={entry === active ? "true" : undefined}
                aria-label={`Go to photo ${entry + 1}`}
                onClick={() => goTo(entry)}
                className={`h-1.5 rounded-full transition-all ${
                  entry === active ? "w-4 bg-white" : "w-1.5 bg-white/60"
                }`}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Compact windowed dot list: first, last, and a small window around active. */
function windowedDots(active: number, total: number): Array<number | "gap"> {
  if (total <= MAX_VISIBLE_DOTS) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const keep = new Set<number>(
    [0, total - 1, active - 1, active, active + 1].filter((n) => n >= 0 && n < total),
  );
  const indices = [...keep].sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  let previous = -1;
  for (const n of indices) {
    if (previous >= 0 && n - previous > 1) out.push("gap");
    out.push(n);
    previous = n;
  }
  return out;
}

function CarouselImage({ image, sharedId }: { image: FeedCarouselImage; sharedId?: string }) {
  const [state, setState] = useState<ImageState>("loading");
  const shared = sharedId ? { layoutId: sharedId, "data-shared-media": sharedId } : {};
  const frameStyle = { width: "100%", height: "100%" } as const;
  if (state === "failed") {
    return (
      <motion.span
        className="fb-feed-img"
        data-state="failed"
        data-testid="post-image-state"
        style={frameStyle}
        {...shared}
      >
        <motion.span
          className="fb-img-fallback"
          role="img"
          aria-label="Photo unavailable"
          variants={fadeVariants}
          initial="hidden"
          animate="visible"
          transition={imageFade}
        >
          <ImageOff size={16} aria-hidden />
          Photo unavailable
        </motion.span>
      </motion.span>
    );
  }
  return (
    <motion.span
      className="fb-feed-img"
      data-state={state}
      data-testid="post-image-state"
      style={frameStyle}
      {...shared}
    >
      <motion.img
        src={image.fileUrl}
        alt={image.alt}
        loading="lazy"
        draggable={false}
        initial={{ opacity: 0 }}
        animate={{ opacity: state === "loaded" ? 1 : 0 }}
        transition={imageFade}
        onLoad={() => setState("loaded")}
        onError={() => setState("failed")}
      />
    </motion.span>
  );
}
