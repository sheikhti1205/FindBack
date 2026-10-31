/**
 * Production boot: one shared `OfflineModelManager` plus one `AiOrchestrator`
 * with the retained local tool runtimes attached.
 *
 * Asset pins are injected data, never invented here: the boot refuses
 * unpinned models exactly like the manager gate does (MISSING_PIN). Backend
 * seams are injected by platform code — web builds pass no seams, so every
 * model runtime stays unavailable and routes fail closed with NO_RUNTIME
 * instead of reaching for cloud.
 */
import { OfflineModelManager, type OfflineAssetPin, type OfflineManagerOptions } from "./offlineModelManager";
import { AiOrchestrator } from "./orchestrator/AiOrchestrator";
import type {
  ProductionEmbeddingBackend,
  ProductionRuntimeDeps,
  ProductionRuntimeId,
  ProductionTextBackend,
} from "./orchestrator/productionRuntimes";

export interface ProductionBootOptions extends Pick<ProductionRuntimeDeps, "text" | "embedding"> {
  readonly pins: readonly OfflineAssetPin[];
  readonly managerOptions?: OfflineManagerOptions;
}

export interface ProductionBoot {
  readonly manager: OfflineModelManager;
  readonly orchestrator: AiOrchestrator;
  readonly runtimes: readonly ProductionRuntimeId[];
  readonly text?: ProductionTextBackend;
  readonly embedding?: ProductionEmbeddingBackend;
}

/**
 * Build the production local-intelligence stack. Throws on duplicate asset ids
 * (the manager's own fail-closed rule); registers only the runtimes whose
 * backend seam was injected.
 */
export function bootProductionAi(options: ProductionBootOptions): ProductionBoot {
  const manager = new OfflineModelManager(options.pins, options.managerOptions);
  const orchestrator = new AiOrchestrator();
  const runtimes = orchestrator.attachProductionRuntimes({
    manager,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.embedding === undefined ? {} : { embedding: options.embedding }),
  });
  return {
    manager,
    orchestrator,
    runtimes,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.embedding === undefined ? {} : { embedding: options.embedding }),
  };
}
