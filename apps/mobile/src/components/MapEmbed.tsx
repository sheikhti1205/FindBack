import { MapPin } from "lucide-react";

interface MapEmbedProps {
  lat?: number | null;
  lng?: number | null;
  label?: string | null;
}

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
 * instead of silently defaulting to a hardcoded place.
 */
export function MapEmbed({ lat, lng, label }: MapEmbedProps) {
  const src = embedSrc(lat, lng, label);

  return (
    <div className="overflow-hidden rounded-m3-md border border-outline-variant">
      {src ? (
        <div className="h-48 w-full bg-surface-container">
          <iframe
            title="Map"
            className="h-full w-full"
            src={src}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      ) : (
        <div className="flex h-48 w-full flex-col items-center justify-center gap-2 bg-surface-container px-6 text-center">
          <MapPin size={20} className="text-on-surface-variant" aria-hidden />
          <p className="text-sm text-on-surface-variant">
            No location yet — type a place or paste a Maps link to preview it here.
          </p>
        </div>
      )}
      {label && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-on-surface-variant">
          <MapPin size={13} aria-hidden />
          <span className="truncate">{label}</span>
        </div>
      )}
    </div>
  );
}