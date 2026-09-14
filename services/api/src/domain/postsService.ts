import {
  type Category,
  type FeedPage,
  type PostItem,
  type PostStatus,
  type PostType,
  type UpdatePostInput,
} from "@findback/shared";
import { createPostSchema, feedQuerySchema } from "@findback/shared";
import { getStore } from "../db/index.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import { getUpload } from "./storageService.js";
import type { Row, SqlValue } from "../db/index.js";

export interface PostRow extends Row {
  id: string;
  user_id: string;
}

/** Map attachments already embedded by a feed RPC row, if present. */
function mapAttachments(value: unknown): PostItem["attachments"] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const a = raw as Row;
    return {
      id: String(a.id),
      postId: String(a.post_id),
      fileUrl: String(a.file_url),
      mimeType: String(a.mime_type),
      fileName: String(a.file_name),
      fileSize: Number(a.file_size),
      createdAt: String(a.created_at),
    };
  });
}

export function rowToPost(row: Row): PostItem {
  const author = {
    id: String(row.user_id),
    username: String(row.author_username),
    emailVerified: Boolean(row.author_email_verified),
    phoneVerified: Boolean(row.author_phone_verified),
    avatarUrl: row.author_avatar_url ? String(row.author_avatar_url) : null,
    createdAt: String(row.author_created_at),
  };
  const post: PostItem = {
    id: String(row.id),
    userId: String(row.user_id),
    author,
    type: String(row.type) as PostType,
    title: String(row.title),
    description: String(row.description),
    category: String(row.category) as Category,
    status: String(row.status) as PostStatus,
    eventDate: String(row.event_date),
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    locationLabel: row.location_label ? String(row.location_label) : null,
    youtubeUrl: row.youtube_url ? String(row.youtube_url) : null,
    attachments: mapAttachments(row.attachments),
    likeCount: Number(row.like_count ?? 0),
    dislikeCount: Number(row.dislike_count ?? 0),
    ratingAvg: row.rating_avg == null ? null : Math.round(Number(row.rating_avg) * 100) / 100,
    ratingCount: Number(row.rating_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  return post;
}

async function attachFiles(post: PostItem): Promise<void> {
  // Feed RPC rows already carry attachments; avoid a per-post round trip.
  if (post.attachments.length > 0) return;
  const files = await getStore().listAttachments(post.id);
  post.attachments = files.map((f) => ({
    id: String(f.id),
    postId: String(f.post_id),
    fileUrl: String(f.file_url),
    mimeType: String(f.mime_type),
    fileName: String(f.file_name),
    fileSize: Number(f.file_size),
    createdAt: String(f.created_at),
  }));
}

export async function ensurePostExists(id: string): Promise<PostRow> {
  const row = await getStore().findPostById(id);
  if (!row) throw new AppError(404, "Post not found");
  return row as PostRow;
}

export async function getPost(id: string, _viewerId?: string): Promise<PostItem> {
  const row = await getStore().getPostDetail(id);
  if (!row) throw new AppError(404, "Post not found");
  const post = rowToPost(row);
  await attachFiles(post);
  return post;
}

export async function createPost(userId: string, raw: unknown): Promise<PostItem> {
  const input = createPostSchema.parse(raw);
  const id = newId();
  const now = nowIso();
  const youtubeUrl = input.youtubeUrl ? input.youtubeUrl : null;
  await getStore().insertPost({
    id,
    user_id: userId,
    type: input.type,
    title: input.title.trim(),
    description: input.description.trim(),
    category: input.category,
    status: "OPEN",
    event_date: input.eventDate,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    location_label: input.locationLabel?.trim() || null,
    youtube_url: youtubeUrl,
    created_at: now,
    updated_at: now,
  });

  if (input.attachmentKey) {
    const upload = await getUpload(input.attachmentKey);
    if (!upload) throw new AppError(400, "Attachment key does not exist");
    if (String(upload.user_id) !== userId) {
      throw new AppError(403, "Attachment was not uploaded by you");
    }
    await getStore().insertAttachment({
      id: newId(),
      post_id: id,
      file_url: String(upload.file_url),
      mime_type: String(upload.mime_type),
      file_name: String(upload.file_name),
      file_size: Number(upload.file_size),
      created_at: now,
    });
  }

  emitGateway("feed:changed", { postId: id });
  return getPost(id, userId);
}

export async function updatePost(userId: string, postId: string, raw: unknown): Promise<PostItem> {
  const post = await ensurePostExists(postId);
  if (String(post.user_id) !== userId) throw new AppError(403, "You can only edit your own posts");
  const patch = raw as UpdatePostInput;
  const fields: Record<string, SqlValue> = {};
  const mapping: (keyof UpdatePostInput)[] = [
    "type",
    "title",
    "description",
    "category",
    "eventDate",
    "latitude",
    "longitude",
    "locationLabel",
    "youtubeUrl",
  ];
  for (const field of mapping) {
    if (patch[field] !== undefined) {
      const column =
        field === "eventDate" ? "event_date" : field === "locationLabel" ? "location_label" : field === "youtubeUrl" ? "youtube_url" : field;
      const value = patch[field];
      fields[column] = value === null || value === undefined ? null : typeof value === "number" ? value : String(value);
    }
  }
  if (Object.keys(fields).length === 0) return getPost(postId, userId);
  fields.updated_at = nowIso();
  await getStore().updatePostFields(postId, fields);
  emitGateway("post:updated", { postId });
  return getPost(postId, userId);
}

export async function changePostStatus(
  userId: string,
  postId: string,
  status: PostStatus,
): Promise<PostItem> {
  const post = await ensurePostExists(postId);
  if (String(post.user_id) !== userId) {
    throw new AppError(403, "Only the owner can change the status");
  }
  await getStore().updatePostFields(postId, { status, updated_at: nowIso() });
  emitGateway("post:updated", { postId });
  return getPost(postId, userId);
}

export async function deletePost(userId: string, postId: string): Promise<void> {
  const post = await ensurePostExists(postId);
  if (String(post.user_id) !== userId) throw new AppError(403, "Only the owner can delete a post");
  await getStore().deletePost(postId);
  emitGateway("post:deleted", { postId });
}

export interface FeedOptions {
  type?: PostType;
  category?: Category;
  status?: PostStatus;
  q?: string;
  cursor?: string;
  limit?: number;
  sort?: "newest" | "oldest";
}

function decodeCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof createdAt === "string" && typeof id === "string") return { createdAt, id };
  } catch {
    return null;
  }
  return null;
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

