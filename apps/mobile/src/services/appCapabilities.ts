import packageJson from "../../package.json";

/**
 * FindBack app capability/knowledge source (versioned).
 *
 * Single source of truth for what the Help Assistant may claim about the app.
 * A matching copy is kept server-side at
 * `supabase/functions/ai-help/capabilities.ts` — bump CAPABILITIES_VERSION
 * in both files whenever shipped UI behavior changes.
 *
 * BYOK cloud requests and explicit verified Android offline installs are
 * separate paths. Installed weights do not prove hardware speed or quality;
 * measured backend claims remain evidence-gated.
 */
export const CAPABILITIES_VERSION = "1.9.0-integration";

/** Generated from apps/mobile/package.json (the canonical SemVer source) — never a duplicated literal. */
export const APP_VERSION: string = packageJson.version;

/**
 * Expected backend/schema capability of this build (static build metadata).
 * Matches the newest data-contract migration prefix the app was built
 * against; shown in Profile → About for release diagnosis.
 */
export const BACKEND_SCHEMA_VERSION = "20261006120000";

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
  notifications: string[];
  aiConnection: string[];
  photoAnalysis: string[];
  helpAssistant: string[];
  markdown: string[];
  privacy: string[];
  emailVerification: string;
  phoneVerification: string;
  accountDeletion: string;
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
    "USE text embeddings are the default. On Android, an installed Needle model can be explicitly selected as the matching challenger in AI & Models for this session; it is not an automatic quality upgrade.",
  ],
  notifications: [
    "The bell opens a notification inbox for likes, dislikes, comments, mentions and status changes. Opening it never marks everything read.",
    "Each row can be marked read or unread, and deleted; a delete can be undone for a few seconds. Swipe right to toggle read, swipe left to delete, and the same actions are available as buttons.",
    "Android shows a system notification for report activity when push is allowed; comment notifications can be answered directly from the notification.",
  ],
  aiConnection: [
    "AI is optional: connect a cloud AI provider key under Settings → AI & intelligence → Cloud connections (/settings/ai/connections), or explicitly install on-device models under Settings → AI & models → On-device AI (/settings/ai/models) on Android.",
    "OpenRouter is the default and uses only its free route (openrouter/free); it never switches to a paid model. Keys you add — OpenRouter, Anthropic, Google, Mistral, Groq, xAI, Cohere, OpenAI, DeepSeek or a custom endpoint — stay on the device and are never sent to FindBack's servers.",
    "Free-only by default: a paid or variable-price route is never selected without explicit per-model, per-price confirmation, and an unknown price is never treated as free.",
    "Android model downloads start only when you tap Download. You can pause and resume, and remove the model; only checksum-verified files become installed. The web build does not offer on-device downloads or inference.",
    "CPU is the on-device default. Measure CPU and Measure GPU run the installed SmolVLM2 correctness corpus and report TTFT and tokens per second. A fresh passing measurement can select the vision backend for this session; the language decoder remains CPU. GPU initialization failure is announced before an explicit CPU retry. Physical-device performance is not yet established.",
  ],
  photoAnalysis: [
    "The create-report photo assistant suggests a title, category, and description. It runs only when you tap Analyze photo and confirm the consent notice.",
    "Analyze photo is local-first on Android when the verified SmolVLM2 runtime is available: automatic mode tries on-device inference first and may fall back to the connected OpenRouter provider only after local failure; nothing is analyzed in the background.",
    "On-device-only never sends the photo to the cloud; cloud-only skips local inference and routes that one request through your connected AI provider.",
  ],
  helpAssistant: [
    "Help answers are generated by the AI provider you connect (OpenRouter's free route by default, or any other provider you added a key for).",
    "On Android, the Help model picker lists verified installed conversational models (SmolVLM2 for descriptions of explicitly approved images) without a provider key. Needle runs automatically in the background for structured item-detail extraction and matching — it never appears as a chat selection. These are specialized tasks, not a general offline support chatbot.",
    "With no cloud provider connected and no selected compatible offline model, Help gives a built-in answer.",
  ],
  markdown: [
    "Report descriptions and Help answers support Markdown: bold, italic, lists, links, quotes, code, and tables.",
    "Raw HTML, scripts, and remote images are stripped for safety.",
  ],
  privacy: [
    "Report photos stay on the device until you publish.",
    "AI requests leave the device only through the provider you connect with your own key (OpenRouter on its free route by default). Help questions you type use that path, and a report photo reaches it only for the cloud leg: automatic mode after local failure, or cloud-only. Report contents are never attached automatically.",
    "On-device inference uses approved inputs on the device without a provider key. Downloading weights needs a network connection and an explicit tap. Automatic photo analysis may fall back to the connected provider after local failure. An on-device-only request never leaves the device.",
  ],
  emailVerification:
    "After registering, verify your email from the Verify screen with the real one-time code.",
  phoneVerification:
    "Phone verification is not enabled in this build because no SMS provider is configured.",
  accountDeletion:
    "Delete your account from Settings > Account. Typing your email confirms permanent deletion of the account, its reports and photos, and its server data.",
  unavailable: [
    "private messaging",
    "face recognition",
    "automatic background matching",
  ],
};

