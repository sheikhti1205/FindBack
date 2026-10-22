/**
 * TRUST — the client surface of the recovery relationship, the participant
 * return ratings, the standing, the DERIVED reputation tier and the
 * interaction limits the server enforces.
 *
 * THE SERVER OWNS EVERY VALUE IN HERE. A recovery is a durable RELATIONSHIP
 * (`successful_returns` row), not `item_posts.status = 'RECOVERED'` — the
 * status merely travels with it. A rating is written by one participant of a
 * recovery about the other one, once per direction. Standing, reputation and
 * the interaction limits are DERIVED at call time from the rows that already
 * exist: there is no stored score, no tier column, no counter table.
 *
 * REPUTATION IS NEVER COMPUTED OR CACHED HERE. The tier the server returns is
 * a LABEL (NEW / NORMAL / TRUSTED); the server's own derivation (the ratings
 * about an account plus the serious part of its standing) is the only truth,
 * and a client-side average would be a second, divergent one. This file
 * therefore never averages the ratings it reads, never stores a reputation
 * number and never serves one from memory: every call asks the server.
 *
 * A RATING CANNOT NAME ITS TARGET. `findback_rate_return()` takes no
 * rated-user parameter — the counterpart is derived from the recovery row — so
 * a client cannot submit a rating about an arbitrary person and cannot submit
 * one about itself at all. The client's own guards mirror the server's own
 * refusals for the cases that can be decided without a round trip; every
 * refusal that needs the server's knowledge is SURFACED, never pre-empted
 * with a guess.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT — read from
 * `supabase/migrations/20261023020000_trust_blocks_feedback_recovery.sql`
 * (D3-TRUST). The line numbers below are that file's.
 *
 *   markRecovered(draft)
 *     -> findback_mark_recovered(p_post_id text, p_helper_kind text,
 *                                 p_helper_user_id text default null)
 *        returns text — the successful_returns row id            [lines 283-288]
 *
 *   listMyRecoveries()
 *     -> findback_my_recoveries()
 *        returns table (successful_return_id text, lost_post_id text,
 *                       counterpart_user_id text, external_helper boolean,
 *                       recovered_at text, my_rating integer,
 *                       counterpart_rating integer)                [lines 392-401]
 *
 *   rateReturn(draft)
 *     -> findback_rate_return(p_return_id text, p_score integer)
 *        returns text — the return_ratings row id                 [lines 499-500]
 *
 *   listReturnRatings(returnId)
 *     -> findback_return_ratings(p_return_id text)
 *        returns table (rater_user_id text, rated_user_id text,
 *                       score integer, created_at text)           [lines 575-581]
 *
 *   fetchStanding()
 *     -> findback_standing(p_user text default null)
 *        returns text — GOOD | PROBATION | RESTRICTED | SUSPENDED | BANNED
 *                                                                   [lines 692-694]
 *
 *   fetchReputationTier(userId)
 *     -> findback_reputation_tier(p_user text)
 *        returns text — NEW | NORMAL | TRUSTED                     [lines 744-745]
 *
 *   fetchPostLimit()
 *     -> findback_post_limit()
 *        returns table (limit_per_day integer,
 *                       burst_cooldown_seconds integer)            [lines 800-801]
 *
 *   fetchInteractionLimits()
 *     -> findback_base_interaction_limit() returns integer        [lines 84-85]
 *      + findback_post_limit()    returns the table above         [lines 800-801]
 *
 *   fetchActiveSanctionKind(userId)
 *     -> findback_active_sanction_kind(p_user text) returns text  [lines 645-646]
 *        REVOKED from `public, anon, authenticated` [line 679], so it is NOT a
 *        client surface: the call is answered with the typed unavailable
 *        outcome, never with an invented kind. `fetchStanding()` is the
 *        client-visible surface.
 *
 *   NOT a client surface: findback_enforce_interaction_limit() — a BEFORE
 *   INSERT trigger on item_posts and comments, revoked from every client role
 *   [line 928] and returning `trigger` [line 875]. The client never calls it:
 *   the guard fires on the write itself and refuses with P0001
 *   'POST_LIMIT_REACHED' or 'POST_COOLDOWN'. `isInteractionLimitRefusal()`
 *   recognises exactly those two words.
 */
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";
import { SANCTION_KINDS, type SanctionKind } from "./moderation";

