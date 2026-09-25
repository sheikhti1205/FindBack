import type { Category, PostType } from "@findback/shared";
import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { diag } from "./diag";

export interface CreatePostInput {
  type: PostType;
  title: string;
  description: string;
  category: Category;
  eventDate: string;
  locationLabel?: string;
  latitude?: number | null;
  longitude?: number | null;
  youtubeUrl?: string;
  attachmentKey?: string;
}

/** Ordered staging-upload ids for the versioned multi-image RPC (0–5). */
export interface CreatePostMultiInput extends Omit<CreatePostInput, "attachmentKey"> {
  attachmentKeys?: string[];
}

/** Mirrors the DB contract (`findback_create_post_client_multi`: at most 5 keys). */
export const MAX_ATTACHMENT_KEYS = 5;

export async function createPost(input: CreatePostInput, traceId?: string): Promise<string> {
  const start = Date.now();
  const { data, error } = await getSupabase().rpc("findback_create_post_client", {
    p_type: input.type,
    p_title: input.title,
    p_description: input.description,
    p_category: input.category,
    p_event_date: input.eventDate,
    p_latitude: input.latitude ?? null,
    p_longitude: input.longitude ?? null,
    p_location_label: input.locationLabel ?? null,
    p_youtube_url: input.youtubeUrl ?? null,
    p_attachment_key: input.attachmentKey ?? null,
  });
  const ms = Date.now() - start;
  if (error) {
    diag("posts.create.rpc.error", {
      rpc: "findback_create_post_client",
      code: error.code,
      message: error.message,
      ms,
    }, { traceId });
    throw new ApiError(error.message, error.code === "42501" ? 403 : 400);
  }
  diag("posts.create.rpc.success", {
    rpc: "findback_create_post_client",
    ms,
    hasAttachmentKey: !!input.attachmentKey,
  }, { traceId });
  return String(data);
}

/**
 * Create a post with 0–5 ordered attachments via the versioned multi-key RPC.
 * The old single-key `createPost` is unchanged for legacy readers/clients.
 * Client-side guards (count, duplicates, blanks) mirror the RPC so doomed
 * publishes fail before any upload bytes move.
 */
export async function createPostMulti(input: CreatePostMultiInput, traceId?: string): Promise<string> {
  const keys = input.attachmentKeys ?? [];
  if (keys.length > MAX_ATTACHMENT_KEYS) {
    throw new ApiError(`At most ${MAX_ATTACHMENT_KEYS} attachments are allowed`, 400);
  }
  if (new Set(keys).size !== keys.length) {
    throw new ApiError("Duplicate attachment keys are not allowed", 400);
  }
  if (keys.some((key) => !key || key.trim() === "")) {
    throw new ApiError("Attachment key must not be empty", 400);
  }
  const start = Date.now();
  const { data, error } = await getSupabase().rpc("findback_create_post_client_multi", {
    p_type: input.type,
    p_title: input.title,
    p_description: input.description,
    p_category: input.category,
    p_event_date: input.eventDate,
    p_attachment_keys: keys,
    p_latitude: input.latitude ?? null,
    p_longitude: input.longitude ?? null,
    p_location_label: input.locationLabel ?? null,
    p_youtube_url: input.youtubeUrl ?? null,
  });
  const ms = Date.now() - start;
  if (error) {
    diag("posts.create.rpc.error", {
      rpc: "findback_create_post_client_multi",
      code: error.code,
      message: error.message,
      ms,
    }, { traceId });
    throw new ApiError(error.message, error.code === "42501" ? 403 : 400);
  }
  diag("posts.create.rpc.success", {
    rpc: "findback_create_post_client_multi",
    ms,
    attachmentCount: keys.length,
  }, { traceId });
  return String(data);
}
