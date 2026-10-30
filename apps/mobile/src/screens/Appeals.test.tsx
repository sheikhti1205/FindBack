// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MyAppeals } from "./MyAppeals";
import { StaffAppeals, StaffAppeal } from "./StaffAppeals";
import { ApiError } from "../services/session";

const f = vi.hoisted(() => ({ user: "person-a", role: vi.fn(), mine: vi.fn(), subjects: vi.fn(), submit: vi.fn(), queue: vi.fn(), detail: vi.fn(), resolve: vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: f.user } }) }));
vi.mock("../services/roles", () => ({ fetchMyRole: () => f.role() }));
vi.mock("../services/moderation", async importOriginal => ({
  ...await importOriginal<typeof import("../services/moderation")>(),
  listMyAppeals: (...args: unknown[]) => f.mine(...args), listMyAppealSubjects: (...args: unknown[]) => f.subjects(...args),
  submitAppeal: (...args: unknown[]) => f.submit(...args), listStaffAppeals: (...args: unknown[]) => f.queue(...args),
  fetchStaffAppeal: (...args: unknown[]) => f.detail(...args), resolveAppeal: (...args: unknown[]) => f.resolve(...args),
}));
const time = "2026-10-29T00:00:00.000Z";
const receipt = { id: "appeal-1", subjectKind: "SANCTION", subjectId: "sanction-1", status: "SUBMITTED", submittedAt: time, resolvedAt: null };
const subject = { subjectKind: "MODERATION_ACTION", subjectId: "action-1", targetType: "POST", targetId: "post-1", action: "HIDE", reason: "OTHER", createdAt: time, openAppealId: null };
const detail = { ...receipt, message: "Please review the context", reviewerNote: null, expiresAt: "2026-11-29T00:00:00Z", appellantUserId: "person-a",
  originalAction: { id: "action-1", targetType: "POST", targetId: "post-1", action: "HIDE", reason: "OTHER", createdAt: time, previousVisibility: "PUBLISHED", nextVisibility: "HIDDEN", sanctionKind: null, sanctionEndsAt: null },
  evidence: [{ id: "report-1", reason: "OTHER", capturedAt: time, expiresAt: "2027-01-29T00:00:00Z", snapshot: { title: "Saved report title", description_excerpt: "Saved context", hidden_metadata: "must not render" } }] };
