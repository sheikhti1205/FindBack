/**
 * ONE navigation catalogue for Settings search, offline Help and feature
 * announcements (S5/S6).
 *
 * These records are metadata only. They never authorize anything: route guards,
 * server grants and role/capability checks stay authoritative, and a capability
 * here is a courtesy-visibility hint, not a permission. Adding a row to a screen
 * without a record here is a bug — the search index is generated from this list,
 * so a destination that exists only in JSX is undiscoverable, and a record whose
 * route does not exist is a dead end.
 *
 * `category` extends the proposed S5 set with `reports`, because reports are a
 * first-class consumer area in Norfold rather than a settings section.
 */

export type DestinationCategory =
  | "account"
  | "preferences"
  | "safety"
  | "help"
  | "tools"
  | "advanced"
  | "reports";

export type DestinationPlatform = "web" | "android";

export type Destination = Readonly<{
  id: string;
  /** Allowlisted internal route/template. */
  route: string;
  title: string;
  summary: string;
  keywords: readonly string[];
  category: DestinationCategory;
  auth: "public" | "signed-in";
  platforms: readonly DestinationPlatform[];
  /** Courtesy visibility only; never authorization. */
  capability?: string;
  helpTopicId?: string;
}>;

export type DestinationContext = Readonly<{
  platform: DestinationPlatform;
  signedIn: boolean;
  capabilities: readonly string[];
}>;

export type DestinationResolution =
  | { kind: "available"; route: string }
  | { kind: "unavailable"; reason: "unknown" | "platform" | "auth" | "capability" };

/**
 * Where a destination sits in the Settings taxonomy. Placement is presentation,
 * so it stays out of the destination record; titles, routes and keywords do not
 * repeat here.
 */
export type SettingsSection =
  | "updates"
  | "account"
  | "preferences"
  | "intelligence"
  | "privacy"
  | "more"
  | "advanced"
  | "troubleshooting"
  | "legal"
  | "helpAbout";

