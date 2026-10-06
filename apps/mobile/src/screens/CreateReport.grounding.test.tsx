// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { ground, publish } = vi.hoisted(() => ({ ground: vi.fn(), publish: vi.fn() }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "grounding-owner", username: "tester" } }) }));
vi.mock("../services/livePhotoGrounding", () => ({ groundReportPhoto: ground }));
vi.mock("../services/posts", async (original) => ({
  ...await original<typeof import("../services/posts")>(),
  publishReport: publish, publishReportWithPhotos: publish,
}));

import { CreateReport } from "./CreateReport";
import { clearDraft, loadDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore, stashPhotoFile } from "../services/photoStore";
import { aiPreferencesKey, saveAiPreferences, AI_PREFERENCES_DEFAULTS } from "../services/ai/aiPreferences";

beforeEach(() => {
  localStorage.clear(); clearDraft(); clearPhotoStore(); ground.mockReset(); publish.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:grounding-preview");
  URL.revokeObjectURL = vi.fn();
  const file = new File(["photo"], "items.jpg", { type: "image/jpeg" });
  const id = stashPhotoFile(file);
  saveDraft({ type: "LOST", title: "My own title", description: "My written description", category: "Bags & Wallets",
    eventDate: "2026-01-01", location: { label: "My location", latitude: null, longitude: null },
    youtubeUrl: "", photoId: id, photoIds: [id], photoNativeUri: null, photoWebPath: null, photoFormat: null }, "grounding-owner");
  saveAiPreferences("grounding-owner", { ...AI_PREFERENCES_DEFAULTS, photoEngine: "on-device-only" });
  ground.mockResolvedValue({ ok: true, value: { engine: "on-device", imageUrl: "data:image/jpeg;base64,cGhvdG8=",
    question: "Which item are you reporting?", options: [{ id: "ground-0", label: "red backpack",
      box: { x: 100, y: 200, w: 300, h: 400, label: "red backpack" } }] } });
});
afterEach(() => { cleanup(); clearDraft(); clearPhotoStore(); vi.restoreAllMocks(); });

it("mounts the production grounding consumer and updates only a separately reviewed title, with overwrite confirmation", async () => {
  render(<CreateReport />);
  const panel = await screen.findByRole("region", { name: "Find an item in this photo" });
  const ui = within(panel);
  const find = ui.getByRole("button", { name: "Find matching items" }) as HTMLButtonElement;
  expect(find.disabled).toBe(true);
  fireEvent.change(ui.getByLabelText("Which item should AI look for?"), { target: { value: "the backpack" } });
  fireEvent.click(ui.getByRole("checkbox"));
  fireEvent.click(find);
  const option = await ui.findByRole("button", { name: "Item 1: red backpack" });
  expect(ground).toHaveBeenCalledWith(expect.any(File), "the backpack", true,
    expect.objectContaining({ photoEngine: "on-device-only", accountId: "grounding-owner", signal: expect.any(AbortSignal) }));
  expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("My own title");
  expect(ui.queryByRole("button", { name: "Apply item title" })).toBeNull();
  fireEvent.click(option);
  expect(option.getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(ui.getByLabelText("Reviewed item title"), { target: { value: "My red backpack" } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(ui.getByRole("button", { name: "Apply item title" }));
  expect(confirm).toHaveBeenCalled();
  expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("My own title");
  expect(ui.getByRole("button", { name: "Apply item title" })).toBeTruthy();
  confirm.mockReturnValue(true);
  fireEvent.click(ui.getByRole("button", { name: "Apply item title" }));
  await waitFor(() => expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("My red backpack"));
  expect(screen.getByDisplayValue("My location")).toBeTruthy();
  expect(screen.getByText("My written description")).toBeTruthy();
  expect(publish).not.toHaveBeenCalled();
});

it("selecting another report photo aborts the production consumer and ignores the previous photo's late boxes", async () => {
  const second = new File(["second photo"], "second.jpg", { type: "image/jpeg" });
  const secondId = stashPhotoFile(second);
  const draft = loadDraft("grounding-owner")!;
  saveDraft({ ...draft, photoIds: [...draft.photoIds!, secondId] }, "grounding-owner");
  let release!: (result: unknown) => void;
  ground.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  render(<CreateReport />);
  const ui = within(await screen.findByRole("region", { name: "Find an item in this photo" }));
  fireEvent.change(ui.getByLabelText("Which item should AI look for?"), { target: { value: "the backpack" } });
  fireEvent.click(ui.getByRole("checkbox")); fireEvent.click(ui.getByRole("button", { name: "Find matching items" }));
  const signal = ground.mock.calls[0]![3].signal as AbortSignal;
  fireEvent.change(screen.getByLabelText("Photo for item selection"), { target: { value: secondId } });
  expect(signal.aborted).toBe(true);
  expect((ui.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  release({ ok: true, value: { engine: "on-device", imageUrl: "data:image/jpeg;base64,cGhvdG8=", options: [
    { id: "old", label: "stale item", box: { x: 0, y: 0, w: 100, h: 100, label: "stale item" } } ] } });
  fireEvent.change(ui.getByLabelText("Which item should AI look for?"), { target: { value: "the new item" } });
  fireEvent.click(ui.getByRole("checkbox")); fireEvent.click(ui.getByRole("button", { name: "Find matching items" }));
  await ui.findByRole("button", { name: "Item 1: red backpack" });
  expect(ground.mock.calls[1]![0]).toBe(second);
  expect(ui.queryByText(/stale item/)).toBeNull(); expect(publish).not.toHaveBeenCalled();
});

it("a cross-tab persisted photo-engine change immediately cancels in-flight results and requires fresh mode-accurate consent", async () => {
  ground.mockImplementationOnce(() => new Promise(() => {}));
  render(<CreateReport />);
  const ui = within(await screen.findByRole("region", { name: "Find an item in this photo" }));
  fireEvent.change(ui.getByLabelText("Which item should AI look for?"), { target: { value: "the backpack" } });
  fireEvent.click(ui.getByRole("checkbox")); fireEvent.click(ui.getByRole("button", { name: "Find matching items" }));
  const signal = ground.mock.calls[0]![3].signal as AbortSignal;
  saveAiPreferences("grounding-owner", { ...AI_PREFERENCES_DEFAULTS, photoEngine: "cloud-only" });
  fireEvent(window, new StorageEvent("storage", { key: aiPreferencesKey("grounding-owner") }));
  expect(signal.aborted).toBe(true);
  expect(ui.getByRole("checkbox").parentElement!.textContent).toContain("Send this photo and item description to OpenRouter");
  expect((ui.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(ground).toHaveBeenCalledTimes(1);
});