/** The three helper kinds the server accepts for a recovery (MC D25). */
export const RECOVERY_HELPER_KINDS = ["FINDBACK_USER", "OUTSIDE", "SELF_OR_PRIVATE"] as const;

export type RecoveryHelperKind = (typeof RECOVERY_HELPER_KINDS)[number];

/** What the reader is told. A raw database word is never shown to a reader. */
export const RECOVERY_HELPER_KIND_LABELS: Readonly<Record<RecoveryHelperKind, string>> = {
  FINDBACK_USER: "Someone on FindBack",
  OUTSIDE: "Someone outside FindBack",
  SELF_OR_PRIVATE: "I found it myself",
};

/** The five standings the server derives (a WARNING is a note, not a standing). */
export const STANDINGS = ["GOOD", "PROBATION", "RESTRICTED", "SUSPENDED", "BANNED"] as const;

export type Standing = (typeof STANDINGS)[number];

/** What the reader is told about their own standing. */
export const STANDING_LABELS: Readonly<Record<Standing, string>> = {
  GOOD: "In good standing",
  PROBATION: "On probation",
  RESTRICTED: "Restricted",
  SUSPENDED: "Suspended",
  BANNED: "Banned",
};

/** The three reputation tiers the server derives. Never a score — a label. */
export const REPUTATION_TIERS = ["NEW", "NORMAL", "TRUSTED"] as const;

export type ReputationTier = (typeof REPUTATION_TIERS)[number];

/** What the reader is told. The tier itself stays a server-owned word. */
export const REPUTATION_TIER_LABELS: Readonly<Record<ReputationTier, string>> = {
  NEW: "New",
  NORMAL: "Established",
  TRUSTED: "Trusted",
};

/** One recovery the caller takes part in, as the server exposes it. */
export interface MyRecovery {
  /** `successful_return_id` — the recovery relationship's own id. */
  returnId: string;
  /** `lost_post_id` — the lost report this recovery belongs to. */
  lostPostId: string;
  /**
   * `counterpart_user_id` — the other participant. It is NULL when the item
   * was returned by somebody outside the app or by the owner themselves: the
   * recovery exists, the person is not named.
   */
  counterpartUserId: string | null;
  /** `external_helper` — true when the helper was not a FindBack account. */
  externalHelper: boolean;
  /** `recovered_at` — the server's instant, in the server's text format. */
  recoveredAt: string;
  /**
   * `my_rating` — the score the CALLER gave the counterpart, or null when the
   * caller has not rated yet.
   */
  myRating: number | null;
  /**
   * `counterpart_rating` — the score the counterpart gave ABOUT the caller, or
   * null when there is none.
   */
  counterpartRating: number | null;
}

/** One rating of one recovery, exactly as the server returns it. */
export interface ReturnRating {
  /** The account that gave the rating. */
  raterUserId: string | null;
  /** The account the rating is about. */
  ratedUserId: string | null;
  /** 1–5. Never averaged here: the average is the server's derivation. */
  score: number;
  /** The server's instant, in the server's text format. */
  createdAt: string;
}

/** What the server enforces on a write. */
export interface InteractionLimit {
  /** How many posts and comments the caller may write per UTC day. */
  limitPerDay: number;
  /** The cooldown between two writes, in seconds. */
  burstCooldownSeconds: number;
}

/** The base number and the limit derived from it. */
export interface InteractionLimits extends InteractionLimit {
  /**
   * The ONE base number every ceiling is a multiple of (owner decision O3):
   * NORMAL is base, TRUSTED is twice it, the report and feedback ceilings are
   * twice it.
   */
  baseLimitPerDay: number;
}

