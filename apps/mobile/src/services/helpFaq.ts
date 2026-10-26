import { CATEGORY_CATALOG } from "@findback/shared";
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

/**
 * Unknown app claim: refuse to invent a feature AND refuse to deny one.
 *
 * The classifier can read the question but cannot place the term it names, and
 * an unplaceable term is ambiguous between a feature the app does not ship
 * ("teleportation") and a shipped feature written badly or in another language
 * ("cuenta", "passwrod", "notificatons", "profle"). It may therefore say what
 * the app does ship and that it will not guess, but it may not say the app
 * lacks anything (CF-070 R2 retry-7 R6-1).
 */
const UNKNOWN_FEATURE_ANSWER =
  "I can't place that term, so I won't guess whether FindBack has it. FindBack ships reports, search, status changes, comments, ratings, photos, location, notifications, account deletion, passwords and email verification — see the Help tab, or ask me about one of those.";

const DEFAULT_SCOPE_ANSWER =
  "I can help with FindBack reports, search, status changes, comments, ratings, photos, location, notifications and account verification. Try asking about one of those features.";

const OTP_ANSWER =
  "Confirm your email with the one-time code sent at signup. Phone verification is not available.";

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
 * Another app or platform, named as somewhere else the request happens:
 * "How do I turn off notifications from another app?". FindBack owns its own
 * notifications, and a question that moves them onto a different product is
 * not about it (CF-070 R2 retry-4 MAJOR-1, the non-`report` member of the
 * family). Narrow on purpose: "another user" and "another report" stay app
 * vocabulary.
 */
const ANOTHER_APP_RE = /\banother\s+(?:app|platform|service|site|website|product)\b/i;

/**
 * A person other than the asker. Another person's one-time code or contact
 * detail is never the asker's own signup help, so the verification branch steps
 * aside and the question fails closed (CF-070 R2 retry-4 MINOR-2). Case
 * matters for a capitalised name, so this is tested against the raw question.
 */
const FOREIGN_PERSON_RE =
  /\banother\s+user\b|\bother\s+users?\b|\buser\s+[A-Z]|\b(?:of|for|from)\s+user\s+\w+|\b(?:his|her|their|someone|somebody)\b/;

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

/**
 * Articles, politeness, request verbs, question grammar and the function words
 * an app question is made of: never the subject. The retry-4 recall rows added
 * `by`/`as`/`all`/`when`/`near`/`more`/`five` and the adjectives a person uses
 * about their own report field (`good`, `clear`, `correct`, `right`).
 */
const SCAFFOLD_RE =
  /\b(?:please|the|a|an|my|your|our|their|its|it|them|this|that|these|those|to|for|on|in|into|at|of|with|from|me|us|i|you|we|can|could|would|should|explain|tell|show|help|do|does|did|is|are|was|be|being|been|get|got|have|has|some|any|again|properly|correctly|here|there|now|then|about|by|as|all|when|after|out|near|using|more|saved|made|per|than|good|clear|correct|right|five|use|offer|why)\b/g;

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
  // The account credentials this app really ships: sign-in takes an email and
  // a password, and the sign-in screen links to password recovery
  // (`services/auth.ts` `login`/`requestPasswordReset`, `App.tsx` `/forgot`).
  "password",
  "passwords",
  "reset",
  "forgot",
  "forgotten",
  // The photo entry points the sibling knowledge file already declares
  // (`appKnowledge.ts` photo vocabulary), plus the list and publishing wording
  // an app question uses about its own screens (CF-070 R2 retry-4 MAJOR-2).
  "camera",
  "gallery",
  "picture",
  "pictures",
  "list",
  "lists",
  "publishing",
]);

