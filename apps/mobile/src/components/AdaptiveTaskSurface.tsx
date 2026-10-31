import { useId, type ReactNode } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { X } from "lucide-react";
import { useKeyboardInset } from "../hooks/keyboardInset";
import { OverlayDepthProvider, OverlayStackBridge, useOverlayDepth } from "./overlayFoundation";

interface SurfaceProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  width?: "standard" | "report";
}

function DialogSurface({ open, onClose, title, description, children, footer, busy = false, confirmation = false, width = "standard" }: SurfaceProps & { confirmation?: boolean }) {
  const depth = useOverlayDepth();
  const descriptionId = useId();
  const viewport = useKeyboardInset();
  return <ModalOverlay isOpen={open} onOpenChange={(value) => { if (!value && !busy) onClose(); }}
    isDismissable={!confirmation && !busy} isKeyboardDismissDisabled
    className="fb-modal-backdrop" style={{
      zIndex: 70 + depth * 10,
      height: viewport.viewportHeightPx || undefined,
      top: Math.max(0, window.innerHeight - viewport.insetPx - viewport.viewportHeightPx),
      bottom: "auto",
    }}>
    <Modal className={`fb-modal-panel ${confirmation ? "fb-confirm-panel" : "fb-task-panel"} ${width === "report" ? "fb-report-panel" : ""}`}>
      <OverlayDepthProvider depth={depth}>
        <OverlayStackBridge onClose={onClose} dismissible={!busy} />
        <Dialog role={confirmation ? "alertdialog" : "dialog"} aria-describedby={description ? descriptionId : undefined}
          aria-busy={busy || undefined} className="fb-surface-dialog">
          <header className="fb-surface-header">
            <Heading slot="title" className="fb-surface-title">{title}</Heading>
            {/* Explicit child focus avoids useDialog's delayed dialog refocus
                racing nested-viewer restoration when a task is opened quickly. */}
            {!confirmation && <Button autoFocus aria-label="Close" isDisabled={busy} onPress={onClose} className="fb-icon-control">
              <X size={20} aria-hidden="true" />
            </Button>}
          </header>
          <div className="fb-surface-body" onFocus={(event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']")) target.scrollIntoView?.({ block: "nearest" });
          }}>
            {description && <p id={descriptionId} className="fb-surface-description">{description}</p>}
            {children}
          </div>
          {footer && <footer className="fb-surface-footer">{footer}</footer>}
        </Dialog>
      </OverlayDepthProvider>
    </Modal>
  </ModalOverlay>;
}

/** Real compact task, centered readable dialog when the window has room. */
export function AdaptiveTaskSurface(props: SurfaceProps) { return <DialogSurface {...props} />; }

/** Caller owns async state/errors. Clicking Confirm never silently closes a failed operation. */
export function ConfirmDialog({ confirmLabel, onConfirm, confirmDisabled = false, cancelLabel = "Cancel", destructive = true, children, ...props }: Omit<SurfaceProps, "children" | "footer"> & {
  confirmLabel: string;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  destructive?: boolean;
  children?: ReactNode;
}) {
  return <DialogSurface {...props} confirmation footer={<>
    <Button autoFocus isDisabled={props.busy} onPress={props.onClose} className="fb-surface-button">{cancelLabel}</Button>
    <Button isDisabled={props.busy || confirmDisabled} onPress={onConfirm} className={`fb-surface-button ${destructive ? "fb-confirm-danger" : "fb-confirm-primary"}`}>{confirmLabel}</Button>
  </>}>{children}</DialogSurface>;
}
