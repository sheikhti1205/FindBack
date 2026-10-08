import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, ImagePlus, Maximize2, Mic, Minimize2, SendHorizonal, X } from "lucide-react";
import { speechInput } from "../services/speechInput";
import {
  fadeUpVariants,
  motionDurations,
  motionEasings,
  motionSprings,
  popoverVariants,
  pressFeedback,
  useShouldReduceMotion,
} from "./uiMotion";

/** Facade boundary for dictation: mock this prop in tests; real device pending. */
export type ComposerSpeech = typeof speechInput;

export type ComposerSelectionStatus = "ready" | "preparing" | "failed";

export interface ComposerImageSelection {
  id: string;
  name: string;
  previewUrl: string;
  /** Sampled-frame disclosure for animated inputs; null for stills. */
  disclosure: string | null;
  /** Native prep state. Absent/`ready` behaves like an ordinary attached photo. */
  status?: ComposerSelectionStatus;
  /** Consumer-safe preparation message shown while `preparing` or `failed`. */
  message?: string | null;
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
  /**
   * Android-native add-menu seam. When provided, Take a photo / Gallery route
   * through the device photo picker instead of the HTML File input; the caller
   * owns Preparing/Ready/Failed rows (see `ComposerImageSelection.status`).
   */
  onPickImage?: (source: "camera" | "gallery") => void;
  /** Retry a failed native preparation row. */
  onRetrySelection?: (id: string) => void;
  /** Block send while a photo is preparing/failed so it cannot be silently dropped. */
  blockSend?: boolean;
  /** Honest capacity note (e.g. model takes fewer images); never a silent drop. */
  capacityNotice?: string | null;
  /** DOM id for the text field (skip links, focus management). */
  inputId?: string;
  /** Dictation facade (permission/listening/result/cancel). Defaults to the real facade. */
  speech?: ComposerSpeech;
}

/**
 * Dictation phases. `starting` and `processing` are real platform windows
 * (permission/start request in flight; stop + listener teardown in flight) —
 * nothing here is a decorative state.
 */
type MicState = "idle" | "starting" | "listening" | "processing";

const MIC_STATE_LABEL: Record<MicState, string | null> = {
  idle: null,
  starting: "Starting dictation…",
  listening: "Listening…",
  processing: "Finishing…",
};

/**
 * How long the maximize/minimize geometry animation stays armed. Derived from
 * the sheet token (never a magic number): typing growth stays instant so the
 * caret never waits on an animation.
 */
const GEOMETRY_WINDOW_MS = motionDurations.sheet * 2000;

