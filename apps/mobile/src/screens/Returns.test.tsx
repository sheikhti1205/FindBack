// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const {
  mockListMyRecoveries,
  mockFetchStanding,
  mockFetchReputationTier,
  mockRateReturn,
  mockFetchPost,
  mockFetchAccountLabels,
} = vi.hoisted(() => ({
  mockListMyRecoveries: vi.fn(),
  mockFetchStanding: vi.fn(),
  mockFetchReputationTier: vi.fn(),
  mockRateReturn: vi.fn(),
  mockFetchPost: vi.fn(),
  mockFetchAccountLabels: vi.fn(),
}));

const viewer = vi.hoisted(() => ({ id: "me" }));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: viewer.id }, booting: false, bootError: null, needsProfile: false }),
}));

// The service is mocked, not the network: the real vocabulary, the real
// labels and the real "not available in this build" answer stay in place.
vi.mock("../services/trust", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/trust")>();
  return {
    ...actual,
    listMyRecoveries: (...args: unknown[]) => mockListMyRecoveries(...args),
    fetchStanding: (...args: unknown[]) => mockFetchStanding(...args),
    fetchReputationTier: (...args: unknown[]) => mockFetchReputationTier(...args),
    rateReturn: (...args: unknown[]) => mockRateReturn(...args),
  };
});

vi.mock("../services/posts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/posts")>();
  return { ...actual, fetchPost: (...args: unknown[]) => mockFetchPost(...args) };
});

vi.mock("../services/accountLabels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accountLabels")>();
  return { ...actual, fetchAccountLabels: (...args: unknown[]) => mockFetchAccountLabels(...args) };
});

import { Returns } from "./Returns";
import { ApiError } from "../services/session";
import { TRUST_UNAVAILABLE_CODE } from "../services/trust";

afterEach(cleanup);

const RECOVERY = {
  returnId: "ret-1",
  lostPostId: "post-1",
  counterpartUserId: "user-2",
  externalHelper: false,
  recoveredAt: "2026-10-22T10:00:00.000Z",
  myRating: null,
  counterpartRating: null,
};

beforeEach(() => {
  viewer.id = "me";
  vi.clearAllMocks();
  mockListMyRecoveries.mockResolvedValue([RECOVERY]);
  mockFetchStanding.mockResolvedValue("GOOD");
  mockFetchReputationTier.mockResolvedValue("NORMAL");
  mockRateReturn.mockResolvedValue("rating-1");
  mockFetchPost.mockResolvedValue({ id: "post-1", userId: "me", title: "Blue backpack" });
  mockFetchAccountLabels.mockResolvedValue(new Map([["user-2", "sam"]]));
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <Returns />
    </MemoryRouter>,
  );
}

