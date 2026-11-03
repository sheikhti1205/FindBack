import type { ReactNode } from "react";
import type { PostItem } from "@norfold/shared";
import { motion } from "framer-motion";
import { MapPin, Tag } from "lucide-react";
import { timeAgo } from "../utils/dates";
import { UserIdentityTrigger } from "./UserIdentityTrigger";
import { StatusChip } from "./StatusChip";
import { PostLink } from "./PostNavigation";
import { motionDurations, motionEasings, motionSprings } from "./uiMotion";
import "./PostAnatomy.css";

export function sharedMediaLayoutId(postId: string) { return `fb-post-media-${postId}`; }
export function sharedTitleLayoutId(postId: string) { return `fb-post-title-${postId}`; }
export const sharedElementTransition = {
  layout: motionSprings.soft, duration: motionDurations.fast, ease: motionEasings.inOut,
} as const;

/** Public presentation only; overflow and relationship state stay with features. */
export function PostIdentityHeader({ post, overflow, contextReportId }: { post: PostItem; overflow?: ReactNode; contextReportId?: string }) {
  return <header className="fb-post-identity">
    <UserIdentityTrigger person={contextReportId ? { ...post.author, contextReportId } : post.author} />
    <span data-testid="post-author" className="sr-only">@{post.author.username}</span>
    <time data-testid="post-time" dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()} className="fb-post-time">{timeAgo(post.createdAt)}</time>
    {overflow && <div className="fb-post-overflow">{overflow}</div>}
  </header>;
}

export function PostStatusTitle({ post, detail = false, titleClassName = "fb-feed-title", linkTestId, enableSharedMedia = false }: {
  post: PostItem; detail?: boolean; titleClassName?: string; linkTestId?: string; enableSharedMedia?: boolean;
}) {
  const Title = detail ? motion.h1 : motion.h3;
  const title = <Title className={`break-words ${titleClassName}`} {...(enableSharedMedia ? {
    layoutId: sharedTitleLayoutId(post.id), "data-shared-title": sharedTitleLayoutId(post.id), transition: sharedElementTransition,
  } : {})}>{post.title}</Title>;
  return <div className="fb-post-heading">
    <div className="fb-post-status"><StatusChip post={post} />{post.status !== "OPEN" && <span>{post.type === "LOST" ? "Lost" : "Found"}</span>}</div>
    <div data-testid="post-title">{detail ? title : <PostLink to={`/posts/${post.id}`} data-testid={linkTestId} className="fb-post-title-link">{title}</PostLink>}</div>
  </div>;
}

/** Facts follow media, never a second metadata card. Extra detail is a slot. */
export function PostFacts({ post, children }: { post: PostItem; children?: ReactNode }) {
  return <div className="fb-post-facts">
    {post.locationLabel && <p data-testid="post-location"><MapPin size={13} aria-hidden /><span>{post.locationLabel}</span></p>}
    <p data-testid="post-category"><Tag size={13} aria-hidden /><span>{post.category}</span></p>
    {children}
  </div>;
}
