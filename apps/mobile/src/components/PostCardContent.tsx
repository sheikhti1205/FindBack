import type { PostItem, PostStatus } from "@findback/shared";
import { MessageSquare, Star, ThumbsDown, ThumbsUp } from "lucide-react";
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

export function PostCardContent({ post }: { post: PostItem }) {
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

      <h3 className="text-base font-semibold leading-snug">{post.title}</h3>
      <p className="line-clamp-2 text-sm text-on-surface-variant">{excerpt}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant">
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
    </>
  );
}
