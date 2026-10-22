// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ user: { id: "u1" } as { id: string } | null }));
vi.mock("../auth", () => ({ useAuth: () => auth }));
import { ReportDeletionFeedbackProvider, useReportDeletionFailure } from "./ReportDeletionFeedback";

let lateFailure: ReturnType<typeof useReportDeletionFailure>;
function Probe() {
  lateFailure = useReportDeletionFailure();
  return <button onClick={() => lateFailure({ userId: "u1", message: "Report not deleted." })}>Fail</button>;
}
afterEach(() => { cleanup(); auth.user = { id: "u1" }; });

describe("Report deletion feedback", () => {
  it("persists a failure when the originating screen leaves and can be dismissed", () => {
    const view = render(<ReportDeletionFeedbackProvider><Probe /></ReportDeletionFeedbackProvider>);
    fireEvent.click(screen.getByText("Fail"));
    view.rerender(<ReportDeletionFeedbackProvider><h1>Another screen</h1></ReportDeletionFeedbackProvider>);
    expect(screen.getByRole("alert").textContent).toBe("Report not deleted.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never shows old-account or signed-out failures to a new account", () => {
    const view = render(<ReportDeletionFeedbackProvider><Probe /></ReportDeletionFeedbackProvider>);
    fireEvent.click(screen.getByText("Fail"));
    auth.user = null;
    view.rerender(<ReportDeletionFeedbackProvider><Probe /></ReportDeletionFeedbackProvider>);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => lateFailure({ userId: "u1", message: "late failure" }));
    expect(screen.queryByRole("alert")).toBeNull();
    auth.user = { id: "u2" };
    view.rerender(<ReportDeletionFeedbackProvider><Probe /></ReportDeletionFeedbackProvider>);
    act(() => lateFailure({ userId: "u1", message: "old account failure" }));
    expect(screen.queryByRole("alert")).toBeNull();
    auth.user = { id: "u1" };
    view.rerender(<ReportDeletionFeedbackProvider><Probe /></ReportDeletionFeedbackProvider>);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
