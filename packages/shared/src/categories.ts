import { CATEGORIES } from "./constants.js";

/**
 * Additive category taxonomy (Report-perfection P3).
 *
 * `CATEGORIES` remains the eight canonical strings the deployed server
 * validator accepts today. This module layers the proposed 25-option
 * taxonomy on top of it WITHOUT widening the released set, so the client can
 * never submit a category the server would reject (R-052/R-051).
 *
 * Release is gated by `RELEASED_CATEGORIES`; flipping the gate requires the
 * versioned, additive migration in supabase/migrations to have been applied
 * by the owner first.
 */

export const CATEGORY_GROUPS = [
  "Tech",
  "Personal items",
  "Study/work",
  "Everyday",
  "Health/animals",
  "Other",
] as const;

export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export interface CategoryOption {
  /** Exact canonical string persisted to the database. */
  canonical: string;
  group: CategoryGroup;
  /** Search/alias terms that are NOT persisted. */
  synonyms?: readonly string[];
  /** Short human hint shown under the label. */
  examples?: string;
}

/** Options the deployed validator accepts right now. Never publish outside this. */
export const RELEASED_CATEGORIES: readonly string[] = CATEGORIES;

/** The full proposed taxonomy. `Other` is kept last by group order. */
export const CATEGORY_CATALOG: readonly CategoryOption[] = [
  { canonical: "Electronics", group: "Tech", synonyms: ["power bank", "gadget", "charger", "device", "phone", "laptop", "camera"], examples: "power bank, charger" },
  { canonical: "Phones & Tablets", group: "Tech", synonyms: ["mobile", "iphone", "android", "ipad"], examples: "phone, tablet" },
  { canonical: "Computers & Accessories", group: "Tech", synonyms: ["laptop", "notebook", "mouse", "keyboard", "monitor"], examples: "laptop, mouse" },
  { canonical: "Audio & Wearables", group: "Tech", synonyms: ["earbuds", "headphone", "smartwatch", "airpods"], examples: "earbuds, smartwatch" },
  { canonical: "Cameras & Photography", group: "Tech", synonyms: ["camera", "lens", "gopro"], examples: "camera, lens" },
  { canonical: "Bags & Wallets", group: "Personal items", synonyms: ["bag", "purse", "backpack", "wallet"], examples: "backpack, purse" },
  { canonical: "Keys", group: "Personal items", synonyms: ["keychain", "key ring"], examples: "key ring" },
  { canonical: "Documents & IDs", group: "Personal items", synonyms: ["id card", "passport", "licence", "license", "certificate"], examples: "ID card, passport" },
  { canonical: "Accessories & Jewelry", group: "Personal items", synonyms: ["jewellery", "ring", "necklace", "bracelet"], examples: "ring, necklace" },
  { canonical: "Watches & Eyewear", group: "Personal items", synonyms: ["watch", "spectacles", "glasses", "sunglasses"], examples: "watch, glasses" },
  { canonical: "Clothing", group: "Personal items", synonyms: ["shirt", "jacket", "dress", "hoodie"], examples: "jacket, scarf" },
  { canonical: "Footwear", group: "Personal items", synonyms: ["shoes", "sneakers", "sandals", "boots"], examples: "shoes, sandals" },
  { canonical: "Personal Care", group: "Personal items", synonyms: ["toiletries", "cosmetics", "skincare"], examples: "toiletries" },
  { canonical: "Books & Stationery", group: "Study/work", synonyms: ["book", "notebook", "pen", "textbook"], examples: "textbook, notebook" },
  { canonical: "Tools & Equipment", group: "Study/work", synonyms: ["tool", "drill", "wrench"], examples: "drill, wrench" },
  { canonical: "Office Supplies", group: "Study/work", synonyms: ["stationery", "folder", "stapler"], examples: "folder, stapler" },
  { canonical: "Umbrellas & Bottles", group: "Everyday", synonyms: ["umbrella", "water bottle", "flask"], examples: "umbrella, flask" },
  { canonical: "Household Items", group: "Everyday", synonyms: ["home", "kitchen", "utensil"], examples: "kitchen item" },
  { canonical: "Sports & Fitness", group: "Everyday", synonyms: ["gym", "sports", "racket", "yoga"], examples: "racket, mat" },
  { canonical: "Toys & Games", group: "Everyday", synonyms: ["toy", "board game", "puzzle"], examples: "toy, puzzle" },
  { canonical: "Travel & Luggage", group: "Everyday", synonyms: ["suitcase", "trolley", "duffel"], examples: "suitcase" },
  { canonical: "Vehicle Accessories", group: "Everyday", synonyms: ["car", "bike", "helmet", "motorcycle"], examples: "helmet, car key" },
  { canonical: "Medical & Health Items", group: "Health/animals", synonyms: ["medicine", "inhaler", "spectacle case"], examples: "medical item" },
  { canonical: "Pet Accessories", group: "Health/animals", synonyms: ["pet", "leash", "collar"], examples: "leash, collar" },
  { canonical: "Other", group: "Other", synonyms: ["misc", "miscellaneous", "unknown"], examples: "anything else" },
] as const;

/** Proposed options that are NOT yet released by the server validator. */
export const PROPOSED_CATEGORIES: readonly string[] = CATEGORY_CATALOG
  .map((option) => option.canonical)
  .filter((canonical) => !RELEASED_CATEGORIES.includes(canonical));

export function isReleasedCategory(value: string): boolean {
  return RELEASED_CATEGORIES.includes(value);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Diacritic/case-insensitive search across canonical labels and synonyms.
 * An empty query returns the whole catalog in stable group order.
 */
export function searchCategoryCatalog(query: string): CategoryOption[] {
  const needle = normalize(query);
  if (!needle) return [...CATEGORY_CATALOG];
  return CATEGORY_CATALOG.filter((option) => {
    if (normalize(option.canonical).includes(needle)) return true;
    return (option.synonyms ?? []).some((synonym) => normalize(synonym).includes(needle));
  });
}
