// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AssistantConfigureSheet } from "./AssistantConfigureSheet";

afterEach(cleanup);

function renderSheet(mode: "automatic" | "on-device-only" | "cloud-only" = "automatic") {
  const onSelectMode = vi.fn();
  const onChooseModel = vi.fn();
  render(
    <MemoryRouter>
      <AssistantConfigureSheet
        mode={mode}
        onSelectMode={onSelectMode}
        modelTitle="Free model router"
        onChooseModel={onChooseModel}
      />
    </MemoryRouter>,
  );
  return { onSelectMode, onChooseModel };
}

describe("AssistantConfigureSheet FBX-020", () => {
  it("offers the three answer policies with consumer copy", () => {
    renderSheet();
    expect(screen.getByTestId("assistant-configure")).toBeTruthy();
    expect(screen.getByTestId("configure-mode-automatic").textContent).toContain("Automatic");
    expect(screen.getByTestId("configure-mode-on-device-only").textContent).toContain("On-device only");
    expect(screen.getByTestId("configure-mode-cloud-only").textContent).toContain("Cloud only");
    // Honest transport copy, no internals.
    expect(screen.getByTestId("configure-mode-on-device-only").textContent).toContain(
      "Nothing is sent to a cloud AI provider",
    );
  });

  it("marks the active policy and forwards policy changes", () => {
    const { onSelectMode } = renderSheet("cloud-only");
    expect(screen.getByTestId("configure-mode-cloud-only").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("configure-mode-automatic").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("configure-mode-on-device-only"));
    expect(onSelectMode).toHaveBeenCalledWith("on-device-only");
  });

  it("exposes the conversational model choice and management links", () => {
    const { onChooseModel } = renderSheet();
    expect(screen.getByTestId("configure-choose-model").textContent).toContain("Free model router");
    fireEvent.click(screen.getByTestId("configure-choose-model"));
    expect(onChooseModel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("configure-manage-models").getAttribute("href")).toBe("/settings/ai/models");
    expect(screen.getByTestId("configure-cloud-connections").getAttribute("href")).toBe(
      "/settings/ai/connections",
    );
    expect(screen.getByTestId("configure-advanced").getAttribute("href")).toBe("/settings/ai/advanced");
    expect(screen.getByTestId("configure-privacy-details").getAttribute("href")).toBe("/settings/ai/privacy");
  });

  it("invents no effort or speed controls", () => {
    const { container } = render(
      <MemoryRouter>
        <AssistantConfigureSheet
          mode="automatic"
          onSelectMode={() => {}}
          modelTitle="Automatic"
          onChooseModel={() => {}}
        />
      </MemoryRouter>,
    );
    expect(container.innerHTML).not.toMatch(/effort|speed|temperature|thorough/i);
  });
});
