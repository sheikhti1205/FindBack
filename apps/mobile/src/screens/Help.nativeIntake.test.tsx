// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { buildPng } from "../services/media/__fixtures__/synthetic";
import { importImage } from "../services/media/importImage";
import { resetBackInterceptors } from "../components/backNavigation";
import { Help } from "./Help";

const intake = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("@capacitor/core", async (original) => {
  const actual = await original<typeof import("@capacitor/core")>();
  return { ...actual, Capacitor: { ...actual.Capacitor, getPlatform: () => "android", isNativePlatform: () => false } };
});
vi.mock("../services/media/nativeMedia", () => ({
  chooseNativeImage: intake.choose,
  isNativeMediaIntakeAvailable: () => true,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u-media", username: "tester" } }) }));
vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));
afterEach(() => { cleanup(); resetBackInterceptors(); localStorage.clear(); document.body.style.overflow = ""; vi.restoreAllMocks(); intake.choose.mockReset(); });

function mount() {
  Element.prototype.scrollIntoView ??= function () {};
  render(<MemoryRouter><Help deps={{ getKey: async () => null }} /></MemoryRouter>);
}
function photos() { fireEvent.click(screen.getByTestId("chat-add-photos")); fireEvent.click(screen.getByTestId("chat-gallery")); }

it("Android photos use URI preparation and show ready derivative without an HTML File read", async () => {
  const item = await importImage({ bytes: buildPng(4, 4), fileName: "photo.png" }, { transcode: async () => buildPng(4, 4), webpEncodeSupported: false });
  intake.choose.mockResolvedValue(item);
  mount();
  const htmlClick = vi.spyOn(HTMLInputElement.prototype, "click");
  photos();
  await screen.findByTestId(`chat-selection-${item.id}`);
  expect(intake.choose).toHaveBeenCalledWith(expect.objectContaining({ source: "photos", highQuality: false }));
  expect(htmlClick).not.toHaveBeenCalled();
});

it("a failed native preparation keeps a retry/remove row and blocks a send from omitting that photo", async () => {
  intake.choose.mockRejectedValue(new Error("private content://path should not leak"));
  mount(); photos();
  await screen.findByRole("button", { name: /retry photo/i });
  expect(screen.queryByText(/content:\/\//)).toBeNull();
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "Describe it" } });
  expect(screen.getByTestId("chat-send")).toHaveProperty("disabled", true);
  intake.choose.mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: /retry photo/i }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /retry photo/i })).toBeNull());
  expect(screen.getByTestId("chat-send")).toHaveProperty("disabled", false);
});