/** The write that records a successful return — the "confirmed match" write. */
export interface MarkRecoveredInput {
  /** The lost report being confirmed — `p_post_id`. */
  postId: string;
  /** Which kind of helper returned it — `p_helper_kind`. */
  helperKind: RecoveryHelperKind;
  /**
   * The helper's account id — `p_helper_user_id`. Required for
   * FINDBACK_USER and forbidden for OUTSIDE and SELF_OR_PRIVATE: an outside or
   * private helper is not an account, and naming one would publish a name the
   * owner asked not to disclose.
   */
  helperUserId?: string | null;
  /**
   * The signed-in account's id, when the screen knows it (`fetchMe()` provides
   * it). It is used ONLY by the local guard that mirrors the server's "a
   * FindBack helper must be another account" refusal and is never sent to the
   * server.
   */
  selfUserId?: string | null;
}

/** A rating the caller is about to give. */
export interface ReturnRatingDraft {
  /** The recovery being rated — `p_return_id`. */
  returnId: string;
  /** The score to give: an integer from 1 to 5 — `p_score`. */
  score: number;
  /**
   * The recovery row the screen is acting on, when it has one. It is used
   * ONLY by the local guard below; nothing in it is ever sent to the server.
   */
  recovery?: MyRecovery | null;
  /**
   * The signed-in account's id, when the screen knows it. Local guard only,
   * never sent to the server.
   */
  selfUserId?: string | null;
}

/**
 * The code every "this build cannot do that" answer carries.
 *
 * The trust migration may not be applied to the project the app is pointed at,
 * and PostgREST then answers PGRST202 ("could not find the function") — a
 * schema term that must never reach a reader. The client turns that into this
 * one typed outcome so a screen can say "not available in this build" instead
 * of showing a fake value.
 */
export const TRUST_UNAVAILABLE_CODE = "RPC_UNAVAILABLE";

const UNAVAILABLE_MESSAGE = "This part of the trust system is not available in this build.";

const SANCTION_KIND_UNAVAILABLE_MESSAGE =
  "The sanction kind is not available to this app. Your standing is the surface you can read.";

/**
 * Is this the typed "not available in this build" answer?
 *
 * A screen asks this before it offers an empty list, a zero limit or a
 * "nothing to show" state: an unavailable surface and an empty one are
 * different facts and must not look the same.
 */
export function isTrustUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === TRUST_UNAVAILABLE_CODE;
}

/**
 * The server's refusal is an answer, not a transport failure.
 *
 *   42501  the server says "you may not do this" (403);
 *   22023  the request itself is wrong — a score out of range, no counterpart
 *           to rate, a helper that is not another account (400);
 *   28000  there is no signed-in account (401);
 *   P0002  the recovery, the report or the helper does not exist (404);
 *   23505  the row already exists — a second recovery, a second rating in the
 *           same direction (409);
 *   P0001  a limit refusal — POST_LIMIT_REACHED / POST_COOLDOWN (429);
 *   PGRST202 / 42883  the function is not there for this client at all (501,
 *           the typed unavailable outcome).
 *
 * Everything else is a server trouble and must not be reported as the user's
 * own mistake.
 */
function trustError(message: string, code?: string): ApiError {
  if (code === "42501") return new ApiError(message, 403, code);
  if (code === "22023") return new ApiError(message, 400, code);
  if (code === "28000") return new ApiError(message, 401, code);
  if (code === "P0002") return new ApiError(message, 404, code);
  if (code === "23505") return new ApiError(message, 409, code);
  if (code === "P0001") return new ApiError(message, 429, code);
  // The server's own words here are a schema term ("could not find the
  // function ... in the schema cache"), so the reader gets a plain sentence
  // and the type carries the truth.
  if (code === "PGRST202" || code === "42883") {
    return new ApiError(UNAVAILABLE_MESSAGE, 501, TRUST_UNAVAILABLE_CODE);
  }
  if (!code && /fetch failed|network|failed to fetch|load failed|timeout/i.test(message)) {
    return new ApiError(message, 503, "SERVICE_UNREACHABLE");
  }
  return new ApiError(message, 500, code);
}

function optionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function isRecoveryHelperKind(value: unknown): value is RecoveryHelperKind {
  return typeof value === "string" && (RECOVERY_HELPER_KINDS as readonly string[]).includes(value);
}

function isStanding(value: unknown): value is Standing {
  return typeof value === "string" && (STANDINGS as readonly string[]).includes(value);
}

function isReputationTier(value: unknown): value is ReputationTier {
  return typeof value === "string" && (REPUTATION_TIERS as readonly string[]).includes(value);
}

