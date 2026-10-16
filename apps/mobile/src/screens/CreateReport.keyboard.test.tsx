// @vitest-environment jsdom
/**
 * §8: the report composer's keyboard composition mode, asserted at the parent
 * layer that owns it. While the on-screen keyboard is up the description and its
 * formatting rail stay above the IME, the photos keep roughly two fifths of what
 * is left, the form gains exactly the scroll tail the keyboard covers, and
 * nothing else moves: no modal, no fixed positioning, no reflow of the fields
 * around the editor, and no programmatic scrolling.
 *
 * The geometry is injected (a stand-in `window.visualViewport`) because the
 * behaviour has to be provable on the host; the real-IME pass belongs to the
 * device acceptance matrix, not this file.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, publishReportWithPhotosMock, photo, nativeMedia } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  publishReportWithPhotosMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    normalizeForUpload: vi.fn(async (file: File) => file),
  },
  nativeMedia: {
    chooseNativeImage: vi.fn(),
    chooseNativeImages: vi.fn(),
    importNativeImageUri: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: { ShortLinkResolver: { resolve: vi.fn() } },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../services/posts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/posts")>();
  return {
    ...actual,
    publishReport: (...args: unknown[]) => publishReportMock(...args),
    publishReportWithPhotos: (...args: unknown[]) => publishReportWithPhotosMock(...args),
  };
});
vi.mock("../services/photo", () => photo);
vi.mock("../services/media/nativeMedia", () => ({
  chooseNativeImage: nativeMedia.chooseNativeImage,
  chooseNativeImages: nativeMedia.chooseNativeImages,
  importNativeImageUri: nativeMedia.importNativeImageUri,
  importedImageToFile: (item: { fileName?: string; derivative: { bytes: Uint8Array; mimeType: string } }) =>
    new File([item.derivative.bytes.slice()], item.fileName || "photo.jpg", { type: item.derivative.mimeType }),
}));

import { CreateReport } from "./CreateReport";
import { ReportPhotoCarousel } from "../components/ReportPhotoCarousel";
import { clearDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";

const WINDOW_HEIGHT = 768;
const KEYBOARD_HEIGHT = 420;
/** The default slide bound the carousel falls back to on its own. */
const DEFAULT_SLIDE_BOUND = "min(58vh, 460px)";
const originalInnerHeight = window.innerHeight;
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

function setInnerHeight(px: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: px });
}

/** A stand-in for `window.visualViewport`; `null` means no keyboard. */
function keyboard(height: number | null) {
  if (height === null) {
    delete (window as { visualViewport?: unknown }).visualViewport;
    return;
  }
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { height, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
}

async function renderForm() {
  render(<CreateReport />);
  // The mount effect re-reads the geometry, so assertions have to wait for that
  // commit rather than reading a pre-effect snapshot.
  await act(async () => {});
  const form = document.querySelector("form");
  if (!form) throw new Error("no report form rendered");
  return { form, dock: screen.getByTestId("report-description") };
}

/**
 * Start editing the description. React's `onFocus` is `focusin`, so the bubbling
 * event is what a real tap on the contenteditable produces.
 */
function focusDescription() {
  fireEvent.focusIn(screen.getByTestId("report-description"));
}

/** One accepted photo, so the carousel (and its slide box) exists. */
async function addOnePhoto() {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" })] },
  });
  await waitFor(() => expect(screen.getAllByTestId("report-photo-slide")).toHaveLength(1), {
    timeout: 5000,
  });
}

/** The slide's box: the button carries the min/max height, the wrapper the list role. */
function slideBox() {
  return screen.getAllByTestId("report-photo-slide-button")[0] as HTMLElement;
}

beforeEach(() => {
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
});

afterEach(() => {
  cleanup();
  setInnerHeight(originalInnerHeight);
  if (originalVisualViewport) {
    Object.defineProperty(window, "visualViewport", originalVisualViewport);
  } else {
    delete (window as { visualViewport?: unknown }).visualViewport;
  }
  clearDraft("u1");
  clearPhotoStore();
});

