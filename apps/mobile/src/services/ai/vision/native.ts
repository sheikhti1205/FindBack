import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { OfflineGenerationChunk, OfflineVisionNativeBridge, OfflineVisionRequest } from "../providers/offline";
import type { ProbeRecord } from "../deviceProbe";

export interface SmolPlugin {
  isVisionAvailable(): Promise<{ available: boolean }>;
  loadVisionModel(args: { modelId: string; backend: "cpu" | "gpu"; installedPath?: string; maxOutputTokens: number }): Promise<{ ready: boolean }>;
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
    const finish = () => { done = true; wake(); };
    const listener = await plugin.addListener("visionChunk", (event) => {
      if (event.generationId !== request.generationId) return;
      if (event.textDelta) chunks.push(event.textDelta);
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
    }
  }
}
