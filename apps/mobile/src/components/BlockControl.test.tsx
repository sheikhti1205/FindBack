// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BlockControl } from "./BlockControl";
import { ApiError } from "../services/session";
const mocks = vi.hoisted(() => ({ list: vi.fn(), block: vi.fn(), unblock: vi.fn(), mutual: vi.fn(), viewer: "me" }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: mocks.viewer } }) }));
vi.mock("../services/blocks", () => ({ listMyBlocks: mocks.list, blockUser: mocks.block, unblockUser: mocks.unblock, isBlockedWithMe: mocks.mutual }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); mocks.viewer = "me";
  mocks.list.mockResolvedValue([]); mocks.block.mockResolvedValue(undefined);
  mocks.unblock.mockResolvedValue({ stillHidden: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
const props = { userId: "sam", name: "Sam" };

it("uses outgoing membership even if incoming-only mutual blocking exists", async () => {
  mocks.mutual.mockResolvedValue(true);
  render(<BlockControl {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Block Sam" }));
  expect(await screen.findByText("You blocked Sam. You can't interact with each other, but public content can still be revealed.")).toBeTruthy();
  expect(mocks.block).toHaveBeenCalledWith("sam");
  expect(mocks.mutual).not.toHaveBeenCalled();
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Public reports and comments remain behind a warning"));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("option to reveal them"));
});

it.each([true, false])("unblock clears outgoing state regardless of stillHidden=%s", async (stillHidden) => {
  mocks.unblock.mockResolvedValue({ stillHidden });
  const onChanged = vi.fn();
  render(<BlockControl {...props} blocked onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Unblock Sam" }));
  expect(await screen.findByRole("button", { name: "Block Sam" })).toBeTruthy();
  expect(screen.getByTestId("block-outcome").textContent).toBe("You've unblocked Sam. You can interact again unless they've also blocked you.");
  expect(onChanged).toHaveBeenCalledWith({ blocked: false, stillHidden });
});

it.each([new Error("network"), new ApiError("missing", 500, "PGRST202")])("offers Retry after rejected membership read, never indefinite Checking", async (failure) => {
  mocks.list.mockRejectedValueOnce(failure);
  render(<BlockControl {...props} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Checking…")).toBeNull();
  if (failure instanceof ApiError) expect(screen.getByRole("alert").textContent).toMatch(/not available in this build/i);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Block Sam" })).toBeTruthy();
});

it("does not claim a block when write is unavailable", async () => {
  mocks.block.mockRejectedValue(new ApiError("missing", 500, "PGRST202"));
  render(<BlockControl {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Block Sam" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/not available in this build/i);
  expect(screen.queryByTestId("block-outcome")).toBeNull();
});

it.each(["account", "target"])("suppresses stale reads across %s switches", async (kind) => {
  let finish!: (rows: { userId: string }[]) => void;
  mocks.list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { rerender } = render(<BlockControl {...props} />);
  if (kind === "account") mocks.viewer = "other";
  const next = kind === "account" ? props : { userId: "lee", name: "Lee" };
  rerender(<BlockControl {...next} />);
  await screen.findByRole("button", { name: `Block ${next.name}` });
  await act(async () => { finish([{ userId: "sam" }]); });
  expect(screen.queryByText("Unblock Sam")).toBeNull();
  expect(screen.getByRole("button", { name: `Block ${next.name}` })).toBeTruthy();
});

it.each(["account", "target"])("suppresses stale mutation state, callbacks and announcements across %s switches", async (kind) => {
  let finish!: () => void;
  mocks.block.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const heard = vi.fn(); window.addEventListener("findback:announce", heard);
  const onChanged = vi.fn();
  const { rerender } = render(<BlockControl {...props} onChanged={onChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Block Sam" }));
  if (kind === "account") mocks.viewer = "other";
  rerender(<BlockControl {...(kind === "target" ? { userId: "lee", name: "Lee" } : props)} onChanged={onChanged} />);
  await screen.findByRole("button", { name: kind === "target" ? "Block Lee" : "Block Sam" });
  await act(async () => { finish(); });
  expect(onChanged).not.toHaveBeenCalled(); expect(heard).not.toHaveBeenCalled();
  expect(screen.queryByTestId("block-outcome")).toBeNull();
  window.removeEventListener("findback:announce", heard);
});
