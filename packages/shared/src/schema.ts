import { z } from "zod";
import type { Category, PostStatus, PostType } from "./constants.js";
import {
  CATEGORIES,
  POST_STATUSES,
  POST_TYPES,
  REACTION_TYPES,
  VERIFICATION_CHANNELS,
} from "./constants.js";

export const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .max(20, "Username must be at most 20 characters")
  .regex(
    /^[a-zA-Z0-9_]+$/,
    "Username may only contain letters, numbers and underscores",
  );

export const emailSchema = z.string().email("A valid email is required").max(254);

export const phoneSchema = z
  .string()
  .regex(
    /^(\+?88)?01[3-9]\d{8}$/,
    "Use a Bangladeshi mobile number, e.g. 01812345678",
  );

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128);

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  identifier: z.string().min(1, "Username or email required"),
  password: z.string().min(1, "Password required"),
});

export const usernameCheckQuerySchema = z.object({
  username: usernameSchema,
});

export const sendVerificationSchema = z.object({
  channel: z.enum(VERIFICATION_CHANNELS),
});

export const verifyChallengeSchema = z.object({
  channel: z.enum(VERIFICATION_CHANNELS),
  code: z.string().regex(/^\d{6,10}$/, "Verification code must be 6-10 digits"),
});

/**
 * Public pending-signup email verification (no session yet). Supabase owns the
 * one-time code, so the client only sends the email/username-free target.
 */
export const emailVerificationSendSchema = z.object({
  email: emailSchema,
});

export const emailVerificationVerifySchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6,10}$/, "Verification code must be 6-10 digits"),
});

/** Exchange a rotating refresh token for a fresh session. */
export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export const createPostSchema = z.object({
  type: z.enum(POST_TYPES),
  title: z.string().min(3, "Title must be at least 3 characters").max(120),
  description: z.string().min(10, "Description must be at least 10 characters").max(3000),
  category: z.enum(CATEGORIES),
  eventDate: z.string().min(1, "Choose a date"),
  locationLabel: z.string().max(200).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  youtubeUrl: z.string().url("YouTube URL must be valid").optional().or(z.literal("")),
  attachmentKey: z.string().optional(),
});

export const updatePostSchema = createPostSchema.partial();

export const feedQuerySchema = z.object({
  type: z.enum(POST_TYPES).optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(POST_STATUSES).optional(),
  q: z.string().max(120).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  sort: z.enum(["newest", "oldest"]).default("newest"),
});

export const addCommentSchema = z.object({
  body: z.string().min(1, "Comment cannot be empty").max(1000),
});

export const reactToPostSchema = z.object({
  type: z.enum(REACTION_TYPES).nullable(),
});

export const ratePostSchema = z.object({
  score: z.number().int().min(1).max(5),
});

export const changeStatusSchema = z.object({
  status: z.enum(POST_STATUSES),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type AddCommentInput = z.infer<typeof addCommentSchema>;
export type ReactToPostInput = z.infer<typeof reactToPostSchema>;
export type RatePostInput = z.infer<typeof ratePostSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type SendVerificationInput = z.infer<typeof sendVerificationSchema>;
export type VerifyChallengeInput = z.infer<typeof verifyChallengeSchema>;
export type EmailVerificationSendInput = z.infer<typeof emailVerificationSendSchema>;
export type EmailVerificationVerifyInput = z.infer<typeof emailVerificationVerifySchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Attachment {
  id: string;
  postId: string;
  fileUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  createdAt: string;
}

export interface PostItem {
  id: string;
  userId: string;
  author: PublicUser;
  type: PostType;
  title: string;
  description: string;
  category: Category;
  status: PostStatus;
  eventDate: string;
  latitude: number | null;
  longitude: number | null;
  locationLabel: string | null;
  youtubeUrl: string | null;
  attachments: Attachment[];
  likeCount: number;
  dislikeCount: number;
  ratingAvg: number | null;
  ratingCount: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommentItem {
  id: string;
  postId: string;
  author: PublicUser;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedPage {
  items: PostItem[];
  nextCursor: string | null;
  total: number;
}
