// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock, handlers, onRealtimeMock } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    fetchFeedMock: vi.fn(),
    handlers,
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
vi.mock("../components/TabTap", () => ({ useTabTap: () => ({ tapCount: 0 }) }));
vi.mock("../components/PostList", () => ({
  PostList: ({ items }: { items: Array<{ id: string }> }) => (
    <ul data-testid="posts">{items.map((i) => <li key={i.id}>{i.id}</li>)}</ul>
  ),
}));

import { Home } from "./Home";
import { clearFeedCaches } from "../hooks/feedCache";

function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(payload);
}

describe("Home realtime (WP9)", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    onRealtimeMock.mockClear();
    handlers.clear();
    clearFeedCaches();
    fetchFeedMock.mockResolvedValue({
      items: ["a", "b", "c"].map((id) => ({ id, title: id })),
      nextCursor: null,
      total: 3,
    });
  });

  afterEach(() => {
    cleanup();
    clearFeedCaches();
  });

  it("reconciles a deleted post in place without refetching", async () => {
    render(<Home />);
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fetchFeedMock.mockClear();

    act(() => emit("post:deleted", { postId: "b", op: "DELETE" }));

    expect(screen.queryByText("b")).toBeNull();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });
});