/**
 * The nouns this app's own reports describe: every word of the shipped
 * category catalog — the canonical labels and their search synonyms
 * (`packages/shared/src/categories.ts`) — plus the pet animals the report
 * pipeline already matches (`services/ai/orchestrator/taskRegistry.ts` files
 * `dog|cat|parrot|pet` under its `pets` category).
 *
 * This is a taxonomy, not a list of rows: an object noun is recognised because
 * the app gives it a category, and the pet names are the animals that category
 * is about. It exists so the vocabulary veto can tell a bound object the app
 * owns from one it merely dropped into its own phrasing ("my lost backpack"
 * versus "a lost city"), which is what the retry-5 review measured as the open
 * MAJOR-1/MAJOR-2 class (CF-070 R2 retry-6 R3).
 */
const REPORT_ITEM_NOUNS: ReadonlySet<string> = new Set([
  ...CATEGORY_CATALOG.flatMap((option) => [option.canonical, ...(option.synonyms ?? [])])
    .flatMap((label) => label.split(/[^A-Za-z]+/))
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 1),
  "cat",
  "cats",
  "dog",
  "dogs",
  "parrot",
  "parrots",
]);

/** The topic's own phrasing a bound object slot carries, never the noun. */
const SLOT_SCAFFOLD_RE =
  /\b(?:lost|found|of|my|our|your|for|a|an|the|listings?|listing|to|from)\b/g;

/**
 * True when the noun a slot matched is one the app's reports describe. The
 * exemption from the vocabulary veto is granted only here: an unrecognised
 * object noun stays in the subject, where it fails the question closed instead
 * of being silently deleted and answered with FindBack copy.
 */
