import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Button } from "../components/Button";
import { UpdateChanges } from "../components/UpdateChanges";
import { announce } from "../components/LiveRegion";
import { PreferenceSwitchRow, SettingsGroup, SettingsPage, StatusPill } from "../components/settings";
import { APP_VERSION } from "../services/appCapabilities";
import type { UpdateCheckFailure, UpdateSnapshot } from "../services/updates/controller";
import type { AndroidRelease, ReleaseHistoryRecord } from "../services/updates/types";
import {
  checkForUpdates,
  markUpdateRead,
  refreshInstalledUpdates,
  setUpdatePopupEnabled,
  useUpdateSnapshot,
} from "../services/updates/runtime";
import { formatTimestamp } from "../utils/dates";
import { readBuildInfo } from "../services/buildInfo";

/** One human sentence per failure cause; never a raw transport or provider string. */
export function checkFailureCopy(code: UpdateCheckFailure): string {
  switch (code) {
    case "offline":
      return "No connection. Everything below is the last information saved on this device.";
    case "http":
      return "The update service answered with an error. Try again in a while.";
    case "invalid":
      return "The update information could not be read, so it was ignored.";
    case "untrusted":
      return "The update information did not come from the trusted source, so it was ignored.";
    case "timeout":
      return "The check took too long to answer.";
    case "backoff":
      return "Waiting a little before checking again.";
  }
}

function checkedAt(ms: number | null): string {
  if (ms === null) return "not yet";
  return formatTimestamp(new Date(ms).toISOString());
}

function checkStatusCopy(snapshot: UpdateSnapshot, native: boolean): { label: string; tone: "neutral" | "success" | "warning" | "error" } {
  const check = snapshot.lastCheck;
  if (check === null) return { label: "Not checked yet", tone: "neutral" };
  if (check.status === "error") return { label: "Couldn't check", tone: "warning" };
  if (!native) return { label: "History updated", tone: "neutral" };
  if (snapshot.installed === null) return { label: "Version unavailable", tone: "warning" };
  if (snapshot.eligible !== null) return { label: "Update available", tone: "warning" };
  return { label: "No compatible update", tone: "neutral" };
}

function historyState(release: AndroidRelease | ReleaseHistoryRecord, snapshot: UpdateSnapshot): string | null {
  if ("downloadStatus" in release) return release.downloadStatus === "none" ? "No files published" : "Archived beta";
  if (snapshot.installed !== null && release.versionCode === snapshot.installed.versionCode) {
    return "Installed";
  }
  if (release.id === snapshot.eligible?.id) return "Available";
  if (release.artifacts.length === 0) return "No files published";
  if (!release.accepted) return "Not accepted";
  return null;
}

function InstalledIdentity({ snapshot, native }: { snapshot: UpdateSnapshot; native: boolean }) {
  if (snapshot.installed !== null) {
    return (
      <p className="text-sm text-on-surface" data-testid="updates-installed">
        {APP_VERSION} · build {snapshot.installed.versionCode}
      </p>
    );
  }
  return (
    <p className="text-sm text-on-surface" data-testid="updates-installed">
      {native ? "This build can't confirm its own version" : "Web build"}
    </p>
  );
}

export function Updates() {
  const snapshot = useUpdateSnapshot();
  const native = Capacitor.isNativePlatform();
  const check = snapshot.lastCheck;
  const status = checkStatusCopy(snapshot, native);
  const [buildGitSha, setBuildGitSha] = useState("");
  useEffect(() => {
    let live = true;
    void readBuildInfo().then(info => { if (live) setBuildGitSha(info.buildGitSha ?? ""); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    // Read the installed identity, then one bounded check. Both are cheap and
    // cached; a failure is reported, never hidden.
    void refreshInstalledUpdates().then(() => checkForUpdates());
  }, []);

  // Opening this screen IS seeing the release. Mark it seen so the optional
  // popup cannot ask about a version the reader has just read about.
  useEffect(() => {
    for (const release of snapshot.history) markUpdateRead(release.id);
  }, [snapshot.history]);

  const checking = snapshot.checking;

  return (
    <div data-testid="updates-screen">
      <SettingsPage
        title="Updates & version history"
        description="What this build is, and what is newer."
        backTo="/settings"
      >
        <SettingsGroup title="This build">
          <div className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
            <div className="min-w-0">
              <InstalledIdentity snapshot={snapshot} native={native} />
              <p className="mt-1 text-sm text-on-surface-variant">
                {check === null
                  ? "Norfold checks for a newer version when you open this screen."
                  : check.status === "error"
                    ? checkFailureCopy(check.code ?? "offline")
                    : `Checked ${checkedAt(check.checkedAt)}.`}
              </p>
            </div>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </div>

          {snapshot.eligible !== null ? (
            <div className="px-3 pb-3">
              <p className="text-sm font-medium text-on-surface" data-testid="updates-eligible">
                {snapshot.eligible.versionName} is ready
              </p>
              <p className="mt-1 text-sm text-on-surface-variant">{snapshot.eligible.summary}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 px-3 pb-4">
            <Button
              variant="outline"
              loading={checking}
              onClick={() => void checkForUpdates().then((next) => {
                announce(
                  next.lastCheck?.status === "error"
                    ? "Couldn't check for updates."
                    : next.eligible !== null
                      ? "A newer version is available."
                       : !native ? "Version history updated."
                         : next.installed === null ? "This build can't confirm its own version."
                           : "No compatible update is available.",
                );
              })}
              data-testid="updates-check-button"
            >
              Check now
            </Button>
            {check?.status === "error" ? (
              <span className="text-sm text-on-surface-variant">Last checked {checkedAt(check.checkedAt)}.</span>
            ) : null}
          </div>
        </SettingsGroup>

        <SettingsGroup
          title="Update notices"
          description="Off by default: versions and changes stay here in Settings. Turn this on for a quiet card when a newer version is ready — only once per version, and never over something you're doing."
        >
          <PreferenceSwitchRow
            title="Show update notices"
            description="A single dismissible notice when a new version is ready."
            checked={snapshot.popupEnabled}
            onChange={(next) => {
              setUpdatePopupEnabled(next);
              announce(next ? "Update notices on." : "Update notices off.");
            }}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Version history"
          description={native ? undefined : "Web updates are deployed automatically; there is nothing to install here."}
        >
          {snapshot.history.length === 0 ? (
            <p className="px-3 py-3 text-sm text-on-surface-variant" data-testid="updates-history-empty">
              No version history is available on this device yet.
            </p>
          ) : (
            <ul className="divide-y divide-outline-variant" data-testid="updates-history">
              {snapshot.history.map((release) => {
                const state = historyState(release, snapshot);
                return (
                  <li key={release.id} className="px-3 py-3" data-testid="updates-history-item">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-on-surface">{release.versionName}</p>
                        <p className="mt-1 text-sm text-on-surface-variant">{release.summary}</p>
                        <UpdateChanges features={(snapshot.features ?? []).filter(feature => feature.releaseId === release.id)}
                          context={{ platform: native ? "android" : "web", buildGitSha, signedIn: true, capabilities: [], satisfiedPrerequisites: [] }} />
                        <p className="mt-1 text-xs text-on-surface-variant">
                          {formatTimestamp(release.publishedAt)}
                           {!("artifacts" in release) || release.artifacts.length === 0 ? " · announcement" : ""}
                        </p>
                      </div>
                      {state !== null ? <StatusPill tone="neutral">{state}</StatusPill> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SettingsGroup>
      </SettingsPage>
    </div>
  );
}
