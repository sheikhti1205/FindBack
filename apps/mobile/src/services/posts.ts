import type {
  Attachment,
  Category,
  CommentItem,
  FeedPage,
  PostItem,
  PostStatus,
  PostType,
  ReactionKind,
  ReactionSummary,
} from "@findback/shared";
import { reactionSummaryFromRow } from "./reactions";
import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { createPost, createPostMulti, type CreatePostInput } from "./postsCreate";
import {
  IMAGES_BUCKET,
  removeStagedUpload,
  removeStagedUploads,
  uploadImage,
  uploadPhotos,
  type UploadProgress,
} from "./postsUpload";
import { MAX_REPORT_PHOTOS, PrepareError } from "./media/prepareImages";
import { diag } from "./diag";
import { PublishOutcomeUncertainError } from "./publishOutcome";

export { createPost, createPostMulti } from "./postsCreate";
export type { CreatePostInput, CreatePostMultiInput } from "./postsCreate";
export { removeStagedUpload, removeStagedUploads, uploadImage, uploadPhotos } from "./postsUpload";
export type { StoredUpload, UploadProgress } from "./postsUpload";
export { MAX_REPORT_PHOTOS } from "./media/prepareImages";

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
  /**
   * Nearby scope (UXN-1). All three must be numeric for the nearby RPC to be
   * used; the center is the already-rounded (~100 m) session center and is
   * never written to the URL. Partial values are ignored (normal feed RPC).
   */
  nearLat?: number | null;
  nearLng?: number | null;
  /** Search radius in meters. */
  radiusM?: number | null;
}

/**
 * Post reads go straight to Supabase via `findback_query_posts_client`.
 * The SQL function independently caps the page size at 20; the client asks for
 * one extra row to detect whether another page exists.
 */
const PAGE_LIMIT = 10;
const CLIENT_FEED_RPC = "findback_query_posts_client";
/**
 * Additive Nearby feed RPC (UXN-1). The normal feed RPC above is untouched;
 * this route is taken only when all three nearby filters are numeric.
 */
export const NEARBY_FEED_RPC = "findback_query_posts_nearby_client";

/** On-device matching pool: min(OPEN opposite-type, 20) per spec. */
export const MATCH_CANDIDATE_LIMIT = 20;

interface PostCursor {
  createdAt: string;
  id: string;
}

export interface AttachmentRow {
  id: unknown;
  post_id: unknown;
  file_url: unknown;
  mime_type: unknown;
  file_name: unknown;
  file_size: unknown;
  created_at: unknown;
  /**
   * 1-based position from `public.attachments.display_order` (D1 migration).
   * The feed/detail RPC payload does not carry it yet (D1 follow-up), so it
   * is optional here: rows without it keep their relative order.
   */
  display_order?: unknown;
}

function displayOrderKey(row: AttachmentRow): number {
  const raw = row.display_order;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? Number(raw) : NaN;
  return Number.isInteger(n) && (n as number) >= 1 ? (n as number) : Number.MAX_SAFE_INTEGER;
}

/**
 * Map attachment rows into `Attachment[]` honouring `display_order`
 * (explicit ascending order; legacy rows without it keep relative order,
 * tie-broken by created_at then id for determinism). Array position IS the
 * display order — the shared `Attachment` shape is intentionally unchanged.
 */
