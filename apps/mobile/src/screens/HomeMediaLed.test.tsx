// @vitest-environment jsdom
// W7B-HOME (FBX-019): the Home feed scroll container carries the media-led
// hook so feed CSS can scope the separator/whitespace system to Home only.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFeedCaches } from "../hooks/feedCache";

const { fetchFeedMock, handlers, onRealtimeMock, tabTapState } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    fetchFeedMock: vi.fn(),
    handlers,
    tabTapState: { tapCount: 0 },
    onRealtimeMock: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    }),
  };
});

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../services/realtime", () => ({ onRealtime: onRealtimeMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => tabTapState }));
vi.mock("../components/PostList", () => ({
  PostList: ({ items }: { items: Array<{ id: string }> }) => (
    <ul data-testid="posts">{items.map((i) => <li key={i.id}>{i.id}</li>)}</ul>
  ),
}));

import { Home } from "./Home";

beforeEach(() => {
  fetchFeedMock.mockReset();
  onRealtimeMock.mockClear();
  handlers.clear();
  tabTapState.tapCount = 0;
  clearFeedCaches();
  fetchFeedMock.mockResolvedValue({
    items: ["a"].map((id) => ({ id, title: id })),
    nextCursor: null,
    total: 1,
  });
});

afterEach(() => {
  cleanup();
  clearFeedCaches();
});

describe("W7B-HOME Home feed container", () => {
  it("marks the feed scroll container media-led and keeps the toolbar contract", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Home />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("posts")).toBeTruthy());
    const feed = screen.getByTestId("posts").closest(".fb-home-feed");
    expect(feed).toBeTruthy();
    expect(screen.getByTestId("home-toolbar")).toBeTruthy();
  });
});
