import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { OverlayTriggerStateContext, Popover, type PopoverProps } from "react-aria-components";
import { isTopModalLayer, useModalLayer } from "../hooks/modalLayers";
import { registerBackInterceptor } from "./backNavigation";
import "./adaptiveFoundation.css";

// Portals preserve React context. Children therefore get a layer above their
// parent even though both mount under body (including menu -> confirmation).
const OverlayDepth = createContext(0);

export function useOverlayDepth() { return useContext(OverlayDepth) + 1; }

export function OverlayDepthProvider({ depth, children }: { depth: number; children: ReactNode }) {
  return <OverlayDepth.Provider value={depth}>{children}</OverlayDepth.Provider>;
}

/** Bridge React Aria surfaces into the existing legacy Escape/Android Back stack.
 * React Aria alone owns focus, outside interaction and scroll containment.
 * Mount INSIDE the portal so a closed/collection-only popover registers nothing.
 */
export function OverlayStackBridge({ onClose, dismissible = true }: { onClose: () => void; dismissible?: boolean }) {
  const layer = useModalLayer(true);
  const latest = useRef({ onClose, dismissible });
  latest.current = { onClose, dismissible };
  useEffect(() => {
    const close = () => { if (latest.current.dismissible) latest.current.onClose(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !isTopModalLayer(layer)) return;
      // Capture before old document-level focus traps. One key/Back consumes
      // exactly one layer, including a submenu, and cannot close its parent.
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener("keydown", escape, true);
    const offBack = registerBackInterceptor(() => {
      if (!isTopModalLayer(layer)) return false;
      close();
      return true;
    });
    return () => { document.removeEventListener("keydown", escape, true); offBack(); };
  }, [layer]);
  return null;
}

function PopoverStackBridge() {
  const state = useContext(OverlayTriggerStateContext);
  return <OverlayStackBridge onClose={() => state?.close()} />;
}

/** Collision-aware positioning and nested portal grouping remain React Aria's. */
export function LayeredPopover({ children, className = "", ...props }: PopoverProps) {
  const depth = useOverlayDepth();
  return <Popover {...props} className={`fb-popover ${className}`} style={{ zIndex: 70 + depth * 10 }}>
    {(values) => <OverlayDepthProvider depth={depth}>
      <PopoverStackBridge />
      {typeof children === "function" ? children(values) : children}
    </OverlayDepthProvider>}
  </Popover>;
}
