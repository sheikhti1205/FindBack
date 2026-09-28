// @vitest-environment jsdom
/**
 * Reduced-motion contract for the composer, isolated in its own file because
 * framer-motion's shared reduced-motion singleton is initialized by whichever
 * render happens first in a test module — this file mocks the OS preference
 * before anything renders, so the preference is observable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { ChatComposer } from "./ChatComposer";

// Installed at module scope — before the first render — because framer-motion's
// reduced-motion singleton is initialized once, by whichever render happens first.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: /prefers-reduced-motion/.test(query),
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia;

afterEach(cleanup);

function mockSpeechFacade() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  return {
    isAvailable: vi.fn(async () => ({
      available: true,
      onDevice: "available",
      networkOptInRequired: false,
      apiLevel: 33,
    })),
    checkPermission: vi.fn(async () => ({ state: "granted" })),
    requestPermission: vi.fn(async () => ({ state: "granted" })),
    start: vi.fn(async () => ({ started: true, route: "on_device", networkAudioDisclosed: false })),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(async (event: string, cb: (payload: never) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return { remove: async () => {} };
    }),
    emit(event: string, payload: never) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

function micState(): string | null {
  return document.querySelector("[data-mic-state]")?.getAttribute("data-mic-state") ?? null;
}

describe("ChatComposer under prefers-reduced-motion", () => {
  it("keeps dictation truthful without a looping pulse", async () => {
    const speech = mockSpeechFacade();
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    // Idle: nothing pulses.
    expect(screen.queryByTestId("chat-mic-pulse")).toBeNull();

    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(await screen.findByTestId("chat-mic-stop")).toBeTruthy();
    expect(micState()).toBe("listening");
    // Recording is still communicated — statically, never as a loop.
    expect(screen.queryByTestId("chat-mic-pulse")).toBeNull();
    expect(screen.getByTestId("chat-mic-recording")).toBeTruthy();
    expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/listening/i);

    fireEvent.click(screen.getByTestId("chat-mic-stop"));
    expect(screen.queryByTestId("chat-mic-recording")).toBeNull();
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-mic-status"));
    expect(micState()).toBe("idle");
  });

  it("still explains microphone permission before the OS dialog", async () => {
    const speech = mockSpeechFacade();
    speech.checkPermission = vi.fn(async () => ({ state: "prompt" }));
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(await screen.findByTestId("chat-mic-permission")).toBeTruthy();

    fireEvent.click(screen.getByTestId("chat-mic-permission-continue"));
    await vi.waitFor(() => expect(micState()).toBe("listening"));
    expect(speech.start).toHaveBeenCalledTimes(1);
  });

  it("swaps send for stop without the crossfade delay mattering", async () => {
    const view = render(<ChatComposer value="hi" onChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByTestId("chat-send-icon-send")).toBeTruthy();
    view.rerender(
      <ChatComposer value="hi" onChange={vi.fn()} onSend={vi.fn()} busy onStop={vi.fn()} />,
    );
    expect(screen.getByTestId("chat-stop")).toBeTruthy();
    expect(await screen.findByTestId("chat-send-icon-stop")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("chat-send-icon-send")).toBeNull());
  });
});
