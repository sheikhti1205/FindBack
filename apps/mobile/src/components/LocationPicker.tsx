import { useState } from "react";
import { Crosshair, ExternalLink, MapPin } from "lucide-react";
import { Button } from "./Button";
import { MapEmbed } from "./MapEmbed";
import {
  FIND_IN_MAPS_HELP,
  openInMaps,
  parseLocationInput,
  resolveShortLink,
  roundToApproximate,
} from "../utils/location";

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
 * optional + graceful fallback) plus a free-text place label, decimal
 * coordinates, or a Google Maps link. No tracking.
 */
export function LocationPicker({ value, onChange }: LocationPickerProps) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [approx, setApprox] = useState(false);

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

  function handleInput(raw: string) {
    const parsed = parseLocationInput(raw);
    setParseError(parsed.error);
    setApprox(false);
    if (parsed.needsResolve) {
      setResolving(true);
      void resolveShortLink(raw)
        .then((finalUrl) => {
          const resolved = parseLocationInput(finalUrl);
          onChange({
            label: resolved.label,
            latitude: resolved.latitude,
            longitude: resolved.longitude,
          });
          setParseError(resolved.error);
        })
        .catch((err: unknown) => {
          setParseError(err instanceof Error ? err.message : "Could not resolve the map link.");
        })
        .finally(() => setResolving(false));
      return;
    }
    onChange({
      label: parsed.label,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
    });
  }

  function handleApproximate() {
    if (value.latitude == null || value.longitude == null) return;
    const rounded = roundToApproximate(value.latitude, value.longitude);
    onChange({ ...value, latitude: rounded.lat, longitude: rounded.lng });
    setApprox(true);
  }

  const hasCoords = value.latitude != null && value.longitude != null;

  return (
    <div className="flex flex-col gap-3">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-on-surface">
          Approximate location
        </span>
        <div className="flex gap-2">
          <input
            value={value.label}
            onChange={(e) => handleInput(e.target.value)}
            placeholder="Place, decimal coords, or a Google Maps link"
            className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
        </div>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="md"
          loading={locating || resolving}
          onClick={useCurrentLocation}
        >
          <Crosshair size={16} aria-hidden />
          Use my location once
        </Button>
        {hasCoords && (
          <Button type="button" variant="text" size="md" onClick={() => openInMaps(value.latitude, value.longitude, value.label)}>
            <ExternalLink size={16} aria-hidden />
            Open in Maps
          </Button>
        )}
        {hasCoords && (
          <span className="flex items-center gap-1 text-xs text-on-surface-variant">
            <MapPin size={13} aria-hidden />
            {value.latitude!.toFixed(4)}, {value.longitude!.toFixed(4)}
          </span>
        )}
      </div>

      {hasCoords && !approx && (
        <div className="flex flex-wrap items-center gap-2 rounded-m3-sm bg-surface-container px-3 py-2">
          <p className="text-xs text-on-surface-variant">
            This pin is exact. For privacy you can round it to ~100 m.
          </p>
          <Button type="button" variant="outline" size="md" onClick={handleApproximate}>
            Round to ~100 m
          </Button>
        </div>
      )}
      {approx && (
        <p className="text-xs text-on-surface-variant">
          Pin rounded to ~100 m precision.
        </p>
      )}

      {(geoError || parseError) && (
        <p className="text-xs text-error">{geoError ?? parseError}</p>
      )}
      <p className="text-xs text-on-surface-variant">{FIND_IN_MAPS_HELP}</p>

      <MapEmbed lat={value.latitude} lng={value.longitude} label={value.label} />
    </div>
  );
}