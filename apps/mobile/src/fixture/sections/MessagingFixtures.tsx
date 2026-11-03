import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Images, Info, MapPin } from "lucide-react";
import { ChatIdentity } from "../../components/ChatIdentity";
import { PeerChatComposer } from "../../components/PeerChatComposer";
import { ALL_VARIANTS, FixtureFrame, FixtureSection, type FixtureVariant } from "../FixtureSection";
import "../../screens/Messaging.css";

/**
 * Chat surface preflight (owner handoff 2026-11-03).
 *
 * The live thread is data-bound (auth, runtime, durable history), so this frame
 * renders the *production* pieces whose hierarchy changed — `ChatIdentity`,
 * `PeerChatComposer` and the real `Messaging.css` bubble/surface rules. Only the
 * sample rows are fixture data; every visual decision belongs to production
 * code. It exists so the identity header, calm borders, pending-state copy and
 * composer can be reviewed at 320dp, wide, dark, AMOLED and large text without
 * a signed-in account.
 */

function Bubble({ own, children, status }: { own?: boolean; children: ReactNode; status?: string }) {
  return (
    <li className={own ? "fb-chat-line fb-chat-line-own" : "fb-chat-line"}>
      <div className={own ? "fb-chat-message fb-chat-message-own" : "fb-chat-message"}>
        <span className="sr-only">{own ? "You: " : "Alex: "}</span>
        {children}
        {own && status && <span className="fb-chat-message-status">{status}</span>}
      </div>
    </li>
  );
}

function Thread({ variant }: { variant: FixtureVariant }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const long = variant === "long-content";
  const name = long ? "alexander_the_third_rivera_with_a_long_handle" : "alex_rivera";
  return (
    <div className="fb-chat-page" data-testid="fixture-chat-thread" style={{ height: 460 }}>
      <header className="fb-chat-header">
        <button type="button" className="fb-chat-icon" aria-label="Back to chats"><ArrowLeft size={22} aria-hidden="true" /></button>
        <ChatIdentity peerId="fixture-peer" name={name} status="Connected" muted />
        <button type="button" className="fb-chat-icon" aria-label="Conversation options"><Info size={21} aria-hidden="true" /></button>
      </header>
      <div className="fb-chat-messages">
        {variant === "loading" && <p role="status" className="fb-chat-secondary">Opening messages…</p>}
        {variant === "empty" && <p className="fb-chat-empty">Say hello and explain why you’d like to connect.</p>}
        {variant === "error" && <p className="fb-chat-error" role="alert">Chat could not sync. Try again.</p>}
        {long && <p className="fb-chat-sync" role="status">A very long status line that has to wrap without pushing the composer or the identity header out of the frame at 320dp.</p>}
        <ol className="fb-chat-transcript" aria-label="Messages">
          <Bubble><p dir="auto">Hi — I think I saw the blue wallet near the east gate around 6pm.</p></Bubble>
          <Bubble own status="Sent"><p dir="auto">Thank you. Was there a card holder inside?</p></Bubble>
          <Bubble><p dir="auto">It had a bank card and a train ticket, so it is probably yours.</p></Bubble>
          <Bubble own status="Sending…">
            <p dir="auto">I can be there in ten minutes.</p>
          </Bubble>
          <Bubble own status="Photo pending">
            <p><Images size={16} aria-hidden="true" /> Photo</p>
          </Bubble>
          <Bubble own status="Sent">
            <p><MapPin size={16} aria-hidden="true" /> Static location</p>
          </Bubble>
        </ol>
      </div>
      <PeerChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => setDraft("")}
        inputRef={inputRef}
        busy={false}
        locked={false}
        canSend={!!draft.trim()}
        photoAllowed
        onPhoto={() => undefined}
        locationAllowed
        onLocation={() => undefined}
      />
    </div>
  );
}

export function MessagingFixtures() {
  return (
    <FixtureSection
      id="messaging"
      title="Messaging thread"
      description="Production ChatIdentity + PeerChatComposer and the real chat surface rules: identity header, calm borders, pending item copy and composer, in normal / 320dp / large text / dark / AMOLED."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {ALL_VARIANTS.map((variant) => (
          <FixtureFrame key={variant} section="messaging" variant={variant}>
            <Thread variant={variant} />
          </FixtureFrame>
        ))}
      </div>
    </FixtureSection>
  );
}
