import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, TouchEvent } from "react";
import { resolveHorizontalSwipe } from "../utils/detailSwipe";

type Point = { x: number; y: number };
type Viewport = Point & { scale: number };
type Gesture = { start: Point; viewport: Viewport; distance: number; pan: boolean; pinch: boolean };
const FIT: Viewport = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 4;
const point = (touch: { clientX: number; clientY: number }): Point => ({ x: touch.clientX, y: touch.clientY });
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Photo-local inspection state: gestures never carry across image selection.
 * Zoomed drags/arrow keys pan; explicit Prev/Next always navigate. */
export function usePhotoViewport(photoId: string, photoUrl: string, onPrev?: () => void, onNext?: () => void) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stored, setStored] = useState({ photoId, viewport: FIT });
  const viewport = stored.photoId === photoId ? stored.viewport : FIT;
  // Persist the reset too: otherwise A → B → A revives A's old zoom when
  // B was only viewed at fit and never wrote inspection state of its own.
  if (stored.photoId !== photoId) setStored({ photoId, viewport: FIT });
  const current = useRef(viewport);
  current.current = viewport;
  const gesture = useRef<Gesture | null>(null);
  const gesturePhoto = useRef(photoId);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const lastTouch = useRef(0);
  if (gesturePhoto.current !== photoId) {
    gesturePhoto.current = photoId;
    gesture.current = null;
    lastTap.current = null;
  }

  function commit(next: Viewport) {
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    const width = stage?.clientWidth || rect?.width || 0;
    const height = stage?.clientHeight || rect?.height || 0;
    const image = Array.from(stage?.querySelectorAll("img") ?? []).find((img) => img.getAttribute("src") === photoUrl);
    let imageWidth = width;
    let imageHeight = height;
    if (image?.naturalWidth && image.naturalHeight) {
      // max-width/max-height contain large photos but do not upscale small
      // ones. Pan bounds must use that same natural-size-capped geometry.
      const fitScale = Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
      imageWidth = image.naturalWidth * fitScale;
      imageHeight = image.naturalHeight * fitScale;
    }
    const scale = Math.max(1, Math.min(MAX_ZOOM, next.scale));
    const limitX = Math.max(0, (imageWidth * scale - width) / 2) || 0;
    const limitY = Math.max(0, (imageHeight * scale - height) / 2) || 0;
    const bounded = { scale, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
    current.current = bounded;
    setStored({ photoId, viewport: bounded });
  }

  function local(p: Point): Point {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: p.x - (rect ? rect.left + rect.width / 2 : 0), y: p.y - (rect ? rect.top + rect.height / 2 : 0) };
  }

  function zoomTo(scale: number, anchor: Point = { x: 0, y: 0 }, base = current.current) {
    const bounded = Math.max(1, Math.min(MAX_ZOOM, scale));
    return { scale: bounded, x: anchor.x - (anchor.x - base.x) * bounded / base.scale, y: anchor.y - (anchor.y - base.y) * bounded / base.scale };
  }

  const reset = () => commit(FIT);
  const zoomIn = () => commit(zoomTo(current.current.scale + 1));
  const zoomOut = () => commit(zoomTo(current.current.scale - 1));

  function beginPinch(touches: TouchEvent["touches"]) {
    const a = point(touches[0]!);
    const b = point(touches[1]!);
    gesture.current = { start: midpoint(a, b), viewport: current.current, distance: Math.hypot(b.x - a.x, b.y - a.y), pan: true, pinch: true };
    lastTap.current = null;
  }

  function onTouchStart(event: TouchEvent) {
    if ((event.target as Element).closest("button")) return;
    if (event.touches.length >= 2) beginPinch(event.touches);
    else if (event.touches[0]) gesture.current = { start: point(event.touches[0]), viewport: current.current, distance: 0, pan: current.current.scale > 1, pinch: false };
  }

  function onTouchMove(event: TouchEvent) {
    const g = gesture.current;
    if (!g || !event.touches[0]) return;
    if (event.touches.length >= 2) {
      if (!g.distance) { beginPinch(event.touches); return; }
      const a = point(event.touches[0]);
      const b = point(event.touches[1]!);
      const center = midpoint(a, b);
      const next = zoomTo(g.viewport.scale * Math.hypot(b.x - a.x, b.y - a.y) / g.distance, local(g.start), g.viewport);
      commit({ ...next, x: next.x + center.x - g.start.x, y: next.y + center.y - g.start.y });
    } else if (g.pan) {
      const end = point(event.touches[0]);
      commit({ ...g.viewport, x: g.viewport.x + end.x - g.start.x, y: g.viewport.y + end.y - g.start.y });
    }
  }

  function onTouchEnd(event: TouchEvent) {
    lastTouch.current = Date.now();
    const g = gesture.current;
    if (!g) return;
    // Finishing a pinch with one finger remaining stays a pan, never a swipe.
    if (event.touches?.length) {
      gesture.current = { start: point(event.touches[0]!), viewport: current.current, distance: 0, pan: true, pinch: true };
      return;
    }
    gesture.current = null;
    const end = event.changedTouches[0] ? point(event.changedTouches[0]) : null;
    if (!end || g.pinch) return;
    const dx = end.x - g.start.x;
    const dy = end.y - g.start.y;
    if (Math.hypot(dx, dy) < 8) {
      const prev = lastTap.current;
      if (prev && Date.now() - prev.at < 300 && Math.hypot(end.x - prev.point.x, end.y - prev.point.y) < 32) {
        commit(current.current.scale > 1 ? FIT : zoomTo(2, local(end)));
        lastTap.current = null;
      } else lastTap.current = { at: Date.now(), point: end };
    } else {
      lastTap.current = null;
      if (!g.pan) {
        const direction = resolveHorizontalSwipe(dx, dy, 0);
        if (direction === "next") onNext?.();
        if (direction === "prev") onPrev?.();
      }
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomIn(); }
    else if (event.key === "-") { event.preventDefault(); zoomOut(); }
    else if (event.key === "0") { event.preventDefault(); reset(); }
    else if (current.current.scale > 1 && event.key.startsWith("Arrow")) {
      event.preventDefault();
      commit({ ...current.current, x: current.current.x + (event.key === "ArrowLeft" ? -40 : event.key === "ArrowRight" ? 40 : 0), y: current.current.y + (event.key === "ArrowUp" ? -40 : event.key === "ArrowDown" ? 40 : 0) });
    } else if (event.key === "ArrowLeft" && onPrev) { event.preventDefault(); onPrev(); }
    else if (event.key === "ArrowRight" && onNext) { event.preventDefault(); onNext(); }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch" || event.button !== 0 || current.current.scale <= 1 || (event.target as Element).closest("button")) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { start: point(event), viewport: current.current, distance: 0, pan: true, pinch: false };
    event.preventDefault();
  }
  function onPointerMove(event: PointerEvent) {
    const g = gesture.current;
    if (event.pointerType === "touch" || !g?.pan) return;
    commit({ ...g.viewport, x: g.viewport.x + event.clientX - g.start.x, y: g.viewport.y + event.clientY - g.start.y });
  }
  const cancel = () => { gesture.current = null; lastTap.current = null; };

  return {
    stageRef, viewport, zoomIn, zoomOut, reset, onKeyDown,
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: cancel, onPointerDown, onPointerMove,
      onPointerUp: (event: PointerEvent) => { if (event.pointerType !== "touch") cancel(); }, onPointerCancel: cancel,
      onDoubleClick: (event: React.MouseEvent) => { if (Date.now() - lastTouch.current > 500 && !(event.target as Element).closest("button")) commit(current.current.scale > 1 ? FIT : zoomTo(2, local(point(event)))); } },
  };
}