export function mapAttachments(rows: AttachmentRow[] | null): Attachment[] {
  return (rows ?? [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) =>
      displayOrderKey(a.row) - displayOrderKey(b.row) ||
      String(a.row.created_at ?? "").localeCompare(String(b.row.created_at ?? "")) ||
      String(a.row.id ?? "").localeCompare(String(b.row.id ?? "")) ||
      a.index - b.index,
    )
    .map(({ row: a }) => ({
      id: String(a.id),
      postId: String(a.post_id),
      fileUrl: String(a.file_url),
      mimeType: String(a.mime_type),
      fileName: String(a.file_name),
      fileSize: Number(a.file_size),
      createdAt: String(a.created_at),
    }));
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

/** True when the nearby RPC must be used: all three scope values numeric. */
export function isNearbyFeedFilters(filters: FeedFilters): boolean {
  return (
    typeof filters.nearLat === "number" &&
    Number.isFinite(filters.nearLat) &&
    typeof filters.nearLng === "number" &&
    Number.isFinite(filters.nearLng) &&
    typeof filters.radiusM === "number" &&
    Number.isFinite(filters.radiusM) &&
    (filters.radiusM as number) > 0
  );
}

function nearbyArgs(
  filters: FeedFilters,
  limit: number,
  cursor: PostCursor | null,
): Record<string, unknown> {
  return {
    ...feedArgs(filters, limit, cursor),
    p_near_lat: filters.nearLat,
    p_near_lng: filters.nearLng,
    p_radius_m: filters.radiusM,
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
  const nearby = isNearbyFeedFilters(filters);
  const { data, error } = await getSupabase().rpc(
    nearby ? NEARBY_FEED_RPC : CLIENT_FEED_RPC,
    nearby
      ? nearbyArgs(filters, PAGE_LIMIT + 1, decodeCursor(cursor))
      : feedArgs(filters, PAGE_LIMIT + 1, decodeCursor(cursor)),
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
  parent_id: string | null;
  depth: number;
  body: string;
  created_at: string;
  updated_at: string;
  author_id: string;
  author_username: string;
  author_email_verified: number | boolean | null;
  author_phone_verified: number | boolean | null;
  author_avatar_url: string | null;
  author_created_at: string;
  /** Per-kind reaction counts (W3.3); absent on rows from the add RPC. */
  reaction_counts?: unknown;
  /** Caller's own reaction (W3.3); absent on rows from the add RPC. */
  my_reaction?: unknown;
}

function mapClientComment(row: ClientCommentRow): CommentItem {
  const reactionSummary = reactionSummaryFromRow(row);
  return {
    id: row.id,
    postId: row.post_id,
    parentId: row.parent_id ?? null,
    depth: row.depth ?? 0,
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
    ...(reactionSummary ? { reactionSummary } : {}),
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

export async function addComment(
  postId: string,
  body: string,
  parentId?: string | null,
): Promise<CommentItem> {
  const { data, error } = await getSupabase().rpc("findback_add_comment_client", {
    p_post_id: postId,
    p_body: body,
    p_parent_id: parentId ?? null,
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
  /** Caller's own reaction (raw wire kind, W3.3: any valid kind, not just LIKE/DISLIKE). */
  myReaction: ReactionKind | null;
  /** Per-kind counts from the widened react RPC (W3.3); absent on legacy mocks. */
  reactionCounts?: ReactionSummary;
}

interface ClientReactionRow {
  post_id: string;
  like_count: number | null;
  dislike_count: number | null;
  my_reaction: string | null;
  reaction_counts?: unknown;
}

export async function reactToPost(
  postId: string,
  type: ReactionKind | null,
): Promise<ReactionResult> {
  const { data, error } = await getSupabase().rpc("findback_react_client", {
    p_post_id: postId,
    p_type: type,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
  const row = ((data ?? []) as ClientReactionRow[])[0];
  if (!row) throw new ApiError("Reaction was not saved", 400);
  const reactionCounts =
    row.reaction_counts === undefined
      ? undefined
      : reactionSummaryFromRow({ reaction_counts: row.reaction_counts, my_reaction: row.my_reaction });
  return {
    postId: row.post_id,
    likeCount: Number(row.like_count ?? 0),
    dislikeCount: Number(row.dislike_count ?? 0),
    myReaction: (row.my_reaction as ReactionKind | null) ?? null,
    ...(reactionCounts ? { reactionCounts } : {}),
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
): Promise<{ myReaction: ReactionKind | null; myRating: number | null }> {
  const { data, error } = await getSupabase().rpc("findback_post_social_state_client", {
    p_post_id: postId,
  });
  if (error) throw new ApiError(error.message, socialErrorStatus(error.code));
  const row = ((data ?? []) as { my_reaction: string | null; my_rating: number | null }[])[0];
  return {
    myReaction: (row?.my_reaction as ReactionKind | null) ?? null,
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
 * opposite-type reports, capped at MATCH_CANDIDATE_LIMIT.
 */
export async function fetchMatchCandidates(oppositeType: PostType): Promise<PostItem[]> {
  const { data, error } = await getSupabase().rpc(
    CLIENT_FEED_RPC,
    feedArgs({ type: oppositeType, status: "OPEN" }, MATCH_CANDIDATE_LIMIT, null),
  );
  if (error) throw new ApiError(error.message, 400);
  return ((data ?? []) as ClientPostRow[]).slice(0, MATCH_CANDIDATE_LIMIT).map(mapClientPost);
}

export async function publishReport(input: CreatePostInput, photo: File | null, traceId?: string): Promise<string> {
  if (!photo) return createPost(input, traceId);
  const stored = await uploadImage(photo, traceId);
  try {
    return await createPost({ ...input, attachmentKey: stored.id }, traceId);
  } catch (err) {
    if (!(err instanceof PublishOutcomeUncertainError)) await removeStagedUpload(stored, traceId);
    throw err;
  }
}

export interface PublishPhotosOptions {
  onProgress?: (progress: UploadProgress) => void;
  traceId?: string;
  /**
   * Cooperative publish cancel threaded from the report screen. Staging
   * remains cooperative via onProgress; this gate covers the boundary AFTER
   * the final photo stages but BEFORE the create-post RPC runs (the point of
   * no return). An abort here cleans exactly this attempt's staged objects
   * and never creates the post row.
   */
  signal?: AbortSignal;
}

/**
 * Publish a report with 0–5 ordered photos.
 *
 * 0 photos (or a single photo via the legacy `publishReport` wrapper) keeps
 * the old RPC path so legacy readers/clients observe no change; ≥1 photo
 * here stages each image independently in order, then calls the versioned
 * multi-key RPC with the ordered staging ids. The RPC consumes staging rows
 * atomically server-side, so a failed publish can never leave a ghost post
 * (a post row without its images): on failure exactly this attempt's staged
 * objects are removed and the caller's local Files stay untouched for retry.
 */
export async function publishReportWithPhotos(
  input: CreatePostInput,
  photos: readonly File[],
  options: PublishPhotosOptions = {},
): Promise<string> {
  if (photos.length > MAX_REPORT_PHOTOS) {
    throw new PrepareError(
      "REPORT_LIMIT",
      `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. ` +
        "The extra photo was not published — remove one first and try again.",
    );
  }
  if (photos.length === 0) return createPost(input, options.traceId);
  diag("posts.publish.multi_start", {
    photoCount: photos.length,
  }, { traceId: options.traceId });
  const staged = await uploadPhotos([...photos], {
    onProgress: options.onProgress,
    traceId: options.traceId,
  });
  if (options.signal?.aborted) {
    await removeStagedUploads(staged, options.traceId);
    const cancelled = new Error("Upload cancelled. Your photos are kept \u2014 try again.");
    cancelled.name = "UploadCancelledError";
    throw cancelled;
  }
  try {
    const postId = await createPostMulti(
      { ...input, attachmentKeys: staged.map((s) => s.id) },
      options.traceId,
    );
    diag("posts.publish.multi_success", {
      postId,
      photoCount: staged.length,
    }, { traceId: options.traceId });
    return postId;
  } catch (err) {
    if (!(err instanceof PublishOutcomeUncertainError)) await removeStagedUploads(staged, options.traceId);
    throw err;
  }
}

async function requirePostOwner(postId: string): Promise<PostItem> {
  const { data: userData, error: userError } = await getSupabase().auth.getUser();
  if (userError || !userData.user) throw new ApiError("Not authenticated", 401);
  const post = await fetchPost(postId);
  if (post.userId !== userData.user.id) {
    throw new ApiError("Only the report owner can change its photos", 403);
  }
  return post;
}

/**
 * Owner-only photo reorder with a precondition conflict strategy: pass the
 * order you currently see (`expectedOrder`); if the server order moved since
 * (another writer won), this throws 409 and writes nothing — reload and
 * retry. Matching preconditions apply last-writer-wins. Omitting the
 * precondition skips the check (single-writer callers only).
 *
 * LIVE NOTE: `attachments` currently has no UPDATE RLS policy (INSERT-own +
 * SELECT only), so live calls 403 until a follow-up migration adds owner
 * UPDATE/DELETE policies. Logic is proven by mocked tests.
 */
export async function reorderPostImages(
  postId: string,
  orderedAttachmentIds: readonly string[],
  expectedOrder?: readonly string[],
  traceId?: string,
): Promise<PostItem> {
  const post = await requirePostOwner(postId);
  const current = post.attachments.map((a) => a.id);
  if (expectedOrder !== undefined) {
    const stale =
      expectedOrder.length !== current.length ||
      expectedOrder.some((id, index) => id !== current[index]);
    if (stale) {
      diag("posts.images.reorder_conflict", { postId }, { traceId });
      throw new ApiError(
        "The photos changed since you last loaded them. Reload and try again.",
        409,
      );
    }
  }
  const currentSet = new Set(current);
  if (
    orderedAttachmentIds.length !== current.length ||
    new Set(orderedAttachmentIds).size !== current.length ||
    orderedAttachmentIds.some((id) => !currentSet.has(id))
  ) {
    throw new ApiError("The new photo order must list each photo exactly once", 400);
  }
  for (let index = 0; index < orderedAttachmentIds.length; index += 1) {
    const { error } = await getSupabase()
      .from("attachments")
      .update({ display_order: index + 1 })
      .eq("id", orderedAttachmentIds[index]!);
    if (error) throw new ApiError(error.message, error.code === "42501" ? 403 : 400);
  }
  diag("posts.images.reorder_success", { postId, photoCount: current.length }, { traceId });
  return fetchPost(postId);
}

/** Owner-only photo rename (display filename). Same RLS live-note as reorder. */
export async function renamePostImage(
  postId: string,
  attachmentId: string,
  fileName: string,
  traceId?: string,
): Promise<PostItem> {
  const post = await requirePostOwner(postId);
  if (!post.attachments.some((a) => a.id === attachmentId)) {
    throw new ApiError("That photo is not part of this report", 404);
  }
  const trimmed = fileName.trim().slice(0, 120);
  if (!trimmed) throw new ApiError("Enter a file name", 400);
  const { error } = await getSupabase()
    .from("attachments")
    .update({ file_name: trimmed })
    .eq("id", attachmentId);
  if (error) throw new ApiError(error.message, error.code === "42501" ? 403 : 400);
  diag("posts.images.rename_success", { postId, attachmentId }, { traceId });
  return fetchPost(postId);
}

function storageKeyFromFileUrl(fileUrl: string): string {
  // Derive `<userId>/<object>` without network: the public URL is always
  // `<supabaseUrl>/storage/v1/object/public/<bucket>/<key>`.
  const prefix = getSupabase().storage.from(IMAGES_BUCKET).getPublicUrl("").data.publicUrl;
  if (!fileUrl.startsWith(prefix) || fileUrl.length === prefix.length) {
    throw new ApiError(
      "Could not locate that photo's stored bytes, so it was left untouched",
      400,
    );
  }
  return fileUrl.slice(prefix.length);
}

/**
 * Owner-only photo removal: deletes the attachment row, then removes the
 * exact Storage object (byte cleanup), then compacts the remaining
 * `display_order` values 1..n best-effort. A row-delete failure throws before
 * any bytes move; a Storage failure after the row delete throws an honest
 * error (orphaned bytes may need manual cleanup) instead of pretending.
 * Same RLS live-note as reorder.
 */
export async function removePostImage(
  postId: string,
  attachmentId: string,
  traceId?: string,
): Promise<PostItem> {
  const post = await requirePostOwner(postId);
  const target = post.attachments.find((a) => a.id === attachmentId);
  if (!target) throw new ApiError("That photo is not part of this report", 404);
  const objectKey = storageKeyFromFileUrl(target.fileUrl);
  const { error: deleteError } = await getSupabase()
    .from("attachments")
    .delete()
    .eq("id", attachmentId);
  if (deleteError) {
    throw new ApiError(deleteError.message, deleteError.code === "42501" ? 403 : 400);
  }
  const { error: bytesError } = await getSupabase().storage.from(IMAGES_BUCKET).remove([objectKey]);
  if (bytesError) {
    diag("posts.images.remove_bytes_failed", {
      postId,
      attachmentId,
      objectKey,
      message: bytesError.message,
    }, { traceId });
    throw new ApiError(
      `The photo entry was removed but its stored bytes could not be deleted (${bytesError.message}). ` +
        "They may need manual cleanup.",
      502,
    );
  }
  const remaining = post.attachments.map((a) => a.id).filter((id) => id !== attachmentId);
  for (let index = 0; index < remaining.length; index += 1) {
    const { error } = await getSupabase()
      .from("attachments")
      .update({ display_order: index + 1 })
      .eq("id", remaining[index]!);
    if (error) {
      diag("posts.images.compact_failed", {
        postId,
        attachmentId: remaining[index],
        message: error.message,
      }, { traceId });
      break;
    }
  }
  diag("posts.images.remove_success", { postId, attachmentId, objectKey }, { traceId });
  return fetchPost(postId);
}
