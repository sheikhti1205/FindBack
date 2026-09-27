import { CATEGORIES, type Category } from "@findback/shared";
import type { GuidedSnapshot } from "./guidedAssistantController";
import type { Intent, ReportSlotFields } from "../ai/types";

export type ReportTurnKind =
  | "SLOT_VALUE"
  | "INTENT_SWITCH"
  | "SIDE_QUESTION"
  | "GREETING"
  | "UNRECOGNIZED";

export interface ReportTurnResolution {
  readonly kind: ReportTurnKind;
  readonly fields?: ReportSlotFields;
  readonly intent?: Intent;
  readonly unmatchedCategory?: string;
}

const CATEGORY_ALIASES: ReadonlyArray<{ aliases: readonly string[]; category: Category }> = [
  // Specific Tech entries precede the broad Electronics fallback so single
  // matches read naturally; multi-matches resolve to ambiguous (never
  // first-wins), so ordering never silently decides a category.
  {
    aliases: [
      "phone",
      "mobile",
      "smartphone",
      "cellphone",
      "cell phone",
      "iphone",
      "tablet",
      "ipad",
      "android",
    ],
    category: "Phones & Tablets",
  },
  {
    aliases: [
      "laptop",
      "notebook",
      "computer",
      "mouse",
      "keyboard",
      "monitor",
    ],
    category: "Computers & Accessories",
  },
  {
    aliases: [
      "headphone",
      "earbud",
      "earphone",
      "airpods",
      "smartwatch",
      "speaker",
    ],
    category: "Audio & Wearables",
  },
  {
    aliases: ["camera", "lens", "gopro"],
    category: "Cameras & Photography",
  },
  {
    aliases: [
      "watch",
      "spectacle",
      "glasses",
      "eyeglass",
      "sunglass",
    ],
    category: "Watches & Eyewear",
  },
  {
    aliases: ["shoe", "sneaker", "sandal", "boot", "footwear"],
    category: "Footwear",
  },
  {
    aliases: ["suitcase", "trolley", "duffel", "luggage"],
    category: "Travel & Luggage",
  },
  {
    aliases: [
      "charger",
      "cable",
      "electronics",
      "electronic",
      "device",
      "gadget",
    ],
    category: "Electronics",
  },
  {
    aliases: [
      "backpack",
      "purse",
      "handbag",
      "wallet",
      "bag",
      "tote",
    ],
    category: "Bags & Wallets",
  },
  {
    aliases: ["key", "keys", "keychain", "keyring", "keyfob"],
    category: "Keys",
  },
  {
    aliases: [
      "passport",
      "license",
      "licence",
      "certificate",
      "document",
      "nid",
      "id card",
      "idcard",
    ],
    category: "Documents & IDs",
  },
  {
    aliases: ["book", "notebook", "stationery", "pen", "pencil", "textbook", "diary"],
    category: "Books & Stationery",
  },
  {
    aliases: [
      "shirt",
      "jacket",
      "dress",
      "cloth",
      "clothes",
      "clothing",
      "cap",
      "trouser",
      "pants",
      "coat",
      "hoodie",
      "sweater",
      "tshirt",
    ],
    category: "Clothing",
  },
  {
    aliases: [
      "ring",
      "jewelry",
      "jewellery",
      "bracelet",
      "necklace",
      "earring",
      "accessory",
    ],
    category: "Accessories & Jewelry",
  },
];

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function aliasMatchesToken(alias: string, token: string): boolean {
  if (token === alias) return true;
  if (token === `${alias}s`) return true;
  if (token === `${alias}es`) return true;
  return false;
}

/**
 * Every category the text matches, in alias-table order. Most inputs match
 * zero or one; inputs matching two or more ("notebook" is both a laptop and a
 * paper notebook, "phone charger" spans Phones and Electronics) are
 * AMBIGUOUS and must trigger a clarification, never a confident assignment.
 */
