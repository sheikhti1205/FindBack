import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";
import { Button } from "./Button";
import { useAppIdle } from "../hooks/appIdle";
import { claimUpdatePrompt, checkForUpdates, refreshInstalledUpdates, dismissUpdate, setUpdateIdle, useUpdateSnapshot } from "../services/updates/runtime";
import type { AndroidRelease } from "../services/updates/types";

/**
 * The ONLY unsolicited update surface.
 *
 * It opens only when the controller says a prompt is allowed (reader opted in,
 * release not dismissed) AND the app is genuinely idle: no dialog, no focused
 * editor, visible document.
 *
 * The shown release is latched locally rather than read from `pending` on every
 * render. Opening the dialog itself registers a modal layer, so the app stops
 * being idle the instant it appears — deriving the render from `pending` would
 * unmount the dialog that just opened it. The latch keeps it open until the
 * reader acts; Escape, back, outside-click, "Later" and "See what's new" all
 * dismiss durably, so the same release never asks again.
 */
export function UpdatePrompt() {
  const snapshot = useUpdateSnapshot();
  const { pathname } = useLocation();
  const idle = useAppIdle(pathname);
  const navigate = useNavigate();
  const [shown, setShown] = useState<AndroidRelease | null>(null);

  useEffect(() => {
    // Owner order 2026-11-06: check once when the app launches and propose the
    // build. Force skips the background interval so minutes-old builds appear.
    void refreshInstalledUpdates().then(() => checkForUpdates(true));
  }, []);

  useEffect(() => { setShown(null); }, [pathname]);

  useEffect(() => {
    setUpdateIdle(idle);
  }, [idle]);

  useEffect(() => {
    if (!idle || shown !== null) return;
    if (snapshot.pending !== null) setShown(claimUpdatePrompt());
  }, [idle, shown, snapshot.pending]);

  if (shown === null) return null;

  const dismiss = () => {
    dismissUpdate(shown.id);
    setShown(null);
  };

  return (
    <AdaptiveTaskSurface
      open
      title={`${shown.versionName} is ready`}
      description="A newer version of Norfold is available. Nothing changes until you choose."
      onClose={dismiss}
      footer={
        <>
          <Button variant="text" onClick={dismiss}>
            Later
          </Button>
          <Button
            onClick={() => {
              dismiss();
              navigate("/settings/updates");
            }}
          >
            See what's new
          </Button>
        </>
      }
    >
      <p className="text-sm text-on-surface-variant" data-testid="update-prompt-summary">
        {shown.summary}
      </p>
    </AdaptiveTaskSurface>
  );
}
