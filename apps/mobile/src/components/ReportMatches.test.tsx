// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { PostItem } from "@findback/shared";
import type { MyMatch } from "../services/matches";
import { ApiError } from "../services/session";
import { ReportMatches } from "./ReportMatches";

const ports = vi.hoisted(() => ({
  list: vi.fn(), propose: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), handover: vi.fn(), suggestions: vi.fn(),
}));
vi.mock("../services/matches", () => ({
  listMyMatches: ports.list, proposeMatch: ports.propose, confirmMatch: ports.confirm,
  cancelMatch: ports.cancel, handoverMatch: ports.handover,
}));
vi.mock("../services/possibleMatches", () => ({
  findPossibleMatches: ports.suggestions, applyMatchesEngineToRuntime: () => true,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "A" } }) }));

const post = {
  id: "mine", userId: "A", author: { id: "A", username: "owner" }, type: "LOST", status: "OPEN",
  title: "My wallet", description: "Blue wallet", category: "Wallet", attachments: [],
} as unknown as PostItem;
const match: MyMatch = {
  matchId: "m1", state: "PENDING", cancelReason: null, proposedAt: "2026-10-29T00:00:00Z",
  myReportId: "mine", myReportType: "LOST", myTitle: "My wallet", peerReportId: "peer",
  peerReportType: "FOUND", peerTitle: "Blue wallet", peerAvailable: true,
  proposedByMe: false, myConfirmed: false, myHandover: false, returnId: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  ports.list.mockResolvedValue([]);
  ports.propose.mockResolvedValue("m1"); ports.confirm.mockResolvedValue("MATCHED");
  ports.cancel.mockResolvedValue(undefined); ports.handover.mockResolvedValue("PARTIAL");
  ports.suggestions.mockResolvedValue({ available: true, candidatesConsidered: 1, matches: [{
    post: { id: "peer", title: "Blue wallet", category: "Wallet", photoUrl: null }, score: 0.8,
    reasons: ["Same category"],
  }] });
});
afterEach(cleanup);
function mount(accountId = "A", onChanged = vi.fn()) {
  return { ...render(<MemoryRouter><ReportMatches accountId={accountId} post={post} onChanged={onChanged} /></MemoryRouter>), onChanged };
}

describe("report matching consumer flow", () => {
  it("requires explicit proposal consent rather than accepting a suggestion on tap", async () => {
    const { onChanged } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /propose match: blue wallet/i }));
    expect(ports.propose).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /propose this match/i });
    expect(within(dialog).getByText(/other owner must also agree/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /send proposal/i }));
    await waitFor(() => expect(ports.propose).toHaveBeenCalledWith("A", "mine", "peer"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/proposal sent/i)).toBeTruthy();
  });

  it("accepts the incoming owner's proposal only after explicit confirmation", async () => {
    ports.list.mockResolvedValue([match]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /review proposal/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm this match/i });
    expect(within(dialog).getByText(/does not mark the item recovered/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm match/i }));
    await waitFor(() => expect(ports.confirm).toHaveBeenCalledWith("A", "m1"));
    expect(await screen.findByText(/both owners confirmed/i)).toBeTruthy();
  });

  it("does not allow a proposer to count as the other owner's consent", async () => {
    ports.list.mockResolvedValue([{ ...match, proposedByMe: true, myConfirmed: true }]);
    mount();
    expect(await screen.findByText(/waiting for the other owner/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /review proposal/i })).toBeNull();
  });

  it("separates actual handover from match acceptance and preserves a partial receipt", async () => {
    ports.list.mockResolvedValue([{ ...match, state: "CONFIRMED", myConfirmed: true }]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /record handover/i }));
    const dialog = screen.getByRole("dialog", { name: /has the item been handed over/i });
    expect(within(dialog).getByText(/both owners must record/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /yes, record handover/i }));
    await waitFor(() => expect(ports.handover).toHaveBeenCalledWith("A", "m1"));
    expect(await screen.findByText(/handover recorded.*waiting for the other owner/i)).toBeTruthy();
  });

  it("explains wrong-match correction before cancellation", async () => {
    ports.list.mockResolvedValue([{ ...match, state: "CONFIRMED", myConfirmed: true }]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /wrong match/i }));
    const dialog = screen.getByRole("dialog", { name: /cancel this match/i });
    expect(within(dialog).getByText(/both reports will reopen/i)).toBeTruthy();
    expect(ports.cancel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel match/i }));
    await waitFor(() => expect(ports.cancel).toHaveBeenCalledWith("A", "m1"));
  });

  it("keeps unavailable-peer history neutral and completed recoveries terminal", async () => {
    ports.list.mockResolvedValue([{ ...match, state: "RECOVERED", returnId: "ret", peerAvailable: false,
      peerTitle: null, peerReportId: null, peerReportType: null }]);
    mount();
    expect(await screen.findByText(/other report unavailable/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /view recovery/i }).getAttribute("href")).toBe("/returns");
    expect(screen.queryByRole("button", { name: /wrong match|record handover|review proposal/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Blue wallet" })).toBeNull();
  });

  it("preserves actionable state on refusal without reporting a successful write", async () => {
    ports.list.mockResolvedValue([match]);
    ports.confirm.mockRejectedValue(new ApiError("This match is no longer available.", 404, "MATCH_UNAVAILABLE"));
    const { onChanged } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /review proposal/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /confirm match/i }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This match is no longer available.");
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText(/both owners confirmed/i)).toBeNull();
    expect(screen.getByRole("button", { name: /refresh match status/i })).toBeTruthy();
  });

  it("does not offer owner writes on a report belonging to someone else", async () => {
    mount("B");
    await screen.findByText("Blue wallet");
    expect(ports.list).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /propose match|review proposal/i })).toBeNull();
  });

  it("does not publish an old account's write receipt after remount", async () => {
    ports.list.mockResolvedValue([match]);
    let done!: (value: string) => void;
    ports.confirm.mockImplementation(() => new Promise((resolve) => { done = resolve; }));
    const { rerender, onChanged } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /review proposal/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /confirm match/i }));
    await waitFor(() => expect(ports.confirm).toHaveBeenCalledTimes(1));
    rerender(<MemoryRouter><ReportMatches accountId="B" post={post} onChanged={onChanged} /></MemoryRouter>);
    await act(async () => { done("MATCHED"); });
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText(/both owners confirmed/i)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