function slotObjectIsKnown(match: string): boolean {
  const nouns = match
    .toLowerCase()
    .replace(SLOT_SCAFFOLD_RE, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
  return (
    nouns.length > 0 &&
    nouns.every((noun) => REPORT_ITEM_NOUNS.has(noun) || APP_VOCAB.has(noun))
  );
}

/**
 * What is left of the question once its request grammar, articles,
 * possessives and any mention of the app itself are gone. "How do I search?"
 * leaves `["search"]`; "How do I upload a photo to my passport application?"
 * leaves `passport` and `application`, which no topic owns.
 *
 * The question is folded to lower case first, so a capitalised opening word
 * ("Does FindBack have …") is read as the word it is rather than as a script
 * the vocabulary cannot read. Punctuation and symbols are dropped, but letters
 * of any script are kept: a script the app's vocabulary cannot read has to be
 * able to veto the question instead of vanishing before it is judged (CF-070 R2
 * retry-4 MINOR-3).
 */
function significantWords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(APP_NAME_STRIP_RE, " ")
    .replace(APP_ACTIVITY_REQUEST_RE, " ")
    .replace(SCAFFOLD_RE, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

/** Latin letters and digits only; anything else is a script FindBack can't read. */
const LATIN_TOKEN_RE = /^[a-z0-9]+$/;

/**
 * The object a question's own wording binds — an exempt region for the
 * vocabulary veto, and exempt only when the noun it binds is one the app's
 * reports describe (`slotObjectIsKnown`). `selfBinding` is what licenses the
 * exemption, so it can never widen past the shape it belongs to, and even then
 * the bound noun itself has to be recognised: "How can I report my lost
 * backpack?" binds `backpack` and is answered, while "How do I report a lost
 * city?" binds `city`, keeps it in the subject, and fails closed — which is
 * what closes the retry-4 MAJOR-1 and retry-5 MAJOR-2 classes (CF-070 R2
 * retry-6 R3).
 */
function boundObjectSlots(question: string, topic: HelpTopic): readonly RegExp[] {
  if (topic.selfBinding !== undefined && !topic.selfBinding.test(question)) return [];
  return topic.objectSlots ?? [];
}

/** The question's words after the exempt object slots are removed. */
function subjectWords(question: string, topic: HelpTopic): string[] {
  let text = question;
  for (const slot of boundObjectSlots(question, topic)) {
    text = text.replace(slot, (match) => (slotObjectIsKnown(match) ? " " : match));
  }
  return significantWords(text);
}

/**
 * True when the question uses a word that belongs to neither this topic nor
 * this app — the subject of the request is something FindBack does not own.
 */
export function hasForeignSubject(question: string, topic: HelpTopic): boolean {
  return subjectWords(question, topic).some(
    (word) =>
      !LATIN_TOKEN_RE.test(word) ||
      (!topic.ownWords.test(word) && !APP_VOCAB.has(word)),
  );
}

/**
 * The significant terms this app's vocabulary cannot place: a word outside the
 * closed vocabulary, or letters of a script it cannot read at all.
 */
function unrecognisedTerms(question: string): readonly string[] {
  return significantWords(question).filter(
    (word) => !LATIN_TOKEN_RE.test(word) || !APP_VOCAB.has(word),
  );
}

/**
 * True when the question is written in this app's vocabulary apart from the
 * single term it names and the app cannot place ("Pets", "teleportation").
 *
 * This is one of the licences for saying anything about the app at all. A
 * question in another language is not one unknown term among recognised ones —
 * `Como elimino mi cuenta de FindBack?` is *entirely* outside the app's
 * vocabulary — so it gets no claim about the app's features at all, keeps the
 * draft, and falls back to ordinary Chat. Refusing is acceptable; telling a
 * user a shipped feature does not exist is not (CF-070 R2 retry-6 R2, L3).
 *
 * The bound is *exactly* one, not at most one: with **zero** unreadable terms
 * the question is fully written in this app's vocabulary, so the
 * unknown-feature answer — whose first sentence says it could not place the
 * term — would assert something about a term that does not exist.
 * `Does FindBack have a list?` is such a question (`list` is a vocabulary
 * word), and it now keeps the draft and falls back to ordinary Chat
 * (CF-070 R2 retry-8 F-2).
 *
 * Deliberate, and pinned: a question whose single unreadable term is a *real*
 * word in another language ("Does FindBack have cuenta?") also consumes the
 * draft, so the app answers with this copy instead of the model's. That is a
 * product choice rather than a defect — the copy says it cannot place the term
 * and declines to guess, instead of denying a shipped feature — and it is pinned
 * on both sides of the band by `helpFaq.test.ts` ("keeps the one-unreadable
 * probe a non-asserting claim about the named term"). Recorded as NIT-3 in
 * ACCEPTANCE-CF070-RETRY9-RESIDUALS.md. Tightening the bound to zero unreadable
 * terms would refuse those questions instead; that is a different product
 * choice, and it is not the one taken here.
 */
function namesOneUnknownTerm(question: string): boolean {
  return unrecognisedTerms(question).length === 1;
}

/** Two tokens one edit apart: a substitution, an insertion, a deletion, or one adjacent transposition. */
function withinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (long.length - short.length > 1) return false;
  if (short.length === long.length) {
    const differences: number[] = [];
    for (let index = 0; index < short.length; index += 1) {
      if (short[index] !== long[index]) differences.push(index);
    }
    if (differences.length <= 1) return true;
    if (differences.length !== 2) return false;
    const [first, second] = differences;
    if (first === undefined || second === undefined) return false;
    return (
      second === first + 1 &&
      short[first] === long[second] &&
      short[second] === long[first]
    );
  }
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < short.length && longIndex < long.length) {
    if (short[shortIndex] === long[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

/**
 * True when a term the vocabulary cannot place is one edit away from a word
 * this app defines, or is a truncation of one — a misspelling, a transposition
 * or a clipped word ("passwrod" → password, "notificatons" → notifications,
 * "profle" → profile, "acount" → account, "pass" → password).
 *
 * Such a term is not the name of an unknown feature: it is one of the app's own
 * concepts written badly, so it must not be read as a feature the app lacks,
 * and the question keeps the draft. The edit distance is deliberately one
 * character: tolerance any wider starts answering world nouns with app copy
 * (CF-070 R2 retry-7 R6-1).
 */
function isNearMissOfAppConcept(word: string): boolean {
  if (word.length < 3) return false;
  for (const known of APP_VOCAB) {
    if (word.length >= 4 && known.startsWith(word)) return true;
    if (withinOneEdit(word, known)) return true;
  }
  return false;
}

/**
 * A yes/no question about whether the app has something: it opens with an
 * auxiliary and names a presence verb ("Does FindBack have …?", "Does FindBack
 * offer …?", "Is a map available?").
 *
 * This is the shape that licenses answering with a statement about the app's
 * feature set at all. A request to do something ("How do I delete my FindBack
 * cuenta?") has neither, so the one term the vocabulary cannot place there is
 * the object of a shipped action, not the name of an unknown feature: it is
 * refused neutrally and the draft is kept (CF-070 R2 retry-7 R6-1).
 */
const AVAILABILITY_PROBE_RE =
  /^\s*(?:does|do|can|could|will|would|is|are|has|have|did)\b[^?]*\b(?:have|has|having|offer|offers|offered|support|supports|supported|include|includes|included|provide|provides|provided|allow|allows|allowed|available|availability|exist|exists|existing)\b/i;


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
  | "matches"
  | "account-deletion"
  | "password"
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

export interface HelpTopic {
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
   * Literal wording this topic answers in, taken from its own FAQ copy.
   * `examples[0]` is always a phrase this topic's own `pattern` matches, so a
   * test can prove the pattern is reachable and that the declared wording is
   * answered. Four `pattern` branches shipped unreachable because nothing
   * checked either (CF-070 R2 retry-4 MAJOR-2).
   */
  readonly examples: readonly string[];
  /**
   * A shape in which the topic's object is unambiguously this app's, so the
   * subject needs no vocabulary check. Only the report topic has one: the app
   * exists to report lost and found things, and the thing itself belongs to
   * the person ("my lost backpack"), so no item noun can be foreign — unlike
   * "a report for school", which the same grammar produces.
   */
  readonly selfBinding?: RegExp;
  /**
   * The positional noun phrases this topic's own phrasing claims as its object.
   * A match is removed before the vocabulary veto runs **only when the noun it
   * binds is one of the app's own report items** (`slotObjectIsKnown`), so the
   * bound object may be any item noun ("my lost backpack", "a photo of my cat",
   * "search listings for a wallet") while an unrecognised object ("a lost
   * city") and any destination the request names still have to answer for
   * themselves (CF-070 R2 retry-4 MAJOR-1, retry-6 R3). Held to `selfBinding`
   * where the topic declares one.
   */
  readonly objectSlots?: readonly RegExp[];
  readonly answer: string;
}

/**
 * Ordered like the FAQ always was: the first topic whose pattern matches wins.
 * Status and search sit ahead of the `report` catch-all because a "mark my
 * report recovered" or "search my reports" question is theirs to answer
 * (CF-070 R2 retry-4 NIT-3). Password recovery sits with the other account
 * topics: the app really does ship email+password sign-in with a password-reset
 * link (`services/auth.ts` `login`/`requestPasswordReset`, `App.tsx` `/forgot`),
 * so a password question is a modelled feature, never a refused one
 * (CF-070 R2 retry-6 R1).
 */
export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "status",
    pattern:
      /\b(?:mark|set)\b[^?]{0,20}\b(?:recovered|matched|closed)\b|\bmy\s+(?:reports?|items?)\b[^?]{0,20}\b(?:status|recovered|matched|closed)\b|\bstatus\b[^?]{0,20}\b(?:control|button)\b/,
    ownWords:
      /^(?:status|statuses|change|update|set|mark|check|view|see|recovered|recover|matched|closed|open)$/,
    examples: ["How do I mark my report as recovered?", "How do I change status?"],
    answer:
      "Open your report and use its status control to mark the item Matched, Recovered or Closed when appropriate.",
  },
  {
    id: "search",
    pattern:
      /\b(?:search|filter|filters|browse|sort)\b[^?]{0,30}\b(?:reports?|items?|listings?|posts?|categories|category|nearby|matches|results?|feed|lost|found)\b|\b(?:reports?|items?|listings?|posts?|categories|category|nearby|matches|results?|feed)\b[^?]{0,30}\b(?:search|filter|filters|browse|sort)\b|\bmy\s+reports?\b[^?]{0,30}\b(?:search|filter)\b/,
    ownWords:
      /^(?:search|searches|filter|filters|filtering|browse|sort|reports?|items?|listings?|posts?|categories|category|nearby|matches|results?|feed|find|finding|lost|found)$/,
    examples: ["How do I filter by category?", "How do I search?"],
    objectSlots: [/\b(?:lost|found)\s+[A-Za-z]+/gi, /\blistings?\s+for\s+[^?]+/gi],
    answer:
      "Open Search to search reports and filter by category, status, Lost or Found. Results come from FindBack listings, not from AI.",
  },
  {
    id: "report",
    pattern:
      /\breports?\b[^?]{0,40}\b(?:lost|found)\b|\b(?:lost|found)\b[^?]{0,40}\breports?\b|\b(?:file|create|make|submit|publish|write|add)\s+(?:a|an|my|the)?\s*reports?\b|\bmy\s+reports?\b|\bdrafts?\b|\b(?:choose|pick|select|add|set|edit|write|update|change)\b[^?]{0,20}\b(?:title|description|date|category)\b/,
    ownWords:
      /^(?:report|reports|reporting|lost|found|draft|drafts|create|add|publish|title|description|date|category)$/,
    examples: ["How can I report my lost backpack?", "How do I add a clear title?"],
    selfBinding:
      /\breport(?:s|ed|ing)?\b[^?]{0,30}\b(?:lost|found)\b|\b(?:lost|found)\b[^?]{0,30}\breport(?:s|ed|ing)?\b/,
    objectSlots: [/\b(?:lost|found)\s+[A-Za-z]+/gi],
    answer:
      "To report an item, open the Report tab, choose Lost or Found, add a title, description, category, date and approximate location, then review and tap Publish. A photo is optional.",
  },
  {
    id: "photo",
    pattern:
      /\b(?:attach|add|upload)\s+(?:an?\s+)?(?:photos?|images?)\b|\bphotos?\s+(?:to|in|on|with)\s+(?:a|an|my|the)\s+reports?\b|\b(?:photo|image)\s+(?:upload|attachment)s?\b/,
    ownWords: /^(?:photo|photos|image|images|upload|attach|attachment|attachments|add)$/,
    examples: ["How do I upload a photo from my gallery?", "How do I upload a photo?"],
    objectSlots: [/\bof\s+my\s+[A-Za-z]+\b/gi],
    answer:
      "You can attach a photo while preparing a report. It is uploaded when you publish the report. There is no AI photo analysis in the app, and a report photo is never sent to an AI provider.",
  },
  {
    id: "notifications",
    pattern:
      /\bturn\s+(?:on|off)\s+(?:push\s+)?notifications?\b|\bpush\s+notifications?\b|\bnotifications?\s+settings\b|\bmark\s+all\s+(?:as\s+)?read\b|\bmy\s+notifications?\b/,
    ownWords:
      /^(?:notification|notifications|push|turn|on|off|read|mark|view|see|check|manage|settings|bell)$/,
    examples: ["How do I mark all read?", "How do I view my notifications?"],
    answer:
      "Open the bell to see notifications for reactions, comments, mentions and status changes. Opening it does not mark everything read; swipe right to toggle read, swipe left to delete, or use the row buttons. On Android you can also get a system notification, and comment notifications can be answered directly.",
  },
  {
    id: "reactions",
    pattern:
      /\bleave\s+(?:a\s+)?comments?\b|\b(?:write|post|add|delete|edit)\s+(?:a\s+)?comments?\b|\bcomments?\s+on\b|\bmy\s+comments?\b|\b(?:rat(?:e|es|ing)|react(?:s|ed|ing)?|reactions?)\b[^?]{0,20}\b(?:posts?|comments?|items?|reports?|listings?|it|them)\b/,
    ownWords:
      /^(?:comment|comments|rate|rating|ratings|react|reaction|reactions|leave|write|post|add|edit|delete)$/,
    examples: ["How do I leave a comment?", "How do I rate a post?"],
    answer:
      "Open a post to comment, react or rate it. Comments and counts update while the post is open.",
  },
  {
    id: "location",
    pattern:
      /\b(?:choose|pick|select|set|add|change|edit|update|share)\b[^?]{0,20}\b(?:location|map|pin)\b|\b(?:location|map|pin)\b[^?]{0,20}\b(?:reports?|items?|listings?|posts?|screen|tab)\b|\bapproximate\s+location\b|\bmy\s+location\b|\bnearby\s+(?:reports?|items?|listings?)\b/,
    ownWords:
      /^(?:location|locations|map|maps|pin|pins|gps|choose|pick|select|set|add|change|edit|update|share|approximate|nearby)$/,
    examples: ["How do I choose a location?", "How do I add an approximate location?"],
    answer:
      "Choose an approximate location from the map when reporting an item. FindBack does not track you in the background.",
  },
  {
    id: "matches",
    pattern: /\bpossible\s+matches?\b/,
    ownWords: /^(?:possible|match|matches|check|see|view|find|show)$/,
    examples: ["How do I check for possible matches?", "How do I see my possible matches?"],
    answer:
      "Possible Matches are the up to three similar listings FindBack shows next to your report by similarity, never by probability. Open your report to see them.",
  },
  {
    id: "account-deletion",
    pattern:
      /\bdelet(?:e|ed|ing|ion)\b\s+(?:my|your)\s+(?:findback\s+)?account\b|\bclos(?:e|ing)\b\s+(?:my|your)\s+(?:findback\s+)?account\b/,
    ownWords: /^(?:delete|deleted|deleting|deletion|close|closing|account|accounts|findback)$/,
    examples: ["How do I delete my account?", "How do I delete my FindBack account?"],
    answer:
      "To delete your account, open Settings, then Account, then Delete account, and type your email to confirm. Deletion permanently removes your account, its reports and photos, and its data on our servers.",
  },
  {
    id: "password",
    pattern:
      /\bpassword(?:s)?\b[^?]{0,20}\b(?:reset|change|forgot|forgotten|recover|recovery)\b|\b(?:reset|change|forgot|forgotten|recover|recovery)\b[^?]{0,20}\bpassword(?:s)?\b|\bpassword(?:s)?\b/,
    ownWords: /^(?:password|passwords|reset|change|forgot|forgotten|recover|recovery|sign|signin|login)$/,
    examples: ["How do I reset my password?", "How do I change my password?"],
    answer:
      "Open the sign-in screen and tap Forgot password, then enter your email. FindBack emails a reset link to that address; opening it lets you choose a new password and signs you in. The message is the same whether or not an account uses that email.",
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
  // Runs of whitespace from a mobile keyboard ("How do   I    report    …")
  // otherwise break the request-grammar patterns and cost an answer that was
  // asked for, so they are collapsed before anything is matched (CF-070 R2
  // retry-5 L6).
  const q = question.trim().replace(/\s+/g, " ").toLowerCase();
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

  // 3b. Another app or platform the request moves onto: "How do I turn off
  // notifications from another app?" names the app's own feature and still
  // belongs to somewhere else, so it fails closed (CF-070 R2 retry-4 MAJOR-1).
  if (ANOTHER_APP_RE.test(q)) return exact("default-scope", DEFAULT_SCOPE_ANSWER);

  // 4. A feature this build does not ship gets an honest negative claim — for a
  // question that names the app or an object the app owns.
  const unavailable = matchUnavailableFeature(q);
  if (unavailable !== null) {
    return scope(
      "unavailable-feature",
      owned,
      `FindBack does not have ${unavailable}. It ships reports, search, status changes, comments, ratings, photos, location and email verification — see the Help tab for the list.`,
    );
  }

  // 5. Coding or other general tasks never reach the FAQ branches (AI-03).
  if (isGeneralNonAppQuestion(question)) return exact("general-scope", GENERAL_SCOPE_ANSWER);

  // 6. A one-time-code question is the verification FAQ, and it is checked
  // BEFORE lookup: "Where is my email verification code?" has a lookup verb and
  // an email word, and running lookup first turned the app's own signup answer
  // into a contact-details refusal (CF-070 R2 retry-3 finding 2). Another
  // person's code is not the asker's signup help, so a question that names one
  // fails closed instead of answering it with the signup instructions
  // (CF-070 R2 retry-4 MINOR-2).
  if (isVerificationQuestion(question)) {
    if (FOREIGN_PERSON_RE.test(question)) return exact("default-scope", DEFAULT_SCOPE_ANSWER);
    return scope("verification", true, OTP_ANSWER);
  }

  // 7. Account and contact lookup is refused (AI-01). Asking FindBack to look
  // someone up is a request to the app, whatever it names — but a question
  // about one's own verification code was already answered above.
  if (isAccountLookupRequest(question)) return scope("lookup", true, LOOKUP_REFUSAL);

  // 8. Feature topics. A phrase match is necessary and not sufficient: "How do
  // I search stock market reports?", "How do I write a report for school?" and
  // "How do I upload a photo to my passport application?" match the search,
  // report and photo phrases word for word. The topic therefore answers only
  // when its subject is bound to this app — by the topic's own self-binding
  // shape, or by a question that uses no word outside the app's vocabulary
  // (CF-070 R2 retry-3 finding 1, retry-4 MAJOR-1). The bound object slot is
  // the only region the veto exempts, so a self-bound question whose
  // destination is somewhere else ("report a lost wallet to the police") still
  // owes an answer for that destination. A question that binds neither keeps
  // the person's draft.
  const byPhrase = HELP_TOPICS.find((candidate) => candidate.pattern.test(q));
  const byShape = HELP_TOPICS.find((candidate) => isMinimalTopicRequest(q, candidate));
  const topic = byPhrase ?? byShape;
  // The veto reads the same folded question the phrases were matched against,
  // so a capitalised opening word cannot be mistaken for another vocabulary.
  if (topic !== undefined && !hasForeignSubject(q, topic)) {
    return scope(topic.id, true, topic.answer);
  }

  // 9. A claim about the app that the knowledge does not cover. Saying anything
  // about the app's feature set needs two things at once: the question must be
  // one this app's vocabulary can read apart from at most the single term it
  // cannot place ("Does FindBack have a Pets category?", "Does FindBack offer
  // teleportation?"), and that term must not be a bad spelling of a concept the
  // app already has ("passwrod", "notificatons", "profle", "pass"). Both
  // licences were measured as open on their own: one unplaceable token inside
  // an app question is exactly a shipped feature written in another language or
  // misspelled ("How do I delete my FindBack cuenta?"), so the claim is also
  // limited to the one shape that is a question about whether the app has
  // something at all. Everything else — another language, a typo of a shipped
  // concept, a request to do something with a term the vocabulary cannot place,
  // the retry-5 NIT-3 residual "How do I send a message to another user?" —
  // asserts nothing about the app, consumes none of the draft, and falls back
  // to ordinary Chat (CF-070 R2 retry-7 R6-1).
  if (
    owned &&
    namesOneUnknownTerm(q) &&
    unrecognisedTerms(q).every((word) => !isNearMissOfAppConcept(word)) &&
    AVAILABILITY_PROBE_RE.test(q) &&
    checkAppClaim(question).status === "unknown"
  ) {
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
