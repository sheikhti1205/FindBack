import { useState } from "react";
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { POST_STATUS_LABELS } from "@findback/shared";
import { CircleAlert, CircleCheck, ImageOff, Link2, MessageSquare, Tag, Heart } from "lucide-react";
import { Link } from "react-router";
import { PhotoLightbox } from "./PhotoLightbox";
import { OwnerReportMenu } from "./OwnerReportActions";
import { timeAgo } from "../utils/dates";
import { stripMarkdown } from "../utils/stripMarkdown";

const OWNER_STATUS_CLASS: Record<PostStatus, string> = {
  OPEN: "fb-owner-status-open",
  MATCHED: "fb-owner-status-matched",
  RECOVERED: "fb-owner-status-recovered",
  CLOSED: "fb-owner-status-closed",
};

/** Lost/Found semantic badge reusing the home-feed badge primitives
 *  (text + icon, never color-only). */
function OwnerTypeBadge({ type }: { type: PostType }) {
  const lost = type === "LOST";
  return (
    <span
      data-testid="owner-report-type"
      className={`fb-type-badge ${lost ? "fb-type-lost" : "fb-type-found"}`}
    >
      {lost ? <CircleAlert size={14} aria-hidden /> : <CircleCheck size={14} aria-hidden />}
      {lost ? "Lost" : "Found"}
    </span>
  );
}

/** Owner engagement; rating remains on the individual report. */
function OwnerMetrics({ post }: { post: PostItem }) {
  return (
    <span
      data-testid="owner-report-metrics"
      className="flex items-center gap-3 text-xs text-on-surface-variant"
    >
      <span className="flex items-center gap-1">
        <Heart size={14} aria-hidden /> {post.likeCount}
      </span>
      <span className="flex items-center gap-1">
        <MessageSquare size={13} aria-hidden /> {post.commentCount}
      </span>
    </span>
  );
}

function OwnerImage({ post, fileUrl }: { post: PostItem; fileUrl: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  if (state === "failed") {
    return (
      <span className="fb-owner-img" data-state="failed" data-testid="owner-report-image">
        <span className="fb-owner-img-fallback" role="img" aria-label="Photo unavailable">
          <ImageOff size={16} aria-hidden />
          Photo unavailable
        </span>
      </span>
    );
  }
  return (
    <span className="fb-owner-img" data-state={state} data-testid="owner-report-image">
      <img
        src={fileUrl}
        alt={`Photo for ${post.title}`}
        loading="lazy"
        className="block h-full w-full object-cover"
        data-loaded={state === "loaded"}
        onLoad={() => setState("loaded")}
        onError={() => setState("failed")}
      />
    </span>
  );
}

/**
 * UXN-4 owner card (`owner-feed` / `my-report`): compact image-left /
 * content-right card for My Reports, visually aligned with the redesigned
 * home feed. Reuses the home-feed badge/chip primitives (`fb-type-badge`,
 * `fb-category-chip`, `fb-feed-title`), `timeAgo`, `stripMarkdown`, and the
 * shared lifecycle labels — only the arrangement and the prominent owner
 * status differ.
 *
 * The content links to the detail page while the photo opens the canonical
 * PhotoLightbox (media and link are siblings, never nested). The row's own
 * controls live in the overflow menu beside the card
 * (`OwnerReportMenu`): status, edit, share and delete. The menu is a SIBLING
 * of the content link, never inside it — a button nested in a link is
 * invalid DOM (see PostCard home-feed). All testids/classes are unchanged.
 * The card never repeats @currentUser: authorship is implicit on My Reports.
 */
export function OwnerReportCard({ post }: { post: PostItem }) {
  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const hero = images[0];
  const excerpt = stripMarkdown(post.description);
  // Canonical PhotoLightbox for the hero thumb (multi-image: full gallery at
  // the tapped index with prev/next). The media button is a SIBLING of the
  // content detail link, never inside it — a button nested in a link is
  // invalid DOM (see PostCard home-feed). All testids/classes are unchanged.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxPhotos = images.map((a) => ({ id: a.id, previewUrl: a.fileUrl }));
  const lastIndex = lightboxPhotos.length - 1;
  return (
    <article data-testid="owner-report-article">
      <div className="flex items-start gap-1">
        <div className="flex flex-1 gap-2.5 rounded-[18px] border border-outline-variant bg-surface-container-low p-2.5 shadow-sm transition-colors hover:border-on-surface-variant active:bg-surface-container">
          <div
            data-testid="owner-report-card"
             className="grid min-w-0 flex-1 grid-cols-[minmax(0,34%)_minmax(0,1fr)] gap-3"
          >
          <div data-testid="owner-report-media" className="relative min-w-0">
            {hero ? (
              <button
                type="button"
                onClick={() => setLightboxIndex(0)}
                aria-label={
                  images.length === 1
                    ? `Open photo for ${post.title} fullscreen`
                    : `Open photo 1 of ${images.length} for ${post.title} fullscreen`
                }
                className="block w-full"
              >
                <OwnerImage post={post} fileUrl={hero.fileUrl} />
              </button>
            ) : (
              <div
                data-testid="owner-report-no-photo"
                className="fb-owner-img fb-owner-img-none"
              >
                <ImageOff size={18} aria-hidden />
                <span>No photo</span>
              </div>
            )}
            {images.length > 1 && (
              <span data-testid="owner-report-photo-count" className="fb-feed-photo-badge">
                {images.length} photos
              </span>
            )}
          </div>
          <Link
            to={`/posts/${post.id}`}
            data-testid="owner-report-content"
            className="flex min-w-0 flex-col gap-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <OwnerTypeBadge type={post.type} />
              <span
                data-testid="owner-report-time"
                className="shrink-0 whitespace-nowrap text-xs text-on-surface-variant"
              >
                {timeAgo(post.createdAt)}
              </span>
            </div>
            <h3 className="fb-feed-title line-clamp-2 break-words">{post.title}</h3>
            <div
              data-testid="owner-report-status"
              className={`flex items-center gap-2 rounded-m3-sm border bg-surface p-2 text-xs font-semibold ${OWNER_STATUS_CLASS[post.status]}`}
            >
              {post.status === "MATCHED" ? <Link2 size={16} aria-hidden className="shrink-0" /> : post.status === "RECOVERED" ? <CircleCheck size={16} aria-hidden className="shrink-0" /> : <CircleAlert size={16} aria-hidden className="shrink-0" />}
              <span>{post.status === "OPEN" ? (post.type === "LOST" ? "Still missing" : "Awaiting owner") : post.status === "MATCHED" ? "Potential match" : POST_STATUS_LABELS[post.status]}</span>
            </div>
            {excerpt && (
              <p className="line-clamp-2 break-words text-sm leading-relaxed text-on-surface-variant">
                {excerpt}
              </p>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-1">
              <span data-testid="owner-report-category" className="fb-category-chip">
                <Tag size={12} aria-hidden className="shrink-0" />
                <span>{post.category}</span>
              </span>
              <OwnerMetrics post={post} />
            </div>
          </Link>
          </div>
        </div>
        <OwnerReportMenu post={post} />
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
    </article>
  );
}
