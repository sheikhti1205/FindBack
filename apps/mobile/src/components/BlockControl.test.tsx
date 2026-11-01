// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BlockControl } from "./BlockControl";
import { ApiError } from "../services/session";
import { subscribeSafetyChanged } from "../services/safetySignals";
import { ChatReportContext } from "../screens/Messaging";
import { MemoryRouter } from "react-router";
const mocks = vi.hoisted(() => ({ list: vi.fn(), block: vi.fn(), unblock: vi.fn(), mutual: vi.fn(), fetchPost: vi.fn(), viewer: "me" }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: mocks.viewer } }) }));
vi.mock("../services/blocks", () => ({ listMyBlocks: mocks.list, blockUser: mocks.block, unblockUser: mocks.unblock, isBlockedWithMe: mocks.mutual }));
vi.mock("../services/posts", () => ({ fetchPost: mocks.fetchPost }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); mocks.viewer = "me";
  mocks.list.mockResolvedValue([]); mocks.block.mockResolvedValue(undefined);
  mocks.unblock.mockResolvedValue({ stillHidden: true });
});
const props = { userId: "sam", name: "Sam" };

it("a real block confirmation revokes a third-author report preview without changing its conversation peer", async () => {
  let blocked = false;
  mocks.fetchPost.mockImplementation(async () => ({ id: "third-report", title: "Third author wallet", type: "FOUND",
    blockedAuthor: blocked, locationLabel: "Private place", attachments: [{ mimeType: "image/jpeg", fileUrl: "/private.jpg" }] }));
  mocks.block.mockImplementation(async () => { blocked = true; });
  render(<MemoryRouter><BlockControl {...props} blocked={false} /><ChatReportContext reportId="third-report" /></MemoryRouter>);
  await screen.findByRole("link", { name: /Third author wallet/ });
  fireEvent.click(screen.getByRole("button", { name: "Block Sam" }));
  confirmBlock("Block");
  expect(await screen.findByText("Report unavailable")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText("Private place")).toBeNull();
});

it("invalidates other mounted subjects even if this block control leaves while the write is pending", async () => {
  let finish!: () => void;
  mocks.block.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const changed = vi.fn();
  const unsubscribe = subscribeSafetyChanged(changed);
  try {
    const view = render(<BlockControl {...props} blocked={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Block Sam" }));
    confirmBlock("Block");
    expect(mocks.block).toHaveBeenCalledWith("sam");
    view.unmount();
    await act(async () => { finish(); });
    expect(changed).toHaveBeenCalledTimes(1);
  } finally { unsubscribe(); }
});

/** Blocking asks through the canonical alert dialog, never window.confirm. */
function confirmBlock(label: "Block" | "Unblock") {
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
}

it("uses outgoing membership even if incoming-only mutual blocking exists", async () => {
  mocks.mutual.mockResolvedValue(true);
  render(<BlockControl {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Block Sam" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toMatch(/Public reports and comments remain behind a warning/);
  expect(dialog.textContent).toMatch(/option to reveal them/);
  expect(mocks.block).not.toHaveBeenCalled();
  confirmBlock("Block");
  expect(await screen.findByText("You blocked Sam. You can't interact with each other, but public content can still be revealed.")).toBeTruthy();
  expect(mocks.block).toHaveBeenCalledWith("sam");
  expect(mocks.mutual).not.toHaveBeenCalled();
});

it.each([true, false])("unblock clears outgoing state regardless of stillHidden=%s", async (stillHidden) => {
  mocks.unblock.mockResolvedValue({ stillHidden });
  const onChanged = vi.fn();
  render(<BlockControl {...props} blocked onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Unblock Sam" }));
  confirmBlock("Unblock");
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
  confirmBlock("Block");
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
  confirmBlock("Block");
  if (kind === "account") mocks.viewer = "other";
  rerender(<BlockControl {...(kind === "target" ? { userId: "lee", name: "Lee" } : props)} onChanged={onChanged} />);
  await screen.findByRole("button", { name: kind === "target" ? "Block Lee" : "Block Sam" });
  await act(async () => { finish(); });
  expect(onChanged).not.toHaveBeenCalled(); expect(heard).not.toHaveBeenCalled();
  expect(screen.queryByTestId("block-outcome")).toBeNull();
  window.removeEventListener("findback:announce", heard);
});
