import { useEffect, useRef } from "react";

/**
 * Authoritative modal-layer stack for keyboard Escape.
 *
 * Competing document-level Escape listeners (fullscreen overlay trap, open
 * formatting menu, link dialog, bottom sheets, lightbox) used to make
 * independent close decisions, so one Escape could dismiss more than the
 * topmost layer. Every Escape-handling layer registers here while open;
 * handlers must ignore the event unless their layer is on top.
 *
 * Hardware Back already stacks correctly (registerBackInterceptor is LIFO),
 * so this module only governs the Escape path.
 */
const stack: string[] = [];
let seq = 0;

export function pushModalLayer(id: string): void {
  if (!stack.includes(id)) stack.push(id);
}

export function popModalLayer(id: string): void {
  const index = stack.indexOf(id);
  if (index >= 0) stack.splice(index, 1);
}

export function isTopModalLayer(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** Test helper. */
export function resetModalLayers(): void {
  stack.length = 0;
}

/**
 * Register the calling layer while `open`. Returns a stable layer id for
 * isTopModalLayer checks in custom (non-trap) Escape handlers.
 */
export function useModalLayer(open: boolean): string {
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    seq += 1;
    idRef.current = `modal-layer-${seq}`;
  }
  const id = idRef.current;
  useEffect(() => {
    if (!open) return;
    pushModalLayer(id);
    return () => {
      popModalLayer(id);
    };
  }, [open, id]);
  return id;
}
