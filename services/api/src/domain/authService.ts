import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { loginSchema, registerSchema, usernameSchema } from "@findback/shared";
import { config } from "../config.js";
import { all, get, run } from "../db/db.js";
import { AppError, newId, nowIso, toPublicUser } from "./helpers.js";
import type { Row } from "../db/db.js";

export interface AuthToken {
  token: string;
  user: ReturnType<typeof toPublicUser>;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

/** Decode + verify a JWT; returns the user id or throws. */
export function verifyToken(token: string): { userId: string } {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    const sub = payload?.sub;
    if (typeof sub !== "string" || !sub) throw new AppError(401, "Invalid token");
    return { userId: sub };
  } catch {
    throw new AppError(401, "Invalid or expired token");
  }
}

async function assertUnique(field: string, value: string): Promise<void> {
  const safeField = field === "email" ? "email" : field === "phone" ? "phone" : "username";
  const row = get<Row>(`SELECT id FROM users WHERE lower(${safeField}) = lower(?)`, [value]);
  if (row) {
    throw new AppError(409, `${field} "${value}" is already registered`);
  }
}

export async function register(input: z.infer<typeof registerSchema>): Promise<AuthToken> {
  const parsed = registerSchema.parse(input);
  await assertUnique("username", parsed.username);
  await assertUnique("email", parsed.email);
  await assertUnique("phone", parsed.phone);

  const id = newId();
  const now = nowIso();
  const passwordHash = await hashPassword(parsed.password);
  run(
    `INSERT INTO users (id, username, email, phone, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, parsed.username, parsed.email, parsed.phone, passwordHash, now, now],
  );
  const row = get<Row>("SELECT * FROM users WHERE id = ?", [id])!;
  return { token: signToken(id), user: toPublicUser(row) };
}

export function login(input: z.infer<typeof loginSchema>): Promise<AuthToken> {
  const parsed = loginSchema.parse(input);
  const row = get<Row>(
    "SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)",
    [parsed.identifier, parsed.identifier],
  );
  if (!row) throw new AppError(401, "Invalid credentials");
  return verifyPassword(parsed.password, String(row.password_hash)).then((ok) => {
    if (!ok) throw new AppError(401, "Invalid credentials");
    return { token: signToken(String(row.id)), user: toPublicUser(row) };
  });
}

export async function checkUsername(username: string): Promise<{ available: boolean; normalized: string }> {
  const parsed = usernameSchema.parse(username);
  const normalized = parsed.trim();
  const row = get<Row>("SELECT id FROM users WHERE lower(username) = lower(?)", [normalized]);
  return { available: !row, normalized };
}

export function me(userId: string): ReturnType<typeof toPublicUser> {
  const row = get<Row>("SELECT * FROM users WHERE id = ?", [userId]);
  if (!row) throw new AppError(404, "User not found");
  return toPublicUser(row);
}

/** List of one-line usernames used by the seeded demo users. */
export function listUserIds(): string[] {
  return all<Row>("SELECT id FROM users").map((r) => String(r.id));
}
