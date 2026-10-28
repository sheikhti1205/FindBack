// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  value: { user: null as object | null, deletionCompletion: null as { accountId: string; state: "cleaning" | "complete" | "cleanup-failed" } | null,
    deletionRecoveryError: false, retryDeletionCleanup: vi.fn(), dismissDeletionCompletion: vi.fn() },
}));
vi.mock("../auth", () => ({ useAuth: () => state.value }));
import { AccountDeletionFeedback } from "./AccountDeletionFeedback";
afterEach(() => {
  cleanup(); vi.clearAllMocks();
  state.value.user = null; state.value.deletionCompletion = null; state.value.deletionRecoveryError = false;
});
describe("account deletion feedback truthfulness", () => {
  it("does not turn an inventory failure into a deletion or completion claim", () => {
    state.value.deletionRecoveryError = true;
    render(<AccountDeletionFeedback />);
    expect(screen.getByRole("alert").textContent).toContain("Could not check unfinished cleanup");
    expect(document.body.textContent).not.toContain("permanently deleted");
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    expect(state.value.retryDeletionCleanup).toHaveBeenCalledOnce();
  });
  it("names local chat history in confirmed cleanup, not only sign-in and keys", () => {
    state.value.deletionCompletion = { accountId: "synthetic-account-a", state: "complete" };
    render(<AccountDeletionFeedback />);
    expect(screen.getByRole("status").textContent).toContain("chat history was cleared");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(state.value.dismissDeletionCompletion).toHaveBeenCalledOnce();
  });
  it("does not let stale complete feedback hide incomplete inventory", () => {
    state.value.deletionCompletion = { accountId: "synthetic-account-a", state: "complete" };
    state.value.deletionRecoveryError = true;
    render(<AccountDeletionFeedback />);
    expect(screen.getByRole("alert").textContent).toContain("Could not check unfinished cleanup");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
  it("never reveals captured A's deletion feedback while B is signed in", () => {
    state.value.user = { id: "synthetic-account-b" };
    state.value.deletionCompletion = { accountId: "synthetic-account-a", state: "cleanup-failed" };
    const view = render(<AccountDeletionFeedback />);
    expect(view.container.textContent).toBe("");
  });
  it("offers generic inventory retry while B is signed in without disclosing A's outcome", () => {
    state.value.user = { id: "synthetic-account-b" };
    state.value.deletionCompletion = { accountId: "synthetic-account-a", state: "complete" };
    state.value.deletionRecoveryError = true;
    render(<AccountDeletionFeedback />);
    expect(screen.getByRole("alert").textContent).toContain("Could not check unfinished cleanup");
    expect(document.body.textContent).not.toMatch(/synthetic-account-a|permanently deleted|chat history was cleared/);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    expect(state.value.retryDeletionCleanup).toHaveBeenCalledOnce();
  });
});
