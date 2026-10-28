// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { ChatComposer } from "./ChatComposer";

afterEach(cleanup);

describe("ChatComposer", () => {
  it("sends trimmed text on submit and keeps IME-friendly labelling", () => {
    const onSend = vi.fn();
    const onChange = vi.fn();
    render(
      <ChatComposer
        value="  hello  "
        onChange={onChange}
        onSend={onSend}
        inputLabel="Ask the Help & FAQ"
      />,
    );
    const input = screen.getByLabelText("Ask the Help & FAQ");
    expect(input).toBeTruthy();
    // M2: budget replaces truncation — the composer carries no character cap.
    expect(input.getAttribute("maxlength")).toBeNull();
    fireEvent.submit(screen.getByTestId("chat-composer"));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("disables send while busy and offers stop instead", () => {
    const onStop = vi.fn();
    render(
      <ChatComposer value="hello" onChange={vi.fn()} onSend={vi.fn()} busy onStop={onStop} />,
    );
    expect(screen.getByTestId("chat-stop")).toBeTruthy();
    expect(screen.queryByTestId("chat-send")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("renders up to ten image selection previews with remove actions", () => {
    const onRemove = vi.fn();
    const selections = Array.from({ length: 10 }, (_, i) => ({
      id: `img-${i}`,
      name: `photo ${i + 1}`,
      previewUrl: `blob:preview-${i}`,
      disclosure: null as string | null,
    }));
    render(
      <ChatComposer
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
        selections={selections}
        onRemoveSelection={onRemove}
      />,
    );
    const group = screen.getByTestId("chat-selections");
    expect(group.querySelectorAll("img").length).toBe(10);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 3" }));
    expect(onRemove).toHaveBeenCalledWith("img-2");
  });

  it("shows the capacity notice instead of silently dropping selections", () => {
    render(
      <ChatComposer
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
        capacityNotice="This model accepts about 1 image(s) per request, but all 3 selections are kept."
      />,
    );
    expect(screen.getByTestId("chat-capacity-notice").textContent).toContain("all 3 selections are kept");
  });

  it("forwards picked files for intake and keeps 48px targets", () => {
    const onAddFiles = vi.fn();
    const { container } = render(
      <ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} onAddFiles={onAddFiles} />,
    );
    const file = new File(["x"], "photo.png", { type: "image/png" });
    const input = screen.getByTestId("chat-file-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    const minTargets = [...container.querySelectorAll("button")].every((b) =>
      b.className.includes("min-h-[48px]") || b.className.includes("h-12"),
    );
    expect(minTargets).toBe(true);
  });
});

function mockSpeechFacade(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const facade = {
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
    ...overrides,
  };
  return facade;
}

describe("ChatComposer M2", () => {
  it("uses an auto-growing textarea with no character cap", () => {
    render(
      <ChatComposer value={"a".repeat(600)} onChange={vi.fn()} onSend={vi.fn()} />,
    );
    const field = screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement;
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.getAttribute("maxlength")).toBeNull();
    expect(field.className).toMatch(/overflow-y-auto/);
    expect(field.value.length).toBe(600);
  });

  it("enables send for photo-only drafts and keeps it disabled when fully empty", () => {
    const selections = [
      { id: "img-1", name: "photo 1", previewUrl: "blob:1", disclosure: null as string | null },
    ];
    const { rerender } = render(
      <ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} selections={selections} />,
    );
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(false);
    rerender(<ChatComposer value="   " onChange={vi.fn()} onSend={vi.fn()} selections={[]} />);
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("expand and minimize share the same draft and attachments", () => {
    const selections = [
      { id: "img-1", name: "photo 1", previewUrl: "blob:1", disclosure: null as string | null },
    ];
    render(
      <ChatComposer value="draft text" onChange={vi.fn()} onSend={vi.fn()} selections={selections} />,
    );
    fireEvent.click(screen.getByTestId("chat-expand"));
    expect(screen.getByTestId("chat-expand").getAttribute("aria-label")).toBe("Minimize composer");
    expect((screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement).value).toBe(
      "draft text",
    );
    expect(screen.getByTestId("chat-selections")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-expand"));
    expect(screen.getByTestId("chat-expand").getAttribute("aria-label")).toBe("Expand composer");
    expect((screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement).value).toBe(
      "draft text",
    );
  });

  it("dictates via the speech facade: listening state then final result appended", async () => {
    const speech = mockSpeechFacade();
    const onChange = vi.fn();
    render(
      <ChatComposer
        value=""
        onChange={onChange}
        onSend={vi.fn()}
        speech={speech as never}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(await screen.findByTestId("chat-mic-stop")).toBeTruthy();
    expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/listening/i);
    speech.emit("speechResult", { text: "hello world", isFinal: true, route: "on_device" } as never);
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("hello world");
    });
    fireEvent.click(screen.getByTestId("chat-mic-stop"));
    expect(speech.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the speech error message visible after the terminal error state arrives", async () => {
    // The native emits `speechError` and then `speechState("error")`. Treating
    // that state like `finished` cleared the notice one event after it was set,
    // so a denied microphone, a network failure and a recogniser crash all
    // looked identical: the mic just stopped with no explanation.
    const speech = mockSpeechFacade();
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    fireEvent.click(screen.getByTestId("chat-mic"));
    await screen.findByTestId("chat-mic-stop");

    speech.emit("speechError", { code: "network", message: "Speech needs a connection." } as never);
    speech.emit("speechState", { state: "error" } as never);

    // Back to idle, with the reason still on screen.
    await screen.findByTestId("chat-mic");
    expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/needs a connection/i);
  });

  it("cancelling dictation restores the pre-dictation draft", async () => {
    const speech = mockSpeechFacade();
    const onChange = vi.fn();
    render(
      <ChatComposer value="draft" onChange={onChange} onSend={vi.fn()} speech={speech as never} />,
    );
    fireEvent.click(screen.getByTestId("chat-mic"));
    await screen.findByTestId("chat-mic-cancel");
    fireEvent.click(screen.getByTestId("chat-mic-cancel"));
    expect(speech.cancel).toHaveBeenCalledTimes(1);
    // The mic returns to idle once the async cancel settles.
    await screen.findByTestId("chat-mic");
    expect(onChange).toHaveBeenCalledWith("draft");
  });

  it("reports a denied microphone permission without starting", async () => {
    const speech = mockSpeechFacade({
      checkPermission: vi.fn(async () => ({ state: "denied" })),
      requestPermission: vi.fn(async () => ({ state: "denied" })),
    });
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    fireEvent.click(screen.getByTestId("chat-mic"));
    // Denied check surfaces the animated pre-prompt first; continuing
    // triggers the OS request, which is denied again → notice, no start.
    expect(await screen.findByTestId("chat-mic-permission")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-mic-permission-continue"));
    expect(await screen.findByTestId("chat-mic-status")).toBeTruthy();
    await vi.waitFor(() => {
      expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/microphone permission/i);
    });
    expect(speech.start).not.toHaveBeenCalled();
  });

  it("forwards camera captures separately from gallery picks", () => {
    const onAddFiles = vi.fn();
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} onAddFiles={onAddFiles} />);
    const file = new File(["x"], "camera.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("chat-camera-input"), { target: { files: [file] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles).toHaveBeenCalledWith([file]);
  });
});

describe("ChatComposer 360dp two-row layout (screenshot 11)", () => {
  it("keeps the textarea alone in a full-width first row with no icon siblings", () => {
    render(<ChatComposer value="hello" onChange={vi.fn()} onSend={vi.fn()} onAddFiles={vi.fn()} />);
    const field = screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement;
    const row = field.parentElement as HTMLElement;
    // The text field must own its row: intrinsic width competition with 48dp
    // icon buttons is exactly what squeezed it on a 360dp screen.
    expect(row.className).toMatch(/flex/);
    expect([...row.children].filter((child) => child !== field)).toHaveLength(0);
    expect(row.querySelectorAll("button, label, input").length).toBe(0);
    expect(field.className).toMatch(/\bw-full\b/);
    expect(field.className).toMatch(/\bmin-w-0\b/);
    // Every control lives in a separate second row.
    const controls = screen.getByTestId("chat-controls");
    expect(controls).not.toBe(row);
    expect(row.contains(controls)).toBe(false);
    for (const id of ["chat-send", "chat-mic", "chat-expand", "chat-add-photos"]) {
      expect(controls.querySelector(`[data-testid="${id}"]`)).toBeTruthy();
    }
    expect(controls.contains(field)).toBe(false);
  });

  it("opens one accessible Add menu offering Camera and Gallery", async () => {
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} onAddFiles={vi.fn()} />);
    const add = screen.getByTestId("chat-add-photos");
    expect(add.tagName).toBe("BUTTON");
    expect(screen.queryByTestId("chat-add-menu")).toBeNull();
    fireEvent.click(add);
    const menu = screen.getByTestId("chat-add-menu");
    expect(["dialog", "menu", "group"]).toContain(menu.getAttribute("role"));
    expect(menu.getAttribute("aria-label") ?? menu.getAttribute("aria-labelledby")).toBeTruthy();
    const camera = screen.getByTestId("chat-take-photo");
    const gallery = screen.getByTestId("chat-gallery");
    expect(camera.textContent).toMatch(/photo|camera/i);
    expect(gallery.textContent).toMatch(/gallery/i);
    // Shared inputs survive behind the menu so onAddFiles keeps working.
    expect(screen.getByTestId("chat-camera-input")).toBeTruthy();
    expect(screen.getByTestId("chat-file-input")).toBeTruthy();
    fireEvent.click(camera);
    // The menu plays its exit animation before unmounting.
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-add-menu"));
    expect(screen.getByTestId("chat-camera-input")).toBeTruthy();
  });
});

