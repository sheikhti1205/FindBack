import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('LOST','FOUND')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','MATCHED','RECOVERED','CLOSED')),
  event_date TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  location_label TEXT,
  youtube_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES item_posts(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES item_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES item_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('LIKE','DISLIKE')),
  created_at TEXT NOT NULL,
  UNIQUE (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES item_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS verification_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL','PHONE')),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_type_created ON item_posts(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_category ON item_posts(category);
CREATE INDEX IF NOT EXISTS idx_posts_user ON item_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_challenges_user_channel ON verification_challenges(user_id, channel);
`;

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* already closed */
    }
    _db = null;
  }
}

export type Row = Record<string, unknown>;

/** Values node:sqlite accepts as bound parameters. */
export type SqlValue = string | number | bigint | Uint8Array | null;

export function run(sql: string, params: unknown[] = []): void {
  getDb().prepare(sql).run(...(params as SqlValue[]));
}

export function runResult(sql: string, params: unknown[] = []): { changes: number | bigint } {
  const res = getDb().prepare(sql).run(...(params as SqlValue[]));
  return { changes: res.changes };
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return getDb().prepare(sql).get(...(params as SqlValue[])) as T | undefined;
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(...(params as SqlValue[])) as T[];
}

/** Rebuild the DB (used by tests). */
export function resetDb(): void {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(`${config.dbFile}${suffix}`)) fs.rmSync(`${config.dbFile}${suffix}`);
  }
  _db = null;
  getDb();
}
