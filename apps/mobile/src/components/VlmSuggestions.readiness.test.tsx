// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { discoverMock, suggestMock, noticeMock } = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  suggestMock: vi.fn(),
  noticeMock: vi.fn((): string | null => null),
}));
vi.mock("../services/vlmDiscovery", () => ({
  discoverObjectsLocally: (...args: unknown[]) => discoverMock(...args),
  suggestForPrimaryLocally: (...args: unknown[]) => suggestMock(...args),
}));
vi.mock("../services/vlmPlugin", () => ({
  getVlmBridge: () => ({
    onInferenceState: vi.fn().mockResolvedValue(() => {}),
    cancelInference: vi.fn().mockResolvedValue(undefined),
    getLastBackendNotice: (...args: unknown[]) =>
      (noticeMock as (...a: unknown[]) => string | null)(...args),
  }),
}));

import { VlmSuggestions } from "./VlmSuggestions";

afterEach(cleanup);

describe("VlmSuggestions readiness gate (frozen ImageAnalysisReadiness)", () => {
  it("gates Analyze while NO_MODEL and routes setup to Offline AI", () => {
    render(
      <MemoryRouter>
        <VlmSuggestions
          imageUri="content://photo"
          onApply={vi.fn()}
          readiness={{ available: false, reason: "NO_MODEL" }}
        />
      </MemoryRouter>,
    );
    const analyze = screen.getByRole("button", {
      name: /analyze photo/i,
    }) as HTMLButtonElement;
    expect(analyze.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(
      /no on-device model yet/i,
    );
    expect(
      screen.getByRole("button", { name: /set up in offline ai/i }),
    ).toBeTruthy();
  });

  it("gates Analyze while VERIFY_REQUIRED with a verify CTA", () => {
    render(
      <MemoryRouter>
        <VlmSuggestions
          imageUri="content://photo"
          onApply={vi.fn()}
          readiness={{ available: false, reason: "VERIFY_REQUIRED" }}
        />
      </MemoryRouter>,
    );
    expect(
      (screen.getByRole("button", { name: /analyze photo/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/not verified/i);
    expect(
      screen.getByRole("button", { name: /verify in offline ai/i }),
    ).toBeTruthy();
  });

  it("leaves Analyze enabled when READY and keeps manual fallback visible", () => {
    discoverMock.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <VlmSuggestions
          imageUri="content://photo"
          onApply={vi.fn()}
          readiness={{ available: true, reason: "READY" }}
        />
      </MemoryRouter>,
    );
    expect(
      (screen.getByRole("button", { name: /analyze photo/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
  });

  it("maps a raw GPU failure to friendly copy with an Offline AI action", async () => {
    discoverMock.mockRejectedValue(new Error("GPU_UNAVAILABLE"));
    render(
      <MemoryRouter>
        <VlmSuggestions
          imageUri="content://photo"
          onApply={vi.fn()}
          readiness={{ available: true, reason: "READY" }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /analyze photo/i }));
    const error = await screen.findByText(/isn't available/i);
    expect(error).toBeTruthy();
    expect(screen.queryByText("GPU_UNAVAILABLE")).toBeNull();
    expect(
      screen.getByRole("button", { name: /open offline ai/i }),
    ).toBeTruthy();
  });
});
