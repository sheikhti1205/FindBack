/**
 * R3 chat relationship/safety policy — pure functions, no storage or transport.
 *
 * Authority: FindBack_Agent_Supplement_2026-10-24_R3/04_CHAT_SYNC_BACKUP_DESIGN_R3.md
 * §2 (REQUEST/CONNECTED, BLOCK separate), §3 (status), §11 (reciprocal receipts).
 *
 * Three deliberate separations this module enforces:
 * 1. BLOCK is a hard boundary flag, never a relationship mode, and every
 *    participant's own block is preserved independently.
 * 2. Trusted results are separated from what a sender may observe. `state`,
 *    `delivery` and `applied` are for the transport only; `senderVisibleSend` and
 *    `senderVisibleState` are the only projections a surface may render, and they
 *    are derived from the mode and the local request session, never from which
 *    negative action the recipient chose.
 * 3. Acceptance requires an *active* request whose initiator is the other person,
 *    so End/Decline (which clear the initiator) cannot be self-accepted.
 *
 * Nothing here authorizes anything on a server. The caller must still pass
 * server-validated, current relationship state; local policy cannot grant delivery,
 * and recipient-private fields must not be handed to the other participant.
 */

export type RelationshipMode = "REQUEST" | "CONNECTED";

/** Recipient-side negative choices. None of them is disclosed precisely. */
export type RecipientAction = "ACCEPT" | "DECLINE" | "HIDE" | "REPORT" | "BLOCK";

export interface PairState {
  /** The two participants. Order carries no meaning. */
  readonly participants: readonly [string, string];
  readonly mode: RelationshipMode;
  /**
   * Participant who opened the current request, or null when the pair has no
   * active approach (fresh pair, after End, or after a decline). Null means
   * either participant may approach next, and acceptance is not possible.
   */
  readonly initiatorId: string | null;
  /** Every participant who blocked the pair. Each choice is preserved. Never a mode. */
  readonly blockedBy: readonly string[];
  /** Recipients who muted this request in their own inbox. Recipient-private. */
  readonly hiddenBy: readonly string[];
  /** Text messages sent during the current request session. */
  readonly requestMessageCount: number;
  /** Whether the current request session already produced its one external nudge. */
  readonly nudged: boolean;
}

export interface OutgoingDraft {
  body: string;
  /** Attachments are a CONNECTED-only capability. */
  mediaCount?: number;
  /** Deliberate one-time location share is CONNECTED-only. */
  locationShared?: boolean;
}

/** Trusted transport decision. MUST NOT be surfaced to the sender. */
export type Delivery = "DELIVER" | "WITHHOLD";

export interface SendAccepted {
  ok: true;
  state: PairState;
  body: string;
  /** Sender-visible: derived only from the mode and the local request session. */
  nudge: boolean;
  mediaAllowed: boolean;
  linkify: boolean;
  delivery: Delivery;
}

export interface Rejected {
  ok: false;
  /** Single opaque reason: never "blocked", "declined" or "hidden". */
  reason: "REJECTED";
}

export type SendResult = SendAccepted | Rejected;

export interface StateChange {
  ok: true;
  state: PairState;
  /** Trusted effect. MUST NOT be surfaced to the other participant. */
  applied: boolean;
}

export type StateResult = StateChange | Rejected;

/**
 * The only sender-visible projection of a send. `state`, `delivery` and `applied`
 * are deliberately absent: `state` carries recipient-private `blockedBy`/
 * `hiddenBy`, and `delivery`/`applied` carry the transport decision. A surface
 * must render this projection, never the raw result.
 */
export interface SenderVisibleSend {
  ok: true;
  body: string;
  nudge: boolean;
  mediaAllowed: boolean;
  linkify: boolean;
}

export function senderVisibleSend(result: SendResult): SenderVisibleSend | Rejected {
  if (!result.ok) return REJECTED;
  return {
    ok: true,
    body: result.body,
    nudge: result.nudge,
    mediaAllowed: result.mediaAllowed,
    linkify: result.linkify,
  };
}

/** The only sender-visible projection of a relationship transition: success or one opaque failure. */
export function senderVisibleState(result: StateResult): { ok: true } | Rejected {
  return result.ok ? { ok: true } : REJECTED;
}

/** What one participant may observe about the relationship. Action-independent. */
export interface InitiatorProjection {
  mode: RelationshipMode;
  /**
   * Attribute-blind composer availability: never reveals the other person's
   * action, and never a delivery guarantee. A blocked sender still sees it.
   */
  composerAvailable: boolean;
  outcome: "AWAITING" | "CONNECTED";
}

/** What one participant may see about their own controls. Never shared across participants. */
export interface RecipientProjection {
  mode: RelationshipMode;
  blocked: boolean;
  hidden: boolean;
  canRespond: boolean;
}

export interface ReceiptPreferences {
  senderEnabled: boolean;
  recipientEnabled: boolean;
}

export type DeliveryState = "SENDING" | "SENT" | "FAILED";
export type VisibleStatus = DeliveryState | "READ";

