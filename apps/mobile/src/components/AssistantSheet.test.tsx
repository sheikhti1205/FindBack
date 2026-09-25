// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantSheet } from "./AssistantSheet";
import { resetBackInterceptors } from "./backNavigation";
import type { GuidedSnapshot } from "../services/assistant/guidedAssistantController";

vi.mock("./LiveRegion", () => ({ announce: vi.fn() }));
afterEach(() => { cleanup(); resetBackInterceptors(); document.body.style.overflow = ""; });

function send(text: string) {
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("assistant-form"));
}

describe("guided cloud assistant", () => {
  it("shows shortcuts without local model controls and labels generated answers", async () => {
    render(<AssistantSheet open onClose={vi.fn()} generate={async () => "Search from the Search tab."} />);
    expect(screen.getByTestId("assistant-source-note").textContent).toContain("free models automatically");
    expect(screen.queryByText(/qwen|download model|gpu/i)).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-shortcut-ask"));
    send("How do I search?");
    expect((await screen.findByTestId("assistant-reply")).textContent).toContain("Search tab");
    expect(screen.getByText("AI-generated")).toBeTruthy();
  });

  it("passes validated search filters to the existing search handoff, never a generated result", async () => {
    const onSnapshot = vi.fn<(snapshot: GuidedSnapshot) => void>();
    render(<AssistantSheet open onClose={vi.fn()} onSnapshot={onSnapshot} generate={async () => '{"query":"keys","status":"LOST"}' } />);
    fireEvent.click(screen.getByTestId("assistant-shortcut-search"));
    send("find lost keys");
    await screen.findByTestId("assistant-ready");
    expect(onSnapshot.mock.lastCall?.[0].searchFilters).toEqual({ query: "keys", status: "LOST" });
  });

  it("drops a cloud reply that resolves after the sheet closed", async () => {
    let resolveGenerate!: (value: string) => void;
    const generate = vi.fn(() => new Promise<string>((resolve) => { resolveGenerate = resolve; }));
    const onClose = vi.fn();
    const view = render(<AssistantSheet open onClose={onClose} generate={generate} />);
    fireEvent.click(screen.getByTestId("assistant-shortcut-ask"));
    send("How do I search?");
    expect(generate).toHaveBeenCalledTimes(1);
    view.rerender(<AssistantSheet open={false} onClose={onClose} generate={generate} />);
    resolveGenerate("Stale answer that must never appear.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.rerender(<AssistantSheet open onClose={onClose} generate={generate} />);
    expect(screen.queryByText("Stale answer that must never appear.")).toBeNull();
  });
});
