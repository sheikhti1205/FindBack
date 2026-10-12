import { useLayoutEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { PostItem, PostStatus } from "@findback/shared";
import { motion } from "framer-motion";
import { CircleAlert, CircleCheck, ImageOff, Link2, Lock, MapPin, MessageSquare, Star, Tag, ThumbsDown, ThumbsUp } from "lucide-react";
import { Link } from "react-router";
import { timeAgo } from "../utils/dates";
import { stripMarkdown } from "../utils/stripMarkdown";
import { HomeFeedLoveButton } from "./HomeFeedLoveButton";
import { ReportShareButton } from "./ReportShareButton";
import { PhotoLightbox } from "./PhotoLightbox";
import { FeedMediaCarousel } from "./FeedMediaCarousel";
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

type SemanticStatusKind = "lost" | "found" | "matched" | "recovered" | "closed";

/**
 * Derive the single semantic status chip from existing PostItem fields only —
 * no invented statuses. An OPEN report reads as its type (Lost/Found); any
 * resolved lifecycle state supersedes it (Matched/Recovered/Closed).
 */
function semanticStatus(post: PostItem): { kind: SemanticStatusKind; label: string } {
  switch (post.status) {
    case "MATCHED":
      return { kind: "matched", label: "Matched" };
    case "RECOVERED":
      return { kind: "recovered", label: "Recovered" };
    case "CLOSED":
      return { kind: "closed", label: "Closed" };
    default:
      return post.type === "LOST"
        ? { kind: "lost", label: "Lost" }
        : { kind: "found", label: "Found" };
  }
}

const STATUS_ICONS: Record<SemanticStatusKind, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  lost: CircleAlert,
  found: CircleCheck,
  matched: Link2,
  recovered: CircleCheck,
  closed: Lock,
};

const STATUS_TONE: Record<SemanticStatusKind, string> = {
  lost: "fb-status-lost",
  found: "fb-status-found",
  matched: "fb-status-matched",
  recovered: "fb-status-recovered",
  closed: "fb-status-closed",
};

/** Semantic status chip: text + icon carry the meaning, never color alone. */
function StatusChip({ post }: { post: PostItem }) {
  const status = semanticStatus(post);
  const Icon = STATUS_ICONS[status.kind];
  return (
    <span
      data-testid="post-status-chip"
      data-status={status.kind}
      className={`fb-type-badge ${STATUS_TONE[status.kind]}`}
    >
      <Icon size={14} aria-hidden />
      {status.label}
    </span>
  );
}

/**
 * Real truncation probe for the clamped description. Reads the element's own
 * scrollHeight vs clientHeight (jsdom reports 0/0, so tests drive the values
 * through the element prototype) and re-runs on resize; a short description
 * never grows a "See more".
 */
function useTruncatedDescription(text: string) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !text) {
      setTruncated(false);
      return;
    }
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text]);
  return { ref, truncated };
}

/**
 * Home-feed layout (W2 content-first redesign, W7B-HOME media-led): near-
 * full-width 4:3 media carousel on top, then an inset text block, then an
 * inset flat action row. The report block itself carries no container chrome
 * (see PostCard `home-feed`); separation is whitespace + hairline.
 *
 * Navigation contract: the media region is a SIBLING of the detail link, never
 * inside it — tapping a photo opens the canonical PhotoLightbox at that index,
 * a horizontal swipe only changes the visible photo, and neither can navigate
 * the post. The detail `Link` wraps only the text (title/description/metadata),
 * so tapping the text opens Post Detail. "See more" is part of that link, so it
 * also navigates to detail instead of expanding inline.
 */
