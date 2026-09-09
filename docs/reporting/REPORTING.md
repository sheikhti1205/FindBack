# FindBack — Reporting Guide

This document describes how to produce reports from FindBack data for the course's
"Crystal Reports" style requirement.

## Decision log

- The app cannot ship a proprietary `.rpt` engine or run Windows-only tooling from this
  environment. Per `DEFERRED_DECISIONS.md`, FindBack provides:
  1. a first-class, documented **REST reporting API** that returns JSON or CSV, and
  2. the exact **schema + queries** needed to connect a desktop reporting tool
     (Crystal Reports, Microsoft Report Builder, Excel/Power Query) to the same database.
- A `.rpt` design file and the SQL Server/OLE-DB connection to SQLite would be produced
  on a Windows machine with Crystal Reports installed (out of scope here).

## 1. Reporting API

Authenticated endpoint (JWT bearer token):

```
GET /reports/activity?days=<1..90>&format=<json|csv>
```

| Parameter | Default | Description |
| --- | --- | --- |
| `days` | 14 | Look-back window for the daily series (clamped 1..90) |
| `format` | `json` | `json` or `csv` (CSV is a downloadable file) |

### JSON shape

```jsonc
{
  "generatedAt": "2026-09-09T12:00:00.000Z",
  "summary": {
    "totalPosts": 42, "openPosts": 30, "recoveredPosts": 6,
    "matchedPosts": 2, "closedPosts": 4,
    "lostPosts": 20, "foundPosts": 22,
    "totalUsers": 8, "totalComments": 15, "totalReactions": 12,
    "totalRatings": 9, "averageRating": 3.9,
    "postsLast7Days": 5
  },
  "byDay": [{ "date": "2026-09-08", "posts": 1, "comments": 0, "newUsers": 0 }],
  "byType":   [{ "type": "FOUND", "count": 22 }],
  "byStatus": [{ "status": "OPEN", "count": 30 }],
  "byCategory": [{ "category": "Electronics", "count": 9 }],
  "topContributors": [{ "username": "rafi_cu", "posts": 3, "comments": 2 }]
}
```

### Example calls

```bash
# login once to obtain a token
TOKEN=$(curl -s -X POST http://localhost:4000/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"rafi_cu","password":"password123"}' | jq -r .token)

curl -s http://localhost:4000/reports/activity?days=14 \
  -H "Authorization: Bearer $TOKEN" | jq .

# CSV export
curl -s -o findback-activity.csv \
  "http://localhost:4000/reports/activity?days=30&format=csv" \
  -H "Authorization: Bearer $TOKEN"
```

The CSV file can be opened directly in Microsoft Excel or fed to any BI tool, including
Crystal Reports' "database export" workflow.

## 2. Direct queries (for Crystal Reports / Report Builder)

The whole database is one SQLite file: `services/api/data/findback.db` (default in
development; override with the `DB_FILE` env var). Any ODBC/OLE-DB SQLite driver can open
it read-only.

### "Lost & Found activity" (main report)

```sql
SELECT strftime('%Y-%m', created_at)                     AS month,
       COUNT(*)                                          AS posts,
       SUM(type = 'LOST')                                AS lost_posts,
       SUM(type = 'FOUND')                               AS found_posts,
       SUM(status = 'RECOVERED')                         AS recovered
FROM item_posts
GROUP BY strftime('%Y-%m', created_at)
ORDER BY month;
```

### "Top contributors" (ranking)

```sql
SELECT u.username,
       COUNT(DISTINCT p.id) AS posts,
       COUNT(DISTINCT c.id) AS comments
FROM users u
LEFT JOIN item_posts p ON p.user_id = u.id
LEFT JOIN comments  c ON c.user_id = u.id
GROUP BY u.id
ORDER BY posts + comments DESC;
```

### "Items by category & status" (matrix)

```sql
SELECT category, status, COUNT(*) AS count
FROM item_posts
GROUP BY category, status
ORDER BY category, status;
```

### "Reactions & ratings engagement"

```sql
SELECT p.title,
       p.type,
       COUNT(DISTINCT r.id)                  AS reactions,
       COUNT(DISTINCT rt.id)                 AS ratings,
       ROUND(AVG(rt.score), 1)               AS avg_score
FROM item_posts p
LEFT JOIN reactions r ON r.post_id = p.id
LEFT JOIN ratings  rt ON rt.post_id = p.id
GROUP BY p.id
ORDER BY reactions DESC;
```

## 3. Ad-hoc console reporting

Convenience script `scripts/report-activity.mjs` (run from the repo root) prints a
terminal summary table and can also write `report.csv`:

```bash
node scripts/report-activity.mjs            # prints JSON summary
node scripts/report-activity.mjs --csv out.csv
```

## 4. Crystal Reports import steps (external tool)

1. Open Crystal Reports → *Create New Connection* → *ODBC* → SQLite ODBC driver.
2. Point DSN at `services/api/data/findback.db`.
3. Add the tables used by the queries above; link on primary/foreign keys.
4. Re-create the SQL statements from section 2 as command objects.
5. Design layout pages (monthly activity, category/status matrix, contributor ranking).
6. Export/print from the report designer.

A canonical `.rpt` file is intentionally not committed — generating it requires the
licensed Windows-only Crystal Reports designer.
