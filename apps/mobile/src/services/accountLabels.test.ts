import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAccountLabels } from "./accountLabels";

const { clientMock } = vi.hoisted(() => ({
  clientMock: { from: vi.fn() },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

beforeEach(() => {
  clientMock.from.mockReset();
});

function stubRows(rows: unknown[]): void {
  const builder = {
    select: vi.fn(() => builder),
    in: vi.fn(() => builder),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  clientMock.from.mockReturnValue(builder);
}

describe("naming the accounts a reader blocked", () => {
  it("reads only the public columns the app already publishes", async () => {
    stubRows([{ id: "user-2", username: "sam" }]);
    const labels = await fetchAccountLabels(["user-2"]);
    expect(labels.get("user-2")).toBe("sam");
    expect(clientMock.from).toHaveBeenCalledWith("users");
    const builder = clientMock.from.mock.results[0]?.value as { select: ReturnType<typeof vi.fn> };
    expect(builder.select).toHaveBeenCalledWith("id, username");
  });

  it("leaves an account with no name out rather than naming it something", async () => {
    stubRows([{ id: "user-3", username: "  " }]);
    const labels = await fetchAccountLabels(["user-3"]);
    expect(labels.has("user-3")).toBe(false);
  });

  it("asks for nothing when there is nobody to name", async () => {
    const labels = await fetchAccountLabels([]);
    expect(labels.size).toBe(0);
    expect(clientMock.from).not.toHaveBeenCalled();
  });

  it("de-duplicates the ids it asks about", async () => {
    stubRows([]);
    await fetchAccountLabels([" user-2 ", "user-2", ""]);
    const builder = clientMock.from.mock.results[0]?.value as { in: ReturnType<typeof vi.fn> };
    expect(builder.in).toHaveBeenCalledWith("id", ["user-2"]);
  });
});
