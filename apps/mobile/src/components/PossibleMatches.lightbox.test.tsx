// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { findMock } = vi.hoisted(() => ({ findMock: vi.fn() }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock, applyMatchesEngineToRuntime: () => true }));

import { PossibleMatches } from "./PossibleMatches";

const post = { id: "lost-1", type: "LOST", status: "OPEN", title: "black umbrella", description: "wooden handle" } as never;

afterEach(cleanup);

describe("PossibleMatches lightbox (W7)", () => {
  it("opens the canonical PhotoLightbox straight in on a match photo tap", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 1, matches: [
      { post: { id: "found-1", title: "Black umbrella", category: "Clothing", eventDate: null, locationLabel: null, photoUrl: "https://example.com/umbrella.jpg" }, score: 0.8, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);

    const photoButton = await screen.findByRole("button", { name: /open photo for black umbrella/i });
    fireEvent.click(photoButton);
    expect(screen.getByTestId("photo-lightbox")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close photo preview/i }));
    await waitFor(() => expect(screen.queryByTestId("photo-lightbox")).toBeNull());
  });

  it("keeps alt text, the broken-image fallback, and title navigation intact", async () => {
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 1, matches: [
      { post: { id: "found-1", title: "Black umbrella", category: "Clothing", eventDate: null, locationLabel: null, photoUrl: "https://example.com/umbrella.jpg" }, score: 0.8, reasons: [] },
    ] });
    render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);

    const image = await screen.findByRole("img", { name: /photo for black umbrella/i });
    expect(image.getAttribute("src")).toBe("https://example.com/umbrella.jpg");
    fireEvent.error(image);
    expect(screen.getByText("Photo unavailable")).toBeTruthy();
    expect(screen.queryByTestId("photo-lightbox")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/posts/found-1");
  });
});
