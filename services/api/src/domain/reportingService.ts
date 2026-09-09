import { all, get } from "../db/db.js";
import { AppError } from "./helpers.js";

export interface ActivityReport {
  generatedAt: string;
  summary: {
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
  };
  byDay: { date: string; posts: number; comments: number; newUsers: number }[];
  byType: { type: string; count: number }[];
  byStatus: { status: string; count: number }[];
  byCategory: { category: string; count: number }[];
  topContributors: { username: string; posts: number; comments: number }[];
}

function clampDays(value: unknown, fallback = 14): number {
  const n = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

export function activityReport(rawDays?: unknown): ActivityReport {
  const days = clampDays(rawDays);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const summary = {
    totalPosts: countWhere("item_posts", "1=1"),
    openPosts: countWhere("item_posts", "status='OPEN'"),
    recoveredPosts: countWhere("item_posts", "status='RECOVERED'"),
    matchedPosts: countWhere("item_posts", "status='MATCHED'"),
    closedPosts: countWhere("item_posts", "status='CLOSED'"),
    lostPosts: countWhere("item_posts", "type='LOST'"),
    foundPosts: countWhere("item_posts", "type='FOUND'"),
    totalUsers: countWhere("users", "1=1"),
    totalComments: countWhere("comments", "1=1"),
    totalReactions: countWhere("reactions", "1=1"),
    totalRatings: countWhere("ratings", "1=1"),
    averageRating: get<{ avg: number | null }>(
      "SELECT AVG(score) AS avg FROM ratings",
    )?.avg ?? null,
    postsLast7Days: countWhere("item_posts", "created_at >= ?", [
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
    ]),
  };

  // Bucket timestamps by UTC day; SQLite date() understands ISO-8601.
  const sinceDay = since.slice(0, 10);
  const byDay = all<{ date: string; posts: number; comments: number; newUsers: number }>(
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

  const byType = all<{ type: string; count: number }>(
    `SELECT type, COUNT(*) AS count FROM item_posts GROUP BY type ORDER BY count DESC`,
  );
  const byStatus = all<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM item_posts GROUP BY status ORDER BY count DESC`,
  );
  const byCategory = all<{ category: string; count: number }>(
    `SELECT category, COUNT(*) AS count FROM item_posts GROUP BY category ORDER BY count DESC`,
  );
  const topContributors = all<{ username: string; posts: number; comments: number }>(
    `
    SELECT u.username,
           COUNT(DISTINCT p.id) AS posts,
           COUNT(DISTINCT c.id) AS comments
    FROM users u
    LEFT JOIN item_posts p ON p.user_id = u.id
    LEFT JOIN comments  c ON c.user_id = u.id
    GROUP BY u.id, u.username
    ORDER BY (posts + comments) DESC, posts DESC
    LIMIT 8`,
  );

  return {
    generatedAt: new Date().toISOString(),
    summary: { ...summary, averageRating: round(summary.averageRating) },
    byDay,
    byType,
    byStatus,
    byCategory,
    topContributors,
  };
}

function countWhere(table: string, where: string, params: unknown[] = []): number {
  const row = get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(row?.n ?? 0);
}

function round(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

export function reportToCsv(report: ActivityReport): string {
  const lines: string[] = [];
  lines.push(["metric", "value"].join(","));
  for (const [k, v] of Object.entries(report.summary)) {
    lines.push([k, String(v)].join(","));
  }
  lines.push("");
  lines.push(["date", "posts", "comments", "newUsers"].join(","));
  for (const row of report.byDay) {
    lines.push([row.date, row.posts, row.comments, row.newUsers].join(","));
  }
  lines.push("");
  lines.push(["type", "count"].join(","));
  for (const row of report.byType) lines.push([row.type, row.count].join(","));
  lines.push("");
  lines.push(["status", "count"].join(","));
  for (const row of report.byStatus) lines.push([row.status, row.count].join(","));
  lines.push("");
  lines.push(["category", "count"].join(","));
  for (const row of report.byCategory) lines.push([csv(row.category), row.count].join(","));
  lines.push("");
  lines.push(["username", "posts", "comments"].join(","));
  for (const row of report.topContributors) lines.push([csv(row.username), row.posts, row.comments].join(","));
  return lines.join("\r\n");
}

function csv(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function requireAuthed(userId: string | undefined): void {
  if (!userId) throw new AppError(401, "Authentication required");
}
