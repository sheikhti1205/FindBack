import {
  Accessibility,
  Activity,
  Bell,
  CircleHelp,
  Cpu,
  Image,
  Info,
  KeyRound,
  LayoutGrid,
  Palette,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { SettingsSearchResult } from "../components/settings";

/**
 * Local settings search index (packet matrices/settings_search_index.csv).
 * Entirely static: no network, no storage reads. `description` carries the
 * group path hint shown under each search result.
 */
export interface SettingsIndexEntry extends SettingsSearchResult {
  /** Lowercase alias terms; never rendered, only matched. */
  keywords: string;
  group: string;
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  {
    id: "account",
    title: "Account & profile",
    keywords: "profile username email phone avatar manage",
    group: "Account",
    route: "/settings/account",
    description: "Account",
    icon: UserRound,
    iconTone: "account",
  },
  {
    id: "appearance",
    title: "Appearance",
    keywords: "theme dark amoled accent color personalization display",
    group: "Preferences",
    route: "/settings/appearance",
    description: "Preferences",
    icon: Palette,
    iconTone: "appearance",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    keywords: "font text size motion reduce animation large",
    group: "Preferences",
    route: "/settings/accessibility",
    description: "Preferences",
    icon: Accessibility,
    iconTone: "accessibility",
  },
  {
    id: "feed-layout",
    title: "Feed layout",
    keywords: "feed layout masonry grid columns photos home auto compact list",
    group: "Preferences",
    route: "/settings/feed-layout",
    description: "Preferences",
    icon: LayoutGrid,
    iconTone: "teal",
  },
  {
    id: "media",
    title: "Media & uploads",
    keywords: "photo image quality data storage upload high",
    group: "Advanced",
    route: "/settings/media",
    description: "More · Advanced",
    icon: Image,
    iconTone: "media",
  },
  {
    id: "notifications",
    title: "Notifications",
    keywords: "push comment mention like status report bell alert",
    group: "Preferences",
    route: "/settings/notifications",
    description: "Preferences",
    icon: Bell,
    iconTone: "notifications",
  },
  {
    id: "ai",
    title: "AI & models",
    keywords: "ai local on device model cpu gpu cloud chat providers",
    group: "Intelligence",
    route: "/settings/ai",
    description: "Intelligence",
    icon: Sparkles,
    iconTone: "ai",
  },
  {
    id: "local-intelligence",
    title: "Local intelligence",
    keywords: "local on device offline phone search helper needle downloaded models smart search",
    group: "Intelligence",
    route: "/settings/local-intelligence",
    description: "Intelligence",
    icon: Cpu,
    iconTone: "ai",
  },
  {
    id: "downloaded-models",
    title: "Downloaded models",
    keywords: "downloaded models installed download storage verify repair remove local",
    group: "Intelligence",
    route: "/settings/local-intelligence/downloads",
    description: "Intelligence · Local intelligence",
    icon: Cpu,
    iconTone: "ai",
  },
  {
    id: "chat-models",
    title: "Chat models",
    keywords: "chat models default favorite last used provider model",
    group: "Intelligence",
    route: "/settings/ai/chat-models",
    description: "Intelligence · AI & models",
    icon: Sparkles,
    iconTone: "ai",
  },
  {
    id: "on-device-models",
    title: "On-device AI",
    keywords: "on device models photo analysis catalogue download local",
    group: "Intelligence",
    route: "/settings/ai/models",
    description: "Intelligence · AI & models",
    icon: Sparkles,
    iconTone: "ai",
  },
  {
    id: "connections",
    title: "Providers",
    keywords: "providers cloud connections openrouter api key provider openai google mistral groq",
    group: "Intelligence",
    route: "/settings/ai/connections",
    description: "Intelligence · AI & models",
    icon: KeyRound,
    iconTone: "ai",
  },
  {
    id: "privacy",
    title: "Privacy & permissions",
    keywords: "privacy location permission sharing",
    group: "Privacy",
    route: "/settings/privacy",
    description: "Privacy",
    icon: ShieldCheck,
    iconTone: "privacy",
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    keywords: "debug build logs export support",
    group: "Advanced",
    route: "/settings/diagnostics",
    description: "More · Advanced",
    icon: Activity,
    iconTone: "privacy",
  },
  {
    id: "help",
    title: "Help & guide",
    keywords: "faq tutorial onboarding lost found search recover",
    group: "Help & about",
    route: "/settings/help",
    description: "More · Help & about",
    icon: CircleHelp,
    iconTone: "help",
  },
  {
    id: "replay",
    title: "Replay introduction",
    keywords: "replay introduction tutorial walkthrough guide start",
    group: "Help & about",
    route: "/onboarding?replay=1",
    description: "More · Help & about",
    icon: RotateCcw,
    iconTone: "help",
  },
  {
    id: "about",
    title: "About FindBack",
    keywords: "version build application",
    group: "Help & about",
    route: "/settings/about",
    description: "More · Help & about",
    icon: Info,
    iconTone: "about",
  },
];

/**
 * Local token filter: every whitespace-separated query token must appear
 * somewhere in the entry's title, keywords, or group (case-insensitive).
 */
export function searchSettings(query: string): SettingsSearchResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return SETTINGS_INDEX.filter((entry) => {
    const haystack = `${entry.title} ${entry.keywords} ${entry.group}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }).map(({ keywords: _keywords, group: _group, ...result }) => result);
}
