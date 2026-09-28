import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { analyzeReportPhoto } from "../services/analyzeReportPhoto";
import { isReleasedCategory, type Category } from "@findback/shared";
import type { VlmAnalysis } from "../services/vlmParser";
import { Button } from "./Button";
import { fadeUpVariants, motionDurations, motionEasings } from "./uiMotion";

interface VlmSuggestionsProps {
  file: File | null;
  currentTitle: string;
  currentDescription: string;
  currentCategory: Category | "";
  /**
   * Applies one reviewed field. Must return true only when the patch actually
   * landed — a declined parent confirm resolves to false so the suggestion
   * stays visible instead of disappearing as though Apply succeeded.
   */
  onApply: (patch: Partial<VlmAnalysis>) => boolean;
}

const STANDARD_ERROR = "Couldn't draft text from this photo. You can retry or continue writing manually.";
const MISSING_KEY_ERROR = "Connect your OpenRouter API key to use AI.";
const DROPPED_CATEGORY_NOTE =
  "The suggested category isn't available yet, so it was left out. Pick a category manually.";

type FieldKey = "title" | "description" | "category";

const UNRESOLVED: Record<FieldKey, boolean> = {
  title: false,
  description: false,
  category: false,
};

/** User-selected photo analysis: explicit cloud consent, then explicit report review. */
export function VlmSuggestions({ file, currentTitle, currentDescription, currentCategory, onApply }: VlmSuggestionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<VlmAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<FieldKey, boolean>>(UNRESOLVED);
  const [editedTitle, setEditedTitle] = useState("");
  const [editedDescription, setEditedDescription] = useState("");
  const [editedCategory, setEditedCategory] = useState("");
  // Generation token: a response that resolves after the photo changed (or the
  // panel unmounted) is stale and must never populate this photo's panel.
  const generation = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Reset state when file changes (including null)
  useEffect(() => {
    generation.current++;
    setConsented(false);
    setSuggestion(null);
    setError(null);
    setNotice(null);
    setBusy(false);
    setResolved(UNRESOLVED);
    setEditedTitle("");
    setEditedDescription("");
    setEditedCategory("");
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, [file]);

  // Cleanup on unmount
  useEffect(() => () => {
    generation.current++;
    abortControllerRef.current?.abort();
  }, []);

  const isSupportedImage = file !== null && ["image/jpeg", "image/png", "image/webp"].includes(file.type);

  async function analyze() {
    if (!consented || busy || !file) return;
    const gen = ++generation.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    setSuggestion(null);
    setResolved(UNRESOLVED);
    try {
      const result = await analyzeReportPhoto(file, true, { signal: controller.signal });
      if (generation.current !== gen) return; // stale photo: drop, never auto-apply
      // An unreleased category is dropped, not fatal: the title and
      // description are still useful and applying is fully manual.
       if (result.categoryUnavailable || (result.suggestedCategory && !isReleasedCategory(result.suggestedCategory))) {
        setSuggestion({ ...result, suggestedCategory: null });
        setNotice(DROPPED_CATEGORY_NOTE);
        setEditedCategory("");
        setResolved({ ...UNRESOLVED, category: true });
      } else {
        setSuggestion(result);
        setEditedCategory(result.suggestedCategory ?? "");
        setResolved(UNRESOLVED);
      }
      setEditedTitle(result.suggestedTitle ?? "");
      setEditedDescription(result.suggestedDescription ?? "");
    }
    catch (err) {
      if (generation.current !== gen) return;
      if (err instanceof Error && err.name === "AbortError") {
        setError("AI request cancelled.");
      } else if ((err as { code?: string } | null)?.code === "MISSING_KEY") {
        setError(MISSING_KEY_ERROR);
      } else {
        setError(STANDARD_ERROR);
      }
    }
    finally {
      if (generation.current === gen) {
        setBusy(false);
        abortControllerRef.current = null;
      }
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
  }

  function resolveField(field: FieldKey) {
    const next = { ...resolved, [field]: true };
    setResolved(next);
    // Once every field has been reviewed, the comparison can go away.
    if (next.title && next.description && next.category) setSuggestion(null);
  }

  function handleApplyTitle() {
    if (!suggestion) return;
    if (onApply({ suggestedTitle: editedTitle })) resolveField("title");
  }

  function handleKeepTitle() {
    if (!suggestion) return;
    resolveField("title");
  }

  function handleApplyDescription() {
    if (!suggestion) return;
    if (onApply({ suggestedDescription: editedDescription })) resolveField("description");
  }

  function handleKeepDescription() {
    if (!suggestion) return;
    resolveField("description");
  }

  function handleApplyCategory() {
    if (!suggestion) return;
    if (!isReleasedCategory(editedCategory)) {
      setError("Choose one of the available categories, or keep your current one.");
      return;
    }
    if (onApply({ suggestedCategory: editedCategory as Category })) resolveField("category");
  }

  function handleKeepCategory() {
    if (!suggestion) return;
    resolveField("category");
  }

  function toggleExpanded() {
    setExpanded((prev) => !prev);
  }

  const headerContent = (
    <div className="flex items-center justify-between w-full">
      <div className="flex-1 text-left cursor-pointer" onClick={toggleExpanded}>
        <h2 className="text-base font-semibold">Draft description from photo</h2>
        <p className="text-sm text-on-surface-variant">Use one of your photos to suggest a title, description and category.</p>
      </div>
      <Button
        type="button"
        variant="text"
        size="md"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse photo suggestions" : "Expand photo suggestions"}
        className="shrink-0"
      >
        {expanded ? "▲" : "▼"}
      </Button>
    </div>
  );

  if (!file || !isSupportedImage) {
    return (
      <section aria-label="Draft description from photo" className="flex flex-col gap-3 rounded-m3-md border border-outline-variant bg-surface-container-low p-4">
        {headerContent}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="empty-hint"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
              className="overflow-hidden text-sm text-on-surface-variant"
              role="status"
            >
              Add a photo to draft text
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    );
  }

  return (
    <section aria-label="Draft description from photo" className="flex flex-col gap-3 rounded-m3-md border border-outline-variant bg-surface-container-low p-4">
      {headerContent}

      {/* Expanding panel: height + opacity instead of a hard reveal, so the
          form never pops in over the report fields below it. */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="suggestion-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            className="flex flex-col gap-3 overflow-hidden"
          >
          <label className="flex min-h-[48px] items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it.
          </label>

          <Button
            type="button"
            disabled={!consented || busy}
            loading={busy}
            onClick={analyze}
          >
            {busy ? "Analyzing photo…" : "Suggest title & description"}
          </Button>

          {busy && (
            <Button type="button" variant="outline" size="md" onClick={handleStop}>
              Stop
            </Button>
          )}

          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}

          {notice ? (
            <p role="status" className="text-sm text-on-surface-variant">
              {notice}
            </p>
          ) : null}

          {suggestion ? (
            <motion.div
              className="flex flex-col gap-3"
              role="region"
              aria-label="Review AI suggestions"
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            >
              <p className="text-sm font-medium">Review suggestions from AI:</p>

              {/* Title comparison */}
              {!resolved.title && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium w-32">Your title</span>
                    <span className="flex-1 text-on-surface-variant">{currentTitle || "(empty)"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium w-32">Suggested title</span>
                    <input
                      type="text"
                      aria-label="Suggested title"
                      value={editedTitle}
                      onChange={(e) => setEditedTitle(e.target.value)}
                      className="flex-1 border border-outline rounded-m3-sm px-2 py-1 text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="primary" size="md" onClick={handleApplyTitle}>Apply title</Button>
                    <Button type="button" variant="outline" size="md" onClick={handleKeepTitle}>Keep title</Button>
                  </div>
                </div>
              )}

              {/* Description comparison */}
              {!resolved.description && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-start gap-2 text-sm">
                    <span className="font-medium w-32">Your description</span>
                    <span className="flex-1 text-on-surface-variant">{currentDescription || "(empty)"}</span>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <span className="font-medium w-32">Suggested description</span>
                    <textarea
                      aria-label="Suggested description"
                      value={editedDescription}
                      onChange={(e) => setEditedDescription(e.target.value)}
                      className="flex-1 border border-outline rounded-m3-sm px-2 py-1 text-sm min-h-[60px]"
                      rows={3}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="primary" size="md" onClick={handleApplyDescription}>Apply description</Button>
                    <Button type="button" variant="outline" size="md" onClick={handleKeepDescription}>Keep description</Button>
                  </div>
                </div>
              )}

              {/* Category comparison */}
              {!resolved.category && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium w-32">Your category</span>
                    <span className="flex-1 text-on-surface-variant">{currentCategory || "(none)"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium w-32">Suggested category</span>
                    <input
                      type="text"
                      aria-label="Suggested category"
                      value={editedCategory}
                      onChange={(e) => setEditedCategory(e.target.value)}
                      className="flex-1 border border-outline rounded-m3-sm px-2 py-1 text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="primary" size="md" onClick={handleApplyCategory}>Apply category</Button>
                    <Button type="button" variant="outline" size="md" onClick={handleKeepCategory}>Keep category</Button>
                  </div>
                </div>
              )}

              {suggestion.uncertainFields.length > 0 && (
                <p className="text-sm text-on-surface-variant">
                  Uncertain: {suggestion.uncertainFields.join(", ")}
                </p>
              )}
            </motion.div>
          ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
