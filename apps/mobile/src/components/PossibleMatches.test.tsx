// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { findMock } = vi.hoisted(() => ({ findMock: vi.fn() }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock, applyMatchesEngineToRuntime: () => true }));

import { PossibleMatches } from "./PossibleMatches";

const post = { id: "lost-1", type: "LOST", status: "OPEN", title: "black umbrella", description: "wooden handle" } as never;

afterEach(cleanup);

describe("PossibleMatches", () => {
  it("lists up to five suggestions and links them with the id", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 6, matches: [
      { post: { id: "found-1", title: "Black umbrella at library", category: "Clothing", eventDate: "2026-09-11", locationLabel: "Central Library" }, score: 0.8, reasons: ["Same location"] },
      { post: { id: "found-2", title: "Umbrella near café", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.7, reasons: [] },
      { post: { id: "found-3", title: "Dark umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.6, reasons: [] },
      { post: { id: "found-4", title: "Spare umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.5, reasons: [] },
      { post: { id: "found-5", title: "Grey umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.4, reasons: [] },
      { post: { id: "found-6", title: "Sixth umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.3, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    expect(await screen.findAllByRole("link")).toHaveLength(5);
    expect(screen.getAllByRole("link")[0]!.getAttribute("href")).toBe("/posts/found-1");
    expect(screen.getByText("Black umbrella at library")).toBeTruthy();
    expect(screen.getByText(/Central Library/)).toBeTruthy();
    expect(screen.getByText(/not confirmed matches/i)).toBeTruthy();
    expect(screen.queryByText(/probability/i)).toBeNull();
    // The sixth suggestion is left out by the cap, and the copy says so as a
    // similarity result rather than as a truncation.
    expect(screen.getByText(/up to 5 possible matches/i)).toBeTruthy();
  });

  it("shows the candidate photo and the reasons without presenting similarity as a percentage", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 1, matches: [
      { post: { id: "found-1", title: "Black umbrella", category: "Clothing", eventDate: "2026-09-11", locationLabel: "Library", photoUrl: "https://example.com/umbrella.jpg" }, score: 0.8, reasons: ["Reported on the same day", "Similar title", "Same category"] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    const image = await screen.findByRole("img", { name: /black umbrella/i });
    expect(image.getAttribute("src")).toBe("https://example.com/umbrella.jpg");
    expect(screen.getByText("Reported on the same day")).toBeTruthy();
    expect(screen.getByText("Similar title")).toBeTruthy();
    expect(screen.getByText("Same category")).toBeTruthy();
    expect(screen.queryByText(/80%|match probability/i)).toBeNull();
    fireEvent.error(image);
    expect(screen.getByText("Photo unavailable")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/posts/found-1");
  });

  it("says how many reports were compared and how many looked similar enough", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 12, matches: [
      { post: { id: "found-1", title: "Black umbrella at library", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.8, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    expect(await screen.findByText(/compared 12 recent reports/i)).toBeTruthy();
    expect(screen.getByText(/1 possible match to review/i)).toBeTruthy();
  });

  it("offers the confirm action only when the recovery lane supplies a handler", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 1, matches: [
      { post: { id: "found-1", title: "Black umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.8, reasons: ["Similar title"] },
    ] });
    const onConfirmMatch = vi.fn();
    render(<MemoryRouter><PossibleMatches post={post} onConfirmMatch={onConfirmMatch} /></MemoryRouter>);
    const button = await screen.findByRole("button", { name: /confirm match: black umbrella/i });
    fireEvent.click(button);
    expect(onConfirmMatch).toHaveBeenCalledTimes(1);
    expect(onConfirmMatch.mock.calls[0]![0]).toMatchObject({ post: { id: "found-1" } });
    // With a handler there is nothing to apologise for.
    expect(screen.queryByText(/isn.t available here/i)).toBeNull();
  });

  it("says plainly that confirming is not available when no handler is supplied", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 1, matches: [
      { post: { id: "found-1", title: "Black umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.8, reasons: ["Similar title"] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    await screen.findByText("Black umbrella");
    expect(screen.queryByRole("button", { name: /confirm match/i })).toBeNull();
    expect(screen.getByText(/confirming a match isn.t available here/i)).toBeTruthy();
  });

  it("reruns matching when category/date/location change, not just title/description", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    const { rerender } = render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    await waitFor(() => expect(findMock).toHaveBeenCalledTimes(1));

    rerender(<MemoryRouter><PossibleMatches post={{ ...(post as Record<string, unknown>), category: "Clothing" } as never} /></MemoryRouter>);
    await waitFor(() => expect(findMock).toHaveBeenCalledTimes(2));

    rerender(<MemoryRouter><PossibleMatches post={{ ...(post as Record<string, unknown>), category: "Clothing", eventDate: "2026-09-11" } as never} /></MemoryRouter>);
    await waitFor(() => expect(findMock).toHaveBeenCalledTimes(3));

    rerender(<MemoryRouter><PossibleMatches post={{ ...(post as Record<string, unknown>), category: "Clothing", eventDate: "2026-09-11", latitude: 23.81, longitude: 90.41, locationLabel: "Library" } as never} /></MemoryRouter>);
    await waitFor(() => expect(findMock).toHaveBeenCalledTimes(4));
  });

  it("shows an informative empty state when the embedder is unavailable", async () => {
    findMock.mockResolvedValue({ available: false, candidatesConsidered: 0, matches: [], unavailableReason: "embed" });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/needs the on-device model/i)).toBeTruthy());
  });

  it("offers a retry when candidate loading fails", async () => {
    findMock.mockResolvedValue({ available: false, candidatesConsidered: 0, matches: [], unavailableReason: "candidates" });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/check your connection/i)).toBeTruthy());
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText(/no reports to compare/i)).toBeTruthy());
    expect(findMock).toHaveBeenCalledTimes(2);
  });

  it("shows EMPTY, not _ERROR copy, when zero candidates were compared", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/no reports to compare/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("shows how many recent reports were compared", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 4, matches: [
      { post: { id: "found-1", title: "Black umbrella at library", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.8, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    expect(await screen.findByText(/compared 4 recent reports/i)).toBeTruthy();
  });

  it("brings rows in as matching finishes and leaves them steady afterwards", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 4, matches: [
      { post: { id: "found-1", title: "Black umbrella at library", category: "Clothing", eventDate: "2026-09-11", locationLabel: "Central Library" }, score: 0.8, reasons: ["Same category"] },
      { post: { id: "found-2", title: "Umbrella near café", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.7, reasons: [] },
      { post: { id: "found-3", title: "Dark umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.6, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    const links = await screen.findAllByRole("link");
    expect(links).toHaveLength(3);

    const rows = links.map((link) => link.closest("li") as HTMLElement);
    // The last row is still queued behind the stagger the moment results land.
    expect(rows[2]!.style.opacity).toBe("0");
    await waitFor(() => expect(rows[0]!.style.opacity).toBe("1"));
    await waitFor(() => expect(rows[2]!.style.opacity).toBe("1"));
    // No endless pulse: the settled rows stay put.
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const row of rows) {
      expect(row.style.opacity).toBe("1");
      expect(row.style.transform === "" || row.style.transform === "none").toBe(true);
    }
  });

  it("updates the compared count as plain text, never tweening the number", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 4, matches: [
      { post: { id: "found-1", title: "Black umbrella at library", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.8, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    const count = await screen.findByText(/compared 4 recent reports/i);
    expect(count.textContent).toBe("Compared 4 recent reports. 1 possible match to review. Up to 5 are shown.");
    // The count line is deliberately untouched by Motion.
    expect(count.style.opacity).toBe("");
    expect(count.style.transform).toBe("");
  });

  // -------------------------------------------------------------------------
  // O5 / CF-050: a candidate whose author the viewer has blocked is EXCLUDED
  // from the pool by the service (the WHERE-style exclusion), so the surface
  // has nothing to show about it. The candidate surface discloses NOTHING
  // about blocks: the gate fixed the exclusion in the reader's WHERE clause
  // with no client-visible column, and the interim client-side filter (see
  // `services/possibleMatches.ts`) carries no count to the UI either.
  // -------------------------------------------------------------------------
  it("never mentions a block on the candidate surface", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);

    // The plain empty state — not a second one that explains a block.
    expect(await screen.findByText(/no reports to compare/i)).toBeTruthy();
    expect(
      screen.getByText("There are no open reports of the opposite type yet. Check back later as new reports are added."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/block/i);
  });

  it("says nothing about blocks next to the compared count", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 2, matches: [
      { post: { id: "found-1", title: "Black umbrella at library", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.8, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);

    expect(await screen.findByText(/compared 2 recent reports/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/block/i);
  });
});
