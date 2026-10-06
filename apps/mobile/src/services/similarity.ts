import type { Category } from "@findback/shared";

/** Bonus applied when the candidate shares the same category as the target. */
export const CATEGORY_BONUS = 0.15;

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

/** A ranked possible match with score and human-readable reasons. */
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

/** Computes date proximity bonus (0 to DATE_BONUS_MAX). */
function dateProximityBonus(targetDate: string | null, candidateDate: string | null): number {
  if (!targetDate || !candidateDate) return 0;

  const target = new Date(targetDate);
  const candidate = new Date(candidateDate);

  if (isNaN(target.getTime()) || isNaN(candidate.getTime())) return 0;

  const diffMs = Math.abs(target.getTime() - candidate.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

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

/** Ranks candidates by base score plus transparent bonuses.
 * Drops candidates whose mapped base score is below the cutoff (or all
 * candidates if no cutoff). Returns at most 3 matches, sorted by score desc
 * then id asc. */
export function rankMatches(
  target: MatchCandidate,
  candidates: MatchCandidate[],
  baseScores: Map<string, number>,
  cosineCutoff?: number,
): PossibleMatch[] {
  const cutoffMapped = cosineCutoff != null ? (cosineCutoff + 1) / 2 : 0;

  const ranked = candidates
    .filter((c) => (baseScores.get(c.id) ?? 0) >= cutoffMapped)
    .map((candidate) => {
      const baseScore = baseScores.get(candidate.id) ?? 0;
      const clampedBase = Math.max(0, Math.min(1, baseScore));

      const reasons: string[] = [];
      let bonus = 0;

      // Category bonus
      if (target.category === candidate.category) {
        bonus += CATEGORY_BONUS;
        reasons.push("same category");
      }

      // Date proximity bonus
      const dateBonus = dateProximityBonus(target.eventDate, candidate.eventDate);
      if (dateBonus > 0) {
        bonus += dateBonus;
        reasons.push("similar date");
      }

      // Location proximity bonus
      const locationBonus = locationProximityBonus(target.locationLat, target.locationLng, candidate.locationLat, candidate.locationLng);
      if (locationBonus > 0) {
        bonus += locationBonus;
        reasons.push("close location");
      }

      const finalScore = Math.max(0, Math.min(1, clampedBase + bonus));

      return {
        post: candidate,
        score: finalScore,
        reasons,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.post.id.localeCompare(b.post.id);
    })
    .slice(0, 3);

  return ranked;
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
