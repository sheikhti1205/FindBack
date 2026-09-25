import { useId, type ChangeEvent, type FormEvent } from "react";
import { ImagePlus, SendHorizonal, X } from "lucide-react";

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
  maxLength?: number;
  selections?: readonly ComposerImageSelection[];
  maxSelections?: number;
  onRemoveSelection?: (id: string) => void;
  onAddFiles?: (files: File[]) => void;
  /** Honest capacity note (e.g. model takes fewer images); never a silent drop. */
  capacityNotice?: string | null;
  /** DOM id for the text field (skip links, focus management). */
  inputId?: string;
}

/**
 * Chat composer: text input plus up-to-ten image selection previews.
 * Controlled and IME-friendly (plain value/onChange, submit on form action so
 * Android IME Done just sends). Grayscale surfaces; the send control carries
 * the only strong fill.
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
  maxLength = 500,
  selections = [],
  maxSelections = 10,
  onRemoveSelection,
  onAddFiles,
  capacityNotice = null,
  inputId,
}: ChatComposerProps) {
  const fileInputId = useId();
  const sendDisabled = disabled || busy || value.trim() === "";

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
              <span className="sr-only">Add photos (up to {maxSelections})</span>
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
          </>
        )}
        <input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={inputLabel}
          maxLength={maxLength}
          disabled={disabled || busy}
          enterKeyHint="send"
          autoComplete="off"
          className="w-full rounded-full border border-outline-variant bg-surface px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none disabled:opacity-60"
        />
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
    </form>
  );
}
