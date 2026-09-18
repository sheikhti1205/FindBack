// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { analyzeMock, discoverMock, suggestMock, inferenceListener } = vi.hoisted(() => ({
  analyzeMock: vi.fn(),
  discoverMock: vi.fn(),
  suggestMock: vi.fn(),
  inferenceListener: { current: null as null | ((e: { state: string; phase?: string }) => void) },
}));
vi.mock("../services/vlm", () => ({
  analyzeImageLocally: analyzeMock,
  VlmUnstructuredOutputError: class extends Error {},
}));
vi.mock("../services/vlmDiscovery", () => ({
  discoverObjectsLocally: discoverMock,
  suggestForPrimaryLocally: suggestMock,
}));
vi.mock("../services/vlmPlugin", () => ({
  getVlmBridge: () => ({
    onInferenceState: vi.fn().mockImplementation((fn: (e: { state: string; phase?: string }) => void) => {
      inferenceListener.current = fn;
      return Promise.resolve(() => Promise.resolve());
    }),
    cancelInference: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { MemoryRouter } from "react-router";
import { VlmSuggestions } from "./VlmSuggestions";

function renderSuggestions(props: { imageUri: string; onApply: (p: object) => void }) {
  return render(
    <MemoryRouter>
      <VlmSuggestions imageUri={props.imageUri} onApply={props.onApply as never} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

const analysis = {
  objectName: "black umbrella",
  suggestedCategory: "Clothing",
  colors: [],
  visibleBrand: null,
  visibleText: [],
  identifyingFeatures: [],
  suggestedTitle: "Black umbrella",
  suggestedDescription: "A black umbrella.",
  uncertainFields: [],
};

describe("VlmSuggestions multi-object flow", () => {
  it("discovers candidates, enforces one primary, and applies suggestions on Use", async () => {
    discoverMock.mockResolvedValue([
      { objectName: "black umbrella", positionHint: "left" },
      { objectName: "keys", positionHint: "right" },
    ]);
    suggestMock.mockResolvedValue(analysis);
    const onApply = vi.fn();
    renderSuggestions({ imageUri: "content://photo", onApply: onApply });

    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
    await screen.findByText("black umbrella");
    expect(screen.getByText("keys")).toBeTruthy();

    // Exactly one PRIMARY by default (first candidate).
    const groups = screen.getAllByRole("radiogroup");
    expect(groups).toHaveLength(2);
    const checked = (g: HTMLElement) => g.querySelector('[aria-checked="true"]')?.textContent;
    expect(checked(groups[0]!)).toBe("Primary");
    expect(checked(groups[1]!)).toBe("Ignore");

    // Promoting the second demotes the first to IGNORE.
    fireEvent.click(within(groups[1]!).getByRole("radio", { name: "Primary" }));
    expect(checked(groups[1]!)).toBe("Primary");
    expect(checked(groups[0]!)).toBe("Ignore");

    fireEvent.click(screen.getByRole("button", { name: /generate suggestions/i }));
    await screen.findAllByText(/black umbrella/i);
    expect(suggestMock).toHaveBeenCalledWith(
      expect.objectContaining({ primary: "keys", include: [], ignore: ["black umbrella"] }),
    );
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /use title/i }));
    expect(onApply).toHaveBeenCalledWith({ suggestedTitle: "Black umbrella" });
    fireEvent.click(screen.getByRole("button", { name: /use description/i }));
    expect(onApply).toHaveBeenCalledWith({ suggestedDescription: "A black umbrella." });
  });

  it("falls back to manual entry when nothing is discovered", async () => {
    discoverMock.mockResolvedValue([]);
    analyzeMock.mockResolvedValue(analysis);
    renderSuggestions({ imageUri: "content://photo", onApply: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
    await screen.findByText(/fill the details manually/i);
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it("surfaces unstructured output as a manual-entry fallback", async () => {
    discoverMock.mockRejectedValue(
      Object.assign(new Error("UNSTRUCTURED_OUTPUT"), { name: "VlmUnstructuredOutputError" }),
    );
    renderSuggestions({ imageUri: "content://photo", onApply: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
    await waitFor(() => expect(screen.getByText(/could not read the photo/i)).toBeTruthy());
  });

  it("invalidates unapplied AI state when the photo changes", async () => {
    discoverMock.mockResolvedValue([{ objectName: "keys", positionHint: "left" }]);
    const { rerender } = renderSuggestions({ imageUri: "content://a", onApply: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
    await screen.findByText("keys");
    rerender(
      <MemoryRouter>
        <VlmSuggestions imageUri="content://b" onApply={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("keys")).toBeNull();
    expect(screen.getByRole("button", { name: /analyze photo/i })).toBeTruthy();
  });

  it("treats a phase-bearing inference event as active and the terminal event as idle", async () => {
    renderSuggestions({ imageUri: "content://photo", onApply: vi.fn() });
    const analyzeButton = screen.getByRole("button", { name: /analyze photo/i }) as HTMLButtonElement;
    expect(analyzeButton.disabled).toBe(false);
    await waitFor(() => expect(inferenceListener.current).not.toBeNull());

    // Normal inference in progress: native emits phases, not fake progress.
    inferenceListener.current!({ state: "READY_GPU", phase: "RUNNING" });
    await waitFor(() => expect((screen.getByRole("button", { name: /analyze photo/i }) as HTMLButtonElement).disabled).toBe(true));

    // Terminal event carries no phase: back to idle.
    inferenceListener.current!({ state: "READY_GPU" });
    await waitFor(() => expect((screen.getByRole("button", { name: /analyze photo/i }) as HTMLButtonElement).disabled).toBe(false));
  });
});
