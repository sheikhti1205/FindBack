/**
 * Comment-composer web emoji catalogue (owner directive 2026-10-14).
 *
 * A compact but complete searchable/categorized/recent picker dataset —
 * NOT a tiny hand-picked stub. Rendered entirely offline from this module
 * (no network to render); the composer lazy-loads nothing heavier because
 * the whole set is a few kilobytes of strings.
 *
 * - `EMOJI_CATEGORIES`: stable category order with keyword-indexed entries.
 * - `searchEmojiCatalog`: case-insensitive keyword/name match, capped.
 * - Recents: MRU list in localStorage (`findback.emoji.recents.v1`, max 24),
 *   guarded so private-mode/SSR never throws; only catalogue-known or
 *   sanitizer-shaped picks are stored, never arbitrary text.
 * - Skin-tone variants ship as first-class catalogue entries (no separate
 *   tone composer needed on web); ZWJ/flag sequences are single entries.
 */

export interface EmojiCatalogEntry {
  /** The single visible pick (may be multi-codepoint: tones, ZWJ, flags). */
  char: string;
  /** Short human name, used for search + accessible labels. */
  name: string;
  /** Space-separated search keywords (lowercase). */
  keywords: string;
}

export interface EmojiCategory {
  id: string;
  label: string;
  /** Tab affordance glyph (decorative; the label carries meaning). */
  icon: string;
  items: readonly EmojiCatalogEntry[];
}

function e(char: string, name: string, keywords: string): EmojiCatalogEntry {
  return { char, name, keywords };
}

const SMILEYS: readonly EmojiCatalogEntry[] = [
  e("😀", "grinning face", "happy smile grin"),
  e("😁", "beaming face", "happy smile grin teeth"),
  e("😂", "face with tears of joy", "laugh lol funny crying"),
  e("🤣", "rolling on the floor laughing", "laugh lol rofl funny"),
  e("😊", "smiling face with smiling eyes", "happy warm blush"),
  e("😍", "smiling face with heart-eyes", "love crush heart eyes"),
  e("😘", "face blowing a kiss", "love kiss heart"),
  e("🥳", "partying face", "celebrate birthday party hat"),
  e("😎", "smiling face with sunglasses", "cool confident"),
  e("🤔", "thinking face", "hmm wonder consider"),
  e("😅", "grinning face with sweat", "nervous relief phew"),
  e("😭", "loudly crying face", "cry tears sad sob"),
  e("😡", "enraged face", "angry mad furious red"),
  e("🥺", "pleading face", "puppy eyes beg please"),
  e("😴", "sleeping face", "sleep tired snore zzz"),
  e("🤯", "exploding head", "mind blown shock wow"),
  e("🙃", "upside-down face", "silly sarcasm"),
  e("😉", "winking face", "wink flirt joke"),
  e("😋", "face savoring food", "yum tasty delicious tongue"),
  e("🤗", "smiling face with open hands", "hug embrace thanks"),
  e("🤭", "face with hand over mouth", "giggle oops secret"),
  e("🫣", "face with peeking eye", "shy peek embarrassed"),
  e("😬", "grimacing face", "awkward yikes oops"),
  e("🥲", "smiling face with tear", "touched grateful bittersweet"),
  e("😤", "face with steam from nose", "frustrated huff determined"),
  e("🤠", "cowboy hat face", "cowboy yeehaw"),
  e("😇", "smiling face with halo", "angel innocent blessed"),
  e("🤩", "star-struck", "excited star eyes wow"),
  e("🤑", "money-mouth face", "rich money dollar"),
  e("🤒", "face with thermometer", "sick ill fever"),
  e("🤕", "face with head-bandage", "hurt injured ouch"),
  e("🥴", "woozy face", "dizzy drunk tired"),
  e("😵", "face with crossed-out eyes", "dizzy dead overwhelmed"),
  e("🥶", "cold face", "freezing cold ice winter"),
  e("🥵", "hot face", "heat sweating summer"),
  e("👻", "ghost", "spooky halloween boo"),
  e("💀", "skull", "dead skeleton danger"),
  e("🤖", "robot", "bot ai machine"),
  e("🎃", "jack-o-lantern", "halloween pumpkin spooky"),
  e("👨‍👩‍👧", "family", "family parents child together"),
  e("🫡", "saluting face", "salute respect yes sir"),
];

