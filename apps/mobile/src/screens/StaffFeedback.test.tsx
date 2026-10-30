// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StaffFeedback, StaffFeedbackDetail } from "./StaffFeedback";
import { ApiError } from "../services/session";
const f = vi.hoisted(() => ({ user: "staff-a", role: vi.fn(), list: vi.fn(), detail: vi.fn(), review: vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: f.user } }) }));
vi.mock("../services/roles", () => ({ fetchMyRole: () => f.role() }));
vi.mock("../services/feedback", async importOriginal => ({ ...await importOriginal<typeof import("../services/feedback")>(),
  listStaffFeedback: (...args: unknown[]) => f.list(...args), fetchStaffFeedback: (...args: unknown[]) => f.detail(...args), reviewFeedback: (...args: unknown[]) => f.review(...args) }));
const time = "2026-10-29T00:00:00Z";
const row = { id: "feedback-1", category: "BUG", status: "NEW", createdAt: time, updatedAt: time };
const detail = { ...row, message: "The button does not respond", adminNote: null, technicalContext: { platform: "android", device_class: "phone" } };
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); f.user = "staff-a"; f.role.mockResolvedValue({ isAdmin: false, capabilities: ["feedback_read"] });
  f.list.mockResolvedValue({ items: [row], nextCursor: null }); f.detail.mockResolvedValue(detail); f.review.mockResolvedValue(undefined); });
function tree(path = "/settings/moderation/feedback") { return <MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/settings/moderation/feedback" element={<StaffFeedback />} /><Route path="/settings/moderation/feedback/:feedbackId" element={<StaffFeedbackDetail />} />
  <Route path="/settings" element={<p>Settings root</p>} /></Routes></MemoryRouter>; }
it("ordinary accounts never request feedback message or queue", async () => {
  f.role.mockResolvedValue({ isAdmin: false, capabilities: [] }); render(tree()); expect(await screen.findByText("Settings root")).toBeTruthy(); expect(f.list).not.toHaveBeenCalled();
});
it("pending feedback is list-first and links to full message and opt-in context", async () => {
  render(tree()); fireEvent.click(await screen.findByRole("link", { name: "Something is broken" }));
  expect(await screen.findByText(detail.message)).toBeTruthy(); expect(screen.getByText("android")).toBeTruthy();
});
it("review sends observed expected status and trimmed note, then rereads", async () => {
  render(tree("/settings/moderation/feedback/feedback-1")); fireEvent.change(await screen.findByLabelText("Staff note (optional)"), { target: { value: " Investigating " } });
  fireEvent.click(screen.getByRole("button", { name: "Start review" })); expect(await screen.findByText("Review saved.")).toBeTruthy();
  expect(f.review).toHaveBeenCalledWith("feedback-1", "REVIEWING", "NEW", "Investigating"); expect(f.detail).toHaveBeenCalledTimes(2);
});
it("resolved feedback offers reopening to Reviewing, never New", async () => {
  f.detail.mockResolvedValue({ ...detail, status: "RESOLVED" }); render(tree("/settings/moderation/feedback/feedback-1"));
  fireEvent.click(await screen.findByRole("button", { name: "Reopen review" })); expect(await screen.findByText("Review saved.")).toBeTruthy();
  expect(f.review).toHaveBeenCalledWith("feedback-1", "REVIEWING", "RESOLVED", ""); expect(screen.queryByRole("button", { name: "Mark new" })).toBeNull();
});
it("a concurrent feedback change disables stale actions until refresh", async () => {
  f.review.mockRejectedValueOnce(new ApiError("FEEDBACK_CHANGED", 409, "FEEDBACK_CHANGED")); render(tree("/settings/moderation/feedback/feedback-1"));
  fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" })); expect(await screen.findByText(/changed.*refresh/i)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(true);
});
it("a confirmed review survives failed readback and failed refresh never re-enables stale writes", async () => {
  f.detail.mockResolvedValueOnce(detail).mockRejectedValue(new Error("network"));
  render(tree("/settings/moderation/feedback/feedback-1"));
  fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));
  expect(await screen.findByText("Review saved.")).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh feedback" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.review).toHaveBeenCalledTimes(1);
});
it("two rapid decision clicks cannot start two feedback mutations", async () => {
  let finish!: () => void; f.review.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  render(tree("/settings/moderation/feedback/feedback-1"));
  const action = await screen.findByRole("button", { name: "Mark resolved" });
  fireEvent.click(action); fireEvent.click(action);
  expect(f.review).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});
it("revocation purges support text and notes", async () => {
  f.review.mockRejectedValueOnce(new ApiError("revoked", 403, "42501")); render(tree("/settings/moderation/feedback/feedback-1"));
  fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" })); expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(detail.message)).toBeNull(); expect(screen.queryByLabelText("Staff note (optional)")).toBeNull();
});
it("failed queue reads are not reported as no feedback", async () => {
  f.list.mockRejectedValueOnce(new ApiError("missing", 500, "PGRST202")); render(tree()); expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("No feedback is waiting for review.")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Retry feedback" }));
  expect(await screen.findByRole("link", { name: "Something is broken" })).toBeTruthy();
});
it("changing status filter ignores a slower previous queue response", async () => {
  let finish!: (v: unknown) => void; f.list.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); render(tree());
  const filter = await screen.findByLabelText("Feedback status");
  f.list.mockResolvedValue({ items: [], nextCursor: null });
  fireEvent.change(filter, { target: { value: "RESOLVED" } });
  await act(async () => { finish({ items: [{ ...row, id: "stale" }], nextCursor: null }); });
  expect(screen.queryByRole("link", { name: "Something is broken" })).toBeNull();
});
it("an in-flight write cannot publish another account's success or support text", async () => {
  let finish!: () => void; f.review.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const view = render(tree("/settings/moderation/feedback/feedback-1")); fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));
  f.user = "staff-b"; f.role.mockResolvedValue({ isAdmin: false, capabilities: [] }); view.rerender(tree("/settings/moderation/feedback/feedback-1"));
  await act(async () => { finish(); }); expect(screen.queryByText("Review saved.")).toBeNull(); expect(screen.queryByText(detail.message)).toBeNull();
});
