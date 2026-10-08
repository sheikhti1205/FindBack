/**
 * Advertised-role closure: every production taskRole must have a real
 * production generator behind it — proven through the REAL
 * ApplicationAiService wiring (real descriptors, real seam construction,
 * real interpreters), never a generic fake that returns whatever each
 * task expects.
 *
 * The Needle fake below is tool-aware: it installs whatever tool schema
 * the service requests via initTools and answers with that tool's call,
 * so a task only succeeds when the service actually installed a schema
 * whose output satisfies the task's own interpreter.
 */
import { describe, expect, it } from "vitest";
import { ApplicationAiService } from "./applicationAi";
import { NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR } from "./modelDescriptors";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import type { ModelDownloadDriver } from "./download/driver";
import { interpreterFor } from "./orchestrator/taskInterpreters";

function driver(): ModelDownloadDriver {
  const disk = new Map<string, string>();
  return {
    rootDir: async () => "/private/ai-models",
    freeBytes: async () => 2_000_000_000,
    stagedSize: async (path) => (disk.has(path) ? 1 : 0),
    readJournalText: async () => null,
    download: async (attempt) => {
      attempt.onProgress?.(20, null);
      disk.set(attempt.stagingPath, attempt.expectedSha256);
      return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    },
    cancelDownload: async () => {},
    hashFile: async (path) => { if (!disk.has(path)) throw new Error("missing"); return disk.get(path)!; },
    promoteFile: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
    removeFile: async (path) => { disk.delete(path); },
  };
}

function toolAwareNeedle() {
  const installed: Array<{ system: string; tools: Array<{ name: string }> }> = [];
  let resident = false;
  return {
    installed,
    bridge: {
      bridgeName: "needle-cact" as const,
      isNeedleAvailable: async () => resident,
      embeddingDimension: async () => 2,
      loadModel: async () => { resident = true; return 2; },
      embedNeedleTexts: async (texts: string[]) => texts.map(() => [1, 0]),
      initTools: async (system: string, toolsJson: string) => {
        installed.push({ system, tools: JSON.parse(toolsJson) as Array<{ name: string }> });
      },
      completeJson: async () => {
        const tool = installed[installed.length - 1]?.tools[0]?.name ?? "record_item";
        const args =
          tool === "search_filters"
            ? { query: "umbrella", category: "accessories" }
            : tool === "item_category"
              ? { category: "accessories", confidence: 0.9 }
              : { title: "red umbrella" };
        return JSON.stringify({ function_calls: [{ name: tool, arguments: args }] });
      },
      unload: async () => { resident = false; },
    },
  };
}

function arm64Smol(describeText: string) {
  let loaded = false;
  return {
    bridgeName: "smolvlm2-litertlm",
    isVisionAvailable: async () => loaded,
    loadVisionModel: async () => { loaded = true; },
    unloadVisionModel: async () => { loaded = false; },
    describeImage: async function* () { yield { textDelta: describeText }; },
    cancelGeneration: async () => {},
    collectDeviceFacts: async (): Promise<Record<string, unknown>> => ({ supportedAbis: ["arm64-v8a"] }),
  };
}

function suppressedNeedle() {
  const installed: Array<{ system: string; tools: Array<{ name: string }> }> = [];
  let resident = false;
  return {
    installed,
    bridge: {
      bridgeName: "needle-cact" as const,
      isNeedleAvailable: async () => resident,
      embeddingDimension: async () => 2,
      loadModel: async () => { resident = true; return 2; },
      embedNeedleTexts: async (texts: string[]) => texts.map(() => [1, 0]),
      initTools: async (system: string, toolsJson: string) => {
        installed.push({ system, tools: JSON.parse(toolsJson) as Array<{ name: string }> });
      },
      completeJson: async () =>
        JSON.stringify({
          function_calls: [],
          suppressed_calls: [{ name: "record_item", arguments: { title: "brown leather wallet" } }],
        }),
      unload: async () => { resident = false; },
    },
  };
}

const EXPECTED_TOOL: Readonly<Record<string, string>> = {
  "extract-report-fields": "record_item",
  "extract-search-filters": "search_filters",
  "classify-category": "item_category",
};

