import { useRef, useState } from "react";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { PrimaryNav } from "../../components/Shell";
import { TopUtilities } from "../../components/TopUtilities";
import { ActionMenu } from "../../components/ActionMenu";
import { AdaptiveTaskSurface, ConfirmDialog } from "../../components/AdaptiveTaskSurface";
import { ComposerShell } from "../../components/ComposerShell";
import { SplitView } from "../../components/SplitView";
import { UserQuickCard } from "../../components/UserQuickCard";
import { TabTapProvider } from "../../components/TabTap";
import { COMPACT_MAX_PX, useContentWidth, useViewportWidth } from "../../components/responsive";
import { FixtureSection } from "../FixtureSection";

/** Integrated synthetic conversation for shared-owner preflight, not a claim
 * about Chat transport, real people, or account/device acceptance. */
export function FoundationDemo({ state = "normal" }: { state?: "normal" | "loading" | "empty" | "error" }) {
  const root = useRef<HTMLDivElement>(null);
  const width = useContentWidth(root, useViewportWidth());
  const rail = width >= COMPACT_MAX_PX;
  const [selected, setSelected] = useState(true);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const [task, setTask] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [failure, setFailure] = useState(false);
  const [notice, setNotice] = useState("");
  return <TabTapProvider><div ref={root} className={`flex h-full min-h-0 w-full bg-surface text-on-surface ${rail ? "flex-row" : "flex-col"}`} data-testid="foundation-demo">
    {rail && <PrimaryNav layout="rail" activePath="/chats" layoutScope="foundation" />}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-outline-variant px-3">
        <h1 className="min-w-0 text-base font-semibold">Chats</h1><TopUtilities liveBadge={false} unreadCount={3} />
      </header>
      <div className="min-h-0 flex-1">
        <SplitView selected={selected} list={<div className="p-3">
          <h2 className="mb-3 font-semibold">Recent</h2>
          <button className="flex min-h-[64px] w-full flex-col items-start border-b border-outline-variant py-3 text-left" onClick={() => setSelected(true)}><span className="font-medium">River Lee</span><span className="text-sm text-on-surface-variant">About your blue wallet</span></button>
        </div>} detail={<div className="flex h-full min-h-0 flex-col">
          <header className="flex shrink-0 items-center gap-1 border-b border-outline-variant px-2 py-1">
            <button aria-label="Back to chats" className="fb-icon-control" onClick={() => setSelected(false)}><ArrowLeft size={20} aria-hidden="true" /></button>
            <div className="min-w-0 flex-1"><UserQuickCard username="river" displayName="River Lee" relationship="Connected" /></div>
            <button aria-label="Filters" className="fb-icon-control" onClick={() => setTask(true)}><SlidersHorizontal size={20} aria-hidden="true" /></button>
            <ActionMenu label="Conversation actions" items={[
              { id: "save", label: "Save", onAction: () => setNotice("Saved") },
              { id: "share", label: "Share", items: [{ id: "copy", label: "Copy link", onAction: () => setNotice("Link copied") }] },
              { id: "delete", label: "Delete conversation", destructive: true, onAction: () => { setFailure(false); setConfirm(true); } },
            ]} />
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {state === "loading" ? <p role="status">Loading messages…</p> : state === "empty" ? <p className="text-sm text-on-surface-variant">No messages yet.</p> : state === "error" ? <p role="alert">Messages couldn’t load. Try again.</p> : <>
              <p className="mb-1 text-xs text-on-surface-variant">Today · 10:32</p>
              <p className="max-w-[36rem] text-sm leading-relaxed">Hi! I found a blue wallet near the library. Could you describe what’s inside so we can check whether it’s yours?</p>
            </>}
            {sent.map((text, index) => <p key={index} className="mt-4 break-words text-right text-sm">{text}</p>)}
            <p role="status" className="mt-2 text-xs text-on-surface-variant">{notice}</p>
          </div>
          <div className="shrink-0 p-3"><ComposerShell value={draft} onChange={setDraft} onSend={() => { setSent((items) => [...items, draft]); setDraft(""); }} inputLabel="Message" placeholder="Message…" context={<p className="text-xs text-on-surface-variant">Blue wallet · Lost report</p>} /></div>
        </div>} />
      </div>
    </div>
    {!rail && <PrimaryNav layout="bottom" activePath="/chats" layoutScope="foundation" />}
    <AdaptiveTaskSurface open={task} onClose={() => setTask(false)} title="Filters" description="Choose which conversations to show." footer={<button className="fb-surface-button" onClick={() => setTask(false)}>Done</button>}>
      <label className="flex flex-col gap-2 text-sm">Search conversations<input className="min-h-[44px] rounded-lg border border-outline-variant bg-surface px-3" placeholder="Name or message" /></label>
      <label className="mt-4 flex min-h-[44px] items-center gap-3 text-sm"><input type="checkbox" />Unread only</label>
    </AdaptiveTaskSurface>
    <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Delete conversation?" description="This removes it from your list." confirmLabel="Delete" onConfirm={() => setFailure(true)}>
      {failure && <p role="alert" className="text-sm text-error">Couldn’t delete. Try again.</p>}
    </ConfirmDialog>
  </div></TabTapProvider>;
}

export function FoundationFixtures() {
  return <FixtureSection id="adaptive-foundation" title="Adaptive foundation" description="Integrated synthetic task using production navigation, identity, actions, dialogs, split view and composer. No transport or account acceptance.">
    <div style={{ height: 560 }}><FoundationDemo /></div>
  </FixtureSection>;
}
