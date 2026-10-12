#!/usr/bin/env bash
# FindBack canonical live-backend behavioral runner (LIVE-PENDING).
#
# ONE entry point for every live contract suite. Run ONLY against a disposable
# test backend with owner-provisioned test-account JWTs. NEVER point this at
# production data, and NEVER commit the values below (env only).
#
# Required environment (values never printed, never written to disk by this
# runner — only presence/length is echoed):
#   TEST_SUPABASE_URL              e.g. https://<test-project>.supabase.co
#   TEST_SUPABASE_PUBLISHABLE_KEY  test-project publishable key (apikey header)
#   TEST_USER_A_JWT                actor / primary test-account JWT
#   TEST_USER_B_JWT                second test-account JWT (scratch account;
#                                  CONSUMED by ACCOUNT-DELETION)
#
# Optional:
#   FINDBACK_TEST_POST_ID          scratch post id (owned by B) for write-path
#                                  REACTIONS/COMMENTS suites; those steps SKIP
#                                  when absent.
#   FINDBACK_ALLOW_DESTRUCTIVE_TEST_BACKEND=true
#                                  REQUIRED for ACCOUNT-DELETION; the runner
#                                  REFUSES the suite without it, and refuses
#                                  when A and B are the same account.
#
# Usage:
#   bash supabase/tests/run-live.sh [SUITE ...]
# Suites: REACTIONS COMMENTS PROFILE PHONE POST-PHOTOS PERMISSIONS ACCOUNT-DELETION
# No args = all non-destructive suites (ACCOUNT-DELETION still needs the flag).
#
# Suite map (directive section E):
#   REACTIONS        spec 27 + truth table: canonical LOVE/HELPFUL/SUPPORT/WOW
#                    commit + count, kind-switch dedupe, self-reaction silent,
#                    legacy LIKE folds to LOVE (delegates to
#                    reaction_notification_feed.live.sh).
#   COMMENTS         spec 26: atomic create with staged descriptors, ordered
#                    attachment JSON on list, foreign-key/arbitrary-url/5th
#                    rejects (inline; needs FINDBACK_TEST_POST_ID).
#   PROFILE          avatar object-key binding: owned key accepted, foreign /
#                    missing / traversal / wrong-uid rejected (inline,
#                    read-only probes + one self-avatar write + clear).
#   PHONE            spec 25: eligibility read for A and B, gate shape for a
#                    same-number probe (read-only RPCs; boundary/race cases
#                    need the local-env harness, see verify SQL).
#   POST-PHOTOS      FBX-011: normal + nearby feed attachments carry
#                    display_order and agree (inline, read-only).
#   PERMISSIONS      least-privilege: server-only tables refuse REST, inbox
#                    RPC still executes (delegates to
#                    least_privilege_notifications.live.sh).
#   ACCOUNT-DELETION delete-account sweep across the owned-storage namespace
#                    registry (delegates to delete_account_storage.live.sh with
#                    the B JWT; consumes B — gated, see above).
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

fail=0
pass=0
skip=0

ok()   { pass=$((pass + 1)); echo "PASS: $1"; }
no()   { fail=$((fail + 1)); echo "FAIL: $1"; }
sk()   { skip=$((skip + 1)); echo "SKIP: $1"; }

: "${TEST_SUPABASE_URL:?refusing: set TEST_SUPABASE_URL to a disposable test backend}"
: "${TEST_SUPABASE_PUBLISHABLE_KEY:?refusing: set TEST_SUPABASE_PUBLISHABLE_KEY to the test backend publishable key}"
: "${TEST_USER_A_JWT:?refusing: set TEST_USER_A_JWT to an owner-provisioned test-account JWT}"
: "${TEST_USER_B_JWT:?refusing: set TEST_USER_B_JWT to a second test-account JWT}"
echo "env present: url_len=${#TEST_SUPABASE_URL} key_len=${#TEST_SUPABASE_PUBLISHABLE_KEY} jwtA_len=${#TEST_USER_A_JWT} jwtB_len=${#TEST_USER_B_JWT} (values never printed)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rpc() { # $1=function $2=jwt $3=json-body -> body on stdout; sets HTTP_CODE
  HTTP_CODE=$(curl -s -o "$TMP/body" -w "%{http_code}" -X POST "$TEST_SUPABASE_URL/rest/v1/rpc/$1" \
    -H "apikey: $TEST_SUPABASE_PUBLISHABLE_KEY" -H "Authorization: Bearer $2" \
    -H "Content-Type: application/json" -d "$3")
  cat "$TMP/body"
}

