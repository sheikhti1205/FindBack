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

/** The app named outright. Enough on its own, and it lifts the veto below. */
const APP_NAME_RE = /\bfindback\b|\b(?:the|this)\s+app\b/i;

/**
 * Other named platforms. The R2 retry review's counterexample is the reason
 * this exists: "How do I delete my Gmail account?" is grammatical and names an
 * object someone owns, and it is still not about this app. A named platform is
 * the one subject that can rule a question out; the list is closed on purpose
 * (services, not topics), and it only applies when the question never says
 * "FindBack".
 */
const FOREIGN_SERVICE_RE =
  /\b(?:gmail|google|outlook|hotmail|yahoo|icloud|apple|facebook|instagram|twitter|tiktok|snapchat|whatsapp|telegram|messenger|youtube|reddit|linkedin|discord|slack|zoom|netflix|spotify|amazon|ebay|paypal|dropbox|onedrive|notion|wordpress|wikipedia|chatgpt|openai|bing)\b/i;

/**
 * Evidence that a question is about THIS app, in the only two forms the FAQ
 * accepts.
 *
 * 1. Ownership — the question names FindBack (or "the app"), or an object the
 *    app owns, next to the possessive: "my report", "another user". Ownership
 *    alone is enough. It is adjacency-anchored, because "my Gmail account"
 *    owns an account and "another person" owns nothing here (both are the R2
 *    retry review's counterexamples).
 * 2. A request phrased in the app's own vocabulary — either a bounded topic
 *    phrase, or a question made of nothing but one app action (see
 *    `significantWords`). The topic words that the whole world also uses for
 *    the same task ("search", "map", "rate", "status") only count inside one
 *    of those two shapes.
 *
 * Request grammar alone ("how do I", "can I") is NOT evidence. It is how the
 * world asks about the world: "How do I bake sourdough bread?", "Can I freeze
 * leftover soup?" and "How do I search for peer-reviewed papers?" are
 * grammatical requests with no app subject, and answering them with FindBack
 * copy — and clearing the draft to do it — is the defect the R2 reviews found
 * (CF-070 R2 findings 1, 1-retry and retry-2).
 */
const APP_OWNERSHIP_RE =
  /\bfindback\b|\bthe app\b|\bthis app\b|\b(?:my|your)\s+(?:findback\s+)?(?:accounts?|reports?|items?|listings?|posts?|profile|drafts?|notifications?|comments?|photos?|matches?)\b|\banother (?:user|member)\b|\bother users?\b/i;

/** A request to do something — necessary, never sufficient, for a topic. */
const APP_ACTIVITY_REQUEST_RE =
  /\bhow (?:do|can|could|should) i\b|\bhow do you\b|\bwhere (?:do|can|should) i\b|\bcan i\b|\bi can'?t\b|\bi (?:want|need) to\b|\bhelp me\b|\bhow to\b|\bis there a way\b|\bturn (?:on|off)\b/i;

/** Articles, politeness and question grammar: never part of the subject. */
const SCAFFOLD_RE =
  /\b(?:please|the|a|an|my|your|our|their|its|it|them|this|that|these|those|to|for|on|in|into|at|of|with|from|me|us|i|you|we|do|does|did|is|are|was|be|being|been|get|got|some|any|again|properly|correctly|here|there|now|then)\b/g;

/**
 * What is left of the question once its grammar, articles and possessives are
 * gone. "How do I search?" leaves `["search"]`; "How do I search for
 * peer-reviewed papers?" leaves four words and is therefore not a request the
 * app can own by itself.
 */
