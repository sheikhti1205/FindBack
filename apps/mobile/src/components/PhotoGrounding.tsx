import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button";
import { groundReportPhoto, type LiveGroundedOptions } from "../services/livePhotoGrounding";
import { selectGroundedOption, toCssPercentRect } from "../services/photoGrounding";
import type { PhotoEnginePreference } from "../services/ai/aiPreferences";
import "./PhotoGrounding.css";

interface PhotoGroundingProps {
  readonly file: File;
  /** Borrowed URL: caller owns its lifetime. Without it, this component owns one. */
  readonly previewUrl?: string;
  readonly photoEngine: PhotoEnginePreference;
  readonly accountId: string;
  readonly currentTitle: string;
  /** True only if the reviewed title was applied (parent owns overwrite confirm). */
  readonly onApply: (title: string) => boolean;
}
const CONSENT_COPY: Record<PhotoEnginePreference, string> = {
  "on-device-only": "Analyze this photo and item description only on this device. They are never sent to OpenRouter.",
  "cloud-only": "Send this photo and item description to OpenRouter with my connected key to find matching items.",
  automatic: "Analyze this photo and item description first on this device; if local grounding is unavailable or unusable, send them to OpenRouter with my connected key.",
};

/** Native buttons retain Tab/Enter/Space behavior; selection never writes a field.
 * Status/error regions announce progress. Review stays inline (no focus trap).
 */
