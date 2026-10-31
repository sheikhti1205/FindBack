import type { RefObject } from "react";
import { ImagePlus, MapPin, Plus } from "lucide-react";
import { ComposerShell } from "./ComposerShell";
import { ActionMenu } from "./ActionMenu";

/** Peer-only visual adapter. Drafts, photo preparation/admission and transport
 * remain with the account/conversation owner, never the separate AI Chat. */
export function PeerChatComposer({ value, onChange, onSend, inputRef, busy, locked, canSend, photoAllowed, onPhoto,
  locationAllowed, onLocation, locating }: {
  value: string; onChange: (value: string) => void; onSend: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>; busy: boolean; locked: boolean;
  canSend: boolean; photoAllowed: boolean; onPhoto: () => void;
  locationAllowed?: boolean; onLocation?: () => void; locating?: boolean;
}) {
  return <ComposerShell value={value} onChange={onChange} onSend={onSend} inputRef={inputRef}
    inputLabel="Message" placeholder="Message" sendLabel="Send message" busy={busy}
    disabled={busy} canSend={canSend} inputProps={{ maxLength: 100000, readOnly: locked }}
    actions={photoAllowed || locationAllowed ? <ActionMenu label="Add to message" icon={<Plus size={20} aria-hidden="true" />}
      disabled={busy || locked || locating} items={[
        ...(photoAllowed ? [{ id: "photo", label: "Photo", icon: <ImagePlus size={18} aria-hidden="true" />, onAction: onPhoto }] : []),
        ...(locationAllowed && onLocation ? [{ id: "location", label: "Location", icon: <MapPin size={18} aria-hidden="true" />, onAction: onLocation }] : []),
      ]} /> : undefined} />;
}
