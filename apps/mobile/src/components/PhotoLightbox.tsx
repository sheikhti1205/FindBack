import React, { useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";

export interface PhotoLightboxPhoto {
  id: string;
  previewUrl: string;
}

export interface PhotoLightboxProps {
  photo: PhotoLightboxPhoto | null;
  index?: number;
  total?: number;
  onClose: () => void;
}

/**
 * Full-size preview opened from a media tile (R-047). Tapping a thumbnail
 * must not hide identifying text, so the image is shown at natural size
 * inside a dismissible modal.
 */
export function PhotoLightbox({ photo, index, total, onClose }: PhotoLightboxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setRef = useFocusTrap(containerRef, onClose, !!photo);
  useModalBack(!!photo, onClose);

  if (!photo) return null;

  const caption =
    index !== undefined && total !== undefined ? `Photo ${index + 1} of ${total}` : "Full size photo";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4"
      data-testid="photo-lightbox"
    >
      <div
        ref={setRef}
        role="dialog"
        aria-modal="true"
        aria-label={caption}
        className="relative flex max-h-full w-full max-w-3xl flex-col items-center gap-3"
      >
        <img
          src={photo.previewUrl}
          alt={caption}
          className="max-h-[75vh] w-auto max-w-full rounded-m3-sm object-contain"
        />
        <p className="text-sm text-white/90">{caption}</p>
        <button
          type="button"
          aria-label="Close photo preview"
          onClick={onClose}
          className="absolute right-0 top-0 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface shadow"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
