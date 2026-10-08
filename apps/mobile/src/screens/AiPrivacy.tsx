import { Link } from "react-router";
import { SettingsGroup, SettingsPage } from "../components/settings";

/** Authoritative Assistant disclosure, separate from the compact chat sheet. */
export function AiPrivacy() {
  return <SettingsPage title="AI & privacy" backTo="/settings/help" description="How FindBack handles optional AI requests.">
    <SettingsGroup title="Automatic and model choices">
      <p className="text-sm leading-relaxed">Automatic chooses only models qualified for your message. Installed on-device photo analysis is tried first for photos. No on-device text-chat model is qualified in this build; text can use a connected cloud model or built-in FindBack guidance. Background tools for report fields and matching are separate from chat.</p>
      <p className="text-sm leading-relaxed">A pinned incompatible model is refused and your draft is kept. A failed local photo send does not silently switch to cloud. Cloud-only skips local generation. On-device only never reads a cloud key or sends your request to a cloud AI provider.</p>
    </SettingsGroup>
    <SettingsGroup title="Connected providers">
      <p className="text-sm leading-relaxed">Cloud answers need an internet connection. Your question, approved photos and conversation context for that request are sent to the connected provider. Answers may vary. Keys stay on this device. OpenRouter's default uses its free route; paid or unknown-price models are blocked here unless the app can collect the required consent.</p>
      <Link to="/settings/ai/connections" className="inline-flex min-h-[48px] items-center text-sm underline">Cloud connections</Link>
    </SettingsGroup>
    <SettingsGroup title="Photos and built-in help">
      <p className="text-sm leading-relaxed">Photos are never attached automatically. Only photos you select for that message are approved. Android prepares a bounded, metadata-free still derivative on the device; supported Motion Photos use the still frame, not their video. Preparation or analysis failures keep your draft for Retry or Remove.</p>
      <p className="text-sm leading-relaxed">Built-in guidance needs no provider and sends nothing to AI. It answers supported FindBack app questions and is labelled as built-in, never as a model response. It cannot analyze a photo. On-device inference needs Android and an installed, verified, compatible model.</p>
    </SettingsGroup>
    <Link to="/settings/privacy" className="inline-flex min-h-[48px] items-center text-sm underline">Privacy settings</Link>
  </SettingsPage>;
}
