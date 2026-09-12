import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { DbAdapter, Row, SqlValue } from "./types.js";

/**
 * Local development schema (SQLite dialect). Mirrors
 * `supabase/migrations/20260912000000_init.sql`; keep the two in sync when
 * columns change. SQLite stays the default provider until the Supabase
 * migration is applied and verified.
 */
export const SQLITE_SCHEMA = `
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

export class SqliteAdapter implements DbAdapter {
  readonly dialect = "sqlite" as const;
  private db: DatabaseSync | null = null;
  private readonly inMemory: boolean;

  constructor(private readonly file: string) {
    this.inMemory = file === ":memory:";
  }

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    if (!this.inMemory) fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SQLITE_SCHEMA);
    this.db = db;
    return db;
  }

  // node:sqlite is synchronous; these async signatures satisfy DbAdapter.
  async init(): Promise<void> {
    this.handle();
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.handle().prepare(sql).run(...(params as SqlValue[]));
  }

  async runResult(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = this.handle().prepare(sql).run(...(params as SqlValue[]));
    return { changes: Number(res.changes) };
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.handle().prepare(sql).get(...(params as SqlValue[])) as T | undefined;
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.handle().prepare(sql).all(...(params as SqlValue[])) as T[];
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      this.db = null;
    }
  }

  async reset(): Promise<void> {
    await this.close();
    if (!this.inMemory) {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(`${this.file}${suffix}`)) fs.rmSync(`${this.file}${suffix}`);
      }
    }
    this.handle();
  }
}
