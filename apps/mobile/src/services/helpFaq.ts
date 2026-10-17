import {
  MODEL_IDENTITY_ANSWER,
  checkAppClaim,
  isAccountLookupRequest,
  isGeneralNonAppQuestion,
  isModelIdentityQuestion,
  isVerificationQuestion,
  matchUnavailableFeature,
} from "./ai/appKnowledge";

/** Out-of-scope work (code, algorithms) — never the OTP or search FAQ. */
const GENERAL_SCOPE_ANSWER =
  "I only answer questions about the FindBack app. Try asking about reports, search, status changes, comments or photos.";

/** AI-01: Help never claims to look up accounts or contact details. */
const LOOKUP_REFUSAL =
  "FindBack can't look up accounts, email addresses or phone numbers. Search covers listings only, so use Search for items and the Profile tab for your own details.";

/** Unknown app claim: refuse to invent a feature. */
const UNKNOWN_FEATURE_ANSWER =
  "I don't know of that feature, and I won't guess. This build ships reports, search, status changes, comments, ratings, photos, notifications and email verification — see the Help tab, or ask me about one of them.";

const DEFAULT_SCOPE_ANSWER =
  "I can help with FindBack reports, search, status changes, comments, photos, notifications and account verification. Try asking about one of those features.";

const OTP_ANSWER =
  "Confirm your email with the one-time code sent at signup. Phone verification is not available in this build.";

/**
 * Evidence that a question is about THIS app, in the only two forms the FAQ
 * accepts.
 *
 * 1. Ownership — the question names FindBack (or "the app"), or an object the
 *    app owns ("my report", "another user"). Ownership alone is enough.
 * 2. An app-activity request — the bounded topic phrase below, and only when
 *    the question is actually asking to do something.
 *
 * Request grammar alone ("how do I", "can I") is NOT evidence. It is how the
 * world asks about the world: "How do I bake sourdough bread?" and "Can I
 * freeze leftover soup?" are grammatical requests with no app subject, and
 * answering them with FindBack copy — and clearing the draft to do it — is the
 * defect the R2 reviews found (CF-070 R2 findings 1 and 1-retry). For the same
 * reason no topic is "app-specific" by its own vocabulary: a bicycle bell is
 * not a notification, and "photos" is not photo upload.
 */
const APP_OWNERSHIP_RE =
  /\bfindback\b|\bthe app\b|\bthis app\b|\bmy (?:accounts?|reports?|listings?|posts?|profile|drafts?|notifications?)\b|\banother (?:user|person|member|account)\b|\bother users?\b/i;

/** A request to do something — necessary, never sufficient, for a topic. */
const APP_ACTIVITY_REQUEST_RE =
  /\bhow (?:do|can|could|should) i\b|\bhow do you\b|\bwhere (?:do|can|should) i\b|\bcan i\b|\bi can'?t\b|\bi (?:want|need) to\b|\bhelp me\b|\bhow to\b|\bis there a way\b|\bturn (?:on|off)\b/i;

export type HelpTopicId =
  | "unavailable-feature"
  | "general-scope"
  | "verification"
  | "lookup"
  | "model-identity"
  | "report"
  | "search"
  | "status"
  | "photo"
  | "notifications"
  | "reactions"
  | "location"
  | "account-deletion"
  | "unknown-feature"
  | "default-scope";

export interface HelpClassification {
  /** Which FAQ branch owns this question, "default-scope" when none does. */
  readonly topic: HelpTopicId;
  /** What FindBack answers with, ready to render. */
  readonly answer: string;
  /** True when that answer really is guidance about THIS question. */
  readonly appHelp: boolean;
}

interface HelpTopic {
  readonly id: HelpTopicId;
  /**
   * Bounded app-activity phrasing. Never a bare common noun: `photo` matches
   * photosynthesis, `map` matches map projections, `find` matches arithmetic,
   * and `bell` matches bicycles.
   */
  readonly pattern: RegExp;
  readonly answer: string;
}

