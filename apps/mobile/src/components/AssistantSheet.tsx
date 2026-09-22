import { useState, type FormEvent } from "react";
import { BottomSheet } from "./BottomSheet";
import { RECOVERY_COPY, type RecoveryAction } from "../services/ai/errors";
import type { AiErrorClass } from "../services/ai/types";
import {
  GUIDED_FLOWS,
  LOCATION_CHOICES,
  PHOTO_CHOICES,
  applyReportFields,
  applySearchFields,
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

export interface AssistantSheetProps {
  open: boolean;
  onClose: () => void;
  onShortcut?: (flow: GuidedFlow) => void;
  onPhotoChoice?: (choice: PhotoChoice) => void;
  onLocationChoice?: (choice: LocationChoice) => void;
  onRecoveryAction?: (action: RecoveryAction) => void;
}

export function AssistantSheet({
  open,
  onClose,
  onShortcut,
  onPhotoChoice,
  onLocationChoice,
  onRecoveryAction,
}: AssistantSheetProps) {
  const [snapshot, setSnapshot] = useState<GuidedSnapshot | null>(null);
  const [input, setInput] = useState("");

  function begin(flow: GuidedFlow): void {
    setSnapshot(startFlow(flow));
    onShortcut?.(flow);
  }

  function submitInput(event: FormEvent): void {
    event.preventDefault();
    const text = input.trim();
    if (text === "") return;
    setInput("");
    if (snapshot === null) {
      setSnapshot(applySearchFields(startFlow("ask"), { query: text }));
      onShortcut?.("ask");
      return;
    }
    if (snapshot.state === "recovering") return;
    if (snapshot.state === "awaitingLocation") {
      setSnapshot(chooseLocation(snapshot, "typed", text));
      onLocationChoice?.("typed");
      return;
    }
    if (snapshot.flow === "search") {
      setSnapshot(applySearchFields(snapshot, { query: text }));
      return;
    }
    if (snapshot.flow === "ask") return;
    const missing = snapshot.missingFields;
    if (missing.includes("category")) {
      setSnapshot(applyReportFields(snapshot, { category: text }));
    } else if (missing.includes("date")) {
      setSnapshot(applyReportFields(snapshot, { dateText: text }));
    } else if (missing.includes("location")) {
      setSnapshot(applyReportFields(snapshot, { locationNote: text }));
    }
  }

  function pickPhoto(choice: PhotoChoice): void {
    if (snapshot === null) return;
    setSnapshot(choosePhoto(snapshot, choice));
    onPhotoChoice?.(choice);
  }

  function pickLocation(choice: LocationChoice): void {
    if (snapshot === null || snapshot.state === "recovering") return;
    if (choice === "typed") return;
    setSnapshot(chooseLocation(snapshot, choice));
    onLocationChoice?.(choice);
  }

  function recover(action: RecoveryAction): void {
    if (snapshot !== null && action === "Retry") {
      setSnapshot(retryAfterRecovery(snapshot));
    }
    onRecoveryAction?.(action);
  }

  const question = snapshot === null ? null : nextMissingQuestion(snapshot);

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
            disabled={input.trim() === ""}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-on-surface text-surface disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </BottomSheet>
  );
}
