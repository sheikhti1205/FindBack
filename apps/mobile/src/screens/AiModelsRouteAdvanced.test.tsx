// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ApplicationAiService } from "../services/ai/applicationAi";
import { SUPPLY_CANDIDATES } from "../services/ai/modelSupply";
import { AdvancedModelSupply } from "./AiModelsRouteAdvanced";

afterEach(cleanup);

function fixture() {
  const descriptor = SUPPLY_CANDIDATES.find((d) => d.modelId === "granite-3.3-2b-instruct-q4_0")!;
  const evaluations: unknown[] = []; const imports: unknown[] = [];
  const service = {
    android: true, registry: { descriptors: [descriptor] },
    subscribe: () => () => {}, snapshot: () => 0,
    manager: { statusOf: () => ({ download: "installed", checksumVerified: true }) },
    compatibility: () => ({ compatible: true }), notice: () => null,
    importLocal: async (options: unknown) => { imports.push(options); return descriptor.modelId; },
    evaluate: async (_modelId: string, options: unknown) => { evaluations.push(options); return "A test answer"; },
    verify: async () => {}, remove: async () => {},
  } as unknown as ApplicationAiService;
  return { service, evaluations, imports };
}

it("requires opt-in and an explicit action before model evaluation", async () => {
  const f = fixture(); render(<AdvancedModelSupply service={f.service} />);
  expect(f.evaluations).toEqual([]);
  fireEvent.change(screen.getByLabelText("Evaluation prompt"), { target: { value: "Say hello" } });
  expect((screen.getByRole("button", { name: "Run evaluation" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("I agree to run this evaluation on my phone"));
  fireEvent.click(screen.getByRole("button", { name: "Run evaluation" }));
  expect(await screen.findByText("A test answer")).toBeTruthy();
  expect(f.evaluations).toHaveLength(1);
  expect(f.evaluations[0]).toMatchObject({ optIn: true, prompt: "Say hello", signal: expect.any(AbortSignal) });
});

it("routes file selection through the canonical native import service", async () => {
  const f = fixture(); render(<AdvancedModelSupply service={f.service} />);
  fireEvent.click(screen.getByRole("button", { name: "Import model files" }));
  await screen.findByText("Import finished.");
  expect(f.imports).toHaveLength(1);
  expect(f.imports[0]).toMatchObject({ modelId: "granite-3.3-2b-instruct-q4_0", signal: expect.any(AbortSignal) });
});

it("cancels evaluation and never renders an answer arriving after cancellation", async () => {
  const f = fixture();
  f.service.evaluate = async (_modelId, options) => new Promise<string>((resolve) => {
    options.signal!.addEventListener("abort", () => resolve("Late answer must not show"), { once: true });
  });
  render(<AdvancedModelSupply service={f.service} />);
  fireEvent.change(screen.getByLabelText("Evaluation prompt"), { target: { value: "hello" } });
  fireEvent.click(screen.getByLabelText("I agree to run this evaluation on my phone"));
  fireEvent.click(screen.getByRole("button", { name: "Run evaluation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel operation" }));
  expect(await screen.findByText("Operation cancelled.")).toBeTruthy();
  expect(screen.queryByText("Late answer must not show")).toBeNull();
});

it("shows the service's failed download result when the download promise settles normally", async () => {
  const f = fixture();
  f.service.manager.statusOf = () => ({ download: "not-installed", checksumVerified: false }) as ReturnType<ApplicationAiService["manager"]["statusOf"]>;
  let reason: string | null = null;
  f.service.notice = () => reason;
  f.service.download = async () => { reason = "Download stopped (HTTP_403)."; };
  render(<AdvancedModelSupply service={f.service} />);
  fireEvent.click(screen.getByRole("button", { name: "Download model" }));
  expect(await screen.findByText("Download stopped (HTTP_403).")).toBeTruthy();
});

it("passes the explicit LiteRT vision choice to local import instead of assuming text", async () => {
  const f = fixture(); render(<AdvancedModelSupply service={f.service} />);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "new-import" } });
  fireEvent.change(screen.getByLabelText("Artifact format"), { target: { value: "litertlm:vision" } });
  fireEvent.change(screen.getByLabelText("Model license"), { target: { value: "Apache-2.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Import local file" }));
  await screen.findByText("Import finished.");
  expect(f.imports[0]).toMatchObject({ format: "litertlm", modality: "vision", license: "Apache-2.0" });
});

it("passes the explicit LiteRT vision choice and exact identity to URL import", async () => {
  const f = fixture(); const inputs: unknown[] = [];
  f.service.importUrl = async (input) => { inputs.push(input); return f.service.registry.descriptors[0]!.modelId; };
  render(<AdvancedModelSupply service={f.service} />);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "new-import" } });
  fireEvent.change(screen.getByLabelText("Artifact format"), { target: { value: "litertlm:vision" } });
  fireEvent.change(screen.getByLabelText("Model license"), { target: { value: "Apache-2.0" } });
  fireEvent.click(screen.getByText("Import from an HTTPS URL"));
  fireEvent.change(screen.getByLabelText("Model URL"), { target: { value: "https://example.org/vision.litertlm" } });
  fireEvent.change(screen.getByLabelText("Expected SHA-256"), { target: { value: "b".repeat(64) } });
  fireEvent.change(screen.getByLabelText("Exact byte count"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Import URL" }));
  await screen.findByText("Import finished.");
  expect(inputs[0]).toMatchObject({ format: "litertlm", modality: "vision", sha256: "b".repeat(64), bytes: 123 });
});

it("sends language and projector mirrors independently in one canonical bundle transaction", async () => {
  const f = fixture(); const bundle = SUPPLY_CANDIDATES.find((d) => d.modelId === "lfm2-vl-450m-q4_0")!;
  const calls: unknown[] = [];
  const service = { ...f.service, registry: { descriptors: [bundle] } } as unknown as ApplicationAiService;
  service.manager.statusOf = () => ({ download: "not-installed", checksumVerified: false }) as ReturnType<ApplicationAiService["manager"]["statusOf"]>;
  service.download = async (id, mirrors) => { calls.push({ id, mirrors }); };
  render(<AdvancedModelSupply service={service} />);
  fireEvent.click(screen.getByText("Same-byte HTTPS mirrors (optional)"));
  fireEvent.change(screen.getByLabelText(`Mirror for ${bundle.fileName}`), { target: { value: "https://mirror.example.org/language.gguf" } });
  fireEvent.change(screen.getByLabelText(`Mirror for ${bundle.companions![0]!.fileName}`), { target: { value: "https://mirror.example.org/projector.gguf" } });
  fireEvent.click(screen.getByRole("button", { name: "Download model" }));
  await screen.findByRole("button", { name: "Download model" });
  expect(calls[0]).toEqual({ id: bundle.modelId, mirrors: { [bundle.fileName]: "https://mirror.example.org/language.gguf", [bundle.companions![0]!.fileName]: "https://mirror.example.org/projector.gguf" } });
});

it("provides the shipped upstream license and attribution text without a remote lookup", () => {
  const f = fixture(); render(<AdvancedModelSupply service={f.service} />);
  fireEvent.click(screen.getByText("License and attribution"));
  expect(screen.getByText(/Licensed under the Apache License/i)).toBeTruthy();
  expect(screen.getByText(/Model artifact published by ibm-granite\/granite-3.3-2b-instruct-GGUF/)).toBeTruthy();
});
