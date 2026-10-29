import type { Category } from "@findback/shared";

/** Bonus applied when the candidate shares the same category as the target. */
export const CATEGORY_BONUS = 0.15;

/**
 * Maximum number of suggestions a match list may carry.
 *
 * The server pool is wider (`MATCH_CANDIDATE_LIMIT` candidates are compared);
 * this is how many of them are SHOWN. It is a display cap, not a quality
 * claim: a list that only produced three suggestions shows three, and the
 * surface says so in words that read as a similarity result rather than a
 * truncation.
 */
export const MATCH_RESULT_LIMIT = 5;

/**
 * Consumer reasons. At most `MATCH_REASON_MAX` are shown, and
 * `MATCH_REASON_MIN` is a TARGET, not a quota: a pair whose comparison
 * supports fewer than three distinct facts shows fewer reasons. Filler
 * reasons are never invented to reach a count.
 */
export const MATCH_REASON_MAX = 5;
export const MATCH_REASON_MIN = 3;

/**
 * Only category equality, date proximity and coordinate proximity contribute
 * independently attributable bonuses today. No title/description or visual
 * explanation is inferred from a combined text vector or a photo URL.
 */
export type MatchReasonSignal =
  | "text"
  | "location"
  | "date"
  | "category";

/**
 * One consumer-facing reason: the signal it came from and the plain-language
 * sentence shown. No scores, no percentages, no model terms, no ids.
 */
export interface MatchReason {
  readonly signal: MatchReasonSignal;
  readonly text: string;
}

/** Maximum bonus for date proximity (same day). */
const DATE_BONUS_MAX = 0.10;
/** Date proximity decays over this many days. */
const DATE_DECAY_DAYS = 30;

/** Maximum bonus for location proximity (≤5 km). */
const LOCATION_BONUS_MAX = 0.10;
/** Full location bonus within this radius (km). */
const LOCATION_FULL_RADIUS_KM = 5;
/** Location bonus decays to zero at this radius (km). */
const LOCATION_DECAY_RADIUS_KM = 20;

/** Safe card projection retained for matching results. */
export interface MatchCandidate {
  id: string;
  title: string;
  description: string | null;
  category: Category;
  eventDate: string | null;
  locationLabel: string | null;
  locationLat: number | null;
  locationLng: number | null;
  /** Presentation-only; never contributes to the similarity score. */
  photoUrl?: string | null;
}

/** A ranked possible match with score and human-readable reasons.
 *
 * `reasons` holds CONSUMER copy only: plain sentences derived from the
 * comparison (see `deriveMatchReasons`). No scores, no percentages, no model
 * terms, no ids — the numbers about a match live in `score`, which the
 * surface never shows as a percentage. */
export interface PossibleMatch {
  post: MatchCandidate;
  score: number;
  reasons: string[];
}

/** Computes cosine similarity between two vectors.
 * Returns a value in [-1, 1], clamped. Returns 0 for zero-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) return 0;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, similarity));
}

/** Computes distance between two lat/lng points in kilometers using Haversine formula. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Days between two report dates, or null when either date is missing or
 * unparseable. Shared by the date BONUS and the date REASON so the two can
 * never disagree about how far apart two reports are.
 */
function dateDistanceDays(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const first = new Date(a);
  const second = new Date(b);
  if (isNaN(first.getTime()) || isNaN(second.getTime())) return null;
  return Math.abs(first.getTime() - second.getTime()) / (1000 * 60 * 60 * 24);
}

/** Computes date proximity bonus (0 to DATE_BONUS_MAX). */
function dateProximityBonus(targetDate: string | null, candidateDate: string | null): number {
  const diffDays = dateDistanceDays(targetDate, candidateDate);
  if (diffDays === null) return 0;
  if (diffDays >= DATE_DECAY_DAYS) return 0;

  // Linear decay from full bonus at 0 days to 0 at DATE_DECAY_DAYS
  return DATE_BONUS_MAX * (1 - diffDays / DATE_DECAY_DAYS);
}

/** Computes location proximity bonus (0 to LOCATION_BONUS_MAX). */
function locationProximityBonus(
  targetLat: number | null,
  targetLng: number | null,
  candidateLat: number | null,
  candidateLng: number | null,
): number {
  if (targetLat == null || targetLng == null || candidateLat == null || candidateLng == null) return 0;

  const distanceKm = haversineKm(targetLat, targetLng, candidateLat, candidateLng);

  if (distanceKm <= LOCATION_FULL_RADIUS_KM) return LOCATION_BONUS_MAX;
  if (distanceKm >= LOCATION_DECAY_RADIUS_KM) return 0;

  // Linear decay from full bonus at 5km to 0 at 20km
  return LOCATION_BONUS_MAX * (1 - (distanceKm - LOCATION_FULL_RADIUS_KM) / (LOCATION_DECAY_RADIUS_KM - LOCATION_FULL_RADIUS_KM));
}

