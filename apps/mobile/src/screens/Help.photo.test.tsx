// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import { aiCredentials } from "../services/aiCredentials";
import { buildPng } from "../services/media/__fixtures__/synthetic";
import { PROBE_BYTES, SOURCE_MAX_BYTES } from "../services/media/mediaPolicy";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u-photo", username: "tester" } }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  (URL as unknown as Record<string, unknown>).createObjectURL = () => "blob:chat-preview";
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  window.localStorage.clear();
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const enc = new TextEncoder();

type FetchCall = { url: string; init: RequestInit };

function stubFetch(responses: Response[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return next;
  }) as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  return calls;
}

function streamResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\ndata: [DONE]\n\n`),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderHelp(deps: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter initialEntries={["/help"]}>
      <Routes>
        <Route path="/help" element={<Help deps={deps} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function composer(): HTMLTextAreaElement {
  return screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement;
}

function send(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

async function attachPng(name = "keys.png") {
  const png = buildPng(4, 4);
  fireEvent.change(screen.getByTestId("chat-file-input"), {
    target: { files: [new File([png as unknown as BlobPart], name, { type: "image/png" })] },
  });
  await screen.findByTestId("chat-selections");
}

function lastUserContent(call: FetchCall): unknown {
  const body = JSON.parse(String(call.init.body));
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  return messages.at(-1)?.content;
}

describe("Help photo per-send binding (G12 photo gap)", () => {
  it("attaching an image on the default OpenRouter direct path resolves the approved photo into the real adapter request", async () => {
    vi.spyOn(aiCredentials, "get").mockResolvedValue("test-key");
    const calls = stubFetch([streamResponse("Photo seen.")]);
    renderHelp({
      getKey: async () => "test-key",
      importDeps: {
        transcode: async () => new Uint8Array([1, 2, 3]),
        webpEncodeSupported: false,
      },
    });
    await attachPng();
    send("What is in this photo?");
    await screen.findByText("Photo seen.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(COMPLETIONS_URL);
    const content = lastUserContent(calls[0]!) as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "text", text: "What is in this photo?" });
    const imagePart = content.find((part) => part.type === "image_url");
    expect(imagePart).toBeDefined();
    // Deliverable data URL from the approved derivative — never a local-only
    // blob: URL the provider could not fetch, never user-file bytes inline.
    expect(imagePart!.image_url!.url).toMatch(/^data:image\/[a-z+]+;base64,AQID$/);
  });

  it("a failed photo send keeps the draft and tray so Retry re-resolves the same approved image", async () => {
    vi.spyOn(aiCredentials, "get").mockResolvedValue("test-key");
    // Non-retryable first failure (the coordinator only retries retryable
    // errors internally), so the user-facing Retry path is exercised.
    const calls = stubFetch([
      errorResponse(401),
      streamResponse("Photo seen on retry."),
    ]);
    renderHelp({
      getKey: async () => "test-key",
      importDeps: {
        transcode: async () => new Uint8Array([1, 2, 3]),
        webpEncodeSupported: false,
      },
    });
    await attachPng();
    const question = "Help me solve a leetcode problem: two sum";
    send(question);
    await screen.findByTestId("chat-error");
    expect(screen.getByTestId("chat-retry")).toBeTruthy();
    expect(composer().value).toBe(question);
    expect(screen.getByTestId("chat-selections")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-retry"));
    await screen.findByText("Photo seen on retry.");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const content = lastUserContent(call) as Array<{ type: string; image_url?: { url: string } }>;
      const imagePart = content.find((part) => part.type === "image_url");
      expect(imagePart!.image_url!.url).toMatch(/^data:image\/[a-z+]+;base64,AQID$/);
    }
  });

  it("the tray image resolver only resolves explicitly approved ids", async () => {
    const mod = (await import("./Help")) as unknown as Record<string, unknown>;
    const createResolver = mod["createChatTrayImageResolver"] as
      | undefined
      | ((items: readonly unknown[]) => (imageId: string) => Promise<string | null>);
    expect(typeof createResolver).toBe("function");
    const item = {
      id: "approved-1",
      derivative: {
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        byteLength: 3,
        width: 4,
        height: 4,
        quality: null,
      },
    };
    const resolve = createResolver!([item]);
    await expect(resolve("approved-1")).resolves.toBe("data:image/png;base64,AQID");
    // Arbitrary local ids are never exposed: unresolvable, so the adapter
    // fails loudly instead of sending unknown content.
    await expect(resolve("not-in-tray")).resolves.toBeNull();
    await expect(resolve("data:image/png;base64,AQID")).resolves.toBeNull();
  });

  it("resolves a GIF derivative — GIF stays usable via sampled stills, never dead-ends", async () => {
    const mod = (await import("./Help")) as unknown as Record<string, unknown>;
    const createResolver = mod["createChatTrayImageResolver"] as
      | undefined
      | ((items: readonly unknown[]) => (imageId: string) => Promise<string | null>);
    const gifItem = {
      id: "gif-1",
      derivative: {
        bytes: new Uint8Array([71, 73, 70]),
        mimeType: "image/gif",
        byteLength: 3,
        width: 4,
        height: 4,
        quality: null,
      },
    };
    const resolve = createResolver!([gifItem]);
    await expect(resolve("gif-1")).resolves.toBe("data:image/gif;base64,R0lG");
  });
});

/**
 * FBX-021: the assistant tray must never turn a source into a source-sized JS
 * allocation. The shared cap and the format gate run BEFORE any read, and the
 * only read a recognized in-cap source gets is a window bounded by that cap.
 */
describe("Help assistant tray bounded intake (FBX-021)", () => {
  it("refuses an over-cap source and a non-photo before any full-source read", async () => {
    renderHelp({
      importDeps: { transcode: async () => new Uint8Array([1, 2, 3]), webpEncodeSupported: false },
    });
    const input = () => screen.getByTestId("chat-file-input");

    // Over the shared source cap: refused from `size` alone, zero reads.
    const overCap = new File([new Uint8Array(0)], "huge.jpg", { type: "image/jpeg" });
    Object.defineProperty(overCap, "size", { value: SOURCE_MAX_BYTES + 1 });
    const overCapRead = vi.fn();
    const overCapSlice = vi.fn();
    Object.defineProperty(overCap, "arrayBuffer", { value: overCapRead, configurable: true });
    Object.defineProperty(overCap, "slice", { value: overCapSlice, configurable: true });
    fireEvent.change(input(), { target: { files: [overCap] } });
    await screen.findByText(/over the 100 MB intake cap/);
    expect(overCapRead).not.toHaveBeenCalled();
    expect(overCapSlice).not.toHaveBeenCalled();

    // In cap but not a photo: one bounded header window, never the whole file.
    const notAPhoto = new File(["definitely not a photo"], "notes.txt", { type: "text/plain" });
    const fullRead = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperty(notAPhoto, "arrayBuffer", { value: fullRead, configurable: true });
    const sliceEnds: number[] = [];
    const realSlice = Blob.prototype.slice.bind(notAPhoto);
    Object.defineProperty(notAPhoto, "slice", {
      configurable: true,
      value: (start?: number, end?: number) => {
        sliceEnds.push(end ?? Number.NaN);
        return realSlice(start, end);
      },
    });
    fireEvent.change(input(), { target: { files: [notAPhoto] } });
    await screen.findByText(/is not a recognized photo/);
    expect(fullRead).not.toHaveBeenCalled();
    expect(sliceEnds.length).toBeGreaterThan(0);
    expect(Math.max(...sliceEnds)).toBeLessThanOrEqual(PROBE_BYTES);

    // Static: Help.tsx itself can never grow a whole-source read again.
    // Vitest may run from the repo root or apps/mobile — resolve by trial.
    let helpSource = "";
    for (const candidate of ["apps/mobile/src/screens/Help.tsx", "src/screens/Help.tsx"]) {
      try {
        helpSource = readFileSync(candidate, "utf8");
        break;
      } catch {
        // Not under this cwd — try the next candidate.
      }
    }
    if (!helpSource) throw new Error(`cannot locate Help.tsx from cwd ${process.cwd()}`);
    expect(helpSource).not.toMatch(/(?:file|source|blob)\s*\.\s*arrayBuffer\s*\(/);
    expect(helpSource).toContain("readSourceForImport");
  });
});
