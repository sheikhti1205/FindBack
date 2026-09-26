import { useEffect, useId, useRef, type FocusEvent, type RefObject } from "react";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { X } from "lucide-react";
import { registerBackInterceptor } from "./backNavigation";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { backdropTransition, sheetTransition } from "./uiMotion";

export type BottomSheetHeight = "medium" | "large" | "full";

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  height?: BottomSheetHeight;
  /** False for critical ops: hides Close, ignores backdrop/Escape/drag/back. */
  dismissible?: boolean;
  closeLabel?: string;
  children: React.ReactNode;
}

const MAX_HEIGHT: Record<BottomSheetHeight, string> = {
  medium: "50dvh",
  large: "85dvh",
  full: "100dvh",
};

/** Downward travel (or flick) past these dismisses a dismissible sheet. */
const DRAG_DISMISS_OFFSET_PX = 120;
const DRAG_DISMISS_VELOCITY_PX_S = 500;

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true']";

/**
 * Modal bottom-sheet primitive (Phase-2 foundation, unstyled content slot).
 *
 * Composes the existing modal primitives: `useFocusTrap` (focus enter, Tab
 * wrap, Escape, focus return to the launcher) and the `registerBackInterceptor`
 * back stack the BackButtonHandler consults before navigating.
 *
 * Dragging starts from the handle only (`dragListener={false}` + drag
 * controls), so nested scrollable content never fights the sheet gesture.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  description,
  height = "large",
  dismissible = true,
  closeLabel = "Close",
  children,
}: BottomSheetProps) {
  return (
    <AnimatePresence>
      {open ? (
        <BottomSheetDialog
          key="bottom-sheet"
          onClose={onClose}
          title={title}
          description={description}
          height={height}
          dismissible={dismissible}
          closeLabel={closeLabel}
        >
          {children}
        </BottomSheetDialog>
      ) : null}
    </AnimatePresence>
  );
}

function BottomSheetDialog({
  onClose,
  title,
  description,
  height = "large",
  dismissible,
  closeLabel,
  children,
}: Omit<BottomSheetProps, "open">) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const dragControls = useDragControls();

  // Latest-callback refs so global listeners never capture a stale onClose.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  const requestClose = (): void => {
    if (dismissibleRef.current) onCloseRef.current();
  };

  // Focus enter + Tab wrap + Escape + focus return to the launcher.
  useFocusTrap(sheetRef as RefObject<HTMLElement | null>, requestClose);

  // Android/browser back dismisses instead of leaving the screen. In
  // non-dismissible mode the press is still consumed so a critical op cannot
  // be cancelled by hardware back.
  useEffect(() => {
    return registerBackInterceptor(() => {
      requestClose();
      return true;
    });
  }, []);

  // Background page must not scroll behind the sheet.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Keyboard/IME: keep the focused field visible instead of letting the
  // sheet or the on-screen keyboard cover it.
  const handleContentFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(EDITABLE_SELECTOR)) {
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "nearest" });
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50">
      <motion.div
        data-testid="bottom-sheet-backdrop"
        aria-hidden="true"
        onClick={requestClose}
        className="absolute inset-0"
        style={{ background: "var(--scrim)" }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={backdropTransition}
      />
      <motion.div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-testid="bottom-sheet"
        data-height={height}
        tabIndex={-1}
        drag={dismissible ? "y" : false}
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={{ top: 0 }}
        dragElastic={0.2}
        dragSnapToOrigin
        onDragEnd={(_event, info) => {
          if (!dismissibleRef.current) return;
          if (
            info.offset.y > DRAG_DISMISS_OFFSET_PX ||
            info.velocity.y > DRAG_DISMISS_VELOCITY_PX_S
          ) {
            onCloseRef.current();
          }
        }}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={sheetTransition}
        style={{ maxHeight: MAX_HEIGHT[height], boxShadow: "var(--shadow-md)" }}
        className="absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-md flex-col rounded-t-m3-xl bg-surface pb-[env(safe-area-inset-bottom)] text-on-surface"
      >
        <div
          data-testid="bottom-sheet-handle"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (dismissible) dragControls.start(event);
          }}
          className="flex min-h-[32px] shrink-0 cursor-grab touch-none items-center justify-center pt-2 active:cursor-grabbing"
        >
          <span className="h-1 w-10 rounded-full bg-outline-variant" />
        </div>
        <div className="flex shrink-0 items-start gap-2 px-4 pb-2">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="min-w-0 break-words text-lg font-semibold">
              {title}
            </h2>
            {description ? (
              <p
                id={descriptionId}
                className="mt-0.5 min-w-0 break-words text-sm text-on-surface-variant"
              >
                {description}
              </p>
            ) : null}
          </div>
          {dismissible ? (
            <button
              type="button"
              aria-label={closeLabel}
              onClick={() => onCloseRef.current()}
              className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-m3-sm text-on-surface-variant hover:bg-surface-container"
            >
              <X size={24} aria-hidden />
            </button>
          ) : null}
        </div>
        <div
          data-testid="bottom-sheet-content"
          onFocus={handleContentFocus}
          style={{ overflowY: "auto" }}
          className="min-h-0 flex-1 px-4 pb-4"
        >
          {children}
        </div>
      </motion.div>
    </div>
  );
}
