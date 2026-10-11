import { AnimatePresence, motion } from "framer-motion";
import { MapPin } from "lucide-react";
import { motionDurations, motionEasings } from "./uiMotion";
import { rasterTilesForCenter, RASTER_ATTRIBUTION } from "../services/location/rasterTiles";
import { PIN_ZOOM } from "../services/location/mapPickerState";

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

function toCoords(lat?: number | null, lng?: number | null): { lat: number; lng: number } | null {
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }
  return { lat, lng };
}

/**
 * Keyless location preview for a one-time approximate location.
 *
 * Coordinates render a static OSM raster grid with a center pin; label-only
 * drafts render a neutral placeholder instead of silently defaulting to a
 * hardcoded place. The grid crossfades in over the reserved 12rem area when
 * coordinates appear — the element is in the DOM from that commit, only its
 * opacity animates. No geocoding is attempted, no coordinates fabricated.
 */
export function MapEmbed({ lat, lng, label }: MapEmbedProps) {
  const coords = toCoords(lat, lng);
  const tiles = coords ? rasterTilesForCenter(coords, PIN_ZOOM) : [];

  return (
    <div className="overflow-hidden rounded-m3-md border border-outline-variant">
      <div className="relative h-48 w-full">
        <AnimatePresence initial={false}>
          {coords ? (
            <motion.div
              key="map"
              className="absolute inset-0 bg-surface-container"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={embedTransition}
              data-testid="map-embed-frame"
              role="region"
              aria-label="Location preview"
            >
              <div className="absolute inset-0 grid grid-cols-3 grid-rows-3" aria-hidden="true">
                {tiles.map((tile, index) => (
                  <img
                    key={`${tile.z}/${tile.x}/${tile.y}#${index}`}
                    src={tile.url}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ))}
              </div>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <MapPin size={24} className="text-on-surface drop-shadow" aria-hidden />
              </div>
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
      {coords && (
        <p className="px-3 pb-2 text-xs text-on-surface-variant">{RASTER_ATTRIBUTION}</p>
      )}
    </div>
  );
}