export const DESTINATIONS: readonly Destination[] = [
  // --- Account ------------------------------------------------------------
  {
    id: "recovered-items",
    route: "/settings/returns",
    title: "Recovered items",
    summary: "Returned items, ratings and your standing.",
    keywords: ["recovery", "returned", "return", "rating", "ratings", "reputation", "standing", "helper"],
    category: "account",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "account",
    route: "/settings/account",
    title: "Account & profile",
    summary: "Your profile, username, email, phone and avatar.",
    keywords: ["profile", "username", "email", "phone", "avatar", "manage"],
    category: "account",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "devices",
    route: "/settings/devices",
    title: "Devices",
    summary: "Phones, tablets and browsers signed in to Chat.",
    keywords: ["device", "phone", "tablet", "browser", "laptop", "installation", "sign", "out", "remove", "rename"],
    category: "account",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "backup",
    route: "/settings/backup",
    title: "Chat backup",
    summary: "Keep your conversations with you.",
    keywords: ["backup", "restore", "google", "drive", "conversations", "save", "device", "transfer"],
    category: "account",
    auth: "signed-in",
    platforms: ["web", "android"],
    helpTopicId: "backup",
  },
  {
    id: "chat-preferences",
    route: "/settings/privacy/messages",
    title: "Chat preferences",
    summary: "Who can contact you.",
    keywords: ["chat", "preferences", "contact", "message", "request", "who", "can"],
    category: "account",
    auth: "signed-in",
    platforms: ["web", "android"],
  },

  // --- Preferences --------------------------------------------------------
  {
    id: "appearance",
    route: "/settings/appearance",
    title: "Appearance",
    summary: "Theme, dark mode, true black and accent.",
    keywords: ["theme", "dark", "amoled", "accent", "color", "personalization", "display"],
    category: "preferences",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "accessibility",
    route: "/settings/accessibility",
    title: "Accessibility",
    summary: "Text size and reduced motion.",
    keywords: ["font", "text", "size", "motion", "reduce", "animation", "large"],
    category: "preferences",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "feed-layout",
    route: "/settings/feed-layout",
    title: "Feed layout",
    summary: "How the Home feed arranges reports.",
    keywords: ["feed", "layout", "masonry", "grid", "columns", "photos", "home", "auto", "compact", "list"],
    category: "preferences",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "notifications",
    route: "/settings/notifications",
    title: "Notification preferences",
    summary: "Push alerts for reactions, comments and status changes.",
    keywords: ["notifications", "push", "comment", "mention", "like", "status", "report", "bell", "alert"],
    category: "preferences",
    auth: "signed-in",
    platforms: ["web", "android"],
  },

  // --- Tools --------------------------------------------------------------
  {
    id: "local-intelligence",
    route: "/settings/local-intelligence",
    title: "Local tools",
    summary: "Smart Search and matching tools.",
    keywords: ["local", "intelligence", "on", "device", "offline", "phone", "search", "helper", "needle", "downloaded", "models", "smart"],
    category: "tools",
    auth: "signed-in",
    // On-device downloads and inference exist only in the Android build. The
    // web build must not advertise a tool it cannot run.
    platforms: ["android"],
    helpTopicId: "local-search",
  },
  {
    id: "downloaded-models",
    route: "/settings/local-intelligence/downloads",
    title: "Downloaded models",
    summary: "Model files this device has downloaded.",
    keywords: ["downloaded", "models", "installed", "download", "storage", "verify", "repair", "remove", "local"],
    category: "tools",
    auth: "signed-in",
    platforms: ["android"],
  },
  {
    id: "ai",
    route: "/settings/ai",
    title: "Optional AI Chat",
    summary: "Your provider, key and chat model.",
    keywords: ["ai", "models", "model", "cloud", "chat", "providers"],
    category: "tools",
    auth: "signed-in",
    platforms: ["web", "android"],
    helpTopicId: "ai-privacy",
  },
  {
    id: "chat-models",
    route: "/settings/ai/chat-models",
    title: "Chat models",
    summary: "Which model an optional AI Chat turn uses.",
    keywords: ["chat", "models", "default", "favorite", "last", "used", "provider", "model"],
    category: "tools",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "connections",
    route: "/settings/ai/connections",
    title: "Providers",
    summary: "Cloud AI provider connections you add yourself.",
    keywords: ["providers", "cloud", "connections", "openrouter", "api", "key", "provider", "openai", "google", "mistral", "groq"],
    category: "tools",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "ai-privacy",
    route: "/settings/ai/privacy",
    title: "AI and privacy",
    summary: "What leaves your device with an optional AI provider.",
    keywords: ["ai", "privacy", "cloud", "provider", "data", "leaves", "device"],
    category: "tools",
    auth: "signed-in",
    platforms: ["web", "android"],
  },

  // --- Privacy & safety ---------------------------------------------------
  {
    id: "privacy",
    route: "/settings/privacy",
    title: "Privacy & permissions",
    summary: "Location, sharing and safety destinations.",
    keywords: ["privacy", "location", "permission", "sharing"],
    category: "safety",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "blocked-accounts",
    route: "/settings/privacy/blocked",
    title: "Blocked accounts",
    summary: "People you have blocked, and unblocking.",
    keywords: ["block", "unblock", "accounts", "people", "safety"],
    category: "safety",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "safety-reports",
    route: "/settings/privacy/reports",
    title: "Your safety reports",
    summary: "Reports you sent to the safety team and their status.",
    keywords: ["report", "abuse", "harassment", "sent", "receipts", "status"],
    category: "safety",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "appeals",
    route: "/settings/privacy/appeals",
    title: "Your appeals",
    summary: "Moderation decisions you asked us to review.",
    keywords: ["appeal", "decision", "warning", "restriction", "review", "outcome", "moderation"],
    category: "safety",
    auth: "signed-in",
    platforms: ["web", "android"],
  },

  // --- Help & about -------------------------------------------------------
  {
    id: "feedback",
    route: "/settings/feedback",
    title: "Send feedback",
    summary: "Tell us what is working and what is not.",
    keywords: ["feedback", "bug", "suggestion", "usability", "other", "support"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "help",
    route: "/settings/help",
    title: "Help & guide",
    summary: "Short guides for the everyday jobs in Norfold.",
    keywords: ["faq", "tutorial", "onboarding", "lost", "found", "search", "recover"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "replay",
    route: "/onboarding?replay=1",
    title: "Replay introduction",
    summary: "See the first-launch introduction again. Nothing is reset.",
    keywords: ["replay", "introduction", "tutorial", "walkthrough", "guide", "start"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "updates",
    route: "/settings/updates",
    title: "Updates & version history",
    summary: "What this build is, whether a newer version is ready, and what changed.",
    keywords: ["update", "updates", "version", "release", "upgrade", "newer", "changes", "history"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "about",
    route: "/settings/about",
    title: "About Norfold",
    summary: "Version, build and the product behind Norfold.",
    keywords: ["version", "build", "application"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "terms",
    route: "/settings/terms",
    title: "Terms of use",
    summary: "What Norfold is, and what each of us is responsible for.",
    keywords: ["terms", "conditions", "rules", "of", "use", "legal", "agreement"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "privacy-policy",
    route: "/settings/privacy-policy",
    title: "Privacy policy",
    summary: "What is stored, what is shared and what safety records remain.",
    keywords: ["privacy", "policy", "data", "personal", "information", "legal"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "community-guidelines",
    route: "/settings/community-guidelines",
    title: "Community guidelines",
    summary: "How people are expected to behave here.",
    keywords: ["community", "guidelines", "rules", "conduct", "behaviour", "legal"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "ask-provider",
    route: "/help",
    title: "Ask your AI provider (cloud)",
    summary: "Optional cloud chat with a provider you connect and pay for.",
    keywords: ["ai", "chat", "help", "cloud", "byok", "provider", "ask"],
    category: "help",
    auth: "signed-in",
    platforms: ["web", "android"],
  },

  // --- Advanced -----------------------------------------------------------
  {
    id: "media",
    route: "/settings/media",
    title: "Media & uploads",
    summary: "Photo quality, data use and uploads.",
    keywords: ["photo", "image", "quality", "data", "storage", "upload", "high"],
    category: "advanced",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "diagnostics",
    route: "/settings/diagnostics",
    title: "Diagnostics",
    summary: "Build details and support exports.",
    keywords: ["debug", "build", "logs", "export", "support"],
    category: "advanced",
    auth: "signed-in",
    platforms: ["web", "android"],
  },

  // --- Reports (help topics and feature links) ----------------------------
  {
    id: "report",
    route: "/report",
    title: "Report an item",
    summary: "Publish a lost or found report.",
    keywords: ["report", "lost", "found", "publish", "create"],
    category: "reports",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "search",
    route: "/search",
    title: "Search reports",
    summary: "Find reports by text, category, date and area.",
    keywords: ["search", "filter", "find", "category", "date", "area"],
    category: "reports",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "my-reports",
    route: "/my",
    title: "Your reports",
    summary: "Your reports, possible matches and closing them.",
    keywords: ["my", "reports", "matches", "possible", "recover", "close"],
    category: "reports",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
  {
    id: "notifications-inbox",
    route: "/notifications",
    title: "Notifications",
    summary: "Reactions, comments and mentions.",
    keywords: ["notifications", "inbox", "reactions", "comments", "mentions"],
    category: "reports",
    auth: "signed-in",
    platforms: ["web", "android"],
  },
];

/** Settings placement, in reading order per section. */
export const SETTINGS_PLACEMENT: readonly { id: string; section: SettingsSection }[] = [
  { id: "recovered-items", section: "account" },
  { id: "account", section: "account" },
  { id: "devices", section: "account" },
  { id: "backup", section: "account" },
  { id: "chat-preferences", section: "account" },
  { id: "appearance", section: "preferences" },
  { id: "notifications", section: "preferences" },
  { id: "accessibility", section: "preferences" },
  { id: "feed-layout", section: "preferences" },
  { id: "local-intelligence", section: "intelligence" },
  { id: "ai", section: "intelligence" },
  { id: "privacy", section: "privacy" },
  { id: "feedback", section: "more" },
  { id: "media", section: "advanced" },
  { id: "diagnostics", section: "troubleshooting" },
  { id: "terms", section: "legal" },
  { id: "privacy-policy", section: "legal" },
  { id: "community-guidelines", section: "legal" },
  { id: "updates", section: "updates" },
  { id: "help", section: "helpAbout" },
  { id: "replay", section: "helpAbout" },
  { id: "about", section: "helpAbout" },
];

const BY_ID = new Map(DESTINATIONS.map((destination) => [destination.id, destination]));

/** The record for an id, with no context filtering. */
export function destinationFor(id: string): Destination | null {
  return BY_ID.get(id) ?? null;
}

/** Placement for a destination id, if it is a Settings row. */
export function settingsSectionFor(id: string): SettingsSection | null {
  return SETTINGS_PLACEMENT.find((entry) => entry.id === id)?.section ?? null;
}

function isAvailable(destination: Destination, context: DestinationContext): DestinationResolution {
  if (!destination.platforms.includes(context.platform)) {
    return { kind: "unavailable", reason: "platform" };
  }
  if (destination.auth === "signed-in" && !context.signedIn) {
    return { kind: "unavailable", reason: "auth" };
  }
  if (destination.capability && !context.capabilities.includes(destination.capability)) {
    return { kind: "unavailable", reason: "capability" };
  }
  return { kind: "available", route: destination.route };
}

/**
 * Resolve a destination for this caller. An unknown, retired or web-incompatible
 * id is refused with a reason: it is never allowed to fall back to a default
 * route that silently sends the reader somewhere else.
 */
export function resolveDestination(id: string, context: DestinationContext): DestinationResolution {
  const destination = destinationFor(id);
  if (!destination) return { kind: "unavailable", reason: "unknown" };
  return isAvailable(destination, context);
}

/**
 * Settings rows and search entries this caller may see, in reading order. The
 * search index and the rows are generated from this one list, so they cannot
 * advertise different destinations.
 */
export function settingsDestinations(context: DestinationContext): readonly Destination[] {
  const placed: Destination[] = [];
  for (const { id } of SETTINGS_PLACEMENT) {
    const destination = destinationFor(id);
    if (!destination) continue;
    if (isAvailable(destination, context).kind === "available") placed.push(destination);
  }
  return placed;
}
