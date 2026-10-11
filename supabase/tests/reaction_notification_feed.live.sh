#!/usr/bin/env bash
# W1-A live contract tests: FBX-009 / FBX-010 / FBX-011 (LIVE-PENDING).
#
# Run ONLY against a disposable test backend with an owner-provisioned
# test-account JWT. NEVER point this at production data.
#
#   FINDBACK_TEST_URL="https://<test-project>.supabase.co" \
#   FINDBACK_TEST_ANON_KEY="<test-project-publishable-key>" \
#   FINDBACK_TEST_JWT="<reactor-test-account-jwt>" \
#   FINDBACK_TEST_OWNER_JWT="<scratch-post-owner-jwt>" \
#   FINDBACK_TEST_POST_ID="<scratch-post-id-owned-by-owner>" \
#   bash supabase/tests/reaction_notification_feed.live.sh
#
# The script refuses to run unless FINDBACK_TEST_URL, FINDBACK_TEST_ANON_KEY
# and FINDBACK_TEST_JWT are set. The publishable key travels ONLY in the
# `apikey` header; user JWTs travel ONLY in `Authorization` (never reuse a
# JWT as the apikey). Write-path steps react on the scratch post and clean
# up after themselves (reaction removed, notification deleted); read-only
# steps touch nothing. OWNER_JWT-gated inbox assertions SKIP when absent.
set -u

fail=0
pass=0
skip=0

ok()   { pass=$((pass + 1)); echo "PASS: $1"; }
no()   { fail=$((fail + 1)); echo "FAIL: $1"; }
sk()   { skip=$((skip + 1)); echo "SKIP: $1"; }

: "${FINDBACK_TEST_URL:?refusing: set FINDBACK_TEST_URL to a disposable test backend}"
: "${FINDBACK_TEST_ANON_KEY:?refusing: set FINDBACK_TEST_ANON_KEY to the test backend publishable key}"
: "${FINDBACK_TEST_JWT:?refusing: set FINDBACK_TEST_JWT to an owner-provisioned test-account JWT}"
POST_ID="${FINDBACK_TEST_POST_ID:-}"
OWNER_JWT="${FINDBACK_TEST_OWNER_JWT:-}"

rpc() { # $1=function $2=jwt $3=json-body -> response body; sets HTTP_CODE
  HTTP_CODE=$(curl -s -o /tmp/w1a_resp.json -w "%{http_code}" \
    -X POST "$FINDBACK_TEST_URL/rest/v1/rpc/$1" \
    -H "apikey: $FINDBACK_TEST_ANON_KEY" \
    -H "Authorization: Bearer $2" \
    -H "Content-Type: application/json" \
    -d "$3")
  cat /tmp/w1a_resp.json
}

py() { python3 -c "$1"; }

echo "== FBX-010/011 read-only: feed RPC shape =="
body=$(rpc findback_query_posts_client "$FINDBACK_TEST_JWT" '{"p_limit":1}')
if [ "$HTTP_CODE" != "200" ]; then
  no "normal feed shape (HTTP $HTTP_CODE): $body"
elif py "import json; import sys; sys.exit(0 if json.load(open('/tmp/w1a_resp.json')) == [] else 1)"; then
  sk "normal feed shape unprovable: test backend feed is empty"
elif py "import json,sys; r=json.load(open('/tmp/w1a_resp.json')); sys.exit(0 if (r and all(k in r[0] for k in ('reaction_counts','reaction_total','my_reaction','like_count','dislike_count','attachments'))) else 1)"; then
  ok "normal feed rows carry reaction_counts + reaction_total + my_reaction (legacy counts kept)"
else
  no "normal feed shape (HTTP $HTTP_CODE): $body"
fi

if [ "$HTTP_CODE" = "200" ] && py "import json,sys; r=json.load(open('/tmp/w1a_resp.json')); a=((r[0].get('attachments') if r else None) or []); sys.exit(0 if all('display_order' in x for x in a) else (0 if not a else 1))"; then
  ok "FBX-011 normal feed attachments carry display_order (or post has none)"
