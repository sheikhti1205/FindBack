import { useState } from "react";
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { motion } from "framer-motion";
import { CircleAlert, CircleCheck, ImageOff, MapPin, MessageSquare, Star, Tag, ThumbsDown, ThumbsUp } from "lucide-react";
import { Link } from "react-router";
import { timeAgo } from "../utils/dates";
import { stripMarkdown } from "../utils/stripMarkdown";
import { HomeFeedLoveButton } from "./HomeFeedLoveButton";
import {
  fadeVariants,
  motionDurations,
  motionEasings,
  motionSprings,
} from "./uiMotion";

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
 *  (photo-led), `compact` is Search Variant B (64px-thumb rows). `home-feed`
 *  is the reference-inspired Home redesign (image-left/content-right); only
 *  Home uses it. */
export type PostCardLayout = "classic" | "editorial" | "compact" | "home-feed";

type ImageState = "loading" | "loaded" | "failed";

/**
 * Wave A shared card → detail element. Keyed by post id so cards never
 * duplicate a layoutId; the detail gallery carries the same id and the pair
 * travels inside RouteTransition's LayoutGroup during the drill-down
 * overlap. `data-shared-media` mirrors the id for tests (Motion never
 * renders layoutId to the DOM). Layout travel uses the soft token spring
 * (interruption-safe); opacity uses the fast fade token.
 */
export function sharedMediaLayoutId(postId: string): string {
  return `fb-post-media-${postId}`;
}

export function sharedTitleLayoutId(postId: string): string {
  return `fb-post-title-${postId}`;
}

/** Per-property transition for shared elements: soft layout travel + fast fade. */
export const sharedElementTransition = {
  layout: motionSprings.soft,
  duration: motionDurations.fast,
  ease: motionEasings.inOut,
} as const;

