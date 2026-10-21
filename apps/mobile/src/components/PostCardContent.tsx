import { useLayoutEffect, useRef, useState } from "react";
import type { PostItem, PostStatus } from "@findback/shared";
import { motion } from "framer-motion";
import { ImageOff, MapPin, MessageSquare, Star, Tag, ThumbsDown, ThumbsUp } from "lucide-react";
import { Link } from "react-router";
import { timeAgo } from "../utils/dates";
import { stripMarkdown } from "../utils/stripMarkdown";
import { displaySizeOrNull } from "../services/media/displayDimensions";
import { MASONRY_FALLBACK_RATIO, masonryAspectRatio } from "./masonryLayout";
import { HomeFeedLoveButton } from "./HomeFeedLoveButton";
import { ReportShareButton } from "./ReportShareButton";
import { StatusChip } from "./StatusChip";
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
 *  Home uses it. `masonry` is the CF-010 ragged grid card (packet `09` §7):
 *  natural-ratio photo, badge, two-line title, location, small counts. */
export type PostCardLayout = "classic" | "editorial" | "compact" | "home-feed" | "masonry";

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

/**
 * What a masonry card knows before its photo loads (packet `09` §7, §9): the
 * natural ratio when the report carries a vouchable size pair, the shared
 * placeholder ratio otherwise. One owner — the grid's height estimate and the
 * card's reserved box must agree, or the first paint would be wrong.
 */
export interface MasonryCardMetrics {
  hasMedia: boolean;
  /** width / height of the first photo, or the placeholder ratio. */
  mediaRatio: number;
  imageCount: number;
  /** True when the stored size is known, so the box needs no correction. */
  sizeKnown: boolean;
}

export function masonryCardMetrics(post: PostItem): MasonryCardMetrics {
  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const size = images[0] ? displaySizeOrNull(images[0]) : null;
  return {
    hasMedia: images.length > 0,
    mediaRatio: size ? masonryAspectRatio(size) : MASONRY_FALLBACK_RATIO,
    imageCount: images.length,
    sizeKnown: size !== null,
  };
}

/**
 * CF-010 masonry card (packet `09` §7). The photo keeps its natural ratio, so
 * cards are honestly different heights instead of every cell being squared off
 * and cropped; there is no description and no equalizing, and a report with no
 * photo is a text-first card rather than a blank block.
 *
 * Navigation follows the same contract as the Home feed card: the media is a
 * SIBLING of the detail link (its own tap target opening the canonical
 * PhotoLightbox), so a tap on the photo can never navigate the report.
 *
 * Rows published before dimensions existed start at the placeholder ratio and
 * correct themselves when the photo decodes; the grid re-packs from the
 * measured height, so the correction stays bounded to that one card.
 */
function MasonryContent({ post, enableSharedMedia = false }: { post: PostItem; enableSharedMedia?: boolean }) {
  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const metrics = masonryCardMetrics(post);
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const ratio = naturalRatio ?? metrics.mediaRatio;
  const first = images[0];
  const extra = metrics.imageCount - 1;
  const sharedId = enableSharedMedia ? sharedMediaLayoutId(post.id) : undefined;
  const lightboxPhotos = images.map((a) => ({ id: a.id, previewUrl: a.fileUrl }));
  const lastIndex = lightboxPhotos.length - 1;
  return (
    <div data-testid="masonry-content" className="flex min-w-0 flex-col">
      {first && (
        <button
          type="button"
          data-testid="masonry-media"
          aria-label={
            metrics.imageCount > 1
              ? `Photo 1 of ${metrics.imageCount} for ${post.title}`
              : `Photo for ${post.title}`
          }
          onClick={() => setLightboxIndex(0)}
          className="fb-masonry-media relative block w-full overflow-hidden"
          style={{ aspectRatio: `${ratio}` }}
        >
          {!mediaFailed && (
            <motion.img
              src={first.fileUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              {...(sharedId
                ? { layoutId: sharedId, "data-shared-media": sharedId, transition: sharedElementTransition }
                : {})}
              onLoad={(event) => {
                if (metrics.sizeKnown) return;
                const el = event.currentTarget;
                if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                  setNaturalRatio(el.naturalWidth / el.naturalHeight);
                }
              }}
              onError={() => setMediaFailed(true)}
            />
          )}
          {/* A photo that cannot load says so, in the same words and the same
              box as every other density (`.fb-img-fallback`). Without this the
              grid keeps a bare <img> and the reader sees the browser's
              broken-image glyph in the middle of a card. aria-hidden: the
              button above already carries the accessible name. */}
          {mediaFailed && (
            <span data-testid="masonry-media-fallback" className="fb-img-fallback" aria-hidden>
              <ImageOff size={16} aria-hidden />
              Photo unavailable
            </span>
          )}
          {extra > 0 && (
            <span data-testid="masonry-more-media" className="fb-masonry-more" aria-hidden>
              +{extra}
            </span>
          )}
        </button>
      )}
      <div className="fb-masonry-body">
        <StatusChip post={post} />
        <Link
          to={`/posts/${post.id}`}
          data-testid="masonry-detail-link"
          className="flex min-w-0 flex-col gap-1 rounded-m3-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-surface"
        >
          <SharedTitle
            post={post}
            className="fb-masonry-title line-clamp-2 break-words"
            enableSharedMedia={enableSharedMedia}
          />
          {post.locationLabel && (
            <p
              data-testid="post-location"
              className="flex min-w-0 items-center gap-1 text-[11px] text-on-surface-variant"
            >
              <MapPin size={12} aria-hidden className="shrink-0" />
              <span className="truncate">{post.locationLabel}</span>
            </p>
          )}
        </Link>
        <CountRow post={post} compact />
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
  if (layout === "masonry") return <MasonryContent post={post} enableSharedMedia={enableSharedMedia} />;
  return <ClassicContent post={post} enableSharedMedia={enableSharedMedia} />;
}
