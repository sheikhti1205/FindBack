// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

const analyze = vi.hoisted(() => vi.fn());
vi.mock("../services/analyzeReportPhoto", () => ({ analyzeReportPhoto: analyze }));
import { VlmSuggestions } from "./VlmSuggestions";

afterEach(cleanup);

describe("VlmSuggestions — Draft description from photo", () => {
  const makeFile = (name: string, type: string, size = 1000) =>
    new File([new Uint8Array(size)], name, { type });

  beforeEach(() => {
    analyze.mockReset();
  });

  function expandPanel() {
    // Click the expand button if collapsed, otherwise do nothing
    const expandButton = screen.queryByRole("button", { name: /Expand photo suggestions/i });
    if (expandButton) {
      fireEvent.click(expandButton);
    }
  }

  it("renders collapsed by default with section title and subtitle", () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={vi.fn()} /></MemoryRouter>);

    expect(screen.getByText("Draft description from photo")).toBeTruthy();
    expect(screen.getByText("Use one of your photos to suggest a title, description and category.")).toBeTruthy();
    // Should be collapsed - no consent checkbox or button visible initially
    expect(screen.queryByLabelText(/Send this selected photo to OpenRouter/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Suggest title & description" })).toBeNull();
  });

  it("shows compact disabled callout when no usable photo", () => {
    const file = makeFile("photo.gif", "image/gif"); // unsupported
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={vi.fn()} /></MemoryRouter>);

    expandPanel();
    expect(screen.getByText("Add a photo to draft text")).toBeTruthy();
    expect(screen.queryByLabelText(/Send this selected photo to OpenRouter/)).toBeNull();
  });

  it("expands on click showing consent checkbox unchecked by default", () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={vi.fn()} /></MemoryRouter>);

    expandPanel();
    const checkbox = screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it.") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Suggest title & description" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("consent checkbox must be checked before request fires", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "Blue wallet",
      suggestedDescription: "A blue wallet.",
      suggestedCategory: "Bags & Wallets",
      uncertainFields: [],
    });
    const file = makeFile("wallet.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    expect(analyze).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    expect(analyze).not.toHaveBeenCalled(); // consent not checked

    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith(file, true, expect.any(Object)));
  });

  it("consent resets to unchecked when photo changes", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "First",
      suggestedDescription: "First desc",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    const first = makeFile("first.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    const { rerender } = render(<MemoryRouter><VlmSuggestions file={first} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));

    // Change photo
    const second = makeFile("second.jpg", "image/jpeg");
    rerender(<MemoryRouter><VlmSuggestions file={second} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    // Consent should be unchecked again - need to expand again after rerender
    expandPanel();
    const checkbox = screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it.") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Suggest title & description" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("loading shows 'Analyzing photo…' with Stop control", async () => {
    let resolveAnalyze: (value: unknown) => void;
    analyze.mockImplementationOnce(() => new Promise((resolve) => { resolveAnalyze = resolve; }));
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));

    await waitFor(() => expect(screen.getByText("Analyzing photo…")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    // Button name changes to "Analyzing photo…" when loading
    expect((screen.getByRole("button", { name: "Analyzing photo…" }) as HTMLButtonElement).disabled).toBe(true);

    resolveAnalyze!({
      suggestedTitle: "Done",
      suggestedDescription: "Done desc",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    await waitFor(() => expect(screen.queryByText("Analyzing photo…")).toBeNull());
  });

  it("success shows comparison cards with per-field Apply/Keep", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "AI Title",
      suggestedDescription: "AI Description",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Your title")).toBeTruthy());

    expect(screen.getByText("Suggested title")).toBeTruthy();
    expect((screen.getByLabelText("Suggested title") as HTMLInputElement).value).toBe("AI Title");
    expect(screen.getByText("Your description")).toBeTruthy();
    expect(screen.getByText("Suggested description")).toBeTruthy();
    expect(screen.getByText("Your category")).toBeTruthy();
    expect((screen.getByLabelText("Suggested category") as HTMLInputElement).value).toBe("Electronics");

    // Per-field Apply/Keep buttons
    expect(screen.getByRole("button", { name: "Apply title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply description" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep description" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply category" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep category" })).toBeTruthy();
  });

  it("keeps the suggestion visible when the parent declines the replacement", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "AI Title",
      suggestedDescription: "AI Description",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    // The parent shows a confirm dialog and the user declines: onApply
    // returns false, so the suggestion must stay instead of resolving away.
    const apply = vi.fn(() => false);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="Kept title" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Your title")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect(apply).toHaveBeenCalledWith({ suggestedTitle: "AI Title" });
    // Declined: the suggested title is still on screen for a later decision.
    expect(screen.getByRole("button", { name: "Apply title" })).toBeTruthy();
    expect((screen.getByLabelText("Suggested title") as HTMLInputElement).value).toBe("AI Title");
  });

  it("compares AI fields with the live report values, including edits made after analysis", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "AI Title",
      suggestedDescription: "AI Description",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    const { rerender } = render(
      <MemoryRouter><VlmSuggestions file={file} currentTitle="Saved title" currentDescription="Saved description" currentCategory="Bags & Wallets" onApply={apply} /></MemoryRouter>,
    );
    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Review suggestions from AI:")).toBeTruthy());

    expect(screen.getByText("Saved title")).toBeTruthy();
    expect(screen.getByText("Saved description")).toBeTruthy();
    expect(screen.getByText("Bags & Wallets")).toBeTruthy();
    rerender(
      <MemoryRouter><VlmSuggestions file={file} currentTitle="Typed title" currentDescription="Typed description" currentCategory="Clothing" onApply={apply} /></MemoryRouter>,
    );
    expect(screen.getByText("Typed title")).toBeTruthy();
    expect(screen.getByText("Typed description")).toBeTruthy();
    expect(screen.getByText("Clothing")).toBeTruthy();
    expect(screen.queryByText("Saved title")).toBeNull();
    expect((screen.getByLabelText("Suggested title") as HTMLInputElement).value).toBe("AI Title");
    fireEvent.click(screen.getByRole("button", { name: "Keep title" }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("applying title only changes title and keeps the other fields reviewable", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "AI Title",
      suggestedDescription: "AI Description",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Your title")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ suggestedTitle: "AI Title" }));
    // The description and category reviews must survive a title-only apply.
    expect(screen.getByRole("button", { name: "Apply description" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply category" })).toBeTruthy();
    expect(apply).not.toHaveBeenCalledWith(expect.objectContaining({ suggestedDescription: expect.any(String) }));
  });

  it("Keep calls nothing so the existing field stays byte-identical", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "AI Title",
      suggestedDescription: "AI Description",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Your description")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Keep description" }));
    // Keep must never notify the form — a null patch would blank the field.
    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Keep description" })).toBeNull();
    expect(screen.getByRole("button", { name: "Apply title" })).toBeTruthy();
  });

  it("failure shows exact copy and keeps fields/photos intact", async () => {
    analyze.mockRejectedValueOnce(new Error("OpenRouter took too long to respond. Please try again."));
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Couldn't draft text from this photo. You can retry or continue writing manually.")).toBeTruthy());

    expect(apply).not.toHaveBeenCalled();
    // Photo and fields should remain - no publish block
    expect(screen.getByText("Draft description from photo")).toBeTruthy();
  });

  it("missing credential shows honest connect/manual message, never fabricates text", async () => {
    // Real OpenRouterError carries a machine code; match that shape.
    analyze.mockRejectedValueOnce(
      Object.assign(new Error("Connect your OpenRouter API key to use AI."), { code: "MISSING_KEY" }),
    );
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Connect your OpenRouter API key to use AI.")).toBeTruthy());

    expect(screen.queryByText(/AI Title|AI Description/)).toBeNull();
  });

  it("timeout classification - bounded timeout, no indefinite spinner", async () => {
    analyze.mockRejectedValueOnce(new Error("OpenRouter took too long to respond. Please try again."));
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));

    await waitFor(() => expect(screen.getByText("Analyzing photo…")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Couldn't draft text from this photo. You can retry or continue writing manually.")).toBeTruthy());
    expect(screen.queryByText("Analyzing photo…")).toBeNull();
  });

  it("shows the service's unreleased-category notice while keeping usable text", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "Test",
      suggestedDescription: "Test desc",
      suggestedCategory: null,
      categoryUnavailable: true,
      uncertainFields: [],
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Your title")).toBeTruthy());

    // The unreleased category is surfaced as a notice, never as an applied value.
    expect(screen.getByText(/isn't available yet/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply category" })).toBeNull();
    expect(screen.getByRole("button", { name: "Apply title" })).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });

  it("stale response after photo change ignored", async () => {
    let resolveFirst: (value: unknown) => void;
    analyze.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const first = makeFile("first.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    const { rerender } = render(<MemoryRouter><VlmSuggestions file={first} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));

    const second = makeFile("second.jpg", "image/jpeg");
    rerender(<MemoryRouter><VlmSuggestions file={second} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    resolveFirst!({
      suggestedTitle: "Stale title",
      suggestedDescription: "Stale desc",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("Stale title")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("user can edit suggestion before applying", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "AI Title",
      suggestedDescription: "AI Description",
      suggestedCategory: "Electronics",
      uncertainFields: [],
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const apply = vi.fn(() => true);
    render(<MemoryRouter><VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={apply} /></MemoryRouter>);

    expandPanel();
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));
    await waitFor(() => expect(screen.getByText("Your title")).toBeTruthy());

    // Edit the suggested title input
    const titleInput = screen.getByLabelText("Suggested title");
    fireEvent.change(titleInput, { target: { value: "Edited Title" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ suggestedTitle: "Edited Title" }));
  });
});

describe("VlmSuggestions motion (Wave E)", () => {
  const makeFile = (name: string, type: string, size = 1000) =>
    new File([new Uint8Array(size)], name, { type });

  beforeEach(() => {
    analyze.mockReset();
  });

  it("collapses the expanded panel with an accordion exit", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    render(
      <MemoryRouter>
        <VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Expand photo suggestions/i }));
    expect(screen.getByRole("button", { name: /Collapse photo suggestions/i }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText(/Send this selected photo to OpenRouter/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Collapse photo suggestions/i }));
    expect(screen.getByRole("button", { name: /Expand photo suggestions/i }).getAttribute("aria-expanded")).toBe("false");
    // The panel plays its exit instead of vanishing in the same frame.
    await waitForElementToBeRemoved(() =>
      screen.queryByLabelText(/Send this selected photo to OpenRouter/),
    );
  });

  it("lets the drafted suggestion rise into the panel", async () => {
    analyze.mockResolvedValueOnce({
      suggestedTitle: "Blue wallet",
      suggestedDescription: "A blue wallet.",
      suggestedCategory: "Bags & Wallets",
      uncertainFields: [],
    });
    const file = makeFile("wallet.jpg", "image/jpeg");
    render(
      <MemoryRouter>
        <VlmSuggestions file={file} currentTitle="" currentDescription="" currentCategory="" onApply={vi.fn(() => true)} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Expand photo suggestions/i }));
    fireEvent.click(screen.getByLabelText("Send this selected photo to OpenRouter to suggest report text. Nothing is published or applied until I review it."));
    fireEvent.click(screen.getByRole("button", { name: "Suggest title & description" }));

    const region = await screen.findByRole("region", { name: "Review AI suggestions" });
    // Enters hidden, then settles — no instant pop-in over the form.
    expect(region.style.opacity).toBe("0");
    await waitFor(() => expect(region.style.opacity).toBe("1"), { timeout: 2000 });
    // The drafted title lands in the editable field inside the risen region.
    expect((screen.getByLabelText("Suggested title") as HTMLInputElement).value).toBe("Blue wallet");
  });
});