/** Ordered like the FAQ always was: the first topic whose pattern matches wins. */
const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "report",
    pattern:
      /\breports?\b[^?]{0,40}\b(?:lost|found)\b|\b(?:lost|found)\b[^?]{0,40}\breports?\b|\b(?:file|create|make|submit|publish|write)\s+(?:a|an|my|the)?\s*reports?\b|\bmy\s+reports?\b/,
    answer:
      "To report an item, open the Report tab, choose Lost or Found, add a title, description, category, date and approximate location, then review and tap Publish. A photo is optional.",
  },
  {
    id: "search",
    pattern: /\bsearch\b|\bfilters?\b/,
    answer:
      "Open Search to search reports and filter by category, status, Lost or Found. Results come from FindBack listings, not from AI.",
  },
  {
    id: "status",
    pattern: /\brecover(?:y|ed|ies)?\b|\bstatus\b|\bclosed?\b|\bmatched?\b/,
    answer:
      "Open your report and use its status control to mark the item Matched, Recovered or Closed when appropriate.",
  },
  {
    id: "photo",
    pattern:
      /\b(?:attach|add|upload)\s+(?:an?\s+)?(?:photos?|images?)\b|\bphotos?\s+(?:to|in|on|with)\s+(?:a|an|my|the)\s+reports?\b|\b(?:photo|image)\s+(?:upload|attachment)s?\b/,
    answer:
      "You can attach a photo while preparing a report. It is uploaded when you publish. AI photo analysis is optional and sends the selected image to your connected AI provider only with your consent.",
  },
  {
    id: "notifications",
    pattern:
      /\bturn\s+(?:on|off)\s+(?:push\s+)?notifications?\b|\bpush\s+notifications?\b|\bnotifications?\s+(?:settings|inbox|bell)\b|\bmark\s+all\s+(?:as\s+)?read\b|\bmy\s+notifications?\b/,
    answer:
      "Open the bell to see notifications for reactions, comments, mentions and status changes. Opening it does not mark everything read; swipe right to toggle read, swipe left to delete, or use the row buttons. On Android you can also get a system notification, and comment notifications can be answered directly.",
  },
  {
    id: "reactions",
    pattern:
      /\bleave\s+(?:a\s+)?comments?\b|\b(?:write|post|add|delete|edit)\s+(?:a\s+)?comments?\b|\bcomments?\s+on\b|\brat(?:e|es|ing|ings)\b|\bmy\s+comments?\b/,
    answer:
      "Open a post to comment, react or rate it. Comments and counts update while the post is open.",
  },
  {
    id: "location",
    pattern: /\blocations?\b|\bmaps?\b|\bgps\b/,
    answer:
      "Choose an approximate location from the map when reporting an item. FindBack does not track you in the background.",
  },
  {
    id: "account-deletion",
    pattern: /\bdelet(?:e|ed|ing|ion)\b[^?]{0,20}\baccounts?\b|\baccounts?\b[^?]{0,20}\bdelet(?:e|ed|ing|ion)\b/,
    answer:
      "To delete your account, open Settings, then Account, then Delete account, and type your email to confirm. Deletion permanently removes your account, its reports and photos, and its data on our servers.",
  },
];

/**
 * Single, deterministic classification shared by the FAQ answer and the
 * app-help predicate, so the two can never disagree about the same question.
 */
export function classifyHelpQuestion(question: string): HelpClassification {
  const q = question.trim().toLowerCase();
  const owned = APP_OWNERSHIP_RE.test(q);
  const activityRequest = APP_ACTIVITY_REQUEST_RE.test(q);
  const scope = (topic: HelpTopicId, appHelp: boolean, answer: string): HelpClassification => ({
    topic,
    answer: appHelp ? answer : DEFAULT_SCOPE_ANSWER,
    appHelp,
  });
  const exact = (topic: HelpTopicId, answer: string): HelpClassification => ({
    topic,
    answer,
    appHelp: false,
  });

  // 1. A feature this build does not ship gets an honest negative claim — for a
  // question that names the app or an object the app owns.
  const unavailable = matchUnavailableFeature(q);
  if (unavailable !== null) {
    return scope(
      "unavailable-feature",
      owned,
      `FindBack does not have ${unavailable} in this build. It ships reports, search, status changes, comments, ratings, photos and email verification — see the Help tab for the list.`,
    );
  }

  // 2. Coding or other general tasks never reach the FAQ branches (AI-03).
  if (isGeneralNonAppQuestion(question)) return exact("general-scope", GENERAL_SCOPE_ANSWER);

  // 3. Verification stays the answer for real one-time-code questions (AI-03
  // pair). Asking about a signup code is app help by itself.
  if (isVerificationQuestion(question)) return scope("verification", true, OTP_ANSWER);

  // 4. Account and contact lookup is refused (AI-01). Asking FindBack to look
  // someone up is a request to the app, whatever it names.
  if (isAccountLookupRequest(question)) return scope("lookup", true, LOOKUP_REFUSAL);

  // 5. Model identity is never guessed; the question is about the assistant.
  if (isModelIdentityQuestion(question)) return scope("model-identity", true, MODEL_IDENTITY_ANSWER);

  // 6. Feature topics: the bounded app-activity phrasing plus either ownership
  // or an actual request. Grammar on its own never reaches the FAQ.
  const topic = HELP_TOPICS.find((candidate) => candidate.pattern.test(q));
  if (topic !== undefined) {
    return scope(topic.id, owned || activityRequest, topic.answer);
  }

  // 7. A claim about the app that the knowledge does not cover: do not invent
  // it, and only claim it when the question names the app.
  if (owned && checkAppClaim(question).status === "unknown") {
    return scope("unknown-feature", true, UNKNOWN_FEATURE_ANSWER);
  }

  return exact("default-scope", DEFAULT_SCOPE_ANSWER);
}

/**
 * Deterministic, offline FindBack help; no provider or user credential required.
 */
export function builtInHelp(question: string): string {
  return classifyHelpQuestion(question).answer;
}

/**
 * True only when the question really is app help, so a failed send may be
 * replaced by the built-in answer. Anything else (a general question that only
 * shares grammar or vocabulary with one) keeps the person's draft instead
 * (CF-070 R2 finding 1).
 */
export function isAppHelpQuestion(question: string): boolean {
  return classifyHelpQuestion(question).appHelp;
}
