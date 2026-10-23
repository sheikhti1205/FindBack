import { MATCH_CANDIDATE_LIMIT, fetchMatchCandidates } from "./posts";
import { getApplicationAi, type ApplicationAiService } from "./ai/applicationAi";
import { embeddingInput, embedTexts, validateEmbeddingVectors } from "./embeddings";
import { stripMarkdown } from "../utils/stripMarkdown";
import type { PostItem } from "@findback/shared";
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
 * Default candidate fetcher: the server's candidate reader, asked about a
 * TARGET report.
 *
 * The reader is asked for the target, not for a type: it reads the target
 * from the visible view, works out the opposite type itself, and excludes a
 * candidate whose author the reader is blocked with. The client is told
 * neither the target's type nor anything about a block.
 */
async function defaultFetchCandidates(targetId: string): Promise<PostItem[]> {
  return fetchMatchCandidates(targetId, PAGE_LIMIT);
}

/** Finds possible matches for a target post by comparing against the most recent relevant open reports.
 * Embeds target and candidates in a single batch, ranks with transparent bonuses, returns the
 * top suggestions (see `MATCH_RESULT_LIMIT`).
 * On embed failure, returns an unavailability object instead of throwing.
 *
 * VISUAL MATCHING: there is no visual pass in this build, and none is faked.
 * The only embedding capability that exists is TEXT (`FindBackEmbeddings`
 * embeds strings; the Needle challenger embeds strings). The vision runtime
 * is a generative VLM that produces text descriptions, not image vectors.
 * Single-resident ownership would also need sequential scheduling of a real
 * image encoder alongside Needle. A visual signal would
 * therefore be a different capability, not a flag on this one — see the
 * E3 handoff for the smallest wiring plan. */
export async function findPossibleMatches(
  target: PostItem,
  deps?: {
    fetchCandidates?: (targetId: string) => Promise<PostItem[]>;
    embed?: (texts: string[]) => Promise<number[][]>;
    aiService?: Pick<ApplicationAiService, "matchingBackend" | "embedNeedle">;
  },
): Promise<PossibleMatchesResult> {
  const fetchCandidates = deps?.fetchCandidates ?? defaultFetchCandidates;
  const ai = deps?.aiService ?? getApplicationAi();
  // USE stays the default; explicit Needle only when installed/verified. A
  // Needle embed failure degrades to unavailable — never a silent USE fallback.
  const embed = deps?.embed ?? (resolveMatchingBackend(ai) === "needle" ? (texts: string[]) => ai.embedNeedle(texts) : embedTexts);

  let fetched: PostItem[];
  try {
    fetched = await fetchCandidates(target.id);
  } catch {
    return { matches: [], candidatesConsidered: 0, available: false, unavailableReason: "candidates" };
  }

  // O5 (CF-050) — the exclusion is the SERVER's, and it is total.
  //
  // `findback_match_candidates_client` excludes a candidate whose author the
  // reader is blocked with in its WHERE clause, so a blocked counterpart is
  // never returned and never compared, let alone suggested. No block bit is
  // projected to the client, the candidate type is not widened, and the
  // consumer surface shows no block copy: a candidate that is blocked simply
  // is not proposed.
  //
  // The cap is applied here as well as on the server, so an injected fetcher
  // cannot widen the pool.
  const candidates = fetched.slice(0, PAGE_LIMIT).map(toMatchCandidate);

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
