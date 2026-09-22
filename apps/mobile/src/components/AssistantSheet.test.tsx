// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantRecoveryNotice, AssistantSheet } from "./AssistantSheet";
import { resetBackInterceptors } from "./backNavigation";
import { RECOVERY_COPY } from "../services/ai/errors";
import {
  GUIDED_RECOVERY_CLASSES,
  type GuidedFlow,
} from "../services/assistant/guidedAssistantController";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

function renderSheet(props?: {
  onShortcut?: (flow: GuidedFlow) => void;
  onPhotoChoice?: (choice: string) => void;
  onLocationChoice?: (choice: string) => void;
}) {
  const onShortcut = vi.fn();
  const onPhotoChoice = vi.fn();
  const onLocationChoice = vi.fn();
  render(
    <AssistantSheet
      open
      onClose={vi.fn()}
      onShortcut={props?.onShortcut ?? onShortcut}
      onPhotoChoice={props?.onPhotoChoice ?? onPhotoChoice}
      onLocationChoice={props?.onLocationChoice ?? onLocationChoice}
    />,
  );
  return { onShortcut, onPhotoChoice, onLocationChoice };
}

function typeAndSend(text: string): void {
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("assistant-form"));
}

describe("AssistantSheet", () => {
  it("renders the greeting, four shortcuts, and free-text input", () => {
    renderSheet();
    expect(screen.getByTestId("assistant-greeting")).toBeTruthy();
    expect(screen.getByTestId("assistant-shortcut-lost")).toBeTruthy();
    expect(screen.getByTestId("assistant-shortcut-found")).toBeTruthy();
    expect(screen.getByTestId("assistant-shortcut-search")).toBeTruthy();
    expect(screen.getByTestId("assistant-shortcut-ask")).toBeTruthy();
    expect(screen.getByTestId("assistant-input")).toBeTruthy();
  });

  it("starts the lost flow from its shortcut", () => {
    const onShortcut = vi.fn();
    renderSheet({ onShortcut });
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    expect(onShortcut).toHaveBeenCalledWith("lost");
    expect(screen.getByTestId("assistant-question").textContent).toContain("category");
  });

  it("routes free text with no flow into an ask search", () => {
    const onShortcut = vi.fn();
    renderSheet({ onShortcut });
    typeAndSend("black umbrella");
    expect(onShortcut).toHaveBeenCalledWith("ask");
    expect(screen.getByTestId("assistant-ready").textContent).toContain("black umbrella");
  });

  it("drives report collection through the photo and location seams", () => {
    const seams = renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    typeAndSend("Keys");
    typeAndSend("2026-09-01");
    typeAndSend("Central library");
    expect(screen.getByTestId("assistant-photo-step")).toBeTruthy();
    fireEvent.click(screen.getByTestId("assistant-photo-take"));
    expect(seams.onPhotoChoice).toHaveBeenCalledWith("take");
    expect(screen.getByTestId("assistant-location-step")).toBeTruthy();
    fireEvent.click(screen.getByTestId("assistant-location-skip"));
    expect(seams.onLocationChoice).toHaveBeenCalledWith("skip");
    const ready = screen.getByTestId("assistant-ready").textContent ?? "";
    expect(ready).toContain("Keys");
    expect(ready).toContain("Central library");
  });

  it("accepts a typed place through the input on the location step", () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-found"));
    typeAndSend("Keys");
    typeAndSend("2026-09-01");
    typeAndSend("Central library");
    fireEvent.click(screen.getByTestId("assistant-photo-none"));
    typeAndSend("North gate bench");
    expect(screen.getByTestId("assistant-ready").textContent).toContain("North gate bench");
  });
});

describe("AssistantRecoveryNotice", () => {
  it.each(GUIDED_RECOVERY_CLASSES)("shows frozen recovery copy for %s", (errorClass) => {
    const onAction = vi.fn();
    render(<AssistantRecoveryNotice errorClass={errorClass} onAction={onAction} />);
    expect(screen.getByTestId("assistant-recovery-message").textContent).toBe(
      RECOVERY_COPY[errorClass].message,
    );
    for (const action of RECOVERY_COPY[errorClass].actions) {
      fireEvent.click(screen.getByTestId(`assistant-recovery-action-${action}`));
      expect(onAction).toHaveBeenCalledWith(action);
    }
    expect(onAction).toHaveBeenCalledTimes(RECOVERY_COPY[errorClass].actions.length);
  });
});
