import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { OfflineGenerationChunk, OfflineVisionNativeBridge, OfflineVisionRequest } from "../providers/offline";
import type { ProbeRecord } from "../deviceProbe";
import { diag } from "../../diag";

export interface SmolPlugin {
  isVisionAvailable(): Promise<{ available: boolean }>;
  loadVisionModel(args: { modelId: string; backend: "cpu" | "gpu"; installedPath?: string; maxOutputTokens: number; evaluation?: boolean }): Promise<{ ready: boolean }>;
  unloadVisionModel(): Promise<unknown>;
  describeImage(args: OfflineVisionRequest): Promise<unknown>;
  cancelGeneration(args: { generationId: string }): Promise<unknown>;
  collectDeviceFacts(): Promise<Record<string, unknown>>;
  measureBackend(args: { modelId: string; modelRev: string; installedPath: string; backend: "cpu" | "gpu"; corpusVersion: string }): Promise<{ record: ProbeRecord | null }>;
  addListener(name: "visionChunk", callback: (event: { generationId: string; textDelta?: string; done?: boolean; cancelled?: boolean; error?: string }) => void): Promise<PluginListenerHandle>;
}

/** Listener installed before inference; generation ids isolate calls and cancellation. */
export class CapacitorSmolVlmBridge implements OfflineVisionNativeBridge {
  readonly bridgeName = "smolvlm2-litertlm";
  private plugin(): SmolPlugin {
    if (Capacitor.getPlatform() !== "android") throw new Error("SmolVLM requires Android");
    return registerPlugin<SmolPlugin>("FindbackSmolVlm");
  }
  async isVisionAvailable(): Promise<boolean> {
    return (await this.plugin().isVisionAvailable()).available;
  }
  async loadVisionModel(args: Parameters<OfflineVisionNativeBridge["loadVisionModel"]>[0]): Promise<void> {
    if ((await this.plugin().loadVisionModel(args)).ready !== true) throw new Error("SmolVLM load failed");
  }
  async unloadVisionModel(): Promise<void> { await this.plugin().unloadVisionModel(); }
  async cancelGeneration(generationId: string): Promise<void> { await this.plugin().cancelGeneration({ generationId }); }
  collectDeviceFacts(): Promise<Record<string, unknown>> { return this.plugin().collectDeviceFacts(); }
  async measureBackend(args: Parameters<SmolPlugin["measureBackend"]>[0]): Promise<ProbeRecord | null> {
    return (await this.plugin().measureBackend(args)).record;
  }
  async *describeImage(request: OfflineVisionRequest, signal: AbortSignal): AsyncGenerator<OfflineGenerationChunk> {
    if (signal.aborted) return;
    const plugin = this.plugin();
    const chunks: string[] = [];
    let done = false;
    let failure: Error | undefined;
    let cancellation: Promise<unknown> | undefined;
    let wake = () => {};
    const started = performance.now();
    let chunkCount = 0;
    let firstChunkMs = 0;
    let lastChunkMs = 0;
    let chunkIntervalMs = 0;
    let minIntervalMs = 0;
    let maxIntervalMs = 0;
    const cadence = (event: string) => diag(event, {
      chunkCount, firstChunkMs, lastChunkMs, chunkIntervalMs, minIntervalMs, maxIntervalMs,
      meanIntervalMs: chunkCount > 1 ? (lastChunkMs - firstChunkMs) / (chunkCount - 1) : 0,
    });
    const finish = () => { done = true; wake(); };
    const listener = await plugin.addListener("visionChunk", (event) => {
      if (done || signal.aborted || event.generationId !== request.generationId) return;
      if (event.textDelta) {
        const ms = performance.now() - started;
        chunkIntervalMs = chunkCount > 0 ? ms - lastChunkMs : 0;
        if (chunkCount === 0) firstChunkMs = ms;
        else {
          minIntervalMs = chunkCount === 1 ? chunkIntervalMs : Math.min(minIntervalMs, chunkIntervalMs);
          maxIntervalMs = Math.max(maxIntervalMs, chunkIntervalMs);
        }
        lastChunkMs = ms;
        chunkCount++;
        cadence("ai.stream.bridge.chunk");
        chunks.push(event.textDelta);
      }
      if (event.error) failure = new Error(event.error);
      if (event.done || event.cancelled || event.error) done = true;
      wake();
    });
    const cancel = () => cancellation ??= plugin.cancelGeneration({ generationId: request.generationId }).catch(() => undefined);
    const abort = () => {
      void cancel();
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      const inference = plugin.describeImage(request).then(finish, () => {
        failure = new Error("On-device vision generation failed"); finish();
      });
      while (!done || chunks.length > 0) {
        if (signal.aborted) return;
        if (chunks.length > 0) yield { textDelta: chunks.shift()! };
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
      await inference;
      if (failure) throw failure;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!done || signal.aborted) await cancel();
      await listener.remove();
      cadence("ai.stream.bridge.end");
    }
  }
}
