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

/** The same names, stripped out of the subject before it is judged. */
const APP_NAME_STRIP_RE = /\bfindback\b|\b(?:the|this|our)\s+app\b/g;

/**
 * A question that puts this app outside itself is not about it, whatever else
 * it says: "How do I upload a photo to Instagram, not FindBack?" (CF-070 R2
 * retry-3 finding 1).
 */
const NEGATED_APP_RE = /\bnot\s+findback\b|\bnot\s+(?:the|this)\s+app\b/i;

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
 * Evidence that a question is about THIS app.
 *
 * Ownership: the question names FindBack (or "the app"), or an object the app
 * owns, next to the possessive: "my report", "another user". It is
 * adjacency-anchored, because "my Gmail account" owns an account and "another
 * person" owns nothing here (both are the R2 retry review's counterexamples).
 * Ownership decides the negative-claim branches (a feature this build does not
 * ship, a claim the knowledge does not cover).
 *
 * Ownership alone is NOT enough for a feature topic, and request grammar alone
 * is never evidence. The retry-3 review showed why: "How can I report my lost
 * backpack?" and "How do I write a report for school?" have the same grammar
 * and the same shared task noun, and only the first is about this app. So a
 * topic answers only when its subject is BOUND to the app — either by the
 * topic's own self-binding shape (reporting a lost or found thing, whatever
 * the thing is) or by a question that uses no word outside the app's closed
 * vocabulary (`APP_VOCAB`). Everything else keeps the person's draft, which is
 * the cheap failure: a missed answer costs a retype, a wrong answer costs the
 * draft and teaches the wrong thing.
 */
const APP_OWNERSHIP_RE =
  /\bfindback\b|\bthe app\b|\bthis app\b|\b(?:my|your)\s+(?:findback\s+)?(?:accounts?|reports?|items?|listings?|posts?|profile|drafts?|notifications?|comments?|photos?|matches?)\b|\banother (?:user|member)\b|\bother users?\b/i;

/** A request to do something — necessary, never sufficient, for a topic. */
const APP_ACTIVITY_REQUEST_RE =
  /\bhow (?:do|can|could|should) i\b|\bhow do you\b|\bwhere (?:do|can|should) i\b|\bcan i\b|\bi can'?t\b|\bi (?:want|need) to\b|\bhelp me\b|\bhow to\b|\bis there a way\b|\bturn (?:on|off)\b/i;

/** Articles, politeness, request verbs and question grammar: never the subject. */
const SCAFFOLD_RE =
  /\b(?:please|the|a|an|my|your|our|their|its|it|them|this|that|these|those|to|for|on|in|into|at|of|with|from|me|us|i|you|we|can|could|would|should|explain|tell|show|help|do|does|did|is|are|was|be|being|been|get|got|have|has|some|any|again|properly|correctly|here|there|now|then|about)\b/g;

/**
 * The closed vocabulary of this app: every word a question about FindBack's
 * features can be made of, on top of its own topic's words.
 *
 * Closed on purpose, and closed at the level of ordinary words rather than of
 * named services, because the services are not the problem. The retry-3
 * review's ten counterexamples are "stock market", "school", "essay",
 * "passport application", "bank", "meeting", "employee performance review",
 * "PDF", "shop" and "Instagram" — no list of named platforms could have
 * covered school, bank, meeting, passport or PDF, and this set does not need
 * to name any of them. A question that uses a word outside it is asking about
 * something this app does not own, so the FAQ keeps the draft instead.
 */
const APP_VOCAB: ReadonlySet<string> = new Set([
  // What the app owns.
  "findback",
  "app",
  "report",
  "reports",
  "reporting",
  "item",
  "items",
  "listing",
  "listings",
  "post",
  "posts",
  "comment",
  "comments",
  "notification",
  "notifications",
  "status",
  "statuses",
  "location",
  "locations",
  "map",
  "maps",
  "pin",
  "pins",
  "photo",
  "photos",
  "image",
  "images",
  "attachment",
  "attachments",
  "profile",
  "account",
  "accounts",
  "category",
  "categories",
  "draft",
  "drafts",
  "match",
  "matches",
  "possible",
  "search",
  "searches",
  "filter",
  "filters",
  "filtering",
  "result",
  "results",
  "feed",
  "nearby",
  "bell",
  "inbox",
  "unread",
  "settings",
  "user",
  "users",
  "member",
  "members",
  "another",
  "other",
  // Fields a report carries.
  "title",
  "description",
  "date",
  "youtube",
  "link",
  "links",
  // States and words the app defines.
  "lost",
  "found",
  "open",
  "closed",
  "matched",
  "recovered",
  "recover",
  "publish",
  "published",
  "approximate",
  "gps",
  // The actions the app owns.
  "browse",
  "sort",
  "turn",
  "enable",
  "disable",
  "upload",
  "uploads",
  "attach",
  "add",
  "create",
  "make",
  "file",
  "submit",
  "write",
  "edit",
  "update",
  "change",
  "set",
  "mark",
  "remove",
  "delete",
  "deleted",
  "deleting",
  "deletion",
  "close",
  "closing",
  "find",
  "finding",
  "see",
  "view",
  "check",
  "share",
  "choose",
  "pick",
  "select",
  "react",
  "reaction",
  "reactions",
  "rate",
  "rating",
  "ratings",
  "stars",
  "leave",
  "verify",
  "verification",
  "code",
  "otp",
  "confirm",
  "consent",
  "optional",
]);

