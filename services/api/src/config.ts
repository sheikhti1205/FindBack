import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package root of services/api — correct both when running from src/ (tsx)
 * and from dist/ (compiled node start).
 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Monorepo root (services/api -> repo root). There is exactly ONE environment
 * file, `<repo>/.env`, resolved relative to this module so it loads no matter
 * what process.cwd() is (repo root, services/api, or a deploy runner).
 *
 * dotenv never overrides variables already present in the real process
 * environment, so platform-injected config wins. A missing file is fine —
 * production can supply the variables directly.
 */
const rootEnvPath = path.resolve(packageRoot, "..", "..", ".env");
dotenv.config({ path: rootEnvPath, quiet: true });

/**
 * Persistence backend. `sqlite` is the safe default used by the automated test
 * harness and local demo; the real application sets DB_PROVIDER=supabase.
 * Tests are pinned to SQLite so they can never accidentally reach the live
 * Supabase project even if DB_PROVIDER is set in the environment.
 */
const dbProvider: "sqlite" | "supabase" =
  process.env.NODE_ENV === "test" || process.env.DB_PROVIDER !== "supabase"
    ? "sqlite"
    : "supabase";

export const config = {
  packageRoot,
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  /** Dev-only default; always set a real secret for anything non-local. */
  jwtSecret: process.env.JWT_SECRET ?? "findback-dev-only-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  /** True outside production: dev verification adapter echoes codes back. */
  devMode: process.env.NODE_ENV !== "production",
  /** In tests each worker gets its own in-memory database (no shared file). */
  dbFile:
    process.env.NODE_ENV === "test"
      ? ":memory:"
      : process.env.DB_FILE ??
        path.resolve(packageRoot, "data", "findback.db"),
  /**
   * Selects the persistence backend (see `dbProvider` above). `sqlite` powers
   * the tests and local demo; `supabase` is the real application backend.
   */
  dbProvider,
  /**
   * Supabase project URL. Used by the Data API Store (server-side only).
   */
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  /**
   * Supabase backend secret key (service role). Server-side only: it bypasses
   * RLS and must NEVER be exposed to apps/mobile or any VITE_ variable.
   */
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? "",
  /**
   * Supabase publishable (anon) key. Server-side only in FindBack: the Node API
   * performs user Auth operations with it and validates JWTs via JWKS. It must
   * never reach the mobile app or any VITE_ variable.
   */
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  uploadsDir: process.env.UPLOADS_DIR ?? path.resolve(packageRoot, "uploads"),
  /** Public base URL the mobile/web app uses to reach this API. */
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}`,
  /** Optional directory of built web assets to serve at "/" (single-container demo). */
  staticWebDir: process.env.STATIC_WEB_DIR ?? "",
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "deepseek-chat",
  },
} as const;
