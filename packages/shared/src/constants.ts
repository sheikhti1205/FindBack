export const POST_TYPES = ["LOST", "FOUND"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_STATUSES = ["OPEN", "MATCHED", "RECOVERED", "CLOSED"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const CATEGORIES = [
  "Electronics",
  "Bags & Wallets",
  "Keys",
  "Documents & IDs",
  "Books & Stationery",
  "Clothing",
  "Accessories & Jewelry",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const REACTION_TYPES = ["LIKE", "DISLIKE"] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

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

/**
 * Transparent mapping used by the on-device image classifier to translate generic
 * labels into FindBack categories. The classifier maps *keywords* it understands
 * to categories; any unlisted/unknown keyword falls back to "Other".
 */
export const ML_KEYWORD_TO_CATEGORY: Record<string, Category> = {
  phone: "Electronics",
  smartphone: "Electronics",
  laptop: "Electronics",
  computer: "Electronics",
  tablet: "Electronics",
  camera: "Electronics",
  earphone: "Electronics",
  headphone: "Electronics",
  charger: "Electronics",
  watch: "Accessories & Jewelry",
  necklace: "Accessories & Jewelry",
  ring: "Accessories & Jewelry",
  bracelet: "Accessories & Jewelry",
  wallet: "Bags & Wallets",
  backpack: "Bags & Wallets",
  handbag: "Bags & Wallets",
  purse: "Bags & Wallets",
  briefcase: "Bags & Wallets",
  luggage: "Bags & Wallets",
  key: "Keys",
  keyboard: "Electronics",
  book: "Books & Stationery",
  notebook: "Books & Stationery",
  "pencil box": "Books & Stationery",
  folder: "Documents & IDs",
  envelope: "Documents & IDs",
  sunglasses: "Accessories & Jewelry",
  umbrella: "Clothing",
  hat: "Clothing",
  cap: "Clothing",
  jacket: "Clothing",
  shirt: "Clothing",
  glasses: "Accessories & Jewelry",
  trophy: "Other",
};