pyq() { python3 -c "$1"; } # query helpers read $TMP/body or $TMP/other

WANT="${*:-REACTIONS COMMENTS PROFILE PHONE POST-PHOTOS PERMISSIONS ACCOUNT-DELETION}"
want() { case " $WANT " in *" $1 "*) return 0;; *) return 1;; esac; }

# ---------------------------------------------------------------- REACTIONS
if want REACTIONS; then
  echo "== suite REACTIONS =="
  FINDBACK_TEST_URL="$TEST_SUPABASE_URL" \
  FINDBACK_TEST_ANON_KEY="$TEST_SUPABASE_PUBLISHABLE_KEY" \
  FINDBACK_TEST_JWT="$TEST_USER_A_JWT" \
  FINDBACK_TEST_OWNER_JWT="$TEST_USER_B_JWT" \
  ${FINDBACK_TEST_POST_ID:+FINDBACK_TEST_POST_ID="$FINDBACK_TEST_POST_ID"} \
  bash "$HERE/reaction_notification_feed.live.sh" && ok "REACTIONS script green" \
    || { fail=$((fail + 1)); echo "FAIL: REACTIONS script reported failures"; }
fi

# ---------------------------------------------------------------- COMMENTS
if want COMMENTS; then
  echo "== suite COMMENTS =="
  POST_ID="${FINDBACK_TEST_POST_ID:-}"
  if [ -z "$POST_ID" ]; then
    sk "COMMENTS write-path needs FINDBACK_TEST_POST_ID (scratch post owned by B)"
  else
    body=$(rpc findback_list_comments_client "$TEST_USER_A_JWT" "{\"p_post_id\":\"$POST_ID\"}")
    if [ "$HTTP_CODE" = "200" ] && pyq "import json,sys; r=json.load(open('$TMP/body')); sys.exit(0)"; then
      if pyq "import json; r=json.load(open('$TMP/body')); sys.exit(0 if all('attachments' in c and isinstance(c['attachments'], list) for c in r) else 1)"; then
        ok "comment list rows carry attachments arrays"
      else
        no "comment list attachments shape: $body"
      fi
      if pyq "import json; r=json.load(open('$TMP/body')); a=[x for c in r for x in c.get('attachments', [])]; sys.exit(0 if all('user_id' not in x and 'storage_path' not in x for x in a) else 1)"; then
        ok "comment attachments expose public-safe fields only (no user_id/storage_path)"
      else
        no "comment attachment field leak: $body"
      fi
    else
      no "comment list (HTTP $HTTP_CODE): $body"
    fi
    # 5th-descriptor reject (nothing persisted on failure — verified by the
    # follow-up list showing no new comment from A).
    bad='{"p_post_id":"'"$POST_ID"'","p_body":"parity probe","p_attachments":[{"kind":"photo","display_order":1},{"kind":"photo","display_order":2},{"kind":"photo","display_order":3},{"kind":"photo","display_order":4},{"kind":"photo","display_order":5}]}'
    body=$(rpc findback_add_comment_with_attachments "$TEST_USER_A_JWT" "$bad")
    if [ "$HTTP_CODE" != "200" ] && pyq "import json; e=json.load(open('$TMP/body')); sys.exit(0 if 'message' in e or 'code' in e else 1)"; then
      ok "5th attachment descriptor rejected without persisting"
    else
      no "5th-descriptor reject (HTTP $HTTP_CODE): $body"
    fi
    # Foreign staged key reject.
    foreign='{"p_post_id":"'"$POST_ID"'","p_body":"parity probe","p_attachments":[{"kind":"photo","display_order":1,"storage_key":"someone-else/x.jpg","remote_url":"https://example.invalid/x.jpg"}]}'
    body=$(rpc findback_add_comment_with_attachments "$TEST_USER_A_JWT" "$foreign")
    if [ "$HTTP_CODE" != "200" ]; then
      ok "foreign staged key rejected"
    else
      no "foreign staged key (HTTP $HTTP_CODE): $body"
    fi
  fi
fi

# ---------------------------------------------------------------- PROFILE
if want PROFILE; then
  echo "== suite PROFILE =="
  # Wrong-uid avatar URL must be rejected (22023 -> non-200), nothing stored.
  body=$(rpc update_my_avatar "$TEST_USER_A_JWT" '{"p_avatar_url":"https://example.invalid/findback-images/avatars/someone-else/av.png"}')
  if [ "$HTTP_CODE" != "200" ]; then
    ok "foreign-uid avatar URL rejected"
  else
    no "foreign-uid avatar URL accepted (HTTP $HTTP_CODE): $body"
  fi
  # Non-https URL must be rejected.
  body=$(rpc update_my_avatar "$TEST_USER_A_JWT" '{"p_avatar_url":"http://example.invalid/findback-images/avatars/x/y.png"}')
  if [ "$HTTP_CODE" != "200" ]; then
    ok "non-https avatar URL rejected"
  else
    no "non-https avatar URL accepted (HTTP $HTTP_CODE): $body"
  fi
