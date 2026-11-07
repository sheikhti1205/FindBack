# Scoped Chat history recovery

Chat's canonical session owns optional foreground peer discovery. It uses the
same enrolled device signer, server, durable history and account-switch abort
lifetime as ordinary mailbox sync. Peer data never advances mailbox checkpoints
or creates outgoing messages.

## Authenticated RPC surface

- `findback_history_peer(action, args)` admits discovery and signaling for one
  conversation. Both endpoints must remain enrolled, unrevoked, in the current
  conversation epoch. Different accounts additionally require an unblocked,
  connected relationship. Signals carry bounded RTC negotiation, never messages.
- `findback_peer_history_authority(session_id, candidates)` checks both endpoint
  generations and message authority atomically. Production export and import
  use this RPC for each page (at most 64 exact message-ID/payload-identity pairs).
- `findback_chat_history_authority(conversation_id, epoch, target, candidates)`
  is the admitted, body-free authority primitive. It requires caller device
  admission, participant membership, current epoch, and publication to caller
  and target. It returns only server-derived immutable identity/order/time.

The context helper is internal-only; anonymous and service roles cannot execute
these RPCs, and peer/chat storage tables remain closed to ordinary clients.

## Privacy and preservation

Each endpoint applies its own private deletion/clear state. An exporter cannot
observe the recipient's private deletion via authority results, including media.
Universal Unsend denies recovery for everyone. Receipts, drafts, private clears
and conversation checkpoints are never imported from a correspondent.

The sender scans all locally accepted bodies, including older holes behind the
receiver's newer saved sequence. Immutable v2 hashes validate content separately
from mailbox TTL retention. Bodies with missing legacy immutable identity cannot
be validated by substituting moderation/body-only hashes. Copies that no longer
exist cannot be recreated. Media parent recovery uses current media eligibility;
it does not promise recovery of expired photo bytes.

STUN provides direct-network candidates, not a TURN connectivity guarantee.
Source and synthetic regression checks do not certify actual provider/device
recovery; those outcomes require separately observed acceptance.
