import request from "supertest";
import { createApp } from "../app.js";
import { get, all } from "../db/index.js";
import type { Row } from "../db/index.js";

export const app = createApp();

let counter = 0;

export interface TestAgent {
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
    phone: string;
    emailVerified: boolean;
    phoneVerified: boolean;
  };
}

const NUMERIC = "0123456789";

function randomPhone(): string {
  const mid = String(3 + Math.floor(Math.random() * 7)); // 3..9
  let tail = "";
  for (let i = 0; i < 8; i++) tail += NUMERIC[Math.floor(Math.random() * NUMERIC.length)];
  return `01${mid}${tail}`; // 018xxxxxxxx shape
}

/** Register a fresh user via the REST API and return auth + user. */
export async function registerAgent(prefix = "testuser"): Promise<TestAgent> {
  counter += 1;
  const suffix = `${Date.now().toString(36)}${counter}`;
  const payload = {
    username: `${prefix}_${suffix}`.slice(0, 20),
    email: `${prefix}${suffix}@example.com`,
    phone: randomPhone(),
    password: "password123",
  };
  const res = await request(app).post("/auth/register").send(payload).expect(201);
  return {
    token: res.body.token as string,
    user: res.body.user as TestAgent["user"],
  };
}

export async function loginAs(identifier: string): Promise<string> {
  const res = await request(app)
    .post("/auth/login")
    .send({ identifier, password: "password123" })
    .expect(200);
  return res.body.token as string;
}

export async function seedUser(identifier: string): Promise<{ id: string }> {
  const row = await get<Row>(
    "SELECT id FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)",
    [identifier, identifier],
  );
  if (!row) throw new Error(`seed user ${identifier} not found`);
  return { id: String(row.id) };
}

export async function seededPostId(): Promise<string> {
  const row = await get<Row>("SELECT id FROM item_posts ORDER BY created_at ASC LIMIT 1");
  if (!row) throw new Error("no seeded posts");
  return String(row.id);
}

export async function countRows(
  table: string,
  where = "",
  params: unknown[] = [],
): Promise<number> {
  const sql = `SELECT COUNT(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ""}`;
  const row = await get<Row>(sql, params);
  return Number(row?.c ?? 0);
}

export { get, all };
export type { Row };
