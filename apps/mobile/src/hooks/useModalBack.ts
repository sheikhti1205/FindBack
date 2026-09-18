import { useEffect, useRef } from "react";
import { registerBackInterceptor } from "../components/backNavigation";

/**
 * While `open`, the Android hardware back button dismisses the dialog instead
 * of navigating away from the whole screen.
 */
export function useModalBack(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    return registerBackInterceptor(() => {
      closeRef.current();
      return true;
    });
  }, [open]);
}
