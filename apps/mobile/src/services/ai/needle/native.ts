/**
 * Production Needle bridge over the `FindbackNeedle` native plugin (JNI
 * over the pinned needle3 engine). Web builds never construct this — the
 * factory throws a fail-closed `DriverError`-shaped Error when there is no
 * native platform, so callers keep the stub/test path without inventing
 * vectors.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  NEEDLE_MODEL_ID,
  NativeNeedleEmbedder,
  type NativeNeedleBridge,
} from "./embedder";

interface FindbackNeedlePlugin {
  isNeedleAvailable(): Promise<{ available: boolean }>;
  loadNeedleModel(args: { modelId: string; installedPath?: string }): Promise<{
    ready: boolean;
    dimension: number;
  }>;
  embeddingDimension(): Promise<{ dimension: number }>;
  embedNeedleTexts(args: { texts: string[] }): Promise<{ vectors: number[][] }>;
  initNeedleTools(args: { systemPrompt?: string; toolsJson?: string }): Promise<unknown>;
  completeNeedleJson(args: { input: string; maxNewTokens?: number }): Promise<{ output: string }>;
  unloadNeedleModel(): Promise<unknown>;
}

export class CapacitorNeedleBridge implements NativeNeedleBridge {
  readonly bridgeName = "needle-cact";

  private plugin(): FindbackNeedlePlugin {
    if (Capacitor.isNativePlatform() !== true) {
      throw new Error("Needle native bridge is absent on web");
    }
    return registerPlugin<FindbackNeedlePlugin>("FindbackNeedle");
  }

  async isNeedleAvailable(): Promise<boolean> {
    try {
      const result = await this.plugin().isNeedleAvailable();
      return result.available === true;
    } catch {
      return false;
    }
  }

  async embeddingDimension(): Promise<number> {
    const { dimension } = await this.plugin().embeddingDimension();
    return dimension;
  }

  async embedNeedleTexts(texts: string[]): Promise<number[][]> {
    const { vectors } = await this.plugin().embedNeedleTexts({ texts });
    return vectors;
  }

  async loadModel(args: { modelId: string; installedPath?: string }): Promise<number> {
    const result = await this.plugin().loadNeedleModel(args);
    if (result.ready !== true) throw new Error("Needle engine failed to load");
    return result.dimension;
  }

  async completeJson(input: string, maxNewTokens = 256): Promise<string> {
    const { output } = await this.plugin().completeNeedleJson({ input, maxNewTokens });
    return output;
  }

  async initTools(systemPrompt?: string, toolsJson?: string): Promise<void> {
    await this.plugin().initNeedleTools({ systemPrompt, toolsJson });
  }

  async unload(): Promise<void> {
    try {
      await this.plugin().unloadNeedleModel();
    } catch {
      // Unload is best-effort; residency state is re-probed on next use.
    }
  }
}

/**
 * Build the production embedder: load the resident (idempotent; throws
 * `model_not_installed` while weights are absent), then probe the engine
 * dimension (never assumed from config) and bind it. Callers keep the
 * stub/test path explicitly — this factory never falls back.
 */
export async function createNativeNeedleEmbedder(
  bridge: NativeNeedleBridge & {
    loadModel(args: { modelId: string; installedPath?: string }): Promise<number>;
  },
  options: { modelId?: string; installedPath?: string } = {},
): Promise<NativeNeedleEmbedder> {
  const modelId = options.modelId ?? NEEDLE_MODEL_ID;
  const dimension = await bridge.loadModel({ modelId, installedPath: options.installedPath });
  return new NativeNeedleEmbedder(bridge, dimension);
}