function significantWords(question: string): string[] {
  return question
    .replace(APP_ACTIVITY_REQUEST_RE, " ")
    .replace(SCAFFOLD_RE, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** A question made only of this topic's own words is a request for this topic. */
function isMinimalTopicRequest(question: string, topic: HelpTopic): boolean {
  const words = significantWords(question);
  return words.length > 0 && words.every((word) => topic.ownWords.test(word));
}

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
   * and `bell` matches bicycles. The task words the whole world shares
   * (`search`, `map`, `rate`, `status`) appear only inside a phrase that names
   * what the app is searched, mapped or rated.
   */
  readonly pattern: RegExp;
  /**
   * The words this topic is allowed to own. A question whose significant words
   * are all of them is the minimal request for this topic ("how do i search?",
   * "how do I change status?") and is app help by that shape alone.
   */
  readonly ownWords: RegExp;
  readonly answer: string;
}

/** Ordered like the FAQ always was: the first topic whose pattern matches wins. */
const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "report",
    pattern:
      /\breports?\b[^?]{0,40}\b(?:lost|found)\b|\b(?:lost|found)\b[^?]{0,40}\breports?\b|\b(?:file|create|make|submit|publish|write|add)\s+(?:a|an|my|the)?\s*reports?\b|\bmy\s+reports?\b|\bdrafts?\b/,
    ownWords: /^(?:report|reports|reporting|lost|found|draft|drafts|create|add|publish)$/,
    answer:
      "To report an item, open the Report tab, choose Lost or Found, add a title, description, category, date and approximate location, then review and tap Publish. A photo is optional.",
  },
  {
    id: "search",
    pattern:
      /\b(?:search|filter|filters|browse|sort)\b[^?]{0,30}\b(?:reports?|items?|listings?|posts?|categories|category|nearby|matches|results?|feed)\b|\b(?:reports?|items?|listings?|posts?|categories|category|nearby|matches|results?|feed)\b[^?]{0,30}\b(?:search|filter|filters|browse|sort)\b|\bmy\s+reports?\b[^?]{0,30}\b(?:search|filter)\b/,
    ownWords: /^(?:search|searches|filter|filters|filtering|browse|sort|reports?|items?|listings?|posts?|categories|category|nearby|matches|results?|feed)$/,
    answer:
      "Open Search to search reports and filter by category, status, Lost or Found. Results come from FindBack listings, not from AI.",
  },
  {
    id: "status",
    pattern:
      /\b(?:mark|set)\b[^?]{0,20}\b(?:recovered|matched|closed)\b|\bmy\s+(?:reports?|items?)\b[^?]{0,20}\b(?:status|recovered|matched|closed)\b|\bstatus\b[^?]{0,20}\b(?:control|button)\b/,
    ownWords: /^(?:status|statuses|change|update|set|mark|check|view|see|recovered|recover|matched|closed|open)$/,
    answer:
      "Open your report and use its status control to mark the item Matched, Recovered or Closed when appropriate.",
  },
  {
    id: "photo",
    pattern:
      /\b(?:attach|add|upload)\s+(?:an?\s+)?(?:photos?|images?)\b|\bphotos?\s+(?:to|in|on|with)\s+(?:a|an|my|the)\s+reports?\b|\b(?:photo|image)\s+(?:upload|attachment)s?\b/,
    ownWords: /^(?:photo|photos|image|images|upload|attach|attachment|attachments|add)$/,
    answer:
      "You can attach a photo while preparing a report. It is uploaded when you publish. AI photo analysis is optional and sends the selected image to your connected AI provider only with your consent.",
  },
  {
    id: "notifications",
    pattern:
      /\bturn\s+(?:on|off)\s+(?:push\s+)?notifications?\b|\bpush\s+notifications?\b|\bnotifications?\s+settings\b|\bmark\s+all\s+(?:as\s+)?read\b|\bmy\s+notifications?\b/,
    ownWords: /^(?:notification|notifications|push|turn|on|off|read|view|see|check|manage|settings|bell)$/,
    answer:
      "Open the bell to see notifications for reactions, comments, mentions and status changes. Opening it does not mark everything read; swipe right to toggle read, swipe left to delete, or use the row buttons. On Android you can also get a system notification, and comment notifications can be answered directly.",
  },
  {
    id: "reactions",
    pattern:
      /\bleave\s+(?:a\s+)?comments?\b|\b(?:write|post|add|delete|edit)\s+(?:a\s+)?comments?\b|\bcomments?\s+on\b|\bmy\s+comments?\b|\b(?:rat(?:e|es|ing)|react(?:s|ed|ing)?|reactions?)\b[^?]{0,20}\b(?:posts?|comments?|items?|reports?|listings?|it|them)\b/,
    ownWords: /^(?:comment|comments|rate|rating|ratings|react|reaction|reactions|leave|write|post|add|edit|delete)$/,
    answer:
      "Open a post to comment, react or rate it. Comments and counts update while the post is open.",
  },
  {
    id: "location",
    pattern:
      /\b(?:choose|pick|select|set|add|change|edit|update|share)\b[^?]{0,20}\b(?:location|map|pin)\b|\b(?:location|map|pin)\b[^?]{0,20}\b(?:reports?|items?|listings?|posts?|screen|tab)\b|\bapproximate\s+location\b|\bmy\s+location\b|\bnearby\s+(?:reports?|items?|listings?)\b/,
    ownWords: /^(?:location|locations|map|maps|pin|pins|gps|choose|pick|select|set|add|change|edit|update|share|approximate|nearby)$/,
    answer:
      "Choose an approximate location from the map when reporting an item. FindBack does not track you in the background.",
  },
  {
    id: "account-deletion",
    pattern:
      /\bdelet(?:e|ed|ing|ion)\b\s+(?:my|your)\s+(?:findback\s+)?account\b|\bclos(?:e|ing)\b\s+(?:my|your)\s+(?:findback\s+)?account\b/,
    ownWords: /^(?:delete|deleted|deleting|deletion|close|closing|account|accounts|findback)$/,
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

  // 1. Model identity is never guessed; the question is about the assistant,
  // even when it names another assistant.
  if (isModelIdentityQuestion(question)) return scope("model-identity", true, MODEL_IDENTITY_ANSWER);

  // 2. Account and contact lookup is refused (AI-01). Asking FindBack to look
  // someone up is a request to the app, whatever it names.
  if (isAccountLookupRequest(question)) return scope("lookup", true, LOOKUP_REFUSAL);

  // 3. A named other platform is never this app — unless the question also
  // says "FindBack" (CF-070 R2 retry-2: "How do I delete my Gmail account?"
  // and "How do I turn off Gmail notifications?").
  if (!APP_NAME_RE.test(q) && FOREIGN_SERVICE_RE.test(q)) {
    return exact("default-scope", DEFAULT_SCOPE_ANSWER);
  }

  // 4. A feature this build does not ship gets an honest negative claim — for a
  // question that names the app or an object the app owns.
  const unavailable = matchUnavailableFeature(q);
  if (unavailable !== null) {
    return scope(
      "unavailable-feature",
      owned,
      `FindBack does not have ${unavailable} in this build. It ships reports, search, status changes, comments, ratings, photos and email verification — see the Help tab for the list.`,
    );
  }

  // 5. Coding or other general tasks never reach the FAQ branches (AI-03).
  if (isGeneralNonAppQuestion(question)) return exact("general-scope", GENERAL_SCOPE_ANSWER);

  // 6. Verification stays the answer for real one-time-code questions (AI-03
  // pair). Asking about a signup code is app help by itself.
  if (isVerificationQuestion(question)) return scope("verification", true, OTP_ANSWER);

  // 7. Feature topics: a bounded app-activity phrase, or a question made of
  // nothing but the topic's own words ("how do I search?"). Either way the
  // question must still be a request, and ownership alone is enough.
  const byPhrase = HELP_TOPICS.find((candidate) => candidate.pattern.test(q));
  const byShape = HELP_TOPICS.find((candidate) => isMinimalTopicRequest(q, candidate));
  const topic = byPhrase ?? byShape;
  if (topic !== undefined) {
    return scope(topic.id, owned || activityRequest, topic.answer);
  }

  // 8. A claim about the app that the knowledge does not cover: do not invent
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