describe("report composer keyboard mode (§8)", () => {
  it("leaves the form alone while no keyboard is up", async () => {
    setInnerHeight(WINDOW_HEIGHT);
    keyboard(null);
    const { form, dock } = await renderForm();

    expect(form.style.paddingBottom).toBe("");
    expect(dock.className).not.toContain("sticky");
    expect(form.className).not.toContain("fixed");
    // Photos stay above the editor: the picker precedes the description dock.
    const picker = screen.getByTestId("report-media-picker");
    expect(picker.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("docks the description above the IME and budgets the photos from what is left", async () => {
    setInnerHeight(WINDOW_HEIGHT);
    keyboard(KEYBOARD_HEIGHT);
    const { form, dock } = await renderForm();
    await addOnePhoto();
    focusDescription();

    // The form can scroll a further `inset + tail` past its own content, so the
    // last field (and the rail) can be brought clear of the keyboard.
    expect(form.style.paddingBottom).toBe(`${WINDOW_HEIGHT - KEYBOARD_HEIGHT + 8}px`);
    expect(dock.className).toContain("sticky");
    expect(dock.className).toContain("bottom-0");
    // §8: ~40% of the visible area above the IME — 420px of visible area here.
    expect(slideBox().style.maxHeight).toBe(`${Math.round(KEYBOARD_HEIGHT * 0.4)}px`);
    // In flow, not fixed: the fields around the editor never reflow, and the
    // composer never scrolls the page itself.
    expect(dock.parentElement).toBe(form);
    expect(dock.className).not.toContain("fixed");
    // No hard modal appears, and the photo controls stay usable while typing.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("Take photo") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("report-media-picker").className).not.toContain("sticky");
    expect(screen.getByTestId("report-photo-track")).toBeTruthy();
  });

  it("keeps a usable photo floor on a very short visible area", async () => {
    setInnerHeight(WINDOW_HEIGHT);
    keyboard(200);
    await renderForm();
    await addOnePhoto();
    focusDescription();
    // 40% of 200px would be 80px — below the floor a photo stops being a photo.
    expect(slideBox().style.maxHeight).toBe("120px");
  });

  it("follows the keyboard opening and hands the space back when it closes", async () => {
    setInnerHeight(WINDOW_HEIGHT);
    keyboard(null);
    const { form, dock } = await renderForm();
    await addOnePhoto();
    expect(form.style.paddingBottom).toBe("");
    expect(slideBox().style.maxHeight).toBe(DEFAULT_SLIDE_BOUND);

    keyboard(KEYBOARD_HEIGHT);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    focusDescription();
    expect(form.style.paddingBottom).toBe(`${WINDOW_HEIGHT - KEYBOARD_HEIGHT + 8}px`);
    expect(dock.className).toContain("sticky");
    expect(slideBox().style.maxHeight).toBe("168px");

    fireEvent.focusOut(dock);
    keyboard(null);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(form.style.paddingBottom).toBe("");
    expect(dock.className).not.toContain("sticky");
    expect(slideBox().style.maxHeight).toBe(DEFAULT_SLIDE_BOUND);
  });

  it("keeps the tail but does not dock while the keyboard belongs to another field", async () => {
    // The person finished the description and tapped Category: the IME is still
    // up, so the field in focus still needs its scroll tail — but a docked editor
    // would now be sitting on top of that very field.
    setInnerHeight(WINDOW_HEIGHT);
    keyboard(KEYBOARD_HEIGHT);
    const { form, dock } = await renderForm();
    await addOnePhoto();

    expect(form.style.paddingBottom).toBe(`${WINDOW_HEIGHT - KEYBOARD_HEIGHT + 8}px`);
    expect(dock.className).not.toContain("sticky");
    expect(slideBox().style.maxHeight).toBe(DEFAULT_SLIDE_BOUND);
  });

  it("keeps the carousel's own bound when no budget is passed", () => {
    render(
      <ReportPhotoCarousel
        photos={[{ id: "a", webPath: "blob:a" }]}
        onRemove={vi.fn()}
        onMove={vi.fn()}
        onMakeCover={vi.fn()}
        onPreview={vi.fn()}
        disabled={false}
      />,
    );
    expect(slideBox().style.maxHeight).toBe(DEFAULT_SLIDE_BOUND);
    expect(slideBox().style.minHeight).toBe("180px");
  });
});
