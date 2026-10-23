/**
 * Deterministic, dependency-free evaluation of the matching pipeline.
 *
 * WHAT IS MEASURED: the RANKER (the pre-bonus cutoff, the transparent
 * bonuses, the result cap) and the REASON DERIVATION, over a small
 * hand-labelled fixture of lost/found pairs, given the base scores the
 * fixture carries.
 *
 * WHAT IS NOT MEASURED: text-embedding quality. The fixture's base scores
 * are hand-labelled synthetic inputs, not vectors from an on-device model, so
 * no number produced here says anything about how well the app matches real
 * reports. The written report repeats that limitation next to the numbers.
 *
 * The module has NO runtime imports on purpose: the offline harness runs it
 * under Node's type stripping, where an extensionless relative import cannot
 * be resolved. The ranker and the reason derivation are therefore injected,
 * and both the harness and the unit test wire the SAME production functions.
 */

import type { MatchCandidate, MatchReason, MatchReasonSignal } from "./similarity";

/** A candidate in the evaluation fixture: a match candidate plus the mapped
 * base score the fixture hands to the ranker. */
export interface EvaluationCandidate extends MatchCandidate {
  /** The mapped base score (cosine mapped to [0,1]) for this candidate. */
  mappedScore: number;
}

/** One labelled case: a target report, the candidate reports compared against
 * it, and which of those candidates are the same item. */
export interface EvaluationCase {
  id: string;
  notes?: string;
  /** Ids of the candidates that are the same item as the target. May be
   * empty for a case where NOTHING in the pool is the same item — those
   * cases measure precision only. */
  relevantIds: string[];
  /** Overrides merged onto the fixture's shared target. */
  target?: Partial<MatchCandidate>;
  candidates: EvaluationCandidate[];
  /** Hand-labelled reason signals expected on the relevant candidate. */
  expectedReasonSignals?: MatchReasonSignal[];
}

/** The committed fixture: a shared target plus the labelled cases. */
export interface EvaluationFixture {
  version: string;
  /** What the numbers in this fixture are and are not. */
  evidenceKind: string;
  /** The day the fixture was written. */
  createdAt: string;
  /** The number of cases the fixture holds. */
  fixtureSize: number;
  target: MatchCandidate;
  cases: EvaluationCase[];
}

/** A ranked match as the evaluation sees it. Structurally the production
 * `PossibleMatch`, so the production ranker can be injected unchanged. */
export interface EvaluatedMatch {
  post: MatchCandidate;
  score: number;
  reasons: string[];
}

/** The production functions the evaluation runs. */
export interface MatchEvaluationDeps {
  /** The production ranker, already bound to the shipped cutoff and cap. */
  rank: (
    target: MatchCandidate,
    candidates: MatchCandidate[],
    scores: Map<string, number>,
  ) => EvaluatedMatch[];
  /** The production reason derivation. */
  deriveReasons: (target: MatchCandidate, candidate: MatchCandidate) => MatchReason[];
  /** The production support test for one derived reason. */
  isSupported: (reason: MatchReason, target: MatchCandidate, candidate: MatchCandidate) => boolean;
  /** The production target minimum for reasons on one match. */
  minimumReasons: number;
}

/** The cut-offs the evaluation reports. */
export const EVALUATION_KS = [1, 3, 5] as const;

/** Per-case results. */
export interface EvaluationRow {
  id: string;
  relevantIds: string[];
  rankedIds: string[];
  returned: number;
  precisionAt1: number;
  precisionAt3: number;
  precisionAt5: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  reciprocalRank: number;
  reasonsEmitted: number;
  reasonsSupported: number;
  reasonSupportRate: number;
  /** Ranked matches that carried fewer reasons than the target minimum. */
  matchesBelowReasonMinimum: number;
  /** Reasons per ranked match, in ranked order. */
  reasonCounts: number[];
  /** Emitted reasons the derivation no longer supports. Empty in a healthy run. */
  unsupportedReasons: { matchId: string; reason: string }[];
  /** Hand-label comparison for the relevant candidate, when the case has one. */
  reasonLabels: {
    expected: MatchReasonSignal[];
    derived: MatchReasonSignal[];
    matched: MatchReasonSignal[];
    missing: MatchReasonSignal[];
  } | null;
}