const GESTURES: readonly EmojiCatalogEntry[] = [
  e("👍", "thumbs up", "yes approve like good agree"),
  e("👍🏻", "thumbs up light skin tone", "yes approve light"),
  e("👍🏼", "thumbs up medium-light skin tone", "yes approve"),
  e("👍🏽", "thumbs up medium skin tone", "yes approve"),
  e("👍🏾", "thumbs up medium-dark skin tone", "yes approve"),
  e("👍🏿", "thumbs up dark skin tone", "yes approve dark"),
  e("👎", "thumbs down", "no dislike bad disagree"),
  e("🙏", "folded hands", "please thanks pray grateful hope"),
  e("🙏🏻", "folded hands light skin tone", "please thanks light"),
  e("🙏🏼", "folded hands medium-light skin tone", "please thanks"),
  e("🙏🏽", "folded hands medium skin tone", "please thanks"),
  e("🙏🏾", "folded hands medium-dark skin tone", "please thanks"),
  e("🙏🏿", "folded hands dark skin tone", "please thanks dark"),
  e("👏", "clapping hands", "applause congratulations well done"),
  e("👏🏻", "clapping hands light skin tone", "applause light"),
  e("👏🏽", "clapping hands medium skin tone", "applause"),
  e("👏🏿", "clapping hands dark skin tone", "applause dark"),
  e("👋", "waving hand", "hello hi bye wave"),
  e("👋🏻", "waving hand light skin tone", "hello hi light"),
  e("👋🏽", "waving hand medium skin tone", "hello hi"),
  e("👋🏿", "waving hand dark skin tone", "hello hi dark"),
  e("🤝", "handshake", "deal agree support partner"),
  e("✊", "raised fist", "solidarity power protest"),
  e("✌️", "victory hand", "peace victory two"),
  e("🤞", "crossed fingers", "luck hope wish"),
  e("🙌", "raising hands", "celebrate hooray praise"),
  e("👌", "OK hand", "ok perfect fine"),
  e("🤲", "palms up together", "pray hope dua humble"),
  e("🫶", "heart hands", "love heart hands thanks"),
  e("💪", "flexed biceps", "strong muscle power"),
  e("👀", "eyes", "look see watch notice"),
  e("🙈", "see-no-evil monkey", "shy embarrassed ignore"),
  e("🙉", "hear-no-evil monkey", "ignore listen"),
  e("🙊", "speak-no-evil monkey", "silent secret oops"),
  e("✊🏽", "raised fist medium skin tone", "solidarity power"),
];

const HEARTS: readonly EmojiCatalogEntry[] = [
  e("❤️", "red heart", "love like heart red"),
  e("🧡", "orange heart", "love heart orange"),
  e("💛", "yellow heart", "love heart yellow"),
  e("💚", "green heart", "love heart green"),
  e("💙", "blue heart", "love heart blue"),
  e("💜", "purple heart", "love heart purple"),
  e("🖤", "black heart", "love heart black"),
  e("🤍", "white heart", "love heart white"),
  e("💔", "broken heart", "heartbreak sad split"),
  e("💕", "two hearts", "love hearts affection"),
  e("💖", "sparkling heart", "love sparkle heart"),
  e("💗", "growing heart", "love heart growing"),
  e("💘", "heart with arrow", "love cupid crush"),
  e("💝", "heart with ribbon", "love gift heart"),
  e("❣️", "heart exclamation", "love heart emphasis"),
];

const NATURE: readonly EmojiCatalogEntry[] = [
  e("🐶", "dog face", "dog puppy pet"),
  e("🐱", "cat face", "cat kitten pet"),
  e("🦊", "fox", "fox clever"),
  e("🐼", "panda", "panda bear cute"),
  e("🦁", "lion", "lion king brave"),
  e("🐸", "frog", "frog toad"),
  e("🐵", "monkey face", "monkey playful"),
  e("🦋", "butterfly", "butterfly transform pretty"),
  e("🐝", "honeybee", "bee honey busy"),
  e("🌸", "cherry blossom", "flower spring blossom pink"),
  e("🌹", "rose", "flower rose love red"),
  e("🌻", "sunflower", "flower sunflower sunny"),
  e("🌈", "rainbow", "rainbow pride hope colorful"),
  e("☀️", "sun", "sunny day bright weather"),
  e("🌙", "crescent moon", "night moon sleep"),
  e("⭐", "star", "star favorite night"),
  e("🔥", "fire", "hot lit flame trending"),
  e("💧", "droplet", "water drop tear"),
  e("🌊", "water wave", "ocean sea wave"),
  e("🍀", "four leaf clover", "lucky clover fortune"),
];

