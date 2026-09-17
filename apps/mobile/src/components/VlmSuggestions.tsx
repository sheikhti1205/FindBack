import { useEffect, useRef, useState } from "react";
import { Sparkles, AlertCircle, Download } from "lucide-react";
import { Button } from "./Button";
import { MarkdownView } from "./MarkdownView";
import { analyzeImageLocally, VlmUnstructuredOutputError } from "../services/vlm";
import {
  discoverObjectsLocally,
  suggestForPrimaryLocally,
  type ObjectSelection,
  type ObjectRole,
} from "../services/vlmDiscovery";
import { getVlmBridge, type InferenceStateEvent, type VlmState } from "../services/vlmPlugin";
import type { VlmAnalysis } from "../services/vlmParser";

interface VlmSuggestionsProps {
  imageUri: string;
  onApply: (patch: Partial<VlmAnalysis>) => void;
}

const FIELD_LABELS: Record<"suggestedTitle" | "suggestedCategory" | "suggestedDescription", string> = {
  suggestedTitle: "Title",
  suggestedCategory: "Category",
  suggestedDescription: "Description",
};

const APPLY_FIELDS: (keyof VlmAnalysis & ("suggestedTitle" | "suggestedCategory" | "suggestedDescription"))[] = [
  "suggestedTitle",
  "suggestedCategory",
  "suggestedDescription",
];

const ROLES: ObjectRole[] = ["PRIMARY", "INCLUDE", "IGNORE"];

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

type Phase = "idle" | "discovering" | "review" | "generating" | "done";

