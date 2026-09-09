import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package root of services/api — correct both when running from src/ (tsx)
 * and from dist/ (compiled node start).
 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  uploadsDir: process.env.UPLOADS_DIR ?? path.resolve(packageRoot, "uploads"),
  /** Public base URL the mobile/web app uses to reach this API. */
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}`,
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "deepseek-chat",
  },
} as const;
