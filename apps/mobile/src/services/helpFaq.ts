import {
  MODEL_IDENTITY_ANSWER,
  checkAppClaim,
  isAccountLookupRequest,
  isGeneralNonAppQuestion,
  isModelIdentityQuestion,
  isVerificationQuestion,
  matchUnavailableFeature,
  mentionsAppDomain,
} from "./ai/appKnowledge";

/** Out-of-scope work (code, algorithms) — never the OTP or search FAQ. */
const GENERAL_SCOPE_ANSWER =
  "I only answer questions about the FindBack app. Try asking about reports, search, status changes, comments or photos.";

/** AI-01: Help never claims to look up accounts or contact details. */
const LOOKUP_REFUSAL =
  "FindBack can't look up accounts, email addresses or phone numbers. Search covers listings only, so use Search for items and the Profile tab for your own details.";

/** Unknown app claim: refuse to invent a feature. */
const UNKNOWN_FEATURE_ANSWER =
  "I don't know of that feature, and I won't guess. This build ships reports, search, status changes, comments, ratings, photos and email verification — see the Help tab, or ask me about one of them.";

const DEFAULT_SCOPE_ANSWER =
  "I can help with FindBack reports, search, status changes, comments, photos and account verification. Try asking about one of those features.";

const OTP_ANSWER =
  "Confirm your email with the one-time code sent at signup. Phone verification is not available in this build.";

/** Deterministic, offline FindBack help; no provider or user credential required. */
export function builtInHelp(question: string): string {
  const q = question.trim().toLowerCase();

  // 1. A feature this build does not ship gets an honest negative claim.
  const unavailable = matchUnavailableFeature(q);
  if (unavailable !== null) {
    return `FindBack does not have ${unavailable} in this build. It ships reports, search, status changes, comments, ratings, photos and email verification — see the Help tab for the list.`;
  }

  // 2. Coding or other general tasks never reach the FAQ branches (AI-03).
  if (isGeneralNonAppQuestion(question)) return GENERAL_SCOPE_ANSWER;

  // 3. Verification stays the answer for real one-time-code questions (AI-03 pair).
  if (isVerificationQuestion(question)) return OTP_ANSWER;

  // 4. Account and contact lookup is refused (AI-01).
  if (isAccountLookupRequest(question)) return LOOKUP_REFUSAL;

  // 5. Model identity is never guessed.
  if (isModelIdentityQuestion(question)) return MODEL_IDENTITY_ANSWER;

  if (/report|lost|found/.test(q)) {
    return "To report an item, open the Report tab, choose Lost or Found, add a title, description, category, date and approximate location, then review and tap Publish. A photo is optional.";
  }
  if (/\bfind\b|search|filter/.test(q)) {
    return "Open Search to search reports and filter by category, status, Lost or Found. Results come from FindBack listings, not from AI.";
  }
  if (/recover|status|closed|match/.test(q)) {
    return "Open your report and use its status control to mark the item Matched, Recovered or Closed when appropriate.";
  }
  if (/photo|image|upload/.test(q)) {
    return "You can attach a photo while preparing a report. It is uploaded when you publish. AI photo analysis is optional and sends the selected image to OpenRouter only with your consent.";
  }
  if (/comment|rating|like/.test(q)) {
    return "Open a post to comment, react or rate it. Comments and counts update while the post is open.";
  }
  if (/location|map|gps/.test(q)) {
    return "Choose an approximate location from the map when reporting an item. FindBack does not track you in the background.";
  }

  // 6. A claim about the app that the knowledge does not cover: do not invent it.
  if (checkAppClaim(question).status === "unknown" && mentionsAppDomain(question)) {
    return UNKNOWN_FEATURE_ANSWER;
  }

  return DEFAULT_SCOPE_ANSWER;
}
