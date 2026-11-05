import {
  Accessibility,
  Activity,
  Bell,
  CircleHelp,
  Cpu,
  Flag,
  Image,
  Info,
  KeyRound,
  LayoutGrid,
  CloudUpload,
  MessageSquare,
  MonitorSmartphone,
  Palette,
  RotateCcw,
  Scale,
  ShieldCheck,
  Sparkles,
  UserRound,
  UserRoundX,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { SettingIconTone, SettingsSearchResult } from "../components/settings";
import {
  destinationFor,
  resolveDestination,
  type DestinationContext,
  SETTINGS_PLACEMENT,
  settingsSectionFor,
  type SettingsSection,
} from "./destinations";

/**
 * Local settings search index (packet matrices/settings_search_index.csv).
 *
 * The titles, routes and aliases are NOT written here: every entry is generated
 * from the navigation catalogue (`services/destinations.ts`), so Settings search
 * cannot advertise a destination the catalogue does not know or disagree with it
 * about where a row goes. This file adds only presentation (icon, group path).
 *
 * Entirely static: no network, no storage reads.
 */
export interface SettingsIndexEntry extends SettingsSearchResult {
  /** Lowercase alias terms; never rendered, only matched. */
  keywords: string;
  group: string;
}

type SectionLabel = Readonly<{ group: string; description: string }>;

const SECTION_LABEL: Record<SettingsSection, SectionLabel> = {
  account: { group: "Account", description: "Account" },
  preferences: { group: "Preferences", description: "Preferences" },
  intelligence: { group: "Intelligence", description: "Intelligence" },
  privacy: { group: "Privacy", description: "Privacy" },
  more: { group: "More", description: "More" },
  advanced: { group: "Advanced", description: "More · Advanced" },
  troubleshooting: { group: "Advanced", description: "More · Advanced" },
  legal: { group: "Legal", description: "More · Legal" },
  helpAbout: { group: "Help & about", description: "More · Help & about" },
};

/**
 * Destinations that are not Settings rows but are still worth finding from
 * Settings search — the leaf screens inside a row, plus safety destinations
 * that live under Privacy & safety.
 */
const SEARCH_ONLY: readonly { id: string; section: SettingsSection; description?: string }[] = [
  { id: "blocked-accounts", section: "privacy", description: "Privacy · Safety" },
  { id: "safety-reports", section: "privacy", description: "Privacy · Safety" },
  { id: "appeals", section: "privacy", description: "Privacy · Safety" },
  { id: "downloaded-models", section: "intelligence", description: "Local tools" },
  { id: "chat-models", section: "intelligence", description: "Optional AI Chat" },
  { id: "connections", section: "intelligence", description: "Optional AI Chat" },
  { id: "ai-privacy", section: "intelligence", description: "Optional AI Chat" },
];

type Presentation = Readonly<{
  icon: LucideIcon;
  iconTone: SettingIconTone;
  description?: string;
}>;

/** Icon and tone only. Never a title, route or alias. */
const PRESENTATION: Record<string, Presentation> = {
  "recovered-items": { icon: RotateCcw, iconTone: "success" },
  account: { icon: UserRound, iconTone: "account" },
  devices: { icon: MonitorSmartphone, iconTone: "teal" },
  backup: { icon: CloudUpload, iconTone: "blue" },
  "chat-preferences": { icon: MessageSquare, iconTone: "neutral" },
  appearance: { icon: Palette, iconTone: "appearance" },
  accessibility: { icon: Accessibility, iconTone: "accessibility" },
  "feed-layout": { icon: LayoutGrid, iconTone: "teal" },
  notifications: { icon: Bell, iconTone: "notifications" },
  "local-intelligence": { icon: Cpu, iconTone: "ai" },
  "downloaded-models": { icon: Cpu, iconTone: "ai" },
  ai: { icon: Sparkles, iconTone: "ai" },
  "chat-models": { icon: Sparkles, iconTone: "ai" },
  connections: { icon: KeyRound, iconTone: "ai" },
  "ai-privacy": { icon: ShieldCheck, iconTone: "privacy" },
  privacy: { icon: ShieldCheck, iconTone: "privacy" },
  "blocked-accounts": { icon: UserRoundX, iconTone: "privacy" },
  "safety-reports": { icon: Flag, iconTone: "privacy" },
  appeals: { icon: Scale, iconTone: "privacy" },
  feedback: { icon: MessageSquare, iconTone: "neutral" },
  media: { icon: Image, iconTone: "media" },
  diagnostics: { icon: Activity, iconTone: "privacy" },
  terms: { icon: Scale, iconTone: "about" },
  "privacy-policy": { icon: ShieldCheck, iconTone: "privacy" },
  "community-guidelines": { icon: Users, iconTone: "help" },
  help: { icon: CircleHelp, iconTone: "help" },
  replay: { icon: RotateCcw, iconTone: "help" },
  about: { icon: Info, iconTone: "about" },
};

function entry(id: string, section: SettingsSection, description?: string): SettingsIndexEntry | null {
  const destination = destinationFor(id);
  if (!destination) return null;
  const presentation = PRESENTATION[id];
  if (!presentation) return null;
  return {
    id: destination.id,
    title: destination.title,
    keywords: destination.keywords.join(" "),
    group: SECTION_LABEL[section].group,
    route: destination.route,
    description: description ?? presentation.description ?? SECTION_LABEL[section].description,
    icon: presentation.icon,
    iconTone: presentation.iconTone,
  };
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  ...SETTINGS_PLACEMENT.map(({ id, section }) => entry(id, section, PRESENTATION[id]?.description))
    .filter((value): value is SettingsIndexEntry => value !== null),
  ...SEARCH_ONLY.map(({ id, section, description }) => entry(id, section, description))
    .filter((value): value is SettingsIndexEntry => value !== null),
];

/**
 * Local token filter: every whitespace-separated query token must appear
 * somewhere in the entry's title, keywords, or group (case-insensitive).
 */
export function searchSettings(query: string, context?: DestinationContext): SettingsSearchResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return SETTINGS_INDEX.filter((entry) => {
    if (context && resolveDestination(entry.id, context).kind !== "available") return false;
    const haystack = `${entry.title} ${entry.keywords} ${entry.group}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }).map(({ keywords: _keywords, group: _group, ...result }) => result);
}

/** Whether a destination id is a Settings row (as opposed to a search-only leaf). */
export function isSettingsRow(id: string): boolean {
  return settingsSectionFor(id) !== null;
}