const FOOD: readonly EmojiCatalogEntry[] = [
  e("☕", "hot beverage", "coffee tea hot drink"),
  e("🍕", "pizza", "pizza slice cheese"),
  e("🎂", "birthday cake", "birthday cake celebrate sweet"),
  e("🍔", "hamburger", "burger fast food"),
  e("🍩", "doughnut", "donut sweet"),
  e("🍎", "red apple", "apple fruit healthy"),
  e("🍇", "grapes", "grapes fruit"),
  e("🍓", "strawberry", "strawberry fruit berry"),
  e("🥑", "avocado", "avocado healthy toast"),
  e("🍜", "steaming bowl", "noodles ramen soup"),
  e("🍰", "shortcake", "cake dessert sweet"),
  e("🧁", "cupcake", "cupcake dessert sweet"),
  e("🍪", "cookie", "cookie biscuit sweet"),
  e("🍉", "watermelon", "watermelon fruit summer"),
  e("🥭", "mango", "mango fruit tropical"),
  e("🍍", "pineapple", "pineapple tropical fruit"),
  e("🥤", "cup with straw", "drink soda juice"),
  e("🍺", "beer mug", "beer drink cheers"),
];

const ACTIVITIES: readonly EmojiCatalogEntry[] = [
  e("⚽", "soccer ball", "football soccer sport"),
  e("🏀", "basketball", "basketball sport"),
  e("🏏", "cricket game", "cricket bat ball sport"),
  e("🏸", "badminton", "badminton shuttle sport"),
  e("🎾", "tennis", "tennis sport ball"),
  e("🏊", "person swimming", "swim pool sport"),
  e("🚴", "person biking", "cycling bike sport"),
  e("🎮", "video game", "gaming controller play"),
  e("🎲", "game die", "dice game random luck"),
  e("🎯", "bullseye", "target direct hit goal"),
  e("🎨", "artist palette", "art paint creative"),
  e("🎭", "performing arts", "theater drama masks"),
  e("🎤", "microphone", "sing karaoke mic"),
  e("🎧", "headphone", "music listen audio"),
  e("⚾", "baseball", "baseball sport"),
  e("🎪", "circus tent", "circus carnival fun"),
];

const TRAVEL: readonly EmojiCatalogEntry[] = [
  e("🚗", "automobile", "car drive road"),
  e("🚲", "bicycle", "bike cycling"),
  e("✈️", "airplane", "flight travel plane trip"),
  e("🚀", "rocket", "launch space fast ship"),
  e("🚂", "locomotive", "train railway"),
  e("🏝️", "desert island", "island beach vacation"),
  e("🗺️", "world map", "map travel directions"),
  e("🧳", "luggage", "travel bag suitcase trip"),
  e("⛺", "tent", "camping tent outdoors"),
  e("🏖️", "beach with umbrella", "beach vacation sea"),
  e("🛵", "motor scooter", "scooter bike rickshaw"),
  e("🚁", "helicopter", "helicopter rescue fly"),
  e("⛵", "sailboat", "sail boat sea"),
  e("🚦", "traffic light", "traffic signal stop"),
];

const OBJECTS: readonly EmojiCatalogEntry[] = [
  e("🎁", "wrapped gift", "gift present surprise birthday"),
  e("💡", "light bulb", "idea helpful bright tip"),
  e("📱", "mobile phone", "phone mobile smartphone"),
  e("💻", "laptop", "computer laptop work"),
  e("📷", "camera", "photo camera picture"),
  e("🎥", "movie camera", "video film record"),
  e("🔑", "key", "key lock access found"),
  e("🔒", "locked", "lock secure private safe"),
  e("💰", "money bag", "money cash rich reward"),
  e("🎒", "backpack", "bag school travel lost"),
  e("📚", "books", "books study read"),
  e("✏️", "pencil", "write edit pencil"),
  e("🧸", "teddy bear", "teddy cute toy child"),
  e("🪴", "potted plant", "plant green home"),
  e("⏰", "alarm clock", "alarm time reminder"),
  e("🔔", "bell", "notification alert ring"),
  e("🎈", "balloon", "party celebrate birthday"),
  e("🧃", "beverage box", "juice drink box"),
  e("📦", "package", "box parcel delivery"),
  e("🛒", "shopping cart", "shop buy market"),
];

