# FindBack — Database Schema & Entity Relationship Diagram

Source of truth: `supabase/migrations/20260912000000_init.sql` (production:
Supabase PostgreSQL). The local/test mirror is
`services/api/src/db/sqliteAdapter.ts` (SQLite `node:sqlite`, WAL mode, foreign
keys enforced). All timestamps are ISO-8601 UTC strings.

## ERD (Mermaid)

```mermaid
erDiagram
    users ||--o{ item_posts : "author of"
    users ||--o{ comments : "writes"
    users ||--o{ reactions : "performs"
    users ||--o{ ratings : "gives"
    users ||--o{ verification_challenges : "requests"
    users ||--o{ uploads : "owns"
    item_posts ||--o{ attachments : "has"
    item_posts ||--o{ comments : "receives"
    item_posts ||--o{ reactions : "receives"
    item_posts ||--o{ ratings : "receives"

    users {
        text id PK
        text username UK "collate nocase"
        text email UK "collate nocase"
        text phone UK
        text password_hash
        integer email_verified "0 or 1"
        integer phone_verified "0 or 1"
        text avatar_url
        text created_at
        text updated_at
    }
    item_posts {
        text id PK
        text user_id FK "users.id"
        text type "LOST | FOUND"
        text title
        text description
        text category "enum CATEGORIES"
        text status "OPEN|MATCHED|RECOVERED|CLOSED"
        text event_date
        real latitude
        real longitude
        text location_label
        text youtube_url
        text created_at
        text updated_at
    }
    attachments {
        text id PK
        text post_id FK "item_posts.id"
        text file_url
        text mime_type
        text file_name
        integer file_size
        text created_at
    }
    comments {
        text id PK
        text post_id FK "item_posts.id"
        text user_id FK "users.id"
        text body
        text created_at
        text updated_at
    }
    reactions {
        text id PK
        text post_id FK "item_posts.id"
        text user_id FK "users.id"
        text type "LIKE | DISLIKE"
        text created_at
    }
    ratings {
        text id PK
        text post_id FK "item_posts.id"
        text user_id FK "users.id"
        integer score "1..5"
        text created_at
        text updated_at
    }
    verification_challenges {
        text id PK
        text user_id FK "users.id"
        text channel "EMAIL | PHONE"
        text code_hash
        text expires_at
        text verified_at
        text created_at
    }
    uploads {
        text id PK
        text user_id FK "users.id"
        text file_name
        text mime_type
        integer file_size
        text file_url
        text created_at
    }
```

## Table reference

| Table | Purpose | Uniqueness / rules |
| --- | --- | --- |
| `users` | App accounts (also the demo "reporters/finders") | username, email, phone unique case-insensitive |
| `item_posts` | Lost/found reports | type in (LOST, FOUND); status defaults OPEN; one author per post |
| `attachments` | Image files linked to a post | optional, many per post |
| `comments` | Discussion under a post | one author per comment |
| `reactions` | One like/dislike vote per (post, user) | UNIQUE(post_id, user_id) |
| `ratings` | One 1–5 star rating per (post, user) | UNIQUE(post_id, user_id), score 1..5 |
| `verification_challenges` | Email/phone OTP challenges | hashed code, expiry timestamp |
| `uploads` | Files uploaded but not yet attached to a post | owned by user |

## Business rules enforced

- A reaction or rating is upserted per unique `(post_id, user_id)` — last write wins.
- `reactions`/`ratings` aggregates on posts are derived by `COUNT`, so they never drift.
- Deleting a post cascades to its attachments/comments/reactions/ratings.
- `verification_challenges` records keep an audit trail; successful verification also flips
  `users.email_verified` / `users.phone_verified`.

## Indexes

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_posts_type_created` | type, created_at DESC | feed ordering & type filter |
| `idx_posts_category` | category | category filter + reports |
| `idx_posts_user` | user_id | "my posts" |
| `idx_comments_post` | post_id, created_at | comment listing |
| `idx_challenges_user_channel` | user_id, channel | OTP lookups |
