import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Lightbox, { createModule, MODULE_NO_SCROLL, useController, useLightboxState, type ComponentProps, type Plugin, type SlideImage, type ZoomRef } from "yet-another-react-lightbox";
import { FocusScope } from "react-aria/FocusScope";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import { ImageOff, RotateCcw } from "lucide-react";
import { OverlayStackBridge, useOverlayDepth } from "./overlayFoundation";
import { isPrivateMediaKey, peekMediaUrl, privateCommentMediaKey, resolveMediaUrl } from "../services/media/privateMedia";
import { getSupabase } from "../services/supabaseClient";
import { useShouldReduceMotion } from "./uiMotion";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import "./MediaViewer.css";

export interface MediaViewerItem {
  id: string;
  src: string;
  thumbnailSrc?: string | null;
  width?: number | null;
  height?: number | null;
  alt: string;
  title?: string | null;
}

export interface MediaViewerProps {
  items: readonly MediaViewerItem[];
  index: number | null;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
}

// Reuse React Aria's scope tree for containment and restoration, inside the
// portal around the full viewport (including Fullscreen and Thumbnails).
function ViewerFocusScope({ children }: ComponentProps) {
  return <FocusScope contain restoreFocus>{children}</FocusScope>;
}
const focusScopeModule = createModule("FindBackFocusScope", ViewerFocusScope);
const containFocus: Plugin = ({ addParent }) => addParent(MODULE_NO_SCROLL, focusScopeModule);
const plugins = [Zoom, Fullscreen, Thumbnails, containFocus];
const RetryPhoto = createContext<(() => void) | null>(null);

function RetrySlide({ children, available }: { children: ReactNode; available: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const { focus } = useController();
  return <RetryPhoto.Provider value={available ? () => { setAttempt((value) => value + 1); focus(); } : null}>
    <Fragment key={attempt}>{children}</Fragment>
  </RetryPhoto.Provider>;
}

function UnavailablePhoto() {
  const retry = useContext(RetryPhoto);
  return <div className="fb-viewer-unavailable" role="status">
    <ImageOff size={28} aria-hidden="true" /><p>Photo unavailable</p>
    {retry && <button type="button" onClick={(event) => { event.stopPropagation(); retry(); }}>Retry photo</button>}
  </div>;
}

function PhotoCounter() {
  const { currentIndex, slides } = useLightboxState();
  return <span className="fb-viewer-counter" role="status">Photo {currentIndex + 1} of {slides.length}</span>;
}

function PhotoThumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return !src || failed ? <ImageOff size={20} aria-hidden="true" />
    : <img src={src} alt="" className="fb-viewer-thumbnail" onError={() => setFailed(true)} />;
}

/** One inspection owner. YARL owns focus entry, inert siblings, scroll lock and
 * physics; React Aria contains/restores focus; the bridge owns Escape/Back. */
export function MediaViewer({ items, index, onIndexChange, onClose }: MediaViewerProps) {
  if (index === null || items.length === 0) return null;
  return <OpenMediaViewer items={items} index={Math.max(0, Math.min(items.length - 1, index))} onIndexChange={onIndexChange} onClose={onClose} />;
}

