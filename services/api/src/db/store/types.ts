import type { Row, SqlValue } from "../types.js";

/**
 * Typed persistence contract used by the domain services.
 *
 * Implementations:
 *  - `SqliteStore`   — issues SQL against a `DbAdapter` (tests + local dev).
 *  - `SupabaseStore` — uses the Supabase Data API (@supabase/supabase-js).
 *
 * Business logic (validation, authorization, realtime events, response
 * shaping) stays in the domain services; only data access lives here.
 */
export type StoreProvider = "sqlite" | "supabase";

export interface UserInsert {
  id: string;
  username: string;
  email: string;
  phone: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface PostInsert {
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
}

export interface AttachmentInsert {
  id: string;
  post_id: string;
  file_url: string;
  mime_type: string;
  file_name: string;
  file_size: number;
  created_at: string;
}

export interface CommentInsert {
  id: string;
  post_id: string;
  user_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface ReactionUpsert {
  id: string;
  post_id: string;
  user_id: string;
  type: "LIKE" | "DISLIKE";
  created_at: string;
}

export interface RatingInsert {
  id: string;
  post_id: string;
  user_id: string;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface ChallengeInsert {
  id: string;
  user_id: string;
  channel: "EMAIL" | "PHONE";
  code_hash: string;
  expires_at: string;
  created_at: string;
}

export interface UploadInsert {
  id: string;
  user_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  file_url: string;
  created_at: string;
}

/** Filters mirrored 1:1 from the public feed query options. */
export interface PostFilter {
  userId?: string;
  type?: string;
  category?: string;
  status?: string;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  cursor?: { createdAt: string; id: string } | null;
  order: "asc" | "desc";
}

export interface RatingStats {
  avg: number | null;
  count: number;
}

export interface DayBucket {
  date: string;
  posts: number;
  comments: number;
  newUsers: number;
}

export interface GroupCount {
  value: string;
  count: number;
}

export interface Contributor {
  username: string;
  posts: number;
  comments: number;
}

export interface ReportSummary {
  totalPosts: number;
  openPosts: number;
  recoveredPosts: number;
  matchedPosts: number;
  closedPosts: number;
  lostPosts: number;
  foundPosts: number;
  totalUsers: number;
  totalComments: number;
  totalReactions: number;
  totalRatings: number;
  averageRating: number | null;
  postsLast7Days: number;
}

export interface Store {
  readonly provider: StoreProvider;

  /** Verify configuration and that the backend is reachable. */
  init(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<void>;

  // ---- users ----
  findUserById(id: string): Promise<Row | undefined>;
  findUserIdByField(
    field: "username" | "email" | "phone",
    value: string,
  ): Promise<Row | undefined>;
  findUserByIdentifier(identifier: string): Promise<Row | undefined>;
  insertUser(row: UserInsert): Promise<void>;
  listUserIds(): Promise<string[]>;
  setUserVerified(userId: string, field: "email_verified" | "phone_verified"): Promise<void>;

  // ---- posts ----
  findPostById(id: string): Promise<Row | undefined>;
  getPostDetail(id: string): Promise<Row | undefined>;
  queryPosts(filter: PostFilter, limit: number): Promise<Row[]>;
  countPosts(filter: PostFilter): Promise<number>;
  insertPost(row: PostInsert): Promise<void>;
  updatePostFields(id: string, fields: Record<string, SqlValue>): Promise<void>;
  deletePost(id: string): Promise<void>;
  listAttachments(postId: string): Promise<Row[]>;
  insertAttachment(row: AttachmentInsert): Promise<void>;

  // ---- comments ----
  listComments(postId: string, limit: number): Promise<Row[]>;
  findCommentWithAuthor(id: string): Promise<Row | undefined>;
  findComment(id: string, postId: string): Promise<Row | undefined>;
  getPostOwnerId(postId: string): Promise<string | null>;
  insertComment(row: CommentInsert): Promise<void>;
  deleteComment(id: string): Promise<void>;

  // ---- reactions ----
  countReactions(postId: string, type: "LIKE" | "DISLIKE"): Promise<number>;
  findReaction(postId: string, userId: string): Promise<Row | undefined>;
  deleteReaction(postId: string, userId: string): Promise<void>;
  upsertReaction(row: ReactionUpsert): Promise<void>;
  ratingStats(postId: string): Promise<RatingStats>;

  // ---- ratings ----
  findRating(postId: string, userId: string): Promise<Row | undefined>;
  updateRatingScore(id: string, score: number, updatedAt: string): Promise<void>;
  insertRating(row: RatingInsert): Promise<void>;

  // ---- verification ----
  findLatestPendingChallenge(
    userId: string,
    channel: "EMAIL" | "PHONE",
  ): Promise<Row | undefined>;
  insertChallenge(row: ChallengeInsert): Promise<void>;
  markChallengeVerified(id: string, verifiedAt: string): Promise<void>;

  // ---- uploads ----
  insertUpload(row: UploadInsert): Promise<void>;
  findUploadById(id: string): Promise<Row | undefined>;

  // ---- reporting ----
  reportSummary(days: number): Promise<ReportSummary>;
  activityByDay(sinceDay: string): Promise<DayBucket[]>;
  groupPostCount(field: "type" | "status" | "category"): Promise<GroupCount[]>;
  topContributors(limit: number): Promise<Contributor[]>;
}
