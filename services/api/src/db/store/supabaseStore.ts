import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Row, SqlValue } from "../types.js";
import type {
  AttachmentInsert,
  ChallengeInsert,
  CommentInsert,
  Contributor,
  DayBucket,
  GroupCount,
  PostFilter,
  PostInsert,
  RatingInsert,
  RatingStats,
  ReactionUpsert,
  ReportSummary,
  Store,
  UploadInsert,
  UserInsert,
} from "./types.js";

const AUTHOR_COLUMNS = "username, email, phone, email_verified, phone_verified, avatar_url, created_at";

interface EmbeddedAuthor {
  username?: unknown;
  email?: unknown;
  phone?: unknown;
  email_verified?: unknown;
  phone_verified?: unknown;
  avatar_url?: unknown;
  created_at?: unknown;
}

function fail(context: string, error: { message: string }): never {
  throw new Error(`SupabaseStore ${context}: ${error.message}`);
}

/**
 * Escape SQL LIKE metacharacters so `ilike` behaves as case-insensitive
 * equality (`_` and `%` must be literal, not wildcards).
 */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

/** Flatten PostgREST's embedded `author` object into the flat SQL column aliases. */
function flattenAuthor(row: Row): Row {
  const author = row.author as EmbeddedAuthor | undefined;
  if (author) {
    row.author_username = author.username;
    row.author_email = author.email;
    row.author_phone = author.phone;
    row.author_email_verified = author.email_verified;
    row.author_phone_verified = author.phone_verified;
    row.author_avatar_url = author.avatar_url ?? null;
    row.author_created_at = author.created_at;
  }
  return row;
}

/**
 * Supabase Data API (PostgREST) backed Store.
 *
 * Uses the backend-only secret key, which must never reach the mobile app or
 * any `VITE_` variable. Feed/report aggregates require SQL RPCs and are
 * deliberately unsupported here for now.
 */
export class SupabaseStore implements Store {
  readonly provider = "supabase" as const;
  private readonly client: SupabaseClient;

  constructor(url: string, secretKey: string) {
    if (!url) throw new Error("SupabaseStore requires SUPABASE_URL");
    if (!secretKey) throw new Error("SupabaseStore requires SUPABASE_SECRET_KEY");
    this.client = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  async init(): Promise<void> {
    await this.ping();
  }

  async close(): Promise<void> {
    // The Data API client is stateless over HTTP; nothing to release.
  }

  async ping(): Promise<void> {
    const { error } = await this.client.from("users").select("id", { head: true }).limit(1);
    if (error) throw new Error(`Supabase Data API unreachable: ${error.message}`);
  }

  // ---- users ----
  async findUserById(id: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("findUserById", error);
    return (data as Row | null) ?? undefined;
  }

  async findUserIdByField(
    field: "username" | "email" | "phone",
    value: string,
  ): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("users")
      .select("id")
      .ilike(field, escapeLike(value))
      .limit(1)
      .maybeSingle();
    if (error) fail("findUserIdByField", error);
    return (data as Row | null) ?? undefined;
  }

  async findUserByIdentifier(identifier: string): Promise<Row | undefined> {
    const pattern = escapeLike(identifier);
    const byUsername = await this.client
      .from("users")
      .select("*")
      .ilike("username", pattern)
      .limit(1)
      .maybeSingle();
    if (byUsername.error) fail("findUserByIdentifier", byUsername.error);
    if (byUsername.data) return byUsername.data as Row;
    const byEmail = await this.client
      .from("users")
      .select("*")
      .ilike("email", pattern)
      .limit(1)
      .maybeSingle();
    if (byEmail.error) fail("findUserByIdentifier", byEmail.error);
    return (byEmail.data as Row | null) ?? undefined;
  }

  async insertUser(row: UserInsert): Promise<void> {
    const { error } = await this.client.from("users").insert(row);
    if (error) fail("insertUser", error);
  }

  async listUserIds(): Promise<string[]> {
    const { data, error } = await this.client.from("users").select("id");
    if (error) fail("listUserIds", error);
    return (data ?? []).map((r) => String((r as Row).id));
  }