/**
 * What is left of the question once its request grammar, articles,
 * possessives and any mention of the app itself are gone. "How do I search?"
 * leaves `["search"]`; "How do I upload a photo to my passport application?"
 * leaves `passport` and `application`, which no topic owns.
 */
function significantWords(question: string): string[] {
  return question
    .replace(APP_NAME_STRIP_RE, " ")
    .replace(APP_ACTIVITY_REQUEST_RE, " ")
    .replace(SCAFFOLD_RE, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

/**
 * True when the question uses a word that belongs to neither this topic nor
 * this app — the subject of the request is something FindBack does not own.
 */
function hasForeignSubject(question: string, topic: HelpTopic): boolean {
  return significantWords(question).some(
    (word) => !topic.ownWords.test(word) && !APP_VOCAB.has(word),
  );
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
  /**
   * A shape in which the topic's object is unambiguously this app's, so the
   * subject needs no vocabulary check. Only the report topic has one: the app
   * exists to report lost and found things, and the thing itself belongs to
   * the person ("my lost backpack"), so no item noun can be foreign — unlike
   * "a report for school", which the same grammar produces.
   */
  readonly selfBinding?: RegExp;
  readonly answer: string;
}

/** Ordered like the FAQ always was: the first topic whose pattern matches wins. */
const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "report",
    pattern:
      /\breports?\b[^?]{0,40}\b(?:lost|found)\b|\b(?:lost|found)\b[^?]{0,40}\breports?\b|\b(?:file|create|make|submit|publish|write|add)\s+(?:a|an|my|the)?\s*reports?\b|\bmy\s+reports?\b|\bdrafts?\b/,
    ownWords: /^(?:report|reports|reporting|lost|found|draft|drafts|create|add|publish)$/,
    selfBinding:
      /\breport(?:s|ed|ing)?\b[^?]{0,30}\b(?:lost|found)\b|\b(?:lost|found)\b[^?]{0,30}\breport(?:s|ed|ing)?\b/,
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
 *
 * Two different questions are decided here and they must not be conflated:
 * which FAQ topic a question is closest to, and whether this app may answer it
 * at all. The second one is what costs the person their draft when it is
 * wrong. The order of the branches is part of the contract — verification
 * before lookup is a repaired regression, not a preference (CF-070 R2 retry-3
 * finding 2).
 */
export function classifyHelpQuestion(question: string): HelpClassification {
  const q = question.trim().toLowerCase();
  const owned = APP_OWNERSHIP_RE.test(q);
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

  // 2. A question that excludes this app is not about it, even when it also
  // names it: "How do I upload a photo to Instagram, not FindBack?"
  if (NEGATED_APP_RE.test(q)) return exact("default-scope", DEFAULT_SCOPE_ANSWER);

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

  // 6. A one-time-code question is the verification FAQ, and it is checked
  // BEFORE lookup: "Where is my email verification code?" has a lookup verb and
  // an email word, and running lookup first turned the app's own signup answer
  // into a contact-details refusal (CF-070 R2 retry-3 finding 2).
  if (isVerificationQuestion(question)) return scope("verification", true, OTP_ANSWER);

  // 7. Account and contact lookup is refused (AI-01). Asking FindBack to look
  // someone up is a request to the app, whatever it names — but a question
  // about one's own verification code was already answered above.
  if (isAccountLookupRequest(question)) return scope("lookup", true, LOOKUP_REFUSAL);

  // 8. Feature topics. A phrase match is necessary and not sufficient: "How do
  // I search stock market reports?", "How do I write a report for school?" and
  // "How do I upload a photo to my passport application?" match the search,
  // report and photo phrases word for word. The topic therefore answers only
  // when its subject is bound to this app — by the topic's self-binding shape,
  // or by a question made only of the app's vocabulary (CF-070 R2 retry-3
  // finding 1). A question that binds neither keeps the person's draft.
  const byPhrase = HELP_TOPICS.find((candidate) => candidate.pattern.test(q));
  const byShape = HELP_TOPICS.find((candidate) => isMinimalTopicRequest(q, candidate));
  const topic = byPhrase ?? byShape;
  if (topic !== undefined) {
    const selfBound = topic.selfBinding?.test(q) === true;
    if (selfBound || !hasForeignSubject(q, topic)) {
      return scope(topic.id, true, topic.answer);
    }
  }

  // 9. A claim about the app that the knowledge does not cover: do not invent
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
