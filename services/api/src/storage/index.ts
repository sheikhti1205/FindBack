import { config } from "../config.js";
import { LocalStorageProvider } from "./localStorageProvider.js";
import { createSupabaseStorageProvider } from "./supabaseStorageClient.js";
import type { StorageProvider } from "./storageProvider.js";

export {
  LocalStorageProvider,
} from "./localStorageProvider.js";
export {
  FINDBACK_IMAGES_BUCKET,
  SupabaseStorageProvider,
  type SupabaseStorageOperations,
} from "./supabaseStorageProvider.js";
export {
  createSupabaseStorageClient,
  createSupabaseStorageOperations,
  createSupabaseStorageProvider,
} from "./supabaseStorageClient.js";
export {
  sanitizeFileName,
  type StorageProvider,
  type StorageSaveContext,
  type StoredObject,
  type StoredUpload,
} from "./storageProvider.js";
export { normalizeImage, type NormalizedImage } from "./imageNormalizer.js";

let provider: StorageProvider | null = null;

/**
 * Pure storage-provider selection, mirroring `selectAuthProvider`:
 *
 * - `sqlite` (tests + local demo) → `LocalStorageProvider`
 * - `supabase` (real application) → `SupabaseStorageProvider`
 *
 * `config.dbProvider` is pinned to `sqlite` under `NODE_ENV=test`, so the test
 * suite can never reach live Supabase Storage even with `DB_PROVIDER=supabase`.
 */
export function selectStorageProvider(
  dbProvider: "sqlite" | "supabase",
  createSupabase: () => StorageProvider = createSupabaseStorageProvider,
): StorageProvider {
  return dbProvider === "supabase" ? createSupabase() : new LocalStorageProvider();
}

/**
 * The active storage provider, selected once. If Supabase is selected without
 * the required configuration, `createSupabaseStorageProvider()` throws a clear
 * error — there is intentionally no silent fallback to local disk.
 */
export function getStorageProvider(): StorageProvider {
  if (!provider) provider = selectStorageProvider(config.dbProvider);
  return provider;
}

/** Test hook: override the singleton provider (or reset with `null`). */
export function setStorageProviderForTests(next: StorageProvider | null): void {
  provider = next;
}
