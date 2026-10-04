import { useEffect, useState } from "react";
import { Bell, LifeBuoy, Sparkles } from "lucide-react";
import { AdvancedDisclosure, SettingsGroup, SettingsPage, SettingsRow } from "../components/settings";
import { readBuildInfo, type BuildInfo } from "../services/buildInfo";
import { APP_VERSION, BACKEND_SCHEMA_VERSION, CAPABILITIES_VERSION } from "../services/appCapabilities";
import "./About.css";

function shortSha(sha: string | null | undefined): string {
  if (!sha || sha === "unknown") return "unknown";
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/**
 * Settings → About (consumer): brand, mission, live version, and useful
 * links. Build identity stays available inside the Technical details
 * disclosure for release diagnosis — disclosed, not deleted.
 */
export function About() {
  const [info, setInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    readBuildInfo()
      .then((value) => {
        if (mounted) setInfo(value);
      })
      .catch(() => {
        // Unreadable bridge: static metadata still shows with unknown identity.
        if (mounted) setInfo(null);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const fullSha = info?.buildGitSha ?? null;

  return (
    <SettingsPage title="About" backTo="/settings">
      <SettingsGroup title="FindBack">
        <div className="fb-about-brand">
          <p className="fb-about-name">FindBack {APP_VERSION}</p>
          <p className="fb-about-mission">
            FindBack helps people report, discover and recover lost items without turning the
            experience into a public-data free-for-all.
          </p>
          <p className="fb-about-ai">
            Optional AI features using a provider key you add (Profile → AI Connection).
            OpenRouter is the default and stays on its free route; with
            your consent a selected report photo is sent to your connected provider for suggestions.
            Reports, search and other core features work without AI.
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Useful links">
        <SettingsRow
          title="Help chat"
          description="Ask the help assistant a question."
          icon={LifeBuoy}
          iconTone="about"
          route="/help"
        />
        <SettingsRow
          title="Notifications"
          description="Likes, comments, and mentions on your reports."
          icon={Bell}
          iconTone="about"
          route="/notifications"
        />
        <SettingsRow
          title="AI Connection"
          description="Connect an AI provider for optional features."
          icon={Sparkles}
          iconTone="about"
          route="/ai-connection"
        />
      </SettingsGroup>

      <AdvancedDisclosure>
        <dl className="fb-about-technical">
          <div>
            <dt>Build</dt>
            <dd title={fullSha ?? undefined}>{shortSha(fullSha)}</dd>
          </div>
          <div>
            <dt>Version code</dt>
            <dd>
              {typeof info?.versionCode === "number" && info.versionCode > 0 ? info.versionCode : "unknown"}
            </dd>
          </div>
          <div>
            <dt>Expected backend/schema capability</dt>
            <dd>{BACKEND_SCHEMA_VERSION}</dd>
          </div>
          <div>
            <dt>Help capability</dt>
            <dd>{CAPABILITIES_VERSION}</dd>
          </div>
        </dl>
      </AdvancedDisclosure>
    </SettingsPage>
  );
}
