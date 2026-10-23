// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockSubmitReport, mockIsBlockedWithMe, authState, listMyBlocks, blockUser, unblockUser, announce } = vi.hoisted(() => ({
  mockSubmitReport: vi.fn(),
  mockIsBlockedWithMe: vi.fn(),
  authState: { user: { id: "reader" } as { id: string } | null },
  listMyBlocks: vi.fn(),
  blockUser: vi.fn(),
  unblockUser: vi.fn(),
  announce: vi.fn(),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("./LiveRegion", () => ({ announce }));

vi.mock("../services/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/moderation")>();
  return { ...actual, submitReport: (...args: unknown[]) => mockSubmitReport(...args) };
});

vi.mock("../services/blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/blocks")>();
  return { ...actual, listMyBlocks, blockUser, unblockUser, isBlockedWithMe: (...args: unknown[]) => mockIsBlockedWithMe(...args) };
});

import { SafetyActions } from "./SafetyActions";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: "reader" };
  listMyBlocks.mockResolvedValue([]);
  blockUser.mockResolvedValue(true);
  unblockUser.mockResolvedValue({ stillHidden: true });
  mockSubmitReport.mockResolvedValue({ reportId: "report-1" });
  mockIsBlockedWithMe.mockResolvedValue(false);
});

function openActions() {
  fireEvent.click(screen.getByRole("button", { name: /More (report|profile|comment) actions/ }));
}

describe("the safety overflow on a report or comment", () => {
  it("keeps one compact trigger and lazily opens the canonical block control", async () => {
    render(
      <SafetyActions
        content={{ targetType: "POST", targetId: "post-1" }}
        person={{ userId: "user-2", name: "Sam" }}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(listMyBlocks).not.toHaveBeenCalled();
    openActions();
    expect(screen.getByRole("menuitem", { name: "Report post" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Block account" }));
    expect(await screen.findByRole("button", { name: "Block Sam" })).toBeTruthy();
    expect(listMyBlocks).toHaveBeenCalledTimes(1);
  });

  it("reports the content itself, with the right target", async () => {
    render(
      <SafetyActions
        content={{ targetType: "COMMENT", targetId: "comment-1" }}
        person={{ userId: "user-2", name: "Sam" }}
      />,
    );
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report comment" }));
    expect(screen.getByRole("dialog", { name: /report a problem/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));
    await waitFor(() => expect(mockSubmitReport).toHaveBeenCalledTimes(1));
    expect(mockSubmitReport).toHaveBeenCalledWith({
      targetType: "COMMENT",
      targetId: "comment-1",
      reason: "HARASSMENT",
      detail: null,
    });
  });
});

describe("the safety overflow on a profile", () => {
  it("offers to report the person, not the profile", () => {
    render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    openActions();
    expect(screen.getByRole("menuitem", { name: "Report user" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Report post" })).toBeNull();
  });

  it("reports the person as a person", async () => {
    render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report user" }));
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));
    await waitFor(() => expect(mockSubmitReport).toHaveBeenCalledTimes(1));
    expect(mockSubmitReport).toHaveBeenCalledWith({
      targetType: "USER",
      targetId: "user-2",
      reason: "HARASSMENT",
      detail: null,
    });
  });

  it("has no guest or self-target actions", () => {
    authState.user = null;
    const view = render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    expect(screen.queryByRole("button")).toBeNull();
    authState.user = { id: "user-2" };
    view.rerender(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(listMyBlocks).not.toHaveBeenCalled();
  });

  it("closes old report UI across target and account changes", () => {
    const view = render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report user" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<SafetyActions reportPerson person={{ userId: "user-3", name: "Lee" }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    openActions();
    authState.user = { id: "other-reader" };
    view.rerender(<SafetyActions reportPerson person={{ userId: "user-3", name: "Lee" }} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("supports menu arrows and Escape focus return", () => {
    render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    const trigger = screen.getByRole("button", { name: "More profile actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Report user" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Block account" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("runs the canonical confirmed block action for the loaded person", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Block account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Block Sam" }));
    expect((await screen.findByTestId("block-outcome")).textContent).toContain("You blocked Sam.");
    expect(blockUser).toHaveBeenCalledExactlyOnceWith("user-2");
    expect(unblockUser).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a late report %s after account replacement", async (settle) => {
    let resolve!: (value: { reportId: string }) => void;
    let reject!: (error: Error) => void;
    mockSubmitReport.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const view = render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report user" }));
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    authState.user = { id: "replacement-reader" };
    view.rerender(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    await act(async () => { if (settle === "resolve") resolve({ reportId: "old-receipt" }); else reject(new Error("Old refusal")); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(announce).not.toHaveBeenCalled();
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report user" }));
    expect(screen.queryByTestId("report-receipt")).toBeNull();
    expect(screen.queryByTestId("report-error")).toBeNull();
  });

  it("ignores a late block membership read after target replacement", async () => {
    let resolve!: (rows: { userId: string }[]) => void;
    listMyBlocks.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
    const view = render(<SafetyActions reportPerson person={{ userId: "user-2", name: "Sam" }} />);
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Block account" }));
    expect((screen.getByTestId("block-control") as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<SafetyActions reportPerson person={{ userId: "user-3", name: "Lee" }} />);
    await act(async () => { resolve([{ userId: "user-2" }]); });
    expect(screen.queryByRole("dialog")).toBeNull();
    openActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Block account" }));
    expect((await screen.findByRole("button", { name: "Block Lee" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Unblock Sam" })).toBeNull();
  });
});