function FeedImage({
  url,
  alt,
  variant,
  postId,
  enableSharedMedia = false,
}: {
  url: string;
  alt: string;
  variant: "frame" | "thumb" | "feed";
  postId: string;
  enableSharedMedia?: boolean;
}) {
  const [state, setState] = useState<ImageState>("loading");
  const frameClass = variant === "thumb" ? "fb-thumb" : variant === "feed" ? "fb-feed-img" : "fb-img-frame";
  const sharedId = enableSharedMedia ? sharedMediaLayoutId(postId) : undefined;
  // Wave A: shimmer → loaded crossfade. The reserved-aspect frame stays
  // mounted throughout (no layout shift); the photo fades from transparent
  // over the shimmer once decoded, and the error fallback fades in via the
  // same fast opacity token. Transform/opacity only; MotionConfig keeps the
  // fade under reduced motion while the travel collapses.
  const imgTransition = { duration: motionDurations.fast, ease: motionEasings.inOut };
  if (state === "failed") {
    return (
      <motion.span
        className={frameClass}
        data-state="failed"
        data-testid="post-image-state"
        {...(sharedId
          ? { layoutId: sharedId, "data-shared-media": sharedId, transition: sharedElementTransition }
          : {})}
      >
        <motion.span
          className="fb-img-fallback"
          role="img"
          aria-label="Photo unavailable"
          variants={fadeVariants}
          initial="hidden"
          animate="visible"
          transition={imgTransition}
        >
          <ImageOff size={16} aria-hidden />
          Photo unavailable
        </motion.span>
      </motion.span>
    );
  }
  return (
    <motion.span
      className={frameClass}
      data-state={state}
      data-testid="post-image-state"
      {...(sharedId
        ? { layoutId: sharedId, "data-shared-media": sharedId, transition: sharedElementTransition }
        : {})}
    >
      {/* The frame reserves a fixed aspect box before load, so
          loading → loaded never shifts layout. The sweep shimmer is a CSS
          pseudo-element (ignored by assistive tech); the img alt stays the
          accessible name throughout. Reduced-motion disables the sweep. */}
      <motion.img
        src={url}
        alt={alt}
        loading="lazy"
        initial={{ opacity: 0 }}
        animate={{ opacity: state === "loaded" ? 1 : 0 }}
        transition={imgTransition}
        onLoad={() => setState("loaded")}
        onError={() => setState("failed")}
      />
    </motion.span>
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
function ClassicImage({
  fileUrl,
  post,
  enableSharedMedia = false,
}: {
  fileUrl: string;
  post: PostItem;
  enableSharedMedia?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const sharedId = enableSharedMedia ? sharedMediaLayoutId(post.id) : undefined;
  return (
    <motion.img
      src={fileUrl}
      alt={`Photo for ${post.title}`}
      loading="lazy"
      className="aspect-[4/3] w-full rounded-m3-sm border border-outline-variant object-cover"
      initial={{ opacity: 0 }}
      animate={{ opacity: loaded ? 1 : 0 }}
      transition={sharedElementTransition}
      onLoad={() => setLoaded(true)}
      {...(sharedId ? { layoutId: sharedId, "data-shared-media": sharedId } : {})}
    />
  );
}

function ClassicContent({ post, enableSharedMedia = false }: { post: PostItem; enableSharedMedia?: boolean }) {
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
        <ClassicImage fileUrl={image.fileUrl} post={post} enableSharedMedia={enableSharedMedia} />
      )}

      <SharedTitle post={post} className="break-words text-base font-semibold leading-snug" enableSharedMedia={enableSharedMedia} />
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

/** Optional shared-element title: same layoutId as the detail h1 (keyed by post id). */
function SharedTitle({
  post,
  className,
  enableSharedMedia = false,
}: {
  post: PostItem;
  className: string;
  enableSharedMedia?: boolean;
}) {
  const sharedId = enableSharedMedia ? sharedTitleLayoutId(post.id) : undefined;
  return (
    <motion.h3
      className={className}
      {...(sharedId
        ? { layoutId: sharedId, "data-shared-title": sharedId, transition: sharedElementTransition }
        : {})}
    >
      {post.title}
    </motion.h3>
  );
}

/** Variant A editorial: kicker, large photo first, serif headline. */
function EditorialContent({ post, enableSharedMedia = false }: { post: PostItem; enableSharedMedia?: boolean }) {
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
        <FeedImage
          url={image.fileUrl}
          alt={`Photo for ${post.title}`}
          variant="frame"
          postId={post.id}
          enableSharedMedia={enableSharedMedia}
        />
      ) : (
        <p className="text-xs text-on-surface-variant">No photo attached</p>
      )}

      <SharedTitle post={post} className="fb-editorial-title break-words" enableSharedMedia={enableSharedMedia} />
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
function CompactContent({ post, enableSharedMedia = false }: { post: PostItem; enableSharedMedia?: boolean }) {
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
        <FeedImage
          url={image.fileUrl}
          alt={`Photo for ${post.title}`}
          variant="thumb"
          postId={post.id}
          enableSharedMedia={enableSharedMedia}
        />
      ) : (
        <div className="fb-thumb-none" aria-hidden>
          No photo
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* P6: compact Search title wraps readably to exactly two lines. */}
        <SharedTitle
          post={post}
          className="line-clamp-2 break-words text-sm font-bold leading-snug"
          enableSharedMedia={enableSharedMedia}
        />
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

/** Lost/Found semantic badge: muted surface + deep ink + icon. Text and icon
 *  carry the meaning so type is never color-only. */
function TypeBadge({ type }: { type: PostType }) {
  const lost = type === "LOST";
  return (
    <span
      data-testid="post-type-badge"
      className={`fb-type-badge ${lost ? "fb-type-lost" : "fb-type-found"}`}
    >
      {lost ? <CircleAlert size={14} aria-hidden /> : <CircleCheck size={14} aria-hidden />}
      {lost ? "Lost" : "Found"}
    </span>
  );
}

/** Restrained home-feed engagement summary: comments and rating only. The like
 *  count lives exactly once on the card — on the Love toggle in the action
 *  row below. Dislikes stay visible on Post Detail; the feed footer stays
 *  quiet. */
function HomeFeedMetrics({ post }: { post: PostItem }) {
  return (
    <span data-testid="post-metrics" className="flex items-center gap-3 text-[11px] text-on-surface-variant">
      <span className="flex items-center gap-1">
        <MessageSquare size={13} aria-hidden /> {post.commentCount}
      </span>
      <span className="flex items-center gap-1">
        <Star size={13} aria-hidden />
        {post.ratingCount > 0 ? post.ratingAvg?.toFixed(1) : "—"}
      </span>
    </span>
  );
}

/**
 * Home-feed layout (reference-inspired redesign): image-left/content-right.
 * Only Home uses this; Search `compact` and other `classic` renderings are
 * verbatim. Reuses FeedImage (lazy, shimmer, crossfade, failure fallback,
 * shared layoutId), SharedTitle (shared layoutId), stripMarkdown, timeAgo,
 * and the lifecycle labels — only the arrangement and emphasis change.
 *
 * UXN-2 DOM contract: the PostCard home-feed shell is a plain div, so this
 * block owns navigation AND actions as siblings — the detail `Link` wraps
 * media + text, and the Love toggle sits beside it in an action row. Never
 * nest the button inside the link.
 */
function HomeFeedContent({ post, enableSharedMedia = false }: { post: PostItem; enableSharedMedia?: boolean }) {
  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const hero = images[0];
  const excerpt = stripMarkdown(post.description);
  // Detail destination mirrors PostList (`/posts/${post.id}`) — the single
  // route both shells navigate to.
  return (
    <div data-testid="home-feed-content" className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Link
        to={`/posts/${post.id}`}
        data-testid="home-feed-detail-link"
        className="grid min-w-0 grid-cols-[minmax(112px,42%)_minmax(0,1fr)] gap-2.5"
      >
        <div className="relative min-w-0 self-start">
          {hero ? (
            <FeedImage
              url={hero.fileUrl}
              alt={`Photo for ${post.title}`}
              variant="feed"
              postId={post.id}
              enableSharedMedia={enableSharedMedia}
            />
          ) : (
            <div data-testid="home-feed-no-photo" className="fb-feed-img fb-feed-img-none">
              <ImageOff size={18} aria-hidden />
              <span>No photo</span>
            </div>
          )}
          {images.length > 1 && (
            <span data-testid="photo-count" className="fb-feed-photo-badge">
              {images.length} photos
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <TypeBadge type={post.type} />
            <span data-testid="post-time" className="shrink-0 whitespace-nowrap text-[11px] text-on-surface-variant">
              {timeAgo(post.createdAt)}
            </span>
          </div>
          <div data-testid="post-title">
            <SharedTitle
              post={post}
              className="fb-feed-title line-clamp-2 break-words"
              enableSharedMedia={enableSharedMedia}
            />
          </div>
          {excerpt && (
            <p data-testid="post-description" className="line-clamp-2 break-words text-sm leading-relaxed text-on-surface-variant">
              {excerpt}
            </p>
          )}
          {post.locationLabel && (
            <p data-testid="post-location" className="flex min-w-0 items-center gap-1 text-xs text-on-surface-variant">
              <MapPin size={13} aria-hidden className="shrink-0" />
              <span className="truncate">{post.locationLabel}</span>
            </p>
          )}
          <p data-testid="post-author" className="truncate text-[11px] text-on-surface-variant">
            @{post.author.username}
          </p>
          <div data-testid="post-footer" className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-1">
            <span data-testid="post-category" className="fb-category-chip">
              <Tag size={12} aria-hidden className="shrink-0" />
              <span>{post.category}</span>
            </span>
            {post.status !== "OPEN" && (
              <span data-testid="post-lifecycle" className="text-[11px] font-medium text-on-surface-variant">
                {STATUS_LABELS[post.status]}
              </span>
            )}
            <HomeFeedMetrics post={post} />
          </div>
        </div>
      </Link>
      <div data-testid="home-feed-actions" className="flex items-center gap-1">
        <HomeFeedLoveButton postId={post.id} likeCount={post.likeCount} />
      </div>
    </div>
  );
}

export function PostCardContent({
  post,
  layout = "classic",
  enableSharedMedia = false,
}: {
  post: PostItem;
  layout?: PostCardLayout;
  /**
   * Wave A: opt into the shared card → detail element (media + title carry
   * `layoutId`s keyed by post id). Enabled by PostList so the drill-down
   * pair exists; off everywhere else so stray cards never duplicate a
   * layoutId.
   */
  enableSharedMedia?: boolean;
}) {
  if (layout === "editorial") return <EditorialContent post={post} enableSharedMedia={enableSharedMedia} />;
  if (layout === "compact") return <CompactContent post={post} enableSharedMedia={enableSharedMedia} />;
  if (layout === "home-feed") return <HomeFeedContent post={post} enableSharedMedia={enableSharedMedia} />;
  return <ClassicContent post={post} enableSharedMedia={enableSharedMedia} />;
}
