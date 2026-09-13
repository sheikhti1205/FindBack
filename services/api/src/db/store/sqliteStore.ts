import type { DbAdapter, Row, SqlValue } from "../types.js";
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

const COMMENT_SELECT = `
  SELECT c.*, u.username AS author_username, u.email AS author_email,
         u.phone AS author_phone, u.email_verified AS author_email_verified,
         u.phone_verified AS author_phone_verified,
         u.avatar_url AS author_avatar_url, u.created_at AS author_created_at
  FROM comments c JOIN users u ON u.id = c.user_id
`;

/**
 * SQLite-backed Store. Powers the automated test suite and local demo; the real
 * application uses `SupabaseStore` against the Supabase Data API.
 */
export class SqliteStore implements Store {
  readonly provider = "sqlite" as const;

  constructor(private readonly adapter: DbAdapter) {}

  async init(): Promise<void> {
    await this.adapter.init();
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }

  async ping(): Promise<void> {
    await this.adapter.get("SELECT 1 AS ok");
  }

  // ---- users ----
  findUserById(id: string): Promise<Row | undefined> {
    return this.adapter.get<Row>("SELECT * FROM users WHERE id = ?", [id]);
  }

  findUserIdByField(
    field: "username" | "email" | "phone",
    value: string,
  ): Promise<Row | undefined> {
    const safeField = field === "email" ? "email" : field === "phone" ? "phone" : "username";
    return this.adapter.get<Row>(`SELECT id FROM users WHERE lower(${safeField}) = lower(?)`, [
      value,
    ]);
  }

  findUserByIdentifier(identifier: string): Promise<Row | undefined> {
    return this.adapter.get<Row>(
      "SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)",
      [identifier, identifier],
    );
  }