export function assistantCategoryCandidates(text: string): Category[] {
  const found: Category[] = [];
  const push = (category: Category) => {
    if (!((CATEGORIES as readonly string[]).includes(category))) return;
    if (!found.includes(category)) found.push(category);
  };
  const lower = ` ${text.toLowerCase()} `;
  if (lower.includes(" cell phone ")) push("Phones & Tablets");
  if (lower.includes(" id card ")) push("Documents & IDs");
  const tokens = tokensOf(text);
  for (const entry of CATEGORY_ALIASES) {
    for (const alias of entry.aliases) {
      if (alias.includes(" ")) continue;
      for (const token of tokens) {
        if (aliasMatchesToken(alias, token)) {
          push(entry.category);
          break;
        }
      }
    }
  }
  return found;
}

/** True when the text matches two or more categories and needs a follow-up question. */
export function isAssistantCategoryAmbiguous(text: string): boolean {
  return assistantCategoryCandidates(text).length > 1;
}

export function resolveAssistantCategory(text: string): Category | undefined {
  const candidates = assistantCategoryCandidates(text);
  // Exactly one confident match resolves; zero or AMBIGUOUS (2+) resolve to
  // nothing so every caller falls back to asking instead of misfiling.
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isGreeting(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length >= 32) return false;
  return /^(hi|hello|hey|yo|salam)\b/i.test(trimmed);
}

const APP_NOUNS = [
  "app",
  "findback",
  "report",
  "search",
  "filter",
  "photo",
  "location",
  "account",
  "profile",
  "publish",
  "comment",
  "rating",
  "model",
  "offline",
  "help",
  "button",
  "screen",
  "feed",
  "tab",
];

function isAppQuestion(message: string): boolean {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  if (/\bhow (do|can|should) (i|you|we)\b/.test(lower)) return true;
  if (/\bhow to\b/.test(lower)) return true;
  if (/\bwhat can\b/.test(lower)) return true;
  if (/\bhelp (me|with)\b/.test(lower)) return true;
  const questionShaped =
    /^(how|what|where|why|when|which|can|could|does|do|is|are|should|help)\b/.test(lower) ||
    trimmed.endsWith("?");
  if (!questionShaped) return false;
  if (/\b(lost|lose|losing|missing|misplaced|found|picked up|discovered)\b/.test(lower)) {
    return false;
  }
  if (/\b(search|find|look for|looking for|show me|browse)\b/.test(lower)) {
    return APP_NOUNS.some((noun) => lower.includes(noun));
  }
  return APP_NOUNS.some((noun) => lower.includes(noun));
}

function switchTargetFor(message: string): Intent | undefined {
  const lower = message.toLowerCase();
  const hasLost = /\b(lost|lose|losing|missing|misplaced)\b/.test(lower);
  const hasFound = /\b(found|picked up|discovered)\b/.test(lower);
  const hasSearch =
    /\b(search|browse)\b/.test(lower) ||
    /\blook for\b/.test(lower) ||
    /\blooking for\b/.test(lower) ||
    /\bshow me\b/.test(lower) ||
    /\bfind\b/.test(lower);
  const framing =
    /\b(actually|instead|rather|never ?mind|switch|meant|let me|i want to|i'd like to|change to)\b/.test(
      lower,
    );
  if (framing) {
    if (hasSearch && !hasLost && !hasFound) return "SEARCH";
    if (hasFound && !hasLost) return "REPORT_FOUND";
    if (hasLost && !hasFound) return "REPORT_LOST";
    if (/\breport\b/.test(lower) && hasLost) return "REPORT_LOST";
    if (/\breport\b/.test(lower) && hasFound) return "REPORT_FOUND";
    return undefined;
  }
  return undefined;
}

function mismatchedTarget(
  snapshot: GuidedSnapshot,
  message: string,
): Intent | undefined {
  const lower = message.toLowerCase();
  const hasLost = /\b(lost|lose|losing|missing|misplaced)\b/.test(lower);
  const hasFound = /\b(found|picked up|discovered)\b/.test(lower);
  const hasSearchVerb =
    /\b(search|browse)\b/.test(lower) ||
    /\blook for\b/.test(lower) ||
    /\blooking for\b/.test(lower) ||
    /\bshow me\b/.test(lower);
  if (snapshot.flow === "lost" && hasFound && !hasLost) return "REPORT_FOUND";
  if (snapshot.flow === "found" && hasLost && !hasFound) return "REPORT_LOST";
  if ((snapshot.flow === "lost" || snapshot.flow === "found") && hasSearchVerb) {
    return "SEARCH";
  }
  return undefined;
}

