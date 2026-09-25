// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const analyze = vi.hoisted(() => vi.fn());
vi.mock("../services/analyzeReportPhoto", () => ({ analyzeReportPhoto: analyze }));
import { VlmSuggestions } from "./VlmSuggestions";

afterEach(cleanup);

describe("consented OpenRouter image suggestions", () => {
  it("never sends a selected photo until explicit consent, then requires review before applying", async () => {
    analyze.mockResolvedValueOnce({ suggestedTitle: "Blue wallet", suggestedDescription: "A blue wallet.", suggestedCategory: null, uncertainFields: [] });
    const file = new File(["jpeg"], "wallet.jpg", { type: "image/jpeg" });
    const apply = vi.fn();
    render(<MemoryRouter><VlmSuggestions file={file} onApply={apply} /></MemoryRouter>);
    expect(analyze).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Analyze photo" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Send selected photo to OpenRouter for AI suggestions"));
    fireEvent.click(screen.getByRole("button", { name: "Analyze photo" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith(file, true));
    expect(apply).not.toHaveBeenCalled();
    expect(await screen.findByText("Title: Blue wallet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply suggestions" }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ suggestedTitle: "Blue wallet" }));
  });

  it("drops a stale response when the photo changes mid-request", async () => {
    let resolveFirst!: (value: unknown) => void;
    analyze.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const first = new File(["jpeg"], "first.jpg", { type: "image/jpeg" });
    const apply = vi.fn();
    const view = render(<MemoryRouter><VlmSuggestions file={first} onApply={apply} /></MemoryRouter>);
    fireEvent.click(screen.getByLabelText("Send selected photo to OpenRouter for AI suggestions"));
    fireEvent.click(screen.getByRole("button", { name: "Analyze photo" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const second = new File(["png"], "second.png", { type: "image/png" });
    view.rerender(<MemoryRouter><VlmSuggestions file={second} onApply={apply} /></MemoryRouter>);
    resolveFirst({ suggestedTitle: "Stale title", suggestedDescription: "Stale.", suggestedCategory: null, uncertainFields: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Title: Stale title")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});
