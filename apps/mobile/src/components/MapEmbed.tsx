import { AnimatePresence, motion } from "framer-motion";
import { MapPin } from "lucide-react";
import { motionDurations, motionEasings } from "./uiMotion";

interface MapEmbedProps {
  lat?: number | null;
  lng?: number | null;
  label?: string | null;
}

/** Empty-state <-> map crossfade; both panes are absolutely stacked (no reflow). */
const embedTransition = {
  type: "tween",
  duration: motionDurations.standard,
  ease: motionEasings.out,
} as const;

function embedSrc(lat?: number | null, lng?: number | null, label?: string | null): string | null {
  if (lat != null && lng != null) {
    return `https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
  }
  const q = label?.trim();
  if (!q) return null;
  return `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=15&output=embed`;
}

/**
 * Keyless embedded Google Map for an approximate one-time location.
 * Neutral empty state: no coordinates and no label renders a placeholder
 * instead of silently defaulting to a hardcoded place. The iframe fades in
 * over the reserved 12rem area when the source appears — the element is in
 * the DOM from that commit, only its opacity animates.
 */
export function MapEmbed({ lat, lng, label }: MapEmbedProps) {
  const src = embedSrc(lat, lng, label);

  return (
    <div className="overflow-hidden rounded-m3-md border border-outline-variant">
      <div className="relative h-48 w-full">
        <AnimatePresence initial={false}>
          {src ? (
            <motion.div
              key="map"
              className="absolute inset-0 bg-surface-container"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={embedTransition}
              data-testid="map-embed-frame"
            >
              <iframe
                title="Map"
                className="h-full w-full"
                src={src}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-container px-6 text-center"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={embedTransition}
            >
              <MapPin size={20} className="text-on-surface-variant" aria-hidden />
              <p className="text-sm text-on-surface-variant">
                No location yet — type a place or paste a Maps link to preview it here.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {label && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-on-surface-variant">
          <MapPin size={13} aria-hidden />
          <span className="truncate">{label}</span>
        </div>
      )}
    </div>
  );
}
