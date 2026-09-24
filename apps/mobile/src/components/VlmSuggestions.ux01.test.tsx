// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { inferenceListener } = vi.hoisted(() => ({
  inferenceListener: {
    current: null as null | ((e: {
      state: string;
      phase?: string;
      modelId?: string;
      error?: string;
      progress?: number;
    }) => void),
  },
}));
vi.mock("../services/vlmDiscovery", () => ({
  discoverObjectsLocally: vi.fn(),
  suggestForPrimaryLocally: vi.fn(),
}));
vi.mock("../services/vlmPlugin", () => ({
  getVlmBridge: () => ({
    onInferenceState: vi.fn().mockImplementation(
      (
        fn: (e: {
          state: string;
          phase?: string;
          modelId?: string;
          error?: string;
          progress?: number;
        }) => void,
      ) => {
        inferenceListener.current = fn;
        return Promise.resolve(() => {});
      },
    ),
    cancelInference: vi.fn().mockResolvedValue(undefined),
    getLastBackendNotice: vi.fn((): string | null => null),
  }),
}));

import { MemoryRouter } from "react-router";
import { VlmSuggestions } from "./VlmSuggestions";

function renderSuggestions(imageUri = "content://photo") {
  return render(
    <MemoryRouter>
      <VlmSuggestions imageUri={imageUri} onApply={vi.fn()} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  inferenceListener.current = null;
});

async function waitForListener() {
  await waitFor(() => expect(inferenceListener.current).not.toBeNull());
}

describe("VlmSuggestions UX-01 inference phase UX", () => {
  it("shows real phase text for each native phase with no fake percentages", async () => {
    renderSuggestions();
    await waitForListener();

    const phases: Array<[string, RegExp]> = [
      ["LOADING_MODEL", /loading model/i],
      ["PREPARING_IMAGE", /preparing (photo|image)/i],
      ["RUNNING", /analyz/i],
      ["POSTPROCESSING", /finish/i],
    ];
    for (const [phase, text] of phases) {
      inferenceListener.current!({ state: "READY_GPU", phase });
      const status = await screen.findByRole("status", { name: /inference status/i });
      expect(status.textContent).toMatch(text);
      // Never invent percentages or seconds remaining.
      expect(status.textContent).not.toMatch(/%/);
      expect(status.textContent).not.toMatch(/second/i);
      expect(status.textContent).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
    }
  });

  it("shows model identity only when native provides it", async () => {
    renderSuggestions();
    await waitForListener();

    inferenceListener.current!({
      state: "READY_GPU",
      phase: "RUNNING",
      modelId: "smolvlm2-500m",
    });
    let status = await screen.findByRole("status", { name: /inference status/i });
    expect(status.textContent).toMatch(/smolvlm2-500m/);

    // Terminal then a phase without modelId: no identity text.
    inferenceListener.current!({ state: "READY_GPU" });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: /inference status/i })).toBeNull(),
    );
    inferenceListener.current!({ state: "READY_GPU", phase: "RUNNING" });
    status = await screen.findByRole("status", { name: /inference status/i });
    expect(status.textContent).not.toMatch(/smolvlm2-500m/);
    expect(status.textContent).not.toMatch(/undefined|null/);
  });

  it("ends status cleanly on terminal events with no lingering spinner", async () => {
    renderSuggestions();
    await waitForListener();
    const analyze = screen.getByRole("button", {
      name: /analyze photo/i,
    }) as HTMLButtonElement;

    inferenceListener.current!({ state: "READY_GPU", phase: "RUNNING" });
    await screen.findByRole("status", { name: /inference status/i });
    await waitFor(() => expect(analyze.disabled).toBe(true));

    // Terminal event carries no phase: status ends, Analyze re-enabled.
    inferenceListener.current!({ state: "READY_GPU" });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: /inference status/i })).toBeNull(),
    );
    await waitFor(() => expect(analyze.disabled).toBe(false));
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it("surfaces a native terminal error without a spinner", async () => {
    renderSuggestions();
    await waitForListener();

    inferenceListener.current!({ state: "READY_GPU", phase: "RUNNING" });
    await screen.findByRole("status", { name: /inference status/i });

    inferenceListener.current!({
      state: "RUNTIME_ERROR",
      error: "RUNTIME_ERROR",
    });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: /inference status/i })).toBeNull(),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/runtime error/i);
    expect(alert.textContent).not.toContain("RUNTIME_ERROR");
    expect(document.body.textContent).not.toMatch(/%/);
    const analyze = screen.getByRole("button", {
      name: /analyze photo/i,
    }) as HTMLButtonElement;
    await waitFor(() => expect(analyze.disabled).toBe(false));
  });

  it("ignores stale phase events after the photo changes until terminal", async () => {
    const { rerender } = renderSuggestions("content://a");
    await waitForListener();

    inferenceListener.current!({ state: "READY_GPU", phase: "RUNNING" });
    await screen.findByRole("status", { name: /inference status/i });

    rerender(
      <MemoryRouter>
        <VlmSuggestions imageUri="content://b" onApply={vi.fn()} />
      </MemoryRouter>,
    );
    // Photo change ends local status immediately (no infinite spinner).
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: /inference status/i })).toBeNull(),
    );

    // Stale phase from the cancelled old-photo job must not resurrect status.
    inferenceListener.current!({ state: "READY_GPU", phase: "RUNNING" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("status", { name: /inference status/i })).toBeNull();

    // Terminal event for the old job releases the gate without error.
    inferenceListener.current!({ state: "READY_GPU" });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /analyze photo/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves accessibility semantics for status and error", async () => {
    renderSuggestions();
    await waitForListener();

    inferenceListener.current!({ state: "READY_GPU", phase: "RUNNING" });
    const status = await screen.findByRole("status", { name: /inference status/i });
    expect(status.getAttribute("role")).toBe("status");

    inferenceListener.current!({
      state: "RUNTIME_ERROR",
      error: "RUNTIME_ERROR",
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toBeTruthy();
    // Existing controls keep their semantics.
    expect(
      screen.getByRole("button", { name: /analyze photo/i }),
    ).toBeTruthy();
  });
});
