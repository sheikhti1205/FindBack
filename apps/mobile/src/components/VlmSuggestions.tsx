import { useEffect, useRef, useState } from "react";
import { analyzeReportPhoto } from "../services/analyzeReportPhoto";
import type { VlmAnalysis } from "../services/vlmParser";
import { Button } from "./Button";

/** User-selected photo analysis: explicit cloud consent, then explicit report review. */
export function VlmSuggestions({ file, onApply }: { file: File; onApply: (patch: Partial<VlmAnalysis>) => void }) {
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<VlmAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Generation token: a response that resolves after the photo changed (or the
  // panel unmounted) is stale and must never populate this photo's panel.
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setConsented(false);
    setSuggestion(null);
    setError(null);
    setBusy(false);
  }, [file]);

  useEffect(() => () => { generation.current++; }, []);

  async function analyze() {
    if (!consented || busy) return;
    const gen = ++generation.current;
    setBusy(true);
    setError(null);
    setSuggestion(null);
    try {
      const result = await analyzeReportPhoto(file, true);
      if (generation.current !== gen) return; // stale photo: drop, never auto-apply
      setSuggestion(result);
    }
    catch (err) {
      if (generation.current !== gen) return;
      setError(err instanceof Error ? err.message : "Photo analysis is unavailable.");
    }
    finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  return (
    <section aria-label="AI photo suggestions" className="flex flex-col gap-3 rounded-m3-md border border-outline-variant bg-surface-container-low p-4">
      <h2 className="text-base font-semibold">AI photo suggestions</h2>
      <p className="text-sm text-on-surface-variant">Optional. Your selected photo will leave this device and be sent to OpenRouter for analysis using an available free vision model. Review every suggestion before applying it.</p>
      <label className="flex min-h-[48px] items-center gap-3 text-sm">
        <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
        Send selected photo to OpenRouter for AI suggestions
      </label>
      <Button type="button" disabled={!consented || busy} loading={busy} onClick={() => void analyze()}>Analyze photo</Button>
      {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
      {suggestion ? (
        <div className="flex flex-col gap-2" role="region" aria-label="Review AI suggestions">
          <p className="text-sm font-medium">Review suggestions from AI:</p>
          {suggestion.suggestedTitle && <p className="text-sm">Title: {suggestion.suggestedTitle}</p>}
          {suggestion.suggestedDescription && <p className="text-sm">Description: {suggestion.suggestedDescription}</p>}
          {suggestion.suggestedCategory && <p className="text-sm">Category: {suggestion.suggestedCategory}</p>}
          {suggestion.uncertainFields.length > 0 && <p className="text-sm">Uncertain: {suggestion.uncertainFields.join(", ")}</p>}
          <Button type="button" variant="outline" onClick={() => { onApply(suggestion); setSuggestion(null); }}>Apply suggestions</Button>
        </div>
      ) : null}
    </section>
  );
}
