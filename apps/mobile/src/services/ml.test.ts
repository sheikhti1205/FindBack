import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadMock, classifyMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  classifyMock: vi.fn(),
}));

vi.mock("@tensorflow/tfjs", () => ({
  ready: vi.fn().mockResolvedValue(undefined),
  getBackend: vi.fn(() => "cpu"),
  setBackend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tensorflow-models/mobilenet", () => ({ load: loadMock }));

import {
  LOCAL_MODEL_URL,
  MlUnavailableError,
  mapLabelToCategory,
  suggestCategoryFromImage,
} from "./ml";

function imageFile(): File {
  return new File(["fake-bytes"], "photo.jpg", { type: "image/jpeg" });
}

beforeEach(() => {
  loadMock.mockReset();
  classifyMock.mockReset();
  loadMock.mockResolvedValue({ classify: classifyMock });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:local-image"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = vi.fn().mockResolvedValue(undefined);
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("suggestCategoryFromImage", () => {
  it("loads the bundled local model and never a CDN", async () => {
    classifyMock.mockResolvedValue([{ className: "laptop, laptop computer", probability: 0.9 }]);

    const result = await suggestCategoryFromImage(imageFile());

    expect(loadMock).toHaveBeenCalledTimes(1);
    const options = loadMock.mock.calls[0]![0];
    expect(options).toEqual({ version: 1, alpha: 0.25, modelUrl: LOCAL_MODEL_URL });
    expect(JSON.stringify(options)).not.toMatch(/tfhub|storage\.googleapis|kaggle|https?:/i);
    expect(result).toEqual({
      category: "Electronics",
      confidence: 0.9,
      rawLabel: "laptop, laptop computer",
    });
  });

  it("uses the bundled path constant", () => {
    expect(LOCAL_MODEL_URL).toBe("/models/mobilenet/model.json");
  });

  it("returns Other when no ImageNet label maps to a category", async () => {
    classifyMock.mockResolvedValue([{ className: "window screen", probability: 0.42 }]);

    await expect(suggestCategoryFromImage(imageFile())).resolves.toEqual({
      category: "Other",
      confidence: 0.42,
      rawLabel: "window screen",
    });
  });

  it("throws a clear error when the bundled model cannot load, without any network fetch", async () => {
    loadMock.mockRejectedValueOnce(new Error("Failed to fetch model.json"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(suggestCategoryFromImage(imageFile())).rejects.toBeInstanceOf(MlUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("mapLabelToCategory", () => {
  it("maps known keywords", () => {
    expect(mapLabelToCategory("laptop, laptop computer")).toBe("Electronics");
    expect(mapLabelToCategory("leather wallet")).toBe("Bags & Wallets");
    expect(mapLabelToCategory("front door key")).toBe("Keys");
  });

  it("returns null for unmapped labels and for the catch-all Other bucket", () => {
    expect(mapLabelToCategory("window screen")).toBeNull();
    expect(mapLabelToCategory("trophy")).toBeNull();
  });
});
