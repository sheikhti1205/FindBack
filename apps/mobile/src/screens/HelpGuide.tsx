import { useMemo, useState } from "react";
import {
  Bell,
  CloudUpload,
  Cpu,
  FilePlus2,
  HandCoins,
  LifeBuoy,
  MessagesSquare,
  MonitorSmartphone,
  PackageSearch,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSearch,
  type SettingIconTone,
  type SettingsSearchResult,
} from "../components/settings";
import { destinationFor } from "../services/destinations";
import { helpTopics, type HelpGroup, type HelpTopic } from "../services/helpTopics";
import "./HelpGuide.css";

const PRESENTATION: Record<string, { icon: LucideIcon; iconTone: SettingIconTone }> = {
  "report-lost": { icon: FilePlus2, iconTone: "help" },
  "report-found": { icon: HandCoins, iconTone: "help" },
  "search-filter": { icon: Search, iconTone: "help" },
  "possible-matches": { icon: PackageSearch, iconTone: "help" },
  "recover-close": { icon: RotateCcw, iconTone: "help" },
  notifications: { icon: Bell, iconTone: "notifications" },
  backup: { icon: CloudUpload, iconTone: "blue" },
  devices: { icon: MonitorSmartphone, iconTone: "teal" },
  "delete-account": { icon: UserRound, iconTone: "account" },
  "local-search": { icon: Cpu, iconTone: "ai" },
  "ai-privacy": { icon: ShieldCheck, iconTone: "privacy" },
  "ask-provider": { icon: MessagesSquare, iconTone: "help" },
  "replay-intro": { icon: LifeBuoy, iconTone: "help" },
};

/**
 * Settings → Help & guide.
 *
 * Every article is static text, so this page works with no provider key and no
 * connection: the troubleshooting and the limits are on the page, not behind a
 * cloud call. Destinations come from the shared catalogue; the general cloud
 * assistant is named as an optional provider chat rather than app support.
 */
export function HelpGuide() {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const topics = useMemo(
    () => helpTopics({
      platform: Capacitor.isNativePlatform() ? "android" : "web",
      signedIn: true,
      capabilities: [],
    }),
    [],
  );
  const filtered = useMemo(() => {
    if (needle.length === 0) return topics;
    return topics.filter((topic) => {
      const haystack = `${topic.title} ${topic.summary} ${topic.keywords.join(" ")} ${topic.body.join(" ")}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [needle, topics]);
  const groups = useMemo(() => {
    const names: HelpGroup[] = [];
    for (const topic of filtered) {
      if (!names.includes(topic.group)) names.push(topic.group);
    }
    return names;
  }, [filtered]);
  const results: SettingsSearchResult[] = filtered.flatMap((topic) => {
    const destination = topic.destinationId ? destinationFor(topic.destinationId) : null;
    const presentation = PRESENTATION[topic.id];
    if (!destination || !presentation) return [];
    return [{ id: topic.id, title: topic.title, description: topic.summary, route: destination.route, ...presentation }];
  });

  return (
    <SettingsPage
      title="Help & guide"
      backTo="/settings"
      description="Short guides for the everyday jobs in Norfold. These work without a connection or a provider key."
    >
      <SettingsSearch
        query={query}
        onQueryChange={setQuery}
        results={results}
        label="Search help topics"
        placeholder="Search help topics"
      />
      {needle.length === 0 ? (
        groups.map((group) => (
          <SettingsGroup key={group} title={group}>
            {filtered
              .filter((topic) => topic.group === group)
              .map((topic) => <Article key={topic.id} topic={topic} />)}
          </SettingsGroup>
        ))
      ) : null}
    </SettingsPage>
  );
}

function Article({ topic }: { topic: HelpTopic }) {
  const destination = topic.destinationId ? destinationFor(topic.destinationId) : null;
  const presentation = PRESENTATION[topic.id];
  if (!destination || !presentation) return null;
  return (
    <div className="fb-help-article">
      <SettingsRow
        title={topic.title}
        description={topic.summary}
        icon={presentation.icon}
        iconTone={presentation.iconTone}
        route={destination.route}
      />
      <div className="fb-help-article-body">
        {topic.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </div>
    </div>
  );
}
