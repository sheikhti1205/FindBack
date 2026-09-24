import { useState, type FormEvent } from "react";
import { BottomSheet } from "./BottomSheet";
import { announce } from "./LiveRegion";
import {
  buildAssistantReportHandoff,
  type AssistantReportHandoff,
} from "../services/assistant/assistantHandoff";
import { RECOVERY_COPY, type RecoveryAction } from "../services/ai/errors";
import type { AiErrorClass } from "../services/ai/types";
import {
  executeAssistantMessage,
  type AssistantExecutionRuntime,
} from "../services/assistant/assistantExecution";
import type { ModelProfile } from "../services/ai/modelProfiles";
import {
  GUIDED_FLOWS,
  LOCATION_CHOICES,
  PHOTO_CHOICES,
  chooseLocation,
  choosePhoto,
  nextMissingQuestion,
  retryAfterRecovery,
  startFlow,
  type GuidedFlow,
  type GuidedSnapshot,
  type LocationChoice,
  type PhotoChoice,
} from "../services/assistant/guidedAssistantController";

const SHORTCUT_LABELS: Record<GuidedFlow, string> = {
  lost: "Report a lost item",
  found: "Report a found item",
  search: "Search listings",
  ask: "Ask a question",
};

const PHOTO_LABELS: Record<PhotoChoice, string> = {
  take: "Take a photo",
  choose: "Choose a photo",
  none: "No photo",
};

const LOCATION_LABELS: Record<LocationChoice, string> = {
  map: "Pick on a map",
  current: "Use current location",
  typed: "Type a place name",
  skip: "Skip location",
};

