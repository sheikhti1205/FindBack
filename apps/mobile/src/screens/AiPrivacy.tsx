import { Link } from "react-router";
import { AdvancedDisclosure, SettingsGroup, SettingsPage } from "../components/settings";

/**
 * Authoritative AI disclosure, separate from the compact chat sheet.
 *
 * The copy follows the shipped surfaces: Chat is cloud-only (the provider the
 * reader chooses receives the messages), the local helpers that run on the
 * phone never reach a provider, and the retired Automatic/On-device-only/
 * Cloud-only switch is not described as if it still existed.
 */
export function AiPrivacy() {
  return <SettingsPage title="AI & privacy" backTo="/settings/help" description="How FindBack handles optional AI requests.">
    <SettingsGroup title="How answers work">
      <p className="text-sm leading-relaxed">Chat answers come from the cloud provider you pick in Settings → AI & models → Providers. That provider receives the messages you send and the conversation context needed to reply.</p>
      <p className="text-sm leading-relaxed">Search and report-field suggestions can run on this phone. Those requests stay on the device and are never sent to a provider.</p>
    </SettingsGroup>
    <SettingsGroup title="Your choices">
      <p className="text-sm leading-relaxed">You choose which provider and model Chat uses, and you can change it at any time. Chat history is held in the app&apos;s memory while the app is open, separate for each account, and it is gone when you close the app.</p>
      <Link to="/settings/ai/connections" className="inline-flex min-h-[48px] items-center text-sm underline">Providers</Link>
    </SettingsGroup>
    <AdvancedDisclosure title="Technical details">
      <p className="text-sm leading-relaxed">Routing rules, model qualification tables, and runtime or schema details live here and in Diagnostics — never on the ordinary surface above.</p>
    </AdvancedDisclosure>
    <Link to="/settings/privacy" className="inline-flex min-h-[48px] items-center text-sm underline">Privacy settings</Link>
  </SettingsPage>;
}
