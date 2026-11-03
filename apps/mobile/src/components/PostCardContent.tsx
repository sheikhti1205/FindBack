import { useState, type ReactNode } from "react";
import type { PostItem } from "@findback/shared";
import { motion } from "framer-motion";
import { ImageOff } from "lucide-react";
import { displaySizeOrNull } from "../services/media/displayDimensions";
import { useMediaUrl } from "../services/media/privateMedia";
import { MASONRY_FALLBACK_RATIO, masonryAspectRatio } from "./masonryLayout";
import { HomeFeedLoveButton } from "./HomeFeedLoveButton";
import { PostActionRow } from "./PostActionRow";
import { ReportShareButton } from "./ReportShareButton";
import { PostIdentityHeader, PostStatusTitle, PostFacts, sharedMediaLayoutId, sharedElementTransition } from "./PostAnatomy";
import { useReportNavigation } from "./PostNavigation";
import { PostDescription } from "./PostDescription";
import { FeedMediaCarousel } from "./FeedMediaCarousel";
import { fadeVariants, motionDurations, motionEasings } from "./uiMotion";

export { sharedMediaLayoutId, sharedTitleLayoutId, sharedElementTransition } from "./PostAnatomy";
export type PostCardLayout = "classic" | "editorial" | "compact" | "home-feed" | "masonry";
type ImageState = "loading" | "loaded" | "failed";

/** Reserved geometry and decode/failure feedback shared by non-carousel previews. */
function FeedImage({ url, alt, variant, postId, enableSharedMedia = false }: {
  url: string; alt: string; variant: "frame" | "thumb"; postId: string; enableSharedMedia?: boolean;
}) {
  const [state, setState] = useState<ImageState>("loading");
  const src = useMediaUrl(url);
  const sharedId = enableSharedMedia ? sharedMediaLayoutId(postId) : undefined;
  const transition = { duration: motionDurations.fast, ease: motionEasings.inOut };
  return <motion.span className={variant === "thumb" ? "fb-thumb" : "fb-img-frame"}
    data-state={state} data-testid="post-image-state" {...(sharedId ? {
      layoutId: sharedId, "data-shared-media": sharedId, transition: sharedElementTransition,
    } : {})}>
    {state === "failed" ? <motion.span className="fb-img-fallback" role="img" aria-label="Photo unavailable"
      variants={fadeVariants} initial="hidden" animate="visible" transition={transition}>
      <ImageOff size={16} aria-hidden />Photo unavailable
    </motion.span> : <motion.img src={src} alt={alt} loading="lazy" initial={{ opacity: 0 }}
      animate={{ opacity: state === "loaded" ? 1 : 0 }} transition={transition}
      onLoad={() => setState("loaded")} onError={() => setState("failed")} />}
  </motion.span>;
}

/** Same size owner for both masonry's estimate and its pre-decode geometry. */
export interface MasonryCardMetrics {
  hasMedia: boolean;
  mediaRatio: number;
  imageCount: number;
  sizeKnown: boolean;
}
export function masonryCardMetrics(post: PostItem): MasonryCardMetrics {
  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const size = images[0] ? displaySizeOrNull(images[0]) : null;
  return { hasMedia: images.length > 0, mediaRatio: size ? masonryAspectRatio(size) : MASONRY_FALLBACK_RATIO,
    imageCount: images.length, sizeKnown: size !== null };
}

function MasonryPreview({ post, onOpenReport, enableSharedMedia }: {
  post: PostItem; onOpenReport: () => void; enableSharedMedia: boolean;
}) {
  const metrics = masonryCardMetrics(post);
  const first = post.attachments.find(a => a.mimeType.startsWith("image/"));
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  if (!first) return null;
  const src = useMediaUrl(first.fileUrl);
  const sharedId = enableSharedMedia ? sharedMediaLayoutId(post.id) : undefined;
  return <button type="button" data-testid="masonry-media"
    aria-label={metrics.imageCount > 1 ? `Photo 1 of ${metrics.imageCount} for ${post.title}` : `Photo for ${post.title}`}
    onClick={onOpenReport} className="fb-post-photo fb-masonry-media relative block w-full overflow-hidden"
    style={{ aspectRatio: `${naturalRatio ?? metrics.mediaRatio}` }}>
    {!failed && <motion.img src={src} alt="" loading="lazy" className="h-full w-full object-cover"
      {...(sharedId ? { layoutId: sharedId, "data-shared-media": sharedId, transition: sharedElementTransition } : {})}
      onLoad={(event) => {
        const el = event.currentTarget;
        if (!metrics.sizeKnown && el.naturalWidth > 0 && el.naturalHeight > 0) setNaturalRatio(el.naturalWidth / el.naturalHeight);
      }} onError={() => setFailed(true)} />}
    {failed && <span data-testid="masonry-media-fallback" className="fb-img-fallback" aria-hidden><ImageOff size={16} aria-hidden />Photo unavailable</span>}
    {metrics.imageCount > 1 && <span data-testid="masonry-more-media" className="fb-masonry-more" aria-hidden>+{metrics.imageCount - 1}</span>}
  </button>;
}