/** Keyspace cursor pagination over item_posts with search + filters. */
export async function feed(rawQuery: unknown, _viewerId?: string): Promise<FeedPage> {
  const q = feedQuerySchema.parse(rawQuery);
  const order = q.sort === "oldest" ? "asc" : "desc";
  const limit = Math.min(q.limit ?? 10, 20);
  const filter = {
    type: q.type,
    category: q.category,
    status: q.status,
    q: q.q,
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    cursor: decodeCursor(q.cursor),
    order,
  } as const;

  const total = await getStore().countPosts(filter);
  const rows = await getStore().queryPosts(filter, limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await Promise.all(
    pageRows.map(async (row) => {
      const post = rowToPost(row);
      await attachFiles(post);
      return post;
    }),
  );

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(String(last.created_at), String(last.id)) : null;
  return { items, nextCursor, total };
}

export async function myPosts(userId: string, rawQuery: unknown): Promise<FeedPage> {
  const q = feedQuerySchema.parse(rawQuery);
  const limit = Math.min(q.limit ?? 10, 20);
  const rows = await getStore().queryPosts(
    {
      userId,
      cursor: decodeCursor(q.cursor),
      order: "desc",
    },
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await Promise.all(
    pageRows.map(async (row) => {
      const post = rowToPost(row);
      await attachFiles(post);
      return post;
    }),
  );
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(String(last.created_at), String(last.id)) : null;
  return { items, nextCursor, total: items.length };
}
