import { Button } from "./Button";
import type { AppUpdateState } from "../services/updates/native";

function outcome(state: AppUpdateState): string {
  switch (state.kind) {
    case "idle": return "";
    case "downloading": return "Downloading update… You can keep using Norfold.";
    case "verifying": return "Checking the update before it can be installed…";
    case "ready": return "Download checked. Install when you're ready; Android will ask you to confirm.";
    case "needs-permission": return "Android asks you to allow updates from Norfold. Open Android settings, allow it if you choose, then return here and tap Install update.";
    case "needs-confirmation": return "Continue to Android to confirm the update. If its confirmation was closed, cancel here and try again.";
    case "installing": return "Waiting for Android. Follow its installation prompt, then return to Norfold.";
    case "installed": return "This device is running the updated app. Your existing data stays in place.";
    case "cancelled": return "Update cancelled. You can download it again when you're ready.";
    case "failed": return state.code === "storage" ? "There isn't enough free space for this update. Free some space and try again."
      : ["signature","identity","integrity","compatibility","version","origin","metadata"].includes(state.code)
        ? "This download couldn't be verified for your app. It hasn't been installed. Check for updates again."
        : state.code === "interrupted" ? "The download was interrupted. Download it again when you're ready."
          : "The update couldn't finish. You can check again or retry the download.";
  }
}

/** Inline status, not a blocking modal or a second download owner. */
export function UpdateJob({state,onInstall,onCancel,onPermission}: {
  state: AppUpdateState; onInstall:()=>void; onCancel:()=>void; onPermission:()=>void;
}) {
  if (state.kind === "idle") return null;
  const cancellable=["downloading","verifying","ready","needs-permission","needs-confirmation","installing"].includes(state.kind);
  return <div className="px-3 py-3" data-testid="update-job">
    <p role="status" className="text-sm text-on-surface-variant">{outcome(state)}</p>
    {state.kind === "downloading" ? <div className="mt-2">
      <progress aria-label="Update download" value={state.received} max={state.total} className="h-1 w-full accent-primary" />
      <p className="mt-1 text-xs text-on-surface-variant">{Math.floor(100*state.received/state.total)}%</p>
    </div> : null}
    <div className="mt-2 flex flex-wrap gap-2">
      {state.kind === "needs-permission" ? <Button variant="outline" onClick={onPermission}>Open Android settings</Button> : null}
      {["ready","needs-permission","needs-confirmation"].includes(state.kind)
        ? <Button onClick={onInstall}>{state.kind === "needs-confirmation" ? "Continue installation" : "Install update"}</Button> : null}
      {cancellable ? <Button variant="text" onClick={onCancel}>{state.kind === "downloading" ? "Cancel download" : "Cancel update"}</Button> : null}
    </div>
  </div>;
}
