// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabaseClient", () => ({ getSupabase: () => ({ rpc }) }));
import { listMyAppeals, listMyAppealSubjects } from "./moderation";

const receipt = {
  id: "appeal-1", subject_kind: "MODERATION_ACTION", subject_id: "action-1",
  status: "SUBMITTED", submitted_at: "2026-10-23T10:00:00.000Z", resolved_at: null,
};
const subject = {
  subject_kind: "MODERATION_ACTION", subject_id: "action-1", target_type: "POST",
  target_id: "post-1", action: "HIDE", reason: "HARASSMENT",
  created_at: "2026-10-23T09:00:00.000Z", open_appeal_id: null,
};
const page = (items: unknown[], next_cursor: unknown = null) => ({ data: { items, next_cursor }, error: null });
beforeEach(() => rpc.mockReset());

describe("durable appeal receipts", () => {
  it("projects only safe receipt fields and forwards the exact keyset cursor", async () => {
    rpc.mockResolvedValue(page([{ ...receipt, reviewer_note: "private", resolved_by: "staff", message: "private body" }]));
    const rows = await listMyAppeals({ limit: 2, before: { submittedAt: "2026-10-23T11:00:00.000Z", id: "appeal-2" } });
    expect(rpc).toHaveBeenCalledWith("findback_my_appeals", { p_limit: 2, p_before_submitted_at: "2026-10-23T11:00:00.000Z", p_before_id: "appeal-2" });
    expect(rows).toEqual({ items: [{ id: "appeal-1", subjectKind: "MODERATION_ACTION", subjectId: "action-1", status: "SUBMITTED", submittedAt: "2026-10-23T10:00:00.000Z", resolvedAt: null }], nextCursor: null });
  });

  it("does not invent states or erase the distinction between open and resolved", async () => {
    rpc.mockResolvedValue(page([
      receipt, { ...receipt, id: "review", status: "UNDER_REVIEW" },
      { ...receipt, id: "done", subject_kind: "SANCTION", status: "RESOLVED", resolved_at: "2026-10-23T12:00:00.000Z" },
      { ...receipt, status: "GRANTED" }, { ...receipt, subject_kind: "OTHER" },
      { ...receipt, id: " " }, { ...receipt, status: "RESOLVED" },
      { ...receipt, resolved_at: "2026-10-23T12:00:00.000Z" }, null,
    ]));
    expect((await listMyAppeals()).items.map(row => row.id)).toEqual(["appeal-1", "review", "done"]);
  });

  it("does not cache a prior response (UI in-flight account isolation is a separate gate)", async () => {
    rpc.mockResolvedValueOnce(page([receipt]));
    expect((await listMyAppeals()).items).toHaveLength(1);
    rpc.mockResolvedValueOnce(page([]));
    expect((await listMyAppeals()).items).toEqual([]);
  });

  it("keeps an unavailable backend distinct from an empty history", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function unavailable" } });
    await expect(listMyAppeals()).rejects.toMatchObject({ status: 500 });
  });

  it("rejects an invalid cursor before making a request", async () => {
    await expect(listMyAppeals({ before: { submittedAt: "", id: "a" } })).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("bounds page size and refuses malformed successful payloads", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(listMyAppeals({ limit: 500 })).rejects.toMatchObject({ code: "UNEXPECTED_SHAPE" });
    expect(rpc).toHaveBeenCalledWith("findback_my_appeals", { p_limit: 100, p_before_submitted_at: null, p_before_id: null });
  });

  it("preserves the server continuation across a fully filtered page", async () => {
    const cursor = { submitted_at: "2026-10-23T10:00:00.000001Z", id: "boundary" };
    rpc.mockResolvedValueOnce(page([{ ...receipt, status: "FUTURE" }], cursor));
    const first = await listMyAppeals({ limit: 1 });
    expect(first).toEqual({ items: [], nextCursor: { submittedAt: cursor.submitted_at, id: "boundary" } });
    rpc.mockResolvedValueOnce(page([receipt]));
    expect((await listMyAppeals({ limit: 1, before: first.nextCursor! })).items).toHaveLength(1);
    expect(rpc).toHaveBeenLastCalledWith("findback_my_appeals", { p_limit: 1, p_before_submitted_at: cursor.submitted_at, p_before_id: "boundary" });
  });

  it.each([undefined, {}, { submitted_at: "bad", id: "a" }, { submitted_at: receipt.submitted_at, id: " " }])("refuses an unusable server boundary %j", async next => {
    rpc.mockResolvedValue({ data: { items: [receipt], next_cursor: next }, error: null });
    await expect(listMyAppeals()).rejects.toMatchObject({ code: "UNEXPECTED_SHAPE" });
  });

  it.each(["bad", " ", "2026-02-30T10:00:00Z"])("does not treat invalid date %s as a receipt", async date => {
    rpc.mockResolvedValue(page([{ ...receipt, submitted_at: date }, { ...receipt, resolved_at: undefined }]));
    expect((await listMyAppeals()).items).toEqual([]);
  });
});

