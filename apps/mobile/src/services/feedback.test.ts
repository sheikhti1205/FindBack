import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  listMyFeedback,
  submitFeedback,
} from "./feedback";

const { clientMock, orderMock, selectMock, fromMock } = vi.hoisted(() => {
  const orderMock = vi.fn();
  const selectMock = vi.fn((_columns: string) => ({ order: orderMock }));
  const fromMock = vi.fn((_table: string) => ({ select: selectMock }));
  const clientMock = { rpc: vi.fn(), from: fromMock };
  return { clientMock, orderMock, selectMock, fromMock };
});

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

beforeEach(() => {
  clientMock.rpc.mockReset();
  fromMock.mockClear();
  selectMock.mockClear();
  orderMock.mockReset();
});

function lastCall(name: string): Record<string, unknown> {
  const call = clientMock.rpc.mock.calls.find((entry) => entry[0] === name);
  expect(call, `${name} was called`).toBeTruthy();
  return call![1] as Record<string, unknown>;
}

describe("the feedback vocabulary", () => {
  it("is the four categories the server accepts", () => {
    expect([...FEEDBACK_CATEGORIES]).toEqual(["BUG", "SUGGESTION", "USABILITY", "OTHER"]);
  });

  it("is the three statuses the server accepts", () => {
    expect([...FEEDBACK_STATUSES]).toEqual(["NEW", "REVIEWING", "RESOLVED"]);
  });

  it("labels every value, and never shows the raw database word", () => {
    for (const category of FEEDBACK_CATEGORIES) {
      const label = FEEDBACK_CATEGORY_LABELS[category];
      expect(label, `${category} has a label`).toBeTruthy();
      expect(label).not.toBe(category);
    }
    for (const status of FEEDBACK_STATUSES) {
      const label = FEEDBACK_STATUS_LABELS[status];
      expect(label, `${status} has a label`).toBeTruthy();
      expect(label).not.toBe(status);
    }
  });
});

describe("submitting feedback", () => {
  it("sends the named scalars — never a blob and never a message copy", async () => {
    clientMock.rpc.mockResolvedValue({ data: "feedback-1", error: null });

    await expect(
      submitFeedback({
        category: "BUG",
        message: "  the feed flickers when I scroll  ",
        includeTechnicalInfo: true,
        appVersion: " 2.0.0-beta.1 ",
        platform: "android",
        screen: "settings/privacy",
        deviceClass: null,
      }),
    ).resolves.toBe("feedback-1");

    expect(lastCall("findback_submit_feedback")).toEqual({
      p_category: "BUG",
      p_message: "the feed flickers when I scroll",
      p_include_technical_info: true,
      p_app_version: "2.0.0-beta.1",
      p_platform: "android",
      p_screen: "settings/privacy",
      p_device_class: null,
    });
    // There is no argument a log, a token or a context object could travel in.
    expect(Object.keys(lastCall("findback_submit_feedback"))).toHaveLength(7);
  });

  it("turns a blank scalar into null instead of an empty string", async () => {
    clientMock.rpc.mockResolvedValue({ data: "feedback-2", error: null });
    await submitFeedback({
      category: "OTHER",
      message: "hello",
      includeTechnicalInfo: false,
      appVersion: "   ",
      platform: "",
    });
    expect(lastCall("findback_submit_feedback")).toMatchObject({
      p_app_version: null,
      p_platform: null,
      p_screen: null,
      p_device_class: null,
    });
  });

  it("refuses a category the server does not know, without a round trip", async () => {
    await expect(
      submitFeedback({
        category: "PRAISE" as unknown as (typeof FEEDBACK_CATEGORIES)[number],
        message: "nice app",
        includeTechnicalInfo: false,
      }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_CATEGORY" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("refuses an empty and an over-long message, never truncating one", async () => {
    await expect(
      submitFeedback({ category: "BUG", message: "   ", includeTechnicalInfo: false }),
    ).rejects.toMatchObject({ status: 400, code: "EMPTY_MESSAGE" });

    await expect(
      submitFeedback({
        category: "BUG",
        message: "x".repeat(FEEDBACK_MESSAGE_MAX + 1),
        includeTechnicalInfo: false,
      }),
    ).rejects.toMatchObject({ status: 400, code: "MESSAGE_TOO_LONG" });

    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("does not claim success when the server answered without an id", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    await expect(
      submitFeedback({ category: "BUG", message: "hello", includeTechnicalInfo: false }),
    ).rejects.toMatchObject({ status: 500, code: "UNEXPECTED_SHAPE" });
  });

  it("maps the server's refusals: bad input, a rate limit, a lost session", async () => {
    const cases: Array<[string, number]> = [
      ["22023", 400],
      ["42501", 403],
      ["28000", 401],
      ["P0001", 429],
      ["PGRST202", 500],
    ];
    for (const [code, status] of cases) {
      clientMock.rpc.mockResolvedValue({ data: null, error: { message: "refused", code } });
      await expect(
        submitFeedback({ category: "BUG", message: "hello", includeTechnicalInfo: false }),
      ).rejects.toMatchObject({ status, code });
    }
  });
});

describe("reading my own submissions", () => {
  it("asks only for the five granted columns — never message, context or admin_note", async () => {
    orderMock.mockResolvedValue({ data: [], error: null });

    await expect(listMyFeedback()).resolves.toEqual([]);

    expect(fromMock).toHaveBeenCalledWith("feedback");
    const columns = String(selectMock.mock.calls[0]![0]);
    expect(columns).toBe("id, category, status, created_at, updated_at");
    // The server does not grant these; asking for one would be a 42501 and,
    // worse, would prove the client wanted the text back.
    for (const forbidden of ["message", "technical_context", "admin_note", "user_id", "*"]) {
      expect(columns).not.toContain(forbidden);
    }
    expect(orderMock).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("maps the rows the user is shown", async () => {
    orderMock.mockResolvedValue({
      data: [
        {
          id: "feedback-1",
          category: "BUG",
          status: "REVIEWING",
          created_at: "2026-10-22T10:00:00.000Z",
          updated_at: "2026-10-22T11:00:00.000Z",
        },
      ],
      error: null,
    });

    await expect(listMyFeedback()).resolves.toEqual([
      {
        id: "feedback-1",
        category: "BUG",
        status: "REVIEWING",
        createdAt: "2026-10-22T10:00:00.000Z",
        updatedAt: "2026-10-22T11:00:00.000Z",
      },
    ]);
  });

  it("drops a row whose category or status the app cannot label", async () => {
    orderMock.mockResolvedValue({
      data: [
        { id: "a", category: "PRAISE", status: "NEW", created_at: "", updated_at: "" },
        { id: "b", category: "BUG", status: "ARCHIVED", created_at: "", updated_at: "" },
        { id: "c", category: "OTHER", status: "RESOLVED", created_at: "", updated_at: "" },
      ],
      error: null,
    });

    await expect(listMyFeedback()).resolves.toEqual([
      { id: "c", category: "OTHER", status: "RESOLVED", createdAt: "", updatedAt: "" },
    ]);
  });

  it("carries a refusal rather than showing an empty history", async () => {
    orderMock.mockResolvedValue({ data: null, error: { message: "permission denied", code: "42501" } });
    await expect(listMyFeedback()).rejects.toMatchObject({ status: 403, code: "42501" });
  });
});
