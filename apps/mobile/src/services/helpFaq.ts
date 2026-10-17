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
 * A question shows app intent when it names FindBack (or the app), asks how or
 * where the person can do something, or names an object the app owns ("my
 * report"). A lone feature keyword is not intent: `photo` sits inside
 * "photosynthesis" and `map` inside "map projections", so answering those with
 * FindBack advice replaces a failed attempt with instructions for a different
 * question (CF-070 R2 finding 1 — the substitution also cleared the draft).
 * The ambiguous topics below therefore require this signal; answers that only
 * exist as app guidance (notification behaviour) declare `appSpecific`.
 */
const APP_HELP_CONTEXT =
  /\bfindback\b|\bthe app\b|\bhow (?:do|can|should) i\b|\bwhere (?:do|can|should) i\b|\bcan i\b|\bi can'?t\b|\bhow to\b|\bturn (?:on|off)\b|\bis there a way\b|\bmy (?:accounts?|reports?|listings?|posts?|profile|drafts?|notifications?)\b/i;

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
  readonly pattern: RegExp;
  readonly answer: string;
  /**
   * The answer is app behaviour whichever question carried the keyword (the
   * notification inbox, for example). Everything else answers only when the
   * question itself shows app intent.
   */
  readonly appSpecific: boolean;
}

/** Ordered like the FAQ always was: the first topic whose pattern matches wins. */
const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "report",
    pattern: /\breports?\b|\blost\b|\bfound\b/,
    answer:
      "To report an item, open the Report tab, choose Lost or Found, add a title, description, category, date and approximate location, then review and tap Publish. A photo is optional.",
    appSpecific: false,
  },
  {
    id: "search",
    pattern: /\bsearch\b|\bfilters?\b|\bfind\b/,
    answer:
      "Open Search to search reports and filter by category, status, Lost or Found. Results come from FindBack listings, not from AI.",
    appSpecific: false,
  },
  {
    id: "status",
    pattern: /\brecover(?:y|ed|ies)?\b|\bstatus\b|\bclosed?\b|\bmatched?\b/,
    answer:
      "Open your report and use its status control to mark the item Matched, Recovered or Closed when appropriate.",
    appSpecific: false,
  },
  {
    id: "photo",
    pattern: /\bphotos?\b|\bimages?\b|\buploads?\b|\buploading\b/,
    answer:
      "You can attach a photo while preparing a report. It is uploaded when you publish. AI photo analysis is optional and sends the selected image to your connected AI provider only with your consent.",
    appSpecific: false,
  },
  {
    id: "notifications",
    pattern: /\bnotifications?\b|\bpush\b|\bbell\b|\binbox\b|\bunread\b|\bmark all read\b|\bswipe\b/,
    answer:
      "Open the bell to see notifications for reactions, comments, mentions and status changes. Opening it does not mark everything read; swipe right to toggle read, swipe left to delete, or use the row buttons. On Android you can also get a system notification, and comment notifications can be answered directly.",
    appSpecific: true,
  },
  {
    id: "reactions",
    pattern: /\bcomments?\b|\brat(?:e|es|ing|ings)\b|\blikes?\b/,
    answer:
      "Open a post to comment, react or rate it. Comments and counts update while the post is open.",
    appSpecific: false,
  },
  {
    id: "location",
    pattern: /\blocations?\b|\bmaps?\b|\bgps\b/,
    answer:
      "Choose an approximate location from the map when reporting an item. FindBack does not track you in the background.",
    appSpecific: false,
  },
  {
    id: "account-deletion",
    pattern: /\bdelet(?:e|ed|ing|ion)\b[^?]{0,20}\baccounts?\b|\baccounts?\b[^?]{0,20}\bdelet(?:e|ed|ing|ion)\b/,
    answer:
      "To delete your account, open Settings, then Account, then Delete account, and type your email to confirm. Deletion permanently removes your account, its reports and photos, and its data on our servers.",
    appSpecific: false,
  },
];

/**
 * Single, deterministic classification shared by the FAQ answer and the
 * app-help predicate, so the two can never disagree about the same question.
 */
export function classifyHelpQuestion(question: string): HelpClassification {
  const q = question.trim().toLowerCase();
  const showsAppContext = APP_HELP_CONTEXT.test(q);
  /** A gated topic: without app intent the answer is the honest scope note. */
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

  // 1. A feature this build does not ship gets an honest negative claim — but
  // only for a question that is actually about this app.
  const unavailable = matchUnavailableFeature(q);
  if (unavailable !== null) {
    return scope(
      "unavailable-feature",
      showsAppContext,
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

  // 6. Feature topics answer only when the question shows app intent.
  const topic = HELP_TOPICS.find((candidate) => candidate.pattern.test(q));
  if (topic !== undefined) {
    return scope(topic.id, topic.appSpecific || showsAppContext, topic.answer);
  }

  // 7. A claim about the app that the knowledge does not cover: do not invent it.
  if (checkAppClaim(question).status === "unknown") {
    return scope("unknown-feature", showsAppContext, UNKNOWN_FEATURE_ANSWER);
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
 * replaced by the built-in answer. Anything else (a general question a keyword
 * merely collides with) keeps the person's draft instead (CF-070 R2 finding 1).
 */
export function isAppHelpQuestion(question: string): boolean {
  return classifyHelpQuestion(question).appHelp;
}
