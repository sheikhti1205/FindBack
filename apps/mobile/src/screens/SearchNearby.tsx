import { useLayoutEffect, useRef, useState } from "react";
import { Crosshair } from "lucide-react";
import { SelectField } from "../components/Fields";
import { createProductionLocationAdapter, requestFixWithGeneration } from "../services/locationAdapter";
import { isValidCenter } from "../services/location/mapPickerState";
import {
  DEFAULT_NEARBY_RADIUS_KM, NEARBY_RADIUS_OPTIONS_KM, NEARBY_SHEET_NOTICE,
  clearNearbySession, kmToMeters, parseNearbyRadiusParam, roundNearbyCenter,
  setNearbySession, type NearbyCenter, type NearbyRadiusKm,
} from "../services/nearby";
import { useUrlParam } from "../hooks/useUrlParam";

/** Search owns only its active scope. The canonical adapter owns permission/fix;
 * the rounded center stays in the private Nearby session, never in a link. */
export function useSearchNearby() {
  const [nearParam, setNearParam] = useUrlParam("near");
  const radius = parseNearbyRadiusParam(nearParam) ?? DEFAULT_NEARBY_RADIUS_KM;
  const [center, setCenter] = useState<NearbyCenter | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useLayoutEffect(() => () => { generation.current++; }, []);
  const active = center !== null && parseNearbyRadiusParam(nearParam) !== null;
  async function enable() {
    if (locating) return;
    const request = ++generation.current;
    setLocating(true); setError(null);
    try {
      const result = await requestFixWithGeneration(createProductionLocationAdapter(), { generation });
      if (request !== generation.current) return;
      if (result.kind === "fix" && isValidCenter({ lat: result.lat, lng: result.lng })) {
        const rounded = roundNearbyCenter(result.lat, result.lng);
        setCenter(rounded); setNearParam(String(radius));
        setNearbySession({ center: rounded, radiusKm: radius, active: true });
      } else {
        setError(result.kind === "denied" ? "Location access is off. Enable it in Settings, or search by place name."
          : "Location is unavailable right now. Try again or search by place name.");
      }
    } finally { if (request === generation.current) setLocating(false); }
  }
  function clear() {
    generation.current++; setLocating(false); setError(null);
    setCenter(null); setNearParam(""); clearNearbySession();
  }
  function setRadius(next: NearbyRadiusKm) {
    setNearParam(String(next));
    if (active) setNearbySession({ radiusKm: next });
  }
  return { active, radius, locating, error, enable, clear, setRadius,
    feedFilters: active ? { nearLat: center.lat, nearLng: center.lng, radiusM: kmToMeters(radius) } : {},
  };
}

export function SearchNearbyControls({ nearby }: { nearby: ReturnType<typeof useSearchNearby> }) {
  return <fieldset className="fb-search-nearby">
    <legend className="text-sm font-semibold">Nearby</legend>
    <p className="text-xs text-on-surface-variant">{NEARBY_SHEET_NOTICE}</p>
    <button type="button" className="fb-surface-button gap-2" disabled={nearby.locating} onClick={() => void nearby.enable()}>
      <Crosshair size={16} aria-hidden />{nearby.locating ? "Locating…" : "Use my location once"}
    </button>
    {nearby.locating && <p role="status" className="text-xs text-on-surface-variant">Finding your approximate area…</p>}
    {nearby.error && <p role="alert" className="text-sm text-error">{nearby.error}</p>}
    <SelectField label="Distance" value={String(nearby.radius)} onChange={e => {
      const next = parseNearbyRadiusParam(e.target.value); if (next) nearby.setRadius(next);
    }} options={NEARBY_RADIUS_OPTIONS_KM.map(km => ({ value: String(km), label: `${km} km` }))} />
    {nearby.active && <p role="status" className="text-xs text-on-surface-variant">Within {nearby.radius} km of your approximate area.</p>}
  </fieldset>;
}
