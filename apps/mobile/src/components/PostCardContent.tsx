import type { PostItem } from "@findback/shared";
import { MessageSquare, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { timeAgo } from "../utils/dates";

export function PostCardContent({ post }: { post: PostItem }) {
  const image = post.attachments.find((a) => a.mimeType.startsWith("image/"));
  return (
    <>
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide">
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
      </div>

      {image && (
        <img
          src={image.fileUrl}
          alt=""
          loading="lazy"
          className="h-40 w-full rounded-m3-sm border border-outline-variant object-cover"
        />
      )}

      <h3 className="text-base font-semibold leading-snug">{post.title}</h3>
      <p className="line-clamp-2 text-sm text-on-surface-variant">{post.description}</p>

      <div className="flex items-center gap-4 text-xs text-on-surface-variant">
        <span className="font-medium text-on-surface">@{post.author.username}</span>
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
