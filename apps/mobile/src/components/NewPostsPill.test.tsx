// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewPostsPill } from "./NewPostsPill";

afterEach(cleanup);

describe("NewPostsPill", () => {
  it("does not reserve a spacer when there are no new posts or updates", () => {
    const { container } = render(<NewPostsPill count={0} hasUpdates={false} onTap={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[class*="min-h-"]')).toBeNull();
  });

  it("announces new posts, refreshes on tap and removes the wrapper after exit", async () => {
    const onTap = vi.fn();
    const { container, rerender } = render(<NewPostsPill count={2} onTap={onTap} />);
    fireEvent.click(screen.getByRole("button", { name: "2 new posts — tap to refresh" }));
    expect(onTap).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("2 new posts");
    rerender(<NewPostsPill count={0} hasUpdates={false} onTap={onTap} />);
    await waitFor(() => expect(container.querySelector('[class*="min-h-"]')).toBeNull());
  });

  it("shows an Updates action without inventing a new-post count", () => {
    render(<NewPostsPill count={0} hasUpdates onTap={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Updates — tap to refresh" })).toBeTruthy();
  });
});
