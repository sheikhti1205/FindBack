import { useEffect, useState } from "react";
import { Sparkles, AlertCircle, Download } from "lucide-react";
import { Button } from "./Button";
import { MarkdownView } from "./MarkdownView";
import { analyzeImageLocally, VlmUnstructuredOutputError } from "../services/vlm";
import { getVlmBridge, type InferenceStateEvent, type VlmState } from "../services/vlmPlugin";
import type { VlmAnalysis } from "../services/vlmParser";

interface VlmSuggestionsProps {
  imageUri: string;
  onApply: (patch: Partial<VlmAnalysis>) => void;
}

const FIELD_LABELS: Record<keyof VlmAnalysis, string> = {
  objectName: "Object name",
  suggestedCategory: "Category",
  colors: "Colors",
  visibleBrand: "Brand",
  visibleText: "Visible text",
  identifyingFeatures: "Identifying features",
  suggestedTitle: "Title",
  suggestedDescription: "Description",
  uncertainFields: "Uncertain fields",
};

const APPLY_FIELDS: (keyof VlmAnalysis)[] = [
  "suggestedTitle",
  "suggestedCategory",
  "suggestedDescription",
];

function formatValue(value: VlmAnalysis[keyof VlmAnalysis]): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value ?? "";
}

function hasValue(value: VlmAnalysis[keyof VlmAnalysis]): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== null && value !== undefined && value !== "";
}

export function VlmSuggestions({ imageUri, onApply }: VlmSuggestionsProps) {
  const [analysis, setAnalysis] = useState<VlmAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inferenceRunning, setInferenceRunning] = useState(false);

  // Subscribe to inference state to disable while another analysis runs
  useEffect(() => {
    let removeListener: (() => void) | null = null;
    getVlmBridge()
      .onInferenceState((event: InferenceStateEvent) => {
        // Consider inference running when state is not READY_GPU or terminal states
        const runningStates: VlmState[] = ["DOWNLOADING", "VERIFYING_HASH", "GPU_SELF_TESTING"];
        setInferenceRunning(runningStates.includes(event.state));
      })
      .then((remove) => {
        removeListener = remove;
      })
      .catch(() => {
        // Web adapter or other error - ignore
      });

    return () => {
      removeListener?.();
    };
  }, []);

  const disabled = !imageUri || analyzing || inferenceRunning;

  async function handleAnalyze() {
    if (disabled) return;
    setAnalyzing(true);
    setError(null);
    setAnalysis(null);

    try {
      // Use current form context as userContext - empty for now since we don't have access to form
      const result = await analyzeImageLocally({
        imageUri,
        mode: "AUTO",
        userContext: { title: "", description: "" },
      });
      setAnalysis(result);
    } catch (err) {
      const isUnstructured = err instanceof VlmUnstructuredOutputError || (err instanceof Error && err.name === "VlmUnstructuredOutputError");
      const isGpuUnavailable = err instanceof Error && (err.message.includes("GPU_UNAVAILABLE") || err.message.includes("MODEL_UNAVAILABLE"));
      if (isUnstructured) {
        setError("Could not read the photo — fill the details manually.");
      } else if (isGpuUnavailable) {
        setError("Model not available. Tap to download.");
      } else {
        setError(err instanceof Error ? err.message : "Analysis failed");
      }
    } finally {
      setAnalyzing(false);
    }
  }

  function handleApply(field: keyof VlmAnalysis) {
    if (!analysis) return;
    const value = analysis[field];
    if (!hasValue(value)) return;
    onApply({ [field]: value } as Partial<VlmAnalysis>);
  }

  if (!imageUri) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-3" aria-label="Local AI analysis">
      <p className="text-sm font-medium">Analyze with local AI</p>

      <Button
        type="button"
        variant="outline"
        size="md"
        loading={analyzing}
        disabled={disabled}
        onClick={handleAnalyze}
      >
        <Sparkles size={16} aria-hidden />
        Analyze photo
      </Button>

      {error && (
        <div className="flex items-center gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          <AlertCircle size={16} aria-hidden />
          <span>{error}</span>
          {(error.includes("Model not available") || error.includes("GPU_UNAVAILABLE") || error.includes("MODEL_UNAVAILABLE")) && (
            <Button type="button" variant="text" size="md" onClick={handleAnalyze}>
              <Download size={14} aria-hidden />
              Download model
            </Button>
          )}
        </div>
      )}

      {analysis && (
        <div className="flex flex-col gap-2">
          {APPLY_FIELDS.map((field) => {
            const value = analysis[field];
            if (!hasValue(value)) return null;
            return (
              <div key={String(field)} className="flex items-center justify-between gap-2 rounded-m3-sm border border-outline-variant p-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-on-surface-variant">{FIELD_LABELS[field]}</p>
                  {field === "suggestedDescription" ? (
                    <MarkdownView text={String(value ?? "")} />
                  ) : (
                    <p className="text-sm text-on-surface truncate">{formatValue(value)}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="text"
                  size="md"
                  onClick={() => handleApply(field)}
                  aria-label={`Apply ${FIELD_LABELS[field].toLowerCase()}`}
                >
                  Apply
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}