function extractDateText(message: string): string | undefined {
  const match = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match?.[1];
}

function extractLocationNote(message: string, dateText: string | undefined): string | undefined {
  const withoutDate =
    dateText !== undefined ? message.replace(dateText, " ") : message;
  const match = withoutDate.match(
    /\b(?:at|in|near|nearby|around|from|outside|inside|by|on)\s+([A-Za-z][A-Za-z0-9 .,'-]{2,80})/i,
  );
  const captured = match?.[1]
    ?.trim()
    .replace(/[.,;]+$/, "")
    .replace(/\s+(?:at|on)$/i, "");
  if (captured === undefined || captured === "") return undefined;
  return captured;
}

function isShortAnswer(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > 40) return false;
  return trimmed.split(/\s+/).filter((part) => part.length > 0).length <= 4;
}

export function resolveReportTurn(
  snapshot: GuidedSnapshot,
  message: string,
): ReportTurnResolution {
  const trimmed = message.trim();
  if (trimmed === "" || !/[a-z0-9]/i.test(trimmed)) {
    return { kind: "UNRECOGNIZED" };
  }
  if (trimmed.length <= 2) {
    if (/[a-z]/i.test(trimmed) && snapshot.missingFields.includes("category")) {
      return { kind: "UNRECOGNIZED", unmatchedCategory: trimmed };
    }
    return { kind: "UNRECOGNIZED" };
  }
  if (isGreeting(trimmed)) return { kind: "GREETING" };
  if (isAppQuestion(trimmed)) return { kind: "SIDE_QUESTION" };
  const framed = switchTargetFor(trimmed);
  if (framed !== undefined) {
    const current =
      snapshot.flow === "lost"
        ? "REPORT_LOST"
        : snapshot.flow === "found"
          ? "REPORT_FOUND"
          : snapshot.flow === "search"
            ? "SEARCH"
            : undefined;
    if (current === undefined || framed !== current) {
      return { kind: "INTENT_SWITCH", intent: framed };
    }
  }
  const mismatched = mismatchedTarget(snapshot, trimmed);
  if (mismatched !== undefined) return { kind: "INTENT_SWITCH", intent: mismatched };

  const category = resolveAssistantCategory(trimmed);
  const dateText = extractDateText(trimmed);
  const locationNote = extractLocationNote(trimmed, dateText);
  if (category === undefined && dateText === undefined && locationNote === undefined) {
    if (snapshot.missingFields.includes("category") && isShortAnswer(trimmed)) {
      return { kind: "UNRECOGNIZED", unmatchedCategory: trimmed };
    }
    if (snapshot.missingFields.includes("location") && snapshot.patch.title !== undefined) {
      return { kind: "SLOT_VALUE", fields: { locationNote: trimmed } };
    }
    if (trimmed.endsWith("?") || trimmed.length <= 2) return { kind: "UNRECOGNIZED" };
    if (!isShortAnswer(trimmed) && snapshot.patch.title === undefined) {
      return { kind: "SLOT_VALUE", fields: { title: trimmed } };
    }
    return { kind: "UNRECOGNIZED", unmatchedCategory: undefined };
  }
  const fields: ReportSlotFields = {};
  if (category !== undefined) (fields as Record<string, string>).category = category;
  if (dateText !== undefined) (fields as Record<string, string>).dateText = dateText;
  if (locationNote !== undefined) {
    (fields as Record<string, string>).locationNote = locationNote;
  }
  if (
    snapshot.patch.title === undefined &&
    (dateText !== undefined || locationNote !== undefined || trimmed.split(/\s+/).length > 3)
  ) {
    (fields as Record<string, string>).title = trimmed;
  }
  return { kind: "SLOT_VALUE", fields };
}
