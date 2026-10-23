# NORFOLD — Preliminary Name Clearance Audit

**Date:** 2026-10-18
**Scope:** Preliminary ownability screen for `NORFOLD` as an umbrella/parent brand (with `Norfold Find` and future products beneath it).
**Status:** PRELIMINARY SCREEN ONLY. Not a legal clearance opinion. Trademark registers could not be machine-searched (bot walls) — see Gaps.
**Verdict:** **CAUTION** (proceed-able, with corrective actions) — see §5.

---

## 1. Summary of the ask

FindBack must be renamed. The owner is proposing `NORFOLD` as a parent/studio brand with
products underneath (`Norfold Find`, `Norfold ID`, `Norfold Campus`, …), rather than as a
single app name.

Discovery during this audit: `Norfold` is **already an in-house project** — local repo
`/home/sheikh/GitHub/Norfold` (remote `https://github.com/Norfold-App/Norfold.git`,
Android `applicationId = com.norfold.app`, web `https://norfold.pages.dev`), positioned as
*"a private workspace for notes, documents, tasks, conversations, and shared work"* and
flagged **pre-release**. No App Store / Google Play listing exists for it yet.

---

## 2. Method and controls

| Check | Source | Control used | Result confidence |
|---|---|---|---|
| Domain registration | RDAP (registry-authoritative) | Known-registered names in the same TLD (e.g. `vercel.app`, `openai.ai`, `bbc.co.uk`, `vercel.net`) | High for .com/.net/.org/.app/.dev/.ai/.xyz/.co.uk |
| Reachability | DNS via local resolver | — | Corroborating only (NXDOMAIN ≠ unregistered) |
| App stores | Apple iTunes Search API (JSON); Google Play search HTML | Apple: real result set returned; Play: control query `whatsapp` returned 91 in-page hits vs 20 query-echo-only hits for `norfold` | High (iOS), Medium (Play) |
| GitHub | GitHub REST API | Search endpoint returns totals | High |
| Other handles | HTTP status + page title | Control handle `@zzqqxxnonsensehandle99` → HTTP 404 "404 Not Found" | High for YouTube |
| UK companies | Companies House open search (server-rendered) | Control query `monzo` → 33 hits / 52,877 bytes vs `norfold` → 3 hits (search-box links only) / 31,906 bytes | High |
| BD trademark journal | DPDT-published Trademarks Journal PDFs (Oracle Object Storage), text-extracted with `pdftotext` | Control words `ADVERTISED` (622 / 593 hits) and `Samsung` (5 / 2 hits) confirm the extraction is complete | High, but only 2 journals |
| Package registries | npm registry, PyPI JSON | — | High |
| Trademark registers (US/EU/UK/WIPO) | **FAILED** — Cloudflare challenge / CAPTCHA / bot wall | — | **Unverified** |

---

## 3. Findings (verified)

### 3.1 Domains

| Domain | State | Evidence |
|---|---|---|
| `norfold.com` | **TAKEN** — registered **2025-06-06T22:59:15Z**, registrar Namecheap, NS `dns1/dns2.registrar-servers.com`, A `192.64.119.232` (parking IP) | RDAP |
| `norfold.app` | **TAKEN** — registered **2026-10-16T11:56:28Z** (2 days ago), Cloudflare registrar, NS `kay/ned.ns.cloudflare.com` | RDAP |
| `norfold.net` `.org` `.io` `.dev` `.ai` `.xyz` `.co.uk` `.tech` `.studio` `.shop` | RDAP 404 on endpoints validated with known-registered names → **appears unregistered** | RDAP |
| `norfold.co`, `norfold.com.bd` | **UNVERIFIED** (no RDAP for these TLDs; NXDOMAIN only) | — |

> `norfold.app` was registered two days before this audit and the local Norfold repo already
> references `https://norfold.app`. **Confirm whether that registration is the owner's** —
> if not, the nearest premium domain is gone.

### 3.2 Handles / registries / stores

