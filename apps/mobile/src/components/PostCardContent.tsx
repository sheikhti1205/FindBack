import { useState } from "react";
import type { PostItem, PostStatus } from "@findback/shared";
import { ImageOff, MessageSquare, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { timeAgo } from "../utils/dates";
import { stripMarkdown } from "../utils/stripMarkdown";

const STATUS_LABELS: Record<PostStatus, string> = {
  OPEN: "Open",
  MATCHED: "Matched",
  RECOVERED: "Recovered",
  CLOSED: "Closed",
};

const STATUS_CLASS: Record<PostStatus, string> = {
  OPEN: "border-outline-variant text-on-surface-variant",
  MATCHED: "border-on-surface-variant text-on-surface",
  RECOVERED: "border-on-surface bg-on-surface text-surface",
  CLOSED: "border-outline-variant text-outline",
};

/** U2 hybrid rollout: `classic` preserves the pre-U2 rendering (used by
 *  screens outside the rollout, e.g. MyPosts). `editorial` is Home Variant A
 *  (photo-led), `compact` is Search Variant B (64px-thumb rows). */
export type PostCardLayout = "classic" | "editorial" | "compact";

type ImageState = "loading" | "loaded" | "failed";

function FeedImage({
  url,
  alt,
  variant,
}: {
  url: string;
  alt: string;
  variant: "frame" | "thumb";
}) {
  const [state, setState] = useState<ImageState>("loading");
  const frameClass = variant === "thumb" ? "fb-thumb" : "fb-img-frame";
  if (state === "failed") {
    return (
      <span className={frameClass} data-state="failed" data-testid="post-image-state">
        <span className="fb-img-fallback" role="img" aria-label="Photo unavailable">
          <ImageOff size={16} aria-hidden />
          Photo unavailable
        </span>
      </span>
    );
  }
  return (
    <span className={frameClass} data-state={state} data-testid="post-image-state">
      {/* The frame reserves a fixed aspect box before load, so
          loading → loaded never shifts layout. The sweep shimmer is a CSS
          pseudo-element (ignored by assistive tech); the img alt stays the
          accessible name throughout. Reduced-motion disables the sweep. */}
      <img
        src={url}
        alt={alt}
        loading="lazy"
        onLoad={() => setState("loaded")}
        onError={() => setState("failed")}
      />
    </span>
  );
}

function CountRow({ post, compact = false }: { post: PostItem; compact?: boolean }) {
  const textClass = compact ? "text-[11px]" : "text-xs";
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-on-surface-variant ${textClass}`}>
      <span className="max-w-full truncate font-medium text-on-surface">
        @{post.author.username}
      </span>
      <span className="flex items-center gap-1">
        <ThumbsUp size={14} aria-hidden /> {post.likeCount}
      </span>
      <span className="flex items-center gap-1">
        <ThumbsDown size={14} aria-hidden /> {post.dislikeCount}
      </span>
      <span className="flex items-center gap-1">
        <MessageSquare size={14} aria-hidden /> {post.commentCount}
      </span>
      <span className="flex items-center gap-1">
        <Star size={14} aria-hidden />
        {post.ratingCount > 0 ? post.ratingAvg?.toFixed(1) : "—"}
      </span>
    </div>
  );
}

/** Pre-U2 rendering, verbatim. Default for screens outside the rollout. */
function ClassicContent({ post }: { post: PostItem }) {
  const image = post.attachments.find((a) => a.mimeType.startsWith("image/"));
  const excerpt = stripMarkdown(post.description);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium uppercase tracking-wide">
        <span
          className={
            post.type === "LOST"
              ? "text-on-surface"
              : "text-on-surface-variant"
          }
        >
          {post.type === "LOST" ? "Lost" : "Found"}
        </span>
        <span className="text-outline">·</span>
        <span className="text-on-surface-variant">{post.category}</span>
        <span className="text-outline">·</span>
        <span className="text-on-surface-variant">{timeAgo(post.createdAt)}</span>
        <span
          className={`rounded-full border px-2 py-0.5 normal-case tracking-normal ${STATUS_CLASS[post.status]}`}
        >
          {STATUS_LABELS[post.status]}
        </span>
      </div>

      {image && (
        <img
          src={image.fileUrl}
          alt={`Photo for ${post.title}`}
          loading="lazy"
          className="aspect-[4/3] w-full rounded-m3-sm border border-outline-variant object-cover"
        />
      )}

      <h3 className="break-words text-base font-semibold leading-snug">{post.title}</h3>
      <p className="line-clamp-2 break-words text-sm text-on-surface-variant">{excerpt}</p>

      <CountRow post={post} />
    </>
  );
}

function imageCount(post: PostItem): number {
  return post.attachments.filter((a) => a.mimeType.startsWith("image/")).length;
}

function PhotoCount({ post }: { post: PostItem }) {
  const n = imageCount(post);
  if (n === 0) return null;
  return (
    <p data-testid="photo-count" className="text-xs text-on-surface-variant">
      {n} {n === 1 ? "photo" : "photos"}
    </p>
  );
}

/** Variant A editorial: kicker, large photo first, serif headline. */
function EditorialContent({ post }: { post: PostItem }) {
  const image = post.attachments.find((a) => a.mimeType.startsWith("image/"));
  const excerpt = stripMarkdown(post.description);
  const byline = [
    post.locationLabel,
    timeAgo(post.createdAt),
    `by @${post.author.username}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <p className="fb-kicker">
        {post.type === "LOST" ? "Lost" : "Found"} · {post.category} ·{" "}
        {STATUS_LABELS[post.status]}
      </p>

      {image ? (
        <FeedImage url={image.fileUrl} alt={`Photo for ${post.title}`} variant="frame" />
      ) : (
        <p className="text-xs text-on-surface-variant">No photo attached</p>
      )}

      <h3 className="fb-editorial-title break-words">{post.title}</h3>
      <p className="text-xs text-on-surface-variant">{byline}</p>
      <PhotoCount post={post} />
      {excerpt && (
        <p className="line-clamp-3 break-words text-sm leading-relaxed text-on-surface-variant">
          {excerpt}
        </p>
      )}

      <div className="border-t border-outline-variant pt-2">
        <CountRow post={post} />
      </div>
    </>
  );
}