describe("own actionable appeal subjects", () => {
  it("projects references and an existing receipt, never staff identity or notes", async () => {
    rpc.mockResolvedValue(page([subject, { ...subject, subject_kind: "SANCTION", subject_id: "sanction-1", target_type: "USER", action: "WARN", open_appeal_id: "appeal-2", decider_user_id: "staff", moderator_note: "private" }]));
    const rows = await listMyAppealSubjects();
    expect(rpc).toHaveBeenCalledWith("findback_my_appeal_subjects", { p_limit: 50, p_before_created_at: null, p_before_subject_kind: null, p_before_subject_id: null });
    expect(rows.items).toEqual([
      { subjectKind: "MODERATION_ACTION", subjectId: "action-1", targetType: "POST", targetId: "post-1", action: "HIDE", reason: "HARASSMENT", createdAt: "2026-10-23T09:00:00.000Z", openAppealId: null },
      { subjectKind: "SANCTION", subjectId: "sanction-1", targetType: "USER", targetId: "post-1", action: "WARN", reason: "HARASSMENT", createdAt: "2026-10-23T09:00:00.000Z", openAppealId: "appeal-2" },
    ]);
  });

  it("drops unknown, favorable and malformed references rather than offering a broken action", async () => {
    rpc.mockResolvedValue(page([subject, ...[
      { subject_kind: "UNKNOWN" }, { subject_id: "" }, { target_type: "UNKNOWN" },
      { target_id: "" }, { action: "UNKNOWN" }, { action: "PUBLISH" }, { action: "NO_ACTION" },
      { reason: "UNKNOWN" }, { created_at: "" }, { open_appeal_id: 123 },
      { subject_kind: "SANCTION" }, { target_type: "USER" }, { action: "WARN" },
      { open_appeal_id: undefined }, { created_at: "2026-02-30T00:00:00Z" },
    ].map(patch => ({ ...subject, ...patch }))]));
    expect((await listMyAppealSubjects()).items).toHaveLength(1);
  });

  it("preserves authentication errors instead of showing no decisions", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "28000", message: "Not authenticated" } });
    await expect(listMyAppealSubjects()).rejects.toMatchObject({ status: 401 });
  });

  it("continues subject pages using all raw ordering columns", async () => {
    rpc.mockResolvedValue(page([subject], { created_at: subject.created_at, subject_kind: "MODERATION_ACTION", subject_id: "action-1" }));
    const first = await listMyAppealSubjects({ limit: 1 });
    rpc.mockResolvedValue(page([]));
    await listMyAppealSubjects({ limit: 1, before: first.nextCursor! });
    expect(rpc).toHaveBeenLastCalledWith("findback_my_appeal_subjects", { p_limit: 1, p_before_created_at: subject.created_at, p_before_subject_kind: "MODERATION_ACTION", p_before_subject_id: "action-1" });
  });

  it("refuses malformed subject envelopes and cursors rather than hiding data", async () => {
    rpc.mockResolvedValue(page([], { created_at: "invalid", subject_kind: "SANCTION", subject_id: "s" }));
    await expect(listMyAppealSubjects()).rejects.toMatchObject({ code: "UNEXPECTED_SHAPE" });
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(listMyAppealSubjects()).rejects.toMatchObject({ code: "UNEXPECTED_SHAPE" });
    await expect(listMyAppealSubjects({ before: { createdAt: " ", subjectKind: "SANCTION", subjectId: "s" } })).rejects.toMatchObject({ status: 400 });
  });
});
