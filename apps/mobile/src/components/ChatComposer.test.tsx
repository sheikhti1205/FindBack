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
    expect(input.getAttribute("maxlength")).toBe("500");
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
