import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { MapPin } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { useReportPreview } from "../hooks/useReportPreview";

/**
 * One report reference, rendered inline.
 *
 * This is the only renderer for "report card in a comment" and is shared by
 * both mount points — the markdown unfurl (I4a) and the typed descriptor list
 * (I4b). It is deliberately NOT `PostCardContent` (feed controls, lightbox,
 * detail link) nor `OwnerReportCard` (owner voice, no author, lifecycle box).
 *
 * Inline-only: every element here is phrasing content (`span`, `img`, `a`,
 * `button`) because `ReactMarkdown` renders the link inside a `<p>`. The whole
 * card is one link. The cover is decorative (`alt=""`) because the adjacent
 * title already names the link; a title in both places would announce it twice.
 */

/**
 * The one unavailable node. States A (absent/unreadable target) and B
 * (tombstone, `reportPostId: null`) both render it, so no viewer can infer why
 * a reference is unavailable — the indistinguishability ruling.
 */
export const REPORT_UNAVAILABLE: ReactNode = (
  <span
    data-testid="report-unavailable"
    className="inline-flex items-center rounded-m3-sm border border-outline-variant px-2 py-1 align-middle text-xs text-on-surface-variant"
  >
    Report unavailable
  </span>
);

export function ReportReferenceCard({ postId }: { postId: string | null }) {
  const state = useReportPreview(postId);
  const [coverFailed, setCoverFailed] = useState(false);

  if (state.status === "unavailable") return REPORT_UNAVAILABLE;

  if (state.status === "error") {
    return (
      <span
        data-testid="report-reference-error"
        className="inline-flex flex-wrap items-center gap-1 rounded-m3-sm border border-outline-variant px-2 py-1 align-middle text-xs text-on-surface-variant"
      >
        <span>Couldn&apos;t load this report.</span>
        <button
          type="button"
          onClick={state.retry}
          className="inline-flex min-h-[44px] items-center rounded-full px-2 font-medium underline"
        >
          Retry
        </button>
      </span>
    );
  }

  if (state.status === "loading") {
    return (
      <span
        data-testid="report-reference-loading"
        className="inline-flex max-w-full items-center gap-2 rounded-m3-sm border border-outline-variant p-1.5 align-middle"
      >
        <span aria-hidden className="h-12 w-12 shrink-0 animate-pulse rounded-m3-sm bg-surface-container" />
        <span aria-hidden className="flex min-w-0 flex-col gap-1">
          <span className="h-3 w-28 animate-pulse rounded-full bg-surface-container" />
          <span className="h-2.5 w-20 animate-pulse rounded-full bg-surface-container" />
        </span>
        <span className="sr-only">Loading report</span>
      </span>
    );
  }

  const { post } = state;
  // Photos only (report publishes are photo-only); a non-image first descriptor
  // must not turn the box into a broken-image glyph.
  const cover = coverFailed
    ? undefined
    : post.attachments.find((attachment) => attachment.mimeType.startsWith("image/"))?.fileUrl;
  return (
    <Link
      to={`/posts/${post.id}`}
      data-testid="report-reference"
      className="inline-flex max-w-full items-center gap-2 rounded-m3-sm border border-outline-variant p-1.5 align-middle hover:border-outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-surface"
    >
      <span className="h-12 w-12 shrink-0 overflow-hidden rounded-m3-sm bg-surface-container">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            onError={() => setCoverFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <StatusChip post={post} />
        <span className="line-clamp-2 break-words text-xs font-semibold">{post.title}</span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-on-surface-variant">
          <span className="truncate">@{post.author.username}</span>
          {post.locationLabel ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <MapPin size={10} aria-hidden />
                <span className="truncate">{post.locationLabel}</span>
              </span>
            </>
          ) : null}
        </span>
      </span>
    </Link>
  );
}