export function PhotoGrounding({ file, previewUrl, photoEngine, accountId, currentTitle, onApply }: PhotoGroundingProps) {
  const id = useId();
  const [expression, setExpression] = useState("");
  const [consent, setConsent] = useState(false);
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState<LiveGroundedOptions | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewedTitle, setReviewedTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const focusAfterStop = useRef(false);
  useEffect(() => {
    if (!busy && focusAfterStop.current) {
      focusAfterStop.current = false;
      document.getElementById(`${id}-find`)?.focus();
    }
  }, [busy, id]);

  useEffect(() => {
    if (previewUrl !== undefined) { setPreview(previewUrl); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, previewUrl]);
  useEffect(() => {
    generation.current++;
    focusAfterStop.current = false;
    active.current?.abort(); active.current = null;
    setExpression(""); setConsent(false); setResult(null); setSelectedId(null);
    setReviewedTitle(""); setBusy(false); setStatus(""); setError("");
    return () => { generation.current++; active.current?.abort(); };
  }, [file, photoEngine, accountId]);

  function invalidate() {
    generation.current++; active.current?.abort(); active.current = null;
    setBusy(false); setResult(null); setSelectedId(null); setReviewedTitle(""); setStatus(""); setError("");
  }
  async function find() {
    if (!consent || !expression.trim() || busy) return;
    invalidate();
    const token = ++generation.current;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setStatus("Finding matching items…");
    try {
      const next = await groundReportPhoto(file, expression, true, { signal: controller.signal, photoEngine, accountId });
      if (generation.current !== token || controller.signal.aborted) return;
      if (!next.ok) {
        setStatus("");
        setError(next.error.reason ?? (next.error.errorClass === "RUNTIME_ERROR" || next.error.errorClass === "MODEL_UNAVAILABLE"
          ? "On-device item search is unavailable. Install the local model or choose a different photo engine."
          : "No usable item boxes were returned. Describe the item manually or retry."));
        return;
      }
      setResult(next.value);
      setStatus(next.value.options.length ? `Found ${next.value.options.length} item option${next.value.options.length === 1 ? "" : "s"}. ${next.value.engine === "on-device" ? "Analyzed on-device." : "Analyzed with OpenRouter."} Select an item, then review its title.`
        : "No confident match — describe the item manually or retry.");
    } catch (reason) {
      if (generation.current !== token) return;
      setStatus("");
      if (controller.signal.aborted || (reason instanceof Error && reason.name === "AbortError")) setStatus("Item request cancelled.");
      else setError(reason instanceof Error ? reason.message : "Couldn't find items. Describe the item manually or retry.");
    } finally {
      if (generation.current === token) { setBusy(false); active.current = null; }
    }
  }
  function stop() { focusAfterStop.current = true; invalidate(); setStatus("Item request cancelled."); }
  function resolveReview(message: string) {
    document.getElementById(`${id}-${selectedId}`)?.focus();
    setSelectedId(null); setStatus(message);
  }
  const selected = selectedId && result ? selectGroundedOption(result.options, selectedId) : undefined;
  const supported = ["image/jpeg", "image/png", "image/webp"].includes(file.type);

  return <section aria-label="Find an item in this photo" className="photo-grounding flex flex-col gap-3 rounded-m3-md border border-outline-variant bg-surface-container-low p-4">
    <h2 className="text-base font-semibold">Find an item in this photo</h2>
    <p className="text-sm text-on-surface-variant">Describe the item, choose a match, then review its title. Boxes are visual guides only: nothing is cropped, geolocated, published or automatically applied.</p>
    {supported ? <>
      <div className="photo-grounding-image">
        <img src={result?.imageUrl ?? (preview || undefined)} alt="Report photo for item selection" />
        {result?.options.map((option, index) => {
          const rect = toCssPercentRect(option.box);
          return <span key={option.id} data-grounding-box={option.id} aria-hidden="true"
            className={`photo-grounding-box${selectedId === option.id ? " is-selected" : ""}`}
            style={{ left: `${rect.leftPct}%`, top: `${rect.topPct}%`, width: `${rect.widthPct}%`, height: `${rect.heightPct}%` }}>
            <span>{index + 1}{selectedId === option.id ? " ✓" : ""}</span>
          </span>;
        })}
      </div>
      <label htmlFor={`${id}-expression`} className="text-sm font-medium">Which item should AI look for?</label>
      <input id={`${id}-expression`} value={expression} maxLength={140} placeholder="e.g. the red backpack near the chair"
        className="rounded-m3-sm border border-outline-variant bg-surface px-3 py-3 text-base"
        onChange={(event) => { invalidate(); setExpression(event.target.value); }} />
      <label className="flex min-h-[48px] items-center gap-3 text-sm">
        <input type="checkbox" checked={consent} onChange={(event) => { invalidate(); setConsent(event.target.checked); }} />
        {CONSENT_COPY[photoEngine]} Nothing is applied until I select and review it.
      </label>
      <Button id={`${id}-find`} type="button" disabled={!consent || !expression.trim() || busy} onClick={() => void find()}>Find matching items</Button>
      {busy && <Button type="button" variant="outline" onClick={stop}>Stop finding items</Button>}
      <p role="status" className="text-sm">{status}</p>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      {result && result.options.length > 0 && <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Which item are you reporting?</legend>
        {result.options.map((option, index) => <Button key={option.id} id={`${id}-${option.id}`} type="button" variant="outline" aria-pressed={selectedId === option.id}
          onClick={() => { setSelectedId(option.id); setReviewedTitle(option.label); }}>
          Item {index + 1}: {option.label}
        </Button>)}
      </fieldset>}
      {selected && <section aria-label="Review selected item" className="flex flex-col gap-2">
        <p className="text-sm">Selected item: {selected.label} · via ground-objects</p>
        <p className="text-sm">Your title: {currentTitle || "(empty)"}</p>
        <label htmlFor={`${id}-title`} className="text-sm font-medium">Reviewed item title</label>
        <input id={`${id}-title`} value={reviewedTitle} maxLength={120} className="rounded-m3-sm border border-outline-variant bg-surface px-3 py-3 text-base"
          onChange={(event) => setReviewedTitle(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!reviewedTitle.trim()} onClick={() => {
            if (onApply(reviewedTitle.trim())) resolveReview("Reviewed item title applied to your draft.");
          }}>Apply item title</Button>
          <Button type="button" variant="outline" onClick={() => resolveReview("Your title was kept.")}>Keep my title</Button>
        </div>
      </section>}
    </> : <p role="status">Choose a JPEG, PNG or WebP photo to find an item. You can still describe this photo manually.</p>}
  </section>;
}
