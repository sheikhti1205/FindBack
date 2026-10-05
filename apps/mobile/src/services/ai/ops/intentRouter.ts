/**
 * Lane B intent router: classify-intent → route-intent → validated app action CTA.
 *
 * Deterministic-first, pure, no side effects. This module never navigates,
 * never writes, never calls a model: it proposes a destination CTA that the
 * caller renders visibly and only follows through deterministic validated
 * application actions (the Help ACTION_ROUTES allowlist). OPEN_MAP keeps its
 * location precondition: without caller-confirmed location there is no CTA.
 *
 * `getAssistantDefault()` is the narrow Lane A seam: Lane A owns the
 * persisted Assistant default store and will implement this getter. Until
 * then it returns null (fallback-safe); callers must handle null as "no
 * persisted default".
 */
import type { Intent } from "../types";
import { loadAiPreferences } from "../aiPreferences";
import type { RouteDestination } from "./routeIntent";

export type AssistantIntent = Intent;
export type AssistantRoute = RouteDestination;

/** Allowed proposed destination CTA. `target` is a validated in-app route. */
export interface IntentCta {
  readonly id: string;
  readonly label: string;
  readonly target: string;
}

export interface ResolvedAssistantIntent {
  readonly intent: AssistantIntent;
  readonly route: AssistantRoute;
  /** Present only when the route maps to an allowed navigable CTA. */
  readonly cta: IntentCta | null;
  /** Present only when the route is ASK_USER (clarify, never navigate). */
  readonly clarification?: string;
}

/**
 * Narrow Lane A seam: reads the persisted Assistant default choice for this
 * account (null = Automatic, resolved to the free route at send time).
 * Returns the RAW stored choice, never the resolved fallback: callers use
 * null to mean "no explicit choice" (Help seeds its session override to
 * Automatic; the picker shows every row selectable). No account, no storage,
 * or any failure reads as null. Never throws.
 */
export function getAssistantDefault(accountId?: string): string | null {
  try {
    if (accountId === undefined || accountId.trim() === "") return null;
    const stored = loadAiPreferences(accountId).preferredAssistantModel;
    return stored !== null && stored.trim() !== "" ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic-first Assistant entry classifier (standard entry router).
 * Pure keyword rules; ambiguous/empty input falls through to UNKNOWN so the
 * model path (classify-intent op) can clarify via ASK_USER. Never invents.
 */
export function classifyAssistantIntent(text: string): AssistantIntent {
  const input = text.trim();
  if (input === "") return "UNKNOWN";
  const lower = input.toLowerCase();
  // A question about how the app works is an app-question even when it names
  // a flow ("how do I report a lost item?" asks, it does not report).
  if (/^(how|what|where|when|why|can|could|would|is|are|do|does|help)\b/.test(lower)) return "APP_QUESTION";
  // T07: "I lost something." with no item detail is ambiguous — clarify via
  // ASK_USER rather than opening the wrong flow.
  if (/\b(something|anything|stuff)\b/.test(lower) && !/\b(keys|wallet|phone|bag|umbrella|backpack|laptop|dog|cat|pet|passport|jacket|coat)\b/.test(lower)) {
    return "UNKNOWN";
  }
  if (/\b(lost|missing)\b/.test(lower)) return "REPORT_LOST";
  if (/\b(found|find owner|returned to owner)\b/.test(lower)) return "REPORT_FOUND";
  if (/\b(search|find|look for|looking for|filter|browse)\b/.test(lower)) {
    // "I found X" is a found report, not a search — found wins above, so a
    // bare "find" here is a search request.
    if (/\b(found|find owner)\b/.test(lower) && /\b(owner|returned)\b/.test(lower)) return "REPORT_FOUND";
    return "SEARCH";
  }
  if (/\b(how|help|what|report|account|settings|verify|notification|photo|status|comment|map)\b/.test(lower)) {
    return "APP_QUESTION";
  }
  if (/\b(hello|hi|hey|thanks|thank you)\b/.test(lower) && !/\b(lost|found|search|report|find)\b/.test(lower)) {
    return "OPEN_QUESTION";
  }
  return "UNKNOWN";
}

/** Deterministic intent → route mapping (code-owned, never model-chosen). */
export function routeForIntent(intent: AssistantIntent): AssistantRoute {
  switch (intent) {
    case "REPORT_LOST":
      return "OPEN_REPORT_LOST";
    case "REPORT_FOUND":
      return "OPEN_REPORT_FOUND";
    case "SEARCH":
      return "OPEN_SEARCH";
    case "APP_QUESTION":
      return "OPEN_HELP";
    case "OPEN_QUESTION":
    case "UNKNOWN":
      return "ASK_USER";
  }
}

/**
 * Validated route → CTA. Returns null when there is no navigable CTA
 * (ASK_USER needs clarification) or when the OPEN_MAP location precondition
 * fails. Never invents targets: every CTA target is a shipped in-app route.
 */
export function ctaForRoute(
  route: AssistantRoute,
  options?: { readonly hasLocation?: boolean },
): IntentCta | null {
  switch (route) {
    case "OPEN_SEARCH":
      return { id: "OPEN_SEARCH", label: "Open search", target: "/search" };
    case "OPEN_REPORT_LOST":
      return { id: "OPEN_REPORT_LOST", label: "Start lost report", target: "/report" };
    case "OPEN_REPORT_FOUND":
      return { id: "OPEN_REPORT_FOUND", label: "Start found report", target: "/report" };
    case "OPEN_HELP":
      return { id: "OPEN_HELP", label: "Open help", target: "/help" };
    case "OPEN_MAP":
      if (options?.hasLocation !== true) return null;
      return { id: "OPEN_MAP", label: "Open map", target: "/search" };
    case "ASK_USER":
      return null;
  }
}

/**
 * Full deterministic chain: classify → route → validated CTA. Pure: proposes,
 * never navigates. ASK_USER resolves to a clarification prompt instead of a CTA.
 */
export function resolveAssistantIntent(
  text: string,
  options?: { readonly hasLocation?: boolean },
): ResolvedAssistantIntent {
  const intent = classifyAssistantIntent(text);
  const route = routeForIntent(intent);
  if (route === "ASK_USER") {
    return {
      intent,
      route,
      cta: null,
      clarification: "Could you say a little more about what you need — a lost report, a found report, a search, or a question about the app?",
    };
  }
  return { intent, route, cta: ctaForRoute(route, options) };
}
