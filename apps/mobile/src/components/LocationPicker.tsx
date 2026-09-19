import { useEffect, useRef, useState } from "react";
import { Crosshair, ExternalLink, MapPin } from "lucide-react";
import { Button } from "./Button";
import { announce } from "./LiveRegion";
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
  /** Whether the stored coordinates are rounded to ~100 m or exact. */
  precision?: "APPROXIMATE" | "EXACT";
  /**
   * Unrounded coordinates kept alongside the published ones so the user can
   * toggle approximate ↔ exact without losing the precise fix. Local draft only.
   */
  preciseLatitude?: number | null;
  preciseLongitude?: number | null;
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
  // Legacy drafts carry no precision; they were always rounded.
  const [approx, setApprox] = useState(() => value.precision !== "EXACT");
  const [sourceText, setSourceText] = useState(value.label);
  // Keep the unrounded coordinates so "Use exact pin" can really restore them.
  const [precise, setPrecise] = useState<{ lat: number; lng: number } | null>(() => {
    if (value.preciseLatitude != null && value.preciseLongitude != null) {
      return { lat: value.preciseLatitude, lng: value.preciseLongitude };
    }
    return value.latitude != null && value.longitude != null
      ? { lat: value.latitude, lng: value.longitude }
      : null;
  });
  // Guards a short-link A resolving after the user replaced it with link B.
  const resolveSeq = useRef(0);
  // The last value this picker emitted, so an external reset (discard draft)
  // can be told apart from the echo of our own onChange.
  const emittedRef = useRef(value);

  useEffect(() => {
    if (value === emittedRef.current) return;
    emittedRef.current = value;
    setSourceText(value.label);
    setPrecise(
      value.preciseLatitude != null && value.preciseLongitude != null
        ? { lat: value.preciseLatitude, lng: value.preciseLongitude }
        : value.latitude != null && value.longitude != null
          ? { lat: value.latitude, lng: value.longitude }
          : null,
    );
    setApprox(value.precision !== "EXACT");
    setGeoError(null);
    setParseError(null);
  }, [value]);

  function emit(next: LocationValue) {
    emittedRef.current = next;
    onChange(next);
  }

  function setCoords(
    label: string,
    lat: number | null,
    lng: number | null,
    precision: "APPROXIMATE" | "EXACT",
  ) {
    if (lat == null || lng == null) {
      setPrecise(null);
      setApprox(true);
      emit({ label, latitude: lat, longitude: lng, precision: "APPROXIMATE", preciseLatitude: null, preciseLongitude: null });
      return;
    }
    setPrecise({ lat, lng });
    if (precision === "EXACT") {
      setApprox(false);
      emit({ label, latitude: lat, longitude: lng, precision: "EXACT", preciseLatitude: lat, preciseLongitude: lng });
      return;
    }
    const rounded = roundToApproximate(lat, lng);
    setApprox(true);
    emit({ label, latitude: rounded.lat, longitude: rounded.lng, precision: "APPROXIMATE", preciseLatitude: lat, preciseLongitude: lng });
  }

  function useCurrentLocation() {
    if (!("geolocation" in navigator)) {
      setGeoError("Location is not supported in this browser — type a place instead.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        setCoords(value.label || "Pinned location", lat, lng, "APPROXIMATE");
        announce("Approximate location imported (~100 m).");
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
    setSourceText(raw);
    const parsed = parseLocationInput(raw);
    setParseError(parsed.error);
    if (parsed.needsResolve) {
      const seq = ++resolveSeq.current;
      setResolving(true);
      void resolveShortLink(raw)
        .then((finalUrl) => {
          if (seq !== resolveSeq.current) return;
          const resolved = parseLocationInput(finalUrl);
          setCoords(resolved.label, resolved.latitude, resolved.longitude, "APPROXIMATE");
          setParseError(resolved.error);
        })
        .catch((err: unknown) => {
          if (seq !== resolveSeq.current) return;
          setParseError(err instanceof Error ? err.message : "Could not resolve the map link.");
        })
        .finally(() => {
          if (seq === resolveSeq.current) setResolving(false);
        });
      return;
    }
    if (parsed.latitude != null && parsed.longitude != null) {
      setCoords(parsed.label, parsed.latitude, parsed.longitude, "APPROXIMATE");
      return;
    }
    setPrecise(null);
    setApprox(true);
    emit({
      label: parsed.label,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      precision: "APPROXIMATE",
      preciseLatitude: null,
      preciseLongitude: null,
    });
  }

  function handleApproximate() {
    const lat = precise?.lat ?? value.latitude;
    const lng = precise?.lng ?? value.longitude;
    if (lat == null || lng == null) return;
    const rounded = roundToApproximate(lat, lng);
    setPrecise({ lat, lng });
    emit({ ...value, latitude: rounded.lat, longitude: rounded.lng, precision: "APPROXIMATE", preciseLatitude: lat, preciseLongitude: lng });
    setApprox(true);
  }

  function handleUseExact() {
    if (!precise) return;
    emit({ ...value, latitude: precise.lat, longitude: precise.lng, precision: "EXACT", preciseLatitude: precise.lat, preciseLongitude: precise.lng });
    setApprox(false);
    announce("Exact pin enabled. It will be shown publicly.");
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
            value={sourceText}
            onChange={(e) => handleInput(e.target.value)}
            placeholder="Place, decimal coords, or a Google Maps link"
            className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
        </div>
        {value.label && value.label !== sourceText && (
          <p className="mt-1 text-xs text-on-surface-variant">Parsed: {value.label}</p>
        )}
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
        <Button
          type="button"
          variant="outline"
          size="md"
          disabled={!sourceText.trim() && !hasCoords}
          onClick={() => void openInMaps(value.latitude, value.longitude, sourceText.trim() || value.label)}
        >
          <ExternalLink size={16} aria-hidden />
          Find location in Maps
        </Button>
        {hasCoords && (
          <Button type="button" variant="text" size="md" onClick={() => void openInMaps(value.latitude, value.longitude, value.label)}>
            <ExternalLink size={16} aria-hidden />
            Open in Maps
          </Button>
        )}
        {hasCoords && (
          <span className="flex items-center gap-1 text-xs text-on-surface-variant">
            <MapPin size={13} aria-hidden />
            {/* The readout must not imply more precision than the mode holds:
                approximate pins show the 3 decimals they were rounded to. */}
            {approx
              ? `${value.latitude!.toFixed(3)}, ${value.longitude!.toFixed(3)}`
              : `${value.latitude}, ${value.longitude}`}
          </span>
        )}
      </div>

      {hasCoords && !approx && (
        <div className="flex flex-wrap items-center gap-2 rounded-m3-sm border border-error px-3 py-2">
          <p className="text-xs text-error">
            Warning: this is an exact pin and will be shown publicly. Prefer the approximate area.
          </p>
          <Button type="button" variant="outline" size="md" onClick={handleApproximate}>
            Round to ~100 m
          </Button>
        </div>
      )}
      {hasCoords && approx && (
        <div className="flex flex-wrap items-center gap-2 rounded-m3-sm bg-surface-container px-3 py-2">
          <p className="text-xs text-on-surface-variant">
            Pin rounded to ~100 m precision.
          </p>
          <Button type="button" variant="text" size="md" onClick={handleUseExact}>
            Use exact pin
          </Button>
        </div>
      )}

      {(geoError || parseError) && (
        <p className="text-xs text-error">{geoError ?? parseError}</p>
      )}
      <p className="text-xs text-on-surface-variant">{FIND_IN_MAPS_HELP} Paste the coordinates or link back here.</p>

      <MapEmbed lat={value.latitude} lng={value.longitude} label={value.label} />
    </div>
  );
}