// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantRecoveryNotice, AssistantSheet } from "./AssistantSheet";
import { resetBackInterceptors } from "./backNavigation";
import { RECOVERY_COPY } from "../services/ai/errors";
import type { AssistantExecutionRuntime } from "../services/assistant/assistantExecution";
import type { AssistantReportHandoff } from "../services/assistant/assistantHandoff";
import {
  GUIDED_RECOVERY_CLASSES,
  type GuidedFlow,
  type GuidedSnapshot,
} from "../services/assistant/guidedAssistantController";

const announceMock = vi.hoisted(() => vi.fn());
vi.mock("./LiveRegion", () => ({ announce: announceMock }));

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
  announceMock.mockClear();
});

function renderSheet(props?: {
  onShortcut?: (flow: GuidedFlow) => void;
  onPhotoChoice?: (choice: string) => void;
  onLocationChoice?: (choice: string) => void;
  onSnapshot?: (snapshot: GuidedSnapshot) => void;
  onReviewReport?: (handoff: AssistantReportHandoff) => void;
  onClose?: () => void;
  runtime?: AssistantExecutionRuntime;
}) {
  const onShortcut = vi.fn();
  const onPhotoChoice = vi.fn();
  const onLocationChoice = vi.fn();
  const onSnapshot = vi.fn();
  const onReviewReport = vi.fn();
  const onClose = vi.fn();
  render(
    <AssistantSheet
      open
      onClose={props?.onClose ?? onClose}
      onShortcut={props?.onShortcut ?? onShortcut}
      onPhotoChoice={props?.onPhotoChoice ?? onPhotoChoice}
      onLocationChoice={props?.onLocationChoice ?? onLocationChoice}
      onSnapshot={props?.onSnapshot ?? onSnapshot}
      onReviewReport={props?.onReviewReport ?? onReviewReport}
      runtime={props?.runtime}
    />,
  );
  return { onShortcut, onPhotoChoice, onLocationChoice, onSnapshot, onReviewReport, onClose };
}

const DATE_QUESTION = "When was the item lost or found? An approximate date is enough.";
const LOCATION_QUESTION =
  "Where was the item lost or found? A nearby landmark or area name is enough.";

function typeAndSend(text: string): void {
  fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("assistant-form"));
}

async function collectToReady() {
  fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
  typeAndSend("Keys");
  await screen.findAllByText(DATE_QUESTION);
  typeAndSend("2026-09-01");
  await screen.findAllByText(LOCATION_QUESTION);
  typeAndSend("Central library");
  await screen.findByTestId("assistant-photo-step");
  fireEvent.click(screen.getByTestId("assistant-photo-none"));
  await screen.findByTestId("assistant-location-step");
  fireEvent.click(screen.getByTestId("assistant-location-skip"));
  await screen.findByTestId("assistant-ready");
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
    await screen.findAllByText(DATE_QUESTION);
    typeAndSend("2026-09-01");
    await screen.findAllByText(LOCATION_QUESTION);
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
    await screen.findAllByText(DATE_QUESTION);
    typeAndSend("2026-09-01");
    await screen.findAllByText(LOCATION_QUESTION);
    typeAndSend("Central library");
    await screen.findByTestId("assistant-photo-step");
    fireEvent.click(screen.getByTestId("assistant-photo-none"));
    await screen.findByTestId("assistant-location-step");
    typeAndSend("North gate bench");
    const ready = await screen.findByTestId("assistant-ready");
    expect(ready.textContent).toContain("North gate bench");
    expect(seams.onLocationChoice).toHaveBeenCalledWith("typed");
  });

  it("emits the frozen handoff through an enabled Review report action", async () => {
    const seen: AssistantReportHandoff[] = [];
    const { onClose } = renderSheet({ onReviewReport: (handoff) => seen.push(handoff) });
    await collectToReady();
    const review = await screen.findByTestId("assistant-review-report");
    expect((review as HTMLButtonElement).disabled).toBe(false);
    expect(review.textContent).toContain("Review report");
    fireEvent.click(review);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.version).toBe(1);
    expect(seen[0]?.source).toBe("assistant");
    expect(seen[0]?.patch.category).toBe("Keys");
    expect(seen[0]?.photoChoice).toBe("none");
    expect(seen[0]?.locationChoice).toBe("skip");
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId("assistant-review-note").textContent).toContain(
      "Nothing is",
    );
  });

  it("keeps a visible user/assistant transcript and never swallows input", async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    typeAndSend("hello");
    const users = await screen.findAllByTestId("assistant-transcript-user");
    expect(users.at(-1)?.textContent).toContain("hello");
    const assistants = await screen.findAllByTestId("assistant-transcript-assistant");
    expect(assistants.at(-1)?.textContent).toContain("Hello!");
    const log = screen.getByTestId("assistant-transcript");
    expect(log.getAttribute("role")).toBe("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(announceMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("assistant-question").textContent).toContain("category");
  });

  it("answers unknown bj with an explicit can't-match in the transcript", async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    typeAndSend("bj");
    const users = await screen.findAllByTestId("assistant-transcript-user");
    expect(users.at(-1)?.textContent).toContain("bj");
    const assistants = await screen.findAllByTestId("assistant-transcript-assistant");
    expect(assistants.at(-1)?.textContent).toContain('couldn\'t match "bj"');
    expect(assistants.at(-1)?.textContent).toContain("Electronics");
    expect(screen.getByTestId("assistant-question").textContent).toContain("category");
  });

  it("maps keychain to Keys from the sheet input", async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("assistant-shortcut-lost"));
    typeAndSend("my keychain");
    await screen.findAllByText(DATE_QUESTION);
    const assistants = await screen.findAllByTestId("assistant-transcript-assistant");
    expect(assistants.at(-1)?.textContent).toContain(DATE_QUESTION);
  });

  it("states the built-in fallback when no model runtime is attached", () => {
    renderSheet();
    expect(screen.getByTestId("assistant-source-note").textContent).toContain(
      "Using built-in help",
    );
  });

  it("states the on-device session when a model runtime is attached", () => {
    renderSheet({
      runtime: { generate: async () => "answer" },
    });
    expect(screen.getByTestId("assistant-source-note").textContent).toContain(
      "Using Qwen locally",
    );
  });

  it("labels the actual on-device model instead of always Qwen (AI-06)", () => {
    renderSheet({
      runtime: { generate: async () => "answer", modelLabel: "LFM2.5 1.2B" },
    });
    const note = screen.getByTestId("assistant-source-note").textContent ?? "";
    expect(note).toContain("LFM2.5 1.2B");
    expect(note).not.toContain("Qwen");
  });

  it("labels the Qwen session from its runtime label", () => {
    renderSheet({
      runtime: { generate: async () => "answer", modelLabel: "Qwen3 0.6B" },
    });
    expect(screen.getByTestId("assistant-source-note").textContent).toContain(
      "Using Qwen3 0.6B locally",
    );
  });

  it("answers app questions and follow-ups through the grounded help path", async () => {
    const runtime: AssistantExecutionRuntime = {
      answerAppQuestion: async (question) => ({ text: `Built-in: ${question}`, source: "fallback" }),
    };
    renderSheet({ runtime });
    fireEvent.click(screen.getByTestId("assistant-shortcut-ask"));
    typeAndSend("How do I search?");
    await screen.findByText("Built-in: How do I search?");
    typeAndSend("What about filters?");
    await screen.findByText("Built-in: What about filters?");
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
