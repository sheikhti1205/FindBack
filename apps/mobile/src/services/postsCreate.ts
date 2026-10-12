import type { Category, PostType } from "@findback/shared";
import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { diag } from "./diag";
import { withTimeout } from "./timeout";
import { PublishOutcomeUncertainError } from "./publishOutcome";

/**
 * Bound for the create-post RPC. A hang must surface as uncertain (the
 * server may still have committed — staged uploads are kept and republish
 * stays blocked), never spin the report screen forever.
 */
export const CREATE_POST_RPC_TIMEOUT_MS = 30_000;

async function createRpc(name: string, args: Record<string, unknown>, traceId?: string): Promise<string> {
  const start = Date.now();
  let result: Awaited<ReturnType<ReturnType<typeof getSupabase>["rpc"]>>;
  try {
    result = await withTimeout(
      () => Promise.resolve(getSupabase().rpc(name, args)),
      CREATE_POST_RPC_TIMEOUT_MS,
      "Report publish timed out",
    );
  } catch {
    throw new PublishOutcomeUncertainError();
  }
  if (result.error) {
    diag("posts.create.rpc.error", {
      rpc: name,
      code: result.error.code,
      message: result.error.message,
      ms: Date.now() - start,
    }, { traceId });
    // PostgREST/transport errors without a SQL code cannot establish that the
    // server rejected the transaction. Never delete bytes or retry blindly.
    if (!result.error.code || result.error.code.startsWith("PGRST")) {
      throw new PublishOutcomeUncertainError();
    }
    throw new ApiError(result.error.message, result.error.code === "42501" ? 403 : 400);
  }
  if (typeof result.data !== "string" || !result.data.trim()) {
    throw new PublishOutcomeUncertainError();
  }
  return result.data;
}

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
  const id = await createRpc("findback_create_post_client", {
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
  diag("posts.create.rpc.success", {
    rpc: "findback_create_post_client",
    ms: Date.now() - start,
    hasAttachmentKey: !!input.attachmentKey,
  }, { traceId });
  return id;
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
  const id = await createRpc("findback_create_post_client_multi", {
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
  diag("posts.create.rpc.success", {
    rpc: "findback_create_post_client_multi",
    ms: Date.now() - start,
    attachmentCount: keys.length,
  }, { traceId });
  return id;
}
