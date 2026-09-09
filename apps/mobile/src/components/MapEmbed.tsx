import { MapPin } from "lucide-react";

interface MapEmbedProps {
  lat?: number | null;
  lng?: number | null;
  label?: string | null;
}

function embedSrc(lat?: number | null, lng?: number | null, label?: string | null): string {
  if (lat != null && lng != null) {
    return `https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
  }
  const q = encodeURIComponent(label?.trim() || "University of Chittagong");
  return `https://maps.google.com/maps?q=${q}&z=15&output=embed`;
}

/**
 * Keyless embedded Google Map for an approximate one-time location.
 * (Requirement minimum: embedded map; no continuous tracking.)
 */
export function MapEmbed({ lat, lng, label }: MapEmbedProps) {
  return (
    <div className="overflow-hidden rounded-m3-md border border-outline-variant">
      <div className="h-48 w-full bg-surface-container">
        <iframe
          title="Map"
          className="h-full w-full"
          src={embedSrc(lat, lng, label)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
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