| Asset | State | Evidence |
|---|---|---|
| GitHub `@Norfold` | **TAKEN, dormant** — user since 2019-03-25, 0 repos, 0 followers, last profile update 2021-07-29 | GitHub API |
| GitHub `@Norfold-App` | Owner's own account (org hosting the Norfold repo) — created 2026-07-15 | GitHub API |
| GitHub repos named `norfold` | 0 | GitHub API (total_count = 0) |
| YouTube `@norfold` | **TAKEN** — HTTP 200 title "norfold - YouTube" vs control HTTP 404 | HTTP + control |
| npm package `norfold` | **FREE** (404) | npm registry |
| PyPI package `norfold` | **FREE** (404) | PyPI |
| Apple App Store (US, `term=norfold`) | **No `Norfold` app** — 2 results, both unrelated (`Norbula.mn`, `CSE NORPAPER`) | iTunes Search API |
| Google Play (US search) | **No exact `Norfold` app surfaced** — page shows "Search instead for", only query-echo matches | Play HTML + control |
| UK company `Norfold` | **NONE** — Companies House returns no Norfold entity | Companies House + control |
| BD Trademarks Journal No. 340 & No. 342 (2026) | **No `NORFOLD` / `NORDFOLD`** advertised; nearest neighbours only `noraks`, `noramic`, `norkels` | DPDT journal PDFs, control-validated |

### 3.3 Commercial neighbours (risk-relevant)

| Name | What it is | Relevance |
|---|---|---|
| **Nordfold** (`nordfold.ch`) | Live Swiss company, Zurich, founded 2023, **"application development, network security and other IT services"** | **Highest concern.** One character from `Norfold`; same sector (software/IT services). Blurred in speech and in app-store search. |
| `nFold` (`nfold.io`) | Netherlands HR-tech SaaS, **deadpooled** | Low — different spelling/pronunciation |
| `Llc Norfold` | Volza trade profile for a **Russia**-based exporter (1,377 shipments) | Low for software, but it is a legal entity using the name |
| "Norfold LLC (Ukraine)" / "Norfold Limited (China)" | Asserted by a prior AI summary | **UNVERIFIED** — Volza page returns HTTP 403; no independent confirmation found |

### 3.4 Key constraint: Bangladesh is not in the Madrid System

Bangladesh is not a Contracting Party to the Madrid Protocol/Agreement, so:
- a BD-based applicant **cannot** use Madrid as the origin for one multi-country application; and
- Madrid international registrations **do not extend to** Bangladesh.

Claimed by a prior summary; corroborated by Lexology (2024), Tuhin & Partners (2024), Chambers
Trade Marks & Copyright 2026 (Bangladesh) and a WIPO Madrid Working Group document listing
Bangladesh as an *observer*. Primary WIPO member list is JS-rendered and could not be
machine-read → **[INFERRED], high confidence**.

---

## 4. Cost expectations (official fees only — verify at filing time)

All figures verified 2026-10-18 from the sources noted. Bangladesh does **not** allow
multi-class applications, so the per-class official fee repeats.

### Bangladesh (DPDT) — per class

| Step | Form | Official fee |
|---|---|---|
| Pre-filing search | TM-4 | BDT 2,000 + 15% VAT (+ ~BDT 500 misc) ≈ **BDT 2,800** |
| Application | TM-1 | BDT 5,000 + 15% VAT ≈ **BDT 5,750** |
| Journal publication | TM-9 | BDT 3,000 + 15% VAT ≈ **BDT 3,450** |
| Registration certificate | TM-11 | **BDT 15,000** |
| **Official total, 1 class** | | **≈ BDT 27,000 (~US$220)** |
| Renewal every 10 yrs | | BDT 20,000 (late: +5,000; reinstatement: 2,000) |

