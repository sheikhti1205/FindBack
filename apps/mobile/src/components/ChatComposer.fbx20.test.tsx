// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatComposer } from "./ChatComposer";

afterEach(cleanup);

function baseProps(overrides = {}) {
  return {
    value: "",
    onChange: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  };
}

describe("ChatComposer FBX-020 (model chip + attach menu)", () => {
  it("renders the model chip with the consumer model name and opens the picker", () => {
    const onOpenModels = vi.fn();
    render(<ChatComposer {...baseProps()} modelTitle="Free model router" onOpenModels={onOpenModels} />);
    const chip = screen.getByTestId("composer-model-chip");
    expect(chip.textContent).toContain("Free model router");
    expect(chip.getAttribute("aria-label")).toBe("Choose model, currently Free model router");
    fireEvent.click(chip);
    expect(onOpenModels).toHaveBeenCalledTimes(1);
  });

  it("hides the model chip when no picker seam is provided", () => {
    render(<ChatComposer {...baseProps()} />);
    expect(screen.queryByTestId("composer-model-chip")).toBeNull();
  });

  it("never falls back to the retired Automatic mode label", () => {
    render(<ChatComposer {...baseProps()} onOpenModels={() => {}} />);
    const chip = screen.getByTestId("composer-model-chip");
    expect(chip.textContent).not.toMatch(/automatic/i);
    expect(chip.getAttribute("aria-label")).toBe("Choose model");
  });

  it("disables the model chip while a send is in flight", () => {
    render(
      <ChatComposer {...baseProps()} busy modelTitle="Free model router" onOpenModels={() => {}} modelDisabled />,
    );
    expect(screen.getByTestId("composer-model-chip")).toHaveProperty("disabled", true);
  });

  it("offers Camera, Gallery and Files in the attach menu, without Guide duplication", async () => {
    const onAddFiles = vi.fn();
    render(<ChatComposer {...baseProps()} onAddFiles={onAddFiles} onPickImage={() => {}} />);
    fireEvent.click(screen.getByTestId("chat-add-photos"));
    const menu = await screen.findByTestId("chat-add-menu");
    expect(menu.textContent).toContain("Take a photo");
    expect(menu.textContent).toContain("Gallery");
    expect(menu.textContent).toContain("Files");
    expect(screen.getByTestId("chat-take-photo")).toBeTruthy();
    expect(screen.getByTestId("chat-gallery")).toBeTruthy();
    expect(screen.getByTestId("chat-files")).toBeTruthy();
    // Guide concepts never duplicate inside the attach menu.
    expect(menu.textContent).not.toMatch(/guide/i);
  });

  it("forwards picked files through the generic files input", () => {
    const onAddFiles = vi.fn();
    render(<ChatComposer {...baseProps()} onAddFiles={onAddFiles} />);
    fireEvent.click(screen.getByTestId("chat-add-photos"));
    fireEvent.click(screen.getByTestId("chat-files"));
    const input = screen.getByTestId("chat-files-input") as HTMLInputElement;
    const file = new File(["x"], "note.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles.mock.calls[0]![0]).toHaveLength(1);
  });

  it("shows the Location row only when a location seam is provided", () => {
    render(<ChatComposer {...baseProps()} onAddFiles={vi.fn()} />);
    fireEvent.click(screen.getByTestId("chat-add-photos"));
    expect(screen.queryByTestId("chat-location")).toBeNull();
    cleanup();

    const onPickLocation = vi.fn();
    render(<ChatComposer {...baseProps()} onAddFiles={vi.fn()} onPickLocation={onPickLocation} />);
    fireEvent.click(screen.getByTestId("chat-add-photos"));
    fireEvent.click(screen.getByTestId("chat-location"));
    expect(onPickLocation).toHaveBeenCalledTimes(1);
  });

  it("keeps the textarea auto-grow bounded to five lines", () => {
    render(<ChatComposer {...baseProps()} modelTitle="Chat model" onOpenModels={() => {}} />);
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(field.getAttribute("rows")).toBe("1");
    expect(field.className).toMatch(/max-h-\[9rem\]/);
  });
});
