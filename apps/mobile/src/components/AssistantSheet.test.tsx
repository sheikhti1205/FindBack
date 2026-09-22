// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantRecoveryNotice, AssistantSheet } from "./AssistantSheet";
import { resetBackInterceptors } from "./backNavigation";
import { RECOVERY_COPY } from "../services/ai/errors";
import type { AssistantExecutionRuntime } from "../services/assistant/assistantExecution";
import {
  GUIDED_RECOVERY_CLASSES,
  type GuidedFlow,
  type GuidedSnapshot,
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
  onSnapshot?: (snapshot: GuidedSnapshot) => void;
  runtime?: AssistantExecutionRuntime;
}) {
  const onShortcut = vi.fn();
  const onPhotoChoice = vi.fn();
  const onLocationChoice = vi.fn();
  const onSnapshot = vi.fn();
  render(
    <AssistantSheet
      open
      onClose={vi.fn()}
      onShortcut={props?.onShortcut ?? onShortcut}
      onPhotoChoice={props?.onPhotoChoice ?? onPhotoChoice}
      onLocationChoice={props?.onLocationChoice ?? onLocationChoice}
      onSnapshot={props?.onSnapshot ?? onSnapshot}
      runtime={props?.runtime}
    />,
  );
  return { onShortcut, onPhotoChoice, onLocationChoice, onSnapshot };
}

const DATE_QUESTION = "When was the item lost or found? An approximate date is enough.";
const LOCATION_QUESTION =
  "Where was the item lost or found? A nearby landmark or area name is enough.";

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

  it("routes free text through intent routing into held search", async () => {
    const seen: GuidedSnapshot[] = [];
    const { onShortcut } = renderSheet({ onSnapshot: (snapshot) => seen.push(snapshot) });
    typeAndSend("black umbrella");
    const ready = await screen.findByTestId("assistant-ready");
    expect(ready.textContent).toContain("black umbrella");
    expect(onShortcut).not.toHaveBeenCalled();
    expect(seen.at(-1)?.flow).toBe("search");
    expect(seen.at(-1)?.searchFilters?.query).toBe("black umbrella");
  });

  it("drives report collection through the photo and location seams", async () => {
    const seams = renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    typeAndSend("Keys");
    await screen.findByText(DATE_QUESTION);
    typeAndSend("2026-09-01");
    await screen.findByText(LOCATION_QUESTION);
    typeAndSend("Central library");
    await screen.findByTestId("assistant-photo-step");
    fireEvent.click(screen.getByTestId("assistant-photo-take"));
    expect(seams.onPhotoChoice).toHaveBeenCalledWith("take");
    await screen.findByTestId("assistant-location-step");
    fireEvent.click(screen.getByTestId("assistant-location-skip"));
    expect(seams.onLocationChoice).toHaveBeenCalledWith("skip");
    const ready = await screen.findByTestId("assistant-ready");
    expect(ready.textContent).toContain("Keys");
    expect(ready.textContent).toContain("Central library");
  });

  it("accepts a typed place through the input on the location step", async () => {
    const seams = renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-found"));
    typeAndSend("Keys");
    await screen.findByText(DATE_QUESTION);
    typeAndSend("2026-09-01");
    await screen.findByText(LOCATION_QUESTION);
    typeAndSend("Central library");
    await screen.findByTestId("assistant-photo-step");
    fireEvent.click(screen.getByTestId("assistant-photo-none"));
    await screen.findByTestId("assistant-location-step");
    typeAndSend("North gate bench");
    const ready = await screen.findByTestId("assistant-ready");
    expect(ready.textContent).toContain("North gate bench");
    expect(seams.onLocationChoice).toHaveBeenCalledWith("typed");
  });

  it("holds the report review action instead of applying it", async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    typeAndSend("Keys");
    await screen.findByText(DATE_QUESTION);
    typeAndSend("2026-09-01");
    await screen.findByText(LOCATION_QUESTION);
    typeAndSend("Central library");
    await screen.findByTestId("assistant-photo-step");
    fireEvent.click(screen.getByTestId("assistant-photo-none"));
    await screen.findByTestId("assistant-location-step");
    fireEvent.click(screen.getByTestId("assistant-location-skip"));
    const review = await screen.findByTestId("assistant-review-held");
    expect((review as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("assistant-review-held-note").textContent).toContain(
      "never filled in automatically",
    );
  });

  it("answers app questions and follow-ups through the grounded help path", async () => {
    const runtime: AssistantExecutionRuntime = {
      answerAppQuestion: async (question) => ({ text: `Built-in: ${question}`, source: "fallback" }),
    };
    renderSheet({ runtime });
    fireEvent.click(screen.getByTestId("assistant-shortcut-ask"));
    typeAndSend("How do I search?");
    const first = await screen.findByTestId("assistant-reply");
    expect(first.textContent).toBe("Built-in: How do I search?");
    typeAndSend("What about filters?");
    const second = await screen.findByTestId("assistant-reply");
    expect(second.textContent).toBe("Built-in: What about filters?");
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
