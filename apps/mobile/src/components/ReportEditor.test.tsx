// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => new Proxy({}, { get: () => async () => ({}) }),
}));
vi.mock("@capacitor/geolocation", () => ({
  Geolocation: {
    checkPermissions: async () => ({ coarseLocation: "prompt", location: "prompt" }),
    requestPermissions: async () => ({}),
    getCurrentPosition: async () => ({ coords: { latitude: 0, longitude: 0, accuracy: 10 }, timestamp: 0 }),
  },
}));
// The map sheet's internals are covered by MapPickerSheet.test.tsx.
vi.mock("./MapPickerSheet", () => ({ MapPickerSheet: () => null }));

import {
  ReportEditor,
  reportEditorIsDirty,
  reportEditorValuesFromPost,
  validateReportEditorValues,
  type ReportEditorValues,
} from "./ReportEditor";

const post = {
  id: "p1",
  userId: "u1",
  author: { id: "u1", username: "alice" },
  type: "LOST" as const,
  status: "OPEN" as const,
  title: "Scientific calculator",
  description: "A black scientific calculator lost near the science faculty.",
  category: "Electronics" as const,
  eventDate: "2026-09-29",
  latitude: 23.81,
  longitude: 90.41,
  locationLabel: "Dhaka",
  youtubeUrl: null,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  likeCount: 0,
  dislikeCount: 0,
  ratingAvg: null,
  ratingCount: 0,
  commentCount: 0,
  attachments: [
    {
      id: "a1",
      postId: "p1",
      fileUrl: "https://example.test/photo.jpg",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      fileSize: 1024,
      createdAt: "2026-09-29T00:00:00.000Z",
    },
  ],
};

function values(): ReportEditorValues {
  return reportEditorValuesFromPost(post as never);
}

afterEach(cleanup);

describe("ReportEditor", () => {
  it("hydrates the stored report into the fields", () => {
    render(<ReportEditor values={values()} onChange={() => {}} photos={post.attachments} />);
    expect((screen.getByLabelText("What did you lose?") as HTMLInputElement).value).toBe(
      "Scientific calculator",
    );
    expect(screen.getByTestId("category-trigger").textContent).toContain("Electronics");
    expect((screen.getByPlaceholderText("Place, decimal coords, or a Google Maps link") as HTMLInputElement).value).toBe(
      "Dhaka",
    );
  });

  it("shows the photos read-only, with an honest explanation and no photo controls", () => {
    render(<ReportEditor values={values()} onChange={() => {}} photos={post.attachments} />);
    const note = screen.getByTestId("report-editor-photos-note");
    expect(note.textContent).toMatch(/can't be added, removed or reordered/i);
    // No add/remove/reorder control is offered for a photo.
    expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /make cover/i })).toBeNull();
  });

  it("reports a patch when a field changes", () => {
    const onChange = vi.fn();
    render(<ReportEditor values={values()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "A new title" } });
    expect(onChange).toHaveBeenCalledWith({ title: "A new title" });
  });

  it("knows when the values differ from the baseline", () => {
    const baseline = values();
    expect(reportEditorIsDirty(baseline, baseline)).toBe(false);
    expect(reportEditorIsDirty({ ...baseline, title: "Another title" }, baseline)).toBe(true);
    expect(
      reportEditorIsDirty(
        { ...baseline, location: { ...baseline.location, label: "" } },
        baseline,
      ),
    ).toBe(true);
    expect(
      reportEditorIsDirty(
        { ...baseline, location: { ...baseline.location, latitude: 1, longitude: 2 } },
        baseline,
      ),
    ).toBe(true);
  });

  it("validates against the server's own bounds", () => {
    const base = values();
    expect(validateReportEditorValues(base)).toEqual({});
    const errors = validateReportEditorValues({
      ...base,
      title: "ab",
      category: "",
      eventDate: "",
    });
    expect(errors.title).toBeTruthy();
    expect(errors.category).toBeTruthy();
    expect(errors.eventDate).toBeTruthy();
  });
});
