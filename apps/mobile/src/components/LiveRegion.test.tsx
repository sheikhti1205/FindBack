// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { announce, LiveRegion, Snackbar } from "./LiveRegion";

afterEach(cleanup);

describe("LiveRegion snackbar", () => {
  it("announces politely and shows one visible toast that auto-exits", async () => {
    render(<LiveRegion autoExitMs={50} />);

    act(() => {
      announce("Report published.");
    });

    // Screen-reader announcement persists in the sr-only live region …
    expect(screen.getByTestId("live-region-announcement")).toHaveProperty(
      "textContent",
      "Report published.",
    );
    // … while exactly one visible toast carries the same message.
    expect(screen.getByTestId("snackbar-message")).toHaveProperty(
      "textContent",
      "Report published.",
    );

    // The visible toast exits on its own; the announcement stays.
    await waitFor(() => expect(screen.queryByTestId("snackbar-message")).toBeNull());
    expect(screen.getByTestId("live-region-announcement")).toHaveProperty(
      "textContent",
      "Report published.",
    );
  });

  it("stays silent with no message", () => {
    render(<LiveRegion autoExitMs={50} />);
    expect(screen.getByTestId("live-region-announcement").textContent).toBe("");
    expect(screen.queryByTestId("snackbar-message")).toBeNull();
  });
});

describe("Snackbar primitive", () => {
  it("announces itself as a live status by default", () => {
    render(<Snackbar open message="Press back again to exit" />);
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Press back again to exit");
  });

  it("renders nothing when closed", () => {
    render(<Snackbar open={false} message="Press back again to exit" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
