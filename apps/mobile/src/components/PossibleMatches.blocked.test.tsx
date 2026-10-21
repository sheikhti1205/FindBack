// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Category, PostItem } from "@findback/shared";

import { findPossibleMatches } from "../services/possibleMatches";

/**
 * O5 / CF-050 on the Possible Matches surface.
 *
 * The candidate surface is licensed to differ from ordinary public
 * visibility (MODERATION-CONTRACT-DECISION.md §13.9, branch 1: "unlike
 * ordinary public visibility"), and the CF-050 D40/D41 gate's Decision 1 fixes
 * EXCLUSION as the mechanism for an actionable matching candidate. A match
 * card exists to suggest reaching that person, so a shielded-but-visible card
 * would still read as a suggestion: the candidate is dropped from the pool
 * instead, and the compared count never counts it.
 *
 * The gate's END STATE is an exclusion in the candidate RPC's WHERE clause,
 * with no client-visible column and no widened candidate type. That reader
 * does not exist in the database yet, so the service runs the SAME exclusion
 * on the RAW rows it receives, BEFORE they are mapped to a candidate — the
 * interim that stands in for the server reader until it lands.
 *
 * The bit itself is direction-free: the caller is blocked WITH the candidate's
 * author, in either direction, and nothing here says which. Nothing here
 * discloses it either: the surface says nothing about blocks.
 */

const target = {
  id: "lost-1",
  type: "LOST",
  status: "OPEN",
  title: "black umbrella",
  description: "wooden handle",
  category: "Clothing",
  eventDate: null,
  locationLabel: null,
  latitude: null,
  longitude: null,
} as never;

/** A RAW candidate row, the way the feed reader returns it. */
function rawCandidate(id: string, overrides: Partial<PostItem> = {}): PostItem {
  return {
    id,
    title: `umbrella ${id}`,
    description: "wooden handle",
    category: "Clothing" as Category,
    eventDate: null,
    locationLabel: null,
    latitude: null,
    longitude: null,
    attachments: [],
    ...overrides,
  } as unknown as PostItem;
}

/** One vector per input text; the content itself is irrelevant here. */
function embedder() {
  return vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
}

describe("Possible Matches — blocked candidate (O5)", () => {
  it("never surfaces a candidate whose author the viewer has blocked", async () => {
    const embed = embedder();
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [
        rawCandidate("found-blocked", { title: "blocked umbrella", blockedAuthor: true }),
        rawCandidate("found-open", { title: "open umbrella" }),
      ],
      embed,
    });

    expect(result.available).toBe(true);
    expect(result.matches.map((match) => match.post.id)).toEqual(["found-open"]);
    expect(result.matches.some((match) => match.post.id === "found-blocked")).toBe(false);
  });

  it("never compares (embeds) a blocked candidate", async () => {
    const embed = embedder();
    await findPossibleMatches(target, {
      fetchCandidates: async () => [
        rawCandidate("found-blocked", { title: "blocked umbrella", blockedAuthor: true }),
        rawCandidate("found-open", { title: "open umbrella" }),
      ],
      embed,
    });

    // Only the target and the open candidate were embedded.
    expect(embed).toHaveBeenCalledTimes(1);
    const texts = embed.mock.calls[0]![0] as string[];
    expect(texts).toHaveLength(2);
    expect(texts.join(" | ")).not.toContain("blocked umbrella");
  });

  it("keeps the compared count truthful: the blocked row is not counted as compared", async () => {
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [
        rawCandidate("found-blocked", { blockedAuthor: true }),
        rawCandidate("found-open"),
      ],
      embed: embedder(),
    });

    expect(result.candidatesConsidered).toBe(1);
  });

  it("treats an absent blocked flag as not blocked", async () => {
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [rawCandidate("found-open")],
      embed: embedder(),
    });

    expect(result.matches.map((match) => match.post.id)).toEqual(["found-open"]);
    expect(result.candidatesConsidered).toBe(1);
  });

  it("reports an all-blocked pool as nothing compared, not as a failure", async () => {
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [
        rawCandidate("found-a", { blockedAuthor: true }),
        rawCandidate("found-b", { blockedAuthor: true }),
      ],
      embed: embedder(),
    });

    expect(result.available).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.candidatesConsidered).toBe(0);
  });

  it("still ranks and surfaces a candidate from an unblocked author", async () => {
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [rawCandidate("found-open")],
      embed: embedder(),
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.post.id).toBe("found-open");
    expect(result.matches[0]!.post.title).toBe("umbrella found-open");
  });

  it("excludes the blocked rows BEFORE the pool cap, so the compared pool keeps its size", async () => {
    // A pool capped first would be smaller than the server-side end state
    // (20 unblocked rows) whenever any of the raw rows is blocked. The
    // exclusion therefore runs first, and the compared count is what was
    // really compared.
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => rawCandidate(`blocked-${i}`, { blockedAuthor: true })),
      rawCandidate("found-open"),
    ];
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => rows,
      embed: embedder(),
    });

    expect(result.candidatesConsidered).toBe(1);
    expect(result.matches.map((match) => match.post.id)).toEqual(["found-open"]);
  });
});
