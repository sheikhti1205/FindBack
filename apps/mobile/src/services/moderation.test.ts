// @vitest-environment jsdom
/**
 * Moderation service: the client vocabulary must be the SERVER vocabulary, and
 * every refusal the server makes must stay the answer it is.
 *
 * Two kinds of test live here:
 *
 *   1. PARITY. The reasons, the actions, the action → capability map and the
 *      action → sanction-kind map are spelled out in this client AND in
 *      `20261022173000_moderation_reports_sanctions_appeals.sql`. Both are
 *      closed lists that a UI offers as buttons, so a drift between them is a
 *      button that always fails (or worse, a reason the server cannot store).
 *      These tests read the migration and fail on drift, without needing a
 *      database.
 *   2. BEHAVIOUR. The RPC name, the exact parameter names, the parse of the
 *      answer, and the status mapping of every server refusal.
 *
 * The tables are deliberately not readable by any client role (RLS, no policy,
 * no grant), so this service must never query a table: the last test asserts
 * there is no `.from(` in it at all.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("./supabaseClient", () => ({ getSupabase: () => ({ rpc: rpcMock }) }));

import {
  ACTION_CAPABILITIES,
  ACTION_SANCTION_KINDS,
  APPEAL_SUBJECT_KINDS,
  MODERATION_ACTIONS,
  MODERATION_VISIBILITIES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  SANCTION_KINDS,
  applyModeration,
  fetchModerationQueue,
  fetchModerationTarget,
  fetchMyPostModeration,
  listMyModerationOutcomes,
  listMyReports,
  submitAppeal,
  submitReport,
} from "./moderation";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(
  REPO_ROOT,
  "supabase/migrations/20261022173000_moderation_reports_sanctions_appeals.sql",
);
// The visibility atom predates B2a and is NOT redefined here: the client still
// has to name the four values the item_posts CHECK accepts.
const VISIBILITY_MIGRATION = resolve(
  REPO_ROOT,
  "supabase/migrations/20261017070000_visibility_kernel_and_blocks.sql",
);
const SERVICE_SOURCE = resolve(process.cwd(), "src/services/moderation.ts");

function migration(): string {
  return readFileSync(MIGRATION, "utf8");
}

function reasonListFromMigration(sql: string): string[] {
  const start = sql.indexOf("create or replace function public.findback_report_reasons()");
  const block = sql.slice(start, sql.indexOf("$$;", sql.indexOf("select array[", start)));
  const arrayBody = block.slice(block.indexOf("select array["), block.indexOf("];"));
  return Array.from(arrayBody.matchAll(/'([A-Z_]+)'/g)).map((match) => match[1]!);
}

function caseMap(sql: string, marker: string): Record<string, string> {
  const start = sql.indexOf(marker);
  const block = sql.slice(start, sql.indexOf("end;", start));
  const map: Record<string, string> = {};
  for (const match of block.matchAll(/when '([A-Z_]+)' then '([A-Za-z_]+)'/g)) {
    map[match[1]!] = match[2]!;
  }
  return map;
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: null, error: null });
});

describe("the client vocabulary is the server vocabulary", () => {
  it("names exactly the seven reasons the migration stores", () => {
    expect(reasonListFromMigration(migration())).toEqual([...REPORT_REASONS]);
    expect(REPORT_REASONS).toHaveLength(7);
  });

  it("names exactly the nine actions the writer accepts", () => {
    const sql = migration();
    expect(sql).toContain("if p_action is null or p_action not in (");
    for (const action of MODERATION_ACTIONS) {
      expect(sql).toContain(`'${action}'`);
    }
    // The closed list in the migration has nine entries and the client knows
    // nine: a tenth action added to one side would be a button that always
    // answers 22023.
    const vocabulary = sql.slice(
      sql.indexOf("if p_action is null or p_action not in ("),
      sql.indexOf(")", sql.indexOf("if p_action is null or p_action not in (")),
    );
    expect(Array.from(vocabulary.matchAll(/'([A-Z_]+)'/g))).toHaveLength(MODERATION_ACTIONS.length);
  });

  it("maps every action to the capability the writer maps it to", () => {
    expect(caseMap(migration(), "v_capability := case p_action")).toEqual({
      ...ACTION_CAPABILITIES,
    });
  });

  it("maps every member action to the sanction kind the writer maps it to", () => {
    expect(caseMap(migration(), "v_kind := case p_action")).toEqual({
      ...ACTION_SANCTION_KINDS,
    });
  });

  it("offers only target types, statuses, visibilities and sanction kinds the schema accepts", () => {
    const sql = migration();
    for (const targetType of REPORT_TARGET_TYPES) {
      expect(sql).toContain(`'${targetType}'`);
    }
    for (const status of REPORT_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    const visibilitySql = readFileSync(VISIBILITY_MIGRATION, "utf8");
    for (const visibility of MODERATION_VISIBILITIES) {
      expect(visibilitySql).toContain(`'${visibility}'`);
    }
    for (const kind of SANCTION_KINDS) {
      expect(sql).toContain(`'${kind}'`);
    }
    for (const kind of APPEAL_SUBJECT_KINDS) {
      expect(sql).toContain(`'${kind}'`);
    }
  });

  it("calls only RPCs the migration defines, and never reads a table", () => {
    const sql = migration();
    for (const rpc of [
      "findback_submit_report",
      "findback_my_reports",
      "findback_moderation_queue",
      "findback_moderation_target",
      "findback_apply_moderation",
      "findback_my_moderation_outcomes",
      "findback_my_post_moderation",
      "findback_submit_appeal",
    ]) {
      expect(sql).toContain(`function public.${rpc}(`);
    }
    // The moderation tables are ungranted with zero policies: a table query in
    // this service could only fail, and would mean a private read had been
    // reintroduced somewhere else.
    expect(readFileSync(SERVICE_SOURCE, "utf8")).not.toMatch(/\.from\(/);
  });
});

describe("filing a report", () => {
  it("posts the exact parameters and returns the surviving receipt", async () => {
    rpcMock.mockResolvedValue({ data: "report-1", error: null });

    const result = await submitReport({
      targetType: "POST",
      targetId: "  post-1  ",
      reason: "HARASSMENT",
      detail: "  A threatening listing.  ",
    });

    expect(result).toEqual({ reportId: "report-1" });
    expect(rpcMock).toHaveBeenCalledWith("findback_submit_report", {
      p_target_type: "POST",
      p_target_id: "post-1",
      p_reason: "HARASSMENT",
      p_detail: "A threatening listing.",
    });
  });

  it("sends a null detail when none was given, so a whitespace note is not stored", async () => {
    rpcMock.mockResolvedValue({ data: "report-1", error: null });

    await submitReport({ targetType: "COMMENT", targetId: "c1", reason: "OTHER", detail: "   " });

    expect(rpcMock).toHaveBeenCalledWith("findback_submit_report", {
      p_target_type: "COMMENT",
      p_target_id: "c1",
      p_reason: "OTHER",
      p_detail: null,
    });
  });

  it("is idempotent on the client's side too: a retry keeps the same receipt id", async () => {
    rpcMock.mockResolvedValue({ data: "report-1", error: null });

    const first = await submitReport({ targetType: "USER", targetId: "u1", reason: "OTHER" });
    const second = await submitReport({ targetType: "USER", targetId: "u1", reason: "OTHER" });

    expect(second.reportId).toBe(first.reportId);
  });

  it("refuses a reason outside the closed vocabulary without calling the server", async () => {
    await expect(
      submitReport({ targetType: "POST", targetId: "p1", reason: "BORING" as never }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_REASON" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("refuses an empty target and an over-long note without calling the server", async () => {
    await expect(
      submitReport({ targetType: "POST", targetId: "   ", reason: "OTHER" }),
    ).rejects.toMatchObject({ status: 400, code: "MISSING_TARGET" });
    await expect(
      submitReport({ targetType: "POST", targetId: "p1", reason: "OTHER", detail: "x".repeat(2001) }),
    ).rejects.toMatchObject({ status: 400, code: "DETAIL_TOO_LONG" });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("the server's refusals stay the answers they are", () => {
  const cases: Array<{ code: string; message: string; status: number }> = [
    { code: "42501", message: "You may not perform this moderation action", status: 403 },
    { code: "28000", message: "Not authenticated", status: 401 },
    { code: "22023", message: "Unknown report reason", status: 400 },
    { code: "P0002", message: "Report target unavailable", status: 404 },
    { code: "P0001", message: "REPORT_LIMIT_REACHED", status: 429 },
    { code: "P0001", message: "APPEAL_ALREADY_OPEN", status: 409 },
    { code: "PGRST202", message: "Could not find the function", status: 500 },
  ];

  for (const { code, message, status } of cases) {
    it(`maps ${code} ${message} to ${status}`, async () => {
      rpcMock.mockResolvedValue({ data: null, error: { code, message } });
      await expect(listMyReports()).rejects.toMatchObject({ status });
    });
  }

  it("never retries a permission refusal, and never reports it as a bad request", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "You may not read the moderation queue" },
    });

    await expect(fetchModerationQueue()).rejects.toMatchObject({ status: 403 });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("the consumer receipt", () => {
  it("carries five fields and drops a row the client cannot label", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          id: "r1",
          target_type: "POST",
          reason: "HARASSMENT",
          status: "OPEN",
          created_at: "2026-10-22T10:00:00.000Z",
          // A server-only field that must never be forwarded by the client.
          target_id: "post-1",
        },
        { id: "r2", target_type: "POST", reason: "BORING", status: "OPEN", created_at: "x" },
        { id: "r3", target_type: "POST", reason: "OTHER", status: "MYSTERY", created_at: "x" },
        { id: "r4", target_type: "VIDEO", reason: "OTHER", status: "OPEN", created_at: "x" },
        { id: "r5", target_type: "POST", reason: "OTHER", status: "OPEN" },
      ],
    });

    const receipts = await listMyReports();

    expect(receipts).toEqual([
      {
        id: "r1",
        targetType: "POST",
        reason: "HARASSMENT",
        status: "OPEN",
        createdAt: "2026-10-22T10:00:00.000Z",
      },
    ]);
    expect(Object.keys(receipts[0]!)).toHaveLength(5);
  });

  it("answers an empty list for a payload that is not an array", async () => {
    rpcMock.mockResolvedValue({ data: { items: [] }, error: null });
    await expect(listMyReports()).resolves.toEqual([]);
  });
});

describe("the moderator queue", () => {
  it("asks for the caller's limit and parses one derived case", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          target_type: "COMMENT",
          target_id: "c1",
          report_count: "2",
          reasons: ["HARASSMENT", "BORING", "OTHER"],
          first_reported_at: "2026-10-22T09:00:00.000Z",
          last_reported_at: "2026-10-22T10:00:00.000Z",
          current_visibility: "PUBLISHED",
          target_exists: true,
          status: "OPEN",
        },
        { target_type: "COMMENT", target_id: "c2", status: "MYSTERY" },
      ],
      error: null,
    });

    const queue = await fetchModerationQueue(25);

    expect(rpcMock).toHaveBeenCalledWith("findback_moderation_queue", { p_limit: 25 });
    expect(queue).toEqual([
      {
        targetType: "COMMENT",
        targetId: "c1",
        reportCount: 2,
        reasons: ["HARASSMENT", "OTHER"],
        firstReportedAt: "2026-10-22T09:00:00.000Z",
        lastReportedAt: "2026-10-22T10:00:00.000Z",
        currentVisibility: "PUBLISHED",
        targetExists: true,
        status: "OPEN",
      },
    ]);
  });

  it("defaults to fifty cases and reports an unlabelled visibility as null", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          target_type: "USER",
          target_id: "u1",
          report_count: 1,
          reasons: ["OTHER"],
          first_reported_at: "a",
          last_reported_at: "b",
          current_visibility: null,
          target_exists: false,
          status: "OPEN",
        },
      ],
      error: null,
    });

    const queue = await fetchModerationQueue();

    expect(rpcMock).toHaveBeenCalledWith("findback_moderation_queue", { p_limit: 50 });
    expect(queue[0]).toMatchObject({ currentVisibility: null, targetExists: false });
  });
});

describe("the case detail", () => {
  it("returns the live target, its reports and its decisions", async () => {
    rpcMock.mockResolvedValue({
      data: {
        target_type: "POST",
        target_id: "p1",
        target_exists: true,
        target: { target_type: "POST", id: "p1", moderation_visibility: "HIDDEN" },
        reports: [
          {
            id: "r1",
            reason: "HARASSMENT",
            detail: "context",
            status: "ACTIONED",
            created_at: "2026-10-22T10:00:00.000Z",
            reviewed_at: "2026-10-22T11:00:00.000Z",
            evidence: { target_type: "POST", title: "Hide me" },
          },
          { id: "r2", reason: "BORING", status: "OPEN", created_at: "x" },
        ],
        outcomes: [
          { action: "HIDE", reason: "HARASSMENT", created_at: "2026-10-22T11:00:00.000Z" },
          { action: "NOT_AN_ACTION", reason: "OTHER", created_at: "x" },
        ],
      },
      error: null,
    });

    const target = await fetchModerationTarget("POST", " p1 ");

    expect(rpcMock).toHaveBeenCalledWith("findback_moderation_target", {
      p_target_type: "POST",
      p_target_id: "p1",
    });
    expect(target).toEqual({
      targetType: "POST",
      targetId: "p1",
      targetExists: true,
      target: { target_type: "POST", id: "p1", moderation_visibility: "HIDDEN" },
      reports: [
        {
          id: "r1",
          reason: "HARASSMENT",
          detail: "context",
          status: "ACTIONED",
          createdAt: "2026-10-22T10:00:00.000Z",
          reviewedAt: "2026-10-22T11:00:00.000Z",
          evidence: { target_type: "POST", title: "Hide me" },
        },
      ],
      decisions: [{ action: "HIDE", reason: "HARASSMENT", createdAt: "2026-10-22T11:00:00.000Z" }],
    });
  });

  it("reports a deleted target honestly instead of inventing a row", async () => {
    rpcMock.mockResolvedValue({
      data: {
        target_type: "POST",
        target_id: "p9",
        target_exists: false,
        target: null,
        reports: [],
        outcomes: [],
      },
      error: null,
    });

    const target = await fetchModerationTarget("POST", "p9");

    expect(target).toMatchObject({ targetExists: false, target: null, reports: [], decisions: [] });
  });

  it("refuses an unknown target type without calling the server", async () => {
    await expect(fetchModerationTarget("VIDEO" as never, "p1")).rejects.toMatchObject({
      status: 400,
      code: "UNKNOWN_TARGET",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("applying one action", () => {
  it("sends every parameter the writer takes and returns the audit id", async () => {
    rpcMock.mockResolvedValue({ data: "audit-1", error: null });

    const result = await applyModeration({
      targetType: "USER",
      targetId: " u1 ",
      action: "BAN",
      reasonCode: "SCAM_OR_MISLEADING",
      note: "  repeated fraud  ",
      sanctionKind: "BANNED",
      sanctionEndsAt: "2027-01-01T00:00:00.000Z",
    });

    expect(result).toEqual({ auditId: "audit-1" });
    expect(rpcMock).toHaveBeenCalledWith("findback_apply_moderation", {
      p_target_type: "USER",
      p_target_id: "u1",
      p_action: "BAN",
      p_reason_code: "SCAM_OR_MISLEADING",
      p_note: "repeated fraud",
      p_sanction_kind: "BANNED",
      p_sanction_ends_at: "2027-01-01T00:00:00.000Z",
    });
  });

  it("passes nulls a content action takes, rather than inventing a sanction", async () => {
    rpcMock.mockResolvedValue({ data: "audit-2", error: null });

    await applyModeration({
      targetType: "POST",
      targetId: "p1",
      action: "HIDE",
      reasonCode: "HARASSMENT",
      note: "   ",
    });

    expect(rpcMock).toHaveBeenCalledWith("findback_apply_moderation", {
      p_target_type: "POST",
      p_target_id: "p1",
      p_action: "HIDE",
      p_reason_code: "HARASSMENT",
      p_note: null,
      p_sanction_kind: null,
      p_sanction_ends_at: null,
    });
  });

  it("refuses an action outside the closed vocabulary without calling the server", async () => {
    await expect(
      applyModeration({
        targetType: "POST",
        targetId: "p1",
        action: "DELETE_EVERYTHING" as never,
        reasonCode: "OTHER",
      }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_ACTION" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("keeps a capability refusal as 403 even for an admin-looking action", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "You may not perform this moderation action" },
    });

    await expect(
      applyModeration({ targetType: "USER", targetId: "u1", action: "BAN", reasonCode: "OTHER" }),
    ).rejects.toMatchObject({ status: 403, code: "42501" });
  });
});

describe("the author's own view", () => {
  it("lists the caller's outcomes, five fields, and drops an unknown action", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          target_type: "POST",
          target_id: "p1",
          action: "HIDE",
          reason: "HARASSMENT",
          created_at: "2026-10-22T11:00:00.000Z",
        },
        { target_type: "POST", target_id: "p1", action: "MYSTERY", reason: "OTHER", created_at: "x" },
      ],
      error: null,
    });

    const outcomes = await listMyModerationOutcomes();

    expect(outcomes).toEqual([
      {
        targetType: "POST",
        targetId: "p1",
        action: "HIDE",
        reason: "HARASSMENT",
        createdAt: "2026-10-22T11:00:00.000Z",
      },
    ]);
    expect(Object.keys(outcomes[0]!)).toHaveLength(5);
  });

  it("lists the state of the caller's own rows and drops a state it cannot name", async () => {
    rpcMock.mockResolvedValue({
      data: [
        { post_id: "p1", moderation_visibility: "PUBLISHED", updated_at: "2026-10-22T11:00:00.000Z" },
        { post_id: "p2", moderation_visibility: "PUBLISHED" },
        { post_id: "p3", moderation_visibility: "SOMETHING_NEW", updated_at: "x" },
      ],
      error: null,
    });

    await expect(fetchMyPostModeration()).resolves.toEqual([
      { postId: "p1", visibility: "PUBLISHED", updatedAt: "2026-10-22T11:00:00.000Z" },
    ]);
  });
});

describe("appealing a decision", () => {
  it("sends the subject pair and returns the appeal id", async () => {
    rpcMock.mockResolvedValue({ data: "appeal-1", error: null });

    const result = await submitAppeal("SANCTION", " s1 ", "  Please review.  ");

    expect(result).toEqual({ appealId: "appeal-1" });
    expect(rpcMock).toHaveBeenCalledWith("findback_submit_appeal", {
      p_target_kind: "SANCTION",
      p_target_id: "s1",
      p_message: "Please review.",
    });
  });

  it("refuses an empty or over-long message without calling the server", async () => {
    await expect(submitAppeal("SANCTION", "s1", "   ")).rejects.toMatchObject({
      status: 400,
      code: "MESSAGE_LENGTH",
    });
    await expect(submitAppeal("SANCTION", "s1", "x".repeat(2001))).rejects.toMatchObject({
      status: 400,
      code: "MESSAGE_LENGTH",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("answers a second open appeal with 409, not a generic failure", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "APPEAL_ALREADY_OPEN" },
    });

    await expect(submitAppeal("MODERATION_ACTION", "a1", "Again, please.")).rejects.toMatchObject({
      status: 409,
      code: "APPEAL_ALREADY_OPEN",
    });
  });
});
