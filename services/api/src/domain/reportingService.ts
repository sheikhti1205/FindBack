import { getStore } from "../db/index.js";
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

export async function activityReport(rawDays?: unknown): Promise<ActivityReport> {
  const days = clampDays(rawDays);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const sinceDay = since.slice(0, 10);

  const store = getStore();
  const summary = await store.reportSummary(days);
  const byDay = (await store.activityByDay(sinceDay)).map((r) => ({
    date: String(r.date),
    posts: Number(r.posts),
    comments: Number(r.comments),
    newUsers: Number(r.newUsers),
  }));
  const byType = (await store.groupPostCount("type")).map((r) => ({
    type: String(r.value),
    count: Number(r.count),
  }));
  const byStatus = (await store.groupPostCount("status")).map((r) => ({
    status: String(r.value),
    count: Number(r.count),
  }));
  const byCategory = (await store.groupPostCount("category")).map((r) => ({
    category: String(r.value),
    count: Number(r.count),
  }));
  const topContributors = (await store.topContributors(8)).map((r) => ({
    username: String(r.username),
    posts: Number(r.posts),
    comments: Number(r.comments),
  }));

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
