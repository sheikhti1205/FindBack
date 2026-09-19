import type {
  Attachment,
  Category,
  CommentItem,
  FeedPage,
  PostItem,
  PostStatus,
  PostType,
} from "@findback/shared";
import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { createPost, type CreatePostInput } from "./postsCreate";
import { removeStagedUpload, uploadImage } from "./postsUpload";

export { createPost } from "./postsCreate";
export type { CreatePostInput } from "./postsCreate";
export { removeStagedUpload, uploadImage } from "./postsUpload";
export type { StoredUpload } from "./postsUpload";

export interface FeedFilters {
  type?: PostType | "";
  category?: Category | "";
  status?: PostStatus | "";
  q?: string;
  sort?: "newest" | "oldest";
  dateFrom?: string;
  dateTo?: string;
  /** Restrict to one author (used by My Reports pagination). */
  userId?: string;
}

/**
 * Post reads go straight to Supabase via `findback_query_posts_client`.
 * The SQL function independently caps the page size at 20; the client asks for
 * one extra row to detect whether another page exists.
 */
const PAGE_LIMIT = 10;
const CLIENT_FEED_RPC = "findback_query_posts_client";

/** On-device matching pool: min(OPEN opposite-type, 20) per spec (WP8 #5). */
export const MATCH_CANDIDATE_LIMIT = 20;

interface PostCursor {
  createdAt: string;
  id: string;
}

interface AttachmentRow {
  id: unknown;
  post_id: unknown;
  file_url: unknown;
  mime_type: unknown;
  file_name: unknown;
  file_size: unknown;
  created_at: unknown;
}

interface ClientPostRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  description: string;
  category: string;
  status: string;
  event_date: string;
  latitude: number | null;
  longitude: number | null;
  location_label: string | null;
  youtube_url: string | null;
  created_at: string;
  updated_at: string;
  author_username: string;
  author_email_verified: number | boolean | null;
  author_phone_verified: number | boolean | null;
  author_avatar_url: string | null;
  author_created_at: string;
  like_count: number | null;
  dislike_count: number | null;
  rating_avg: number | string | null;
  rating_count: number | null;
  comment_count: number | null;
  attachments: AttachmentRow[] | null;
  total_count: number | null;
}

function decodeCursor(cursor?: string): PostCursor | null {
  if (!cursor) return null;
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    return null;
  }
  return null;
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mapAttachments(rows: AttachmentRow[] | null): Attachment[] {
  return (rows ?? []).map((a) => ({
    id: String(a.id),
    postId: String(a.post_id),
    fileUrl: String(a.file_url),
    mimeType: String(a.mime_type),
    fileName: String(a.file_name),
    fileSize: Number(a.file_size),
    createdAt: String(a.created_at),
  }));
}