  async insertUser(row: UserInsert): Promise<void> {
    // The local SQLite schema requires a bcrypt hash (`password_hash TEXT NOT
    // NULL`). Only the Supabase Auth provider inserts null, and it never uses
    // this store; fail clearly here instead of surfacing an opaque constraint
    // error if that ever changes.
    if (row.password_hash == null) {
      throw new Error(
        "SqliteStore.insertUser: password_hash is required for local/SQLite auth",
      );
    }
    await this.adapter.run(
      `INSERT INTO users (id, username, email, phone, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.username,
        row.email,
        row.phone,
        row.password_hash,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  async listUserIds(): Promise<string[]> {
    const rows = await this.adapter.all<Row>("SELECT id FROM users");
    return rows.map((r) => String(r.id));
  }

  async setUserVerified(userId: string, field: "email_verified" | "phone_verified"): Promise<void> {
    await this.adapter.run(`UPDATE users SET ${field} = 1, updated_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      userId,
    ]);
  }

  // ---- posts ----
  findPostById(id: string): Promise<Row | undefined> {
    return this.adapter.get<Row>("SELECT * FROM item_posts WHERE id = ?", [id]);
  }

  getPostDetail(id: string): Promise<Row | undefined> {
    return this.adapter.get<Row>(`${POST_SELECT} WHERE p.id = ?`, [id]);
  }

  private buildPostWhere(filter: PostFilter): { whereSql: string; params: unknown[]; order: string } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId) {
      where.push("p.user_id = ?");
      params.push(filter.userId);
    }
    if (filter.type) {
      where.push("p.type = ?");
      params.push(filter.type);
    }
    if (filter.category) {
      where.push("p.category = ?");
      params.push(filter.category);
    }
    if (filter.status) {
      where.push("p.status = ?");
      params.push(filter.status);
    }
    if (filter.q) {
      where.push("(lower(p.title) LIKE ? OR lower(p.description) LIKE ?)");
      const like = `%${filter.q.toLowerCase()}%`;
      params.push(like, like);
    }
    if (filter.dateFrom) {
      where.push("p.event_date >= ?");
      params.push(filter.dateFrom);
    }
    if (filter.dateTo) {
      where.push("p.event_date <= ?");
      params.push(filter.dateTo);
    }
    const order = filter.order === "asc" ? "ASC" : "DESC";
    const cmp = filter.order === "asc" ? ">" : "<";
    if (filter.cursor) {
      where.push(`(p.created_at ${cmp} ? OR (p.created_at = ? AND p.id ${cmp} ?))`);
      params.push(filter.cursor.createdAt, filter.cursor.createdAt, filter.cursor.id);
    }
    return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params, order };
  }

  queryPosts(filter: PostFilter, limit: number): Promise<Row[]> {
    const { whereSql, params, order } = this.buildPostWhere(filter);
    return this.adapter.all<Row>(
      `${POST_SELECT} ${whereSql} ORDER BY p.created_at ${order}, p.id ${order} LIMIT ?`,
      [...params, limit],
    );
  }

  async countPosts(filter: PostFilter): Promise<number> {
    const { whereSql, params } = this.buildPostWhere(filter);
    const row = await this.adapter.get<Row>(`SELECT COUNT(*) AS c FROM item_posts p ${whereSql}`, params);
    return Number(row?.c ?? 0);
  }

  async insertPost(row: PostInsert): Promise<void> {
    await this.adapter.run(
      `INSERT INTO item_posts
         (id, user_id, type, title, description, category, status, event_date,
          latitude, longitude, location_label, youtube_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.user_id,
        row.type,
        row.title,
        row.description,
        row.category,
        row.status,
        row.event_date,
        row.latitude,
        row.longitude,
        row.location_label,
        row.youtube_url,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  async updatePostFields(id: string, fields: Record<string, SqlValue>): Promise<void> {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const sets = entries.map(([column]) => `${column} = ?`);
    const params = entries.map(([, value]) => value);
    await this.adapter.run(`UPDATE item_posts SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }

  async deletePost(id: string): Promise<void> {
    await this.adapter.run("DELETE FROM item_posts WHERE id = ?", [id]);
  }

  listAttachments(postId: string): Promise<Row[]> {
    return this.adapter.all<Row>(
      "SELECT * FROM attachments WHERE post_id = ? ORDER BY created_at ASC",
      [postId],
    );
  }

  async insertAttachment(row: AttachmentInsert): Promise<void> {
    await this.adapter.run(
      `INSERT INTO attachments (id, post_id, file_url, mime_type, file_name, file_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.post_id, row.file_url, row.mime_type, row.file_name, row.file_size, row.created_at],
    );
  }

  // ---- comments ----
  listComments(postId: string, limit: number): Promise<Row[]> {
    return this.adapter.all<Row>(
      `${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT ?`,
      [postId, limit],
    );
  }

  findCommentWithAuthor(id: string): Promise<Row | undefined> {
    return this.adapter.get<Row>(`${COMMENT_SELECT} WHERE c.id = ?`, [id]);
  }

  findComment(id: string, postId: string): Promise<Row | undefined> {
    return this.adapter.get<Row>("SELECT * FROM comments WHERE id = ? AND post_id = ?", [
      id,
      postId,
    ]);
  }

  async getPostOwnerId(postId: string): Promise<string | null> {
    const row = await this.adapter.get<Row>("SELECT user_id FROM item_posts WHERE id = ?", [postId]);
    return row ? String(row.user_id) : null;
  }

  async insertComment(row: CommentInsert): Promise<void> {
    await this.adapter.run(
      `INSERT INTO comments (id, post_id, user_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.post_id, row.user_id, row.body, row.created_at, row.updated_at],
    );
  }

  async deleteComment(id: string): Promise<void> {
    await this.adapter.run("DELETE FROM comments WHERE id = ?", [id]);
  }

  // ---- reactions ----
  async countReactions(postId: string, type: "LIKE" | "DISLIKE"): Promise<number> {
    const row = await this.adapter.get<Row>(
      "SELECT COUNT(*) AS c FROM reactions WHERE post_id = ? AND type = ?",
      [postId, type],
    );
    return Number(row?.c ?? 0);
  }

  findReaction(postId: string, userId: string): Promise<Row | undefined> {
    return this.adapter.get<Row>("SELECT type FROM reactions WHERE post_id = ? AND user_id = ?", [
      postId,
      userId,
    ]);
  }

  async deleteReaction(postId: string, userId: string): Promise<void> {
    await this.adapter.run("DELETE FROM reactions WHERE post_id = ? AND user_id = ?", [
      postId,
      userId,
    ]);
  }

  async upsertReaction(row: ReactionUpsert): Promise<void> {
    await this.adapter.run(
      `INSERT INTO reactions (id, post_id, user_id, type, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(post_id, user_id) DO UPDATE SET type = excluded.type`,
      [row.id, row.post_id, row.user_id, row.type, row.created_at],
    );
  }

  async ratingStats(postId: string): Promise<RatingStats> {
    const row = await this.adapter.get<Row>(
      "SELECT AVG(score) AS avg, COUNT(*) AS cnt FROM ratings WHERE post_id = ?",
      [postId],
    );
    return {
      avg: row?.avg == null ? null : Math.round(Number(row.avg) * 100) / 100,
      count: Number(row?.cnt ?? 0),
    };
  }

  // ---- ratings ----
  findRating(postId: string, userId: string): Promise<Row | undefined> {
    return this.adapter.get<Row>("SELECT id, score FROM ratings WHERE post_id = ? AND user_id = ?", [
      postId,
      userId,
    ]);
  }

  async updateRatingScore(id: string, score: number, updatedAt: string): Promise<void> {
    await this.adapter.run("UPDATE ratings SET score = ?, updated_at = ? WHERE id = ?", [
      score,
      updatedAt,
      id,
    ]);
  }

  async insertRating(row: RatingInsert): Promise<void> {
    await this.adapter.run(
      `INSERT INTO ratings (id, post_id, user_id, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.post_id, row.user_id, row.score, row.created_at, row.updated_at],
    );
  }

  // ---- verification ----
  findLatestPendingChallenge(
    userId: string,
    channel: "EMAIL" | "PHONE",
  ): Promise<Row | undefined> {
    return this.adapter.get<Row>(
      `SELECT * FROM verification_challenges
       WHERE user_id = ? AND channel = ? AND verified_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId, channel],
    );
  }

  async insertChallenge(row: ChallengeInsert): Promise<void> {
    await this.adapter.run(
      `INSERT INTO verification_challenges (id, user_id, channel, code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.channel, row.code_hash, row.expires_at, row.created_at],
    );
  }

  async markChallengeVerified(id: string, verifiedAt: string): Promise<void> {
    await this.adapter.run("UPDATE verification_challenges SET verified_at = ? WHERE id = ?", [
      verifiedAt,
      id,
    ]);
  }

  // ---- uploads ----
  async insertUpload(row: UploadInsert): Promise<void> {
    await this.adapter.run(
      `INSERT INTO uploads (id, user_id, file_name, mime_type, file_size, file_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.file_name, row.mime_type, row.file_size, row.file_url, row.created_at],
    );
  }

  findUploadById(id: string): Promise<Row | undefined> {
    return this.adapter.get<Row>("SELECT * FROM uploads WHERE id = ?", [id]);
  }

  // ---- reporting ----
  private async countWhere(table: string, where: string, params: unknown[] = []): Promise<number> {
    const row = await this.adapter.get<Row>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
    return Number(row?.n ?? 0);
  }

  async reportSummary(_days: number): Promise<ReportSummary> {
    const avgRow = await this.adapter.get<Row>("SELECT AVG(score) AS avg FROM ratings");
    return {
      totalPosts: await this.countWhere("item_posts", "1=1"),
      openPosts: await this.countWhere("item_posts", "status='OPEN'"),
      recoveredPosts: await this.countWhere("item_posts", "status='RECOVERED'"),
      matchedPosts: await this.countWhere("item_posts", "status='MATCHED'"),
      closedPosts: await this.countWhere("item_posts", "status='CLOSED'"),
      lostPosts: await this.countWhere("item_posts", "type='LOST'"),
      foundPosts: await this.countWhere("item_posts", "type='FOUND'"),
      totalUsers: await this.countWhere("users", "1=1"),
      totalComments: await this.countWhere("comments", "1=1"),
      totalReactions: await this.countWhere("reactions", "1=1"),
      totalRatings: await this.countWhere("ratings", "1=1"),
      averageRating: avgRow?.avg == null ? null : Number(avgRow.avg),
      postsLast7Days: await this.countWhere("item_posts", "created_at >= ?", [
        new Date(Date.now() - 7 * 86_400_000).toISOString(),
      ]),
    };
  }

  async activityByDay(sinceDay: string): Promise<DayBucket[]> {
    return this.adapter.all<DayBucket>(
      `
    WITH RECURSIVE days(d) AS (
      SELECT date('${sinceDay}')
      UNION ALL
      SELECT date(d, '+1 day') FROM days WHERE d < date('now')
    )
    SELECT d AS date,
           (SELECT COUNT(*) FROM item_posts WHERE date(created_at) = d) AS posts,
           (SELECT COUNT(*) FROM comments  WHERE date(created_at) = d) AS comments,
           (SELECT COUNT(*) FROM users     WHERE date(created_at) = d) AS newUsers
    FROM days`,
    );
  }

  async groupPostCount(field: "type" | "status" | "category"): Promise<GroupCount[]> {
    const column = field === "type" ? "type" : field === "status" ? "status" : "category";
    return this.adapter.all<GroupCount>(
      `SELECT ${column} AS value, COUNT(*) AS count FROM item_posts GROUP BY ${column} ORDER BY count DESC`,
    );
  }

  topContributors(limit: number): Promise<Contributor[]> {
    return this.adapter.all<Contributor>(
      `
    SELECT u.username,
           COUNT(DISTINCT p.id) AS posts,
           COUNT(DISTINCT c.id) AS comments
    FROM users u
    LEFT JOIN item_posts p ON p.user_id = u.id
    LEFT JOIN comments  c ON c.user_id = u.id
    GROUP BY u.id, u.username
    ORDER BY (posts + comments) DESC, posts DESC
    LIMIT ?`,
      [limit],
    );
  }
}
