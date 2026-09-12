import {
  type Category,
  type FeedPage,
  type PostItem,
  type PostStatus,
  type PostType,
  type UpdatePostInput,
} from "@findback/shared";
import { createPostSchema, feedQuerySchema } from "@findback/shared";
import { all, get, run } from "../db/index.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import { getUpload } from "./storageService.js";
import type { Row } from "../db/index.js";

export interface PostRow extends Row {
  id: string;
  user_id: string;
}

const POST_SELECT = `
  SELECT p.*,
         u.username AS author_username, u.email AS author_email, u.phone AS author_phone,
         u.email_verified AS author_email_verified, u.phone_verified AS author_phone_verified,
         u.avatar_url AS author_avatar_url, u.created_at AS author_created_at,
         (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.type = 'LIKE') AS like_count,
         (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id AND r.type = 'DISLIKE') AS dislike_count,
         (SELECT AVG(score) FROM ratings ra WHERE ra.post_id = p.id) AS rating_avg,
         (SELECT COUNT(*) FROM ratings ra WHERE ra.post_id = p.id) AS rating_count,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
  FROM item_posts p
  JOIN users u ON u.id = p.user_id
`;

export function rowToPost(row: Row): PostItem {
  const author = {
    id: String(row.user_id),
    username: String(row.author_username),
    email: String(row.author_email),
    phone: String(row.author_phone),
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
    attachments: [],
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
  const files = await all<Row>(
    "SELECT * FROM attachments WHERE post_id = ? ORDER BY created_at ASC",
    [post.id],
  );
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
  const row = await get<PostRow>("SELECT * FROM item_posts WHERE id = ?", [id]);
  if (!row) throw new AppError(404, "Post not found");
  return row;
}

export async function getPost(id: string, _viewerId?: string): Promise<PostItem> {
  const row = await get<Row>(`${POST_SELECT} WHERE p.id = ?`, [id]);
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
  await run(
    `INSERT INTO item_posts
       (id, user_id, type, title, description, category, status, event_date,
        latitude, longitude, location_label, youtube_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      input.type,
      input.title.trim(),
      input.description.trim(),
      input.category,
      input.eventDate,
      input.latitude ?? null,
      input.longitude ?? null,
      input.locationLabel?.trim() || null,
      youtubeUrl,
      now,
      now,
    ],
  );

  if (input.attachmentKey) {
    const upload = await getUpload(input.attachmentKey);
    if (!upload) throw new AppError(400, "Attachment key does not exist");
    if (String(upload.user_id) !== userId) {
      throw new AppError(403, "Attachment was not uploaded by you");
    }
    await run(
      `INSERT INTO attachments (id, post_id, file_url, mime_type, file_name, file_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        id,
        String(upload.file_url),
        String(upload.mime_type),
        String(upload.file_name),
        Number(upload.file_size),
        now,
      ],
    );
  }

  emitGateway("feed:changed", { postId: id });
  return getPost(id, userId);
}

export async function updatePost(userId: string, postId: string, raw: unknown): Promise<PostItem> {
  const post = await ensurePostExists(postId);
  if (String(post.user_id) !== userId) throw new AppError(403, "You can only edit your own posts");
  const patch = raw as UpdatePostInput;
  const sets: string[] = [];
  const params: unknown[] = [];
  const fields: (keyof UpdatePostInput)[] = [
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
  for (const field of fields) {
    if (patch[field] !== undefined) {
      const column =
        field === "eventDate" ? "event_date" : field === "locationLabel" ? "location_label" : field === "youtubeUrl" ? "youtube_url" : field;
      sets.push(`${column} = ?`);
      const value = patch[field];
      params.push(value === null || value === undefined ? null : typeof value === "number" ? value : String(value));
    }
  }
  if (sets.length === 0) return getPost(postId, userId);
  sets.push("updated_at = ?");
  params.push(nowIso(), postId);
  await run(`UPDATE item_posts SET ${sets.join(", ")} WHERE id = ?`, params);
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
  await run("UPDATE item_posts SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), postId]);
  emitGateway("post:updated", { postId });
  return getPost(postId, userId);
}

export async function deletePost(userId: string, postId: string): Promise<void> {
  const post = await ensurePostExists(postId);
  if (String(post.user_id) !== userId) throw new AppError(403, "Only the owner can delete a post");
  await run("DELETE FROM item_posts WHERE id = ?", [postId]);
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
  const where: string[] = [];
  const params: unknown[] = [];

  if (q.type) {
    where.push("p.type = ?");
    params.push(q.type);
  }
  if (q.category) {
    where.push("p.category = ?");
    params.push(q.category);
  }
  if (q.status) {
    where.push("p.status = ?");
    params.push(q.status);
  }
  if (q.q) {
    where.push("(lower(p.title) LIKE ? OR lower(p.description) LIKE ?)");
    const like = `%${q.q.toLowerCase()}%`;
    params.push(like, like);
  }
  if (q.dateFrom) {
    where.push("p.event_date >= ?");
    params.push(q.dateFrom);
  }
  if (q.dateTo) {
    where.push("p.event_date <= ?");
    params.push(q.dateTo);
  }

  const cursor = decodeCursor(q.cursor);
  const cmp = q.sort === "oldest" ? ">" : "<";
  const altCmp = q.sort === "oldest" ? ">" : "<";
  if (cursor) {
    where.push(`(p.created_at ${cmp} ? OR (p.created_at = ? AND p.id ${altCmp} ?))`);
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const order = q.sort === "oldest" ? "ASC" : "DESC";

  const limit = Math.min(q.limit ?? 10, 20);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await get<Row>(`SELECT COUNT(*) AS c FROM item_posts p ${whereSql}`, params);
  const total = Number(totalRow?.c ?? 0);

  const rows = await all<Row>(
    `${POST_SELECT} ${whereSql} ORDER BY p.created_at ${order}, p.id ${order} LIMIT ?`,
    [...params, limit + 1],
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
  return { items, nextCursor, total };
}

export async function myPosts(userId: string, rawQuery: unknown): Promise<FeedPage> {
  const q = feedQuerySchema.parse(rawQuery);
  const where = ["p.user_id = ?"];
  const params: unknown[] = [userId];
  const cursor = decodeCursor(q.cursor);
  const order = "DESC";
  if (cursor) {
    where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const limit = Math.min(q.limit ?? 10, 20);
  const rows = await all<Row>(
    `${POST_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.created_at ${order}, p.id ${order} LIMIT ?`,
    [...params, limit + 1],
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