  async setUserVerified(userId: string, field: "email_verified" | "phone_verified"): Promise<void> {
    const { error } = await this.client
      .from("users")
      .update({ [field]: 1, updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (error) fail("setUserVerified", error);
  }

  // ---- posts ----
  async findPostById(id: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("item_posts")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("findPostById", error);
    return (data as Row | null) ?? undefined;
  }

  async getPostDetail(id: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("item_posts")
      .select(`*, author:users(${AUTHOR_COLUMNS})`)
      .eq("id", id)
      .maybeSingle();
    if (error) fail("getPostDetail", error);
    if (!data) return undefined;
    const row = flattenAuthor(data as Row);
    const [likeCount, dislikeCount, commentCount, stats] = await Promise.all([
      this.countReactions(id, "LIKE"),
      this.countReactions(id, "DISLIKE"),
      this.countRows("comments", "post_id", id),
      this.computeRatingStats(id),
    ]);
    row.like_count = likeCount;
    row.dislike_count = dislikeCount;
    row.comment_count = commentCount;
    row.rating_avg = stats.avg;
    row.rating_count = stats.count;
    return row;
  }

  private feedArgs(filter: PostFilter, limit: number): Record<string, unknown> {
    return {
      p_user_id: filter.userId ?? null,
      p_type: filter.type ?? null,
      p_category: filter.category ?? null,
      p_status: filter.status ?? null,
      p_q: filter.q ?? null,
      p_date_from: filter.dateFrom ?? null,
      p_date_to: filter.dateTo ?? null,
      p_cursor_created_at: filter.cursor?.createdAt ?? null,
      p_cursor_id: filter.cursor?.id ?? null,
      p_order: filter.order,
      p_limit: limit,
    };
  }

  async queryPosts(filter: PostFilter, limit: number): Promise<Row[]> {
    const { data, error } = await this.client.rpc(
      "findback_query_posts",
      this.feedArgs(filter, limit),
    );
    if (error) fail("queryPosts", error);
    return (data ?? []) as Row[];
  }

  async countPosts(filter: PostFilter): Promise<number> {
    // Same RPC, one row requested: `total_count` is a window count over the
    // fully filtered set, so no separate count query/RPC is needed.
    const { data, error } = await this.client.rpc("findback_query_posts", this.feedArgs(filter, 1));
    if (error) fail("countPosts", error);
    const rows = (data ?? []) as Row[];
    return rows.length ? Number(rows[0]!.total_count ?? 0) : 0;
  }

  async insertPost(row: PostInsert): Promise<void> {
    const { error } = await this.client.from("item_posts").insert(row);
    if (error) fail("insertPost", error);
  }

  async updatePostFields(id: string, fields: Record<string, SqlValue>): Promise<void> {
    const { error } = await this.client.from("item_posts").update(fields).eq("id", id);
    if (error) fail("updatePostFields", error);
  }

  async deletePost(id: string): Promise<void> {
    const { error } = await this.client.from("item_posts").delete().eq("id", id);
    if (error) fail("deletePost", error);
  }

  async listAttachments(postId: string): Promise<Row[]> {
    const { data, error } = await this.client
      .from("attachments")
      .select("*")
      .eq("post_id", postId)
      .order("created_at", { ascending: true });
    if (error) fail("listAttachments", error);
    return (data ?? []) as Row[];
  }

  async insertAttachment(row: AttachmentInsert): Promise<void> {
    const { error } = await this.client.from("attachments").insert(row);
    if (error) fail("insertAttachment", error);
  }

  // ---- comments ----
  async listComments(postId: string, limit: number): Promise<Row[]> {
    const { data, error } = await this.client
      .from("comments")
      .select(`*, author:users(${AUTHOR_COLUMNS})`)
      .eq("post_id", postId)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) fail("listComments", error);
    return (data ?? []).map((r) => flattenAuthor(r as Row));
  }

  async findCommentWithAuthor(id: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("comments")
      .select(`*, author:users(${AUTHOR_COLUMNS})`)
      .eq("id", id)
      .maybeSingle();
    if (error) fail("findCommentWithAuthor", error);
    return data ? flattenAuthor(data as Row) : undefined;
  }

  async findComment(id: string, postId: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("comments")
      .select("*")
      .eq("id", id)
      .eq("post_id", postId)
      .maybeSingle();
    if (error) fail("findComment", error);
    return (data as Row | null) ?? undefined;
  }

  async getPostOwnerId(postId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("item_posts")
      .select("user_id")
      .eq("id", postId)
      .maybeSingle();
    if (error) fail("getPostOwnerId", error);
    return data ? String((data as Row).user_id) : null;
  }

  async insertComment(row: CommentInsert): Promise<void> {
    const { error } = await this.client.from("comments").insert(row);
    if (error) fail("insertComment", error);
  }

  async deleteComment(id: string): Promise<void> {
    const { error } = await this.client.from("comments").delete().eq("id", id);
    if (error) fail("deleteComment", error);
  }

  // ---- reactions ----
  async countReactions(postId: string, type: "LIKE" | "DISLIKE"): Promise<number> {
    const { count, error } = await this.client
      .from("reactions")
      .select("*", { count: "exact", head: true })
      .eq("post_id", postId)
      .eq("type", type);
    if (error) fail("countReactions", error);
    return count ?? 0;
  }

  async findReaction(postId: string, userId: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("reactions")
      .select("type")
      .eq("post_id", postId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("findReaction", error);
    return (data as Row | null) ?? undefined;
  }

  async deleteReaction(postId: string, userId: string): Promise<void> {
    const { error } = await this.client
      .from("reactions")
      .delete()
      .eq("post_id", postId)
      .eq("user_id", userId);
    if (error) fail("deleteReaction", error);
  }

  /**
   * One reaction per (post_id, user_id). Mirrors the SQL
   * `ON CONFLICT (post_id, user_id) DO UPDATE SET type = excluded.type`:
   * an existing row keeps its id/created_at and only `type` changes.
   */
  async upsertReaction(row: ReactionUpsert): Promise<void> {
    const { data, error } = await this.client
      .from("reactions")
      .update({ type: row.type })
      .eq("post_id", row.post_id)
      .eq("user_id", row.user_id)
      .select("id");
    if (error) fail("upsertReaction", error);
    if (data && data.length > 0) return;
    const { error: insertError } = await this.client.from("reactions").insert(row);
    if (insertError) fail("upsertReaction", insertError);
  }

  private async computeRatingStats(postId: string): Promise<RatingStats> {
    const { data, error } = await this.client
      .from("ratings")
      .select("score")
      .eq("post_id", postId);
    if (error) fail("ratingStats", error);
    const scores = (data ?? []).map((r) => Number((r as Row).score));
    if (scores.length === 0) return { avg: null, count: 0 };
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { avg: Math.round(avg * 100) / 100, count: scores.length };
  }

  async ratingStats(postId: string): Promise<RatingStats> {
    return this.computeRatingStats(postId);
  }

  // ---- ratings ----
  async findRating(postId: string, userId: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("ratings")
      .select("id, score")
      .eq("post_id", postId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("findRating", error);
    return (data as Row | null) ?? undefined;
  }

  async updateRatingScore(id: string, score: number, updatedAt: string): Promise<void> {
    const { error } = await this.client
      .from("ratings")
      .update({ score, updated_at: updatedAt })
      .eq("id", id);
    if (error) fail("updateRatingScore", error);
  }

  async insertRating(row: RatingInsert): Promise<void> {
    const { error } = await this.client.from("ratings").insert(row);
    if (error) fail("insertRating", error);
  }

  // ---- verification ----
  async findLatestPendingChallenge(
    userId: string,
    channel: "EMAIL" | "PHONE",
  ): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("verification_challenges")
      .select("*")
      .eq("user_id", userId)
      .eq("channel", channel)
      .is("verified_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail("findLatestPendingChallenge", error);
    return (data as Row | null) ?? undefined;
  }

  async insertChallenge(row: ChallengeInsert): Promise<void> {
    const { error } = await this.client.from("verification_challenges").insert(row);
    if (error) fail("insertChallenge", error);
  }

  async markChallengeVerified(id: string, verifiedAt: string): Promise<void> {
    const { error } = await this.client
      .from("verification_challenges")
      .update({ verified_at: verifiedAt })
      .eq("id", id);
    if (error) fail("markChallengeVerified", error);
  }

  // ---- uploads ----
  async insertUpload(row: UploadInsert): Promise<void> {
    const { error } = await this.client.from("uploads").insert(row);
    if (error) fail("insertUpload", error);
  }

  async findUploadById(id: string): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("uploads")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("findUploadById", error);
    return (data as Row | null) ?? undefined;
  }

  // ---- reporting (single findback_report RPC bundle) ----
  private async fetchReport(days: number, topLimit = 8): Promise<Record<string, unknown>> {
    const { data, error } = await this.client.rpc("findback_report", {
      p_days: days,
      p_top_limit: topLimit,
    });
    if (error) fail("findback_report", error);
    return (data ?? {}) as Record<string, unknown>;
  }

  private daysFromSinceDay(sinceDay: string): number {
    const since = Date.parse(`${sinceDay}T00:00:00.000Z`);
    if (!Number.isFinite(since)) return 14;
    const days = Math.floor((Date.now() - since) / 86_400_000);
    return Math.min(90, Math.max(1, days));
  }

  async reportSummary(days: number): Promise<ReportSummary> {
    const report = await this.fetchReport(days);
    const s = (report.summary ?? {}) as Record<string, unknown>;
    return {
      totalPosts: Number(s.totalPosts ?? 0),
      openPosts: Number(s.openPosts ?? 0),
      recoveredPosts: Number(s.recoveredPosts ?? 0),
      matchedPosts: Number(s.matchedPosts ?? 0),
      closedPosts: Number(s.closedPosts ?? 0),
      lostPosts: Number(s.lostPosts ?? 0),
      foundPosts: Number(s.foundPosts ?? 0),
      totalUsers: Number(s.totalUsers ?? 0),
      totalComments: Number(s.totalComments ?? 0),
      totalReactions: Number(s.totalReactions ?? 0),
      totalRatings: Number(s.totalRatings ?? 0),
      averageRating: s.averageRating == null ? null : Number(s.averageRating),
      postsLast7Days: Number(s.postsLast7Days ?? 0),
    };
  }

  async activityByDay(sinceDay: string): Promise<DayBucket[]> {
    const report = await this.fetchReport(this.daysFromSinceDay(sinceDay));
    const rows = Array.isArray(report.byDay) ? (report.byDay as Row[]) : [];
    return rows.map((r) => ({
      date: String(r.date),
      posts: Number(r.posts ?? 0),
      comments: Number(r.comments ?? 0),
      newUsers: Number(r.newUsers ?? 0),
    }));
  }

  async groupPostCount(field: "type" | "status" | "category"): Promise<GroupCount[]> {
    const report = await this.fetchReport(14);
    const key = field === "type" ? "byType" : field === "status" ? "byStatus" : "byCategory";
    const rows = Array.isArray(report[key]) ? (report[key] as Row[]) : [];
    return rows.map((r) => ({ value: String(r.value), count: Number(r.count ?? 0) }));
  }

  async topContributors(limit: number): Promise<Contributor[]> {
    const report = await this.fetchReport(14, limit);
    const rows = Array.isArray(report.topContributors) ? (report.topContributors as Row[]) : [];
    return rows.map((r) => ({
      username: String(r.username),
      posts: Number(r.posts ?? 0),
      comments: Number(r.comments ?? 0),
    }));
  }

  private async countRows(table: string, column: string, value: string): Promise<number> {
    const { count, error } = await this.client
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(column, value);
    if (error) fail(`countRows(${table})`, error);
    return count ?? 0;
  }
}
