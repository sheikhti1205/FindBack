import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Info, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useContentWidth, useRootFontPx } from "./responsive";
import { CHAT_DETAILS_PANE, readPanePreference, writePanePreference } from "./panePreference";

/** A third pane inside SplitView's conversation. Only layout lives here: the
 * caller renders the same actions as its compact task sheet. The transcript
 * never moves/remounts and the preference never syncs with account data. */
export function ChatDetailsLayout({ children, details, identity, onCompactOpen }: {
  children: (toggle: ReactNode) => ReactNode;
  details: ReactNode;
  identity?: ReactNode;
  onCompactOpen: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // Measure the actual detail column, after the conversation list/nav rail,
  // rather than promising three usable panes from viewport width alone.
  const width = useContentWidth(container, 0);
  const rootFont = useRootFontPx();
  const wide = width >= Math.max(760, 47.5 * rootFont);
  const [pref, setPref] = useState(() => readPanePreference(CHAT_DETAILS_PANE));
  const expanded = wide && !pref.collapsed;
  const id = useId();
  const focusInDetails = useRef(false);
  useLayoutEffect(() => {
    if (!expanded && focusInDetails.current) {
      toggle.current?.focus({ preventScroll: true });
      focusInDetails.current = false;
    }
  }, [expanded]);
  function collapse() {
    const next = { ...pref, collapsed: !pref.collapsed };
    setPref(next); writePanePreference(next, CHAT_DETAILS_PANE);
  }
  const control = <button ref={toggle} type="button" className="fb-chat-icon"
    aria-label={wide ? expanded ? "Hide conversation details" : "Show conversation details" : "Conversation options"}
    aria-expanded={wide ? expanded : undefined} aria-controls={wide ? id : undefined}
    onClick={wide ? collapse : onCompactOpen}>
    {wide ? expanded ? <PanelRightClose size={21} aria-hidden="true" /> : <PanelRightOpen size={21} aria-hidden="true" /> : <Info size={21} aria-hidden="true" />}
  </button>;
  return <div ref={container} className={`fb-chat-workspace${expanded ? " fb-chat-workspace-details" : ""}`}>
    {children(control)}
    <aside ref={sidebar} id={id} hidden={!expanded} className="fb-chat-details" aria-label="Conversation info"
      onFocusCapture={() => { focusInDetails.current = true; }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) focusInDetails.current = false; }}
      onKeyDown={event => {
        // React portal events can bubble from a nested dialog whose DOM is not
        // in this pane. Escape there belongs to that dialog, not the sidebar.
        if (event.key === "Escape" && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) {
          event.preventDefault(); collapse(); toggle.current?.focus({ preventScroll: true });
        }
      }}>
      {expanded && <><header className="fb-chat-details-heading"><h2>Conversation info</h2></header>
        {identity && <div className="fb-chat-details-person">{identity}</div>}
        {details}</>}
    </aside>
  </div>;
}
