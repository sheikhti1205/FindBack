// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostItem } from "@findback/shared";
import type { PossibleMatchesResult } from "../services/possibleMatches";

const state = vi.hoisted(() => ({ account: "viewer-a" as string | null, find: vi.fn(), preferences: vi.fn(), apply: vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: state.account ? { id: state.account } : null }) }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: state.find, applyMatchesEngineToRuntime: state.apply }));
vi.mock("../services/ai/aiPreferences", () => ({ loadAiPreferences: state.preferences }));

import { PossibleMatches } from "./PossibleMatches";

const post = { id: "lost-shared", type: "LOST", status: "OPEN", title: "Umbrella", description: "Wooden handle" } as PostItem;
function result(title: string): PossibleMatchesResult {
  return { available: true, candidatesConsidered: 1, matches: [{
    post: { id: title, title, description: null, category: "Clothing", eventDate: null,
      locationLabel: null, locationLat: null, locationLng: null, photoUrl: null },
    score: 0.8, reasons: [],
  }] };
}
function deferred() {
  let resolve!: (value: PossibleMatchesResult) => void;
  const promise = new Promise<PossibleMatchesResult>(done => { resolve = done; });
  return { promise, resolve };
}
const beforePaint: boolean[] = [];
function View() {
  useLayoutEffect(() => {
    if (state.account === "viewer-b") beforePaint.push(screen.queryByText("Visible only in A pool") !== null);
  }, [state.account]);
  return <MemoryRouter><PossibleMatches post={post} /></MemoryRouter>;
}
function view() { return <View />; }

beforeEach(() => {
  state.account = "viewer-a";
  beforePaint.length = 0;
  state.find.mockReset();
  state.apply.mockReset().mockReturnValue(true);
  state.preferences.mockReset().mockReturnValue({ matchesEngine: "use" });
});
afterEach(cleanup);

describe("PossibleMatches viewer-scoped results", () => {
  it("withdraws settled results when the viewer changes without changing the report", async () => {
    const next = deferred();
    state.find.mockResolvedValueOnce(result("Visible only in A pool")).mockReturnValueOnce(next.promise);
    const { rerender } = render(view());
    expect(await screen.findByText("Visible only in A pool")).toBeTruthy();
    expect(state.apply).toHaveBeenLastCalledWith("use");

    state.account = "viewer-b";
    state.preferences.mockReturnValue({ matchesEngine: "needle" });
    state.apply.mockReturnValue(false);
    rerender(view());
    expect(beforePaint).toEqual([false]);
    expect(screen.queryByText("Visible only in A pool")).toBeNull();
    expect(state.preferences).toHaveBeenLastCalledWith("viewer-b");
    expect(state.apply).toHaveBeenLastCalledWith("needle");
    expect(state.find).toHaveBeenCalledTimes(2);
    await act(async () => { next.resolve(result("B pool")); });
    expect(screen.getByText("B pool")).toBeTruthy();
  });

  it("does not publish an old viewer's response after an in-flight account switch", async () => {
    const first = deferred();
    const second = deferred();
    state.find.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(view());
    expect(state.find).toHaveBeenCalledTimes(1);

    state.account = "viewer-b";
    rerender(view());
    await act(async () => { first.resolve(result("Late A pool")); });
    expect(screen.queryByText("Late A pool")).toBeNull();
    expect(state.find).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(result("Current B pool")); });
    expect(screen.getByText("Current B pool")).toBeTruthy();
  });

  it("control: a report change already invalidates the previous request", async () => {
    const first = deferred();
    const second = deferred();
    state.find.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    rerender(<MemoryRouter><PossibleMatches post={{ ...post, id: "another-lost" }} /></MemoryRouter>);
    await act(async () => { first.resolve(result("Old report pool")); });
    expect(screen.queryByText("Old report pool")).toBeNull();
    expect(state.find).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(result("New report pool")); });
    expect(screen.getByText("New report pool")).toBeTruthy();
  });

  it("logout withdraws the authenticated pool even when the surface remains mounted", async () => {
    state.find.mockResolvedValueOnce(result("Signed-in pool"))
      .mockResolvedValueOnce({ available: true, candidatesConsidered: 0, matches: [] });
    const { rerender } = render(view());
    expect(await screen.findByText("Signed-in pool")).toBeTruthy();
    state.account = null;
    rerender(view());
    expect(screen.queryByText("Signed-in pool")).toBeNull();
    expect(await screen.findByText("No reports to compare")).toBeTruthy();
    expect(state.preferences).toHaveBeenLastCalledWith("local");
  });

  it("A to B to A cannot revive the first A request", async () => {
    const firstA = deferred();
    const b = deferred();
    const secondA = deferred();
    state.find.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);
    const { rerender } = render(view());
    state.account = "viewer-b";
    rerender(view());
    state.account = "viewer-a";
    rerender(view());
    await act(async () => {
      firstA.resolve(result("Obsolete A pool"));
      b.resolve(result("Obsolete B pool"));
    });
    expect(screen.queryByText("Obsolete A pool")).toBeNull();
    expect(screen.queryByText("Obsolete B pool")).toBeNull();
    await act(async () => { secondA.resolve(result("Latest A pool")); });
    expect(screen.getByText("Latest A pool")).toBeTruthy();
    expect(state.find).toHaveBeenCalledTimes(3);
  });

  it("closes the canonical photo viewer and does not reopen it for the new account", async () => {
    const photo = result("Same photo candidate");
    photo.matches[0]!.post.photoUrl = "https://example.invalid/umbrella.jpg";
    const next = deferred();
    state.find.mockResolvedValueOnce(photo).mockReturnValueOnce(next.promise);
    const { rerender } = render(view());
    fireEvent.click(await screen.findByRole("button", { name: /open photo for same photo candidate/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    state.account = "viewer-b";
    rerender(view());
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { next.resolve(photo); });
    expect(screen.getByText("Same photo candidate")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("new-account load failure never falls back to old results and remains retryable", async () => {
    state.find.mockResolvedValueOnce(result("A before failure"))
      .mockResolvedValueOnce({ available: false, unavailableReason: "candidates", candidatesConsidered: 0, matches: [] })
      .mockResolvedValueOnce(result("B retry pool"));
    const { rerender } = render(view());
    expect(await screen.findByText("A before failure")).toBeTruthy();
    state.account = "viewer-b";
    rerender(view());
    expect(screen.queryByText("A before failure")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("B retry pool")).toBeTruthy();
    expect(state.preferences).toHaveBeenLastCalledWith("viewer-b");
  });

  it("same-account social refresh retains the settled pool without reranking", async () => {
    state.find.mockResolvedValue(result("Stable pool"));
    const { rerender } = render(<MemoryRouter><PossibleMatches post={post} /></MemoryRouter>);
    expect(await screen.findByText("Stable pool")).toBeTruthy();
    rerender(<MemoryRouter><PossibleMatches post={{ ...post, likeCount: 12 }} /></MemoryRouter>);
    expect(screen.getByText("Stable pool")).toBeTruthy();
    expect(state.find).toHaveBeenCalledTimes(1);
  });
});
