// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { analyzeMock } = vi.hoisted(() => ({ analyzeMock: vi.fn() }));
vi.mock("../services/vlm", () => ({
  analyzeImageLocally: analyzeMock,
  VlmUnstructuredOutputError: class extends Error {},
}));
vi.mock("../services/vlmPlugin", () => ({
  getVlmBridge: () => ({ onInferenceState: vi.fn().mockResolvedValue(() => Promise.resolve()) }),
}));

import { VlmSuggestions } from "./VlmSuggestions";

afterEach(cleanup);

describe("VlmSuggestions", () => {
  it("shows suggestions but only applies them when the user taps Apply", async () => {
    analyzeMock.mockResolvedValue({
      objectName: "black umbrella",
      suggestedCategory: "Clothing",
      colors: [],
      visibleBrand: null,
      visibleText: [],
      identifyingFeatures: [],
      suggestedTitle: "Black umbrella",
      suggestedDescription: "A black umbrella.",
      uncertainFields: [],
    });
    const onApply = vi.fn();
    render(<VlmSuggestions imageUri="content://photo" onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
    await screen.findAllByText(/black umbrella/i);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /apply title/i }));
    expect(onApply).toHaveBeenCalledWith({ suggestedTitle: "Black umbrella" });
    fireEvent.click(screen.getByRole("button", { name: /apply description/i }));
    expect(onApply).toHaveBeenCalledWith({ suggestedDescription: "A black umbrella." });
  });

  it("surfaces unstructured output as a manual-entry fallback", async () => {
    analyzeMock.mockRejectedValue(Object.assign(new Error("UNSTRUCTURED_OUTPUT"), { name: "VlmUnstructuredOutputError" }));
    render(<VlmSuggestions imageUri="content://photo" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
    await waitFor(() => expect(screen.getByText(/could not read the photo/i)).toBeTruthy());
  });
});