export function VlmSuggestions({ imageUri, onApply }: VlmSuggestionsProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [selections, setSelections] = useState<ObjectSelection[]>([]);
  const [instruction, setInstruction] = useState("");
  const [analysis, setAnalysis] = useState<VlmAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inferenceRunning, setInferenceRunning] = useState(false);
  /** Per-photo generation: stale responses after an image change are ignored. */
  const generation = useRef(0);

  // Changing the photo invalidates all unapplied AI state.
  useEffect(() => {
    generation.current++;
    setPhase("idle");
    setSelections([]);
    setInstruction("");
    setAnalysis(null);
    setError(null);
    setBusy(false);
  }, [imageUri]);

  // Subscribe to inference state to disable while another analysis runs
  useEffect(() => {
    let removeListener: (() => void) | null = null;
    getVlmBridge()
      .onInferenceState((event: InferenceStateEvent) => {
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

  const disabled = !imageUri || busy || inferenceRunning;

  function fail(err: unknown) {
    const isUnstructured = err instanceof VlmUnstructuredOutputError || (err instanceof Error && err.name === "VlmUnstructuredOutputError");
    const isGpuUnavailable = err instanceof Error && (err.message.includes("GPU_UNAVAILABLE") || err.message.includes("MODEL_UNAVAILABLE"));
    if (isUnstructured) {
      setError("Could not read the photo — fill the details manually.");
    } else if (isGpuUnavailable) {
      setError("Model not available. Tap to download.");
    } else {
      setError(err instanceof Error ? err.message : "Analysis failed");
    }
  }

  async function handleDiscover() {
    if (disabled) return;
    const gen = ++generation.current;
    setBusy(true);
    setError(null);
    setAnalysis(null);
    setPhase("discovering");
    try {
      const objects = await discoverObjectsLocally({ imageUri, mode: "AUTO" });
      if (generation.current !== gen) return;
      if (objects.length === 0) {
        // No candidates: fall back to the classic single-object analysis.
        const result = await analyzeImageLocally({ imageUri, mode: "AUTO", userContext: { title: "", description: "" } });
        if (generation.current !== gen) return;
        setAnalysis(result);
        setPhase("done");
      } else {
        setSelections(
          objects.map((o, i) => ({ ...o, role: i === 0 ? "PRIMARY" : "IGNORE" as ObjectRole })),
        );
        setPhase("review");
      }
    } catch (err) {
      if (generation.current !== gen) return;
      fail(err);
      setPhase("idle");
    } finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  function setRole(index: number, role: ObjectRole) {
    setSelections((prev) =>
      prev.map((s, i) => {
        if (i === index) return { ...s, role };
        // Exactly one PRIMARY: promoting demotes the previous one to INCLUDE.
        if (role === "PRIMARY" && s.role === "PRIMARY") return { ...s, role: "INCLUDE" };
        return s;
      }),
    );
  }

  async function handleGenerate() {
    const primary = selections.find((s) => s.role === "PRIMARY");
    if (!primary || busy) return;
    const gen = ++generation.current;
    setBusy(true);
    setError(null);
    setPhase("generating");
    try {
      const result = await suggestForPrimaryLocally({
        imageUri,
        mode: "AUTO",
        primary: primary.objectName,
        include: selections.filter((s) => s.role === "INCLUDE").map((s) => s.objectName),
        userInstruction: instruction,
        userContext: { title: "", description: "" },
      });
      if (generation.current !== gen) return;
      setAnalysis(result);
      setPhase("done");
    } catch (err) {
      if (generation.current !== gen) return;
      fail(err);
      setPhase("review");
    } finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  function handleApply(field: keyof VlmAnalysis) {
    if (!analysis) return;
    const value = analysis[field];
    if (!hasValue(value)) return;
    // Applied text becomes normal user-owned form text.
    onApply({ [field]: value } as Partial<VlmAnalysis>);
  }

  if (!imageUri) {
    return null;
  }

  const primaryCount = selections.filter((s) => s.role === "PRIMARY").length;

  return (
    <section className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-3" aria-label="Local AI analysis">
      <p className="text-sm font-medium">Analyze with local AI</p>

      {(phase === "idle" || phase === "discovering") && (
        <Button
          type="button"
          variant="outline"
          size="md"
          loading={busy}
          disabled={disabled}
          onClick={handleDiscover}
        >
          <Sparkles size={16} aria-hidden />
          Analyze photo
        </Button>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          <AlertCircle size={16} aria-hidden />
          <span>{error}</span>
          {(error.includes("Model not available") || error.includes("GPU_UNAVAILABLE") || error.includes("MODEL_UNAVAILABLE")) && (
            <Button type="button" variant="text" size="md" onClick={handleDiscover}>
              <Download size={14} aria-hidden />
              Download model
            </Button>
          )}
        </div>
      )}

      {(phase === "review" || phase === "generating") && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-on-surface-variant">
            Pick exactly one PRIMARY object. INCLUDE others that belong with it; the rest stay
            ignored. Or fill the details manually below.
          </p>
          <ul className="flex flex-col gap-2">
            {selections.map((s, i) => (
              <li key={`${s.objectName}-${i}`} className="rounded-m3-sm border border-outline-variant p-2">
                <p className="text-sm font-medium text-on-surface">{s.objectName}</p>
                <p className="text-xs text-on-surface-variant">{s.positionHint}</p>
                <div role="radiogroup" aria-label={`Role for ${s.objectName}`} className="mt-1 flex gap-1">
                  {ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      role="radio"
                      aria-checked={s.role === role}
                      onClick={() => setRole(i, role)}
                      className={`min-h-[48px] flex-1 rounded-m3-xs px-2 text-xs font-medium ${
                        s.role === role ? "bg-on-surface text-surface" : "text-on-surface-variant hover:bg-surface-container"
                      }`}
                    >
                      {role === "PRIMARY" ? "Primary" : role === "INCLUDE" ? "Include" : "Ignore"}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-on-surface-variant">
              Optional instruction (e.g. “it has a zipper”)
            </span>
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Anything the photo does not show clearly…"
              className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="md"
            loading={phase === "generating"}
            disabled={busy || primaryCount !== 1}
            onClick={handleGenerate}
          >
            <Sparkles size={16} aria-hidden />
            Generate suggestions
          </Button>
        </div>
      )}

      {phase === "done" && analysis && (
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
                  aria-label={`Use ${FIELD_LABELS[field].toLowerCase()}`}
                >
                  Use
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