const page = (items: unknown[] = [], nextCursor: unknown = null) => ({ items, nextCursor });
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks(); f.user = "person-a";
  f.role.mockResolvedValue({ isAdmin: false, capabilities: ["appeals_review"] });
  f.mine.mockResolvedValue(page([receipt])); f.subjects.mockResolvedValue(page([subject]));
  f.submit.mockResolvedValue({ appealId: "new" }); f.queue.mockResolvedValue(page([receipt]));
  f.detail.mockResolvedValue(detail); f.resolve.mockResolvedValue(undefined);
});
function tree(path = "/settings/privacy/appeals") {
  return <MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/settings/privacy/appeals" element={<MyAppeals />} />
    <Route path="/settings/moderation/appeals" element={<StaffAppeals />} />
    <Route path="/settings/moderation/appeals/:appealId" element={<StaffAppeal />} />
    <Route path="/settings" element={<p>Settings root</p>} />
  </Routes></MemoryRouter>;
}
it("discovers own adverse decisions and submits a trimmed required message, then refreshes receipts", async () => {
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: /appeal this decision/i }));
  const input = screen.getByLabelText("Why should we review this?");
  expect(input.getAttribute("maxlength")).toBe("2000");
  expect(document.activeElement).toBe(input);
  expect((screen.getByRole("button", { name: "Send appeal" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: " Please look again " } });
  fireEvent.click(screen.getByRole("button", { name: "Send appeal" }));
  expect(await screen.findByText("Your appeal was sent." )).toBeTruthy();
  expect(f.submit).toHaveBeenCalledWith("MODERATION_ACTION", "action-1", "Please look again");
  expect(f.mine).toHaveBeenCalledTimes(2);
});
it("an already-open appeal has no duplicate submit affordance", async () => {
  f.subjects.mockResolvedValue(page([{ ...subject, openAppealId: "appeal-1" }])); render(tree());
  expect(await screen.findByText("An appeal is already open for this decision.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /appeal this decision/i })).toBeNull();
});
it.each(["GRANTED", "DENIED", "EXPIRED"])("consumer receipt shows plain durable outcome %s, never staff detail", async decision => {
  f.mine.mockResolvedValue(page([{ ...receipt, status: "RESOLVED", decision, resolvedAt: time, reviewerNote: "private note" }])); render(tree());
  expect(await screen.findByText({ GRANTED: "Granted", DENIED: "Denied", EXPIRED: "Expired" }[decision]!)).toBeTruthy();
  expect(screen.queryByText("private note")).toBeNull();
});
it("preserves raw continuation even when a page contains no rendered receipts", async () => {
  const cursor = { submittedAt: time, id: "raw-last" };
  f.mine.mockResolvedValueOnce(page([], cursor)).mockResolvedValueOnce(page([receipt])); render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "More appeals" }));
  expect(await screen.findByText("Waiting for review")).toBeTruthy();
  expect(f.mine).toHaveBeenLastCalledWith({ before: cursor });
});
it.each([new ApiError("missing", 500, "PGRST202"), new Error("network")])("failed receipts are not empty and retry is read-only", async error => {
  f.mine.mockRejectedValueOnce(error); render(tree());
  expect(await screen.findByTestId("appeal-history-error")).toBeTruthy();
  expect(screen.queryByText("You haven’t sent an appeal yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry appeals" }));
  expect(await screen.findByText("Waiting for review")).toBeTruthy(); expect(f.submit).not.toHaveBeenCalled();
});
it("account switching discards private drafts, old receipts and late submission announcements", async () => {
  let finish!: (v: unknown) => void;
  f.submit.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(tree()); fireEvent.click(await screen.findByRole("button", { name: /appeal this decision/i }));
  fireEvent.change(screen.getByLabelText("Why should we review this?"), { target: { value: "Private draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send appeal" }));
  f.user = "person-b"; f.mine.mockResolvedValue(page()); f.subjects.mockResolvedValue(page());
  const heard = vi.fn(); window.addEventListener("findback:announce", heard);
  try { view.rerender(tree()); await act(async () => { finish({ appealId: "new" }); });
    expect(screen.queryByDisplayValue("Private draft")).toBeNull(); expect(screen.queryByText("Your appeal was sent.")).toBeNull(); expect(heard).not.toHaveBeenCalled();
  } finally { window.removeEventListener("findback:announce", heard); }
});
it("ordinary accounts cannot request staff lists or detail", async () => {
  f.role.mockResolvedValue({ isAdmin: false, capabilities: [] }); render(tree("/settings/moderation/appeals/appeal-1"));
  expect(await screen.findByText("Settings root")).toBeTruthy(); expect(f.detail).not.toHaveBeenCalled(); expect(f.queue).not.toHaveBeenCalled();
});
it("staff queue opens full detail with original action and bounded evidence, not raw metadata", async () => {
  render(tree("/settings/moderation/appeals"));
  fireEvent.click(await screen.findByRole("link", { name: /account decision/i }));
  expect(await screen.findByText(detail.message)).toBeTruthy(); expect(screen.getByText("Saved report title")).toBeTruthy();
  expect(screen.getByText("Hidden")).toBeTruthy(); expect(screen.queryByText("must not render")).toBeNull();
});
it.each(["Grant appeal", "Deny appeal"])("%s requires a reason and persists exactly one action", async label => {
  render(tree("/settings/moderation/appeals/appeal-1"));
  const input = await screen.findByLabelText("Review reason");
  expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: " Reasoned decision " } });
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(await screen.findByText("Review saved.")).toBeTruthy();
  expect(f.resolve).toHaveBeenCalledTimes(1); expect(f.resolve).toHaveBeenCalledWith("appeal-1", label.startsWith("Grant") ? "GRANTED" : "DENIED", "Reasoned decision");
});
it("a resolved appeal has its outcome and reason but no active decision controls", async () => {
  f.detail.mockResolvedValue({ ...detail, status: "RESOLVED", decision: "DENIED", resolvedAt: time, reviewerNote: "Original action stands" });
  render(tree("/settings/moderation/appeals/appeal-1")); expect(await screen.findByText("Original action stands")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Grant appeal" })).toBeNull();
});
it("conflict invites reread, not a repeated resolution", async () => {
  f.resolve.mockRejectedValueOnce(new ApiError("APPEAL_ALREADY_RESOLVED", 409, "APPEAL_ALREADY_RESOLVED"));
  render(tree("/settings/moderation/appeals/appeal-1")); fireEvent.change(await screen.findByLabelText("Review reason"), { target: { value: "Reason" } });
  fireEvent.click(screen.getByRole("button", { name: "Deny appeal" }));
  expect(await screen.findByText(/already been resolved.*refresh/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh appeal" })); expect(f.resolve).toHaveBeenCalledTimes(1);
});
it("revoked authority purges private appeal detail and disables decisions", async () => {
  f.resolve.mockRejectedValueOnce(new ApiError("revoked", 403, "42501")); render(tree("/settings/moderation/appeals/appeal-1"));
  fireEvent.change(await screen.findByLabelText("Review reason"), { target: { value: "Reason" } }); fireEvent.click(screen.getByRole("button", { name: "Deny appeal" }));
  expect(await screen.findByRole("alert")).toBeTruthy(); expect(screen.queryByText(detail.message)).toBeNull();
  expect(screen.queryByRole("button", { name: "Grant appeal" })).toBeNull();
});
it("expired or erased evidence is explicit; it never falls back to live content", async () => {
  f.detail.mockResolvedValue({ ...detail, evidence: [{ ...detail.evidence[0], snapshot: null }] }); render(tree("/settings/moderation/appeals/appeal-1"));
  const section = await screen.findByRole("region", { name: "Saved evidence" });
  expect(await within(section).findByText(/no longer available/i)).toBeTruthy(); expect(screen.queryByText("Saved report title")).toBeNull();
});
it("a late old-account detail response cannot expose appellant text", async () => {
  let finish!: (v: unknown) => void; f.detail.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(tree("/settings/moderation/appeals/appeal-1")); await screen.findByText("Loading appeal…");
  f.user = "person-b"; f.role.mockResolvedValue({ isAdmin: false, capabilities: [] }); view.rerender(tree("/settings/moderation/appeals/appeal-1"));
  await act(async () => { finish(detail); }); expect(screen.queryByText(detail.message)).toBeNull();
});