// ---------------------------------------------------------------------------
// Measured-state-gated copy.
//
// Static facts explain reachable installs and specialized tasks. Automatic
// backend and performance claims stay hidden until measured evidence passes
// (see `./ai/uiGates.ts`). The getters below return measured copy only with
// flags; with no evidence they return a conservative hidden-state line that
// claims nothing about speed or automation. No string here may claim a
// backend is faster, automatic, or magic — measured winners are described as
// "the measured backend", never as "GPU-faster" or "auto-magic".
// ---------------------------------------------------------------------------

/** Explicit measured/probe flags gating WS7 capability copy. All default off. */
export interface MeasuredCapabilityFlags {
  /** At least one fresh, correctness-passing device probe exists. */
  readonly hasFreshAutoProbe: boolean;
  /** An offline model is installed with a verified checksum. */
  readonly hasVerifiedOfflineModel: boolean;
  /** Fresh, passing Needle measurement evidence exists. */
  readonly hasNeedleEvidence: boolean;
  /** A fresh, passing GPU probe is the measured winner. */
  readonly hasFreshGpuProbe: boolean;
}

/** Default flags: no evidence, every gated affordance stays hidden. */
export const MEASURED_FLAGS_NONE: MeasuredCapabilityFlags = {
  hasFreshAutoProbe: false,
  hasVerifiedOfflineModel: false,
  hasNeedleEvidence: false,
  hasFreshGpuProbe: false,
};

/**
 * Automatic-backend copy. Shown only with a fresh passing probe; otherwise
 * the affordance is hidden and the app serves the safe CPU fallback.
 */
export function getAutoCapabilityCopy(flags: MeasuredCapabilityFlags): string[] {
  if (flags.hasFreshAutoProbe === true) {
    return [
      "Automatic backend choice is shown because a fresh on-device measurement passed its correctness check; the measured backend is used, otherwise the safe CPU fallback is served.",
    ];
  }
  return [
    "Automatic backend choice is hidden: no fresh passing measurement on this device, so the safe CPU fallback is served.",
  ];
}

/**
 * Offline-model copy. Shown only with a verified install; otherwise hidden
 * while download controls remain available on Android.
 */
export function getOfflineCapabilityCopy(flags: MeasuredCapabilityFlags): string[] {
  if (flags.hasVerifiedOfflineModel === true) {
    return [
      "Offline use is shown because a model is installed with a verified checksum; downloads start only on explicit user action.",
    ];
  }
  return [
    "Offline use is hidden: no verified model is installed on this device.",
  ];
}

/**
 * Needle copy. Shown only with fresh, passing measurement evidence;
 * otherwise hidden with no capability claims.
 */
export function getNeedleCapabilityCopy(flags: MeasuredCapabilityFlags): string[] {
  if (flags.hasNeedleEvidence === true) {
    return [
      "Needle details are shown because a fresh measurement passed its correctness check on this device.",
    ];
  }
  return ["Needle details are hidden: no fresh passing measurement on this device."];
}

/**
 * GPU copy. Shown only when a fresh, passing GPU probe is the measured
 * winner; otherwise hidden. Never claims a GPU is faster in general — only
 * that this device measured it for the current model revision.
 */
export function getGpuCapabilityCopy(flags: MeasuredCapabilityFlags): string[] {
  if (flags.hasFreshGpuProbe === true) {
    return [
      "GPU use is shown because this device measured it with a fresh probe that passed its correctness check for the current model; other devices may measure differently.",
    ];
  }
  return ["GPU details are hidden: no fresh passing measurement on this device."];
}
