// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { REPORT_REASONS } from "../services/moderation";
import { ApiError } from "../services/session";

const { mockSubmitReport, viewer } = vi.hoisted(() => ({ mockSubmitReport: vi.fn(), viewer: { id: "reader" } }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: viewer.id } }) }));

// The service is mocked, not the network: the real vocabulary and the real
// labels stay, only the server call is replaced.
vi.mock("../services/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/moderation")>();
  return { ...actual, submitReport: (...args: unknown[]) => mockSubmitReport(...args) };
});

import { ReportSheet } from "./ReportSheet";

afterEach(cleanup);

beforeEach(() => {
  mockSubmitReport.mockReset();
  viewer.id = "reader";
  mockSubmitReport.mockResolvedValue({ reportId: "report-1" });
});

function renderSheet(targetType: "POST" | "COMMENT" | "USER" = "POST") {
  return render(
    <ReportSheet
      open
      onClose={() => {}}
      target={{ targetType, targetId: "target-1" }}
    />,
  );
}

describe("the one report sheet", () => {
  it.each(["target", "reopen", "account"])("ignores an old submission after a %s change", async (change) => {
    let resolve!: (value: { reportId: string }) => void;
    mockSubmitReport.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onReported = vi.fn();
    const target = { targetType: "POST" as const, targetId: "target-1" };
    const props = { open: true, onClose: () => {}, target, onReported };
    const heard: string[] = [];
    const listener = (event: Event) => { heard.push((event as CustomEvent<string>).detail); };
    window.addEventListener("findback:announce", listener);
    try {
      const { rerender } = render(<ReportSheet {...props} />);
      fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
      fireEvent.click(screen.getByRole("button", { name: /send report/i }));
      expect(mockSubmitReport).toHaveBeenCalledTimes(1);
      if (change === "reopen") rerender(<ReportSheet {...props} open={false} />);
      if (change === "account") viewer.id = "other-reader";
      const next = change === "target" ? { ...target, targetId: "target-2" } : target;
      rerender(<ReportSheet {...props} target={next} />);
      fireEvent.change(screen.getByLabelText(/anything else we should know/i), { target: { value: "second draft" } });
      await act(async () => { resolve({ reportId: "old-receipt" }); });
      expect(screen.queryByTestId("report-receipt")).toBeNull();
      expect(onReported).not.toHaveBeenCalled();
      expect(heard).not.toContain("Report sent.");
      expect((screen.getByLabelText(/anything else we should know/i) as HTMLTextAreaElement).value).toBe("second draft");
      expect((screen.getByRole("button", { name: /send report/i }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      window.removeEventListener("findback:announce", listener);
    }
  });

  it("offers the seven server reasons in words, and no eighth option", () => {
    renderSheet();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(REPORT_REASONS.length);
    expect(REPORT_REASONS).toHaveLength(7);
    expect(screen.getByRole("radio", { name: /scam or misleading/i })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /hard to use/i })).toBeNull();
    // A database word never reaches the screen.
    expect(document.body.textContent).not.toMatch(/SCAM_OR_MISLEADING/);
  });

  it("names what is being reported, in the reader's words", () => {
    renderSheet("COMMENT");
    expect(screen.getByRole("dialog", { name: /report a problem/i })).toBeTruthy();
    expect(document.body.textContent).toContain("this comment");
  });

  it("sends the chosen reason, the target and the note — and nothing else", async () => {
    renderSheet("USER");
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.change(screen.getByLabelText(/anything else we should know/i), {
      target: { value: "They kept messaging me." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    await waitFor(() => expect(mockSubmitReport).toHaveBeenCalledTimes(1));
    expect(mockSubmitReport).toHaveBeenCalledWith({
      targetType: "USER",
      targetId: "target-1",
      reason: "HARASSMENT",
      detail: "They kept messaging me.",
    }, expect.any(AbortSignal));
  });

  it("shows an honest receipt only after the server confirmed the report", async () => {
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /spam or a duplicate/i }));
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    expect(await screen.findByTestId("report-receipt")).toBeTruthy();
    expect(screen.getByText(/report sent/i)).toBeTruthy();
    // The receipt points at the place the reader can follow it.
    expect(screen.getByTestId("report-receipt").textContent).toContain("Settings");
  });

  it("keeps the form open and says why when the server refuses", async () => {
    mockSubmitReport.mockRejectedValue(new ApiError("REPORT_LIMIT_REACHED", 429, "REPORT_LIMIT_REACHED"));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    const error = await screen.findByTestId("report-error");
    expect(error.textContent).toMatch(/a lot of reports today/i);
    // No receipt, and the form is still there to try again.
    expect(screen.queryByTestId("report-receipt")).toBeNull();
    expect(screen.getByRole("button", { name: /send report/i })).toBeTruthy();
  });

  it("refuses to send without a reason", async () => {
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));
    expect(await screen.findByTestId("report-error")).toBeTruthy();
    expect(mockSubmitReport).not.toHaveBeenCalled();
  });

  it("says plainly that reporting is not in this build when the server has no such function", async () => {
    mockSubmitReport.mockRejectedValue(new ApiError("Could not find the function", 500, "PGRST202"));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    const error = await screen.findByTestId("report-error");
    expect(error.textContent).toMatch(/not available in this build/i);
    // No receipt, and no database word.
    expect(screen.queryByTestId("report-receipt")).toBeNull();
    expect(error.textContent).not.toMatch(/PGRST202|schema/i);
  });

  it("announces the outcome for a screen reader", async () => {
    const heard: string[] = [];
    const listener = (event: Event): void => {
      heard.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("findback:announce", listener);
    try {
      renderSheet();
      fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
      fireEvent.click(screen.getByRole("button", { name: /send report/i }));
      await screen.findByTestId("report-receipt");
      expect(heard).toContain("Report sent.");
    } finally {
      window.removeEventListener("findback:announce", listener);
    }
  });
});
