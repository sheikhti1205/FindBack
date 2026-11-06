import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useMessaging } from "../services/messaging/useMessaging";
import { BottomSheet } from "./BottomSheet";

/** One app-wide hold: backup imports and background mailbox sync can happen on
 * any screen. Counts from HEAD are publication work, so never label them as a
 * precise number of recovered bodies or invent a source device. */
export function MessagingRestoration() {
  const chat = useMessaging(), sync = chat.threadSync;
  const open = !!chat.restoration || (sync?.mode === "blocking" && (sync.missing ?? 0) > 10);
  return open ? <RestoreDialog /> : null;
}

function RestoreDialog() {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const prior = new Map<HTMLElement, boolean>();
    const isolate = () => {
      for (const node of Array.from(document.body.children)) {
        if (!(node instanceof HTMLElement) || node === layer.current || prior.has(node)) continue;
        prior.set(node, node.hasAttribute("inert")); node.setAttribute("inert", "");
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
    return () => { observer.disconnect(); for (const [node, inert] of prior) if (!inert) node.removeAttribute("inert"); };
  }, []);
  return createPortal(<div ref={layer} style={{ position: "fixed", inset: 0, zIndex: 1000 }}>
    <BottomSheet open onClose={() => undefined} title="Restoring messages" dismissible={false} height="medium" backdropBlur>
      <p role="status" className="text-sm leading-relaxed text-on-surface-variant">Bringing your saved conversations up to date. This takes a moment.</p>
    </BottomSheet>
  </div>, document.body);
}