function isSanctionKind(value: unknown): value is SanctionKind {
  return typeof value === "string" && (SANCTION_KINDS as readonly string[]).includes(value);
}

/**
 * Mark a lost report recovered — the "confirmed match" write.
 *
 * The server writes the durable recovery row and moves the report's own status
 * to RECOVERED in the same transaction, and returns the recovery row's id. One
 * report can be recovered ONCE: a second attempt is refused by the server
 * (23505) and that refusal is surfaced here, not swallowed.
 *
 * The local guards mirror the server's own refusals for the cases that need
 * no round trip (no report, an unknown helper kind, a helper that is not
 * another account). Everything else — who may confirm, whether the report was
 * already recovered — is the server's answer and is surfaced as it came.
 */
export async function markRecovered(input: MarkRecoveredInput): Promise<string> {
  const postId = input.postId.trim();
  if (!postId) throw new ApiError("A report is required.", 400, "MISSING_POST_ID");
  if (!isRecoveryHelperKind(input.helperKind)) {
    throw new ApiError("Choose who returned the item.", 400, "UNKNOWN_HELPER_KIND");
  }

  const helper = optionalId(input.helperUserId);
  const self = optionalId(input.selfUserId);
  if (input.helperKind === "FINDBACK_USER") {
    if (!helper) throw new ApiError("A FindBack helper is required.", 400, "MISSING_HELPER_ID");
    if (self && helper === self) {
      throw new ApiError(
        "A FindBack helper must be another account; mark a self-recovery as self or private.",
        400,
        "SELF_HELPER",
      );
    }
  } else if (helper) {
    // The server refuses this too: an outside or private helper is not an
    // account, and accepting an id here would publish a name the owner asked
    // not to disclose.
    throw new ApiError("An outside or private helper has no account.", 400, "HELPER_HAS_NO_ACCOUNT");
  }

  const { data, error } = await getSupabase().rpc("findback_mark_recovered", {
    p_post_id: postId,
    p_helper_kind: input.helperKind,
    p_helper_user_id: helper,
  });
  if (error) throw trustError(error.message, error.code);
  if (typeof data !== "string" || !data.trim()) {
    throw new ApiError("The server did not confirm the recovery.", 500, "UNEXPECTED_SHAPE");
  }
  return data;
}

/**
 * The caller's own recoveries.
 *
 * A block never hides this record: the recovery is the shared fact that
 * something came back, and the two people of a completed return keep their
 * rating eligibility even after blocking each other.
 *
 * A row without a recovery id cannot be acted on, so it is dropped rather
 * than rendered as an empty entry.
 */
export async function listMyRecoveries(): Promise<MyRecovery[]> {
  const { data, error } = await getSupabase().rpc("findback_my_recoveries", {});
  if (error) throw trustError(error.message, error.code);
  return ((data ?? []) as Record<string, unknown>[])
    .map((row) => ({
      returnId: String(row.successful_return_id ?? "").trim(),
      lostPostId: String(row.lost_post_id ?? "").trim(),
      counterpartUserId: optionalId(row.counterpart_user_id),
      externalHelper: row.external_helper === true,
      recoveredAt: String(row.recovered_at ?? ""),
      myRating: optionalCount(row.my_rating),
      counterpartRating: optionalCount(row.counterpart_rating),
    }))
    .filter((row) => row.returnId !== "");
}

/**
 * Rate the other participant of a recovery.
 *
 * Once per direction, and never about yourself: the server DERIVES the rated
 * user from the recovery row, so this call has no rated-user parameter at all
 * and cannot name one. The local guards mirror the server's own refusals for
 * the cases that are certain without the server — a score outside 1–5, a
 * recovery with no FindBack counterpart, and a recovery record that names the
 * caller as their own counterpart.
 *
 * What the client does NOT decide: whether the caller is a participant (the
 * server refuses 42501) and whether this direction was already rated (the
 * server refuses 23505). Those refusals are surfaced with the server's own
 * words rather than pre-empted with a guess.
 */
