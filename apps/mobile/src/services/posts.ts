import type {
  Category,
  CommentItem,
  FeedPage,
  PostItem,
  PostStatus,
  PostType,
} from "@findback/shared";
import { apiFetch, apiBase, getToken } from "./api";

export interface FeedFilters {
  type?: PostType | "";
  category?: Category | "";
  status?: PostStatus | "";
  q?: string;
  sort?: "newest" | "oldest";
  dateFrom?: string;
  dateTo?: string;
}

export function feedUrl(filters: FeedFilters, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.category) params.set("category", filters.category);
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.sort === "oldest") params.set("sort", "oldest");
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "10");
  const qs = params.toString();
  return `/posts${qs ? `?${qs}` : ""}`;
}

export async function fetchFeed(filters: FeedFilters, cursor?: string): Promise<FeedPage> {
  return apiFetch<FeedPage>(feedUrl(filters, cursor));
}

export async function fetchPost(id: string): Promise<PostItem> {
  return apiFetch<PostItem>(`/posts/${id}`);
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

export async function createPost(input: CreatePostInput): Promise<PostItem> {
  return apiFetch<PostItem>("/posts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updatePostStatus(id: string, status: PostStatus): Promise<PostItem> {
  return apiFetch<PostItem>(`/posts/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function fetchComments(postId: string): Promise<CommentItem[]> {
  return apiFetch<CommentItem[]>(`/posts/${postId}/comments`);
}

export async function addComment(postId: string, body: string): Promise<CommentItem> {
  return apiFetch<CommentItem>(`/posts/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function deleteComment(postId: string, commentId: string): Promise<void> {
  await apiFetch(`/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
}

export interface ReactionResult {
  postId: string;
  likeCount: number;
  dislikeCount: number;
  myReaction: "LIKE" | "DISLIKE" | null;
}

export async function reactToPost(
  postId: string,
  type: "LIKE" | "DISLIKE" | null,
): Promise<ReactionResult> {
  return apiFetch<ReactionResult>(`/posts/${postId}/react`, {
    method: "POST",
    body: JSON.stringify({ type }),
  });
}

export async function ratePost(postId: string, score: number): Promise<{
  postId: string;
  score: number;
  ratingAvg: number | null;
  ratingCount: number;
}> {
  return apiFetch(`/posts/${postId}/rating`, {
    method: "PUT",
    body: JSON.stringify({ score }),
  });
}

export async function fetchMyPosts(): Promise<FeedPage> {
  return apiFetch<FeedPage>("/me/posts");
}

export interface StoredUpload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileUrl: string;
}

/** Upload an image through the FindBack API (Supabase Storage in production). */
export async function uploadImage(file: File): Promise<StoredUpload> {
  const form = new FormData();
  form.append("file", file);
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase()}/uploads`, { method: "POST", headers, body: form });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  const data = (await res.json()) as { upload: StoredUpload };
  return data.upload;
}