const REJECTED: Rejected = Object.freeze({ ok: false, reason: "REJECTED" });

/** Storage-input bound only; not a product decision about request-stage limits. */
const MAX_BODY_UNITS = 100_000;

/** Common suffixes used by the conservative pre-acceptance gate. */
const DOMAIN_SUFFIXES = new Set([
  "com", "net", "org", "io", "co", "app", "social", "dev", "me", "info",
  "biz", "xyz", "gg", "link", "site", "online", "edu", "gov", "tv", "ai",
  "fr", "uk", "de", "eu", "ca", "au", "in", "us",
]);

/**
 * Character classes, not regular expressions. A `[)…]+$` regex backtracks
 * quadratically on a long punctuation run followed by an ordinary character, so
 * both the trailing-punctuation strip and the host check are explicit single-pass
 * loops. The body bound is large enough that this matters.
 */
const TRAILING_PUNCTUATION = new Set([")", ",", ".", ";", ":", "!", "?", "'", "\"", "]", "}"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const WWW = /^www\./i;

function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0) {
    const char = token[end - 1];
    if (char === undefined || !TRAILING_PUNCTUATION.has(char)) break;
    end -= 1;
  }
  return token.slice(0, end);
}

/** Dot-separated labels of ASCII alphanumerics/hyphens or non-ASCII characters. */
function isHostName(host: string): boolean {
  if (!host) return false;
  let labels = 0;
  let start = 0;
  for (let index = 0; index <= host.length; index += 1) {
    if (index < host.length && host[index] !== ".") {
      const code = host.charCodeAt(index);
      const allowed =
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2d ||
        code >= 0xa1;
      if (!allowed) return false;
      continue;
    }
    if (index === start) return false;
    labels += 1;
    start = index + 1;
  }
  return labels >= 2;
}

function isParticipant(state: PairState, actorId: string): boolean {
  return state.participants.includes(actorId);
}

function isBlocked(state: PairState): boolean {
  return state.blockedBy.length > 0;
}

function blockedFor(state: PairState, actorId: string): boolean {
  return state.blockedBy.includes(actorId);
}

function normalizeBody(body: string): string | null {
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_BODY_UNITS) return null;
  return trimmed;
}

/**
 * Conservative, linear-time pre-acceptance link gate. This is not the security
 * boundary: every REQUEST result also reports `linkify: false`, and the renderer
 * must show plain text with no autolinking or Markdown links. Obfuscated forms
 * (`example[.]com`, spaced `www . example . com`, unusual TLDs) may pass here and
 * must still never become clickable.
 */
