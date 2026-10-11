#!/usr/bin/env bash
# W1-B live contract tests: FBX-034 — least-privilege grants on server-only
# tables (LIVE-PENDING). Run ONLY against a disposable test backend AFTER
# applying the 20261011* migrations (this file is the post-migration state).
#
#   FINDBACK_TEST_URL="https://<test-project>.supabase.co" \
#   FINDBACK_TEST_ANON_KEY="<test-project-publishable-key>" \
#   FINDBACK_TEST_JWT="<any-authenticated-test-account-jwt>" \
#   bash supabase/tests/least_privilege_notifications.live.sh
#
# Proves, with the authenticated role:
#   * direct REST access to the four server-only tables is refused
#     (notifications / device_tokens / notification_preferences /
#     push_reply_tokens — the FBX-034 revokes);
#   * client-reachable tables are unaffected (positive control on
#     item_posts, so a blanket outage cannot false-pass the denials);
#   * the SECURITY DEFINER inbox RPC still works (RPC EXECUTE grants are
#     function-level and must survive the table-level revokes).
#
# The publishable key travels ONLY in the `apikey` header; the user JWT
# travels ONLY in `Authorization`.
set -u

fail=0
pass=0
skip=0

ok()   { pass=$((pass + 1)); echo "PASS: $1"; }
no()   { fail=$((fail + 1)); echo "FAIL: $1"; }
sk()   { skip=$((skip + 1)); echo "SKIP: $1"; }

: "${FINDBACK_TEST_URL:?refusing: set FINDBACK_TEST_URL to a disposable test backend}"
: "${FINDBACK_TEST_ANON_KEY:?refusing: set FINDBACK_TEST_ANON_KEY to the test backend publishable key}"
: "${FINDBACK_TEST_JWT:?refusing: set FINDBACK_TEST_JWT to an authenticated test-account JWT}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rest() { # $1=METHOD $2=path $3=extra-curl-args... -> body in $TMP/body, sets HTTP_CODE
  local method=$1 path=$2; shift 2
  HTTP_CODE=$(curl -s -o "$TMP/body" -w "%{http_code}" -X "$method" "$FINDBACK_TEST_URL$path" \
    -H "apikey: $FINDBACK_TEST_ANON_KEY" -H "Authorization: Bearer $FINDBACK_TEST_JWT" "$@")
}

expect_denied() { # $1=table-label $2=rest-path
  rest GET "$2?select=id&limit=1"
  if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    ok "$1 direct REST access is refused (HTTP $HTTP_CODE)"
  else
    no "$1 direct REST access returned HTTP $HTTP_CODE (expected 401/403): $(cat "$TMP/body")"
  fi
}

echo "== positive control: client table is still reachable =="
rest GET "/rest/v1/item_posts?select=id&limit=1"
if [ "$HTTP_CODE" = "200" ]; then
  ok "item_posts REST access works (denials below are table-specific, not an outage)"
else
  no "item_posts REST access returned HTTP $HTTP_CODE — cannot attribute later denials to FBX-034"
fi

echo "== FBX-034: server-only tables refuse direct REST access =="
expect_denied "notifications"    "/rest/v1/notifications"
expect_denied "device_tokens"    "/rest/v1/device_tokens"
expect_denied "notification_preferences" "/rest/v1/notification_preferences"
expect_denied "push_reply_tokens"        "/rest/v1/push_reply_tokens"

echo "== RPC surface still works for the authenticated role =="
HTTP_CODE=$(curl -s -o "$TMP/body" -w "%{http_code}" -X POST "$FINDBACK_TEST_URL/rest/v1/rpc/findback_list_notifications_client" \
  -H "apikey: $FINDBACK_TEST_ANON_KEY" -H "Authorization: Bearer $FINDBACK_TEST_JWT" \
  -H "Content-Type: application/json" -d '{"p_deleted":false}')
if [ "$HTTP_CODE" = "200" ]; then
  ok "findback_list_notifications_client RPC still executes for authenticated"
else
  no "findback_list_notifications_client RPC returned HTTP $HTTP_CODE (expected 200): $(cat "$TMP/body")"
fi

echo "== summary: $pass passed, $fail failed, $skip skipped =="
[ "$fail" -eq 0 ]
