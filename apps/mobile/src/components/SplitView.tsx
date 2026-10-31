import { useLayoutEffect, useRef, type ReactNode } from "react";
import { MEDIUM_MAX_PX, useContentWidth, useViewportWidth } from "./responsive";
import "./adaptiveFoundation.css";

/** Retains pane state/drafts while compact layouts expose only one pane.
 * Data, routing and selection remain with the feature owner. */
export function SplitView({ selected, list, detail }: { selected: boolean; list: ReactNode; detail: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  const width = useContentWidth(container, useViewportWidth());
  const wide = width >= MEDIUM_MAX_PX;
  const listHidden = !wide && selected;
  const detailHidden = !wide && !selected;
  useLayoutEffect(() => {
    const active = document.activeElement;
    const hidden = listHidden ? listPane.current : detailHidden ? detailPane.current : null;
    if (active && hidden?.contains(active)) {
      (listHidden ? detailPane.current : listPane.current)?.focus();
    }
  }, [listHidden, detailHidden]);
  return <div ref={container} className={`fb-split-view ${wide ? "fb-split-wide" : ""}`}>
    <div ref={listPane} hidden={listHidden} tabIndex={-1} className="fb-split-list">{list}</div>
    <div ref={detailPane} hidden={detailHidden} tabIndex={-1} className="fb-split-detail">{detail}</div>
  </div>;
}
