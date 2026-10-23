// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockFetchModerationTarget, mockApplyModeration, viewer } = vi.hoisted(() => ({
  mockFetchModerationTarget: vi.fn(),
  mockApplyModeration: vi.fn(),
  viewer: { id: "moderator-a" },
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: viewer.id } }) }));

vi.mock("../services/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/moderation")>();
  return {
    ...actual,
    fetchModerationTarget: (...args: unknown[]) => mockFetchModerationTarget(...args),
    applyModeration: (...args: unknown[]) => mockApplyModeration(...args),
  };
});

import { ModerationCaseSheet, describeTarget } from "./ModerationCaseSheet";
import { ApiError } from "../services/session";

afterEach(cleanup);

const ENTRY = {
  targetType: "POST" as const,
  targetId: "post-1",
  reportCount: 2,
  reasons: ["HARASSMENT" as const],
  firstReportedAt: "2026-10-20T10:00:00.000Z",
  lastReportedAt: "2026-10-22T10:00:00.000Z",
  currentVisibility: "PUBLISHED" as const,
  targetExists: true,
  status: "OPEN" as const,
};

function renderSheet(capabilities: string[], isAdmin = false) {
  return render(
    <ModerationCaseSheet
      open
      entry={ENTRY}
      capabilities={capabilities}
      isAdmin={isAdmin}
      onClose={() => {}}
      onApplied={() => {}}
    />,
  );
}

beforeEach(() => {
  mockFetchModerationTarget.mockReset();
  mockApplyModeration.mockReset();
  viewer.id = "moderator-a";
  mockFetchModerationTarget.mockResolvedValue({
    targetType: "POST",
    targetId: "post-1",
    targetExists: true,
    target: {
      target_type: "POST",
      id: "post-1",
      user_id: "user-2",
      type: "LOST",
      title: "Blue backpack",
      description_excerpt: "Left it on the bus.",
      status: "OPEN",
      moderation_visibility: "PUBLISHED",
      created_at: "2026-10-18T10:00:00.000Z",
    },
    reports: [
      {
        id: "report-1",
        reason: "HARASSMENT",
        detail: "They keep replying to me.",
        status: "OPEN",
        createdAt: "2026-10-22T10:00:00.000Z",
        reviewedAt: null,
        evidence: { title: "Blue backpack", description_excerpt: "Left it on the bus." },
      },
    ],
    decisions: [],
  });
  mockApplyModeration.mockResolvedValue({ auditId: "audit-1" });
});

