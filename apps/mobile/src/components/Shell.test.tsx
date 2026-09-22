// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Shell, assistantSearchNavigationTarget, resolveShellAssistantRuntime, type ShellAssistantSeams } from "./Shell";
import { resetBackInterceptors } from "./backNavigation";
import { QWEN_TEXT_BRIDGE_MODEL_ID, QWEN_TEXT_ENTRY_ID, type GenerateTextRequest, type GenerateTextResult } from "../services/models/textRuntime";
import {
  applySearchFields,
  startFlow,
} from "../services/assistant/guidedAssistantController";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

function renderShell(entry = "/", seams?: ShellAssistantSeams) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Shell seams={seams} />}>
          <Route index element={<p>Home screen</p>} />
          <Route path="/help" element={<p>Help screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function localSeams(overrides: Partial<ShellAssistantSeams> = {}): ShellAssistantSeams {
  return {
    residentEntryId: QWEN_TEXT_ENTRY_ID,
    textRuntimePresent: true,
    textInstalled: true,
    generateText: async (request: GenerateTextRequest): Promise<GenerateTextResult> => ({
      text: `echo:${request.prompt.slice(0, 8)}`,
      modelId: request.modelId,
    }),
    ...overrides,
  };
}

describe("Shell assistant entry point", () => {
  it("shows a floating entry button on tab screens", () => {
    renderShell("/");
    expect(screen.getByTestId("assistant-entry")).toBeTruthy();
    expect(screen.getByText("Home screen")).toBeTruthy();
  });

  it("opens the assistant sheet from the entry button and closes it", () => {
    renderShell("/");
    expect(screen.queryByTestId("assistant-greeting")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-entry"));
    expect(screen.getByTestId("assistant-greeting")).toBeTruthy();
    expect(screen.getByTestId("assistant-shortcut-lost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("assistant-greeting")).toBeNull();
  });

  it("keeps the entry button on screens without bottom navigation", () => {
    renderShell("/help");
    expect(screen.getByTestId("assistant-entry")).toBeTruthy();
  });
});

describe("resolveShellAssistantRuntime", () => {
  it("stays generator-free by default (no bridge method, no resident, no install record)", () => {
    expect(resolveShellAssistantRuntime().generate).toBeUndefined();
  });

  it("resolves the local Qwen runtime only with resident entry, install, and bridge together", async () => {
    const seen: GenerateTextRequest[] = [];
    const runtime = resolveShellAssistantRuntime(
      localSeams({
        generateText: async (request) => {
          seen.push(request);
          return { text: "answer", modelId: request.modelId };
        },
      }),
    );
    expect(runtime.generate).toBeDefined();
    expect(runtime.profile?.id).toBe("qwen3-0.6b-dynamic-int4");
    await expect(
      runtime.generate?.("hi", { maxOutputTokens: 64, temperature: 0 }),
    ).resolves.toBe("answer");
    expect(seen).toEqual([
      {
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        prompt: "hi",
        maxOutputTokens: 64,
        temperature: 0,
      },
    ]);
  });

  it("falls back without install, without the resident entry, or without the bridge", () => {
    expect(resolveShellAssistantRuntime(localSeams({ textInstalled: false })).generate).toBeUndefined();
    expect(
      resolveShellAssistantRuntime(localSeams({ residentEntryId: "smolvlm2-500m-litert-int4" })).generate,
    ).toBeUndefined();
    expect(resolveShellAssistantRuntime(localSeams({ residentEntryId: null })).generate).toBeUndefined();
    expect(resolveShellAssistantRuntime(localSeams({ textRuntimePresent: false })).generate).toBeUndefined();
  });
});

describe("Shell assistant runtime hookup", () => {
  it("states the built-in fallback truthfully when no text model is running", () => {
    renderShell("/");
    fireEvent.click(screen.getByTestId("assistant-entry"));
    expect(screen.getByTestId("assistant-source-note").textContent).toContain(
      "Using built-in help",
    );
  });

  it("states the on-device session truthfully when the Qwen signals hold", () => {
    renderShell("/", localSeams());
    fireEvent.click(screen.getByTestId("assistant-entry"));
    expect(screen.getByTestId("assistant-source-note").textContent).toContain(
      "Using Qwen locally",
    );
  });

  it("answers through the local runtime when the Qwen signals hold", async () => {
    const queue = ['{"intent": "APP_QUESTION"}', "Use the Search tab filters."];
    renderShell(
      "/",
      localSeams({
        generateText: async (request): Promise<GenerateTextResult> => ({
          text: queue.length > 1 ? (queue.shift() as string) : queue[0] as string,
          modelId: request.modelId,
        }),
      }),
    );
    fireEvent.click(screen.getByTestId("assistant-entry"));
    fireEvent.click(screen.getByTestId("assistant-shortcut-ask"));
    fireEvent.change(screen.getByTestId("assistant-input"), {
      target: { value: "How do I search?" },
    });
    fireEvent.submit(screen.getByTestId("assistant-form"));
    const reply = await screen.findByTestId("assistant-reply");
    expect(reply.textContent).toContain("Search tab");
  });
});

describe("assistantSearchNavigationTarget", () => {
  it("maps a ready search snapshot to the ordinary search route", () => {
    const ready = applySearchFields(startFlow("search"), { query: "keys" });
    expect(ready.state).toBe("ready");
    expect(assistantSearchNavigationTarget(ready)).toBe("/search?q=keys");
  });

  it("never navigates for collecting, report-ready, or filterless snapshots", () => {
    expect(assistantSearchNavigationTarget(startFlow("search"))).toBeNull();
    const reportReady = applySearchFields(startFlow("lost"), { query: "keys" });
    expect(assistantSearchNavigationTarget(reportReady)).toBeNull();
  });
});