export function containsLink(body: string): boolean {
  if (body.includes("://")) return true;
  for (const raw of body.split(/\s+/)) {
    if (!raw) continue;
    const token = stripTrailingPunctuation(raw);
    if (!token) continue;
    if (SCHEME.test(token) || WWW.test(token)) return true;
    const at = token.indexOf("@");
    if (at > 0 && token.indexOf(".", at) > at) return true;
    // Only the host part matters: paths, queries, fragments and ports do not
    // change whether the token is a link, and cutting them keeps this linear.
    const pathStart = token.search(/[/?#]/);
    const authority = pathStart === -1 ? token : token.slice(0, pathStart);
    const portStart = authority.indexOf(":");
    const host = portStart === -1 ? authority : authority.slice(0, portStart);
    const dot = host.lastIndexOf(".");
    if (dot <= 0 || dot === host.length - 1) continue;
    if (!DOMAIN_SUFFIXES.has(host.slice(dot + 1).toLowerCase())) continue;
    if (isHostName(host)) return true;
  }
  return false;
}

/** Deep-enough copy: nested arrays are cloned and frozen so callers cannot alias them. */
function withState(state: PairState, patch: Partial<PairState>): PairState {
  const merged = { ...state, ...patch };
  merged.participants = Object.freeze([...merged.participants]) as unknown as [string, string];
  merged.blockedBy = Object.freeze([...merged.blockedBy]) as unknown as string[];
  merged.hiddenBy = Object.freeze([...merged.hiddenBy]) as unknown as string[];
  return Object.freeze(merged) as PairState;
}

/** Open a request on behalf of `actorId` when the pair has no active approach. */
export function applyApproach(state: PairState, actorId: string): StateResult {
  if (!isParticipant(state, actorId) || state.mode !== "REQUEST") return REJECTED;
  if (state.initiatorId !== null && state.initiatorId !== actorId) return REJECTED;
  return {
    ok: true,
    state: withState(state, { initiatorId: actorId }),
    applied: !isBlocked(state),
  };
}

/**
 * Validate and project one outgoing message.
 * REQUEST: text only, initiator only, no links/media/location, one nudge per session.
 * CONNECTED: normal private chat.
 * A block withholds delivery without changing anything the sender can observe.
 */
export function applySend(state: PairState, actorId: string, draft: OutgoingDraft): SendResult {
  if (!isParticipant(state, actorId)) return REJECTED;
  const body = normalizeBody(draft?.body ?? "");
  if (body === null) return REJECTED;
  const wantsMedia = (draft.mediaCount ?? 0) > 0 || draft.locationShared === true;
  const delivery: Delivery = isBlocked(state) ? "WITHHOLD" : "DELIVER";

  if (state.mode === "CONNECTED") {
    return {
      ok: true,
      state: withState(state, {}),
      body,
      nudge: false,
      mediaAllowed: true,
      linkify: true,
      delivery,
    };
  }

  // REQUEST stage.
  if (state.initiatorId !== null && state.initiatorId !== actorId) return REJECTED;
  if (wantsMedia) return REJECTED;
  if (containsLink(body)) return REJECTED;

  return {
    ok: true,
    state: withState(state, {
      initiatorId: actorId,
      requestMessageCount: state.requestMessageCount + 1,
      nudged: true,
    }),
    body,
    nudge: !state.nudged,
    mediaAllowed: false,
    linkify: false,
    delivery,
  };
}

/**
 * Recipient-side decision.
 * - BLOCK is allowed in either mode and preserves every participant's own choice.
 * - ACCEPT/DECLINE/HIDE/REPORT require an *active* request (non-null initiator)
 *   where the actor is the recipient. End/Decline clear the initiator, so they can
 *   never be re-accepted without a new approach.
 * - A block anywhere withholds acceptance; the actor sees an ordinary "not
 *   connected" state, never the other participant's private block.
 */
export function applyRecipientAction(state: PairState, actorId: string, action: RecipientAction): StateResult {
  if (!isParticipant(state, actorId)) return REJECTED;

  if (action === "BLOCK") {
    if (blockedFor(state, actorId)) return { ok: true, state: withState(state, {}), applied: false };
    return {
      ok: true,
      state: withState(state, { blockedBy: [...state.blockedBy, actorId] }),
      applied: true,
    };
  }

  if (state.mode !== "REQUEST" || state.initiatorId === null || state.initiatorId === actorId) {
    return REJECTED;
  }

  switch (action) {
    case "ACCEPT":
      if (isBlocked(state)) return { ok: true, state: withState(state, {}), applied: false };
      return {
        ok: true,
        state: withState(state, {
          mode: "CONNECTED",
          initiatorId: null,
          hiddenBy: [],
          requestMessageCount: 0,
          nudged: true,
        }),
        applied: true,
      };
    case "DECLINE":
      // Keep the request session's nudge state so the sender cannot tell a decline
      // from a hide or report through the next message's nudge bit.
      return {
        ok: true,
        state: withState(state, { initiatorId: null, hiddenBy: [] }),
        applied: true,
      };
    case "HIDE":
      return {
        ok: true,
        state: withState(state, {
          hiddenBy: state.hiddenBy.includes(actorId) ? [...state.hiddenBy] : [...state.hiddenBy, actorId],
        }),
        applied: true,
      };
    case "REPORT":
      // Reporting never upgrades the relationship and never closes it for the sender.
      return { ok: true, state: withState(state, {}), applied: true };
    default:
      return REJECTED;
  }
}

/** End connection: back to REQUEST, history preserved, either person may approach again. */
export function applyEnd(state: PairState, actorId: string): StateResult & { historyRetained?: true } {
  if (!isParticipant(state, actorId) || state.mode !== "CONNECTED") return REJECTED;
  return {
    ok: true,
    applied: true,
    historyRetained: true,
    state: withState(state, {
      mode: "REQUEST",
      initiatorId: null,
      hiddenBy: [],
      requestMessageCount: 0,
      nudged: false,
    }),
  };
}

/** Initiator-visible projection: deliberately independent of the recipient's action. */
export function initiatorProjection(state: PairState, viewerId: string): InitiatorProjection {
  return {
    mode: state.mode,
    composerAvailable: isParticipant(state, viewerId),
    outcome: state.mode === "CONNECTED" ? "CONNECTED" : "AWAITING",
  };
}

/** Own-controls projection. A block or hide is visible only to the participant who chose it. */
export function recipientProjection(state: PairState, viewerId: string): RecipientProjection {
  const participant = isParticipant(state, viewerId);
  const ownBlock = blockedFor(state, viewerId);
  return {
    mode: state.mode,
    blocked: participant && ownBlock,
    hidden: participant && state.hiddenBy.includes(viewerId),
    canRespond:
      participant &&
      state.mode === "REQUEST" &&
      state.initiatorId !== null &&
      state.initiatorId !== viewerId &&
      !ownBlock,
  };
}

/** Read receipts require an accepted chat and mutual opt-in. */
export function receiptEligible(state: PairState, receipts: ReceiptPreferences): boolean {
  return state.mode === "CONNECTED" && receipts.senderEnabled && receipts.recipientEnabled;
}

/** Request-stage messages stay Sent/Failed even if the server recorded a read. */
export function outgoingStatus(
  state: PairState,
  message: { delivery: DeliveryState; readByRecipient?: boolean },
  receipts: ReceiptPreferences,
): VisibleStatus {
  if (message.delivery !== "SENT") return message.delivery;
  if (!message.readByRecipient) return "SENT";
  return receiptEligible(state, receipts) ? "READ" : "SENT";
}