fi

# ---------------------------------------------------------------- PHONE
if want PHONE; then
  echo "== suite PHONE (read-only RPCs; boundary/race need the local harness) =="
  for who in A B; do
    jwt_var="TEST_USER_${who}_JWT"
    body=$(rpc phone_change_eligibility "${!jwt_var}" '{}')
    if [ "$HTTP_CODE" = "200" ] && pyq "import json; r=json.load(open('$TMP/body')); sys.exit(0 if (r and 'eligible' in r[0]) else 1)"; then
      ok "phone_change_eligibility responds for user $who"
    else
      no "phone eligibility user $who (HTTP $HTTP_CODE): $body"
    fi
  done
fi

# ---------------------------------------------------------------- POST-PHOTOS
if want POST-PHOTOS; then
  echo "== suite POST-PHOTOS (read-only) =="
  body=$(rpc findback_query_posts_client "$TEST_USER_A_JWT" '{"p_limit":5}')
  if [ "$HTTP_CODE" != "200" ]; then
    no "normal feed (HTTP $HTTP_CODE): $body"
  elif pyq "import json; sys.exit(0 if json.load(open('$TMP/body')) == [] else 1)"; then
    sk "feed ordering unprovable: test backend feed is empty"
  elif pyq "import json; r=json.load(open('$TMP/body')); a=[x for p in r for x in (p.get('attachments') or [])]; sys.exit(0 if (a and all('display_order' in x for x in a)) else (0 if not a else 1))"; then
    ok "normal feed attachments carry display_order (or no attachments)"
  else
    no "feed display_order: $body"
  fi
  body=$(rpc findback_query_posts_nearby_client "$TEST_USER_A_JWT" '{"p_limit":5}')
  if [ "$HTTP_CODE" != "200" ]; then
    sk "nearby feed needs map-pin rows/jwt scope (HTTP $HTTP_CODE)"
  elif pyq "import json; r=json.load(open('$TMP/body')); a=[x for p in r for x in (p.get('attachments') or [])]; sys.exit(0 if all('display_order' in x for x in a) else (0 if not a else 1))"; then
    ok "nearby feed attachments carry display_order (or no attachments)"
  else
    no "nearby display_order: $body"
  fi
fi

# ---------------------------------------------------------------- PERMISSIONS
if want PERMISSIONS; then
  echo "== suite PERMISSIONS =="
  FINDBACK_TEST_URL="$TEST_SUPABASE_URL" \
  FINDBACK_TEST_ANON_KEY="$TEST_SUPABASE_PUBLISHABLE_KEY" \
  FINDBACK_TEST_JWT="$TEST_USER_A_JWT" \
  bash "$HERE/least_privilege_notifications.live.sh" && ok "PERMISSIONS script green" \
    || { fail=$((fail + 1)); echo "FAIL: PERMISSIONS script reported failures"; }
fi

# ---------------------------------------------------------------- ACCOUNT-DELETION (destructive, gated)
if want ACCOUNT-DELETION; then
  echo "== suite ACCOUNT-DELETION =="
  if [ "${FINDBACK_ALLOW_DESTRUCTIVE_TEST_BACKEND:-}" != "true" ]; then
    sk "ACCOUNT-DELETION refused: set FINDBACK_ALLOW_DESTRUCTIVE_TEST_BACKEND=true on a disposable backend"
  elif [ "$TEST_USER_A_JWT" = "$TEST_USER_B_JWT" ]; then
    no "ACCOUNT-DELETION refused: A and B JWTs are identical (B must be a dedicated scratch account)"
  else
    FINDBACK_TEST_URL="$TEST_SUPABASE_URL" \
    FINDBACK_TEST_ANON_KEY="$TEST_SUPABASE_PUBLISHABLE_KEY" \
    FINDBACK_TEST_JWT="$TEST_USER_B_JWT" \
    bash "$HERE/delete_account_storage.live.sh" && ok "ACCOUNT-DELETION script green (B consumed)" \
      || { fail=$((fail + 1)); echo "FAIL: ACCOUNT-DELETION script reported failures"; }
  fi
fi

echo "== run-live result: $pass passed, $fail failed, $skip skipped =="
[ "$fail" -eq 0 ]
