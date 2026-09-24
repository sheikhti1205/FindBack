import { useRef, useState } from "react";
import { Camera, Sparkles, X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import { licenseLabel } from "../services/models/modelCatalogue";

export type ManagerAction = "download" | "pause" | "resume" | "cancel" | "verify" | "use" | "delete" | "tryAgain";
export type ManagerStatus =
  | "NOT_INSTALLED" | "DOWNLOADING" | "PAUSED" | "INSTALLED_UNVERIFIED"
  | "READY" | "LOW_MEMORY" | "INCOMPATIBLE" | "UNAVAILABLE";

export interface ManagerModel {
  entryId: string;
  label: string;
  role: "Vision" | "Text";
  bytes: number;
  category: "RECOMMENDED" | "EXPERIMENTAL" | "IMPORTED";
  state: ManagerStatus;
  canDownload: boolean;
  deviceFit?: string;
  downloadedBytes?: number;
  source?: string;
  revision?: string;
  license?: string;
  format?: string;
  quantization?: string;
  runtimeId?: string;
  error?: string;
  loadMs?: number;
  inferenceMs?: number;
  memoryBeforeMb?: number;
  observedPeakMb?: number;
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function status(model: ManagerModel): string {
  switch (model.state) {
    case "NOT_INSTALLED": return model.canDownload ? "Not installed" : "Unavailable";
    case "DOWNLOADING": return "Downloading";
    case "PAUSED": return "Paused";
    case "INSTALLED_UNVERIFIED": return "Installed";
    case "READY": return "Ready";
    case "LOW_MEMORY": return "Installed";
    case "INCOMPATIBLE": return "Installed";
    case "UNAVAILABLE": return "Unavailable";
  }
}

function ModelDetails({ model, availableRamMb, onClose, onAction }: {
  model: ManagerModel;
  availableRamMb?: number | null;
  onClose: () => void;
  onAction: (action: ManagerAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  useModalBack(true, onClose);
  const details = (items: Array<[string, string]>) => (
    <dl className="space-y-2 text-sm">{items.map(([key, value]) => (
      <div key={key} className="flex min-w-0 justify-between gap-4 border-b border-outline-variant/40 py-1">
        <dt className="text-on-surface-variant">{key}</dt><dd className="max-w-[60%] break-all text-right">{value}</dd>
      </div>
    ))}</dl>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" role="presentation">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`${model.label} details`} className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-m3-lg bg-surface p-5 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div><h2 className="text-lg font-semibold">{model.label}</h2><p className="text-sm text-on-surface-variant">{model.category === "IMPORTED" ? "Imported" : model.category === "RECOMMENDED" ? "Recommended" : "Experimental"} · {model.role} model</p></div>
          <button type="button" onClick={onClose} aria-label="Close details" className="flex min-h-[48px] min-w-[48px] items-center justify-center"><X aria-hidden size={20} /></button>
        </div>
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide">Status</h3>
        <p className="mt-1 text-sm">{status(model)} · {model.state === "READY" ? "Verified on this device" : model.state === "LOW_MEMORY" ? "Could not verify — memory was low" : model.state === "INCOMPATIBLE" ? "Not compatible with this build" : model.state === "INSTALLED_UNVERIFIED" ? "Needs device verification" : model.deviceFit ?? "Not tested on this device"}</p>
        {model.error && <p role="alert" className="mt-1 text-sm text-error">{model.error}</p>}
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide">Device</h3>
        {details([["Available memory now", availableRamMb == null ? "Unknown" : `${(availableRamMb / 1024).toFixed(1)} GB`], ["Observed compatibility", model.state === "READY" ? "Observed on this device" : "Not tested or not verified"]])}
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide">Package</h3>
        {details([["Installed size", size(model.bytes)], ["Format", model.format ?? "LiteRT-LM"], ["Quantization", model.quantization ?? "See source"], ["Runtime identity", model.runtimeId ?? model.entryId]])}
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide">Source</h3>
        {details([["Repository", model.source ?? "Local import"], ["Pinned revision", model.revision ?? "Local package"], ["License", model.license ? licenseLabel(model.license) : "See package provenance"]])}
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide">Device test results</h3>
        {details([["Load result", model.state === "READY" ? "Passed · Observed on this device" : "—"], ["Load time", model.loadMs == null ? "—" : `${model.loadMs} ms · Observed on this device`], ["Inference time", model.inferenceMs == null ? "—" : `${model.inferenceMs} ms · Observed on this device`], ["Memory before", model.memoryBeforeMb == null ? "—" : `${model.memoryBeforeMb} MB · Observed on this device`], ["Observed memory peak", model.observedPeakMb == null ? "—" : `${model.observedPeakMb} MB · Observed on this device`]])}
        {(model.state === "INSTALLED_UNVERIFIED" || model.state === "LOW_MEMORY") && (
          <button type="button" onClick={() => onAction("verify")} className="mt-4 min-h-[48px] w-full rounded-m3-xs bg-on-surface px-3 text-surface">Verify model</button>
        )}
        {model.state !== "NOT_INSTALLED" && model.state !== "DOWNLOADING" && model.state !== "PAUSED" && model.state !== "UNAVAILABLE" && (
          <button type="button" onClick={() => onAction("delete")} className="mt-4 min-h-[48px] w-full border-t border-outline-variant pt-3 text-error">Delete model</button>
        )}
      </div>
    </div>
  );
}

export function ModelManagerView({ models, availableRamMb, onAction, onImport, onExport }: {
  models: readonly ManagerModel[];
  availableRamMb?: number | null;
  onAction: (entryId: string, action: ManagerAction) => void;
  onImport: () => void;
  onExport: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const details = models.find((model) => model.entryId === selected);
  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-8">
      <h1 className="text-xl font-semibold">On-device AI</h1>
      <p className="mt-1 text-sm text-on-surface-variant">Available memory: {availableRamMb == null ? "Unknown" : `${(availableRamMb / 1024).toFixed(1)} GB`}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onImport} className="min-h-[48px] flex-1 rounded-m3-xs border border-outline-variant px-3 text-sm">Import model</button>
        <button type="button" onClick={onExport} className="min-h-[48px] flex-1 rounded-m3-xs border border-outline-variant px-3 text-sm">Export models</button>
      </div>
      {(["RECOMMENDED", "EXPERIMENTAL", "IMPORTED"] as const).map((section) => {
        const entries = models.filter((model) => model.category === section);
        if (section === "IMPORTED" && entries.length === 0) return null;
        return <section key={section} role="region" aria-label={section[0] + section.slice(1).toLowerCase()} className="mt-6">
          <h2 className="border-b border-outline-variant pb-2 text-xs font-semibold uppercase tracking-widest">{section}</h2>
          <ul className="divide-y divide-outline-variant" aria-label={`${section.toLowerCase()} models`}>
            {entries.map((model) => {
              const progress = model.bytes > 0 ? Math.max(0, Math.min(100, Math.round((model.downloadedBytes ?? 0) / model.bytes * 100))) : 0;
              const actions: Array<[ManagerAction, string]> = model.state === "DOWNLOADING" ? [["pause", "Pause"], ["cancel", "Cancel"]]
                : model.state === "PAUSED" ? [["resume", "Resume"], ["cancel", "Cancel"]]
                : model.state === "INSTALLED_UNVERIFIED" ? [["verify", "Verify"]]
                : model.state === "READY" ? [["use", "Use"]]
                : model.state === "LOW_MEMORY" ? [["tryAgain", "Try again"]]
                : model.state === "NOT_INSTALLED" && model.canDownload ? [["download", "Download"]] : [];
              return <li key={model.entryId} className="grid min-h-[80px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-2">
                <button type="button" onClick={() => setSelected(model.entryId)} aria-label={`Details for ${model.label}`} className="min-h-[48px] min-w-0 text-left focus-visible:outline-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium">{model.role === "Vision" ? <Camera size={18} aria-hidden className="shrink-0" /> : <Sparkles size={18} aria-hidden className="shrink-0" />}<span className="min-w-0 truncate">{model.label}</span><span className="ml-auto shrink-0 text-xs text-on-surface-variant">{status(model)}</span></span>
                  <span className="mt-1 block truncate text-xs text-on-surface-variant">{model.role} · {size(model.bytes)} · {model.state === "LOW_MEMORY" ? "Memory was low" : model.state === "INCOMPATIBLE" ? "Not compatible with this build" : model.state === "READY" ? "Verified on this device" : model.deviceFit ?? "Needs device verification"}</span>
                  {(model.state === "DOWNLOADING" || model.state === "PAUSED") && <span className="mt-1 block text-xs text-on-surface-variant">{size(model.downloadedBytes ?? 0)} / {size(model.bytes)}{model.state === "DOWNLOADING" ? ` · ${progress}%` : ""}</span>}
                  {model.state === "DOWNLOADING" && <span role="progressbar" aria-label={`${model.label} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-container"><span className="block h-full bg-on-surface" style={{ width: `${progress}%` }} /></span>}
                </button>
                <span className="flex shrink-0 flex-col gap-1">{actions.map(([action, text]) => (
                  <button key={action} type="button" onClick={() => onAction(model.entryId, action)} aria-label={`${text} ${model.label}`} className="min-h-[48px] min-w-[72px] rounded-m3-xs border border-outline-variant px-2 text-xs font-medium focus-visible:outline-2">{text}</button>
                ))}</span>
              </li>;
            })}
          </ul>
        </section>;
      })}
      {details && <ModelDetails model={details} availableRamMb={availableRamMb} onClose={() => setSelected(null)} onAction={(action) => onAction(details.entryId, action)} />}
    </div>
  );
}