/** Minimum base cosine similarity (raw, before mapping) for a candidate to
 * be considered. Candidates below this threshold are dropped regardless of
 * bonus points. Frozen conservative policy, not an empirically tuned value:
 * 0.0 means only negatively-correlated candidates are dropped. Production
 * possibleMatches.ts passes this explicitly; rankMatches without a cutoff
 * intentionally remains the legacy no-filter utility.
 * DEVICE-CALIBRATION: raising this needs on-device measurement.
 * TODO(DEVICE-CALIBRATION): benchmark representative labeled pairs with real
 * native embeddings on the target device before any bump. Synthetic score
 * regression fixtures do not fulfill this requirement. See docs/bench. */
export const MIN_COSINE_CUTOFF = 0.0;

/** Reasons mirror bonuses that actually fired. Combined text embeddings do not
 * attribute title vs description similarity; photos are presentation-only. */
export function deriveMatchReasons(target: MatchCandidate, candidate: MatchCandidate): MatchReason[] {
  const reasons: MatchReason[] = [];
  const locationBonus = locationProximityBonus(target.locationLat, target.locationLng, candidate.locationLat, candidate.locationLng);
  if (locationBonus > 0) reasons.push({ signal: "location", text: locationBonus === LOCATION_BONUS_MAX ? "Within 5 km" : "Within 20 km" });
  const days = dateDistanceDays(target.eventDate, candidate.eventDate);
  if (dateProximityBonus(target.eventDate, candidate.eventDate) > 0 && days !== null) {
    reasons.push({ signal: "date", text: days === 0 ? "Same event date" : days < 1 ? "Events less than a day apart" : days === Math.floor(days) ? `Events ${days} day${days === 1 ? "" : "s"} apart` : "Events within 30 days" });
  }
  if (target.category === candidate.category) reasons.push({ signal: "category", text: "Same category" });
  return reasons;
}

/** Checks emitted wording against the actual comparison, not an LLM. */
export function isReasonSupported(reason: MatchReason, target: MatchCandidate, candidate: MatchCandidate): boolean {
  return deriveMatchReasons(target, candidate).some(
    (derived) => derived.signal === reason.signal && derived.text === reason.text,
  );
}

/** Ranks candidates by base score plus transparent bonuses.
 * Drops candidates whose mapped base score is below the cutoff (or all
 * candidates if no cutoff). Returns at most `limit` matches (default
 * `MATCH_RESULT_LIMIT`), sorted by score desc then id asc. */
export function rankMatches(
  target: MatchCandidate,
  candidates: MatchCandidate[],
  baseScores: Map<string, number>,
  cosineCutoff?: number,
  limit: number = MATCH_RESULT_LIMIT,
): PossibleMatch[] {
  const cutoffMapped = cosineCutoff != null ? (cosineCutoff + 1) / 2 : 0;

  const ranked = candidates
    .filter((c) => (baseScores.get(c.id) ?? 0) >= cutoffMapped)
    .map((candidate) => {
      const baseScore = baseScores.get(candidate.id) ?? 0;
      const clampedBase = Math.max(0, Math.min(1, baseScore));

      let bonus = 0;

      // Category bonus
      if (target.category === candidate.category) {
        bonus += CATEGORY_BONUS;
      }

      // Date proximity bonus
      const dateBonus = dateProximityBonus(target.eventDate, candidate.eventDate);
      if (dateBonus > 0) {
        bonus += dateBonus;
      }

      // Location proximity bonus
      const locationBonus = locationProximityBonus(target.locationLat, target.locationLng, candidate.locationLat, candidate.locationLng);
      if (locationBonus > 0) {
        bonus += locationBonus;
      }

      const finalScore = Math.max(0, Math.min(1, clampedBase + bonus));

      return {
        post: candidate,
        score: finalScore,
        // The consumer reasons are DERIVED from the same comparison, never
        // written by hand, so the explanation and the score cannot drift.
        reasons: deriveMatchReasons(target, candidate).map((reason) => reason.text),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.post.id.localeCompare(b.post.id);
    })
    .slice(0, Math.max(0, limit));

  return ranked;
}

/**
 * Weight of the lexical overlap term in the structured/text fallback.
 *
 * The fallback exists because a device without the embedding model must still
 * get working suggestions (M1 packet: "text/structured matching remains
 * functional"). It is NOT a semantic comparison and never claims to be: it
 * compares normalized words, then adds the same transparent category/date/
 * place bonuses the semantic path uses. 0.55 keeps shared wording the dominant
 * signal while letting the structured bonuses break ties.
 */
export const TEXT_OVERLAP_WEIGHT = 0.55;

/**
 * Minimum lexical overlap for a candidate that has no structured alignment.
 *
 * 0.2 (Dice) means roughly one shared content word in five across both reports;
 * lower values surface pairs that share only a category word ("phone", "bag")
 * and would read as noise.
 */
export const TEXT_MATCH_MIN_OVERLAP = 0.2;

/**
 * Words that carry no matching signal in English. Deliberately tiny: a longer
 * list would be a language decision this build has not measured. Bangla and
 * Banglish content words are left untouched, because dropping them would
 * silently degrade exactly the users this fallback is meant to serve.
 */
const TEXT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from",
  "had", "has", "have", "he", "her", "his", "i", "if", "in", "is", "it", "its",
  "my", "no", "not", "of", "on", "or", "our", "she", "so", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "was",
  "we", "were", "what", "when", "where", "which", "who", "will", "with",
  "you", "your",
]);

