# Adaptive UI ownership

M7-P, source version `0.12.0-beta.1`. This describes current source, not hosted or
native acceptance. The [source checkpoint](releases/M7_P_SOURCE_CLOSURE_2026-11-01.md)
records verification boundaries.

## Principles

Reports and conversations lead; chrome stays compact. Use ordinary list rows,
separators and whitespace rather than cards around every group. Semantic colour
communicates Lost/Found, status or safety, not decoration. Consumer screens do not
expose runtime/model IDs or diagnostics outside Advanced/Diagnostics.

Phone bottom navigation becomes a compact icon rail on wider windows. Reading
columns remain bounded; Chats and Settings use available width for separate panes.
Large text reflows rather than shrinking targets or hiding actions. Appearance
owns light/dark/true-black and motion preferences across all surfaces.

## Canonical owners (`apps/mobile/src/`)

| Concern | Owner / contract |
| --- | --- |
| Destinations and utilities | `components/Shell.tsx`, `TopUtilities.tsx`: Home, My Reports, Chats, Settings; bell/search are utilities, Profile is reached through Settings. |
| Anchored actions | `ActionMenu.tsx`, `AdaptivePopover.tsx`: existing React Aria/Floating UI ownership, nested dismissal, keyboard navigation and launcher restoration. |
| Confirmation and tasks | `AdaptiveTaskSurface.tsx`: small destructive confirmations, bounded desktop tasks and phone/short-window adaptation; shared Back/Escape/IME handling. |
| Split panes | `SplitView.tsx`: list/detail composition without remounting drafts merely on resize. |
| Identity | `UserAvatar.tsx`, `UserQuickCard.tsx`, `PeerIdentityActions.tsx`: one public identity renderer, canonical relationship and safety actions. |
| Composition | `ComposerShell.tsx`: Enter-send on desktop, Shift+Enter newline, no send during IME composition; feature owners keep drafts and send authority. |
| Photo inspection | `MediaViewer.tsx`: approved yet-another-react-lightbox 3.x with Zoom/Fullscreen/Thumbnails, no wrap; React Aria focus scope and shared overlay dismissal. No second viewer. |
| Reports | `PostAnatomy.tsx`, `PostCardContent.tsx`, `PostModal.tsx`: identity, status/title, inline disclosure, media/facts/actions. Desktop contextual navigation retains the background; direct links remain standalone. |
| Report editing | `ReportEditor.tsx` / `ReportMediaPicker.tsx`: shared Create/Edit fields in a task surface; existing draft, media preparation and publication owners retain persistence. |
| Notifications | `screens/Notifications.tsx` and `NotificationPopover.tsx`: one account-keyed inbox implementation; quick view and full route share read/delete/Undo behavior. Preferences are separate. |
| Chat | `screens/Messaging.tsx`, `PeerChatComposer.tsx`: canonical R4 projections, thread/details/search/media presentation, request vs connected capabilities. |

Do not duplicate auth/session, themes, media preparation, block policy, reactions,
report publication or recovery-linked ratings inside presentation components.
Local safety signals carry no private data; report previews re-read authorization
after report changes rather than trusting a cached title/photo.

## Routes and compatibility

- `/`, `/my`, `/chats`, `/settings` are primary destinations.
- `/chats/:conversationId` is canonical; `/connections` and
  `/connections/:conversationId` redirect without losing the conversation.
- `/posts/:id` is standalone on direct entry and contextual on eligible desktop
  navigation. `/report` and `/my/:id/edit` retain real URLs for task surfaces.
- `/search` contains Reports and People. `/notifications` is the full inbox;
  `/settings/notifications` configures preferences.
- `/profile` and `/profile/edit` remain supported; `/u/:username` is public
  identity, `/settings/returns` owns recovery-linked ratings.
- `/settings/local-intelligence` owns Smart Search/matching tools and downloads.
  `/ai-models`, `/offline-ai`, `/settings/ai/models` are compatibility redirects.
  `/settings/ai` remains separate optional provider-key cloud Chat configuration.

## Acceptance boundary

Final local fixtures exercise compact phone (including 320px/200% text), common
phone, landscape, tablet, 1024/1280/1440 desktop, themes, reduced motion and relevant
loading/empty/error/success/input states. Unit tests do not replace capture review.
These fixtures do not certify real accounts, Android touch/IME/native plugins,
screen readers, Sentry ingestion or the owner's phone-photo matching corpus.