export async function rateReturn(draft: ReturnRatingDraft): Promise<string> {
  const returnId = draft.returnId.trim();
  if (!returnId) throw new ApiError("A recovery is required.", 400, "MISSING_RETURN_ID");
  if (!Number.isInteger(draft.score) || draft.score < 1 || draft.score > 5) {
    throw new ApiError("A rating must be between 1 and 5.", 400, "INVALID_SCORE");
  }

  const recovery = draft.recovery ?? null;
  if (recovery) {
    if (recovery.counterpartUserId === null) {
      // An outside or private recovery has no FindBack counterpart: there is
      // nothing to rate, and the server says so with 22023.
      throw new ApiError("This recovery has no FindBack counterpart to rate.", 400, "NO_COUNTERPART");
    }
    const self = optionalId(draft.selfUserId);
    if (self && recovery.counterpartUserId === self) {
      throw new ApiError("You cannot rate yourself.", 400, "SELF_RATING");
    }
  }

  const { data, error } = await getSupabase().rpc("findback_rate_return", {
    p_return_id: returnId,
    p_score: draft.score,
  });
  if (error) throw trustError(error.message, error.code);
  if (typeof data !== "string" || !data.trim()) {
    throw new ApiError("The server did not confirm the rating.", 500, "UNEXPECTED_SHAPE");
  }
  return data;
}

/**
 * May the caller still rate this recovery?
 *
 * A HINT for the screen, not an authorization: the server decides. It mirrors
 * the server's own two rules — there must be a FindBack counterpart to rate,
 * and a direction can be rated once — so a screen does not offer a rating the
 * server would refuse. The write still goes to the server either way.
 */
export function canRateReturn(recovery: MyRecovery): boolean {
  return recovery.counterpartUserId !== null && recovery.myRating === null;
}

/**
 * The participants' view of one recovery's ratings.
 *
 * The rows come back as the server assembles them and are NOT reduced here:
 * no average, no total, no "four stars" count. The only average that exists
 * is the server's own derivation inside findback_reputation_tier(), and a
 * second one computed on the phone would be a second truth.
 *
 * Only the two participants of the recovery may read this; anybody else is
 * refused by the server (42501) and that refusal is surfaced.
 */
export async function listReturnRatings(returnId: string): Promise<ReturnRating[]> {
  const id = returnId.trim();
  if (!id) throw new ApiError("A recovery is required.", 400, "MISSING_RETURN_ID");
  const { data, error } = await getSupabase().rpc("findback_return_ratings", { p_return_id: id });
  if (error) throw trustError(error.message, error.code);
  const ratings: ReturnRating[] = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const score = optionalCount(row.score);
    // A row without a score is not a rating the client can show.
    if (score === null) continue;
    ratings.push({
      raterUserId: optionalId(row.rater_user_id),
      ratedUserId: optionalId(row.rated_user_id),
      score,
      createdAt: String(row.created_at ?? ""),
    });
  }
  return ratings;
}

/**
 * The caller's own standing.
 *
 * The server derives it from its sanction history at call time and shows it
 * to its subject only: asking about anybody else is refused (42501). A
 * WARNING is a note, not a standing.
 */
export async function fetchStanding(): Promise<Standing> {
  // No argument: the server's parameter defaults to the caller.
  const { data, error } = await getSupabase().rpc("findback_standing", {});
  if (error) throw trustError(error.message, error.code);
  if (!isStanding(data)) {
    // A word this build does not know is not a standing, and "GOOD" is not a
    // safe guess: an unknown standing is a server change, not a good account.
    throw new ApiError("The server did not name a known standing.", 500, "UNEXPECTED_SHAPE");
  }
  return data;
}

/**
 * The reputation tier of an account, as the server derives it.
 *
 * A LABEL, never a score: the server counts the ratings about the account and
 * reads the serious part of its standing, and this client never repeats that
 * derivation, never averages the ratings it can read and never caches the
 * answer — every call asks the server again, because the tier moves when a
 * rating or a sanction moves.
 */
export async function fetchReputationTier(userId: string): Promise<ReputationTier> {
  const target = optionalId(userId);
  if (!target) throw new ApiError("A user is required.", 400, "MISSING_USER_ID");
  const { data, error } = await getSupabase().rpc("findback_reputation_tier", { p_user: target });
  if (error) throw trustError(error.message, error.code);
  if (!isReputationTier(data)) {
    throw new ApiError("The server did not name a known reputation tier.", 500, "UNEXPECTED_SHAPE");
  }
  return data;
}