describe("recovered items", () => {
  it("suppresses previous-account recovery reads without further metadata requests", async () => {
    let finish!: (value: typeof RECOVERY[]) => void;
    mockListMyRecoveries.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderScreen();
    viewer.id = "other";
    mockListMyRecoveries.mockResolvedValue([]);
    view.rerender(<MemoryRouter><Returns /></MemoryRouter>);
    await screen.findByText("Nothing has been recovered yet.");
    mockFetchAccountLabels.mockClear();
    await act(async () => { finish([RECOVERY]); });
    expect(screen.queryByText("Blue backpack")).toBeNull();
    expect(mockFetchAccountLabels).not.toHaveBeenCalled();
  });

  it("suppresses previous-account rating completion and announcement", async () => {
    let finish!: () => void;
    mockRateReturn.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const heard = vi.fn(); window.addEventListener("findback:announce", heard);
    try {
      const view = renderScreen();
      fireEvent.click(await screen.findByRole("button", { name: /rate sam 5/i }));
      viewer.id = "other";
      mockListMyRecoveries.mockResolvedValue([]);
      view.rerender(<MemoryRouter><Returns /></MemoryRouter>);
      await screen.findByText("Nothing has been recovered yet.");
      await act(async () => { finish(); });
      expect(screen.queryByTestId("returns-notice")).toBeNull();
      expect(heard).not.toHaveBeenCalled();
    } finally { window.removeEventListener("findback:announce", heard); }
  });
  it("keeps recovery errors distinct from empty and retries independently", async () => {
    mockListMyRecoveries.mockRejectedValueOnce(new ApiError("missing", 501, TRUST_UNAVAILABLE_CODE));
    renderScreen();
    expect(await screen.findByTestId("returns-unavailable")).toBeTruthy();
    expect(screen.queryByText("Nothing has been recovered yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry recovered items" }));
    expect(await screen.findByText("Blue backpack")).toBeTruthy();
  });

  it("shows independent standing and reputation read errors rather than swallowing them", async () => {
    mockFetchStanding.mockRejectedValueOnce(new Error("network"));
    mockFetchReputationTier.mockRejectedValueOnce(new ApiError("missing", 501, TRUST_UNAVAILABLE_CODE));
    renderScreen();
    expect(await screen.findByTestId("standing-error")).toBeTruthy();
    expect((await screen.findByTestId("reputation-error")).textContent).toMatch(/not available in this build/i);
    expect(await screen.findByText("Blue backpack")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry standing" }));
    expect(await screen.findByTestId("returns-standing")).toBeTruthy();
  });

  it("names an unavailable rating write without claiming a save", async () => {
    mockRateReturn.mockRejectedValueOnce(new ApiError("missing", 501, TRUST_UNAVAILABLE_CODE));
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /rate sam 5/i }));
    expect((await screen.findByTestId("returns-error")).textContent).toMatch(/Rating.*not available in this build/i);
    expect(screen.queryByTestId("returns-notice")).toBeNull();
  });
  it("summarises the recovery in words, and says which side the reader was on", async () => {
    renderScreen();
    expect(await screen.findByText("Blue backpack")).toBeTruthy();
    expect(screen.getByText(/Your item came back/)).toBeTruthy();
    expect(document.body.textContent).toContain("with sam");
    expect(document.body.textContent).not.toContain("post-1");
  });

  it("shows the standing and the reputation as a sentence, never a score", async () => {
    renderScreen();
    expect(await screen.findByTestId("returns-standing")).toBeTruthy();
    expect(screen.getByTestId("returns-standing").textContent).toMatch(/good standing/i);
    expect(screen.getByTestId("returns-tier").textContent).toMatch(/established member/i);
    expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*5\s*trust/i);
  });

  it("offers the rating to a participant who has not rated yet", async () => {
    renderScreen();
    const button = await screen.findByRole("button", { name: /rate sam 4 out of 5/i });
    expect(button).toBeTruthy();
  });

  it("sends the rating the reader chose", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /rate sam 5 out of 5/i }));
    await waitFor(() =>
      expect(mockRateReturn).toHaveBeenCalledWith(
        expect.objectContaining({ returnId: "ret-1", score: 5, selfUserId: "me" }),
      ),
    );
  });

  it("offers no rating once the reader has rated", async () => {
    mockListMyRecoveries.mockResolvedValue([{ ...RECOVERY, myRating: 4 }]);
    renderScreen();
    expect(await screen.findByText("You rated 4 of 5")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /rate sam/i })).toBeNull();
  });

  it("offers no rating for a recovery with nobody to rate", async () => {
    mockListMyRecoveries.mockResolvedValue([
      { ...RECOVERY, counterpartUserId: null, externalHelper: true },
    ]);
    renderScreen();
    expect(await screen.findByText("Nothing to rate")).toBeTruthy();
  });

  it("shows the server's refusal as a sentence", async () => {
    mockRateReturn.mockRejectedValue(new ApiError("duplicate key", 409, "23505"));
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /rate sam 5 out of 5/i }));
    await waitFor(() => expect(screen.getByTestId("returns-error")).toBeTruthy());
    expect(screen.getByTestId("returns-error").textContent).toBe("You have already rated this recovery.");
  });

  it("says plainly that the feature is not in this build when the server has no such function", async () => {
    mockListMyRecoveries.mockRejectedValue(
      new ApiError("This part of the trust system is not available in this build.", 501, TRUST_UNAVAILABLE_CODE),
    );
    renderScreen();
    expect(await screen.findByTestId("returns-unavailable")).toBeTruthy();
    expect(screen.getByTestId("returns-unavailable").textContent).toMatch(/not available in this build/i);
  });
});
