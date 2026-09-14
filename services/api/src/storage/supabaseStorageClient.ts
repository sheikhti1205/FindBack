import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import {
  FINDBACK_IMAGES_BUCKET,
  SupabaseStorageProvider,
  type SupabaseStorageOperations,
} from "./supabaseStorageProvider.js";

const STATELESS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

/**
 * Backend-only Supabase client for Storage. Uses the secret key, which must
 * never reach the mobile app or any `VITE_` variable.
 */
export function createSupabaseStorageClient(): SupabaseClient {
  if (!config.supabaseUrl) throw new Error("Supabase Storage requires SUPABASE_URL");
  if (!config.supabaseSecretKey) {
    throw new Error("Supabase Storage requires SUPABASE_SECRET_KEY");
  }
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { ...STATELESS },
  });
}

/** Adapt the SDK's storage client to the provider's narrow operations interface. */
export function createSupabaseStorageOperations(
  client: SupabaseClient,
  bucket: string = FINDBACK_IMAGES_BUCKET,
): SupabaseStorageOperations {
  return {
    async upload(path, buffer, options) {
      const { error } = await client.storage
        .from(bucket)
        .upload(path, buffer, { contentType: options.contentType, upsert: options.upsert });
      return { errorMessage: error?.message ?? null };
    },
    async remove(paths) {
      const { error } = await client.storage.from(bucket).remove(paths);
      return { errorMessage: error?.message ?? null };
    },
    getPublicUrl(path) {
      return client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    },
  };
}

export function createSupabaseStorageProvider(): SupabaseStorageProvider {
  const client = createSupabaseStorageClient();
  return new SupabaseStorageProvider(
    createSupabaseStorageOperations(client, FINDBACK_IMAGES_BUCKET),
  );
}
