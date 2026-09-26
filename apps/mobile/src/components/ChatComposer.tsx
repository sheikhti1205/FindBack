import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Camera, ImagePlus, Maximize2, Mic, Minimize2, SendHorizonal, X } from "lucide-react";
import { speechInput } from "../services/speechInput";

/** Facade boundary for dictation: mock this prop in tests; real device pending. */
export type ComposerSpeech = typeof speechInput;

export interface ComposerImageSelection {
  id: string;
  name: string;
  previewUrl: string;
  /** Sampled-frame disclosure for animated inputs; null for stills. */
  disclosure: string | null;
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  inputLabel?: string;
  placeholder?: string;
  /**
   * Deprecated: M2 budgets in the controller instead of truncating. Kept for
   * prop compatibility and deliberately NOT rendered as maxlength.
   */
  maxLength?: number;
  selections?: readonly ComposerImageSelection[];
  maxSelections?: number;
  onRemoveSelection?: (id: string) => void;
  onAddFiles?: (files: File[]) => void;
  /** Honest capacity note (e.g. model takes fewer images); never a silent drop. */
  capacityNotice?: string | null;
  /** DOM id for the text field (skip links, focus management). */
  inputId?: string;
  /** Dictation facade (permission/listening/result/cancel). Defaults to the real facade. */
  speech?: ComposerSpeech;
}

type MicState = "idle" | "starting" | "listening";

