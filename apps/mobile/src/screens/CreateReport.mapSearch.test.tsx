// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, publishReportWithPhotosMock, photo, searchPlacesMock } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  publishReportWithPhotosMock: vi.fn(),
  searchPlacesMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    chooseReportPhotos: vi.fn(),
    photoToFile: vi.fn(),
    normalizeForUpload: vi.fn(async (file: File) => file),
    toNativeImageUri: vi.fn(),
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
vi.mock("../services/location/nominatimSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/location/nominatimSearch")>();
  return { ...actual, searchPlaces: (...args: unknown[]) => searchPlacesMock(...args) };
});

import { CreateReport } from "./CreateReport";
import { clearDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";
import { chooseCategory } from "../test-utils/reportCategory";

function seedValidReport(): void {
  saveDraft({
    type: "LOST",
    title: "",
    description: "a black phone lost near the library",
    category: "",
    eventDate: todayInputValue(),
    location: { label: "", latitude: null, longitude: null },
    youtubeUrl: "",
    photoId: null,
    photoNativeUri: null,
    photoWebPath: null,
    photoFormat: null,
  }, "u1");
}

async function fillValidReport(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
  await chooseCategory("Electronics");
}

async function openMapSearch(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
  const input = await screen.findByLabelText("Search for a place");
  // The search control must not introduce a nested <form> inside the Report
  // form: an inner submit would propagate outward and publish the report. The
  // nearest form ancestor must therefore be the Report form itself.
  const reportForm = screen.getByRole("button", { name: /publish/i }).closest("form");
  expect(input.closest("form")).toBe(reportForm);
  return input;
}

beforeEach(() => {
  publishReportMock.mockReset();
  publishReportWithPhotosMock.mockReset();
  searchPlacesMock.mockReset();
  searchPlacesMock.mockResolvedValue([]);
  publishReportMock.mockResolvedValue("p1");
  publishReportWithPhotosMock.mockResolvedValue("p1");
  clearDraft();
  clearPhotoStore();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearDraft();
  clearPhotoStore();
});

describe("CreateReport map-search isolation", () => {
  it("pressing Search with a valid report searches without publishing", async () => {
    seedValidReport();
    render(<CreateReport />);
    await fillValidReport();
    const input = await openMapSearch();
    fireEvent.change(input, { target: { value: "library" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    // The place search actually ran (no-results notice), yet neither
    // publishing function was called.
    await screen.findByText(/no places found/i);
    expect(searchPlacesMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(publishReportMock).not.toHaveBeenCalled());
    expect(publishReportWithPhotosMock).not.toHaveBeenCalled();
  });

  it("pressing Enter in the place-search input searches without publishing", async () => {
    seedValidReport();
    render(<CreateReport />);
    await fillValidReport();
    const input = await openMapSearch();
    fireEvent.change(input, { target: { value: "library" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", charCode: 13 });
    await screen.findByText(/no places found/i);
    expect(searchPlacesMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(publishReportMock).not.toHaveBeenCalled());
    expect(publishReportWithPhotosMock).not.toHaveBeenCalled();
  });

  it("ignores a submit event bubbled from a control outside the report form", async () => {
    seedValidReport();
    render(<CreateReport />);
    await fillValidReport();
    const input = await openMapSearch();
    // A submit event whose target is not the report form itself (e.g. from a
    // nested widget) must never publish, even with valid fields.
    fireEvent.submit(input);
    await waitFor(() => expect(publishReportMock).not.toHaveBeenCalled());
    expect(publishReportWithPhotosMock).not.toHaveBeenCalled();
  });
});
