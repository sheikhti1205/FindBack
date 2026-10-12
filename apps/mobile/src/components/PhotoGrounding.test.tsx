// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { ground } = vi.hoisted(() => ({ ground: vi.fn() }));
vi.mock("../services/livePhotoGrounding", () => ({ groundReportPhoto: ground }));
import { PhotoGrounding } from "./PhotoGrounding";
import { ACCEPTED_STILL_FORMATS_LABEL, ACCEPTED_STILL_MIME_TYPES } from "../services/media/mediaPolicy";

const file = new File(["photo"], "items.jpg", { type: "image/jpeg" });
const value = { engine: "on-device", imageUrl: "data:image/jpeg;base64,cGhvdG8=", question: "Which item are you reporting?",
  options: [{ id: "ground-0", label: "red bag", box: { x: 100, y: 200, w: 300, h: 400, label: "red bag" } },
    { id: "ground-1", label: "blue bag", box: { x: 500, y: 0, w: 200, h: 600, label: "blue bag" } }] };
const props = { file, photoEngine: "automatic" as const, accountId: "owner", currentTitle: "My title", onApply: vi.fn(() => true) };
beforeEach(() => {
  ground.mockReset(); ground.mockResolvedValue({ ok: true, value }); props.onApply.mockClear();
  URL.createObjectURL = vi.fn(() => "blob:grounding"); URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function start() {
  fireEvent.change(screen.getByLabelText("Which item should AI look for?"), { target: { value: "the bags" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Find matching items" }));
}
describe("PhotoGrounding reviewed selector", () => {
  it("borrows a parent-owned preview without creating or revoking another object URL", () => {
    const view = render(<PhotoGrounding {...props} previewUrl="blob:parent-owned" />);
    expect(screen.getByAltText("Report photo for item selection").getAttribute("src")).toBe("blob:parent-owned");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    view.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it("gates and advertises the same accepted-still set", () => {
    // Every container the shared sentence advertises is no longer refused.
    for (const type of ACCEPTED_STILL_MIME_TYPES) {
      render(<PhotoGrounding {...props} file={new File(["photo"], `item.${type.split("/")[1]}`, { type })} />);
      expect(screen.getByRole("button", { name: "Find matching items" })).toBeTruthy();
      cleanup();
    }
    // A container outside the advertised set is refused with that same sentence.
    render(<PhotoGrounding {...props} file={new File(["tiff"], "item.tiff", { type: "image/tiff" })} />);
    const notice = screen.getByRole("status").textContent ?? "";
    expect(notice).toContain(ACCEPTED_STILL_FORMATS_LABEL);
    expect(notice).not.toContain("JPEG, PNG or WebP");
    expect(screen.queryByRole("button", { name: "Find matching items" })).toBeNull();
  });
  it("requires expression and consent, renders percentage overlays, and separates selection from Apply and Keep", async () => {
    render(<PhotoGrounding {...props} />);
    expect(screen.getByRole("button", { name: "Find matching items" }).getAttribute("disabled")).not.toBeNull();
    start();
    const option = await screen.findByRole("button", { name: "Item 2: blue bag" });
    const image = screen.getByAltText("Report photo for item selection");
    const overlay = image.parentElement!.querySelector('[data-grounding-box="ground-0"]') as HTMLElement;
    expect(overlay.style.left).toBe("10%"); expect(overlay.style.top).toBe("20%");
    expect(overlay.style.width).toBe("30%"); expect(overlay.style.height).toBe("40%");
    expect(image.getAttribute("src")).toBe(value.imageUrl);
    expect(props.onApply).not.toHaveBeenCalled();
    fireEvent.click(option);
    expect(screen.getByLabelText("Reviewed item title").getAttribute("value")).toBe("blue bag");
    fireEvent.click(screen.getByRole("button", { name: "Keep my title" }));
    expect(props.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Item 1: red bag" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply item title" }));
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith("red bag");
  });
  it.each(["on-device-only", "cloud-only", "automatic"] as const)("makes consent truthful for %s", (photoEngine) => {
    render(<PhotoGrounding {...props} photoEngine={photoEngine} />);
    const label = screen.getByRole("checkbox").parentElement!.textContent!;
    if (photoEngine === "on-device-only") { expect(label).toContain("only on this device"); expect(label).toContain("never sent to OpenRouter"); }
    if (photoEngine === "cloud-only") { expect(label).toContain("Send this photo and item description to OpenRouter"); expect(label).not.toContain("first"); }
    if (photoEngine === "automatic") { expect(label).toContain("first on this device"); expect(label).toContain("OpenRouter"); }
  });
  it("empty matches fail closed without an Apply action", async () => {
    ground.mockResolvedValue({ ok: true, value: { ...value, options: [], question: "No confident match — describe it instead." } });
    render(<PhotoGrounding {...props} />); start();
    await screen.findByText(/No confident match/);
    expect(screen.queryByRole("button", { name: /Item \d:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply item title" })).toBeNull();
  });
  it("invalid output displays an error, never boxes or review actions", async () => {
    ground.mockResolvedValue({ ok: false, error: { errorClass: "INVALID_OUTPUT", diagnostic: "BOX_OUT_OF_BOUNDS" } });
    render(<PhotoGrounding {...props} />); start();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Item \d:/ })).toBeNull();
  });
  it.each(["photo", "engine", "unmount"])("aborts on %s changes, discards late output and releases object URLs", async (change) => {
    let release!: (result: unknown) => void;
    ground.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const view = render(<PhotoGrounding {...props} />); start();
    const signal = ground.mock.calls[0]![3].signal as AbortSignal;
    if (change === "unmount") view.unmount();
    else view.rerender(<PhotoGrounding {...props} {...(change === "photo" ? { file: new File(["other"], "other.jpg", { type: "image/jpeg" }) } : { photoEngine: "cloud-only" })} />);
    expect(signal.aborted).toBe(true);
    if (change !== "engine") expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:grounding");
    await act(async () => release({ ok: true, value }));
    expect(screen.queryByRole("button", { name: "Item 1: red bag" })).toBeNull();
  });
  it("Stop cancels without showing late results", async () => {
    ground.mockImplementation((_f, _e, _c, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
    render(<PhotoGrounding {...props} />); start();
    fireEvent.click(screen.getByRole("button", { name: "Stop finding items" }));
    await screen.findByText("Item request cancelled.");
    expect(props.onApply).not.toHaveBeenCalled();
  });
  it("declining Apply keeps the review available", async () => {
    render(<PhotoGrounding {...props} onApply={() => false} />); start();
    fireEvent.click(await screen.findByRole("button", { name: "Item 1: red bag" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply item title" }));
    expect(within(screen.getByRole("region", { name: "Review selected item" })).getByLabelText("Reviewed item title")).toBeTruthy();
  });
  it("returns focus to the selected option when inline review resolves", async () => {
    render(<PhotoGrounding {...props} />); start();
    const option = await screen.findByRole("button", { name: "Item 1: red bag" });
    fireEvent.click(option);
    const keep = screen.getByRole("button", { name: "Keep my title" }); keep.focus();
    fireEvent.click(keep);
    expect(document.activeElement).toBe(option);
    fireEvent.click(option);
    const apply = screen.getByRole("button", { name: "Apply item title" }); apply.focus();
    fireEvent.click(apply);
    expect(document.activeElement).toBe(option);
  });
});