/**
 * Chat composer: auto-growing textarea (1→6 lines, then internal scroll) plus
 * up-to-ten image selection previews. Controlled and IME-friendly (plain
 * value/onChange; Enter inserts a newline and never submits mid-composition —
 * sending happens through the form action / send button). Grayscale surfaces;
 * the send control carries the only strong fill.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  busy = false,
  onStop,
  disabled = false,
  inputLabel = "Ask the Help & FAQ",
  placeholder = "Ask about reporting, recovering, searching…",
  selections = [],
  maxSelections = 10,
  onRemoveSelection,
  onAddFiles,
  capacityNotice = null,
  inputId,
  speech,
}: ChatComposerProps) {
  const fileInputId = useId();
  const cameraInputId = useId();
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  const [micNotice, setMicNotice] = useState<string | null>(null);
  const baseDraft = useRef("");
  const micStateRef = useRef<MicState>("idle");
  const handles = useRef<Array<{ remove(): Promise<void> }>>([]);

  // G10 fix: photo-only drafts send — text is required only when no photos.
  const sendDisabled = disabled || busy || (value.trim() === "" && selections.length === 0);

  function setMic(next: MicState) {
    micStateRef.current = next;
    setMicState(next);
  }

  // Auto-grow 1→6 lines (12 expanded), then internal scroll. Never shrinks to
  // zero height in runtimes without layout (scrollHeight 0 → skip).
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight <= 0) return;
    const lineHeight = 24;
    const max = (expanded ? 12 : 6) * lineHeight;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value, expanded]);

  async function clearMicHandles() {
    const pending = handles.current;
    handles.current = [];
    for (const h of pending) {
      try {
        await h.remove();
      } catch {
        // Listener teardown is best-effort; the mic UI already moved on.
      }
    }
  }

  // Unmount mid-dictation: cancel the native session so no late result lands
  // in a dead composer.
  useEffect(
    () => () => {
      if (micStateRef.current !== "idle") {
        const facade = speech ?? speechInput;
        void facade.cancel().catch(() => {});
        for (const h of handles.current) {
          void h.remove().catch(() => {});
        }
        handles.current = [];
      }
    },
    [speech],
  );

  async function startDictation() {
    if (disabled || busy || micStateRef.current !== "idle") return;
    const facade = speech ?? speechInput;
    baseDraft.current = value;
    setMicNotice(null);
    setMic("starting");
    try {
      await facade.isAvailable();
    } catch (e) {
      setMicNotice(e instanceof Error ? e.message : "Dictation is only available in the Android app.");
      setMic("idle");
      return;
    }
    try {
      let permission = await facade.checkPermission();
      if (permission.state !== "granted") permission = await facade.requestPermission();
      if (permission.state !== "granted") {
        setMicNotice("Microphone permission is required for dictation.");
        setMic("idle");
        return;
      }
    } catch {
      setMicNotice("Microphone permission is required for dictation.");
      setMic("idle");
      return;
    }
    try {
      handles.current.push(
        await facade.addListener("speechResult", (payload) => {
          if (payload.isFinal) {
            const base = baseDraft.current;
            const next = base === "" ? payload.text : `${base} ${payload.text}`;
            baseDraft.current = next;
            onChange(next);
          } else {
            setMicNotice(`Listening… ${payload.text}`);
          }
        }),
      );
      handles.current.push(
        await facade.addListener("speechState", (payload) => {
          if (
            payload.state === "stopped" ||
            payload.state === "finished" ||
            payload.state === "cancelled" ||
            payload.state === "error"
          ) {
            setMic("idle");
          }
        }),
      );
      handles.current.push(
        await facade.addListener("speechError", (payload) => {
          setMicNotice(payload.message);
          setMic("idle");
        }),
      );
      await facade.start({ preferOnDevice: true });
      setMic("listening");
      setMicNotice("Listening…");
    } catch (e) {
      await clearMicHandles();
      setMicNotice(e instanceof Error ? e.message : "Speech recognition failed.");
      setMic("idle");
    }
  }

  async function stopDictation() {
    if (micStateRef.current !== "listening") return;
    const facade = speech ?? speechInput;
    try {
      await facade.stop();
    } catch (e) {
      setMicNotice(e instanceof Error ? e.message : "Speech recognition failed.");
    } finally {
      await clearMicHandles();
      setMic("idle");
    }
  }

  async function cancelDictation() {
    const facade = speech ?? speechInput;
    try {
      await facade.cancel();
    } catch {
      // Cancelling is best-effort; the draft restore below still applies.
    } finally {
      await clearMicHandles();
      onChange(baseDraft.current);
      setMicNotice(null);
      setMic("idle");
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (sendDisabled) return;
    onSend();
  }

  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    // Reset so picking the same file twice still fires change.
    e.target.value = "";
    if (files.length > 0) onAddFiles?.(files);
  }

  const listening = micState !== "idle";

  return (
    <form
      data-testid="chat-composer"
      onSubmit={onSubmit}
      className="flex flex-col gap-2 border-t border-outline-variant bg-surface p-3"
    >
      {selections.length > 0 && (
        <div
          data-testid="chat-selections"
          role="group"
          aria-label={`Selected photos, ${selections.length} of ${maxSelections}`}
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {selections.map((s) => (
            <figure
              key={s.id}
              data-testid={`chat-selection-${s.id}`}
              className="relative w-16 shrink-0"
            >
              {s.previewUrl !== "" ? (
                <img
                  src={s.previewUrl}
                  alt={s.name}
                  className="h-16 w-16 rounded-m3-xs border border-outline-variant object-cover"
                />
              ) : (
                <span
                  role="img"
                  aria-label={s.name}
                  className="flex h-16 w-16 items-center justify-center rounded-m3-xs border border-outline-variant bg-surface-container-low text-[10px] text-on-surface-variant"
                >
                  {s.name}
                </span>
              )}
              {s.disclosure !== null && <span className="sr-only">{s.disclosure}</span>}
              {onRemoveSelection !== undefined && (
                <button
                  type="button"
                  onClick={() => onRemoveSelection(s.id)}
                  aria-label={`Remove ${s.name}`}
                  className="absolute -right-2 -top-2 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full border border-outline-variant bg-surface text-on-surface shadow"
                >
                  <X size={16} aria-hidden />
                </button>
              )}
            </figure>
          ))}
        </div>
      )}
      {capacityNotice !== null && capacityNotice !== "" && (
        <p data-testid="chat-capacity-notice" className="text-[11px] text-on-surface-variant">
          {capacityNotice}
        </p>
      )}
      <div className="flex items-center gap-2">
        {onAddFiles !== undefined && (
          <>
            <label
              htmlFor={fileInputId}
              data-testid="chat-add-photos"
              className="flex min-h-[48px] min-w-[48px] cursor-pointer items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container"
            >
              <span className="sr-only">Add photos from gallery (up to {maxSelections})</span>
              <ImagePlus size={20} aria-hidden />
            </label>
            <input
              id={fileInputId}
              data-testid="chat-file-input"
              type="file"
              accept="image/*"
              multiple
              disabled={disabled || busy}
              onChange={onFiles}
              className="sr-only"
            />
            <label
              htmlFor={cameraInputId}
              data-testid="chat-take-photo"
              className="flex min-h-[48px] min-w-[48px] cursor-pointer items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container"
            >
              <span className="sr-only">Take a photo</span>
              <Camera size={20} aria-hidden />
            </label>
            <input
              id={cameraInputId}
              data-testid="chat-camera-input"
              type="file"
              accept="image/*"
              capture="environment"
              disabled={disabled || busy}
              onChange={onFiles}
              className="sr-only"
            />
          </>
        )}
        {listening ? (
          <>
            <button
              type="button"
              data-testid="chat-mic-stop"
              onClick={() => void stopDictation()}
              aria-label="Stop dictation"
              className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline text-on-surface"
            >
              <Mic size={20} aria-hidden />
            </button>
            <button
              type="button"
              data-testid="chat-mic-cancel"
              onClick={() => void cancelDictation()}
              aria-label="Cancel dictation"
              className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant"
            >
              <X size={20} aria-hidden />
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="chat-mic"
            onClick={() => void startDictation()}
            aria-label="Dictate"
            disabled={disabled || busy}
            className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container disabled:opacity-60"
          >
            <Mic size={20} aria-hidden />
          </button>
        )}
        <textarea
          ref={fieldRef}
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={inputLabel}
          disabled={disabled || busy}
          enterKeyHint="enter"
          autoComplete="off"
          rows={1}
          className={`w-full rounded-m3-md border border-outline-variant bg-surface px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none disabled:opacity-60 ${
            expanded ? "max-h-[40dvh]" : "max-h-[9rem]"
          } overflow-y-auto`}
        />
        <button
          type="button"
          data-testid="chat-expand"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Minimize composer" : "Expand composer"}
          className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container"
        >
          {expanded ? <Minimize2 size={20} aria-hidden /> : <Maximize2 size={20} aria-hidden />}
        </button>
        {busy && onStop !== undefined ? (
          <button
            type="button"
            data-testid="chat-stop"
            onClick={onStop}
            aria-label="Stop generating"
            className="flex h-12 shrink-0 items-center rounded-full border border-outline px-4 text-sm font-semibold text-on-surface"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            data-testid="chat-send"
            aria-label="Send"
            disabled={sendDisabled}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-on-surface text-surface disabled:opacity-40"
          >
            <SendHorizonal size={18} aria-hidden />
          </button>
        )}
      </div>
      {micNotice !== null && micNotice !== "" && (
        <p data-testid="chat-mic-status" role="status" className="text-[11px] text-on-surface-variant">
          {micNotice}
        </p>
      )}
    </form>
  );
}
