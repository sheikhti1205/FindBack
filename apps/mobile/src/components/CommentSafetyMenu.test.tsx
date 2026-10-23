// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommentSafetyMenu } from "./CommentSafetyMenu";

const { submit } = vi.hoisted(() => ({ submit: vi.fn().mockResolvedValue({ reportId: "receipt" }) }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "reader" } }) }));
const { listBlocks } = vi.hoisted(() => ({ listBlocks: vi.fn().mockResolvedValue([]) }));
vi.mock("../services/blocks", async (original) => ({
  ...await original<typeof import("../services/blocks")>(), listMyBlocks: listBlocks,
}));
vi.mock("../services/moderation", async (original) => ({
  ...await original<typeof import("../services/moderation")>(), submitReport: submit,
}));

afterEach(cleanup);
const base = { commentId: "comment-7", authorId: "author", authorName: "Sam", viewerId: "reader" };

it("opens the canonical report sheet for the actual comment id and restores focus", async () => {
  render(<CommentSafetyMenu {...base} canDelete={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Actions for comment by Sam" }));
  expect(screen.queryByRole("menuitem", { name: "Delete comment" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Report comment" }));
  expect(screen.getByRole("dialog", { name: "Report a problem" })).toBeTruthy();
  expect(screen.getAllByRole("radio")).toHaveLength(7);
  fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByTestId("report-receipt");
  expect(submit).toHaveBeenCalledWith({ targetType: "COMMENT", targetId: "comment-7", reason: "HARASSMENT", detail: null });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for comment by Sam" })));
});

it("offers Delete only when caller permission AND handler are present; never reports self", () => {
  const onDelete = vi.fn();
  render(<CommentSafetyMenu {...base} viewerId="author" canDelete onDelete={onDelete} />);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.queryByRole("menuitem", { name: "Report comment" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete comment" }));
  expect(onDelete).toHaveBeenCalledOnce();
});

it("hides the trigger for signed-out viewers and for self without Delete", () => {
  const { rerender } = render(<CommentSafetyMenu {...base} viewerId={null} canDelete />);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<CommentSafetyMenu {...base} viewerId="author" canDelete />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("supports arrow navigation and Escape focus return like OwnerReportMenu", () => {
  render(<CommentSafetyMenu {...base} canDelete onDelete={() => {}} />);
  const trigger = screen.getByRole("button");
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Report comment" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Block account" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete comment" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("provides compact access to the canonical block control for the comment author", async () => {
  render(<CommentSafetyMenu {...base} canDelete={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Actions for comment by Sam" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Block account" }));
  expect(screen.getByRole("dialog", { name: "Block account" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Block Sam" })).toBeTruthy();
  expect(listBlocks).toHaveBeenCalled();
});