export function AssistantRecoveryNotice({
  errorClass,
  onAction,
}: {
  errorClass: AiErrorClass;
  onAction?: (action: RecoveryAction) => void;
}) {
  const plan = RECOVERY_COPY[errorClass];
  return (
    <div data-testid="assistant-recovery" className="flex flex-col gap-2">
      <p data-testid="assistant-recovery-message" className="text-sm">
        {plan.message}
      </p>
      <div className="flex flex-wrap gap-2">
        {plan.actions.map((action) => (
          <button
            key={action}
            type="button"
            data-testid={`assistant-recovery-action-${action}`}
            onClick={() => onAction?.(action)}
            className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
          >
            {action}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AssistantPhotoStep({
  onChoice,
}: {
  onChoice?: (choice: PhotoChoice) => void;
}) {
  return (
    <div data-testid="assistant-photo-step" className="flex flex-col gap-2">
      <p className="text-sm">Would you like to add a photo?</p>
      <div className="flex flex-wrap gap-2">
        {PHOTO_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            data-testid={`assistant-photo-${choice}`}
            onClick={() => onChoice?.(choice)}
            className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
          >
            {PHOTO_LABELS[choice]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AssistantLocationStep({
  onChoice,
}: {
  onChoice?: (choice: LocationChoice) => void;
}) {
  return (
    <div data-testid="assistant-location-step" className="flex flex-col gap-2">
      <p className="text-sm">How should the location be added?</p>
      <div className="flex flex-wrap gap-2">
        {LOCATION_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            data-testid={`assistant-location-${choice}`}
            onClick={() => onChoice?.(choice)}
            className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
          >
            {LOCATION_LABELS[choice]}
          </button>
        ))}
      </div>
    </div>
  );
}

function AssistantReadySummary({ snapshot }: { snapshot: GuidedSnapshot }) {
  const rows: Array<{ label: string; value: string }> = [];
  if (snapshot.patch.type !== undefined)
    rows.push({ label: "Type", value: snapshot.patch.type });
  if (snapshot.patch.title !== undefined)
    rows.push({ label: "Title", value: snapshot.patch.title });
  if (snapshot.patch.description !== undefined)
    rows.push({ label: "Description", value: snapshot.patch.description });
  if (snapshot.patch.category !== undefined)
    rows.push({ label: "Category", value: snapshot.patch.category });
  if (snapshot.patch.eventDate !== undefined)
    rows.push({ label: "Date", value: snapshot.patch.eventDate });
  if (snapshot.patch.locationNote !== undefined)
    rows.push({ label: "Location note", value: snapshot.patch.locationNote });
  if (snapshot.searchFilters?.query !== undefined)
    rows.push({ label: "Search", value: snapshot.searchFilters.query });
  if (rows.length === 0) return null;
  return (
    <div data-testid="assistant-ready" className="flex flex-col gap-1">
      <p className="text-sm font-medium">Summary of what was collected:</p>
      <dl className="flex flex-col gap-1 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-2">
            <dt className="text-on-surface-variant">{row.label}:</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export interface AssistantTranscriptEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Short display label for a runtime profile. Used only when the injector
 * did not provide an explicit `modelLabel`; explicit labels (which name
 * the exact resident entry, including quant variants) always win.
 */
export function shortLabelForProfile(profile: ModelProfile): string {
  switch (profile.id) {
    case "qwen3-0.6b-dynamic-int4":
      return "Qwen";
    case "lfm2.5-1.2b-q4_0":
      return "LFM2.5 1.2B";
    case "smolvlm2-500m-text":
      return "SmolVLM2 500M";
    default:
      return profile.corpusLabel;
  }
}

export interface AssistantSheetProps {
  open: boolean;
  onClose: () => void;
  onShortcut?: (flow: GuidedFlow) => void;
  onPhotoChoice?: (choice: PhotoChoice) => void;
  onLocationChoice?: (choice: LocationChoice) => void;
  onRecoveryAction?: (action: RecoveryAction) => void;
  /**
   * Execution runtime. Defaults to grounded local routing with the server
   * Help path for app questions (no model required).
   */
  runtime?: AssistantExecutionRuntime;
  /** Emitted on every snapshot change so outer flows can consume held results. */
  onSnapshot?: (snapshot: GuidedSnapshot) => void;
  /** Emitted with the frozen handoff when the enabled Review report action runs. */
  onReviewReport?: (handoff: AssistantReportHandoff) => void;
}

export function AssistantSheet({
  open,
  onClose,
  onShortcut,
  onPhotoChoice,
  onLocationChoice,
  onRecoveryAction,
  runtime,
  onSnapshot,
  onReviewReport,
}: AssistantSheetProps) {
  const [snapshot, setSnapshot] = useState<GuidedSnapshot | null>(null);
  const [transcript, setTranscript] = useState<readonly AssistantTranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");

  function update(next: GuidedSnapshot): void {
    setSnapshot(next);
    onSnapshot?.(next);
  }

  function begin(flow: GuidedFlow): void {
    update(startFlow(flow));
    setTranscript([]);
    onShortcut?.(flow);
  }

  async function submitText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    if (snapshot !== null && snapshot.state === "recovering") return;
    const typedLocation =
      snapshot !== null &&
      snapshot.state === "awaitingLocation" &&
      snapshot.flow !== "search" &&
      snapshot.flow !== "ask";
    setTranscript((previous) => [...previous, { role: "user", text: trimmed }]);
    setBusy(true);
    try {
      const result = await executeAssistantMessage(snapshot, trimmed, runtime ?? {});
      update(result.snapshot);
      setTranscript((previous) => [...previous, { role: "assistant", text: result.reply }]);
      if (typedLocation && result.snapshot.locationChoice === "typed") {
        onLocationChoice?.("typed");
      }
    } finally {
      setBusy(false);
    }
  }

  function submitInput(event: FormEvent): void {
    event.preventDefault();
    const text = input;
    setInput("");
    void submitText(text);
  }

  function pickPhoto(choice: PhotoChoice): void {
    if (snapshot === null) return;
    update(choosePhoto(snapshot, choice));
    onPhotoChoice?.(choice);
  }

  function pickLocation(choice: LocationChoice): void {
    if (snapshot === null || snapshot.state === "recovering") return;
    if (choice === "typed") return;
    update(chooseLocation(snapshot, choice));
    onLocationChoice?.(choice);
  }

  function recover(action: RecoveryAction): void {
    if (snapshot !== null && action === "Retry") {
      update(retryAfterRecovery(snapshot));
    }
    onRecoveryAction?.(action);
  }

  function reviewReport(): void {
    if (snapshot === null) return;
    const handoff = buildAssistantReportHandoff(snapshot);
    if (handoff === null) return;
    onReviewReport?.(handoff);
    announce("Report ready for review.");
    onClose();
  }

  const question = snapshot === null ? null : nextMissingQuestion(snapshot);
  const localModelOn = runtime?.generate !== undefined;
  // Actual resident model label (AI-06): the injector that knows the
  // active entry sets `modelLabel`; a profile-only runtime falls back to
  // its profile's short label. The bare-`generate` fallback preserves the
  // legacy Qwen wording for label-less injectors (tests); production
  // text sessions always carry the real label via resolveLocalTextRuntime.
  const modelName =
    runtime?.modelLabel ??
    (runtime?.profile !== undefined ? shortLabelForProfile(runtime.profile) : "Qwen");
  const handoff = snapshot === null ? null : buildAssistantReportHandoff(snapshot);
  const lastAssistantIndex = transcript.reduce(
    (found, entry, index) => (entry.role === "assistant" ? index : found),
    -1,
  );

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Assistant"
      description="Guided help for reports, search, and questions."
    >
      <div className="flex flex-col gap-3">
        <p data-testid="assistant-greeting" className="text-sm">
          Hello! I can guide you through reporting a lost or found item, searching
          listings, or answering questions about the app.
        </p>
        <p data-testid="assistant-source-note" className="text-xs text-on-surface-variant">
          {localModelOn
            ? `Using ${modelName} locally for this session.`
            : "Using built-in help — no on-device text model is running."}
        </p>
        <div className="flex flex-wrap gap-2">
          {GUIDED_FLOWS.map((flow) => (
            <button
              key={flow}
              type="button"
              data-testid={`assistant-shortcut-${flow}`}
              onClick={() => begin(flow)}
              className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
            >
              {SHORTCUT_LABELS[flow]}
            </button>
          ))}
        </div>
        {snapshot !== null && snapshot.state !== "recovering" && question !== null ? (
          <p data-testid="assistant-question" className="text-sm font-medium">
            {question.question}
          </p>
        ) : null}
        {transcript.length > 0 ? (
          <div
            data-testid="assistant-transcript"
            role="log"
            aria-live="polite"
            aria-label="Assistant conversation"
            className="flex flex-col gap-2"
          >
            <ul className="flex flex-col gap-2">
              {transcript.map((entry, index) => (
                <li
                  key={`${entry.role}-${index}-${entry.text.length}`}
                  data-testid={`assistant-transcript-${entry.role}`}
                  className="flex flex-col gap-0.5 rounded-m3-sm border border-outline-variant px-3 py-2"
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                    {entry.role === "user" ? "You" : "Assistant"}
                  </span>
                  <p
                    className="text-sm"
                    {...(index === lastAssistantIndex && entry.role === "assistant"
                      ? { "data-testid": "assistant-reply" }
                      : null)}
                  >
                    {entry.text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {snapshot?.state === "awaitingPhoto" && snapshot.photoRequest !== undefined ? (
          <AssistantPhotoStep onChoice={pickPhoto} />
        ) : null}
        {snapshot?.state === "awaitingLocation" && snapshot.locationRequest !== undefined ? (
          <AssistantLocationStep onChoice={pickLocation} />
        ) : null}
        {snapshot?.state === "recovering" && snapshot.recovery !== undefined ? (
          <AssistantRecoveryNotice errorClass={snapshot.recovery.errorClass} onAction={recover} />
        ) : null}
        {snapshot?.state === "ready" ? <AssistantReadySummary snapshot={snapshot} /> : null}
        {handoff !== null ? (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              data-testid="assistant-review-report"
              onClick={reviewReport}
              aria-label="Review report"
              className="min-h-[48px] rounded-full bg-on-surface px-3 text-xs font-medium text-surface"
            >
              Review report
            </button>
            <p data-testid="assistant-review-note" className="text-xs text-on-surface-variant">
              Continue to the report form to review these details before publishing. Nothing is
              published automatically.
            </p>
          </div>
        ) : null}
        <form data-testid="assistant-form" onSubmit={submitInput} className="flex items-center gap-2">
          <input
            data-testid="assistant-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type your answer…"
            aria-label="Message the assistant"
            maxLength={500}
            className="w-full rounded-full border border-outline-variant bg-surface px-4 py-2.5 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={input.trim() === "" || busy}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-on-surface text-surface disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </BottomSheet>
  );
}