/** Variant B compact: 64px thumb + two-line summary row. */
function CompactContent({ post }: { post: PostItem }) {
  const image = post.attachments.find((a) => a.mimeType.startsWith("image/"));
  const meta = [
    post.locationLabel,
    timeAgo(post.createdAt),
    `@${post.author.username}`,
    `${post.commentCount} comments`,
    `${post.likeCount} likes`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex gap-2.5">
      {image ? (
        <FeedImage url={image.fileUrl} alt={`Photo for ${post.title}`} variant="thumb" />
      ) : (
        <div className="fb-thumb-none" aria-hidden>
          No photo
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="break-words text-sm font-bold leading-snug">{post.title}</h3>
        <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
          {post.type === "LOST" ? "Lost" : "Found"} · {post.category} ·{" "}
          {STATUS_LABELS[post.status]}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-on-surface-variant">{meta}</p>
        {imageCount(post) > 0 && (
          <p data-testid="photo-count" className="mt-0.5 text-[11px] text-on-surface-variant">
            {imageCount(post)} {imageCount(post) === 1 ? "photo" : "photos"}
          </p>
        )}
      </div>
    </div>
  );
}

export function PostCardContent({
  post,
  layout = "classic",
}: {
  post: PostItem;
  layout?: PostCardLayout;
}) {
  if (layout === "editorial") return <EditorialContent post={post} />;
  if (layout === "compact") return <CompactContent post={post} />;
  return <ClassicContent post={post} />;
}
