import packageJson from "../../package.json";

/**
 * FindBack app capability/knowledge source (versioned).
 *
 * Single source of truth for what the Help Assistant may claim about the app.
 * The Supabase Edge Function `ai-help` carries a matching copy
 * (`supabase/functions/ai-help/capabilities.ts`) — bump CAPABILITIES_VERSION
 * in both files whenever shipped UI behavior changes.
 */
export const CAPABILITIES_VERSION = "1.2.0";

/** Generated from apps/mobile/package.json (the canonical SemVer source) — never a duplicated literal. */
export const APP_VERSION: string = packageJson.version;

export interface AppCapabilities {
  version: string;
  tabs: string[];
  reportFlow: string[];
  statuses: string[];
  searchFilter: string[];
  social: string[];
  location: string[];
  youtube: string;
  possibleMatches: string[];
  localVlm: string[];
  modelModes: string[];
  modelDownload: string[];
  markdown: string[];
  privacy: string[];
  emailVerification: string;
  phoneVerification: string;
  unavailable: string[];
}

export const APP_CAPABILITIES: AppCapabilities = {
  version: CAPABILITIES_VERSION,
  tabs: ["Home", "Search", "Report", "Profile"],
  reportFlow: [
    "Open the Report tab and choose Lost or Found.",
    "Fill title, description (Markdown supported), category, and event date (today or earlier).",
    "Add an optional photo, an approximate or exact location, and an optional YouTube link.",
    "Tap Publish. The photo uploads only when you publish.",
  ],
  statuses: ["OPEN", "MATCHED", "RECOVERED", "CLOSED"],
  searchFilter: [
    "Home has a type switch (All/Lost/Found) and a debounced search box.",
    "The Search tab adds category, status, and newest/oldest sort filters.",
    "The feed pages automatically as you scroll; pull down at the very top to refresh.",
    "Tapping the active Home tab refreshes and scrolls to top.",
  ],
  social: [
    "Each post supports one like or dislike per user, 1–5 star ratings, and comments.",
    "Community average rating and your own rating are shown separately.",
    "Comments and reactions update live while viewing a post.",
  ],
  location: [
    "The location field accepts a place name, decimal coordinates, a Google Maps link, or a geo: URI.",
    "Use-my-location is one-time only; the app never tracks location in the background.",
    "Default is an approximate area (~100 m); an exact pin is optional and shown publicly.",
    "Locations shown in the app can be opened in the Maps app via Open in Maps.",
  ],
  youtube: "An optional YouTube link embeds on the post page with a fallback to open YouTube.",
  possibleMatches: [
    "Open posts show up to 3 Possible Matches: open reports of the opposite type ranked by text similarity plus category, date, and location closeness.",
    "Scores are similarity, not probability. No match is shown when nothing qualifies.",
  ],
  localVlm: [
    "Offline AI lives under Profile. One downloadable on-device model: SmolVLM2 500M.",
    "The Photo AI assistant suggests a title, category, and description for the report photo.",
    "Photo AI runs fully on-device; the photo is never sent to any server for analysis.",
  ],
  modelModes: [
    "There is no inference-mode selector: the installed 500M model always runs on the GPU, with no CPU fallback.",
    "Only states shown in Offline AI are real: installed, downloading with true bytes, GPU-tested ready, or an error.",
  ],
  modelDownload: [
    "Model downloads show true MB/MB and percent, and support Pause and Resume without losing verified data.",
    "Corrupted chunks are repaired by re-fetching only the damaged ranges.",
    "Wi-Fi only is the default; cellular needs explicit opt-in.",
  ],
  markdown: [
    "Report descriptions and Help answers support Markdown: bold, italic, lists, links, quotes, code, and tables.",
    "Raw HTML, scripts, and remote images are stripped for safety.",
  ],
  privacy: [
    "Report photos stay on the device until you publish.",
    "Help Assistant questions are answered by FindBack's server and need an internet connection; photos and report contents are never attached automatically.",
    "Without a configured AI provider the server gives a built-in answer — still via the server, not offline.",
  ],
  emailVerification:
    "After registering, verify your email from the Verify screen with the real one-time code.",
  phoneVerification:
    "Phone verification is not enabled in this build because no SMS provider is configured.",
  unavailable: [
    "account deletion",
    "private messaging",
    "push notifications",
    "face recognition",
    "automatic background matching",
  ],
};