else
  no "FBX-011 attachment display_order: $body"
fi

echo "== FBX-009 read-only: inbox RPC shape =="
body=$(rpc findback_list_notifications_client "$FINDBACK_TEST_JWT" '{"p_deleted":false}')
if [ "$HTTP_CODE" = "200" ] && py "import json,sys; r=json.load(open('/tmp/w1a_resp.json')); sys.exit(0 if all('reaction_kind' in x for x in r) else (0 if not r else 1))"; then
  ok "inbox rows carry reaction_kind (or inbox empty)"
else
  no "inbox shape (HTTP $HTTP_CODE): $body"
fi

if [ -z "$POST_ID" ]; then
  sk "write-path contracts need FINDBACK_TEST_POST_ID (scratch post on the test backend)"
else
  echo "== FBX-009 write-path: canonical LOVE commits + notifies =="
  body=$(rpc findback_react_client "$FINDBACK_TEST_JWT" "{\"p_post_id\":\"$POST_ID\",\"p_type\":\"LOVE\"}")
  if [ "$HTTP_CODE" = "200" ] && py "import json,sys; r=json.load(open('/tmp/w1a_resp.json')); sys.exit(0 if (r and (r[0].get('reaction_counts') or {}).get('LOVE',0) >= 1) else 1)"; then
    ok "LOVE reaction commits and counts canonically (no trigger abort)"
  else
    no "LOVE react (HTTP $HTTP_CODE): $body"
  fi

  if [ -n "$OWNER_JWT" ]; then
    owner_body=$(curl -s -X POST "$FINDBACK_TEST_URL/rest/v1/rpc/findback_list_notifications_client" \
      -H "apikey: $FINDBACK_TEST_ANON_KEY" \
      -H "Authorization: Bearer $OWNER_JWT" \
      -H "Content-Type: application/json" \
      -d '{"p_deleted":false}')
    echo "$owner_body" > /tmp/w1a_owner.json
    if python3 -c "import json; r=json.load(open('/tmp/w1a_owner.json')); raise SystemExit(0 if any(x.get('type')=='REACTION' and x.get('post_id')=='$POST_ID' for x in r) else 1)"; then
      ok "owner inbox holds the REACTION row for the scratch post"
    else
      no "owner REACTION inbox row: $owner_body"
    fi
  else
    sk "owner inbox assertion needs FINDBACK_TEST_OWNER_JWT"
  fi

  echo "== cleanup: remove reaction, delete scratch notification =="
  rpc findback_react_client "$FINDBACK_TEST_JWT" "{\"p_post_id\":\"$POST_ID\",\"p_type\":null}" >/dev/null
  [ "$HTTP_CODE" = "200" ] && ok "scratch LOVE removed" || no "scratch cleanup react (HTTP $HTTP_CODE)"
  if [ -n "$OWNER_JWT" ]; then
    ids=$(echo "$owner_body" | python3 -c "import json,sys; print(','.join(x['id'] for x in json.load(sys.stdin) if x.get('type')=='REACTION' and x.get('post_id')=='$POST_ID'))")
    if [ -n "$ids" ]; then
      arr=$(echo "$ids" | python3 -c "import sys; print('['+','.join('\"'+s+'\"' for s in sys.stdin.read().strip().split(','))+']')")
      curl -s -X POST "$FINDBACK_TEST_URL/rest/v1/rpc/findback_delete_notifications_client" \
        -H "apikey: $FINDBACK_TEST_ANON_KEY" \
        -H "Authorization: Bearer $OWNER_JWT" \
        -H "Content-Type: application/json" \
        -d "{\"p_ids\":$arr}" >/dev/null && ok "scratch REACTION notification deleted" || no "scratch notification cleanup"
    else
      ok "no scratch notification residue"
    fi
  fi
fi

echo "== result: $pass passed, $fail failed, $skip skipped =="
[ "$fail" -eq 0 ]
