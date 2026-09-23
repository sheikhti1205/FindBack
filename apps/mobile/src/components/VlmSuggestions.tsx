import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Sparkles, AlertCircle, Download } from "lucide-react";
import { Button } from "./Button";
import { MarkdownView } from "./MarkdownView";
import {
  discoverObjectsLocally,
  suggestForPrimaryLocally,
  type ObjectSelection,
  type ObjectRole,
} from "../services/vlmDiscovery";
import { getVlmBridge, type InferenceStateEvent, type VlmState } from "../services/vlmPlugin";
import type { VlmAnalysis } from "../services/vlmParser";
import { diag, startActionTrace, clearAmbientTrace } from "../services/diag";
import { friendlyVlmMessage } from "../services/vlmErrors";
import type { ImageAnalysisReadiness } from "../services/models/imageAnalysisReadiness";

interface VlmSuggestionsProps {
  imageUri: string;
  onApply: (patch: Partial<VlmAnalysis>) => void;
  /** Report text already written; sent as context so suggestions fit the draft. */
  userContext?: { title: string; description: string };
  /** Frozen presentation-only readiness; Analyze stays gated until READY. */
  readiness?: ImageAnalysisReadiness;
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

export function VlmSuggestions({ imageUri, onApply, userContext, readiness }: VlmSuggestionsProps) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("idle");
  const [selections, setSelections] = useState<ObjectSelection[]>([]);
  const [instruction, setInstruction] = useState("");
  const [analysis, setAnalysis] = useState<VlmAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inferenceRunning, setInferenceRunning] = useState(false);
  /** Explicit CPU compatibility notice from the last successful analysis. */
  const [cpuNotice, setCpuNotice] = useState<string | null>(null);
  /** Per-photo generation: stale responses after an image change are ignored. */
  const generation = useRef(0);
  const traceIdRef = useRef<string | null>(null);

  // Changing the photo invalidates all unapplied AI state and stops the
  // native work for the old photo instead of letting it run to completion.
  useEffect(() => {
    generation.current++;
    void getVlmBridge()
      .cancelInference()
      .catch(() => undefined);
    setPhase("idle");
    setSelections([]);
    setInstruction("");
    setAnalysis(null);
    setError(null);
    setCpuNotice(null);
    setBusy(false);
  }, [imageUri]);

  // Subscribe to inference state to disable while another analysis runs
  useEffect(() => {
    let removeListener: (() => void) | null = null;
    getVlmBridge()
      .onInferenceState((event: InferenceStateEvent) => {
        const runningStates: VlmState[] = ["DOWNLOADING", "VERIFYING_HASH", "GPU_SELF_TESTING"];
        // Phase present means inference is active (native emits real phases,
        // never fake progress); phase absent on a terminal event means idle.
        setInferenceRunning(runningStates.includes(event.state) || event.phase !== undefined);
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

  const readinessGate = readiness != null && !readiness.available;
  const disabled = !imageUri || busy || inferenceRunning || readinessGate;

  /**
   * Reads the bridge's explicit CPU compatibility notice, if any. Missing on
   * older mocks/web — treated as no notice. Canonical UI copy is fixed here
   * so users always see the same sentence, never a raw backend diagnostic.
   */
  function readCpuNotice(): string | null {
    try {
      const bridge = getVlmBridge() as unknown as { getLastBackendNotice?: () => string | null };
      const notice = typeof bridge.getLastBackendNotice === "function" ? bridge.getLastBackendNotice() : null;
      if (notice && /cpu compatibility mode/i.test(notice)) return "GPU unavailable. Using CPU compatibility mode.";
      return null;
    } catch {
      return null;
    }
  }

  function fail(err: unknown) {
    diag("vlm.error.raw", {
      message: err instanceof Error ? err.message : String(err ?? "unknown"),
    }, { traceId: traceIdRef.current ?? undefined });
    setError(friendlyVlmMessage(err));
  }

  async function handleDiscover() {
    if (disabled) return;
    const gen = ++generation.current;
    traceIdRef.current = startActionTrace();
    clearAmbientTrace();
    setBusy(true);
    setError(null);
    setCpuNotice(null);
    setAnalysis(null);
    setPhase("discovering");
    const discoverStart = Date.now();
    try {
      const objects = await discoverObjectsLocally({ imageUri, mode: "AUTO" }, traceIdRef.current ?? undefined);
      if (generation.current !== gen) return;
      setCpuNotice(readCpuNotice());
      diag("vlm.discover.success", {
        objectCount: objects.length,
        ms: Date.now() - discoverStart,
      }, { traceId: traceIdRef.current ?? undefined });
      if (objects.length === 0) {
        setSelections([]);
        setError("No clear object found — please fill the details manually.");
        setPhase("idle");
      } else {
        setSelections(
          objects.map((o, i) => ({ ...o, role: i === 0 ? "PRIMARY" : "IGNORE" as ObjectRole })),
        );
        setPhase("review");
      }
    } catch (err) {
      if (generation.current !== gen) return;
      diag("vlm.discover.error", {
        message: err instanceof Error ? err.message : "unknown",
        ms: Date.now() - discoverStart,
      }, { traceId: traceIdRef.current ?? undefined });
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
        if (role === "PRIMARY" && s.role === "PRIMARY") return { ...s, role: "IGNORE" };
        return s;
      }),
    );
  }

  async function handleGenerate() {
    const primary = selections.find((s) => s.role === "PRIMARY");
    if (!primary || busy) return;
    if (selections.filter((s) => s.role === "PRIMARY").length !== 1) return;
    const gen = ++generation.current;
    traceIdRef.current = startActionTrace();
    clearAmbientTrace();
    setBusy(true);
    setError(null);
    setCpuNotice(null);
    setPhase("generating");
    const generateStart = Date.now();
    try {
      const result = await suggestForPrimaryLocally({
        imageUri,
        mode: "AUTO",
        primary: primary.objectName,
        include: selections.filter((s) => s.role === "INCLUDE").map((s) => s.objectName),
        ignore: selections.filter((s) => s.role === "IGNORE").map((s) => s.objectName),
        userInstruction: instruction,
        userContext: {
          title: userContext?.title ?? "",
          description: userContext?.description ?? "",
        },
      }, traceIdRef.current ?? undefined);
      if (generation.current !== gen) return;
      setAnalysis(result);
      setCpuNotice(readCpuNotice());
      diag("vlm.generate.success", {
        primary: primary.objectName,
        includeCount: selections.filter((s) => s.role === "INCLUDE").length,
        ignoreCount: selections.filter((s) => s.role === "IGNORE").length,
        hasTitle: !!result.suggestedTitle,
        hasDescription: !!result.suggestedDescription,
        hasCategory: !!result.suggestedCategory,
        ms: Date.now() - generateStart,
      }, { traceId: traceIdRef.current ?? undefined });
      setPhase("done");
    } catch (err) {
      if (generation.current !== gen) return;
      diag("vlm.generate.error", {
        message: err instanceof Error ? err.message : "unknown",
        ms: Date.now() - generateStart,
      }, { traceId: traceIdRef.current ?? undefined });
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

  function handleCancel() {
    generation.current++;
    void getVlmBridge()
      .cancelInference()
      .catch(() => undefined);
    setBusy(false);
    setError(null);
    setPhase(selections.length > 0 ? "review" : "idle");
  }

  if (!imageUri) {
    return null;
  }

  const primaryCount = selections.filter((s) => s.role === "PRIMARY").length;

  return (
    <section className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-3" aria-label="Local AI analysis">
      <p className="text-sm font-medium">Analyze with local AI</p>

      {cpuNotice && (
        <p role="status" className="rounded-m3-sm border border-outline-variant px-3 py-2 text-sm">
          {cpuNotice}
        </p>
      )}

      {readinessGate && readiness != null && (
        <div role="status" className="flex flex-col gap-2 rounded-m3-sm border border-outline-variant px-3 py-2 text-sm">
          <span>
            {readiness.reason === "CHECKING" && "Checking model status…"}
            {readiness.reason === "NO_MODEL" && "No on-device model yet. Set it up in Offline AI — you can still fill the details manually below."}
            {readiness.reason === "VERIFY_REQUIRED" && "Model installed but not verified. Verify the accelerator in Offline AI — you can still fill the details manually below."}
            {readiness.reason === "UNAVAILABLE" && "Model unavailable on this device. Check Offline AI for details — you can still fill the details manually below."}
          </span>
          {readiness.reason !== "CHECKING" && (
            <Button type="button" variant="outline" size="md" onClick={() => navigate("/offline-ai")}>
              <Download size={14} aria-hidden />
              {readiness.reason === "VERIFY_REQUIRED" ? "Verify in Offline AI" : "Set up in Offline AI"}
            </Button>
          )}
        </div>
      )}

      {(phase === "idle" || phase === "discovering") && (
        <div className="flex flex-wrap gap-2">
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
          {phase === "discovering" && (
            <Button type="button" variant="text" size="md" onClick={handleCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}

      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          <AlertCircle size={16} aria-hidden />
          <span>{error}</span>
          {(error.includes("isn't available") || error.includes("Offline AI")) && (
            <Button type="button" variant="text" size="md" onClick={() => navigate("/offline-ai")}>
              <Download size={14} aria-hidden />
              Open Offline AI
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
              onChange={(e) => setInstruction(e.target.value.slice(0, 300))}
              maxLength={300}
              placeholder="Anything the photo does not show clearly…"
              className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap gap-2">
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
            {phase === "generating" && (
              <Button type="button" variant="text" size="md" onClick={handleCancel}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {phase === "done" && analysis && (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" size="md" onClick={() => setPhase("review")}>
            Choose different item
          </Button>
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