/** The committed evaluation report. */
export interface EvaluationReport {
  fixtureVersion: string;
  evidenceKind: string;
  createdAt: string;
  fixtureSize: number;
  caseCount: number;
  /** Cases that carry at least one labelled relevant candidate. */
  labelledCaseCount: number;
  /** Where the fixture lives, filled in by the harness. */
  fixturePath?: string;
  /** The shipped policy the run measured, filled in by the harness. */
  policy?: {
    rawCosineCutoff: number;
    maxResults: number;
    minimumReasons: number;
  };
  /** What the numbers cover, in words. */
  scope: {
    measured: string[];
    notMeasured: string[];
    precisionDefinition: string;
    recallDefinition: string;
  };
  /** The claim this run may carry — and the one it may not. */
  claim: {
    statement: string;
    /** True when the fixture is too small to carry a quality claim. */
    fixtureTooSmallForAQualityClaim: boolean;
    smallestUsefulNextStep: string;
  };
  metrics: {
    precisionAt1: number;
    precisionAt3: number;
    precisionAt5: number;
    recallAt1: number;
    recallAt3: number;
    recallAt5: number;
    reciprocalRank: number;
    /** Cases the recall average is taken over. */
    recallCaseCount: number;
  };
  reasonSupport: {
    reasonsEmitted: number;
    reasonsSupported: number;
    supportRate: number;
    unsupported: { caseId: string; matchId: string; reason: string }[];
    matchesTotal: number;
    matchesBelowReasonMinimum: number;
    reasonCountHistogram: Record<string, number>;
  };
  reasonLabels: {
    labelledCases: number;
    expectedSignals: number;
    matchedSignals: number;
    agreement: number;
  };
  rows: EvaluationRow[];
}

/**
 * Validates a parsed fixture. Returns error strings (empty = valid). Catches
 * the mistakes that would silently turn a measurement into a fiction: a
 * fixture size that disagrees with the cases, a labelled id that names no
 * candidate, a duplicated id, or a non-finite base score.
 */
export function validateEvaluationFixture(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) return ["fixture root must be an object"];
  const doc = value as Partial<EvaluationFixture>;

  if (typeof doc.version !== "string" || doc.version.length === 0) errors.push("version must be a non-empty string");
  if (typeof doc.evidenceKind !== "string" || doc.evidenceKind.length === 0) {
    errors.push("evidenceKind must state what the fixture's numbers are and are not");
  }
  if (typeof doc.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(doc.createdAt)) {
    errors.push("createdAt must be an ISO date (YYYY-MM-DD)");
  }
  if (typeof doc.target !== "object" || doc.target === null) errors.push("target must be an object");
  if (!Array.isArray(doc.cases)) {
    errors.push("cases must be an array");
    return errors;
  }
  if (doc.fixtureSize !== doc.cases.length) {
    errors.push(`fixtureSize (${String(doc.fixtureSize)}) must equal the number of cases (${doc.cases.length})`);
  }

  const seenCaseIds = new Set<string>();
  for (const entry of doc.cases) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) {
      errors.push("every case must have a non-empty string id");
      continue;
    }
    if (seenCaseIds.has(entry.id)) errors.push(`duplicate case id: ${entry.id}`);
    seenCaseIds.add(entry.id);

    if (!Array.isArray(entry.candidates)) {
      errors.push(`case ${entry.id}: candidates must be an array`);
      continue;
    }
    if (entry.candidates.length === 0) errors.push(`case ${entry.id}: needs at least one candidate`);

    const candidateIds = new Set<string>();
    for (const candidate of entry.candidates) {
      if (typeof candidate?.id !== "string" || candidate.id.length === 0) {
        errors.push(`case ${entry.id}: every candidate must have a non-empty string id`);
        continue;
      }
      if (candidateIds.has(candidate.id)) errors.push(`case ${entry.id}: duplicate candidate id ${candidate.id}`);
      candidateIds.add(candidate.id);
      if (typeof candidate.mappedScore !== "number" || !Number.isFinite(candidate.mappedScore)) {
        errors.push(`case ${entry.id}: candidate ${candidate.id} needs a finite mappedScore`);
      }
    }
    if (!Array.isArray(entry.relevantIds)) {
      errors.push(`case ${entry.id}: relevantIds must be an array`);
      continue;
    }
    for (const relevant of entry.relevantIds) {
      if (!candidateIds.has(relevant)) errors.push(`case ${entry.id}: relevantId ${relevant} names no candidate`);
    }
  }
  return errors;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hitsIn(rankedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  let hits = 0;
  for (const id of rankedIds.slice(0, k)) {
    if (relevant.has(id)) hits++;
  }
  return hits;
}

