import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { extractYouTubeId } from "@findback/shared";
import { ExternalLink, PlayCircle } from "lucide-react";
import { motionDurations, motionEasings } from "./uiMotion";

/** Poster fades out as the player fades in, inside the reserved aspect-video box. */
const posterTransition = {
  type: "tween",
  duration: motionDurations.standard,
  ease: motionEasings.out,
} as const;

const playerTransition = {
  type: "tween",
  duration: motionDurations.standard,
  ease: motionEasings.inOut,
} as const;

/**
 * Lite-embed pattern: a poster placeholder holds the 16:9 area and the iframe
 * only mounts once playback is requested, crossfading in. The iframe never
 * animates continuously — a YouTube player and transforms don't mix.
 */
export function YouTubeEmbed({ url }: { url: string }) {
  const videoId = extractYouTubeId(url);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  // A different video (or a cleared field) returns to the poster state.
  useEffect(() => {
    setFailed(false);
    setPlaying(false);
  }, [videoId]);

  if (!videoId) return null;
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-m3-md border border-outline-variant p-4 text-sm text-on-surface-variant">
        <span>Embedded playback is blocked here.</span>
        <a
          href={watchUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-medium text-on-surface"
        >
          <ExternalLink size={16} aria-hidden /> Open on YouTube
        </a>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-m3-md border border-outline-variant">
      <div className="relative aspect-video w-full bg-black">
        <AnimatePresence initial={false}>
          {playing ? (
            <motion.div
              key="player"
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={playerTransition}
              data-testid="youtube-player"
            >
              <iframe
                className="h-full w-full"
                src={`https://www.youtube.com/embed/${videoId}`}
                title="Embedded YouTube video"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                onError={() => setFailed(true)}
              />
            </motion.div>
          ) : (
            <motion.button
              key="poster"
              type="button"
              className="absolute inset-0 flex w-full flex-col items-center justify-center gap-2 bg-black text-white"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={posterTransition}
              onClick={() => setPlaying(true)}
              aria-label="Play video"
              data-testid="youtube-poster"
            >
              <PlayCircle size={48} aria-hidden />
              <span className="text-xs">Play video</span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <a
        href={watchUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 px-3 py-2 text-xs text-on-surface-variant"
      >
        <PlayCircle size={14} aria-hidden />
        Watch on YouTube
      </a>
    </div>
  );
}
