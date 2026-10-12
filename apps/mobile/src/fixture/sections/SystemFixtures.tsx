import { useState } from "react";
import { Button } from "../../components/Button";
import { ChatComposer } from "../../components/ChatComposer";
import { ChatTranscript } from "../../components/ChatTranscript";
import { MapEmbed } from "../../components/MapEmbed";
import { EmptyState, Spinner } from "../../components/PostCard";
import { ProfileHero } from "../../components/ProfileHero";
import { Segmented } from "../../components/Segmented";
import { UserAvatar } from "../../components/UserAvatar";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import { LONG_USERNAME, STRINGS, assistantTranscript } from "../posts";

function noop(): void {}

const PROFILE_USER = {
  id: "fixture-user-1",
  username: "samira",
  email: "samira@example.com",
  phone: "+10000000000",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  displayName: "Samira",
} as const;

const PROFILE_USER_LONG = {
  ...PROFILE_USER,
  username: LONG_USERNAME,
  displayName: LONG_USERNAME,
} as const;

function ThemeSegment() {
  const [theme, setTheme] = useState<"light" | "dark" | "amoled">("light");
  return (
    <Segmented
      value={theme}
      onChange={setTheme}
      options={[
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "amoled", label: "AMOLED" },
      ]}
      ariaLabel="Theme"
    />
  );
}

/**
 * System preflight: profile (`ProfileHero` + `UserAvatar`), settings
 * (`Segmented` + `Button` rows), assistant (`ChatTranscript` +
 * `ChatComposer`), and the map-unavailable state (`MapEmbed` with no
 * coordinates — the honest no-key placeholder). All ACTUAL production
 * components with deterministic data.
 */
