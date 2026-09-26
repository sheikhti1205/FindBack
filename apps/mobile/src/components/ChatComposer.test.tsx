// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(await screen.findByTestId("chat-mic-status")).toBeTruthy();
    expect(screen.getByTestId("chat-mic-status").textContent).toMatch(/microphone permission/i);
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

  it("opens one accessible Add menu offering Camera and Gallery", () => {
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
    expect(screen.queryByTestId("chat-add-menu")).toBeNull();
    expect(screen.getByTestId("chat-camera-input")).toBeTruthy();
  });
});
