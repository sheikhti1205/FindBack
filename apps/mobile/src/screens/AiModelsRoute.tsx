import { useState, useSyncExternalStore } from "react";
import { AiModels, type OfflineDownloadControls } from "./AiModels";
import { DOWNLOAD_MODELS, getApplicationAi, type ApplicationAiService } from "../services/ai/applicationAi";
import { Button } from "../components/Button";

/** Real route owns UI subscriptions; application service owns all transfers and residency. */
export function AiModelsRoute({ service = getApplicationAi() }: { service?: ApplicationAiService }) {
  useSyncExternalStore(service.subscribe, service.snapshot);
  const [modelId, setModelId] = useState<string>(DOWNLOAD_MODELS[0].modelId);
  const [notice, setNotice] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const model = DOWNLOAD_MODELS.find((item) => item.modelId === modelId)!;
  const status = service.manager.statusOf(modelId)!;
  const action = (work: Promise<unknown>) => { void work.catch((error: unknown) => setNotice(error instanceof Error ? error.message : "On-device operation failed.")); };
  const controls: OfflineDownloadControls | null = service.android ? {
    modelId, state: status.download, downloadedBytes: status.downloadedBytes, totalBytes: model.bytes,
    busy: service.busy(modelId), notice: service.notice(modelId),
    onDownload: () => action(service.download(modelId)), onPause: () => action(service.pause(modelId)),
    onResume: () => action(service.download(modelId)), onRemove: () => action(service.remove(modelId)),
  } : null;
  const measure = async (backend: "cpu" | "gpu") => {
    setMeasuring(true); setNotice("Measuring installed SmolVLM2. No sample is assumed.");
    try {
      const record = await service.measure(backend);
      setNotice(`${backend.toUpperCase()}: TTFT ${record.ttftMs.toFixed(1)} ms; ${record.tokensPerSec.toFixed(2)} tokens/s; correctness ${record.correctnessPass ? "PASS" : "FAIL"}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Measurement unavailable."); }
    finally { setMeasuring(false); }
  };
  return <AiModels offlineDownload={controls} offlineStatus={status} probeRecords={service.probeRecords} probeContext={service.probeContext}
    offlineTools={service.android ? <>
      <label className="flex flex-col gap-1 text-sm">On-device model
        <select className="min-h-12 rounded border border-outline-variant bg-surface px-2" value={modelId} onChange={(event) => setModelId(event.target.value)}>
          {DOWNLOAD_MODELS.map((item) => <option key={item.modelId} value={item.modelId}>{item.label}</option>)}
        </select>
      </label>
      <p className="text-sm" role="status">{status.download} · {model.bytes.toLocaleString()} bytes · {status.checksumVerified ? "checksum verified" : "not verified"}</p>
      <label className="flex flex-col gap-1 text-sm">Matching engine
        <select className="min-h-12 rounded border border-outline-variant bg-surface px-2" value={service.matchingBackend} onChange={(event) => {
          try { service.selectMatchingBackend(event.target.value as "use" | "needle"); } catch (error) { setNotice(error instanceof Error ? error.message : "Matching unavailable."); }
        }}>
          <option value="use">USE (default)</option>
          <option value="needle" disabled={!service.manager.statusOf(DOWNLOAD_MODELS[0].modelId)?.checksumVerified}>Needle (installed challenger, this session)</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={measuring || !service.manager.statusOf(DOWNLOAD_MODELS[1].modelId)?.checksumVerified} onClick={() => void measure("cpu")}>Measure CPU</Button>
        <Button type="button" variant="outline" disabled={measuring || !service.manager.statusOf(DOWNLOAD_MODELS[1].modelId)?.checksumVerified} onClick={() => void measure("gpu")}>Measure GPU</Button>
        <Button type="button" variant="outline" disabled={measuring} onClick={() => action(service.facts().then((facts) => setNotice(JSON.stringify(facts))))}>Inspect hardware</Button>
      </div>
      <p role="status" className="text-sm">{notice ?? "Device timings are DEVICE_REQUIRED. CPU is the default; measurements stay on this device for this session."}</p>
    </> : null} />;
}