const SYMBOLS: readonly EmojiCatalogEntry[] = [
  e("✅", "check mark button", "done correct yes verified"),
  e("❌", "cross mark", "no wrong delete error"),
  e("➕", "plus", "add more plus"),
  e("➖", "minus", "remove less minus"),
  e("➡️", "right arrow", "next right forward"),
  e("⬅️", "left arrow", "back left previous"),
  e("⬆️", "up arrow", "up upload top"),
  e("⬇️", "down arrow", "down download bottom"),
  e("ℹ️", "information", "info help details"),
  e("⚠️", "warning", "caution alert careful"),
  e("♻️", "recycling symbol", "recycle reuse green"),
  e("💯", "hundred points", "perfect 100 score"),
  e("✳️", "eight-spoked asterisk", "star sparkle"),
  e("❇️", "sparkle", "sparkle shine new"),
  e("🔣", "input symbols", "symbols input"),
  e("©️", "copyright", "copyright rights"),
  e("🎉", "party popper", "celebrate congrats party tada"),
  e("🥇", "1st place medal", "gold winner first champion"),
];

const FLAGS: readonly EmojiCatalogEntry[] = [
  e("🇧🇩", "flag Bangladesh", "bangladesh flag bd dhaka"),
  e("🇺🇸", "flag United States", "usa america flag us"),
  e("🇬🇧", "flag United Kingdom", "uk britain england flag"),
  e("🇮🇳", "flag India", "india flag"),
  e("🇵🇰", "flag Pakistan", "pakistan flag"),
  e("🇨🇦", "flag Canada", "canada flag"),
  e("🇦🇺", "flag Australia", "australia flag"),
  e("🇯🇵", "flag Japan", "japan flag"),
  e("🇩🇪", "flag Germany", "germany flag"),
  e("🇫🇷", "flag France", "france flag"),
  e("🇸🇦", "flag Saudi Arabia", "saudi arabia flag"),
  e("🇦🇪", "flag United Arab Emirates", "uae dubai emirates flag"),
  e("🏳️‍🌈", "rainbow flag", "pride rainbow lgbt flag"),
];

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  { id: "smileys", label: "Smileys", icon: "😀", items: SMILEYS },
  { id: "gestures", label: "Gestures", icon: "👍", items: GESTURES },
  { id: "hearts", label: "Hearts", icon: "❤️", items: HEARTS },
  { id: "nature", label: "Nature", icon: "🌸", items: NATURE },
  { id: "food", label: "Food", icon: "🍕", items: FOOD },
  { id: "activities", label: "Activities", icon: "⚽", items: ACTIVITIES },
  { id: "travel", label: "Travel", icon: "✈️", items: TRAVEL },
  { id: "objects", label: "Objects", icon: "🎁", items: OBJECTS },
  { id: "symbols", label: "Symbols", icon: "✅", items: SYMBOLS },
  { id: "flags", label: "Flags", icon: "🏳️", items: FLAGS },
];

/** Flat catalogue (category order preserved) for counts/tests. */
export const EMOJI_CATALOG: readonly EmojiCatalogEntry[] = EMOJI_CATEGORIES.flatMap((c) => [...c.items]);

/** True when `char` is a catalogue entry (used to validate recents). */
export function isKnownCatalogEmoji(char: string): boolean {
  return EMOJI_CATALOG.some((entry) => entry.char === char);
}

function looksLikeSinglePick(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 24) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^data:/i.test(trimmed)) return false;
  return true;
}

/**
 * Case-insensitive keyword/name search across the catalogue. Empty query
 * returns the empty list (callers show recents/category grids instead).
 */
export function searchEmojiCatalog(query: string, limit = 60): EmojiCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: EmojiCatalogEntry[] = [];
  for (const entry of EMOJI_CATALOG) {
    if (out.length >= limit) break;
    if (entry.name.includes(q) || entry.keywords.includes(q) || entry.char.includes(q)) {
      out.push(entry);
    }
  }
  return out;
}

const RECENTS_KEY = "findback.emoji.recents.v1";
const RECENTS_MAX = 24;

function readStorage(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && looksLikeSinglePick(v)).slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

/** Most-recent-first recents; never throws, never returns arbitrary text. */
export function loadEmojiRecents(): string[] {
  return readStorage();
}

/**
 * Record a pick at the head of recents (deduped, capped). Returns the new
 * list. Ignores anything that is not a single emoji-shaped pick — recents
 * can never become a text log.
 */
export function recordEmojiRecent(pick: string): string[] {
  if (!looksLikeSinglePick(pick)) return readStorage();
  const next = [pick.trim(), ...readStorage().filter((v) => v !== pick.trim())].slice(0, RECENTS_MAX);
  try {
    globalThis.localStorage?.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota: recents stay in-memory for this session.
  }
  return next;
}
