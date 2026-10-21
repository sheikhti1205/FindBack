import { Download } from "lucide-react";
import { SettingsGroup, SettingsPage, SettingsRow } from "../components/settings";
import { getApplicationAi } from "../services/ai/applicationAi";
import { useLocalIntelligenceService, type LocalIntelligenceService } from "../services/ai/localIntelligenceView";
import { LocalSearchHelperRow } from "./DownloadedModels";

export function LocalIntelligence({ service = getApplicationAi(), downloadsTo = "/settings/local-intelligence/downloads" }: {
  service?: LocalIntelligenceService;
  downloadsTo?: string;
}) {
  const { helper, phase } = useLocalIntelligenceService(service);
  return <SettingsPage title="Local intelligence" description="Small tools for search and report text. Separate from AI Chat." backTo="/settings">
    <SettingsGroup title="Smart Search" description="Normal search works without this helper.">
      <LocalSearchHelperRow service={service} descriptor={helper} phase={phase} />
    </SettingsGroup>
    <SettingsGroup title="Possible Matches" description="Possible Matches compares report text, category, date and location. Photo matching isn't available in this app yet.">
      <SettingsRow title="Text-based suggestions" description={service.android ? "Runs on this phone." : "Text matching needs the Android app."} />
    </SettingsGroup>
    <SettingsGroup title="On this device">
      <SettingsRow title="Downloaded models" description="Manage downloads and remove tools you no longer need." icon={Download} iconTone="neutral" route={downloadsTo} />
    </SettingsGroup>
  </SettingsPage>;
}
