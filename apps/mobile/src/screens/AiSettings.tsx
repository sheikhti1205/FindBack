import { useEffect, useState } from "react";
import { Cloud, Cpu, SlidersHorizontal } from "lucide-react";
import { useAuth } from "../auth";
import { announce } from "../components/LiveRegion";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import { aiCredentials } from "../services/aiCredentials";
import {
  loadAssistantMode,
  saveAssistantMode,
  type AssistantMode,
} from "./AiModels";

type CloudState = "unknown" | "connected" | "not-connected";

/**
 * Consumer AI root (`/settings/ai`). Presentation only: the AI mode radios
 * read/write the real assistant-mode store (`AiModels.loadAssistantMode` /
 * `saveAssistantMode`, no new semantics), the cloud summary is a read-only
 * look at the OpenRouter vault slot, and every row routes to a detail
 * screen the integrator mounts. Offline-first is never offered here.
 */
export function AiSettings({ accountId }: { accountId?: string }) {
  const { user } = useAuth();
  const account = accountId ?? user?.id ?? "local";
  const [mode, setMode] = useState<AssistantMode>(() => loadAssistantMode(account));
  const [cloud, setCloud] = useState<CloudState>("unknown");

  useEffect(() => {
    setMode(loadAssistantMode(account));
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
    setMode(next);
    saveAssistantMode(account, next);
    announce(`AI mode ${MODE_COPY[next].label}.`);
  }

  return (
    <SettingsPage
      title="AI & intelligence"
      description="On-device tools and cloud connections. Everything here works without technical setup."
      backTo="/settings"
    >
      <SettingsGroup
        title="AI mode"
        description="How FindBack answers when you ask for help."
      >
        <div
          role="radiogroup"
          aria-label="AI mode"
          className="flex flex-col gap-2"
        >
          {(Object.keys(MODE_COPY) as OfferedMode[]).map((option) => {
            const checked = mode === option;
            return (
              <label
                key={option}
                className="flex min-h-[48px] cursor-pointer flex-col justify-center gap-0.5 rounded-m3-sm border border-outline-variant px-3 py-2 hover:bg-surface-container focus-within:outline-2 focus-within:outline-solid focus-within:outline-offset-2 focus-within:outline-focus"
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
        {mode === "offline-first" ? (
          <p role="note" className="text-xs text-on-surface-variant">
            Offline-first is set on this account but is not offered in this
            build, so it stays exactly as it is.
          </p>
        ) : null}
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
 * Modes this build can honor. Offline-first stays hidden until policy
 * enables it; a stored offline-first value is kept, never offered.
 */
type OfferedMode = Exclude<AssistantMode, "offline-first">;

const MODE_COPY: Record<OfferedMode, { label: string; detail: string }> = {
  auto: {
    label: "Automatic",
    detail: "FindBack picks the safest available option.",
  },
  "offline-only": {
    label: "On-device only",
    detail: "Answers stay on this phone. Needs downloaded on-device tools.",
  },
  "cloud-only": {
    label: "Cloud only",
    detail: "Never runs on-device tools.",
  },
};
