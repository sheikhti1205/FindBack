import { fetchFeed } from "./posts";
import { embeddingInput, embedTexts } from "./embeddings";
import type { PostItem, PostType } from "@findback/shared";
import { cosineSimilarity, rankMatches, type MatchCandidate, type PossibleMatch, MIN_COSINE_CUTOFF } from "./similarity";

/** Maximum number of candidate posts to fetch per page (client-side cap). */
const PAGE_LIMIT = 10;

/** Result of a possible matches query. */
export interface PossibleMatchesResult {
  matches: PossibleMatch[];
  candidatesConsidered: number;
  available: boolean;
}

/** Converts a PostItem to a MatchCandidate (safe card projection). */
function toMatchCandidate(post: PostItem): MatchCandidate {
  return {
    id: post.id,
    title: post.title,
    description: post.description,
    category: post.category,
    eventDate: post.eventDate,
    locationLabel: post.locationLabel,
    locationLat: post.latitude,
    locationLng: post.longitude,
  };
}

/** Default candidate fetcher: compares against the most recent relevant open reports of the opposite type. */
async function defaultFetchCandidates(oppositeType: PostType): Promise<MatchCandidate[]> {
  const page = await fetchFeed({ type: oppositeType, status: "OPEN" });
  // The SQL layer caps the result set at 20; we take up to PAGE_LIMIT (10) client-side.
  return page.items.slice(0, PAGE_LIMIT).map(toMatchCandidate);
}

/** Finds possible matches for a target post by comparing against the most recent relevant open reports.
 * Embeds target and candidates in a single batch, ranks with transparent bonuses, returns top 3.
 * On embed failure, returns an unavailability object instead of throwing. */
export async function findPossibleMatches(
  target: PostItem,
  deps?: {
    fetchCandidates?: (oppositeType: PostType) => Promise<MatchCandidate[]>;
    embed?: (texts: string[]) => Promise<number[][]>;
  },
): Promise<PossibleMatchesResult> {
  const fetchCandidates = deps?.fetchCandidates ?? defaultFetchCandidates;
  const embed = deps?.embed ?? embedTexts;

  const oppositeType: PostType = target.type === "LOST" ? "FOUND" : "LOST";

  let candidates: MatchCandidate[];
  try {
    candidates = await fetchCandidates(oppositeType);
  } catch {
    return { matches: [], candidatesConsidered: 0, available: false };
  }

  // Build embedding inputs: target first, then candidates (even if empty, to detect embed failure)
  const targetInput = embeddingInput(target.title, target.description);
  const candidateInputs = candidates.map((c) => embeddingInput(c.title, c.description ?? ""));

  let vectors: number[][];
  try {
    vectors = await embed([targetInput, ...candidateInputs]);
  } catch {
    return { matches: [], candidatesConsidered: 0, available: false };
  }

  if (candidates.length === 0) {
    return { matches: [], candidatesConsidered: 0, available: true };
  }

  const targetVector = vectors[0] ?? [];
  const candidateVectors = vectors.slice(1);

  // Compute base cosine similarities
  const baseScores = new Map<string, number>();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const candidateVector = candidateVectors[i] ?? [];
    const similarity = cosineSimilarity(targetVector, candidateVector);
    // Map from [-1, 1] to [0, 1] for base score
    baseScores.set(candidate.id, (similarity + 1) / 2);
  }

  const targetCandidate = toMatchCandidate(target);
  const matches = rankMatches(targetCandidate, candidates, baseScores, MIN_COSINE_CUTOFF);

  return {
    matches,
    candidatesConsidered: candidates.length,
    available: true,
  };
}