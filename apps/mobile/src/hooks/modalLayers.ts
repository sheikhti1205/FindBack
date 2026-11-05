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
const listeners = new Set<(count: number) => void>();

function notify(): void {
  for (const listener of [...listeners]) listener(stack.length);
}

export function pushModalLayer(id: string): void {
  if (stack.includes(id)) return;
  stack.push(id);
  notify();
}

export function popModalLayer(id: string): void {
  const index = stack.indexOf(id);
  if (index < 0) return;
  stack.splice(index, 1);
  notify();
}

/** How many modal layers are currently open (0 = none). */
export function modalLayerCount(): number {
  return stack.length;
}

/**
 * Observe the open-layer count. Used by anything that must not interrupt the
 * reader while a dialog/sheet/lightbox is open (update notices, for example).
 */
export function subscribeModalLayers(listener: (count: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isTopModalLayer(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** Test helper. */
export function resetModalLayers(): void {
  stack.length = 0;
  notify();
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
