import { useEffect, useState } from "react";
import { Cloud, Cpu, SlidersHorizontal } from "lucide-react";
import { useAuth } from "../auth";
import { announce } from "../components/LiveRegion";
import {
  AdvancedDisclosure,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import { aiCredentials } from "../services/aiCredentials";
import {
  loadSeededAiPreferences,
  updateAiPreferences,
  type AssistantModePreference,
} from "../services/ai/aiPreferences";

type CloudState = "unknown" | "connected" | "not-connected";

/**
 * Consumer AI root (`/settings/ai`). Presentation only: the AI mode radios
 * read/write the single authoritative account-scoped store
 * (`aiPreferences.assistantMode`, no new semantics), the cloud summary is a
 * read-only look at the OpenRouter vault slot, and every row routes to a
 * detail screen the integrator mounts. Automatic is local-first.
 * A legacy stored offline-first value migrates to on-device-only (fail
 * closed), which IS offered, so no hidden-value note is needed.
 */
export function AiSettings({ accountId }: { accountId?: string }) {
  const { user } = useAuth();
  const account = accountId ?? user?.id ?? "local";
  const [mode, setMode] = useState<AssistantModePreference>(
    () => loadSeededAiPreferences(account).assistantMode,
  );
  const [cloud, setCloud] = useState<CloudState>("unknown");

  useEffect(() => {
    setMode(loadSeededAiPreferences(account).assistantMode);
  }, [account]);

  useEffect(() => {
    let alive = true;
    setCloud("unknown");
    if (!account || account === "local") {
      setCloud("not-connected");
      return () => {
        alive = false;
      };
    }
    void aiCredentials
      .get(account)
      .then((value) => {
        if (alive) setCloud(value === null ? "not-connected" : "connected");
      })
      .catch(() => {
        if (alive) setCloud("not-connected");
      });
    return () => {
      alive = false;
    };
  }, [account]);

  function chooseMode(next: OfferedMode) {
    // Single authoritative write: the same store the Help send-gate reads.
    // No legacy mirrored write — the legacy key is migration-source only.
    setMode(updateAiPreferences(account, { assistantMode: next }).assistantMode);
    announce(`AI mode ${MODE_COPY[next].label}.`);
  }

  return (
    <SettingsPage
      title="AI & intelligence"
      description="Downloaded on-device tools and optional cloud connections. Core features work without AI setup."
      backTo="/settings"
    >
      <SettingsGroup
        title="AI mode"
        description="How FindBack answers when you ask for help."
      >
        <div
          role="radiogroup"
          aria-label="AI mode"
          className="fb-ai-mode-list"
        >
          {(Object.keys(MODE_COPY) as OfferedMode[]).map((option) => {
            const checked = mode === option;
            return (
              <label
                key={option}
                className="fb-ai-mode-option"
              >
                <input
                  type="radio"
                  name="ai-mode"
                  value={option}
                  checked={checked}
                  onChange={() => chooseMode(option)}
                  className="sr-only"
                />
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span aria-hidden="true">{checked ? "●" : "○"}</span>
                  {MODE_COPY[option].label}
                </span>
                <span className="text-xs text-on-surface-variant">
                  {MODE_COPY[option].detail}
                </span>
              </label>
            );
          })}
        </div>
        <AdvancedDisclosure title="How Automatic chooses">
          <p>
            Automatic tries on-device processing first when a compatible tool is
            downloaded. Text may fall back to a connected cloud model only after
            local AI is unavailable or fails. Stopping a request never sends to
            cloud. Model names, routing rules, and capability details live in
            Advanced and Diagnostics.
          </p>
        </AdvancedDisclosure>
      </SettingsGroup>

      <SettingsGroup title="Options">
        <SettingsRow
          title="On-device AI"
          description="Tools that run on this phone once downloaded."
          icon={Cpu}
          iconTone="ai"
          route="/settings/ai/models"
        />
        <SettingsRow
          title="Cloud connections"
          description={
            cloud === "connected"
              ? "OpenRouter Connected"
              : cloud === "not-connected"
                ? "OpenRouter Not connected"
                : "OpenRouter · checking…"
          }
          icon={Cloud}
          iconTone="ai"
          value={
            cloud === "unknown" ? null : (
              <StatusPill tone={cloud === "connected" ? "success" : "neutral"}>
                {cloud === "connected" ? "Connected" : "Not connected"}
              </StatusPill>
            )
          }
          route="/settings/ai/connections"
        />
        <SettingsRow
          title="Advanced"
          description="Performance tests and technical details."
          icon={SlidersHorizontal}
          iconTone="ai"
          route="/settings/ai/advanced"
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/**
 * Every preference mode is offered here: a legacy stored offline-first
 * value migrates (fail closed) to on-device-only, which is selectable, so
 * there is no hidden-value case to preserve.
 */
type OfferedMode = AssistantModePreference;

const MODE_COPY: Record<OfferedMode, { label: string; detail: string }> = {
  automatic: {
    label: "Automatic",
    detail: "On-device first when ready. Your photo stays on this device; cloud is used only after you allow it.",
  },
  "on-device-only": {
    label: "On-device only",
    detail: "On-device processing. Your photo stays on this device and is never sent to the internet.",
  },
  "cloud-only": {
    label: "Cloud only",
    detail: "Cloud processing, sent only after you allow it. Never runs on this device.",
  },
};
