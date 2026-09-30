import { useRef, useState } from "react";
import type { MouseEvent } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  sharedElementTransition,
  sharedMediaLayoutId,
} from "../PostCardContent";
import { motionDurations, motionEasings } from "../uiMotion";
import { resolveHorizontalSwipe } from "../../utils/detailSwipe";
import type { PhotoLightboxOriginRect } from "../PhotoLightbox";

export interface DetailHeroImage {
  fileUrl: string;
}

interface DetailHeroGalleryProps {
  postId: string;
  title: string;
  images: DetailHeroImage[];
  onOpenLightbox?: (index: number, origin: PhotoLightboxOriginRect | null) => void;
}

/**
 * Detail hero gallery: full card width, 16:10 cover frame, rounded 18-20px,
 * no photo border, stable reserved height, counter + dots, accessible
 * Prev/Next when multiple, horizontal touch swipe (left=next, right=prev).
 * Vertical-dominant gestures and small drags are ignored so page scroll wins.
 * Motion uses existing uiMotion tokens only — no carousel/gesture dependency.
 */
export function DetailHeroGallery({ postId, title, images, onOpenLightbox }: DetailHeroGalleryProps) {
  const [selected, setSelected] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const mediaId = sharedMediaLayoutId(postId);

  // Capture the tapped frame's rect so the lightbox can FLIP out of it.
  function openAt(index: number, e: MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    onOpenLightbox?.(
      index,
      rect.width > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    );
  }
  if (images.length === 0) return null;

  if (images.length === 1) {
    const only = images[0]!;
    return (
      <div className="w-full overflow-hidden rounded-[18px]">
        <button
          type="button"
          onClick={(e) => openAt(0, e)}
          aria-label={`Open photo for ${title} fullscreen`}
          className="block w-full"
        >
          <motion.img
            key={only.fileUrl}
            src={only.fileUrl}
            alt={`Photo for ${title}`}
            className="aspect-[16/10] w-full object-cover"
            layoutId={mediaId}
            data-shared-media={mediaId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={sharedElementTransition}
          />
        </button>
      </div>
    );
  }

  const safeSelected = Math.min(selected, images.length - 1);
  const current = images[safeSelected]!;
  const go = (dir: "next" | "prev") =>
    setSelected((s) => (dir === "next" ? (s + 1) % images.length : (s - 1 + images.length) % images.length));

  return (
    <figure className="w-full">
      <div
        data-testid="detail-hero-stage"
        className="relative w-full overflow-hidden rounded-[18px]"
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (t) touchStart.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchMove={() => {
          // Let vertical-dominant gestures scroll the page: do not preventDefault.
        }}
        onTouchEnd={(e) => {
          const start = touchStart.current;
          touchStart.current = null;
          const end = e.changedTouches[0];
          if (!start || !end) return;
          const dir = resolveHorizontalSwipe(end.clientX - start.x, end.clientY - start.y, 0);
          if (dir) go(dir);
        }}
      >
        <button
          type="button"
          onClick={(e) => openAt(safeSelected, e)}
          aria-label={`Open photo ${safeSelected + 1} of ${images.length} fullscreen`}
          className="block w-full"
        >
          <motion.img
            key={current.fileUrl}
            src={current.fileUrl}
            alt={`Photo ${safeSelected + 1} of ${images.length} for ${title}`}
            className="aspect-[16/10] w-full object-cover"
            layoutId={mediaId}
            data-shared-media={mediaId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
          />
        </button>
        <span
          role="status"
          aria-label={`Photo ${safeSelected + 1} of ${images.length}`}
          className="absolute right-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white"
        >
          {safeSelected + 1} / {images.length}
        </span>
        <button
          type="button"
          aria-label="Previous photo"
          onClick={() => go("prev")}
          className="absolute inset-y-0 left-0 flex items-center pl-1"
        >
          <span className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface shadow">
            <ChevronLeft size={20} aria-hidden />
          </span>
        </button>
        <button
          type="button"
          aria-label="Next photo"
          onClick={() => go("next")}
          className="absolute inset-y-0 right-0 flex items-center pr-1"
        >
          <span className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface shadow">
            <ChevronRight size={20} aria-hidden />
          </span>
        </button>
      </div>
      <figcaption className="sr-only" role="status">
        Photo {safeSelected + 1} of {images.length}
      </figcaption>
      <div role="tablist" aria-label="Report photos" className="mt-2 flex items-center justify-center gap-2">
        {images.map((img, i) => (
          <button
            key={`${img.fileUrl}#${i}`}
            type="button"
            role="tab"
            aria-selected={i === safeSelected}
            aria-label={`Show photo ${i + 1}`}
            onClick={() => setSelected(i)}
            className={`h-2 rounded-full transition-colors ${
              i === safeSelected ? "w-6 bg-on-surface" : "w-2 bg-outline-variant"
            }`}
          />
        ))}
      </div>
    </figure>
  );
}
