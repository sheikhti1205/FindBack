// Rendered-review harness: production components, fake storage,
// no model bytes, no backend sends. Import this module through Vite dev only.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { MotionConfig } from "framer-motion";
import { AiModelsRoute } from "../../apps/mobile/src/screens/AiModelsRoute";
import { AdvancedModelSupply } from "../../apps/mobile/src/screens/AiModelsRouteAdvanced";
import { ApplicationAiService } from "../../apps/mobile/src/services/ai/applicationAi";
import { QWEN_TEXT_MODEL_ID, NEEDLE_DESCRIPTOR } from "../../apps/mobile/src/services/ai/modelDescriptors";
import { StateSwap } from "../../apps/mobile/src/components/uiPrimitives";
import { PostList } from "../../apps/mobile/src/components/PostList";
import { makePost } from "../../apps/mobile/src/fixture/posts";
import { applyTheme } from "../../apps/mobile/src/theme";
import { applyAppearance, DEFAULT_APPEARANCE, type TextScaleId } from "../../apps/mobile/src/appearance";

const service = new ApplicationAiService({
  android: true,
  driver: {
    rootDir: async () => "/fixture-only",
    freeBytes: async () => 2_000_000_000,
    stagedSize: async () => 0,
    readJournalText: async () => null,
    hashFile: async () => { throw new Error("not installed"); },
    download: async () => { throw new Error("Fixture download disabled"); },
    cancelDownload: async () => {}, promoteFile: async () => {}, removeFile: async () => {},
  },
  smol: {
    bridgeName: "smolvlm2-litertlm",
    collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
    isVisionAvailable: async () => false,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {},
    cancelGeneration: async () => {}, describeImage: async function* () {},
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
    review: { render: (surface: string, theme?: string, scale?: TextScaleId, reduce?: boolean) => void; install: () => void; progress: () => void };
  }
}
window.review = {
  render: (surface: string, theme = "light", scale: TextScaleId = "standard", reduce = false) => {
    applyTheme({ theme: theme === "light" ? "light" : "dark", trueBlackDark: theme === "amoled" });
    applyAppearance({ ...DEFAULT_APPEARANCE, textScale: scale, reduceMotion: reduce ? "reduce" : "full" });
    root.render(<MemoryRouter><MotionConfig reducedMotion={reduce ? "always" : "never"}>
      {surface === "models" ? <AiModelsRoute service={service} /> : surface === "advanced" ? <AdvancedModelSupply service={service} /> : <MotionReview scrolled={surface === "scrolled"} />}
    </MotionConfig></MemoryRouter>);
  },
  install: () => {
    const id = NEEDLE_DESCRIPTOR.modelId;
    service.manager.dispatch(id, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(id, { type: "START" });
    service.manager.dispatch(id, { type: "VERIFY_START" });
    service.manager.dispatch(id, { type: "VERIFY_OK", actualSha256: NEEDLE_DESCRIPTOR.sha256 });
  },
  progress: () => {
    service.manager.dispatch(QWEN_TEXT_MODEL_ID, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(QWEN_TEXT_MODEL_ID, { type: "START" });
    service.manager.dispatch(QWEN_TEXT_MODEL_ID, { type: "PROGRESS", downloadedBytes: 100_000_000 });
  },
};
