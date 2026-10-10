import { useState } from "react";
import type { MouseEvent } from "react";
import { motion } from "framer-motion";
import { ImageOff } from "lucide-react";
import {
  sharedElementTransition,
  sharedMediaLayoutId,
} from "../PostCardContent";
import { usePagerTap, useSnapPager } from "../photoPager";
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
 * Detail hero gallery: the canonical continuous-paging behavior shared with
 * the Home feed carousel — a 16:10 cover viewport with a native horizontal
 * scroll-snap track, one-finger paging, vertical page scroll untouched, short
 * drags snapping back. Every photo stays mounted side by side; the index is
 * derived from scroll position, never from a touchEnd→index→fade swap.
 *
 * Chrome stays off the pixels: the position (counter) and the dot affordance
 * live BELOW the frame, never overlaid, and tapping a photo (not swiping)
 * opens the lightbox at that photo's index.
 */
export function DetailHeroGallery({ postId, title, images, onOpenLightbox }: DetailHeroGalleryProps) {
  const { trackRef, active, onScroll, goTo } = useSnapPager(images.length);
  const { pressStart, isTap } = usePagerTap();
  const mediaId = sharedMediaLayoutId(postId);

  // Capture the tapped frame's rect so the lightbox can FLIP out of it.
  // A press that travelled is a page gesture, never an open.
  function openAt(index: number, e: MouseEvent<HTMLButtonElement>) {
    if (!isTap(e)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onOpenLightbox?.(
      index,
      rect.width > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    );
  }
  if (images.length === 0) return null;

  const safeActive = Math.min(active, images.length - 1);

  return (
    <figure className="w-full">
      <div className="relative w-full overflow-hidden rounded-[18px]" style={{ aspectRatio: "16 / 10" }}>
        <div
          ref={trackRef}
          data-testid="detail-hero-track"
          role="group"
          aria-label="Report photos"
          onScroll={onScroll}
          className="flex h-full w-full snap-x snap-mandatory overflow-x-auto"
          style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
        >
          {images.map((image, index) => (
            <button
              key={`${image.fileUrl}#${index}`}
              type="button"
              data-testid="detail-hero-slide"
              onMouseDown={(e) => pressStart(e.clientX, e.clientY)}
              onTouchStart={(e) => {
                const t = e.touches[0];
                if (t) pressStart(t.clientX, t.clientY);
              }}
              onClick={(e) => openAt(index, e)}
              aria-label={
                images.length === 1
                  ? `Open photo for ${title} fullscreen`
                  : `Open photo ${index + 1} of ${images.length} fullscreen`
              }
              className="block h-full w-full shrink-0 snap-center overflow-hidden p-0"
            >
              <HeroImage
                fileUrl={image.fileUrl}
                alt={
                  images.length === 1
                    ? `Photo for ${title}`
                    : `Photo ${index + 1} of ${images.length} for ${title}`
                }
                sharedId={index === 0 ? mediaId : undefined}
              />
            </button>
          ))}
        </div>
      </div>
      {images.length > 1 && (
        <div className="mt-2 flex items-center justify-center gap-3">
          <span role="status" aria-label={`Photo ${safeActive + 1} of ${images.length}`} className="text-xs font-medium tabular-nums text-on-surface-variant">
            {safeActive + 1} / {images.length}
          </span>
          <div role="tablist" aria-label="Report photos" className="flex items-center justify-center gap-2">
            {images.map((img, i) => (
              <button
                key={`${img.fileUrl}#${i}`}
                type="button"
                role="tab"
                aria-selected={i === safeActive}
                aria-label={`Show photo ${i + 1}`}
                onClick={() => goTo(i)}
                className={`h-2 rounded-full transition-colors ${
                  i === safeActive ? "w-6 bg-on-surface" : "w-2 bg-outline-variant"
                }`}
              />
            ))}
          </div>
        </div>
      )}
      <figcaption className="sr-only" role="status">
        Photo {safeActive + 1} of {images.length}
      </figcaption>
    </figure>
  );
}

function HeroImage({ fileUrl, alt, sharedId }: { fileUrl: string; alt: string; sharedId?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const shared = sharedId ? { layoutId: sharedId, "data-shared-media": sharedId } : {};
  if (failed) {
    return (
      <span className="flex aspect-[16/10] w-full items-center justify-center gap-1.5 bg-surface-container text-sm text-on-surface-variant" role="img" aria-label="Photo unavailable" {...shared}>
        <ImageOff size={16} aria-hidden />
        Photo unavailable
      </span>
    );
  }
  return (
    <motion.img
      src={fileUrl}
      alt={alt}
      loading={loaded ? undefined : "lazy"}
      draggable={false}
      className="aspect-[16/10] w-full object-cover"
      {...shared}
      initial={{ opacity: 0 }}
      animate={{ opacity: loaded ? 1 : 0 }}
      transition={sharedElementTransition}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}
