// Rendered-review harness: production components, fake storage,
// no model bytes, no backend sends. Import this module through Vite dev only.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { MotionConfig } from "framer-motion";
import { DownloadedModels } from "../../apps/mobile/src/screens/DownloadedModels";
import { ApplicationAiService } from "../../apps/mobile/src/services/ai/applicationAi";
import { QWEN_TEXT_MODEL_ID, NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR } from "../../apps/mobile/src/services/ai/modelDescriptors";
import { StateSwap } from "../../apps/mobile/src/components/uiPrimitives";
import { PostList } from "../../apps/mobile/src/components/PostList";
import { makePost } from "../../apps/mobile/src/fixture/posts";
import { applyTheme } from "../../apps/mobile/src/theme";
import { applyAppearance, DEFAULT_APPEARANCE, type TextScaleId } from "../../apps/mobile/src/appearance";

const disk = new Map<string, string>();
let failRemoval = false;
const service = new ApplicationAiService({
  android: true,
  driver: {
    supportedAbis: async () => ["arm64-v8a"],
    rootDir: async () => "/fixture-only",
    freeBytes: async () => 2_000_000_000,
    stagedSize: async () => 0,
    readJournalText: async () => null,
    hashFile: async (path) => disk.get(path) ?? "",
    download: async () => { throw new Error("Fixture download disabled"); },
    cancelDownload: async () => {}, promoteFile: async () => {},
    removeFile: async (path) => {
      if (failRemoval && path.includes(QWEN_TEXT_MODEL_ID)) throw new Error("private fixture path /data/models");
      for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
    },
  },
  needle: {
    bridgeName: "needle-cact", isNeedleAvailable: async () => false,
    unload: async () => {}, loadModel: async () => 2, embeddingDimension: async () => 2,
    embedNeedleTexts: async () => [], initTools: async () => {}, completeJson: async () => "{}",
  },
  smol: {
    bridgeName: "smolvlm2-litertlm",
    isVisionAvailable: async () => false,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {},
    cancelGeneration: async () => {}, describeImage: async function* () {},
  },
  qwenText: {
    bridgeName: "qwen3-litertlm-text", isTextAvailable: async () => false,
    loadTextModel: async () => {}, unloadTextModel: async () => {},
    cancelGeneration: async () => {}, generateText: async function* () {},
  },
});
await service.ready;
await service.ensureCompatibility();

const states = ["loading", "empty", "error", "content"] as const;
function MotionReview({ scrolled = false }: { scrolled?: boolean }) {
  const [state, setState] = useState<(typeof states)[number]>("loading");
  const posts = state === "content" ? [makePost("review-post", { title: "Red umbrella" })] : [];
  return <div className="p-4">
    <div className="flex flex-wrap gap-2 mb-4">{states.map(s => <button key={s} onClick={() => setState(s)}>{s}</button>)}</div>
    <div data-testid="scroll-parent" style={scrolled ? { height: 250, overflow: "auto" } : {}}>
    <div style={scrolled ? { paddingTop: 100 } : {}}>
    <div data-testid="swap-parent" style={{ position: scrolled ? "static" : "relative", border: "1px solid currentColor" }}>
      <StateSwap stateKey={state}><div style={{ height: state === "loading" ? 200 : 100 }}>{state}</div></StateSwap>
    </div>
    <div data-testid="list-parent" style={{ position: scrolled ? "static" : "relative", marginTop: 24, border: "1px solid currentColor" }}>
      <PostList items={posts} loading={state === "loading"} loadingMore={false} hasMore={false}
        error={state === "error" ? "Could not load" : null} onLoadMore={async () => {}} density="compact" />
    </div>
    </div></div>
  </div>;
}

const mount = document.createElement("div");
mount.id = "review-root";
document.body.appendChild(mount);
document.getElementById("root")!.style.display = "none";
const root = createRoot(mount);
declare global {
  interface Window {
    review: { render: (surface: string, theme?: string, scale?: TextScaleId, reduce?: boolean) => void; install: () => void; progress: () => void; older: () => void; failRemoval: (fail: boolean) => void };
  }
}
window.review = {
  render: (surface: string, theme = "light", scale: TextScaleId = "standard", reduce = false) => {
    applyTheme({ theme: theme === "light" ? "light" : "dark", trueBlackDark: theme === "amoled" });
    applyAppearance({ ...DEFAULT_APPEARANCE, textScale: scale, reduceMotion: reduce ? "reduce" : "full" });
    root.render(<MemoryRouter><MotionConfig reducedMotion={reduce ? "always" : "never"}>
      {surface === "models" ? <DownloadedModels service={service} /> : <MotionReview scrolled={surface === "scrolled"} />}
    </MotionConfig></MemoryRouter>);
  },
  install: () => {
    const id = NEEDLE_DESCRIPTOR.modelId;
    const path = service.manager.stagingPathsFor("/fixture-only", id, NEEDLE_DESCRIPTOR.revision, NEEDLE_DESCRIPTOR.fileName).installedPath;
    disk.set(path, NEEDLE_DESCRIPTOR.sha256);
    service.manager.dispatch(id, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(id, { type: "START" });
    service.manager.dispatch(id, { type: "VERIFY_START" });
    service.manager.dispatch(id, { type: "VERIFY_OK", actualSha256: NEEDLE_DESCRIPTOR.sha256 });
  },
  progress: () => {
    const id = NEEDLE_DESCRIPTOR.modelId;
    service.manager.dispatch(id, { type: "DELETE" });
    service.manager.dispatch(id, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(id, { type: "START" });
    service.manager.dispatch(id, { type: "PROGRESS", downloadedBytes: 10_000_000 });
  },
  older: () => {
    service.manager.dispatch(QWEN_TEXT_MODEL_ID, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(QWEN_TEXT_MODEL_ID, { type: "START" });
    service.manager.dispatch(QWEN_TEXT_MODEL_ID, { type: "VERIFY_START" });
    const descriptor = service.registry.descriptorFor(QWEN_TEXT_MODEL_ID)!;
    const path = service.manager.stagingPathsFor("/fixture-only", descriptor.modelId, descriptor.revision, descriptor.fileName).installedPath;
    disk.set(path, descriptor.sha256);
    service.manager.dispatch(QWEN_TEXT_MODEL_ID, { type: "VERIFY_OK", actualSha256: descriptor.sha256 });
    const partial = SMOL_VISION_DESCRIPTOR;
    const staged = service.manager.stagingPathsFor("/fixture-only", partial.modelId, partial.revision, partial.fileName).stagingPath;
    disk.set(staged, partial.sha256);
    service.manager.dispatch(partial.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(partial.modelId, { type: "START" });
    service.manager.dispatch(partial.modelId, { type: "FAIL", reason: "transfer failed" });
  },
  failRemoval: (fail) => { failRemoval = fail; },
};
