import { randomUUID } from "node:crypto";
import type { PublicUser } from "@findback/shared";
import type { Row } from "../db/db.js";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Keep fields a client is allowed to see on a user row. */
export function toPublicUser(row: Row): PublicUser {
  return {
    id: String(row.id),
    username: String(row.username),
    email: String(row.email),
    phone: String(row.phone),
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified),
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    createdAt: String(row.created_at),
  };
}

/** Wrap an unexpected internal error with an HTTP-ish code + message. */
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** SQL-friendly ISO-8601 date (yyyy-mm-dd) stored as TEXT. */
export function isoDate(d: string): string {
  return d.slice(0, 10);
}
