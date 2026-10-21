import { MATCH_CANDIDATE_LIMIT, fetchMatchCandidates } from "./posts";
import { getApplicationAi, type ApplicationAiService } from "./ai/applicationAi";
import { embeddingInput, embedTexts, validateEmbeddingVectors } from "./embeddings";
import { stripMarkdown } from "../utils/stripMarkdown";
import type { PostItem, PostType } from "@findback/shared";
import { cosineSimilarity, rankMatches, type MatchCandidate, type PossibleMatch, MIN_COSINE_CUTOFF } from "./similarity";

/** Matching engine selection. USE is the default incumbent; Needle is an
 * explicit, installed-and-verified challenger only (enforced by
 * `ApplicationAiService.selectMatchingBackend` + `embedNeedle` throwing while
 * not installed). Unknown values normalize to USE. No engine is ever claimed
 * better without measured evidence. */
export type MatchingBackend = "use" | "needle";

export function resolveMatchingBackend(
  aiService?: { matchingBackend?: unknown } | null,
): MatchingBackend {
  return aiService?.matchingBackend === "needle" ? "needle" : "use";
}

/** Maximum number of candidate posts to consider: min(OPEN opposite-type, 20). */
const PAGE_LIMIT = MATCH_CANDIDATE_LIMIT;

/**
 * How many RAW rows the interim fetcher asks for before the O5 exclusion.
 *
 * The end state (CF-050) excludes blocked candidates in the candidate RPC's
 * `WHERE` clause, so the pool is 20 OPEN opposite-type rows that the reader
 * may actually be shown. The interim exclusion below happens on the client,
 * AFTER the rows arrive — so a pool capped at 20 raw rows would be SMALLER
 * than the end state whenever any of those 20 is blocked. Asking for a
 * wider window and then keeping the first 20 unblocked rows keeps the
 * compared set the same size the end state would give.
 */
const RAW_CANDIDATE_WINDOW = PAGE_LIMIT * 2;

/** Result of a possible matches query. */
export interface PossibleMatchesResult {
  matches: PossibleMatch[];
  candidatesConsidered: number;
  available: boolean;
  /** Why matching is unavailable: candidates fetch vs on-device embedding. */
  unavailableReason?: "candidates" | "embed";
}

/** Converts a PostItem to a MatchCandidate (safe card projection). */
function toMatchCandidate(post: PostItem): MatchCandidate {
  return {
    id: post.id,
    title: post.title,
    description: post.description ?? null,
    category: post.category,
    eventDate: post.eventDate,
    locationLabel: post.locationLabel,
    locationLat: post.latitude,
    locationLng: post.longitude,
    photoUrl: post.attachments?.find((attachment) => attachment.mimeType.startsWith("image/"))?.fileUrl ?? null,
  };
}

/**
 * Default candidate fetcher: the most recent relevant open reports of the
 * opposite type, as RAW rows.
 *
 * The rows are returned unmapped on purpose: the O5 exclusion runs on them
 * BEFORE they become candidates, so a blocked counterpart is never even
 * compared, let alone suggested.
 */
async function defaultFetchCandidates(oppositeType: PostType): Promise<PostItem[]> {
  return fetchMatchCandidates(oppositeType, RAW_CANDIDATE_WINDOW);
}

/** Finds possible matches for a target post by comparing against the most recent relevant open reports.
 * Embeds target and candidates in a single batch, ranks with transparent bonuses, returns top 3.
 * On embed failure, returns an unavailability object instead of throwing. */
export async function findPossibleMatches(
  target: PostItem,
  deps?: {
    fetchCandidates?: (oppositeType: PostType) => Promise<PostItem[]>;
    embed?: (texts: string[]) => Promise<number[][]>;
    aiService?: Pick<ApplicationAiService, "matchingBackend" | "embedNeedle">;
  },
): Promise<PossibleMatchesResult> {
  const fetchCandidates = deps?.fetchCandidates ?? defaultFetchCandidates;
  const ai = deps?.aiService ?? getApplicationAi();
  // USE stays the default; explicit Needle only when installed/verified. A
  // Needle embed failure degrades to unavailable — never a silent USE fallback.
  const embed = deps?.embed ?? (resolveMatchingBackend(ai) === "needle" ? (texts: string[]) => ai.embedNeedle(texts) : embedTexts);

  const oppositeType: PostType = target.type === "LOST" ? "FOUND" : "LOST";

  let fetched: PostItem[];
  try {
    fetched = await fetchCandidates(oppositeType);
  } catch {
    return { matches: [], candidatesConsidered: 0, available: false, unavailableReason: "candidates" };
  }

  // O5 (CF-050) — INTERIM, on the client, until the server-side candidate
  // reader exists.
  //
  // The candidate surface is licensed to differ from ordinary public
  // visibility (MODERATION-CONTRACT-DECISION.md §13.9 branch 1, and the
  // CF-050 D40/D41 gate's Decision 1): a candidate whose author the caller
  // is blocked with is EXCLUDED from the pool, never surfaced as a
  // suggestion. A match card exists to suggest reaching that person, so a
  // shielded-but-visible card would still read as a suggestion.
  //
  // The gate's END STATE is an exclusion in the candidate RPC's `WHERE`
  // clause, with NO client-visible column and no widened candidate type:
  // that reader does not exist in the database yet, so this filter is the
  // documented interim that stands in for it. It reads the canonical
  // `blocked_author` bit the feed rows already carry, it runs on the RAW
  // rows BEFORE they are mapped to a candidate, and it is dropped the moment
  // the server-side reader lands (lane D5-CANDIDATES).
  //
  // The exclusion happens BEFORE the pool cap: capping first would make the
  // compared set silently smaller than the end state, and the compared count
  // has to be the number of reports that were really compared.
  const unblocked = fetched.filter((post) => post.blockedAuthor !== true);
  // Enforce the spec pool cap even for injected fetchers.
  const candidates = unblocked.slice(0, PAGE_LIMIT).map(toMatchCandidate);

  // Build embedding inputs: target first, then candidates (even if empty, to detect embed failure)
  // Plain-text embedding inputs: never embed Markdown syntax clutter.
  const targetInput = embeddingInput(
    stripMarkdown(target.title),
    stripMarkdown(target.description),
  );
  const candidateInputs = candidates.map((c) =>
    embeddingInput(stripMarkdown(c.title), stripMarkdown(c.description ?? "")),
  );

  let vectors: number[][];
  try {
    // Validate BEFORE cosine: an injected (or stale) embedder must not fabricate
    // scores from a short/ragged/non-finite payload.
    vectors = validateEmbeddingVectors(
      [targetInput, ...candidateInputs],
      await embed([targetInput, ...candidateInputs]),
    );
  } catch {
    return { matches: [], candidatesConsidered: 0, available: false, unavailableReason: "embed" };
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
