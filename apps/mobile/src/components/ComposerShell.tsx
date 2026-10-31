import { useLayoutEffect, useRef, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import { SendHorizonal } from "lucide-react";
import { hasFinePointer } from "./inputCapabilities";
import "./adaptiveFoundation.css";

export interface ComposerShellProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  inputLabel: string;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Explicit true supports attachment-only sends; domain owner validates them. */
  canSend?: boolean;
  /** Fine-pointer desktop default; touch keeps newline. Never inferred from width. */
  enterSends?: boolean;
  context?: ReactNode;
  attachments?: ReactNode;
  actions?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  inputOverlay?: ReactNode;
  sendLabel?: string;
  sendTestId?: string;
  inputProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "disabled" | "aria-label" | "placeholder">;
}

/** Layout/editing only. Uploads, account fencing, drafts and transport stay with callers. */
export function ComposerShell({ value, onChange, onSend, inputLabel, placeholder, disabled = false, busy = false,
  canSend = Boolean(value.trim()), enterSends, context, attachments, actions, inputProps,
  inputRef, inputOverlay, sendLabel = "Send", sendTestId }: ComposerShellProps) {
  const localInput = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? localInput;
  const composing = useRef(false);
  const available = canSend && !disabled && !busy;
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    const style = getComputedStyle(input.current);
    const cap = Math.min(208, (parseFloat(style.lineHeight) || 24) * 5 +
      (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0));
    if (input.current.scrollHeight > 0) input.current.style.height = `${Math.min(cap, input.current.scrollHeight)}px`;
    input.current.style.overflowY = input.current.scrollHeight > cap ? "auto" : "hidden";
  }, [value, input]);
  const send = () => { if (available && !composing.current) onSend(); };
  return <form className="fb-composer-shell" onSubmit={(event) => { event.preventDefault(); send(); }} aria-busy={busy || undefined}>
    {context && <div className="fb-composer-context">{context}</div>}
    {attachments && <div className="fb-composer-attachments">{attachments}</div>}
    <div className="fb-composer-row">
      {actions && <div className="fb-composer-actions">{actions}</div>}
      <div className="fb-composer-field">
      <textarea {...inputProps} ref={input} value={value} aria-label={inputLabel} placeholder={placeholder}
        disabled={disabled} rows={1} onChange={(event) => onChange(event.target.value)}
        onCompositionStart={(event) => { composing.current = true; inputProps?.onCompositionStart?.(event); }}
        onCompositionEnd={(event) => { composing.current = false; inputProps?.onCompositionEnd?.(event); }}
        onKeyDown={(event) => {
          inputProps?.onKeyDown?.(event);
          if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          const sends = enterSends ?? hasFinePointer();
          if (sends) { event.preventDefault(); if (!event.repeat) send(); }
        }} />
      {inputOverlay}
      </div>
      <button type="submit" aria-label={sendLabel} data-testid={sendTestId} disabled={!available} className="fb-icon-control fb-composer-send">
        <SendHorizonal size={20} aria-hidden="true" />
      </button>
    </div>
  </form>;
}