function micState(): string | null {
  return document.querySelector("[data-mic-state]")?.getAttribute("data-mic-state") ?? null;
}

describe("ChatComposer motion (Wave E)", () => {
  it("morphs one control from send into stop instead of swapping buttons", async () => {
    const view = render(<ChatComposer value="hi" onChange={vi.fn()} onSend={vi.fn()} />);
    const control = screen.getByTestId("chat-send");
    expect(control.tagName).toBe("BUTTON");
    expect(screen.getByTestId("chat-send-icon-send")).toBeTruthy();

    view.rerender(
      <ChatComposer value="hi" onChange={vi.fn()} onSend={vi.fn()} busy onStop={vi.fn()} />,
    );
    // Same DOM node throughout: the geometry morphs, the control never remounts.
    expect(screen.getByTestId("chat-stop")).toBe(control);
    expect(control.getAttribute("aria-label")).toBe("Stop generating");
    // The icons crossfade rather than snap.
    expect(await screen.findByTestId("chat-send-icon-stop")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("chat-send-icon-send")).toBeNull());

    view.rerender(<ChatComposer value="hi" onChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByTestId("chat-send")).toBe(control);
    expect(control.getAttribute("aria-label")).toBe("Send");
    expect(await screen.findByTestId("chat-send-icon-send")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("chat-send-icon-stop")).toBeNull());
  });

  it("keeps one composer node and flips aria-expanded across expand/minimize", () => {
    render(<ChatComposer value="draft" onChange={vi.fn()} onSend={vi.fn()} />);
    const form = screen.getByTestId("chat-composer");
    const expand = screen.getByTestId("chat-expand");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("chat-expand-icon-maximize")).toBeTruthy();

    fireEvent.click(expand);
    // Same form node: geometry animates in place rather than re-mounting.
    expect(screen.getByTestId("chat-composer")).toBe(form);
    expect(screen.getByTestId("chat-expand").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("chat-expand").getAttribute("aria-label")).toBe("Minimize composer");
    expect((screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement).value).toBe("draft");

    fireEvent.click(screen.getByTestId("chat-expand"));
    expect(screen.getByTestId("chat-composer")).toBe(form);
    expect(screen.getByTestId("chat-expand").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("chat-expand").getAttribute("aria-label")).toBe("Expand composer");
  });

  it("grows the textarea straight from typing with no transition to wait on", () => {
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} />);
    const field = screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "line one" } });
    // Height is written to the element in the same commit — nothing animates,
    // so the caret can never lag a keystroke.
    expect(field.style.transition).toBe("");
    expect(field.style.animationName).toBe("");
    expect(field.style.height).not.toBe("");
  });

  it("pulses the mic only while the recorder is actually running", async () => {
    const speech = mockSpeechFacade();
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    expect(screen.queryByTestId("chat-mic-pulse")).toBeNull();

    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(await screen.findByTestId("chat-mic-stop")).toBeTruthy();
    expect(micState()).toBe("listening");
    expect(screen.getByTestId("chat-mic-pulse")).toBeTruthy();
    expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/listening/i);

    fireEvent.click(screen.getByTestId("chat-mic-stop"));
    // Recording over: the pulse disappears with the state, no lingering loop.
    expect(screen.queryByTestId("chat-mic-pulse")).toBeNull();
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-mic-status"));
    expect(micState()).toBe("idle");
    expect(screen.getByTestId("chat-mic")).toBeTruthy();
  });

  it("shows Finishing… while teardown is in flight, then settles to idle", async () => {
    let releaseStop!: () => void;
    const speech = mockSpeechFacade({
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStop = resolve;
          }),
      ),
    });
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(await screen.findByTestId("chat-mic-stop")).toBeTruthy();

    fireEvent.click(screen.getByTestId("chat-mic-stop"));
    expect(micState()).toBe("processing");
    expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/finishing/i);
    expect(screen.queryByTestId("chat-mic-pulse")).toBeNull();

    releaseStop();
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-mic-status"));
    expect(micState()).toBe("idle");
    expect(speech.stop).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed start as a status message and returns to idle", async () => {
    const speech = mockSpeechFacade({
      start: vi.fn(async () => {
        throw new Error("recorder busy");
      }),
    });
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    fireEvent.click(screen.getByTestId("chat-mic"));
    await waitFor(() => expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/recorder busy/));
    expect(micState()).toBe("idle");
    expect(screen.getByTestId("chat-mic")).toBeTruthy();
    expect(screen.queryByTestId("chat-mic-pulse")).toBeNull();
  });

  it("ignores a re-tap while dictation is still starting (one start only)", async () => {
    let releaseAvailability!: (value: {
      available: boolean;
      onDevice: string;
      networkOptInRequired: boolean;
      apiLevel: number;
    }) => void;
    const speech = mockSpeechFacade({
      isAvailable: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseAvailability = resolve;
          }),
      ),
    });
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(micState()).toBe("starting");
    expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/starting/i);
    // Interruption: a second tap lands while the first start is still in flight.
    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(speech.isAvailable).toHaveBeenCalledTimes(1);

    releaseAvailability({ available: true, onDevice: "available", networkOptInRequired: false, apiLevel: 33 });
    expect(await screen.findByTestId("chat-mic-stop")).toBeTruthy();
    expect(speech.start).toHaveBeenCalledTimes(1);
    expect(micState()).toBe("listening");
  });

  it("dismisses the animated microphone pre-prompt without touching the OS", async () => {
    const speech = mockSpeechFacade({
      checkPermission: vi.fn(async () => ({ state: "prompt" })),
    });
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} speech={speech as never} />);
    fireEvent.click(screen.getByTestId("chat-mic"));
    const prompt = await screen.findByTestId("chat-mic-permission");
    expect(prompt.textContent).toMatch(/permission dialog opens next/i);

    fireEvent.click(screen.getByTestId("chat-mic-permission-dismiss"));
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-mic-permission"));
    expect(speech.requestPermission).not.toHaveBeenCalled();
    expect(speech.start).not.toHaveBeenCalled();
    expect(micState()).toBe("idle");
  });

  it("explains camera access before the native surface opens", async () => {
    const onAddFiles = vi.fn();
    render(<ChatComposer value="" onChange={vi.fn()} onSend={vi.fn()} onAddFiles={onAddFiles} />);
    fireEvent.click(screen.getByTestId("chat-add-photos"));
    fireEvent.click(screen.getByTestId("chat-take-photo"));
    const prompt = await screen.findByTestId("chat-camera-permission");
    expect(prompt.textContent).toMatch(/camera opens next/i);
    expect(prompt.getAttribute("aria-label")).toBe("Camera access");

    fireEvent.click(screen.getByTestId("chat-camera-permission-dismiss"));
    await waitForElementToBeRemoved(() => screen.queryByTestId("chat-camera-permission"));
    expect(onAddFiles).not.toHaveBeenCalled();
  });
});