function HomeFeedContent({ post, enableSharedMedia = false }: { post: PostItem; enableSharedMedia?: boolean }) {
  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const excerpt = stripMarkdown(post.description);
  const { ref: descriptionRef, truncated } = useTruncatedDescription(excerpt);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxPhotos = images.map((a) => ({ id: a.id, previewUrl: a.fileUrl }));
  const lastIndex = lightboxPhotos.length - 1;
  // Detail destination mirrors PostList (`/posts/${post.id}`) — the single
  // route both shells navigate to.
  return (
    <div data-testid="home-feed-content" className="flex min-w-0 flex-col">
      {images.length > 0 && (
        <div data-testid="home-feed-media" className="fb-home-feed-media">
          <FeedMediaCarousel
            images={images.map((a, i) => ({
              id: a.id,
              fileUrl: a.fileUrl,
              alt:
                images.length === 1
                  ? `Photo for ${post.title}`
                  : `Photo ${i + 1} of ${images.length} for ${post.title}`,
            }))}
            sharedMediaId={enableSharedMedia ? sharedMediaLayoutId(post.id) : undefined}
            onOpenImage={(index) => setLightboxIndex(index)}
          />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2 px-4 pb-2 pt-3">
        <div className="flex items-start justify-between gap-2">
          <StatusChip post={post} />
          <span data-testid="post-time" className="shrink-0 whitespace-nowrap text-xs text-on-surface-variant">
            {timeAgo(post.createdAt)}
          </span>
        </div>
        <Link
          to={`/posts/${post.id}`}
          data-testid="home-feed-detail-link"
          className="flex min-w-0 flex-col gap-1.5 rounded-m3-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-surface"
        >
          <div data-testid="post-title">
            <SharedTitle
              post={post}
              className="fb-feed-title line-clamp-2 break-words"
              enableSharedMedia={enableSharedMedia}
            />
          </div>
          {excerpt && (
            <p
              ref={descriptionRef}
              data-testid="post-description"
              className="line-clamp-2 break-words text-sm leading-relaxed text-on-surface-variant"
            >
              {excerpt}
            </p>
          )}
          {excerpt && truncated && (
            <span
              data-testid="post-description-more"
              className="text-sm font-medium text-on-surface underline"
            >
              See more
            </span>
          )}
          <p data-testid="post-author" className="truncate text-xs text-on-surface-variant">
            @{post.author.username}
          </p>
          {post.locationLabel && (
            <p data-testid="post-location" className="flex min-w-0 items-center gap-1 text-xs text-on-surface-variant">
              <MapPin size={13} aria-hidden className="shrink-0" />
              <span className="truncate">{post.locationLabel}</span>
            </p>
          )}
        </Link>
        <div data-testid="post-footer" className="flex flex-wrap items-center gap-2">
          <span data-testid="post-category" className="fb-category-chip">
            <Tag size={12} aria-hidden className="shrink-0" />
            <span>{post.category}</span>
          </span>
        </div>
        {/* Flat action row (no bordered button cards): the existing Love
            toggle, the comments shortcut, and the existing share button share
            one row. The internal `.fb-report-action` border/background are
            neutralized visually via wrapper utilities — the controls themselves
            are reused untouched. */}
        <div
          data-testid="home-feed-actions"
          role="group"
          aria-label="Report actions"
          className="grid grid-cols-3 items-center gap-1 [&_a]:rounded-full! [&_a]:border-0! [&_a]:bg-transparent! [&_button]:rounded-full! [&_button]:border-0! [&_button]:bg-transparent!"
        >
          <HomeFeedLoveButton postId={post.id} likeCount={post.likeCount} />
          <Link
            to={`/posts/${post.id}#detail-comments`}
            aria-label={`Comments, ${post.commentCount}`}
            className="fb-report-action"
          >
            <MessageSquare size={18} aria-hidden /><span>{post.commentCount}</span>
          </Link>
          <ReportShareButton postId={post.id} title={post.title} />
        </div>
      </div>
      {lightboxIndex !== null && lightboxPhotos.length > 0 && (
        <PhotoLightbox
          photo={lightboxPhotos[Math.min(lightboxIndex, lastIndex)]!}
          index={Math.min(lightboxIndex, lastIndex)}
          total={lightboxPhotos.length}
          photos={lightboxPhotos}
          title={post.title}
          onSelect={(index) => setLightboxIndex(index)}
          onClose={() => setLightboxIndex(null)}
          onPrev={
            lightboxPhotos.length > 1
              ? () =>
                  setLightboxIndex((current) =>
                    current === null ? current : (current - 1 + lightboxPhotos.length) % lightboxPhotos.length,
                  )
              : undefined
          }
          onNext={
            lightboxPhotos.length > 1
              ? () =>
                  setLightboxIndex((current) =>
                    current === null ? current : (current + 1) % lightboxPhotos.length,
                  )
              : undefined
          }
        />
      )}
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
