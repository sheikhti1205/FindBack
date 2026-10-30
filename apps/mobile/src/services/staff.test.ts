import { beforeEach, expect, it, vi } from "vitest";
import { fetchStaffAppeal, listMyAppeals, listStaffAppeals, resolveAppeal } from "./moderation";
import { fetchStaffFeedback, listStaffFeedback, reviewFeedback } from "./feedback";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabaseClient", () => ({ getSupabase: () => ({ rpc }) }));
beforeEach(() => rpc.mockReset());
const time = "2026-10-29T00:00:00.000Z";
const receipt = { id: "appeal-1", subject_kind: "SANCTION", subject_id: "sanction-1", status: "SUBMITTED", decision: null, submitted_at: time, resolved_at: null };
const summary = { id: "feedback-1", category: "BUG", status: "NEW", created_at: time, updated_at: time };

it("keeps resolved consumer decision and strips all private staff fields", async () => {
  rpc.mockResolvedValue({ data: { items: [{ ...receipt, status: "RESOLVED", decision: "GRANTED", resolved_at: time, reviewer_note: "private", resolved_by: "staff" }], next_cursor: null }, error: null });
  expect((await listMyAppeals()).items).toEqual([{ id: "appeal-1", subjectKind: "SANCTION", subjectId: "sanction-1", status: "RESOLVED", decision: "GRANTED", submittedAt: time, resolvedAt: time }]);
});
it.each([null, "REVERSED", "granted"])("never invents a resolved result from %s", async (decision) => {
  rpc.mockResolvedValue({ data: { items: [{ ...receipt, status: "RESOLVED", decision, resolved_at: time }], next_cursor: { submitted_at: time, id: "raw-last" } }, error: null });
  expect(await listMyAppeals()).toEqual({ items: [], nextCursor: { submittedAt: time, id: "raw-last" } });
});
it("uses bounded staff appeal RPC and raw cursor even when filtering malformed rows", async () => {
  rpc.mockResolvedValue({ data: { items: [receipt, { ...receipt, id: "bad", status: "future" }], next_cursor: { submitted_at: time, id: "bad" } }, error: null });
  const page = await listStaffAppeals({ limit: 500 });
  expect(page.items.map((row) => row.id)).toEqual(["appeal-1"]);
  expect(page.nextCursor).toEqual({ submittedAt: time, id: "bad" });
  expect(rpc).toHaveBeenCalledWith("findback_staff_appeals", { p_status: null, p_limit: 100, p_before_submitted_at: null, p_before_id: null });
});
it("refuses invalid staff cursor locally and propagates revoked capability", async () => {
  await expect(listStaffAppeals({ before: { submittedAt: "invalid", id: "a" } })).rejects.toMatchObject({ status: 400 });
  expect(rpc).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Refused" } });
  await expect(listStaffAppeals()).rejects.toMatchObject({ status: 403 });
});
it("maps staff appeal detail without returning unrecognized private metadata", async () => {
  rpc.mockResolvedValue({ data: { ...receipt, message: "Please review", reviewer_note: null, expires_at: time, appellant_user_id: "person", original_action: null, evidence: [], unrelated: "discard" }, error: null });
  const detail = await fetchStaffAppeal("appeal-1");
  expect(detail.message).toBe("Please review");
  expect(detail.originalAction).toBeNull();
  expect(detail).not.toHaveProperty("unrelated");
});
it("requires a grant/deny reason and maps stale/expired outcomes as conflicts", async () => {
  await expect(resolveAppeal("appeal-1", "GRANTED", " ")).rejects.toMatchObject({ status: 400 });
  expect(rpc).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ data: null, error: null });
  await resolveAppeal("appeal-1", "DENIED", " Original decision stands ");
  expect(rpc).toHaveBeenCalledWith("findback_resolve_appeal", { p_appeal_id: "appeal-1", p_decision: "DENIED", p_reviewer_note: "Original decision stands" });
  rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "APPEAL_ALREADY_RESOLVED" } });
  await expect(resolveAppeal("appeal-1", "DENIED", "Reason")).rejects.toMatchObject({ status: 409, code: "APPEAL_ALREADY_RESOLVED" });
});
it("uses bounded feedback queue and strips detail from summaries", async () => {
  rpc.mockResolvedValue({ data: { items: [{ ...summary, message: "not a queue field" }], next_cursor: { created_at: time, id: "feedback-1" } }, error: null });
  expect(await listStaffFeedback({ status: "NEW", limit: 1 })).toEqual({ items: [{ id: "feedback-1", category: "BUG", status: "NEW", createdAt: time, updatedAt: time }], nextCursor: { createdAt: time, id: "feedback-1" } });
  expect(rpc).toHaveBeenCalledWith("findback_staff_feedback", { p_status: "NEW", p_limit: 1, p_before_created_at: null, p_before_id: null });
});
it("maps only explicit feedback detail fields", async () => {
  rpc.mockResolvedValue({ data: { ...summary, message: "The button is confusing", admin_note: "Triage", technical_context: { platform: "android", screen: "feedback", extra: "discard" }, user_id: "not a detail field" }, error: null });
  const result = await fetchStaffFeedback("feedback-1");
  expect(result.message).toBe("The button is confusing");
  expect(result.adminNote).toBe("Triage");
  expect(result.technicalContext).toEqual({ platform: "android", screen: "feedback" });
  expect(result).not.toHaveProperty("user_id");
});
it("feedback writer sends expected status and distinguishes stale data from rate limiting", async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  await reviewFeedback("feedback-1", "REVIEWING", "NEW", " Checking ");
  expect(rpc).toHaveBeenCalledWith("findback_review_feedback", { p_feedback_id: "feedback-1", p_status: "REVIEWING", p_expected_status: "NEW", p_admin_note: "Checking" });
  rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "FEEDBACK_CHANGED" } });
  await expect(reviewFeedback("feedback-1", "RESOLVED", "NEW")).rejects.toMatchObject({ status: 409, code: "FEEDBACK_CHANGED" });
});
it("staff feedback writer rejects oversized notes before any RPC", async () => {
  await expect(reviewFeedback("feedback-1", "REVIEWING", "NEW", "x".repeat(2001))).rejects.toMatchObject({ status: 400 });
  expect(rpc).not.toHaveBeenCalled();
});
