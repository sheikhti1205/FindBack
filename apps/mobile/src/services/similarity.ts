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
  category: Category;
  eventDate: string | null;
  locationLabel: string | null;
  locationLat: number | null;
  locationLng: number | null;
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

/** Ranks candidates by base score plus transparent bonuses.
 * Returns at most 3 matches, sorted by score desc then id asc. */
export function rankMatches(
  target: MatchCandidate,
  candidates: MatchCandidate[],
  baseScores: Map<string, number>,
): PossibleMatch[] {
  const ranked = candidates
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