describe("advertised Needle roles have real production generators", () => {
  it("every structured role installs its own schema and validates end to end", async () => {
    const needle = toolAwareNeedle();
    const service = new ApplicationAiService({ android: true, driver: driver(), needle: needle.bridge, smol: arm64Smol("saw it") });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    for (const taskId of ["extract-report-fields", "extract-search-filters", "classify-category"] as const) {
      const before = needle.installed.length;
      const result = await service.route(taskId, { prompt: "a red umbrella" }, { traceId: `trace-role-${taskId}` });
      expect(result.ok).toBe(true);
      // The service installed exactly one tool for this task — its own
      // schema, never another task's borrowed schema.
      expect(needle.installed.length).toBe(before + 1);
      expect(needle.installed[needle.installed.length - 1]?.tools.map((tool) => tool.name)).toEqual([
        EXPECTED_TOOL[taskId],
      ]);
      if (result.ok) {
        const value = result.value as Record<string, unknown>;
        expect(value["fields"] ?? value).toMatchObject(
          taskId === "extract-report-fields"
            ? { title: "red umbrella" }
            : taskId === "extract-search-filters"
              ? { query: "umbrella" }
              : { category: "accessories" },
        );
      }
    }
  });

  it("extraction succeeds when Needle withholds the record in suppressed_calls", async () => {
    const needle = suppressedNeedle();
    const service = new ApplicationAiService({ android: true, driver: driver(), needle: needle.bridge, smol: arm64Smol("saw it") });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const result = await service.route(
      "extract-report-fields",
      { prompt: "Lost a brown leather wallet near the central library yesterday" },
      { traceId: "trace-suppressed" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value["fields"] ?? value).toMatchObject({ title: "brown leather wallet" });
    }
  });

  it("every advertised role resolves through real wiring (Needle + Smol)", async () => {
    const needle = toolAwareNeedle();
    const service = new ApplicationAiService({ android: true, driver: driver(), needle: needle.bridge, smol: arm64Smol("A red umbrella on a bench.") });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    for (const taskId of NEEDLE_DESCRIPTOR.taskRoles) {
      if (taskId === "embed-texts") {
        expect(await service.embedNeedle(["umbrella"])).toEqual([[1, 0]]);
        continue;
      }
      const result = await service.route(taskId, { prompt: "a red umbrella" }, { traceId: `trace-needle-${taskId}` });
      expect(result.ok).toBe(true);
    }
    for (const taskId of SMOL_VISION_DESCRIPTOR.taskRoles) {
      const result = await service.route(
        taskId,
        { prompt: "describe", imageBase64: "aGVsbG8=" },
        { traceId: `trace-smol-${taskId}` },
      );
      expect(result.ok).toBe(true);
    }
  });

  it("every advertised role has an explicit task interpreter (no implicit success)", () => {
    for (const descriptor of [NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR]) {
      for (const taskId of descriptor.taskRoles) {
        expect(interpreterFor(taskId), `${descriptor.modelId} advertises ${taskId}`).toBeDefined();
      }
    }
  });

  it("Needle tool schemas match the tool-model contract (Phase A.4)", async () => {
    const needle = toolAwareNeedle();
    const service = new ApplicationAiService({ android: true, driver: driver(), needle: needle.bridge, smol: arm64Smol("saw it") });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    await service.route("extract-report-fields", { prompt: "a red umbrella" }, { traceId: "trace-schema-report" });
    await service.route("extract-search-filters", { prompt: "a red umbrella" }, { traceId: "trace-schema-search" });
    await service.route("classify-category", { prompt: "a red umbrella" }, { traceId: "trace-schema-category" });
    const tools = needle.installed
      .map((entry) => (JSON.parse(JSON.stringify(entry.tools)) as Array<Record<string, unknown>>)[0])
      .filter((tool): tool is Record<string, unknown> => tool !== undefined);
    const byName = new Map(tools.map((tool) => [tool["name"], tool]));
    // Extraction is partial by app contract: nothing required, so an
    // ungrounded slot withholds nothing and FindBack validates the rest.
    for (const name of ["record_item", "search_filters"]) {
      const schema = byName.get(name)?.["parameters"] as { required?: unknown };
      expect(schema.required).toEqual([]);
    }
    // Category binds the canonical enum; confidence is the engine's
    // top-level score, never a tool argument.
    const categoryParams = byName.get("item_category")?.["parameters"] as {
      properties?: Record<string, unknown>;
      required?: unknown;
    };
    expect(categoryParams.required).toEqual(["category"]);
    expect((categoryParams.properties?.["category"] as { enum?: unknown }).enum).toEqual([
      "documents",
      "electronics",
      "keys",
      "wallet",
      "bags",
      "clothing",
      "accessories",
      "jewelry",
      "pets",
      "eyewear",
      "sports",
      "books",
      "toys",
      "tools",
      "cosmetics",
      "other",
    ]);
    expect(categoryParams.properties).not.toHaveProperty("confidence");
    // Tool descriptions name the actual extraction action.
    for (const tool of tools) {
      const description = tool["description"];
      expect(typeof description).toBe("string");
      expect((description as string).length).toBeGreaterThan("Record item details".length);
    }
  });
});
