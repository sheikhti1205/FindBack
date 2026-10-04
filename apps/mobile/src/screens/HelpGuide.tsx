import { useMemo, useState } from "react";
import {
  Bell,
  FilePlus2,
  HandCoins,
  LifeBuoy,
  MessagesSquare,
  PackageSearch,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSearch,
  type SettingsSearchResult,
} from "../components/settings";
import "./HelpGuide.css";

interface HelpTopic extends SettingsSearchResult {
  group: string;
}

const TOPICS: readonly HelpTopic[] = [
  {
    id: "report-lost",
    title: "Report a lost item",
    description: "Choose Lost on the Report tab, add details and publish.",
    route: "/report",
    icon: FilePlus2,
    iconTone: "help",
    group: "Reports",
  },
  {
    id: "report-found",
    title: "Report a found item",
    description: "Choose Found on the Report tab, add details and publish.",
    route: "/report",
    icon: HandCoins,
    iconTone: "help",
    group: "Reports",
  },
  {
    id: "search-filter",
    title: "Search and filter reports",
    description: "Find reports by text, category, status, and sort order.",
    route: "/search",
    icon: Search,
    iconTone: "help",
    group: "Reports",
  },
  {
    id: "possible-matches",
    title: "Possible matches",
    description: "Open one of your reports to see its Possible Matches.",
    route: "/my",
    icon: PackageSearch,
    iconTone: "help",
    group: "Reports",
  },
  {
    id: "recover-close",
    title: "Recover or close a report",
    description: "Mark your report recovered or closed from your reports.",
    route: "/my",
    icon: RotateCcw,
    iconTone: "help",
    group: "Reports",
  },
  {
    id: "notifications",
    title: "Notifications",
    description: "Likes, comments, and mentions land in your inbox.",
    route: "/notifications",
    icon: Bell,
    iconTone: "notifications",
    group: "Your account",
  },
  {
    id: "ai-privacy",
    title: "AI and privacy",
    description: "Optional AI features and what leaves your device.",
    route: "/ai-connection",
    icon: Sparkles,
    iconTone: "ai",
    group: "Your account",
  },
  {
    id: "chat-help",
    title: "Chat with help",
    description: "Ask the help assistant a question.",
    route: "/help",
    icon: MessagesSquare,
    iconTone: "help",
    group: "More help",
  },
  {
    id: "replay-intro",
    title: "Replay introduction",
    description: "See the first-launch introduction again. Nothing is reset.",
    route: "/onboarding?replay=1",
    icon: LifeBuoy,
    iconTone: "help",
    group: "More help",
  },
];

/**
 * Settings → Help & guide. Topic rows navigate to real flows; the existing
 * /help chat is linked, not duplicated. Filtering is local (no backend).
 */
export function HelpGuide() {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (needle.length === 0) return TOPICS;
    return TOPICS.filter((topic) => {
      const description = typeof topic.description === "string" ? topic.description : "";
      return (
        topic.title.toLowerCase().includes(needle) || description.toLowerCase().includes(needle)
      );
    });
  }, [needle]);
  const groups = useMemo(() => {
    const names: string[] = [];
    for (const topic of filtered) {
      if (!names.includes(topic.group)) names.push(topic.group);
    }
    return names;
  }, [filtered]);

  return (
    <SettingsPage
      title="Help & guide"
      backTo="/settings"
      description="Short guides for the everyday jobs in FindBack."
    >
      <SettingsSearch
        query={query}
        onQueryChange={setQuery}
        results={filtered}
        label="Search help topics"
        placeholder="Search help topics"
      />
      {needle.length === 0 ? (
        groups.map((group) => (
          <SettingsGroup key={group} title={group}>
            {filtered
              .filter((topic) => topic.group === group)
              .map(({ id, group: _group, ...row }) => (
                <SettingsRow key={id} {...row} />
              ))}
          </SettingsGroup>
        ))
      ) : null}
    </SettingsPage>
  );
}