/** A feed RPC row carries only public author fields — never email/phone. */
function mapClientPost(row: ClientPostRow): PostItem {
  return {
    id: row.id,
    userId: row.user_id,
    author: {
      id: row.user_id,
      username: row.author_username,
      emailVerified: Boolean(row.author_email_verified),
      phoneVerified: Boolean(row.author_phone_verified),
      avatarUrl: row.author_avatar_url ?? null,
      createdAt: row.author_created_at,
    },
    type: row.type as PostType,
    title: row.title,
    description: row.description,
    category: row.category as Category,
    status: row.status as PostStatus,
    eventDate: row.event_date,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    locationLabel: row.location_label ?? null,
    youtubeUrl: row.youtube_url ?? null,
    attachments: mapAttachments(row.attachments),
    likeCount: Number(row.like_count ?? 0),
    dislikeCount: Number(row.dislike_count ?? 0),
    ratingAvg: row.rating_avg == null ? null : Math.round(Number(row.rating_avg) * 100) / 100,
    ratingCount: Number(row.rating_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function feedArgs(
  filters: FeedFilters,
  limit: number,
  cursor: PostCursor | null,
): Record<string, unknown> {
  return {
    p_type: filters.type || null,
    p_category: filters.category || null,
    p_status: filters.status || null,
    p_q: filters.q || null,
    p_date_from: filters.dateFrom || null,
    p_date_to: filters.dateTo || null,
    p_user_id: filters.userId || null,
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_order: filters.sort === "oldest" ? "asc" : "desc",
    p_limit: limit,
  };
}

function toFeedPage(rows: ClientPostRow[], pagedTotal: boolean): FeedPage {
  const hasMore = rows.length > PAGE_LIMIT;
  const pageRows = hasMore ? rows.slice(0, PAGE_LIMIT) : rows;
  const items = pageRows.map(mapClientPost);
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    total: pagedTotal ? items.length : rows.length ? Number(rows[0]!.total_count ?? 0) : 0,
  };
}

/** Authenticated feed/search, read directly from Supabase. */
export async function fetchFeed(filters: FeedFilters, cursor?: string): Promise<FeedPage> {
  const { data, error } = await getSupabase().rpc(
    CLIENT_FEED_RPC,
    feedArgs(filters, PAGE_LIMIT + 1, decodeCursor(cursor)),
  );
  if (error) throw new ApiError(error.message, 400);
  return toFeedPage((data ?? []) as ClientPostRow[], false);
}

/** Single post by id, read directly from Supabase. */
export async function fetchPost(id: string): Promise<PostItem> {
  const { data, error } = await getSupabase().rpc(CLIENT_FEED_RPC, {
    p_post_id: id,
    p_limit: 1,
  });
  if (error) throw new ApiError(error.message, 400);
  const rows = (data ?? []) as ClientPostRow[];
  if (rows.length === 0) throw new ApiError("Post not found", 404);
  return mapClientPost(rows[0]!);
}

export async function updatePostStatus(id: string, status: PostStatus): Promise<PostItem> {
  const { error } = await getSupabase().rpc("findback_change_post_status_client", {
    p_post_id: id,
    p_status: status,
  });
  if (error) throw new ApiError(error.message, error.code === "42501" ? 403 : 400);
  return fetchPost(id);
}

/** A comment RPC row carries only public author fields — never email/phone. */
interface ClientCommentRow {
  id: string;
  post_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_id: string;
  author_username: string;
  author_email_verified: number | boolean | null;
  author_phone_verified: number | boolean | null;
  author_avatar_url: string | null;
  author_created_at: string;
}

function mapClientComment(row: ClientCommentRow): CommentItem {
  return {
    id: row.id,
    postId: row.post_id,
    author: {
      id: row.author_id,
      username: row.author_username,
      emailVerified: Boolean(row.author_email_verified),
      phoneVerified: Boolean(row.author_phone_verified),
      avatarUrl: row.author_avatar_url ?? null,
      createdAt: row.author_created_at,
    },
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function socialErrorStatus(code: string | undefined): number {
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "28000") return 401;
  return 400;
}

/** Comments for a post, read directly from Supabase. */
export async function fetchComments(postId: string): Promise<CommentItem[]> {
  const { data, error } = await getSupabase().rpc("findback_list_comments_client", {
    p_post_id: postId,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
  return ((data ?? []) as ClientCommentRow[]).map(mapClientComment);
}

export async function addComment(postId: string, body: string): Promise<CommentItem> {
  const { data, error } = await getSupabase().rpc("findback_add_comment_client", {
    p_post_id: postId,
    p_body: body,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
  const row = ((data ?? []) as ClientCommentRow[])[0];
  if (!row) throw new ApiError("Comment was not created", 400);
  return mapClientComment(row);
}

export async function deleteComment(_postId: string, commentId: string): Promise<void> {
  const { error } = await getSupabase().rpc("findback_delete_comment_client", {
    p_comment_id: commentId,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
}

export interface ReactionResult {
  postId: string;
  likeCount: number;
  dislikeCount: number;
  myReaction: "LIKE" | "DISLIKE" | null;
}

interface ClientReactionRow {
  post_id: string;
  like_count: number | null;
  dislike_count: number | null;
  my_reaction: string | null;
}

export async function reactToPost(
  postId: string,
  type: "LIKE" | "DISLIKE" | null,
): Promise<ReactionResult> {
  const { data, error } = await getSupabase().rpc("findback_react_client", {
    p_post_id: postId,
    p_type: type,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
  const row = ((data ?? []) as ClientReactionRow[])[0];
  if (!row) throw new ApiError("Reaction was not saved", 400);
  return {
    postId: row.post_id,
    likeCount: Number(row.like_count ?? 0),
    dislikeCount: Number(row.dislike_count ?? 0),
    myReaction: (row.my_reaction as "LIKE" | "DISLIKE" | null) ?? null,
  };
}

interface ClientRatingRow {
  post_id: string;
  score: number;
  rating_avg: number | string | null;
  rating_count: number | null;
}

export async function ratePost(postId: string, score: number): Promise<{
  postId: string;
  score: number;
  ratingAvg: number | null;
  ratingCount: number;
}> {
  const { data, error } = await getSupabase().rpc("findback_rate_client", {
    p_post_id: postId,
    p_score: score,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
  const row = ((data ?? []) as ClientRatingRow[])[0];
  if (!row) throw new ApiError("Rating was not saved", 400);
  return {
    postId: row.post_id,
    score: Number(row.score),
    ratingAvg: row.rating_avg == null ? null : Math.round(Number(row.rating_avg) * 100) / 100,
    ratingCount: Number(row.rating_count ?? 0),
  };
}

/** The caller's own reaction/rating for a post (reload hydration). */
export async function fetchSocialState(
  postId: string,
): Promise<{ myReaction: "LIKE" | "DISLIKE" | null; myRating: number | null }> {
  const { data, error } = await getSupabase().rpc("findback_post_social_state_client", {
    p_post_id: postId,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
  const row = ((data ?? []) as { my_reaction: string | null; my_rating: number | null }[])[0];
  return {
    myReaction: (row?.my_reaction as "LIKE" | "DISLIKE" | null) ?? null,
    myRating: row?.my_rating == null ? null : Number(row.my_rating),
  };
}

/** The signed-in user's own posts, read directly from Supabase. */
export async function fetchMyPosts(): Promise<FeedPage> {
  const { data, error } = await getSupabase().auth.getUser();
  if (error || !data.user) throw new ApiError("Not authenticated", 401);
  const res = await getSupabase().rpc(CLIENT_FEED_RPC, {
    p_user_id: data.user.id,
    p_order: "desc",
    p_limit: PAGE_LIMIT + 1,
  });
  if (res.error) throw new ApiError(res.error.message, 400);
  return toFeedPage((res.data ?? []) as ClientPostRow[], true);
}

/**
 * Candidate pool for on-device possible-matches: the most recent OPEN
 * opposite-type reports, capped at MATCH_CANDIDATE_LIMIT (WP8 #5).
 */
export async function fetchMatchCandidates(oppositeType: PostType): Promise<PostItem[]> {
  const { data, error } = await getSupabase().rpc(
    CLIENT_FEED_RPC,
    feedArgs({ type: oppositeType, status: "OPEN" }, MATCH_CANDIDATE_LIMIT, null),
  );
  if (error) throw new ApiError(error.message, 400);
  return ((data ?? []) as ClientPostRow[]).slice(0, MATCH_CANDIDATE_LIMIT).map(mapClientPost);
}

export async function publishReport(input: CreatePostInput, photo: File | null): Promise<string> {
  if (!photo) return createPost(input);
  const stored = await uploadImage(photo);
  try {
    return await createPost({ ...input, attachmentKey: stored.id });
  } catch (err) {
    await removeStagedUpload(stored);
    throw err;
  }
}