/**
 * Runs the evaluation over one fixture.
 *
 * Precision@k counts the labelled relevant candidates inside the top k as a
 * share of the candidates that were actually returned (denominator
 * `min(k, returned)`), so a case with three candidates is not punished for
 * not having five. Recall@k counts the same hits as a share of the labelled
 * relevant candidates. Cases with no labelled relevant candidate contribute
 * to precision and are left out of the recall average.
 */
export function evaluateFixture(fixture: EvaluationFixture, deps: MatchEvaluationDeps): EvaluationReport {
  const errors = validateEvaluationFixture(fixture);
  if (errors.length > 0) throw new Error(`Invalid evaluation fixture: ${errors.join("; ")}`);

  const rows: EvaluationRow[] = [];
  const unsupported: { caseId: string; matchId: string; reason: string }[] = [];
  const histogram: Record<string, number> = {};
  let reasonsEmitted = 0;
  let reasonsSupported = 0;
  let matchesTotal = 0;
  let matchesBelowReasonMinimum = 0;
  let labelledCases = 0;
  let expectedSignals = 0;
  let matchedSignals = 0;

  for (const entry of fixture.cases) {
    const target: MatchCandidate = { ...fixture.target, ...entry.target };
    const candidates: MatchCandidate[] = entry.candidates.map((candidate) => ({ ...candidate }));
    const scores = new Map(entry.candidates.map((candidate) => [candidate.id, candidate.mappedScore]));
    const ranked = deps.rank(target, candidates, scores);
    const rankedIds = ranked.map((match) => match.post.id);
    const relevant = new Set(entry.relevantIds);

    const precisionAt = (k: number): number => {
      const denominator = Math.min(k, rankedIds.length);
      if (denominator === 0) return 0;
      return hitsIn(rankedIds, relevant, k) / denominator;
    };
    const recallAt = (k: number): number => {
      if (relevant.size === 0) return 0;
      return hitsIn(rankedIds, relevant, k) / relevant.size;
    };
    const firstRelevant = rankedIds.findIndex((id) => relevant.has(id));

    const rowUnsupported: { matchId: string; reason: string }[] = [];
    const reasonCounts: number[] = [];
    let rowEmitted = 0;
    let rowSupported = 0;
    for (const match of ranked) {
      matchesTotal++;
      const derived = deps.deriveReasons(target, match.post);
      reasonCounts.push(match.reasons.length);
      const count = String(match.reasons.length);
      histogram[count] = (histogram[count] ?? 0) + 1;
      if (match.reasons.length < deps.minimumReasons) matchesBelowReasonMinimum++;
      for (const text of match.reasons) {
        reasonsEmitted++;
        rowEmitted++;
        const derivedReason = derived.find((reason) => reason.text === text);
        const supported = derivedReason !== undefined && deps.isSupported(derivedReason, target, match.post);
        if (supported) {
          reasonsSupported++;
          rowSupported++;
        } else {
          rowUnsupported.push({ matchId: match.post.id, reason: text });
          unsupported.push({ caseId: entry.id, matchId: match.post.id, reason: text });
        }
      }
    }

    let reasonLabels: EvaluationRow["reasonLabels"] = null;
    if (entry.expectedReasonSignals && entry.expectedReasonSignals.length > 0) {
      const relevantMatch = ranked.find((match) => relevant.has(match.post.id));
      if (relevantMatch) {
        labelledCases++;
        const derivedSignals = deps.deriveReasons(target, relevantMatch.post).map((reason) => reason.signal);
        const matched = entry.expectedReasonSignals.filter((signal) => derivedSignals.includes(signal));
        expectedSignals += entry.expectedReasonSignals.length;
        matchedSignals += matched.length;
        reasonLabels = {
          expected: [...entry.expectedReasonSignals],
          derived: derivedSignals,
          matched,
          missing: entry.expectedReasonSignals.filter((signal) => !derivedSignals.includes(signal)),
        };
      }
    }

    rows.push({
      id: entry.id,
      relevantIds: [...entry.relevantIds],
      rankedIds,
      returned: rankedIds.length,
      precisionAt1: precisionAt(1),
      precisionAt3: precisionAt(3),
      precisionAt5: precisionAt(5),
      recallAt1: recallAt(1),
      recallAt3: recallAt(3),
      recallAt5: recallAt(5),
      reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
      reasonsEmitted: rowEmitted,
      reasonsSupported: rowSupported,
      reasonSupportRate: rowEmitted === 0 ? 1 : rowSupported / rowEmitted,
      matchesBelowReasonMinimum: ranked.filter((match) => match.reasons.length < deps.minimumReasons).length,
      reasonCounts,
      unsupportedReasons: rowUnsupported,
      reasonLabels,
    });

    const row = rows[rows.length - 1]!;
    row.reasonSupportRate = row.reasonsEmitted === 0 ? 1 : row.reasonsSupported / row.reasonsEmitted;
  }

  const labelledRows = rows.filter((row) => row.relevantIds.length > 0);

  return {
    fixtureVersion: fixture.version,
    evidenceKind: fixture.evidenceKind,
    createdAt: fixture.createdAt,
    fixtureSize: fixture.fixtureSize,
    caseCount: fixture.cases.length,
    labelledCaseCount: labelledRows.length,
    scope: {
      measured: [
        "the pre-bonus cutoff that decides which scored candidates are suggested",
        "the transparent category/date/location bonuses",
        "the result cap that decides how many suggestions are shown",
        "consumer reason derivation and support by the comparison",
      ],
      notMeasured: [
        "text-embedding quality: the fixture's base scores are hand-labelled synthetic inputs, not vectors from an on-device model",
        "on-device behaviour of any model",
        "the real-world false-positive rate on live reports",
        "visual matching: this build has no image-embedding capability to measure",
      ],
      precisionDefinition: "precision@k = labelled relevant candidates inside the top k / min(k, suggestions returned)",
      recallDefinition: "recall@k = labelled relevant candidates inside the top k / labelled relevant candidates; averaged over the cases that carry at least one relevant candidate",
    },
    claim: {
      statement:
        "No matching-quality claim is made. These numbers show that the ranker and the reason derivation behave as specified on the labelled cases of this fixture. They say nothing about how well the app matches real reports, because the base scores they start from are hand-written.",
      fixtureTooSmallForAQualityClaim: true,
      smallestUsefulNextStep:
        "Label real lost/found pairs on the target device, capture the native embeddings that the app actually produces, and re-run this harness over those vectors. Until that exists, the ranking policy and the device-calibration TODO stay open.",
    },
    metrics: {
      precisionAt1: mean(rows.map((row) => row.precisionAt1)),
      precisionAt3: mean(rows.map((row) => row.precisionAt3)),
      precisionAt5: mean(rows.map((row) => row.precisionAt5)),
      recallAt1: mean(labelledRows.map((row) => row.recallAt1)),
      recallAt3: mean(labelledRows.map((row) => row.recallAt3)),
      recallAt5: mean(labelledRows.map((row) => row.recallAt5)),
      reciprocalRank: mean(labelledRows.map((row) => row.reciprocalRank)),
      recallCaseCount: labelledRows.length,
    },
    reasonSupport: {
      reasonsEmitted,
      reasonsSupported,
      supportRate: reasonsEmitted === 0 ? 1 : reasonsSupported / reasonsEmitted,
      unsupported,
      matchesTotal,
      matchesBelowReasonMinimum,
      reasonCountHistogram: histogram,
    },
    reasonLabels: {
      labelledCases,
      expectedSignals,
      matchedSignals,
      agreement: expectedSignals === 0 ? 0 : matchedSignals / expectedSignals,
    },
    rows,
  };
}
