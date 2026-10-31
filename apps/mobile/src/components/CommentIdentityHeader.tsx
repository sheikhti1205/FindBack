import type { ReactNode } from "react";
import type { CommentItem } from "@findback/shared";
import { UserQuickCard } from "./UserQuickCard";
import { UserAvatar } from "./UserAvatar";
import { timeAgo } from "../utils/dates";
import "./CommentThread.css";

/** Public presentation; permissions and action outcomes belong to the thread. */
export function CommentIdentityHeader({ comment, isAuthor, overflow }: {
  comment: CommentItem; isAuthor: boolean; overflow?: ReactNode;
}) {
  const exact = new Date(comment.createdAt).toLocaleString();
  return <header className="fb-comment-header">
    <UserQuickCard username={comment.author.username} displayName={comment.author.displayName} avatarUrl={comment.author.avatarUrl}
      trigger={<><UserAvatar username={comment.author.username} avatarUrl={comment.author.avatarUrl} size={28} />
        <span className="fb-identity-name">@{comment.author.username}</span></>} />
    {isAuthor && <span className="fb-comment-author">Author</span>}
    <time dateTime={comment.createdAt} title={exact} aria-label={exact}>{timeAgo(comment.createdAt)}</time>
    {overflow && <div className="fb-comment-overflow">{overflow}</div>}
  </header>;
}
