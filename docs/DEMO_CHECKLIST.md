# FindBack — teacher demo checklist

A 10–15 minute walkthrough mapping demo steps to the 24 course requirements.
Run the API and the Android app (or the mobile web shell) before starting.

## 0 · Prepare

1. Start the API: `npm run dev:api` → http://localhost:4000
   (auto-seeds the demo database on first run).
2. Open the mobile app (Android APK on an emulator pointing at the host, or
   the web shell at http://localhost:5173).
3. Log in with `rafi_cu` / `password123` (seeded local/demo accounts), or
   register a new account. In Supabase production there are no seeded users —
   register and verify by real email.

## 1 · Auth & verification (req 5, 11, 4)

| What to do | What the teacher sees |
| --- | --- |
| Register a fresh account (username, email, phone + password) | #4: while typing the username it live-reports "available/taken" |
| Register → check the email inbox → enter the emailed code on the **Verify** screen | #5: production email is a real Supabase Auth OTP (8 digits) sent via SMTP; the local demo (SQLite) shows the code on screen instead. Phone verification still needs an SMS provider. |
| Log out and log back in | #11: Supabase access session + rotating refresh token; guarded routes remain authenticated across reloads |

_Signup and login now go directly from the app to Supabase Auth (publishable key); login is email + password (username stays the public profile identity), the live username availability check is also direct to Supabase, and email confirmation remains a real emailed OTP. Browsing the feed, opening a post and viewing My Posts, creating/editing reports, and comments/reactions/ratings now also go directly to Supabase (a public-author-only payload — email/phone never travel with a post; reaction/rating user lists are never exposed); realtime, uploads, reporting and AI still go through the Node API for now._

## 2 · Create a report (req 6, 13, 12, 14, 9, 10, 16)

1. **Report** tab → choose *I lost something / I found something* (req 6).
2. Fill multiple text boxes (title/description), pick a **category dropdown**
   and the **date picker** (req 14), and capture an approximate location with the
   one-time "Use my location" button plus a free-text label (req 10).
3. Attach a photo (req 13) and press **Suggest category (on-device ML)** before
   publishing — TensorFlow.js MobileNet V1 runs inference on the device using
   weights bundled in the app (~1.92 MB), with no CDN fallback and no network
   request; the photo never leaves the device (req 12).
4. Paste a YouTube link and watch the embedded player render live (req 9).
5. Publish → open the post (tailwind-styled, animated card entrance — req 16/15).

## 3 · Realtime engagement (req 2, 3, 7, 8)

1. Open the same post in a **second session** (second browser tab logged in as
   `nusrat`, or a second device on the same network).
2. In session A post a **comment** (req 2) → appears instantly in session B.
3. In session B press **like/dislike** (req 3) → live count in session A.
4. In session A tap a **1–5 star rating** (req 7) → live average updates in B.
5. Back on the feed, scroll to see **pagination/infinite scroll** load more
   (req 8).

## 4 · Search & filters (cross-cutting)

Use the **Search** tab: filter by Lost/Found + category + status + query; show
results update live as posts are added elsewhere.

## 5 · Recovery flow (owner status)

Open one of *your own* posts → **Update status** segmented control
(OPEN → MATCHED → RECOVERED) — shown to the owner only.

## 6 · Reporting & the "Crystal Report" story (req 20)

```bash
node scripts/report-activity.mjs                     # live summary table
node scripts/report-activity.mjs --csv report.csv    # CSV for Excel/Crystal
```

Show the vector ERD: `docs/erd/ERD.pdf` (zoom in — it stays crisp) (req 1).
Point to `docs/reporting/REPORTING.md` with the ready-made SQL queries for the
Crystal Reports designer.

## 7 · Modern API layer (req 18, 19, 22, 23)

1. Open http://localhost:4000/graphql → run a query in GraphiQL (req 18);
   e.g. `{ feed(first: 3) { items { title } } }`.
2. `curl http://localhost:4000/reports/activity?days=7` (req 19).
3. Show `docker-compose.yml` / `Dockerfile` and the GitHub Actions workflow
   (req 22) — CI runs the same lint/typecheck/test commands locally.
4. **Profile → Help Assistant**: ask "How do I report a lost item?" — answers
   from the deterministic fallback (or a configured LLM) (req 23).

## 8 · Show the deliverable (req 17, 21, 24)

- `git log --oneline` (req 17) and `npm run build -w @findback/mobile`.
- Install `app-debug.apk` (apps/mobile/android/app/build/outputs/apk/debug/)
  on an emulator or phone and repeat step 1–3 on-device (req 21, 24).

## Requirement → demo map (quick reference)

| # | Req | # | Req |
|---|---|---|---|
| 1 | §6 | 13 | §2 |
| 2 | §3 | 14 | §2 |
| 3 | §3 | 15 | §2 |
| 4 | §1 | 16 | §2 |
| 5 | §1 | 17 | §8 |
| 6 | §2 | 18 | §7 |
| 7 | §3 | 19 | §7 |
| 8 | §3 | 20 | §6 |
| 9 | §2 | 21 | §8 |
| 10 | §2 | 22 | §7 |
| 11 | §1 | 23 | §7 |
| 12 | §2 | 24 | §8 |
