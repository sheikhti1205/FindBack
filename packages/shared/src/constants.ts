export const POST_TYPES = ["LOST", "FOUND"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_STATUSES = ["OPEN", "MATCHED", "RECOVERED", "CLOSED"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * Canonical category strings persisted to the database. The original eight
 * stay first in their historical order; the 17 cutover additions follow in
 * catalog group order. Released by migration
 * 20260926000001_category_expansion.sql (applied).
 */
export const CATEGORIES = [
  "Electronics",
  "Bags & Wallets",
  "Keys",
  "Documents & IDs",
  "Books & Stationery",
  "Clothing",
  "Accessories & Jewelry",
  "Other",
  "Phones & Tablets",
  "Computers & Accessories",
  "Audio & Wearables",
  "Cameras & Photography",
  "Watches & Eyewear",
  "Footwear",
  "Personal Care",
  "Tools & Equipment",
  "Office Supplies",
  "Umbrellas & Bottles",
  "Household Items",
  "Sports & Fitness",
  "Toys & Games",
  "Travel & Luggage",
  "Vehicle Accessories",
  "Medical & Health Items",
  "Pet Accessories",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const REACTION_TYPES = ["LIKE", "DISLIKE"] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

/**
 * Notification inbox kinds (W1-A). LIKE/DISLIKE are legacy compat rows;
 * every canonical reaction kind (LOVE/HELPFUL/SUPPORT/WOW) notifies as a
 * single REACTION row carrying the kind in `reaction_kind`.
 */
export const NOTIFICATION_TYPES = ["LIKE", "DISLIKE", "COMMENT", "MENTION", "STATUS", "REACTION"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const VERIFICATION_CHANNELS = ["EMAIL", "PHONE"] as const;
export type VerificationChannel = (typeof VERIFICATION_CHANNELS)[number];

export const RATING_MAX = 5;

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  OPEN: "Open",
  MATCHED: "Matched",
  RECOVERED: "Recovered",
  CLOSED: "Closed",
};

/** When a found/lost item is resolved by the owner. */
export const RESOLVED_STATUSES: PostStatus[] = ["RECOVERED", "CLOSED"];

/** Cursor page size for the feed. */
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 20;

/** Debounce (ms) for the live username availability check. */
export const USERNAME_CHECK_DEBOUNCE_MS = 350;