describe("the case sheet", () => {
  it.each(["case", "account", "reopen"])("discards a late case read after a %s boundary", async (boundary) => {
    let resolve!: (value: unknown) => void;
    mockFetchModerationTarget.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const props = { open: true, entry: ENTRY, capabilities: ["reports_review"], isAdmin: false, onClose: vi.fn(), onApplied: vi.fn() };
    const { rerender } = render(<ModerationCaseSheet {...props} />);
    expect(mockFetchModerationTarget).toHaveBeenCalledOnce();
    if (boundary === "reopen") rerender(<ModerationCaseSheet {...props} open={false} />);
    if (boundary === "account") viewer.id = "moderator-b";
    const next = boundary === "case" ? { ...ENTRY, targetId: "post-2" } : ENTRY;
    mockFetchModerationTarget.mockResolvedValueOnce({ targetType: "POST", targetId: next.targetId, targetExists: true, target: { title: "Current case evidence" }, reports: [], decisions: [] });
    rerender(<ModerationCaseSheet {...props} entry={next} />);
    await screen.findByText("Current case evidence");
    await act(async () => { resolve({ targetType: "POST", targetId: "post-1", targetExists: true, target: { title: "Old case evidence" }, reports: [], decisions: [] }); });
    expect(screen.queryByText("Old case evidence")).toBeNull();
    expect(screen.getByText("Current case evidence")).toBeTruthy();
  });

  it.each([
    ["case", "success"], ["case", "error"],
    ["account", "success"], ["account", "error"],
    ["close", "success"], ["close", "error"],
  ])("ignores an old mutation across %s on %s", async (boundary, outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    mockApplyModeration.mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const props = { open: true, entry: ENTRY, capabilities: ["reports_review", "content_hide"], isAdmin: false, onClose: vi.fn(), onApplied: vi.fn() };
    const { rerender } = render(<ModerationCaseSheet {...props} />);
    await screen.findAllByText("Blue backpack");
    fireEvent.change(screen.getByLabelText(/what to do/i), { target: { value: "HIDE" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "HARASSMENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(mockApplyModeration).toHaveBeenCalledOnce();
    if (boundary === "account") viewer.id = "moderator-b";
    if (boundary === "close") rerender(<ModerationCaseSheet {...props} open={false} />);
    else {
      const next = boundary === "case" ? { ...ENTRY, targetId: "post-2" } : ENTRY;
      mockFetchModerationTarget.mockResolvedValueOnce({ targetType: "POST", targetId: next.targetId, targetExists: true, target: { title: "Current case evidence" }, reports: [], decisions: [] });
      rerender(<ModerationCaseSheet {...props} entry={next} />);
      await screen.findByText("Current case evidence");
    }
    await act(async () => { if (outcome === "success") resolve({ auditId: "old-action" }); else reject(new ApiError("Old permission refusal", 403)); });
    expect(props.onApplied).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("moderation-case-error")).toBeNull();
    if (boundary !== "close") expect(screen.getByText("Current case evidence")).toBeTruthy();
  });

  it.each(["success", "error"])("ignores stale read %s even when it settles before the new read", async (outcome) => {
    let resolveOld!: (value: unknown) => void;
    let rejectOld!: (reason: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    mockFetchModerationTarget.mockReturnValueOnce(new Promise((yes, no) => { resolveOld = yes; rejectOld = no; }));
    const props = { open: true, entry: ENTRY, capabilities: ["reports_review", "content_hide"], isAdmin: false, onClose: vi.fn(), onApplied: vi.fn() };
    const { rerender } = render(<ModerationCaseSheet {...props} />);
    mockFetchModerationTarget.mockReturnValueOnce(new Promise((yes) => { resolveNew = yes; }));
    rerender(<ModerationCaseSheet {...props} entry={{ ...ENTRY, targetId: "post-2" }} />);
    await act(async () => {
      if (outcome === "success") resolveOld({ targetType: "POST", targetId: "post-1", targetExists: true, target: { title: "Old case evidence" }, reports: [], decisions: [] });
      else rejectOld(new ApiError("Old read refusal", 403));
    });
    expect(screen.queryByText("Old case evidence")).toBeNull();
    expect(screen.queryByTestId("moderation-case-error")).toBeNull();
    expect(screen.getByText("Loading the case…")).toBeTruthy();
    await act(async () => { resolveNew({ targetType: "POST", targetId: "post-2", targetExists: true, target: { title: "Current case evidence" }, reports: [], decisions: [] }); });
    expect(screen.getByText("Current case evidence")).toBeTruthy();
  });

  it("shows the target and the reports in words, never in ids", async () => {
    renderSheet(["reports_review"]);
    expect(await screen.findAllByText("Blue backpack")).toBeTruthy();
    expect(screen.getByText(/They keep replying to me/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("post-1");
    expect(document.body.textContent).not.toContain("user-2");
  });

  it("offers only the actions the account's permissions allow", async () => {
    renderSheet(["reports_review", "content_hide"]);
    await screen.findAllByText("Blue backpack");
    const select = screen.getByLabelText(/what to do/i) as HTMLSelectElement;
    // The empty first option is the placeholder ("Choose an action"), not an
    // action a moderator may take.
    const options = Array.from(select.options)
      .map((option) => option.value)
      .filter((value) => value !== "");
    expect(options).toEqual(["NO_ACTION", "PUBLISH", "HIDE"]);
  });

  it("offers every action to an admin", async () => {
    renderSheet([], true);
    await screen.findAllByText("Blue backpack");
    const select = screen.getByLabelText(/what to do/i) as HTMLSelectElement;
    const actions = Array.from(select.options).filter((option) => option.value !== "");
    expect(actions).toHaveLength(9);
  });

  it("says so when the account may not act at all", async () => {
    renderSheet([]);
    await screen.findAllByText("Blue backpack");
    expect(screen.getByText(/do not allow any action/i)).toBeTruthy();
    expect(screen.queryByLabelText(/what to do/i)).toBeNull();
  });

  it("applies the chosen action and reason", async () => {
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(<ModerationCaseSheet open entry={ENTRY} capabilities={["reports_review", "content_hide"]} isAdmin={false} onApplied={onApplied} onClose={onClose} />);
    await screen.findAllByText("Blue backpack");
    fireEvent.change(screen.getByLabelText(/what to do/i), { target: { value: "HIDE" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "HARASSMENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(mockApplyModeration).toHaveBeenCalledTimes(1));
    expect(mockApplyModeration).toHaveBeenCalledWith({
      targetType: "POST",
      targetId: "post-1",
      action: "HIDE",
      reasonCode: "HARASSMENT",
      note: null,
      sanctionKind: null,
      sanctionEndsAt: null,
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    // Parent owns queue refresh/close through onApplied; the sheet does not
    // independently dismiss the reviewed case.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as a sentence", async () => {
    mockApplyModeration.mockRejectedValue(new ApiError("You may not do this", 403, "42501"));
    renderSheet(["reports_review", "content_hide"]);
    await screen.findAllByText("Blue backpack");
    fireEvent.change(screen.getByLabelText(/what to do/i), { target: { value: "HIDE" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "HARASSMENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect((await screen.findByTestId("moderation-case-error")).textContent).toBe(
      "You do not have permission to do that.",
    );
  });

  it("says the saved snapshot expired instead of showing an empty box", async () => {
    mockFetchModerationTarget.mockResolvedValue({
      targetType: "POST",
      targetId: "post-1",
      targetExists: true,
      target: { title: "Blue backpack" },
      reports: [
        {
          id: "report-1",
          reason: "HARASSMENT",
          detail: null,
          status: "OPEN",
          createdAt: "2026-10-22T10:00:00.000Z",
          reviewedAt: null,
          evidence: null,
        },
      ],
      decisions: [],
    });
    renderSheet(["reports_review"]);
    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
  });
});

describe("the target, in words", () => {
  it("never names an id", () => {
    const lines = describeTarget("POST", {
      target_type: "POST",
      id: "post-1",
      user_id: "user-2",
      type: "LOST",
      title: "Blue backpack",
      description_excerpt: "Left it on the bus.",
      status: "OPEN",
      moderation_visibility: "PUBLISHED",
      created_at: "2026-10-18T10:00:00.000Z",
    });
    expect(lines.map((line) => line.value).join(" ")).not.toMatch(/post-1|user-2/);
    expect(lines.find((line) => line.label === "Title")?.value).toBe("Blue backpack");
  });

  it("says nothing at all when the target is gone", () => {
    expect(describeTarget("POST", null)).toEqual([]);
  });
});

describe("single-decider ownership in the case sheet", () => {
  it("shows the consumer's re-evaluation request and the decision round", async () => {
    mockFetchModerationTarget.mockResolvedValue({
      targetType: "POST",
      targetId: "post-1",
      targetExists: true,
      target: { title: "Blue backpack" },
      reports: [],
      decisions: [],
      decision: {
        action: "HIDE",
        generation: 2,
        decidedAt: "2026-10-22T11:00:00.000Z",
        reopenedAt: "2026-10-22T12:00:00.000Z",
      },
      reopen: {
        appealId: "appeal-1",
        message: "The photo was mine and the report is mistaken.",
        submittedAt: "2026-10-22T12:00:00.000Z",
      },
    });
    renderSheet(["reports_review", "content_hide"]);

    const notice = await screen.findByTestId("moderation-case-reopen");
    expect(notice.textContent).toMatch(/asked for re-evaluation/i);
    expect(notice.textContent).toContain("The photo was mine and the report is mistaken.");
    expect((await screen.findByTestId("moderation-case-decision")).textContent).toMatch(/round 2/);
  });

  it("tells a second moderator that the decision belongs to someone else", async () => {
    mockApplyModeration.mockRejectedValue(
      new ApiError("MODERATION_DECISION_FINAL", 409, "MODERATION_DECISION_FINAL"),
    );
    renderSheet(["reports_review", "content_hide"]);
    await screen.findAllByText("Blue backpack");
    fireEvent.change(screen.getByLabelText(/what to do/i), { target: { value: "HIDE" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "HARASSMENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect((await screen.findByTestId("moderation-case-error")).textContent).toMatch(
      /already decided this case/i,
    );
  });
});
