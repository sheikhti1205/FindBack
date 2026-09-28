import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type * as MapLibre from "maplibre-gl";

/** Vite emits the worker and its shared imports as assets, including for Capacitor. */
export function configureMapLibreWorker(maplibre: Pick<typeof MapLibre, "setWorkerUrl">): void {
  maplibre.setWorkerUrl(workerUrl);
}