/** The preview keeps density-specific geometry; every tap opens the report. */
function PostMediaPreview({ post, layout, enableSharedMedia, onOpenReport }: {
  post: PostItem; layout: PostCardLayout; enableSharedMedia: boolean; onOpenReport: () => void;
}) {
  const images = post.attachments.filter(a => a.mimeType.startsWith("image/"));
  const first = images[0];
  if (!first) return null;
  if (layout === "home-feed") return <div data-testid="home-feed-media" className="fb-home-feed-media">
    <FeedMediaCarousel images={images.map((a, i) => ({ id: a.id, fileUrl: a.fileUrl,
      alt: images.length === 1 ? `Photo for ${post.title}` : `Photo ${i + 1} of ${images.length} for ${post.title}`,
    }))} sharedMediaId={enableSharedMedia ? sharedMediaLayoutId(post.id) : undefined} onOpenReport={onOpenReport} />
  </div>;
  if (layout === "masonry") return <MasonryPreview post={post} onOpenReport={onOpenReport} enableSharedMedia={enableSharedMedia} />;
  return <button type="button" className="fb-post-photo" aria-label={`Photo for ${post.title}`} onClick={onOpenReport}>
    <FeedImage key={first.fileUrl} url={first.fileUrl} alt={`Photo for ${post.title}`}
      variant={layout === "compact" ? "thumb" : "frame"} postId={post.id} enableSharedMedia={enableSharedMedia} />
  </button>;
}

/** One anatomy across retained density modes. Navigation, identity, disclosure,
 * media and actions are independent targets; feature owners supply overflow.
 *
 * Two-stage media (owner decision): a feed/list/masonry/search photo is a
 * NAVIGATION target — it opens the report — while the report detail's own hero
 * gallery opens the fullscreen viewer. Feed previews therefore own no lightbox. */
export function PostCardContent({ post, layout = "classic", enableSharedMedia = false, overflow }: {
  post: PostItem; layout?: PostCardLayout; enableSharedMedia?: boolean; overflow?: ReactNode;
}) {
  const openReport = useReportNavigation();
  const photoCount = post.attachments.filter(a => a.mimeType.startsWith("image/")).length;
  const openDetail = () => openReport(`/posts/${post.id}`);
  const dense = layout === "compact" || layout === "masonry";
  const titleClassName = layout === "editorial" ? "fb-editorial-title" : layout === "masonry" ? "fb-masonry-title line-clamp-2" : layout === "compact" ? "text-sm font-bold leading-snug line-clamp-2" : "fb-feed-title line-clamp-2";
  return <div data-testid={layout === "home-feed" ? "home-feed-content" : layout === "masonry" ? "masonry-content" : undefined}
    className={`fb-post-content fb-post-${layout}`}>
    <PostIdentityHeader post={post} overflow={overflow} contextReportId={post.id} />
    <PostStatusTitle post={post} titleClassName={titleClassName} enableSharedMedia={enableSharedMedia}
      linkTestId={layout === "home-feed" ? "home-feed-detail-link" : layout === "masonry" ? "masonry-detail-link" : undefined} />
    {!dense && <div className="fb-post-description"><PostDescription text={post.description} /></div>}
    <PostMediaPreview key={post.id} post={post} layout={layout} enableSharedMedia={enableSharedMedia} onOpenReport={openDetail} />
    <PostFacts post={post}>
      {layout !== "home-feed" && layout !== "masonry" && photoCount > 0 && <p data-testid="photo-count">{photoCount} {photoCount === 1 ? "photo" : "photos"}</p>}
    </PostFacts>
    <div data-testid="post-footer">
      <div data-testid={layout === "home-feed" ? "home-feed-actions" : undefined}>
        <PostActionRow commentCount={post.commentCount} commentsHref={`/posts/${post.id}#detail-comments`} slots={{
          like: <HomeFeedLoveButton postId={post.id} likeCount={post.likeCount} />,
          share: <ReportShareButton postId={post.id} title={post.title} />,
        }} />
      </div>
    </div>
  </div>;
}
