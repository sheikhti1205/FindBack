# Open-source research for FindBack

Verified 2026-09-09 via the GitHub API. Policy from the starter prompt: reuse only
MIT/Apache-2.0/BSD/ISC code (or user-owned Norfold code); preserve notices; record
reuse in THIRD_PARTY_SOURCES.md; never copy an entire app and rebrand.

| Repository | Reported status | Verified license | Reuse decision |
|---|---|---|---|
| Atul-AI08/Lost_and_Found | MIT | MIT (GitHub API) | Reference only for flows/Firebase patterns. No copy (different stack: Kotlin+Firebase vs React+Capacitor+local API). |
| team-finders/lost-and-found-app | MIT | **No LICENSE file found** | Reference only for backend/domain ideas. No code reuse (unlicensed). |
| litegenix/Lost-and-found-item-portal-web-application | MIT | **No LICENSE file found** | Reference only for categories/statuses/portal ideas. No code reuse (unlicensed). |
| SK-Jabed/LostFinder-Project-Client | MIT | **No LICENSE file found** | Reference only for React data-flow ideas. No code reuse (unlicensed). |
| pirinthaban/findback | MIT | MIT (GitHub API) | Reference only. Uses the same name "findback"; do NOT copy branding/identity. |
| material-components/material-web | Apache-2.0 | Apache-2.0 | Inspect for Material 3 tokens; treat guidance as documentation, not copied source. |

## Notes
- None of the reference apps are direct-sourced: FindBack uses its own original UI
  and architecture (React+Vite+Tailwind+Capacitor front end; Node+SQLite API) which
  differs from every reference (Kotlin/Firebase, Node/Mongo, Flutter/Firebase, React).
- Material 3 Expressive direction researched and reproduced through CSS tokens, not
  copied component code. No code reuse from these repos is planned; if any small
  MIT/Apache snippet is adapted later it will be listed in THIRD_PARTY_SOURCES.md.