function OpenMediaViewer({ items, index, onIndexChange, onClose }: MediaViewerProps & { index: number }) {
  const zoom = useRef<ZoomRef>(null);
  const reduced = useShouldReduceMotion();
  const depth = useOverlayDepth();
  const [chromeHidden, setChromeHidden] = useState(false);
  // Private report media: a slide source may be a Storage key. The grid that
  // opened this viewer usually resolved it already (`peek`), and anything still
  // unsigned is signed here, so a lightbox never renders a bare object key.
  const [signedSrcs, setSignedSrcs] = useState<Record<string, string>>({});
  const srcKey = items.map((item) => item.src).join("\u0000");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const keys = [...new Set(itemsRef.current.map((item) => item.src).filter(isPrivateMediaKey))];
    const missing = keys.filter((key) => !peekMediaUrl(key));
    if (missing.length === 0) return;
    let live = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void Promise.all(missing.map(async (key) => [key, await resolveMediaUrl(key)] as const)).then((pairs) => {
        if (!live || current !== generation) return;
        const next: Record<string, string> = {};
        for (const [key, url] of pairs) if (url) next[key] = url;
        setSignedSrcs(next);
      });
    };
    refresh();
    const comments = keys.some((key) => !!privateCommentMediaKey(key));
    const timer = comments ? window.setInterval(refresh, 45_000) : undefined;
    const subscription = comments ? getSupabase().auth.onAuthStateChange(() => {
      ++generation; setSignedSrcs({});
      queueMicrotask(() => { if (live) refresh(); });
    }).data.subscription : undefined;
    return () => { live = false; ++generation; window.clearInterval(timer); subscription?.unsubscribe(); };
  }, [srcKey]);
  const slides = useMemo<SlideImage[]>(() => items.map((item) => ({
    src: peekMediaUrl(item.src) ?? signedSrcs[item.src] ?? (privateCommentMediaKey(item.src) ? "" : item.src), alt: item.alt, title: item.title ?? undefined,
    thumbnail: item.thumbnailSrc ?? undefined,
    width: item.width && item.width > 0 ? item.width : undefined,
    height: item.height && item.height > 0 ? item.height : undefined,
  })), [items, signedSrcs]);
  return <Lightbox open close={onClose} slides={slides} index={index}
    plugins={plugins}
    className={`fb-media-viewer${chromeHidden ? " fb-viewer-chrome-hidden" : ""}`}
    labels={{ Lightbox: "Photo viewer", Previous: "Previous photo", Next: "Next photo", Close: "Close photo viewer" }}
    styles={{ root: { zIndex: 100 + depth * 10 } }}
    // Override YARL's focus-recording handler: its ref cleanup restores before
    // FocusScope unmounts, so containment would pull focus back into the dying
    // portal. React Aria alone restores after removal (also for nested scopes).
    // React Aria's enclosing modal must not mark this external portal inert.
    portal={{ container: { ...{ "data-testid": "media-viewer", "data-react-aria-top-layer": "" }, onFocus: () => {}, onKeyDownCapture: () => setChromeHidden(false), onPointerMove: (event) => { if (event.pointerType === "mouse") setChromeHidden(false); } } }}
    carousel={{ finite: true, imageFit: "contain", padding: 0, spacing: 16, preload: 1 }}
    controller={{ closeOnEscape: false, closeOnPullDown: false, closeOnPullUp: false, closeOnBackdropClick: false }}
    animation={{ fade: reduced ? 0 : 180, swipe: reduced ? 0 : 250, zoom: reduced ? 0 : 180 }}
    zoom={{ ref: zoom, scrollToZoom: false, maxZoomPixelRatio: 2 }}
    thumbnails={{ width: 72, height: 48, gap: 8, padding: 2, border: 2, vignette: false }}
    toolbar={{ buttons: [<PhotoCounter key="counter" />, "zoom", <button key="fit" type="button" className="yarl__button fb-viewer-fit" title="Fit photo" aria-label="Fit photo" onClick={() => zoom.current?.changeZoom(1)}><RotateCcw size={24} aria-hidden="true" /></button>, "fullscreen", "close"] }}
    on={{ view: ({ index: next }) => { onIndexChange?.(next); }, click: () => setChromeHidden((hidden) => !hidden) }}
    render={{
      controls: () => <OverlayStackBridge onClose={onClose} />,
      slideContainer: ({ slide, children }) => <RetrySlide available={!!slide.src}>{children}</RetrySlide>,
      slide: ({ slide }) => !slide.src ? <UnavailablePhoto /> : undefined,
      iconError: () => <UnavailablePhoto />,
      thumbnail: ({ slide }) => <PhotoThumbnail key={slide.thumbnail ?? slide.src} src={slide.thumbnail ?? slide.src} />,
    }}
  />;
}
