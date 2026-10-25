import { useEffect, useState } from "react";
import { Cpu, KeyRound, Smartphone, Sparkles } from "lucide-react";
import { useAuth } from "../auth";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
} from "../components/settings";
import { aiCredentials } from "../services/aiCredentials";
import {
  CLOUD_DEFAULT_ROUTE,
  CLOUD_PROVIDER_LABELS,
  loadCloudModelPreferences,
  type CloudProvider,
} from "../services/ai/cloudModelPreferences";

type CloudState = "unknown" | "connected" | "not-connected";

/**
 * Consumer AI root (`/settings/ai`). Presentation only: the cloud summary is
 * a read-only look at the vault slot of the provider Chat actually uses, and
 * every row routes to a detail screen the integrator mounts.
 *
 * The summary is provider-scoped on purpose. Ten cloud providers can each
 * hold their own key, so a line that read one slot while speaking for all of
 * them would be wrong for every setup but one. The provider named here is the
 * one behind the saved Chat model, and the copy names it.
 *
 * The former "AI mode" radio group is gone: Chat is cloud-only now, so an
 * Automatic/On-device/Cloud switch no longer describes what the app does. The
 * privacy decision that still exists — which local tools run on this phone —
 * lives under Local intelligence, and the cloud decisions (provider key,
 * model) live under AI Chat.
 */
export function AiSettings({ accountId }: { accountId?: string }) {
  const { user } = useAuth();
  const account = accountId ?? user?.id ?? "local";
  const [cloud, setCloud] = useState<CloudState>("unknown");
  const [provider, setProvider] = useState<CloudProvider>(CLOUD_DEFAULT_ROUTE.provider);

  useEffect(() => {
    let alive = true;
    setCloud("unknown");
    if (!account || account === "local") {
      setCloud("not-connected");
      return () => {
        alive = false;
      };
    }
    const active = loadCloudModelPreferences(account).defaultModel?.provider ?? CLOUD_DEFAULT_ROUTE.provider;
    setProvider(active);
    void aiCredentials
      .get(account, active)
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

  const providerLabel = CLOUD_PROVIDER_LABELS[provider];
  // Without an account there is no key slot at all: naming a provider here
  // would put an implementation default (OpenRouter) on screen as if the
  // reader had chosen it.
  const signedIn = account !== "local" && account !== "";
  const cloudDescription = !signedIn
    ? "Sign in to add a provider key for Chat."
    : cloud === "unknown"
      ? `Your ${providerLabel} key for Chat.`
      : cloud === "connected"
        ? `Your ${providerLabel} key for Chat. Connected.`
        : `Your ${providerLabel} key for Chat. No key saved yet.`;

  return (
    <SettingsPage
      title="AI & intelligence"
      description="Optional cloud chat and the local tools stored on this phone. Core features work without any AI setup."
      backTo="/settings"
    >
      <SettingsGroup
        title="AI Chat"
        description="Chat uses a cloud provider. Your provider receives the messages you send; FindBack's core features don't need a key."
      >
        <SettingsRow
          title="Providers"
          description={cloudDescription}
          icon={KeyRound}
          iconTone="ai"
          route="/settings/ai/connections"
        />
        <SettingsRow
          title="Models"
          description="Choose the model Chat uses, and keep favorites for next time."
          icon={Sparkles}
          iconTone="ai"
          route="/settings/ai/chat-models"
        />
      </SettingsGroup>
      <SettingsGroup
        title="On this device"
        description="Tools that run on this phone once downloaded."
      >
        <SettingsRow
          title="Local intelligence"
          description="Search and report-text tools that run here. Downloaded models are managed under it."
          icon={Cpu}
          iconTone="ai"
          route="/settings/local-intelligence"
        />
        <SettingsRow
          title="On-device AI"
          description="Photo analysis and other models that run on this phone."
          icon={Smartphone}
          iconTone="ai"
          route="/settings/ai/models"
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
