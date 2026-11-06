import {
  destinationFor,
  resolveDestination,
  type DestinationContext,
  type DestinationPlatform,
} from "./destinations";

/**
 * Offline Help articles (S6).
 *
 * Every article is static text: no provider key, no network, no model call. A
 * topic may point at one catalogue destination, and the Help screen renders that
 * destination through the same resolver the rest of the app uses, so Help can
 * never advertise a row the caller cannot reach. Articles state the limits that
 * matter (best-effort backup, downloaded models, place-name scope, cloud chat)
 * instead of promising an outcome.
 */
export type HelpGroup = "Reports" | "Your account" | "Privacy" | "More help";

export type HelpTopic = Readonly<{
  id: string;
  title: string;
  summary: string;
  keywords: readonly string[];
  group: HelpGroup;
  body: readonly string[];
  /** Catalogue destination this article opens, if any. */
  destinationId?: string;
  platforms: readonly DestinationPlatform[];
}>;

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "report-lost",
    title: "Report a lost item",
    summary: "Choose Lost on the Report tab, add details and publish.",
    keywords: ["lost", "report", "publish", "missing"],
    group: "Reports",
    destinationId: "report",
    platforms: ["web", "android"],
    body: [
      "A report needs enough detail for the right person to recognise the item: what it is, roughly when and where, and a photo if you have one.",
      "Keep identifying details private. The person who claims it can describe them to you directly.",
    ],
  },
  {
    id: "report-found",
    title: "Report a found item",
    summary: "Choose Found on the Report tab, add details and publish.",
    keywords: ["found", "report", "publish", "handed in"],
    group: "Reports",
    destinationId: "report",
    platforms: ["web", "android"],
    body: [
      "Found reports work like lost reports, with one difference: leave out the detail that would prove ownership.",
      "Ask the person who contacts you to describe it before you hand anything over.",
    ],
  },
  {
    id: "search-filter",
    title: "Search and filter reports",
    summary: "Find reports by text, category, status, and sort order.",
    keywords: ["search", "filter", "category", "status", "sort", "find"],
    group: "Reports",
    destinationId: "search",
    platforms: ["web", "android"],
    body: [
      "Word search runs on Norfold's servers, so it can match shared reports this device has never loaded. A place name narrows the reports already loaded here rather than searching the whole world.",
      "You can always review and change the filters yourself, including when Smart Search suggests some.",
    ],
  },
  {
    id: "possible-matches",
    title: "Possible matches",
    summary: "Open one of your reports to see its Possible Matches.",
    keywords: ["matches", "possible", "similar", "suggestion"],
    group: "Reports",
    destinationId: "my-reports",
    platforms: ["web", "android"],
    body: [
      "Possible Matches compares your report with others that look similar.",
      "A match is a suggestion, not proof of ownership and not a promise of recovery. Check the details before you act on it.",
    ],
  },
  {
    id: "recover-close",
    title: "Recover or close a report",
    summary: "Mark your report recovered or closed from your reports.",
    keywords: ["recover", "recovered", "close", "closed", "resolve"],
    group: "Reports",
    destinationId: "my-reports",
    platforms: ["web", "android"],
    body: [
      "Marking a report recovered records the outcome and takes it out of active matching.",
      "Closing a report keeps it in your history. You can publish a new report later if you need to.",
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    summary: "Reactions, comments, and mentions land in your inbox.",
    keywords: ["notifications", "reactions", "comments", "mentions", "inbox"],
    group: "Your account",
    destinationId: "notifications-inbox",
    platforms: ["web", "android"],
    body: [
      "The inbox collects reactions, comments and mentions on your reports and messages.",
      "Push delivery depends on the device and its system settings. A missed push is not a lost message: everything stays in the inbox.",
    ],
  },
  {
    id: "backup",
    title: "Back up your chats",
    summary: "Automatic backup is best-effort and needs Google Drive.",
    keywords: ["backup", "restore", "drive", "chats", "conversations", "switch device"],
    group: "Your account",
    destinationId: "backup",
    platforms: ["web", "android"],
    body: [
      "Chat backup copies your conversations to your own Google Drive, encrypted with your account's backup key. Norfold cannot read them.",
      "It is best-effort: a pass needs a connection, available storage and an authorised Drive, and cannot run while the app is closed. Do not treat it as a guarantee.",
      "If Norfold reports that a backup needs repair, the existing copy is kept as it is until a safe replacement can be written.",
    ],
  },
  {
    id: "devices",
    title: "Devices signed in to Chat",
    summary: "Devices means the installations enrolled for Chat, not every browser.",
    keywords: ["devices", "sessions", "installations", "remove", "sign out"],
    group: "Your account",
    destinationId: "devices",
    platforms: ["web", "android"],
    body: [
      "This list shows the installations enrolled for encrypted Chat under your account.",
      "Removing one stops it receiving new chat keys. It does not delete reports or photos, and it does not sign you out everywhere.",
    ],
  },
  {
    id: "delete-account",
    title: "Delete your account",
    summary: "What is removed, and which safety records remain.",
    keywords: ["delete", "account", "remove", "erase", "close account"],
    group: "Your account",
    destinationId: "account",
    platforms: ["web", "android"],
    body: [
      "Deleting your account removes your reports and photos.",
      "Limited safety records remain as described in the Privacy policy, and other people's existing copies cannot be erased.",
      "You can still cancel from the confirmation step before the deletion starts.",
    ],
  },
  {
    id: "local-search",
    title: "Local tools and Smart Search",
    summary: "Downloading model files does not prove the helper is running.",
    keywords: ["local", "smart search", "models", "downloaded", "offline", "helper", "needle"],
    group: "Privacy",
    destinationId: "local-intelligence",
    // On-device tools exist only in the Android build; the web guide must not
    // offer an article about downloads it cannot run.
    platforms: ["android"],
    body: [
      "Local tools run on this device. Downloading a model file, installing it and loading it are separate steps, and only a search that actually ran can improve your filters.",
      "When the helper is unavailable, ordinary text search and your own filters keep working. Nothing is sent to a cloud provider as a substitute.",
    ],
  },
  {
    id: "ai-privacy",
    title: "AI and privacy",
    summary: "Optional AI features and what leaves your device.",
    keywords: ["ai", "privacy", "cloud", "provider", "data"],
    group: "Privacy",
    destinationId: "ai-privacy",
    platforms: ["web", "android"],
    body: [
      "Optional AI Chat sends the messages you write, and only those, to the provider you connected with your own key.",
      "Your provider is only used for AI Chat. Search, reports and filters keep working without a key.",
    ],
  },
  {
    id: "ask-provider",
    title: "Ask your AI provider (cloud)",
    summary: "Cloud chat with a provider you connect. It is not Norfold support.",
    keywords: ["ai", "chat", "help", "cloud", "provider", "byok", "ask"],
    group: "More help",
    destinationId: "ask-provider",
    platforms: ["web", "android"],
    body: [
      "This is an optional cloud chat with a model provider you connect and pay for yourself. It is not app support and it cannot change your reports, messages or settings.",
      "The offline articles on this page work without a connection or a provider key. Use Send feedback for the product itself.",
    ],
  },
  {
    id: "replay-intro",
    title: "Replay introduction",
    summary: "See the first-launch introduction again. Nothing is reset.",
    keywords: ["replay", "introduction", "tutorial", "walkthrough"],
    group: "More help",
    destinationId: "replay",
    platforms: ["web", "android"],
    body: [
      "The introduction explains the same reports, search and messaging ideas covered here.",
      "Replaying it changes no data and does not repeat first-launch setup.",
    ],
  },
];

const BY_ID = new Map(HELP_TOPICS.map((topic) => [topic.id, topic]));

export function helpTopicFor(id: string): HelpTopic | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Articles this caller can see, with any unavailable destination resolved out
 * first. An article whose destination cannot be reached is not offered.
 */
export function helpTopics(context: DestinationContext): readonly HelpTopic[] {
  return HELP_TOPICS.filter((topic) => {
    if (!topic.platforms.includes(context.platform)) return false;
    if (!topic.destinationId) return true;
    if (!destinationFor(topic.destinationId)) return false;
    return resolveDestination(topic.destinationId, context).kind === "available";
  });
}
