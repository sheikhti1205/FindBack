import { beforeEach, describe, expect, it, vi } from "vitest";

const { analyzeImageMock } = vi.hoisted(() => ({ analyzeImageMock: vi.fn() }));
vi.mock("./vlmPlugin", () => ({
  getVlmBridge: () => ({ analyzeImage: analyzeImageMock }),
}));

import {
  discoverObjectsLocally,
  parseDiscoveryOutput,
  redactSensitiveText,
  suggestForPrimaryLocally,
  withInferenceMutex,
} from "./vlmDiscovery";

const discoveryResult = (objects: unknown) => ({
  text: JSON.stringify({ objects }),
  modelId: "smolvlm2-500m",
  backend: "gpu",
  runtime: "0.16.0",
  diagnostics: [],
});

beforeEach(() => analyzeImageMock.mockReset());

describe("redactSensitiveText", () => {
  it("redacts cards, phones, emails, and id-like text", () => {
    expect(redactSensitiveText("4111 1111 1111 1111")).toBe("[redacted]");
    expect(redactSensitiveText("+880 1712-345678")).toBe("[redacted]");
    expect(redactSensitiveText("owner@example.com")).toBe("[redacted]");
    expect(redactSensitiveText("ID No AB123456")).toBe("[redacted]");
    expect(redactSensitiveText("black wallet")).toBe("black wallet");
  });
});

describe("parseDiscoveryOutput", () => {
  it("caps at six, drops malformed entries, keeps position hints", () => {
    const objects = Array.from({ length: 8 }, (_, i) => ({
      objectName: `item ${i}`,
      positionHint: "left",
    }));
    objects.push({ objectName: 42, positionHint: "x" } as never);
    const parsed = parseDiscoveryOutput(JSON.stringify({ objects }))!;
    expect(parsed).toHaveLength(6);
    expect(parsed[0]).toEqual({ objectName: "item 0", positionHint: "left" });
  });

  it("redacts sensitive names and rejects non-object payloads", () => {
    const parsed = parseDiscoveryOutput(
      JSON.stringify({ objects: [{ objectName: "card 4111-1111-1111-1111", positionHint: "center" }] }),
    )!;
    expect(parsed[0]!.objectName).toBe("[redacted]");
    expect(parseDiscoveryOutput("nope")).toBeNull();
    expect(parseDiscoveryOutput(JSON.stringify({ objects: "x" }))).toBeNull();
    expect(parseDiscoveryOutput(JSON.stringify({ objects: [] }))).toEqual([]);
  });

  it("never carries bounding boxes", () => {
    const parsed = parseDiscoveryOutput(
      JSON.stringify({ objects: [{ objectName: "keys", positionHint: "right", bbox: [1, 2, 3, 4] }] }),
    )!;
    expect(parsed[0]).toEqual({ objectName: "keys", positionHint: "right" });
  });
});

describe("discoverObjectsLocally", () => {
  it("returns candidates and retries once on garbage", async () => {
    analyzeImageMock
      .mockResolvedValueOnce({ ...discoveryResult([]), text: "garbage" })
      .mockResolvedValueOnce(discoveryResult([{ objectName: "keys", positionHint: "left" }]));
    const out = await discoverObjectsLocally({ imageUri: "content://p", mode: "AUTO" });
    expect(out).toEqual([{ objectName: "keys", positionHint: "left" }]);
    expect(analyzeImageMock).toHaveBeenCalledTimes(2);
  });
});

describe("suggestForPrimaryLocally", () => {
  it("focuses the primary, mentions includes, never ignores", async () => {
    const analysis = {
      objectName: "wallet",
      suggestedCategory: "Keys",
      colors: ["black"],
      visibleBrand: null,
      visibleText: [],
      identifyingFeatures: [],
      suggestedTitle: "Black wallet",
      suggestedDescription: "Found near gate.",
      uncertainFields: [],
    };
    analyzeImageMock.mockResolvedValue({
      text: JSON.stringify(analysis),
      modelId: "m",
      backend: "gpu",
      runtime: "x",
      diagnostics: [],
    });
    const out = await suggestForPrimaryLocally({
      imageUri: "content://p",
      mode: "QUALITY",
      primary: "black wallet",
      include: ["keys"],
      userInstruction: "it has a zipper",
      userContext: { title: "", description: "" },
    });
    expect(out.suggestedTitle).toBe("Black wallet");
    const instruction = analyzeImageMock.mock.calls[0]![0].instruction as string;
    expect(instruction).toContain("black wallet");
    expect(instruction).toContain("keys");
    expect(instruction).toContain("zipper");
    expect(analyzeImageMock.mock.calls[0]![0].maxOutputTokens).toBe(256);
  });
});

describe("withInferenceMutex", () => {
  it("serializes concurrent inferences", async () => {
    const order: string[] = [];
    const slow = () => new Promise<string>((res) => setTimeout(() => { order.push("slow"); res("s"); }, 30));
    const fast = () => { order.push("fast"); return Promise.resolve("f"); };
    const [a, b] = await Promise.all([withInferenceMutex(slow), withInferenceMutex(fast)]);
    expect([a, b]).toEqual(["s", "f"]);
    expect(order).toEqual(["slow", "fast"]);
  });
});
