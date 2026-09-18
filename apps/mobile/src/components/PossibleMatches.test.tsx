// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { findMock } = vi.hoisted(() => ({ findMock: vi.fn() }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock }));

import { PossibleMatches } from "./PossibleMatches";

const post = { id: "lost-1", type: "LOST", status: "OPEN", title: "black umbrella", description: "wooden handle" } as never;

afterEach(cleanup);

describe("PossibleMatches", () => {
  it("lists at most three suggestions and links them with the id", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 4, matches: [
      { post: { id: "found-1", title: "Black umbrella at library", category: "Clothing", eventDate: "2026-09-11", locationLabel: "Central Library" }, score: 0.8, reasons: ["same category"] },
      { post: { id: "found-2", title: "Umbrella near café", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.7, reasons: [] },
      { post: { id: "found-3", title: "Dark umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.6, reasons: [] },
      { post: { id: "found-4", title: "Spare umbrella", category: "Clothing", eventDate: null, locationLabel: null }, score: 0.5, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    expect(await screen.findAllByRole("link")).toHaveLength(3);
    expect(screen.getAllByRole("link")[0]!.getAttribute("href")).toBe("/posts/found-1");
    expect(screen.getByText("Black umbrella at library")).toBeTruthy();
    expect(screen.getByText(/Central Library/)).toBeTruthy();
    expect(screen.getByText(/not confirmed matches/i)).toBeTruthy();
    expect(screen.queryByText(/probability/i)).toBeNull();
  });

  it("reruns matching when category/date/location change, not just title/description (WP7 #39)", async () => {
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
    await waitFor(() => expect(screen.getByText(/no possible matches/i)).toBeTruthy());
    expect(findMock).toHaveBeenCalledTimes(2);
  });
});