/** Normalizes report text into comparable content tokens (Unicode-aware).
 * `\p{M}` keeps combining marks, so Bangla vowel signs stay part of the word
 * instead of splitting "কালো" into single letters. */
export function matchTextTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length > 1 && !TEXT_STOPWORDS.has(token));
}

/** The comparable text of one report: title plus description, in that order. */
function reportText(candidate: MatchCandidate): string {
  return `${candidate.title} ${candidate.description ?? ""}`.trim();
}

/**
 * Dice coefficient over the two reports' content tokens, in [0, 1].
 *
 * Order-insensitive and length-normalized, so a long description cannot win by
 * sheer size. Language-agnostic: it compares the tokens the writer actually
 * used, which is what makes Bangla and Banglish descriptions work without a
 * language-specific model.
 */
export function textOverlap(targetText: string, candidateText: string): number {
  const a = matchTextTokens(targetText);
  const b = matchTextTokens(candidateText);
  if (a.length === 0 || b.length === 0) return 0;
  const bCounts = new Map<string, number>();
  for (const token of b) bCounts.set(token, (bCounts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of a) {
    const left = bCounts.get(token) ?? 0;
    if (left > 0) {
      shared++;
      bCounts.set(token, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Reasons for a structured/text suggestion: the same derived structured facts
 * as the semantic path, plus a wording signal when the overlap threshold fired.
 * Nothing here is inferred from a model.
 */
export function deriveTextMatchReasons(
  target: MatchCandidate,
  candidate: MatchCandidate,
  overlap: number,
): MatchReason[] {
  const reasons: MatchReason[] = [];
  if (overlap >= TEXT_MATCH_MIN_OVERLAP) reasons.push({ signal: "text", text: "Similar wording" });
  reasons.push(...deriveMatchReasons(target, candidate));
  return reasons;
}

/**
 * Ranks candidates WITHOUT the embedding model, using wording overlap plus the
 * same structured bonuses. Used only as the declared fallback when the semantic
 * embedder is unavailable or returns an unusable payload.
 *
 * A candidate qualifies when it shares enough wording, or when it shares both
 * the category and an event date within a day — a structured lead that is worth
 * showing even when the two descriptions were written in different words.
 */
export function rankTextMatches(
  target: MatchCandidate,
  candidates: MatchCandidate[],
  limit: number = MATCH_RESULT_LIMIT,
): PossibleMatch[] {
  const targetText = reportText(target);
  return candidates
    .map((candidate) => {
      const overlap = textOverlap(targetText, reportText(candidate));
      const days = dateDistanceDays(target.eventDate, candidate.eventDate);
      const sameCategorySameDay = target.category === candidate.category && days !== null && days < 1;
      let bonus = 0;
      if (target.category === candidate.category) bonus += CATEGORY_BONUS;
      bonus += dateProximityBonus(target.eventDate, candidate.eventDate);
      bonus += locationProximityBonus(
        target.locationLat,
        target.locationLng,
        candidate.locationLat,
        candidate.locationLng,
      );
      const score = Math.max(0, Math.min(1, TEXT_OVERLAP_WEIGHT * overlap + bonus));
      return { candidate, overlap, score, qualifies: overlap >= TEXT_MATCH_MIN_OVERLAP || sameCategorySameDay };
    })
    .filter((entry) => entry.qualifies)
    .map(({ candidate, overlap, score }) => ({
      post: candidate,
      score,
      reasons: deriveTextMatchReasons(target, candidate, overlap).map((reason) => reason.text),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.post.id.localeCompare(b.post.id);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * WS6 benchmark metric hooks: binary-relevance ranking metrics over id lists.
 * Pure functions shared with the bench harness (tools/bench/score.mjs mirrors
 * this math in dependency-free JS; the TS module below owns the contract).
 *
 * `rankedIds` is the system's ranked candidate ids (best first);
 * `relevantIds` is the golden relevant set. Empty `relevantIds` scores 0
 * (corpus validation requires non-empty relevant sets; see goldenCorpus.ts).
 */

/** Rank (0-based) of the first ranked id in `relevant`, or -1 when absent. */
function firstRelevantRank(rankedIds: readonly string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < rankedIds.length; i++) {
    const id = rankedIds[i];
    if (id !== undefined && relevant.has(id)) return i;
  }
  return -1;
}

/**
 * Recall@k: fraction of relevant ids appearing in the top-k ranked ids.
 * Returns 0 when k <= 0 or when there are no relevant ids.
 */
export function recallAtK(rankedIds: readonly string[], relevantIds: readonly string[], k: number): number {
  if (k <= 0 || relevantIds.length === 0) return 0;
  const relevant = new Set(relevantIds);
  const topK = new Set(rankedIds.slice(0, k));
  let hits = 0;
  for (const id of relevant) {
    if (topK.has(id)) hits++;
  }
  return hits / relevant.size;
}

/**
 * Reciprocal rank: 1 / (1 + rank of first relevant), or 0 when no relevant
 * id is ranked. Returns 0 when there are no relevant ids.
 */
export function reciprocalRank(rankedIds: readonly string[], relevantIds: readonly string[]): number {
  if (relevantIds.length === 0) return 0;
  const rank = firstRelevantRank(rankedIds, new Set(relevantIds));
  return rank < 0 ? 0 : 1 / (rank + 1);
}

/**
 * nDCG@k over binary relevance. DCG sums rel_i / log2(i + 2); IDCG is the
 * ideal DCG of min(|relevant|, k) ones up front. Returns 0 when k <= 0 or
 * when there are no relevant ids; 1.0 for a perfect top-k ranking.
 */
export function ndcgAtK(rankedIds: readonly string[], relevantIds: readonly string[], k: number): number {
  if (k <= 0 || relevantIds.length === 0) return 0;
  const relevant = new Set(relevantIds);
  let dcg = 0;
  const depth = Math.min(k, rankedIds.length);
  for (let i = 0; i < depth; i++) {
    const id = rankedIds[i];
    if (id !== undefined && relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Per-query WS6 ranking metrics: Recall@1, Recall@3, MRR, nDCG@3. */
export interface RankingMetrics {
  recallAt1: number;
  recallAt3: number;
  mrr: number;
  ndcgAt3: number;
}

/** Scores one ranked list against its golden relevant set. Pure. */
export function rankingMetrics(rankedIds: readonly string[], relevantIds: readonly string[]): RankingMetrics {
  return {
    recallAt1: recallAtK(rankedIds, relevantIds, 1),
    recallAt3: recallAtK(rankedIds, relevantIds, 3),
    mrr: reciprocalRank(rankedIds, relevantIds),
    ndcgAt3: ndcgAtK(rankedIds, relevantIds, 3),
  };
}

/**
 * Macro-averages per-query metrics (each query counts equally). Empty input
 * yields zeros rather than NaN. Pure.
 */
export function averageRankingMetrics(rows: readonly RankingMetrics[]): RankingMetrics {
  if (rows.length === 0) return { recallAt1: 0, recallAt3: 0, mrr: 0, ndcgAt3: 0 };
  let recallAt1 = 0;
  let recallAt3 = 0;
  let mrr = 0;
  let ndcgAt3 = 0;
  for (const row of rows) {
    recallAt1 += row.recallAt1;
    recallAt3 += row.recallAt3;
    mrr += row.mrr;
    ndcgAt3 += row.ndcgAt3;
  }
  return {
    recallAt1: recallAt1 / rows.length,
    recallAt3: recallAt3 / rows.length,
    mrr: mrr / rows.length,
    ndcgAt3: ndcgAt3 / rows.length,
  };
}
