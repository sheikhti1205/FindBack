import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../components/Button";
import type { ApplicationAiService } from "../services/ai/applicationAi";
import { acquisitionArtifacts, acquisitionBytes } from "../services/ai/modelSupply";
import type { ImportSpec } from "../services/ai/download/import";
import { chooseNativeImage } from "../services/media/nativeMedia";
import { modelLicenseFor } from "../services/ai/modelLicenses";

const field = "min-h-11 w-full min-w-0 rounded-m3-xs border border-outline bg-surface px-3 py-2 text-sm text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";

export function AdvancedModelSupply({ service }: { service: ApplicationAiService }) {
  useSyncExternalStore(service.subscribe, service.snapshot);
  const prefix = useId();
  const [modelId, setModelId] = useState(service.registry.descriptors.find((d) => d.tier === "advanced")?.modelId ?? service.registry.descriptors[0]?.modelId ?? "new-import");
  const [format, setFormat] = useState<ImportSpec["format"]>("gguf");
  const [modality, setModality] = useState<"text" | "vision">("text");
  const [license, setLicense] = useState("");
  const [url, setUrl] = useState("");
  const [sha, setSha] = useState("");
  const [bytes, setBytes] = useState("");
  const [mirrors, setMirrors] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [image, setImage] = useState<string>();
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [answer, setAnswer] = useState<string>();
  const active = useRef<AbortController | null>(null);
  const onCancel = useRef<(() => Promise<void>) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); void onCancel.current?.().catch(() => {}); };
  }, []);
  const d = service.registry.descriptors.find((v) => v.modelId === modelId);
  const legal = modelLicenseFor(modelId);
  const ready = d !== undefined && service.manager.statusOf(modelId)?.download === "installed" && service.manager.statusOf(modelId)?.checksumVerified === true;
  const supported = service.android && (!d || service.compatibility(modelId).compatible);

  const run = async (work: (signal: AbortSignal) => Promise<void>, cancel?: () => Promise<void>) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; onCancel.current = cancel ?? null;
    setWorking(true); setError(undefined); setNotice(undefined); setAnswer(undefined);
    try { await work(controller.signal); }
    catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Operation failed. Try again.");
    } finally {
      if (mounted.current) { if (controller.signal.aborted) setNotice("Operation cancelled."); setWorking(false); }
      active.current = null; onCancel.current = null;
    }
  };
  const imported = (id: string, signal: AbortSignal) => {
    if (!mounted.current || signal.aborted) return;
    setModelId(id); setUrl(""); setOptIn(false); setImage(undefined); setNotice("Import finished.");
  };

  return <section aria-label="Advanced model acquisition and evaluation" className="flex min-w-0 flex-col gap-4">
    <p className="text-sm text-on-surface-variant">Explicit tests only. Importing or evaluating a model does not enable it for assistant, report, or photo tasks.</p>
    <fieldset disabled={working} className="flex min-w-0 flex-col gap-3">
      <label htmlFor={`${prefix}-model`} className="text-sm font-medium">Model</label>
      <select id={`${prefix}-model`} className={field} value={modelId} onChange={(e) => { setModelId(e.target.value); setImage(undefined); setOptIn(false); setAnswer(undefined); setMirrors({}); setNotice(undefined); setError(undefined); }}>
        {service.registry.descriptors.map((v) => <option key={v.modelId} value={v.modelId}>{v.displayName}</option>)}
        <option value="new-import">Other local or URL model</option>
      </select>
      {d ? <>
        <p className="break-words text-xs text-on-surface-variant">{d.format} · {Math.round(acquisitionBytes(d) / 1e6)} MB · {d.license} · {ready ? "Installed" : "Not installed"}</p>
        <p className="text-xs text-on-surface-variant">{d.distributionNote ?? "Use is subject to the model license. Task qualification is unchanged."}</p>
        {d.licenseFacts?.threshold ? <p className="text-xs text-on-surface-variant">{d.licenseFacts.threshold}</p> : null}
        {d.licenseFacts?.notice ? <p className="text-xs text-on-surface-variant">{d.licenseFacts.notice}</p> : null}
        {legal ? <details className="min-w-0 text-xs text-on-surface-variant">
          <summary className="min-h-11 cursor-pointer py-3">License and attribution</summary>
          <p className="break-words">{legal.attribution}</p>
          <pre className="my-3 whitespace-pre-wrap break-words font-sans">{legal.licenseText}</pre>
          {legal.noticeTexts.map((text, index) => <pre key={index} className="my-3 whitespace-pre-wrap break-words font-sans">{text}</pre>)}
          <details>
            <summary className="min-h-11 cursor-pointer py-3">Pinned publisher card and notice inventory</summary>
            <p className="break-words">{legal.noticeInventory}</p>
            <p className="break-all">{legal.license.source}</p>
            <pre className="my-3 whitespace-pre-wrap break-words font-sans">{legal.cardText}</pre>
          </details>
        </details> : null}
        <details className="text-xs text-on-surface-variant">
          <summary className="min-h-11 cursor-pointer py-3">Artifact identity and source</summary>
          <p className="break-all">{d.modelId} · {d.revision}</p>
          {acquisitionArtifacts(d).map((file) => <p key={file.fileName} className="my-2 break-all">{file.fileName} · {file.bytes} bytes · SHA-256 {file.sha256}</p>)}
          <p>Publisher: {d.upstreamRepo ?? (d.trust === "imported" ? "User import, not curated" : "Curated upstream")}</p>
          <p>Hugging Face aliases share one service; they are not independent mirrors.</p>
        </details>
        {!ready ? <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Same-byte HTTPS mirrors (optional)</summary>
          <div className="flex min-w-0 flex-col gap-3 py-2">
            <p className="text-xs text-on-surface-variant">Each mirror must serve the exact selected artifact bytes. A different quantization or projector is not a mirror.</p>
            {acquisitionArtifacts(d).map((file) => <label key={file.fileName} className="flex min-w-0 flex-col gap-1 break-all text-sm">Mirror for {file.fileName}<input className={field} type="url" autoComplete="off" spellCheck={false} value={mirrors[file.fileName] ?? ""} onChange={(e) => setMirrors((current) => ({ ...current, [file.fileName]: e.target.value }))} /></label>)}
          </div>
        </details> : null}
        {d.companions?.length ? <p className="text-xs text-on-surface-variant">File import will ask for the language weights, then the matching projector. Both must pass verification.</p> : null}
        <div className="flex flex-wrap gap-2">
          {!ready && d.downloadable ? <Button type="button" variant="outline" disabled={!supported} onClick={() => void run(async (signal) => { await service.download(modelId, Object.fromEntries(Object.entries(mirrors).filter(([, value]) => value.trim()).map(([fileName, value]) => [fileName, value.trim()])), signal); }, () => service.pause(modelId))}>Download model</Button> : null}
          <Button type="button" variant="outline" disabled={!supported} onClick={() => void run(async (signal) => imported(await service.importLocal({ modelId, signal }), signal))}>Import model files</Button>
          {ready ? <><Button type="button" variant="outline" onClick={() => void run(async () => { await service.verify(modelId); })}>Verify model</Button><Button type="button" variant="outline" onClick={() => void run(async () => { await service.remove(modelId); setModelId("new-import"); setImage(undefined); setOptIn(false); })}>Remove model</Button></> : null}
        </div>
      </> : <>
        <p className="text-xs text-on-surface-variant">Other files stay untrusted, evaluation-only imports. No filename, hash, or model name makes them curated.</p>
        <label className="flex flex-col gap-1 text-sm">Artifact format<select className={field} value={`${format}:${modality}`} onChange={(e) => { const [nextFormat, nextModality] = e.target.value.split(":"); setFormat(nextFormat as ImportSpec["format"]); setModality(nextModality as "text" | "vision"); }}><option value="gguf:text">GGUF text</option><option value="litertlm:text">LiteRT-LM text</option><option value="litertlm:vision">LiteRT-LM vision</option><option value="cact:text">CACT embedding self-test</option></select></label>
        <label className="flex flex-col gap-1 text-sm">Model license<input className={field} maxLength={200} value={license} onChange={(e) => setLicense(e.target.value)} /></label>
        <Button type="button" variant="outline" disabled={!supported || !license.trim()} onClick={() => void run(async (signal) => imported(await service.importLocal({ format: format as "gguf" | "litertlm" | "cact", modality, license, signal }), signal))}>Import local file</Button>
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Import from an HTTPS URL</summary>
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-on-surface-variant">Use a public URL with no credentials or token query. Supply the exact expected byte count and SHA-256; mismatches stop installation.</p>
            <label className="flex flex-col gap-1 text-sm">Model URL<input className={field} type="url" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">Expected SHA-256<input className={field} autoComplete="off" spellCheck={false} maxLength={64} value={sha} onChange={(e) => setSha(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">Exact byte count<input className={field} inputMode="numeric" value={bytes} onChange={(e) => setBytes(e.target.value)} /></label>
            <Button type="button" variant="outline" disabled={!supported || !url || !license.trim() || !/^[a-f0-9]{64}$/.test(sha) || !Number.isSafeInteger(Number(bytes)) || Number(bytes) <= 0} onClick={() => void run(async (signal) => imported(await service.importUrl({ url, sha256: sha, bytes: Number(bytes), format, modality, license }, { signal }), signal), () => service.pause(`imported-${sha}`))}>Import URL</Button>
          </div>
        </details>
      </>}
      {d && ready ? <div className="flex flex-col gap-3 border-t border-outline-variant pt-4">
        <label className="flex flex-col gap-1 text-sm">Evaluation prompt<textarea className={field} rows={3} maxLength={16000} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        {d.capabilities.includes("vision") ? <>
          <Button type="button" variant="outline" disabled={!supported} onClick={() => void run(async (signal) => {
            const photo = await chooseNativeImage({ source: "photos", signal });
            if (!photo || signal.aborted || !mounted.current) return;
            // Only the canonical bounded, orientation-correct, stripped
            // derivative enters JS/base64; never the original photo.
            let encoded = "";
            for (let i = 0; i < photo.derivative.bytes.length; i += 8192) encoded += String.fromCharCode(...photo.derivative.bytes.subarray(i, i + 8192));
            setImage(btoa(encoded)); setNotice("Evaluation photo prepared.");
          })}>Choose evaluation photo</Button>
          {image ? <p className="text-xs text-on-surface-variant">Photo prepared for this evaluation only.</p> : null}
        </> : null}
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />I agree to run this evaluation on my phone</label>
        <Button type="button" variant="outline" disabled={!supported || !optIn || !prompt.trim() || (d.capabilities.includes("vision") && !image)} onClick={() => void run(async (signal) => {
          const result = await service.evaluate(modelId, { optIn, prompt, imageBase64: image, signal });
          if (!signal.aborted && mounted.current) setAnswer(result);
        })}>Run evaluation</Button>
      </div> : null}
    </fieldset>
    {!supported ? <p className="text-sm text-on-surface-variant">This operation requires a supported Android app and runtime.</p> : null}
    {working ? <div className="flex flex-wrap items-center gap-2"><span role="status" className="text-sm">Working…</span><Button type="button" variant="outline" onClick={() => { active.current?.abort(); void onCancel.current?.().catch(() => {}); }}>Cancel operation</Button></div> : null}
    {notice ? <p role="status" className="text-sm text-on-surface-variant">{notice}</p> : null}
    {!notice && !error && d && service.notice(modelId) ? <p role="status" className="break-words text-sm text-on-surface-variant">{service.notice(modelId)}</p> : null}
    {error ? <p role="alert" className="break-words text-sm text-error">{error}</p> : null}
    {answer ? <div role="status" aria-label="Evaluation answer" className="whitespace-pre-wrap break-words text-sm">{answer}</div> : null}
  </section>;
}