export function SystemFixtures() {
  return (
    <>
      <FixtureSection
        id="profile"
        title="Profile"
        description="Production ProfileHero and UserAvatar across identity states."
      >
        <FixtureFrame section="profile" variant="normal">
          <ProfileHero user={{ ...PROFILE_USER }} />
        </FixtureFrame>
        <FixtureFrame section="profile" variant="loading">
          <Spinner label="Loading profile…" />
        </FixtureFrame>
        <FixtureFrame section="profile" variant="empty">
          <EmptyState
            title="No reports yet"
            subtitle="This person has not published any reports."
          />
        </FixtureFrame>
        <FixtureFrame section="profile" variant="error">
          <EmptyState title="Could not load" subtitle={STRINGS.loadingError} />
        </FixtureFrame>
        <FixtureFrame section="profile" variant="long-content">
          <ProfileHero user={{ ...PROFILE_USER_LONG }} />
        </FixtureFrame>
        <FixtureFrame section="profile" variant="large-text">
          <ProfileHero user={{ ...PROFILE_USER }} />
        </FixtureFrame>
        <FixtureFrame section="profile" variant="dark">
          <ProfileHero user={{ ...PROFILE_USER }} />
        </FixtureFrame>
        <FixtureFrame section="profile" variant="amoled">
          <div className="flex items-center gap-3">
            <UserAvatar avatarUrl={null} username={null} size={64} />
            <div>
              <p className="font-semibold">No avatar, no name</p>
              <p className="text-sm text-on-surface-variant">
                Generic glyph fallback
              </p>
            </div>
          </div>
        </FixtureFrame>
        <FixtureFrame section="profile" variant="small-width">
          <ProfileHero user={{ ...PROFILE_USER_LONG }} />
        </FixtureFrame>
      </FixtureSection>

      <FixtureSection
        id="settings"
        title="Settings"
        description="Production settings controls (segmented theme picker, action buttons) across states."
      >
        <FixtureFrame section="settings" variant="normal">
          <div className="flex flex-col gap-3">
            <ThemeSegment />
            <Button variant="outline" onClick={noop}>
              Edit profile
            </Button>
            <Button variant="text" onClick={noop}>
              Sign out
            </Button>
          </div>
        </FixtureFrame>
        <FixtureFrame section="settings" variant="loading">
          <div className="flex flex-col gap-3">
            <ThemeSegment />
            <Button loading onClick={noop}>
              Saving…
            </Button>
          </div>
        </FixtureFrame>
        <FixtureFrame section="settings" variant="empty">
          <EmptyState
            title="Settings"
            subtitle="Appearance, notifications, privacy, and help live here."
          />
        </FixtureFrame>
        <FixtureFrame section="settings" variant="error">
          <EmptyState
            title="Settings unavailable"
            subtitle={STRINGS.loadingError}
          />
        </FixtureFrame>
        <FixtureFrame section="settings" variant="long-content">
          <div className="flex flex-col gap-3">
            <ThemeSegment />
            <Button variant="outline" onClick={noop}>
              A settings action with a deliberately long label that wraps to
              prove button text stays honest at any width
            </Button>
          </div>
        </FixtureFrame>
        <FixtureFrame section="settings" variant="large-text">
          <div className="flex flex-col gap-3">
            <ThemeSegment />
            <Button variant="outline" onClick={noop}>
              Edit profile
            </Button>
          </div>
        </FixtureFrame>
        <FixtureFrame section="settings" variant="dark">
          <div className="flex flex-col gap-3">
            <ThemeSegment />
            <Button variant="outline" onClick={noop}>
              Edit profile
            </Button>
          </div>
        </FixtureFrame>
        <FixtureFrame section="settings" variant="amoled">
          <div className="flex flex-col gap-3">
            <ThemeSegment />
            <Button variant="error" onClick={noop}>
              Delete account
            </Button>
          </div>
        </FixtureFrame>
        <FixtureFrame section="settings" variant="small-width">
          <div className="flex flex-col gap-3">
            <ThemeSegment />
            <Button variant="outline" onClick={noop}>
              Edit profile
            </Button>
          </div>
        </FixtureFrame>
      </FixtureSection>

      <FixtureSection
        id="assistant"
        title="Assistant"
        description="Production ChatTranscript and ChatComposer across conversation states."
      >
        <FixtureFrame section="assistant" variant="normal">
          <div className="flex flex-col gap-3">
            <ChatTranscript messages={assistantTranscript} />
            <ChatComposer
              value=""
              onChange={noop}
              onSend={noop}
              inputLabel="Ask the Help & FAQ"
            />
          </div>
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="loading">
          <ChatTranscript messages={assistantTranscript} busy />
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="empty">
          <div className="flex flex-col gap-3">
            <EmptyState
              title="How can I help?"
              subtitle="Ask about reporting, recovering, or searching."
            />
            <ChatComposer
              value=""
              onChange={noop}
              onSend={noop}
              inputLabel="Ask the Help & FAQ"
            />
          </div>
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="error">
          <ChatTranscript
            messages={assistantTranscript}
            error="The answer could not be finished. Try again."
            onRetry={noop}
          />
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="long-content">
          <ChatTranscript
            messages={[
              ...assistantTranscript,
              {
                id: "fx-t5",
                role: "user" as const,
                text: "What if my description is extremely long and detailed with many paragraphs about the item, the location, the time, and everything I remember?",
              },
              {
                id: "fx-t6",
                role: "assistant" as const,
                text: "Long answers stream the same way short ones do: one bubble, honest provenance, and a stop control while generating. ".repeat(
                  6,
                ),
                source: "llm" as const,
              },
            ]}
            partialText="Streaming partial text appears in its own bubble…"
            partialLabel="AI answer"
          />
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="large-text">
          <div className="flex flex-col gap-3">
            <ChatTranscript messages={assistantTranscript} />
            <ChatComposer
              value="Can I edit a report after publishing?"
              onChange={noop}
              onSend={noop}
              inputLabel="Ask the Help & FAQ"
            />
          </div>
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="dark">
          <div className="flex flex-col gap-3">
            <ChatTranscript messages={assistantTranscript} />
            <ChatComposer
              value=""
              onChange={noop}
              onSend={noop}
              inputLabel="Ask the Help & FAQ"
            />
          </div>
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="amoled">
          <div className="flex flex-col gap-3">
            <ChatTranscript messages={assistantTranscript} busy />
            <ChatComposer
              value=""
              onChange={noop}
              onSend={noop}
              busy
              onStop={noop}
              inputLabel="Ask the Help & FAQ"
            />
          </div>
        </FixtureFrame>
        <FixtureFrame section="assistant" variant="small-width">
          <div className="flex flex-col gap-3">
            <ChatTranscript messages={assistantTranscript} />
            <ChatComposer
              value=""
              onChange={noop}
              onSend={noop}
              inputLabel="Ask the Help & FAQ"
            />
          </div>
        </FixtureFrame>
      </FixtureSection>

      <FixtureSection
        id="map-unavailable"
        title="Map unavailable"
        description="Production MapEmbed with no coordinates: the honest no-key placeholder. Coordinates are never fabricated."
      >
        <FixtureFrame section="map-unavailable" variant="normal">
          <MapEmbed lat={null} lng={null} label={null} />
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="loading">
          <Spinner label="Loading map…" />
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="empty">
          <MapEmbed lat={null} lng={null} label={null} />
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="error">
          <EmptyState
            title={STRINGS.mapUnavailableTitle}
            subtitle={STRINGS.mapUnavailableSubtitle}
          />
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="long-content">
          <div className="flex flex-col gap-3">
            <MapEmbed lat={null} lng={null} label={null} />
            <p className="text-sm text-on-surface-variant">
              {STRINGS.mapUnavailableSubtitle}
            </p>
          </div>
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="large-text">
          <MapEmbed lat={null} lng={null} label={null} />
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="dark">
          <MapEmbed lat={null} lng={null} label={null} />
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="amoled">
          <MapEmbed lat={null} lng={null} label={null} />
        </FixtureFrame>
        <FixtureFrame section="map-unavailable" variant="small-width">
          <MapEmbed lat={null} lng={null} label={null} />
        </FixtureFrame>
      </FixtureSection>
    </>
  );
}
