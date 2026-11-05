import { useEffect, useState } from "react";
import { modalLayerCount, subscribeModalLayers } from "./modalLayers";
import { appActivityBusy, subscribeAppActivity } from "../services/appActivity";

const EDITABLE = "input, textarea, select, [contenteditable='true']";

function editableFocused(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches(EDITABLE);
}

function documentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/**
 * True only when the reader is genuinely idle: no dialog/sheet/lightbox open,
 * no text field focused (so no keyboard is up), and the document is visible.
 *
 * Anything that interrupts — an update notice, for example — must wait for
 * this rather than covering an editor, an upload, a confirmation or a
 * backgrounded tab.
 */
export function isGenuinelyIdle(pathname = "/"): boolean {
  // Only passive routes opt in. New routes, editors and confirmation surfaces
  // fail closed until their activity semantics are explicitly reviewed.
  const passive = ["/", "/my", "/notifications", "/settings", "/settings/about"].includes(pathname);
  return passive && !appActivityBusy() && modalLayerCount() === 0 && !editableFocused() && documentVisible();
}

export function useAppIdle(pathname = "/"): boolean {
  const [idle, setIdle] = useState(() => isGenuinelyIdle(pathname));

  useEffect(() => {
    const recompute = () => setIdle(isGenuinelyIdle(pathname));
    const off = subscribeModalLayers(recompute);
    const offActivity = subscribeAppActivity(recompute);
    const onFocusChange = () => recompute();
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    document.addEventListener("visibilitychange", onFocusChange);
    recompute();
    return () => {
      off();
      offActivity();
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
      document.removeEventListener("visibilitychange", onFocusChange);
    };
  }, [pathname]);

  return idle && isGenuinelyIdle(pathname);
}
