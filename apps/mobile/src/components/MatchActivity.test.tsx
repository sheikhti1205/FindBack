// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyMatch } from "../services/matches";
import { MatchActivity } from "./MatchActivity";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../services/matches", () => ({ listMyMatches: list }));
const match: MyMatch = {
  matchId: "m1", state: "PENDING", cancelReason: null, proposedAt: "2026-10-29T00:00:00Z",
  myReportId: "mine", myReportType: "LOST", myTitle: "My wallet",
  peerReportId: "peer", peerReportType: "FOUND", peerTitle: "Blue wallet",
  peerAvailable: true, proposedByMe: false, myConfirmed: false, myHandover: false, returnId: null,
};
function tree(accountId: string | null = "A") {
  return <MemoryRouter><MatchActivity accountId={accountId} /></MemoryRouter>;
}
function open() { fireEvent.click(screen.getByText("Match activity")); }
beforeEach(() => list.mockReset().mockResolvedValue([match]));
afterEach(cleanup);

describe("account match discovery", () => {
  it("is a compact native disclosure linking to the canonical owner controls", async () => {
    render(tree());
    const summary = screen.getByText("Match activity").closest("summary")!;
    expect(summary).not.toBeNull();
    expect(summary.closest("details")?.open).toBe(false);
    await screen.findByText("Action waiting");
    open();
    const link = await screen.findByRole("link", { name: /My wallet.*Proposal to review/i });
    expect(link.getAttribute("href")).toBe("/posts/mine#detail-matches");
    expect(list).toHaveBeenCalledWith("A", {});
  });

  it.each([
    [{ myConfirmed: true }, "Waiting for the other owner"],
    [{ state: "CONFIRMED" as const }, "Handover to record"],
    [{ state: "CONFIRMED" as const, myHandover: true }, "Waiting for the handover"],
    [{ state: "RECOVERED" as const, returnId: "r1" }, "Recovery complete"],
    [{ state: "CANCELLED" as const }, "Match ended"],
  ])("shows the relationship state without offering a second mutation interface", async (change, label) => {
    list.mockResolvedValue([{ ...match, ...change }]);
    render(tree()); open();
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm|cancel|record handover/i })).toBeNull();
  });

  it("does not expose hidden/deleted peer content or imply it can be accepted", async () => {
    list.mockResolvedValue([{ ...match, peerAvailable: false, peerTitle: "PRIVATE", peerReportId: "private-id" }]);
    render(tree()); open();
    expect(await screen.findByText("Other report unavailable")).toBeTruthy();
    expect(screen.queryByText("PRIVATE")).toBeNull();
    expect(screen.queryByText("Action waiting")).toBeNull();
    expect(document.querySelector('[href*="private-id"]')).toBeNull();
  });

  it("retains history without fabricating a route when the owner's report was deleted", async () => {
    list.mockResolvedValue([{ ...match, state: "CANCELLED", myReportId: null, myTitle: null }]);
    render(tree()); open();
    expect(await screen.findByText("Report removed")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps the disclosure empty on sign-out and suppresses stale A→B→A replies", async () => {
    let resolveA!: (rows: MyMatch[]) => void;
    list.mockImplementationOnce(() => new Promise<MyMatch[]>((resolve) => { resolveA = resolve; }));
    const view = render(tree());
    await waitFor(() => expect(list).toHaveBeenCalledWith("A", {}));
    list.mockResolvedValueOnce([{ ...match, myTitle: "B report" }]);
    view.rerender(tree("B")); open();
    await screen.findByText("B report");
    list.mockResolvedValueOnce([{ ...match, myTitle: "Fresh A report" }]);
    view.rerender(tree("A")); open();
    await screen.findByText("Fresh A report");
    await act(async () => resolveA([{ ...match, myTitle: "Stale A report" }]));
    expect(screen.queryByText("Stale A report")).toBeNull();
    view.rerender(tree(null));
    expect(screen.queryByText("Match activity")).toBeNull();
  });

  it("pages account history with a real timestamp/id cursor and deduplicates repeated rows", async () => {
    const page = Array.from({ length: 20 }, (_, index) => ({ ...match, matchId: `m${index}`, myReportId: `report-${index}`, myTitle: `Report ${index}` }));
    list.mockResolvedValueOnce(page).mockResolvedValueOnce([page[19], { ...match, matchId: "older", myTitle: "Older report" }]);
    render(tree()); open();
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier activity" }));
    await screen.findByText("Older report");
    expect(list).toHaveBeenLastCalledWith("A", { before: { at: match.proposedAt, id: "m19" } });
    expect(screen.getAllByText("Report 19")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load earlier activity" })).toBeNull();
  });

  it("uses a local error and an actual retry, not a raw backend error", async () => {
    list.mockRejectedValueOnce(new Error("SQL secret_table P0002")).mockResolvedValueOnce([]);
    render(tree()); open();
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load match activity. Try again.");
    expect(screen.queryByText(/secret_table/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh match activity" }));
    expect(await screen.findByText("No match activity yet.")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