/**
 * The limit the server enforces on the caller's own writes.
 *
 * A limit of zero means every write is refused; the refusal itself arrives on
 * the write as P0001 'POST_LIMIT_REACHED'.
 */
export async function fetchPostLimit(): Promise<InteractionLimit> {
  const { data, error } = await getSupabase().rpc("findback_post_limit", {});
  if (error) throw trustError(error.message, error.code);
  const row = ((data ?? []) as Record<string, unknown>[])[0];
  const limitPerDay = optionalCount(row?.limit_per_day);
  const burstCooldownSeconds = optionalCount(row?.burst_cooldown_seconds);
  if (limitPerDay === null || burstCooldownSeconds === null) {
    throw new ApiError("The server did not return an interaction limit.", 500, "UNEXPECTED_SHAPE");
  }
  return { limitPerDay, burstCooldownSeconds };
}

/**
 * The base number and the limit derived from it.
 *
 * Both come from the server: the base is the ONE number every ceiling is a
 * multiple of, and the limit is the caller's own derived ceiling. The client
 * does not multiply anything itself.
 */
export async function fetchInteractionLimits(): Promise<InteractionLimits> {
  const [baseLimitPerDay, limit] = await Promise.all([fetchBaseLimit(), fetchPostLimit()]);
  return {
    baseLimitPerDay,
    limitPerDay: limit.limitPerDay,
    burstCooldownSeconds: limit.burstCooldownSeconds,
  };
}

/** The ONE base number, read straight from the server. */
async function fetchBaseLimit(): Promise<number> {
  const { data, error } = await getSupabase().rpc("findback_base_interaction_limit", {});
  if (error) throw trustError(error.message, error.code);
  const base = optionalCount(data);
  if (base === null) {
    throw new ApiError("The server did not return a base interaction limit.", 500, "UNEXPECTED_SHAPE");
  }
  return base;
}

/**
 * The effective sanction kind of an account.
 *
 * READ-ONLY, AND NOT A CLIENT SURFACE. `findback_active_sanction_kind()` is
 * created `security definer` and revoked from `public, anon, authenticated`:
 * it is an internal helper of the standing and tier derivations, so a client
 * call is refused. This function therefore exists so the app can ASK and be
 * told the truth — the refusal comes back as the typed unavailable outcome,
 * never as an invented kind — and so the surface is honest if a later
 * migration does grant it.
 *
 * `fetchStanding()` is what the app shows; a sanction kind is a moderation
 * term, not a consumer one.
 */
export async function fetchActiveSanctionKind(userId: string): Promise<SanctionKind | null> {
  const target = optionalId(userId);
  if (!target) throw new ApiError("A user is required.", 400, "MISSING_USER_ID");
  const { data, error } = await getSupabase().rpc("findback_active_sanction_kind", { p_user: target });
  if (error) {
    // The refusal is structural, not situational: this function is not granted
    // to a client role at all, so it is reported as "not available" instead of
    // as "you may not do this".
    if (error.code === "42501" || error.code === "PGRST202" || error.code === "42883") {
      throw new ApiError(SANCTION_KIND_UNAVAILABLE_MESSAGE, 501, TRUST_UNAVAILABLE_CODE);
    }
    throw trustError(error.message, error.code);
  }
  if (data === null || data === undefined) return null;
  return isSanctionKind(data) ? data : null;
}

/**
 * The two words the interaction-limit guard uses when it refuses a write.
 *
 * The guard is a server-side trigger on the write itself, so the client never
 * calls it: it recognises the refusal when a post or a comment comes back
 * refused.
 */
export const INTERACTION_LIMIT_REFUSALS = ["POST_LIMIT_REACHED", "POST_COOLDOWN"] as const;

/**
 * Is this error the interaction-limit guard refusing a write?
 *
 * Both refusals arrive as P0001 with the word in front of the message; the
 * feedback ceiling uses a different word, so it is not mistaken for one.
 */
export function isInteractionLimitRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return INTERACTION_LIMIT_REFUSALS.some((word) => error.message.includes(word));
}
