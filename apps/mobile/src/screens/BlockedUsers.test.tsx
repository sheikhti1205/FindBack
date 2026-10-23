// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const { mockListMyBlocks, mockUnblockUser, mockFetchAccountLabels } = vi.hoisted(() => ({
  mockListMyBlocks: vi.fn(),
  mockUnblockUser: vi.fn(),
  mockFetchAccountLabels: vi.fn(),
}));

vi.mock("../services/blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/blocks")>();
  return {
    ...actual,
    listMyBlocks: (...args: unknown[]) => mockListMyBlocks(...args),
    unblockUser: (...args: unknown[]) => mockUnblockUser(...args),
  };
});

vi.mock("../services/accountLabels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accountLabels")>();
  return { ...actual, fetchAccountLabels: (...args: unknown[]) => mockFetchAccountLabels(...args) };
});

import { BlockedUsers } from "./BlockedUsers";
import { ApiError } from "../services/session";
const viewer = vi.hoisted(() => ({ id: "me" }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: viewer.id } }) }));

afterEach(cleanup);

beforeEach(() => {
  viewer.id = "me";
  vi.clearAllMocks();
  mockListMyBlocks.mockResolvedValue([
    { userId: "user-2", blockedAt: "2026-10-22T10:00:00.000Z" },
  ]);
  mockFetchAccountLabels.mockResolvedValue(new Map([["user-2", "sam"]]));
  mockUnblockUser.mockResolvedValue({ stillHidden: false });
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <BlockedUsers />
    </MemoryRouter>,
  );
}

describe("the accounts a reader blocked", () => {
  it("suppresses old-account blocked-list reads", async () => {
    let finish!: (value: { userId: string; blockedAt: string }[]) => void;
    mockListMyBlocks.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderScreen();
    viewer.id = "other";
    mockListMyBlocks.mockResolvedValue([]);
    view.rerender(<MemoryRouter><BlockedUsers /></MemoryRouter>);
    await screen.findByText(/haven’t blocked anyone/i);
    await act(async () => { finish([{ userId: "user-2", blockedAt: "2026-10-22" }]); });
    expect(screen.queryByText("Unblock sam")).toBeNull();
  });

  it("suppresses old-account unblock outcome and announcement", async () => {
    let finish!: (value: { stillHidden: boolean }) => void;
    mockUnblockUser.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const heard = vi.fn(); window.addEventListener("findback:announce", heard);
    try {
      const view = renderScreen();
      fireEvent.click(await screen.findByText("Unblock sam"));
      viewer.id = "other";
      mockListMyBlocks.mockResolvedValue([]);
      view.rerender(<MemoryRouter><BlockedUsers /></MemoryRouter>);
      await screen.findByText(/haven’t blocked anyone/i);
      await act(async () => { finish({ stillHidden: false }); });
      expect(screen.queryByTestId("blocked-users-notice")).toBeNull();
      expect(heard).not.toHaveBeenCalled();
    } finally { window.removeEventListener("findback:announce", heard); }
  });
  it("keeps an unavailable unblock honest and retains the row", async () => {
    mockUnblockUser.mockRejectedValueOnce(new ApiError("missing", 500, "PGRST202"));
    renderScreen();
    fireEvent.click(await screen.findByText("Unblock sam"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not available in this build/i);
    expect(screen.getByText("Unblock sam")).toBeTruthy();
  });
  it("names each blocked account and says the block is mutual", async () => {
    renderScreen();
    expect(await screen.findByText("Unblock sam")).toBeTruthy();
    expect(document.body.textContent).toContain("Public reports and comments remain behind a warning with an option to reveal them.");
    expect(document.body.textContent).toContain("Unblocking allows interaction unless they've also blocked you.");
  });

  it("never shows an identifier", async () => {
    renderScreen();
    await screen.findByText("Unblock sam");
    expect(document.body.textContent).not.toContain("user-2");
  });

  it("says so when nobody is blocked", async () => {
    mockListMyBlocks.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText(/haven’t blocked anyone/i)).toBeTruthy();
  });

  it("says the truth when the other side's block is still in force", async () => {
    mockUnblockUser.mockResolvedValue({ stillHidden: true });
    renderScreen();
    fireEvent.click(await screen.findByText("Unblock sam"));

    const notice = await screen.findByTestId("blocked-users-notice");
    expect(notice.textContent).toBe(
      "You've unblocked sam. You can interact again unless they've also blocked you.",
    );
    // The direction is never revealed.
    expect(notice.textContent).not.toMatch(/\bthey blocked you\b/i);
  });

  it("drops the row once the server confirmed the unblock", async () => {
    renderScreen();
    fireEvent.click(await screen.findByText("Unblock sam"));
    await waitFor(() => expect(mockUnblockUser).toHaveBeenCalledWith("user-2"));
    await waitFor(() => expect(screen.queryByText("Unblock sam")).toBeNull());
  });

  it("keeps the row and says why when the server refuses", async () => {
    mockUnblockUser.mockRejectedValue(new Error("boom"));
    renderScreen();
    fireEvent.click(await screen.findByText("Unblock sam"));
    await waitFor(() => expect(screen.getByTestId("blocked-users-error")).toBeTruthy());
    expect(screen.getByText("Unblock sam")).toBeTruthy();
  });

  it("says plainly that the list is not in this build, and never calls it empty", async () => {
    mockListMyBlocks.mockRejectedValue(new ApiError("Could not find the function", 500, "PGRST202"));
    renderScreen();
    const unavailable = await screen.findByTestId("blocked-users-unavailable");
    expect(unavailable.textContent).toMatch(/not available in this build/i);
    // An unavailable list is not an empty list.
    expect(screen.queryByText(/haven’t blocked anyone/i)).toBeNull();
    expect(unavailable.textContent).not.toMatch(/PGRST202|schema/i);
  });
});