/**
 * Chat composer: auto-growing textarea (1→6 lines, then internal scroll) plus
 * up-to-ten image selection previews. Controlled and IME-friendly (plain
 * value/onChange; Enter inserts a newline and never submits mid-composition —
 * sending happens through the form action / send button). Grayscale surfaces;
 * the send control carries the only strong fill.
 *
 * Motion: send↔stop is one control that morphs (layout + icon crossfade),
 * maximize/minimize animates the container geometry through Motion `layout`,
 * dictation pulses only while the recorder is actually running, and the
 * permission pre-prompts rise/fade before the untouchable OS dialog.
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
  onPickImage,
  onRetrySelection,
  blockSend = false,
  capacityNotice = null,
  inputId,
  speech,
}: ChatComposerProps) {
  const fileInputId = useId();
  const cameraInputId = useId();
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  const [micNotice, setMicNotice] = useState<string | null>(null);
  /** Explained-before-asking microphone pre-prompt (the OS dialog follows). */
  const [micPermissionPrompt, setMicPermissionPrompt] = useState(false);
  /** Explained-before-launching camera pre-prompt (the native camera follows). */
  const [cameraPrompt, setCameraPrompt] = useState(false);
  const baseDraft = useRef("");
  const micStateRef = useRef<MicState>("idle");
  const handles = useRef<Array<{ remove(): Promise<void> }>>([]);
  const cameraExplained = useRef(false);
  const [geometryAnimate, setGeometryAnimate] = useState(false);
  const geometryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useShouldReduceMotion();

  // G10 fix: photo-only drafts send — text is required only when no photos.
  const sendDisabled = disabled || busy || blockSend || (value.trim() === "" && selections.length === 0);

  function setMic(next: MicState) {
    micStateRef.current = next;
    setMicState(next);
  }

  // Auto-grow from 1 line up to a 5-line cap (then internal scroll), or a
  // keyboard-safe ~40% of the visual viewport when expanded. Height comes from
  // scrollHeight — never from React state per keystroke — so the caret and the
  // editable value are untouched and nothing auto-sends. Deliberately NOT
  // animated: a per-keystroke transition would lag typing. The one geometry
  // change that does animate is maximize/minimize (see `toggleExpanded`).
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight <= 0) return;
    const style = window.getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 24;
    const pad =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const viewport = window.visualViewport?.height ?? window.innerHeight ?? 0;
    const cap = expanded
      ? Math.max(Math.round(viewport * 0.4), line * 5 + pad)
      : line * 5 + pad;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
  }, [value, expanded]);

  // Arm Motion `layout` only around the expand/collapse toggle so ordinary
  // typing growth stays instant (no animation queue, no caret lag).
  useLayoutEffect(() => {
    if (!geometryAnimate) return;
    if (geometryTimer.current !== null) clearTimeout(geometryTimer.current);
    geometryTimer.current = setTimeout(() => setGeometryAnimate(false), GEOMETRY_WINDOW_MS);
    return () => {
      if (geometryTimer.current !== null) clearTimeout(geometryTimer.current);
    };
  }, [geometryAnimate]);

  // Shared Add popover: focus the first option, close on Escape, restore focus.
  useEffect(() => {
    if (!addMenuOpen) return;
    addMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setAddMenuOpen(false);
        addTriggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [addMenuOpen]);

  function closeAddMenu() {
    setAddMenuOpen(false);
    addTriggerRef.current?.focus();
  }

  function chooseSource(source: "camera" | "gallery") {
    setAddMenuOpen(false);
    if (source === "camera") {
      if (!cameraExplained.current) {
        // Own explanatory UI first; the native camera surface owns everything
        // after the user continues.
        cameraExplained.current = true;
        setCameraPrompt(true);
        addTriggerRef.current?.focus();
        return;
      }
      if (onPickImage !== undefined) onPickImage("camera");
      else cameraInputRef.current?.click();
      addTriggerRef.current?.focus();
      return;
    }
    if (onPickImage !== undefined) onPickImage("gallery");
    else galleryInputRef.current?.click();
    addTriggerRef.current?.focus();
  }

  function continueCamera() {
    setCameraPrompt(false);
    if (onPickImage !== undefined) onPickImage("camera");
    else cameraInputRef.current?.click();
    addTriggerRef.current?.focus();
  }

  function toggleExpanded() {
    setGeometryAnimate(true);
    setExpanded((v) => !v);
  }

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

  async function beginListening(facade: ComposerSpeech) {
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
            setMicNotice(null);
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
      setMicNotice(null);
    } catch (e) {
      await clearMicHandles();
      setMicNotice(e instanceof Error ? e.message : "Speech recognition failed.");
      setMic("idle");
    }
  }

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
    let granted = false;
    try {
      const permission = await facade.checkPermission();
      granted = permission.state === "granted";
    } catch {
      granted = false;
    }
    if (!granted) {
      // Own animated pre-prompt: explain why before the OS dialog is triggered.
      setMic("idle");
      setMicPermissionPrompt(true);
      return;
    }
    await beginListening(facade);
  }

  async function continueDictation() {
    if (micStateRef.current !== "idle") return;
    setMicPermissionPrompt(false);
    const facade = speech ?? speechInput;
    setMicNotice(null);
    setMic("starting");
    try {
      const permission = await facade.requestPermission();
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
    await beginListening(facade);
  }

  async function stopDictation() {
    if (micStateRef.current !== "listening") return;
    const facade = speech ?? speechInput;
    setMic("processing");
    try {
      await facade.stop();
    } catch (e) {
      setMicNotice(e instanceof Error ? e.message : "Speech recognition failed.");
      await clearMicHandles();
      setMic("idle");
      return;
    }
    await clearMicHandles();
    setMicNotice(null);
    setMic("idle");
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
      setMicPermissionPrompt(false);
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

  const showStop = busy && onStop !== undefined;
  const listening = micState === "listening";
  const micStatus = micNotice ?? MIC_STATE_LABEL[micState];

  return (
    <motion.form
      data-testid="chat-composer"
      onSubmit={onSubmit}
      layout={geometryAnimate}
      transition={motionSprings.soft}
      className="flex flex-col gap-2 border-t border-outline-variant bg-surface p-3"
    >
      {selections.length > 0 && (
        <div
          data-testid="chat-selections"
          role="group"
          aria-label={`Selected photos, ${selections.length} of ${maxSelections}`}
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {selections.map((s) => {
            const status = s.status ?? "ready";
            return (
              <figure
                key={s.id}
                data-testid={`chat-selection-${s.id}`}
                data-status={status}
                className="relative w-16 shrink-0"
              >
                {status === "preparing" ? (
                  <span
                    role="img"
                    aria-label={s.message ?? `Preparing ${s.name}`}
                    className="flex h-16 w-16 items-center justify-center rounded-m3-xs border border-outline-variant bg-surface-container-low text-[10px] text-on-surface-variant"
                  >
                    Preparing…
                  </span>
                ) : status === "failed" ? (
                  <span
                    role="img"
                    aria-label={s.message ?? `${s.name} could not be added`}
                    className="flex h-16 w-16 items-center justify-center rounded-m3-xs border border-error bg-error-container px-1 text-center text-[10px] text-on-error-container"
                  >
                    Couldn’t add
                  </span>
                ) : s.previewUrl !== "" ? (
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
                {status === "ready" && s.disclosure !== null && <span className="sr-only">{s.disclosure}</span>}
                {status === "failed" && (
                  <span data-testid={`chat-selection-message-${s.id}`} className="sr-only">
                    {s.message ?? "Photo preparation failed."}
                  </span>
                )}
                {status === "failed" && onRetrySelection !== undefined && (
                  <button
                    type="button"
                    data-testid={`chat-selection-retry-${s.id}`}
                    onClick={() => onRetrySelection(s.id)}
                    className="absolute -bottom-2 left-0 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full border border-outline-variant bg-surface text-[10px] text-on-surface shadow"
                  >
                    Retry {s.name}
                  </button>
                )}
                {onRemoveSelection !== undefined && status !== "preparing" && (
                  <motion.button
                    type="button"
                    onClick={() => onRemoveSelection(s.id)}
                    aria-label={`Remove ${s.name}`}
                    whileTap={pressFeedback.iconButton}
                    transition={{ duration: motionDurations.instant }}
                    className="absolute -right-2 -top-2 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full border border-outline-variant bg-surface text-on-surface shadow"
                  >
                    <X size={16} aria-hidden />
                  </motion.button>
                )}
              </figure>
            );
          })}
        </div>
      )}
      {capacityNotice !== null && capacityNotice !== "" && (
        <p data-testid="chat-capacity-notice" className="text-[11px] text-on-surface-variant">
          {capacityNotice}
        </p>
      )}
      {/* Row 1 — the text field owns the full usable width (screenshot 11 fix):
          no 48dp icon siblings compete for intrinsic width at 360dp. */}
      <div data-testid="chat-field-row" className="flex min-w-0 w-full">
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
          className={`min-w-0 w-full resize-none rounded-m3-md border border-outline-variant bg-surface px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none disabled:opacity-60 ${
            expanded ? "max-h-[40dvh]" : "max-h-[9rem]"
          } overflow-y-auto`}
        />
      </div>
      {/* Row 2 — accessories: Add, mic, expand on the left; send/stop on the right. */}
      <div data-testid="chat-controls" className="relative flex items-center gap-2">
        {(onAddFiles !== undefined || onPickImage !== undefined) && (
          <>
            <motion.button
              type="button"
              ref={addTriggerRef}
              data-testid="chat-add-photos"
              aria-haspopup="dialog"
              aria-expanded={addMenuOpen}
              aria-controls={addMenuOpen ? `${fileInputId}-menu` : undefined}
              disabled={disabled || busy}
              onClick={() => setAddMenuOpen((v) => !v)}
              whileTap={pressFeedback.iconButton}
              transition={{ duration: motionDurations.instant }}
              className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container disabled:opacity-60"
            >
              <span className="sr-only">Add photos from gallery (up to {maxSelections})</span>
              <ImagePlus size={20} aria-hidden />
            </motion.button>
            <input
              id={fileInputId}
              ref={galleryInputRef}
              data-testid="chat-file-input"
              type="file"
              accept="image/*"
              multiple
              disabled={disabled || busy}
              onChange={onFiles}
              className="sr-only"
            />
            <input
              id={cameraInputId}
              ref={cameraInputRef}
              data-testid="chat-camera-input"
              type="file"
              accept="image/*"
              capture="environment"
              disabled={disabled || busy}
              onChange={onFiles}
              className="sr-only"
            />
            <AnimatePresence initial={false}>
              {addMenuOpen && (
                <motion.div
                  ref={addMenuRef}
                  id={`${fileInputId}-menu`}
                  key="add-menu"
                  data-testid="chat-add-menu"
                  role="dialog"
                  aria-label="Add photos"
                  variants={popoverVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                  className="absolute bottom-full left-3 z-10 mb-2 flex w-[min(16rem,calc(100vw-1.5rem))] flex-col gap-1 rounded-m3-md border border-outline-variant bg-surface-container p-1 shadow-lg"
                >
                  <button
                    type="button"
                    data-testid="chat-take-photo"
                    onClick={() => chooseSource("camera")}
                    className="flex min-h-[48px] w-full items-center gap-3 rounded-m3-sm px-3 text-left text-sm text-on-surface hover:bg-surface-container-high"
                  >
                    <Camera size={20} aria-hidden />
                    Take a photo
                  </button>
                  <button
                    type="button"
                    data-testid="chat-gallery"
                    onClick={() => chooseSource("gallery")}
                    className="flex min-h-[48px] w-full items-center gap-3 rounded-m3-sm px-3 text-left text-sm text-on-surface hover:bg-surface-container-high"
                  >
                    <ImagePlus size={20} aria-hidden />
                    Gallery
                  </button>
                  <button
                    type="button"
                    data-testid="chat-add-cancel"
                    onClick={closeAddMenu}
                    className="flex min-h-[48px] w-full items-center justify-center rounded-m3-sm px-3 text-sm text-on-surface-variant hover:bg-surface-container-high"
                  >
                    Cancel
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
        {/* Trailing element keeps the control row width stable across states. */}
        <div className="flex shrink-0 items-center gap-2" data-mic-state={micState}>
          {listening ? (
            <>
              <span className="relative flex shrink-0 items-center justify-center">
                {/* Truthful pulse: only mounted while the recorder is running,
                    removed the instant it stops. No fake waveform. */}
                {!reduceMotion && (
                  <motion.span
                    data-testid="chat-mic-pulse"
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-full border-2 border-on-surface"
                    initial={{ opacity: 0.55, scale: 1 }}
                    animate={{ opacity: [0.55, 0], scale: [1, 1.7] }}
                    transition={{
                      duration: motionDurations.emphasized,
                      repeat: Infinity,
                      ease: motionEasings.inOut,
                    }}
                  />
                )}
                {reduceMotion && (
                  <span
                    data-testid="chat-mic-recording"
                    aria-hidden
                    className="pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-on-surface"
                  />
                )}
                <motion.button
                  type="button"
                  key="mic-stop"
                  data-testid="chat-mic-stop"
                  onClick={() => void stopDictation()}
                  aria-label="Stop dictation"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: motionDurations.fast }}
                  whileTap={pressFeedback.iconButton}
                  className="relative flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline text-on-surface"
                >
                  <Mic size={20} aria-hidden />
                </motion.button>
              </span>
              <motion.button
                type="button"
                key="mic-cancel"
                data-testid="chat-mic-cancel"
                onClick={() => void cancelDictation()}
                aria-label="Cancel dictation"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: motionDurations.fast }}
                whileTap={pressFeedback.iconButton}
                className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant"
              >
                <X size={20} aria-hidden />
              </motion.button>
            </>
          ) : (
            <span className="relative flex shrink-0 items-center justify-center">
              <motion.button
                type="button"
                data-testid="chat-mic"
                onClick={() => void startDictation()}
                aria-label="Dictate"
                disabled={disabled || busy}
                whileTap={pressFeedback.iconButton}
                transition={{ duration: motionDurations.instant }}
                className="relative flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container disabled:opacity-60"
              >
                <Mic size={20} aria-hidden />
              </motion.button>
            </span>
          )}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <motion.button
            type="button"
            data-testid="chat-expand"
            onClick={toggleExpanded}
            aria-label={expanded ? "Minimize composer" : "Expand composer"}
            aria-expanded={expanded}
            whileTap={pressFeedback.iconButton}
            transition={{ duration: motionDurations.instant }}
            className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container"
          >
            <span className="grid place-items-center">
              <AnimatePresence initial={false}>
                {expanded ? (
                  <motion.span
                    key="minimize"
                    data-testid="chat-expand-icon-minimize"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                    className="grid [grid-area:1/1]"
                    aria-hidden
                  >
                    <Minimize2 size={20} />
                  </motion.span>
                ) : (
                  <motion.span
                    key="maximize"
                    data-testid="chat-expand-icon-maximize"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                    className="grid [grid-area:1/1]"
                    aria-hidden
                  >
                    <Maximize2 size={20} />
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </motion.button>
          {/* One control for send ↔ stop: `layout` morphs the geometry and the
              icon/label crossfades, so nothing is ever abruptly replaced. */}
          <motion.button
            layout
            type={showStop ? "button" : "submit"}
            data-testid={showStop ? "chat-stop" : "chat-send"}
            aria-label={showStop ? "Stop generating" : "Send"}
            disabled={showStop ? false : sendDisabled}
            onClick={showStop ? onStop : undefined}
            whileTap={showStop ? undefined : pressFeedback.button}
            transition={motionSprings.snappy}
            className={`flex h-12 shrink-0 items-center justify-center rounded-full ${
              showStop
                ? "border border-outline px-4 text-sm font-semibold text-on-surface"
                : "w-12 bg-on-surface text-surface disabled:opacity-40"
            }`}
          >
            <span className="grid place-items-center">
              <AnimatePresence initial={false}>
                {showStop ? (
                  <motion.span
                    key="stop"
                    data-testid="chat-send-icon-stop"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                    className="grid [grid-area:1/1]"
                  >
                    Stop
                  </motion.span>
                ) : (
                  <motion.span
                    key="send"
                    data-testid="chat-send-icon-send"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                    className="grid [grid-area:1/1]"
                    aria-hidden
                  >
                    <SendHorizonal size={18} />
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </motion.button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {micPermissionPrompt && (
          <motion.div
            key="mic-permission"
            data-testid="chat-mic-permission"
            role="group"
            aria-label="Microphone permission"
            variants={fadeUpVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            className="rounded-m3-sm border border-outline-variant bg-surface-container-low px-3 py-2"
          >
            <p className="text-xs text-on-surface-variant">
              Dictation needs microphone access. The system permission dialog opens next; you can
              decline there at any time.
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <motion.button
                type="button"
                data-testid="chat-mic-permission-continue"
                onClick={() => void continueDictation()}
                whileTap={pressFeedback.button}
                transition={{ duration: motionDurations.instant }}
                className="min-h-[48px] rounded-full bg-on-surface px-4 text-xs font-semibold text-surface"
              >
                Continue
              </motion.button>
              <motion.button
                type="button"
                data-testid="chat-mic-permission-dismiss"
                onClick={() => setMicPermissionPrompt(false)}
                whileTap={pressFeedback.button}
                transition={{ duration: motionDurations.instant }}
                className="min-h-[48px] rounded-full border border-outline-variant px-4 text-xs font-medium text-on-surface"
              >
                Not now
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {cameraPrompt && (
          <motion.div
            key="camera-permission"
            data-testid="chat-camera-permission"
            role="group"
            aria-label="Camera access"
            variants={fadeUpVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            className="rounded-m3-sm border border-outline-variant bg-surface-container-low px-3 py-2"
          >
            <p className="text-xs text-on-surface-variant">
              Your camera opens next so you can attach a photo. Photos stay on this device until
              you send them.
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <motion.button
                type="button"
                data-testid="chat-camera-permission-continue"
                onClick={continueCamera}
                whileTap={pressFeedback.button}
                transition={{ duration: motionDurations.instant }}
                className="min-h-[48px] rounded-full bg-on-surface px-4 text-xs font-semibold text-surface"
              >
                Continue
              </motion.button>
              <motion.button
                type="button"
                data-testid="chat-camera-permission-dismiss"
                onClick={() => setCameraPrompt(false)}
                whileTap={pressFeedback.button}
                transition={{ duration: motionDurations.instant }}
                className="min-h-[48px] rounded-full border border-outline-variant px-4 text-xs font-medium text-on-surface"
              >
                Not now
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {micStatus !== null && micStatus !== "" && (
          <motion.p
            key="mic-status"
            data-testid="chat-mic-status"
            role="status"
            variants={fadeUpVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="text-[11px] text-on-surface-variant"
          >
            {micStatus}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.form>
  );
}
