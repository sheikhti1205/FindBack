import { useLayoutEffect, useRef } from "react";
import type { BodyMedia } from "../services/commentBodyMedia";
import { useMediaUrl } from "../services/media/privateMedia";

/** Same gallery geometry for private uploads, provider GIFs and legacy video. */
export function CommentMediaPreview({ media }: { media: BodyMedia }) {
  const src = useMediaUrl(media.url);
  return media.kind === "video" ? <CommentVideo key={media.url} src={src} alt={media.alt} />
    : <img src={src} alt={media.alt} loading="lazy" className="h-24 w-auto rounded-m3-sm border border-outline-variant object-cover" />;
}

/** Updating a video's src resets native playback. Snapshot before assigning it,
 * then restore only across authorized renewals of this same stored address.
 * An unresolved/auth-invalidated source clears the resource and the snapshot. */
function CommentVideo({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const element = useRef<HTMLVideoElement>(null);
  const previousSource = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const video = element.current;
    if (!video) return;
    const renewing = !!previousSource.current && !!src;
    const playback = renewing ? { time: video.currentTime, rate: video.playbackRate, playing: !video.paused } : null;
    const hadSource = !!previousSource.current;
    previousSource.current = src;
    if (!src) {
      video.removeAttribute("src");
      if (hadSource) video.load();
      return;
    }
    const restore = () => {
      if (!playback || video.getAttribute("src") !== src) return;
      video.currentTime = Number.isFinite(video.duration) ? Math.min(playback.time, video.duration) : playback.time;
      video.playbackRate = playback.rate;
      if (playback.playing) void video.play().catch(() => { /* Browser may require a fresh play gesture. */ });
    };
    video.addEventListener("loadedmetadata", restore, { once: true });
    // Imperative assignment is intentional: a JSX src update would reset the
    // element before this effect could sample its old position/play state.
    video.src = src;
    return () => video.removeEventListener("loadedmetadata", restore);
  }, [src]);
  return <video ref={element} controls playsInline preload="metadata" className="h-24 max-w-full rounded-m3-sm border border-outline-variant object-cover" aria-label={alt} />;
}
