import { useState } from "react";
import { extractYouTubeId } from "@findback/shared";
import { ExternalLink, PlayCircle } from "lucide-react";

export function YouTubeEmbed({ url }: { url: string }) {
  const videoId = extractYouTubeId(url);
  const [failed, setFailed] = useState(false);

  if (!videoId) return null;
  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-m3-md border border-outline-variant p-4 text-sm text-on-surface-variant">
        <span>Embedded playback is blocked here.</span>
        <a
          href={url}
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
      <div className="aspect-video w-full bg-black">
        <iframe
          className="h-full w-full"
          src={`https://www.youtube.com/embed/${videoId}`}
          title="Embedded YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          onError={() => setFailed(true)}
        />
      </div>
      <a
        href={url}
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
