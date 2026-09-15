import type { Category, PostType } from "@findback/shared";
import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";

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

export async function createPost(input: CreatePostInput): Promise<string> {
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
  if (error) throw new ApiError(error.message, error.code === "42501" ? 403 : 400);
  return String(data);
}