Sources: Tuhin & Partners, JK Associates, aeenx, DPDT journal text. **Add local agent/attorney
fees** (typically US$150–500 per class, plus Power-of-Attorney legalisation) and a
**12–24 month** timeline. Opposition window is disputed between sources (60/120 days vs the
journal's own "two months") — confirm with the agent.

### United States (USPTO) — per class

| Item | Fee |
|---|---|
| Base application (§1/§44) | **US$350** |
| Insufficient-information surcharge | +US$100 |
| Free-form goods/services text (instead of ID Manual) | +US$200 → up to **US$550+/class** |
| Extension of protection (Madrid designating US) | US$600/class |
| §8 declaration of use (yr 5–6) | US$325/class |
| §9 renewal (yr 10) | US$325/class |

Source: uspto.gov fee schedule + USPTO fee-change alerts (effective 2025-01-18). US filings
generally require a US-licensed attorney; typical professional fee US$500–1,500 per mark.

### European Union (EUIPO)

€850 first class, **+€50** second class, **+€150** each further class per euipo.europa.eu.
Two classes = €900. No local agent required to file.

### United Kingdom (UKIPO) — from 1 April 2026

£205 online, first class; **+£60** per additional class (paper £250). Renewal £245 + £60/class.
Source: GOV.UK TM3 (REV April 26) + CITMA/UKFT fee announcements.

### Domains

`norfold.app`/`.dev`/`.io` ≈ US$10–15/yr (`.app`/`.dev` force HTTPS). `.com.bd` is cheap via
BTCL-accredited registrars. `norfold.com` is parked on Namecheap + `registrar-servers.com` —
acquiring it means brokering with the holder (brandable short names commonly ask
US$500–5,000+; no listed price found).

### Indicative BD-only launch budget

| Scenario | Official | + agent (est.) | Total (est.) |
|---|---|---|---|
| 1 class (9 — downloadable app) | ~BDT 27,000 | US$200–500 | ~US$420–720 |
| 2 classes (9 + 42 SaaS) | ~BDT 54,000 | US$300–700 | ~US$700–1,200 |
| 3 classes (9 + 42 + 45 lost-property services) | ~BDT 81,000 | US$450–1,000 | ~US$1,000–1,700 |

---

## 5. Verdict — CAUTION

**Why not GO:** `Nordfold` (Swiss, live, IT/software services) is one character away and in the
same sector; `norfold.com` and YouTube `@norfold` are gone; GitHub `@Norfold` is held (though
dormant and reclaimable via GitHub's inactive-username policy).

**Why not NO-GO:** Nobody appears to hold `NORFOLD` as a software mark in the checks that did
run; no BD company, no BD journal publication, no app-store app, no npm/PyPI/UK-company
collision; and the owner already has brand assets, an app id and a live pre-release site.

**Corrective actions (in order):**
1. Confirm ownership of `norfold.app` and switch the public site off `norfold.pages.dev`.
2. Have a BD agent run the TM-4 search in classes 9, 42 (and 45 if the lost-property service
   is filed under Norfold) — **before** renaming FindBack everywhere.
3. File `NORFOLD` as a **word mark** (not just logo) in BD; the word mark is the durable asset.
4. Register the mark **before** the public launch of `FindBack` → `Norfold Find`.
5. Consider `norfold.io` / `norfold.dev` alongside `.app` for search and email identity.
6. Keep dated first-use evidence: commits, releases, screenshots, store listings, domain invoices.
7. Do **not** plan on Madrid from a BD entity; if multi-country protection is wanted, either file
   nationally per market or form a company in a Madrid member state first.

---

## 6. Gaps / what this audit does NOT establish

- **Trademark register coverage.** USPTO (Trademark Center / `tmsearch` API), EUIPO eSearch,
  UKIPO search and WIPO Global Brand Database all blocked automated access (Cloudflare
  challenge, CAPTCHA, ALTCHA, 404 API paths, `uspto.report` 403). USPTO bulk-data host and
  Google DoH were unreachable from this environment. **No US/EU/UK/WIPO register conclusion
  was reached.** These must be searched manually or by an agent.
- **BD register coverage.** Only Trademarks Journal No. 340 and No. 342 (2026) plus one 2024
  PDF were searched. The DPDT WIPO-Publish search portal
  (`bd.publish.wipo.net/wopublish-search/public/home`) is reachable but its API paths 404 —
  it is a manual, browser-only search.
- **Corporate registries.** Only the UK register was checked. Ukraine and China entity claims
  are unverified; RJSC (Bangladesh) was not checked.
- Not legal advice. Trademark availability is a legal judgment made by examiners, not a screen.
