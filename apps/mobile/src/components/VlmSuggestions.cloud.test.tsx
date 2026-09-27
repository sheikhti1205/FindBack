// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const analyze = vi.hoisted(() => vi.fn());
vi.mock("../services/analyzeReportPhoto", () => ({ analyzeReportPhoto: analyze }));
import { VlmSuggestions } from "./VlmSuggestions";

afterEach(cleanup);

const CONSENT_LABEL =
  "Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it.";

function expandPanel(): void {
  const expand = screen.queryByRole("button", { name: /Expand photo suggestions/i });
  if (expand) fireEvent.click(expand);
}

describe("consented OpenRouter image suggestions", () => {
  it("never sends a selected photo until explicit consent, then requires review before applying", async () => {
    analyze.mockResolvedValueOnce({ suggestedTitle: "Blue wallet", suggestedDescription: "A blue wallet.", suggestedCategory: null, uncertainFields: [] });
    const file = new File(["jpeg"], "wallet.jpg", { type: "image/jpeg" });
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);
    expandPanel();
    expect(analyze).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Suggest title & description" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(CONSENT_LABEL));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith(file, true, expect.any(Object)));
    expect(apply).not.toHaveBeenCalled();
    expect(await screen.findByText("Review suggestions from AI:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ suggestedTitle: "Blue wallet" }));
    // Applying the title must not silently touch the description.
    expect(apply).not.toHaveBeenCalledWith(expect.objectContaining({ suggestedDescription: expect.any(String) }));
  });

  it("drops a stale response when the photo changes mid-request", async () => {
    let resolveFirst!: (value: unknown) => void;
    analyze.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const first = new File(["jpeg"], "first.jpg", { type: "image/jpeg" });
    const apply = vi.fn(() => true);
    const view = render(<MemoryRouter><VlmSuggestions file={first} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);
    expandPanel();
    fireEvent.click(screen.getByLabelText(CONSENT_LABEL));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const second = new File(["png"], "second.png", { type: "image/png" });
    view.rerender(<MemoryRouter><VlmSuggestions file={second} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);
    resolveFirst({ suggestedTitle: "Stale title", suggestedDescription: "Stale.", suggestedCategory: null, uncertainFields: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale title")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});
