import { useState } from "react";
import { Crosshair, MapPin } from "lucide-react";
import { Button } from "./Button";
import { MapEmbed } from "./MapEmbed";

export interface LocationValue {
  label: string;
  latitude: number | null;
  longitude: number | null;
}

interface LocationPickerProps {
  value: LocationValue;
  onChange: (value: LocationValue) => void;
}

/**
 * One-time approximate location: optional "use my location once" (permission
 * optional + graceful fallback) plus a free-text place label. No tracking.
 */
export function LocationPicker({ value, onChange }: LocationPickerProps) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  function useCurrentLocation() {
    if (!("geolocation" in navigator)) {
      setGeoError("Location is not supported in this browser — type a place instead.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onChange({
          ...value,
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
        });
        setLocating(false);
      },
      () => {
        setGeoError("Could not get your location — type an approximate place instead.");
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-on-surface">
          Approximate location
        </span>
        <div className="flex gap-2">
          <input
            value={value.label}
            onChange={(e) => onChange({ ...value, label: e.target.value })}
            placeholder="e.g. Science Faculty, University of Chittagong"
            className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
        </div>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="md"
          loading={locating}
          onClick={useCurrentLocation}
        >
          <Crosshair size={16} aria-hidden />
          Use my location once
        </Button>
        {value.latitude != null && value.longitude != null && (
          <span className="flex items-center gap-1 text-xs text-on-surface-variant">
            <MapPin size={13} aria-hidden />
            {value.latitude.toFixed(4)}, {value.longitude.toFixed(4)}
          </span>
        )}
      </div>
      {geoError && <p className="text-xs text-error">{geoError}</p>}

      <MapEmbed lat={value.latitude} lng={value.longitude} label={value.label} />
    </div>
  );
}
