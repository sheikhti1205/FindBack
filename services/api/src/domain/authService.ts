import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { loginSchema, registerSchema, usernameSchema } from "@findback/shared";
import { config } from "../config.js";
import { getStore } from "../db/index.js";
import { AppError, newId, nowIso, toPublicUser } from "./helpers.js";

/**
 * Local auth implementation: bcrypt passwords, locally signed JWTs, and the
 * profile lookups (`me`, `checkUsername`) the domain needs.
 *
 * Auth routes and middleware consume this through the `AuthProvider` seam
 * (`LocalAuthProvider`), not directly; a `SupabaseAuthProvider` can replace it
 * in a later block without touching those consumers.
 */
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
  const row = await getStore().findUserIdByField(safeField, value);
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
  await getStore().insertUser({
    id,
    username: parsed.username,
    email: parsed.email,
    phone: parsed.phone,
    password_hash: passwordHash,
    created_at: now,
    updated_at: now,
  });
  const row = await getStore().findUserById(id);
  return { token: signToken(id), user: toPublicUser(row!) };
}

export async function login(input: z.infer<typeof loginSchema>): Promise<AuthToken> {
  const parsed = loginSchema.parse(input);
  const row = await getStore().findUserByIdentifier(parsed.identifier);
  if (!row) throw new AppError(401, "Invalid credentials");
  const ok = await verifyPassword(parsed.password, String(row.password_hash));
  if (!ok) throw new AppError(401, "Invalid credentials");
  return { token: signToken(String(row.id)), user: toPublicUser(row) };
}

export async function checkUsername(
  username: string,
): Promise<{ available: boolean; normalized: string }> {
  const parsed = usernameSchema.parse(username);
  const normalized = parsed.trim();
  const row = await getStore().findUserIdByField("username", normalized);
  return { available: !row, normalized };
}

export async function me(userId: string): Promise<ReturnType<typeof toPublicUser>> {
  const row = await getStore().findUserById(userId);
  if (!row) throw new AppError(404, "User not found");
  return toPublicUser(row);
}

/** List of one-line usernames used by the seeded demo users. */
export async function listUserIds(): Promise<string[]> {
  return getStore().listUserIds();
}
