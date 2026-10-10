import { Link } from "react-router";
import { AdvancedDisclosure, SettingsGroup, SettingsPage } from "../components/settings";

/** Authoritative Assistant disclosure, separate from the compact chat sheet. */
export function AiPrivacy() {
  return <SettingsPage title="AI & privacy" backTo="/settings/help" description="How FindBack handles optional AI requests.">
    <SettingsGroup title="How answers work">
      <p className="text-sm leading-relaxed">Automatic starts on this phone when ready. Your photo stays on this device unless you choose to share it for that message.</p>
      <p className="text-sm leading-relaxed">On-device processing keeps your photo on this device and never uses the internet. Cloud processing is sent only after you allow it, and only what you approved for that message.</p>
    </SettingsGroup>
    <SettingsGroup title="Your choices">
      <p className="text-sm leading-relaxed">Photos are never attached on their own. Only the photos you pick for a message are shared. Built-in help needs no connection and never analyzes a photo.</p>
      <Link to="/settings/ai/connections" className="inline-flex min-h-[48px] items-center text-sm underline">Cloud connections</Link>
    </SettingsGroup>
    <AdvancedDisclosure title="Technical details">
      <p className="text-sm leading-relaxed">Automatic picks only qualified options for your message. A failed on-device attempt keeps your draft instead of quietly switching. Model names, routing rules, capability tables, and runtime or schema details live here and in Diagnostics — never on the ordinary surface above.</p>
    </AdvancedDisclosure>
    <Link to="/settings/privacy" className="inline-flex min-h-[48px] items-center text-sm underline">Privacy settings</Link>
  </SettingsPage>;
}
