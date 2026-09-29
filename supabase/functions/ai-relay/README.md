# ai-relay — OpenAI / DeepSeek secure relay (AI-021)

Authenticated Supabase Edge Function. Mobile calls it over its signed-in
session with `{ provider, messages }`; the provider secret lives only in
this function's environment and is never logged, echoed, or returned.

## Required server env (never in mobile source)

```bash
supabase secrets set \
  AI_RELAY_OPENAI_API_KEY="..." \
  AI_RELAY_DEEPSEEK_API_KEY="..."
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` are provisioned by the platform and
are used for session verification only.

## Optional server env

| Var | Default |
| --- | --- |
| `AI_RELAY_OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `AI_RELAY_OPENAI_MODEL` | `gpt-4o-mini` |
| `AI_RELAY_DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `AI_RELAY_DEEPSEEK_MODEL` | `deepseek-chat` |

## Request / response

`POST` with the session `Authorization: Bearer <jwt>` header:

```json
{ "provider": "openai", "messages": [{ "role": "user", "content": "Hello" }] }
```

- `stream: false` (default) → `200 { "text", "provider", "model" }`
- `stream: true` → `200 text/event-stream` SSE passthrough from the provider
- Unknown provider / bad shape → `400`; no session → `401`; provider
  secret missing → `503 { "code": "provider_not_configured" }`;
  upstream rate limit → `429`; other upstream failures → `502`.
  Upstream bodies are never echoed.

Bounds: ≤ 20 messages, ≤ 4_000 chars per message, ≤ 16_000 chars total,
15 s upstream timeout, answers clipped to 6_000 chars.

## Deploy (owner-gated — docs only, do NOT deploy from feature work)

```bash
supabase secrets set AI_RELAY_OPENAI_API_KEY="..." AI_RELAY_DEEPSEEK_API_KEY="..."
supabase functions deploy ai-relay
```

Live smoke (needs a signed-in session token and deployed secrets):

```bash
curl -X POST "$SUPABASE_URL/functions/v1/ai-relay" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "content-type: application/json" \
  -d '{"provider":"openai","messages":[{"role":"user","content":"Reply with the word ok."}]}'
```

## Checks

```bash
deno check supabase/functions/ai-relay/index.ts
deno test supabase/functions/ai-relay/
```
