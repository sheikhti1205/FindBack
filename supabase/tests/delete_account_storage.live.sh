#!/usr/bin/env bash
# W1-B live contract tests: FBX-023 / FBX-037 — delete-account storage sweep
# (LIVE-PENDING). Run ONLY against a disposable test backend.
#
#   FINDBACK_TEST_URL="https://<test-project>.supabase.co" \
#   FINDBACK_TEST_ANON_KEY="<test-project-publishable-key>" \
#   FINDBACK_TEST_JWT="<scratch-account-jwt>" \
#   bash supabase/tests/delete_account_storage.live.sh
#
# IMPORTANT: the scratch account is CONSUMED by this script — the
# delete-account function deletes its auth user, so provision a throwaway
# account per run and never reuse the JWT afterwards. The script refuses to
# run unless FINDBACK_TEST_URL, FINDBACK_TEST_ANON_KEY and FINDBACK_TEST_JWT
# are set. The publishable key travels ONLY in the `apikey` header; the
# account JWT travels ONLY in `Authorization`.
#
# What it proves, per namespace (FBX-023 registry):
#   * objects under findback-images/<uid>/ are deleted;
#   * objects under findback-images/avatars/<uid>/ are deleted when that
#     layout exists live (SKIP when the owner-prefix RLS refuses the seed —
#     the layout was never writable, so there is nothing to sweep);
#   * objects under findback-comment-media/<uid>/ are deleted;
#   * the JWT's own session cannot call the function after deletion (auth
#     user is gone), and an unauthenticated call is refused (FBX-037 guard
#     surface: the function takes no uid parameter — cross-user deletion is
#     impossible by construction).
set -u

fail=0
pass=0
skip=0

ok()   { pass=$((pass + 1)); echo "PASS: $1"; }
no()   { fail=$((fail + 1)); echo "FAIL: $1"; }
sk()   { skip=$((skip + 1)); echo "SKIP: $1"; }

: "${FINDBACK_TEST_URL:?refusing: set FINDBACK_TEST_URL to a disposable test backend}"
: "${FINDBACK_TEST_ANON_KEY:?refusing: set FINDBACK_TEST_ANON_KEY to the test backend publishable key}"
: "${FINDBACK_TEST_JWT:?refusing: set FINDBACK_TEST_JWT to a scratch account JWT (this account will be deleted)}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

api() { # $1=METHOD $2=path $3=extra-header-array... -> body in $TMP/body, sets HTTP_CODE
  local method=$1 path=$2; shift 2
  HTTP_CODE=$(curl -s -o "$TMP/body" -w "%{http_code}" -X "$method" "$FINDBACK_TEST_URL$path" \
    -H "apikey: $FINDBACK_TEST_ANON_KEY" -H "Authorization: Bearer $FINDBACK_TEST_JWT" "$@")
}

echo "== resolve scratch uid =="
api GET "/auth/v1/user"
if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL: cannot resolve scratch user (HTTP $HTTP_CODE): $(cat "$TMP/body")"
  exit 1
fi
UID_VAL=$(python3 -c "import json,sys; print(json.load(open('$TMP/body'))['id'])")
echo "scratch uid: $UID_VAL"

seed_object() { # $1=bucket $2=relative-path -> 0 when seeded, 1 when RLS refused
  api POST "/storage/v1/object/$1/$2" \
    -H "Content-Type: image/jpeg" --data-binary "w1b-delete-probe"
  [ "$HTTP_CODE" = "200" ]
}

check_gone() { # $1=bucket $2=relative-path $3=label
  api GET "/storage/v1/object/public/$1/$2"
  if [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "400" ]; then
    ok "$3 object is gone after delete-account"
  else
    no "$3 object still readable after delete-account (HTTP $HTTP_CODE)"
  fi
}

echo "== seed probe objects (FBX-023 namespaces) =="
IMAGES_SEEDED=0; AVATARS_SEEDED=0; COMMENTS_SEEDED=0

if seed_object findback-images "$UID_VAL/probe.jpg"; then
  IMAGES_SEEDED=1; ok "seeded findback-images/$UID_VAL/probe.jpg"
else
  no "cannot seed findback-images/$UID_VAL/probe.jpg (HTTP $HTTP_CODE): $(cat "$TMP/body")"
fi

if seed_object findback-images "avatars/$UID_VAL/probe.jpg"; then
  AVATARS_SEEDED=1; ok "seeded findback-images/avatars/$UID_VAL/probe.jpg"
else
  sk "avatars/$UID_VAL/ seed refused (HTTP $HTTP_CODE) — owner-prefix RLS never allowed this layout, nothing to sweep"
fi

if seed_object findback-comment-media "$UID_VAL/probe.jpg"; then
  COMMENTS_SEEDED=1; ok "seeded findback-comment-media/$UID_VAL/probe.jpg"
else
  no "cannot seed findback-comment-media/$UID_VAL/probe.jpg (HTTP $HTTP_CODE): $(cat "$TMP/body") (apply 20261011030000 first)"
fi

SEEDED=$((IMAGES_SEEDED + AVATARS_SEEDED + COMMENTS_SEEDED))

echo "== invoke delete-account with the scratch JWT =="
api POST "/functions/v1/delete-account" -H "Content-Type: application/json" -d '{}'
if [ "$HTTP_CODE" = "404" ]; then
  sk "delete-account not deployed on this backend (HTTP 404) — deploy the function, then rerun"
  exit 0
fi
if [ "$HTTP_CODE" != "200" ]; then
  no "delete-account failed (HTTP $HTTP_CODE): $(cat "$TMP/body")"
  exit 1
fi
REMOVED=$(python3 -c "import json,sys; print(json.load(open('$TMP/body')).get('storageRemoved',0))")
PROFILE=$(python3 -c "import json,sys; print(json.load(open('$TMP/body')).get('profileDeleted'))")
AUTHGONE=$(python3 -c "import json,sys; print(json.load(open('$TMP/body')).get('authDeleted'))")
if [ "$PROFILE" = "True" ] && [ "$AUTHGONE" = "True" ] && [ "$REMOVED" -ge "$SEEDED" ]; then
  ok "delete-account reported storageRemoved=$REMOVED (>= $SEEDED seeded), profileDeleted, authDeleted"
else
  no "delete-account body incomplete: $(cat "$TMP/body") (seeded=$SEEDED)"
fi

echo "== verify seeded objects are gone =="
[ "$IMAGES_SEEDED" = "1" ] && check_gone findback-images "$UID_VAL/probe.jpg" "findback-images/<uid>/"
[ "$AVATARS_SEEDED" = "1" ] && check_gone findback-images "avatars/$UID_VAL/probe.jpg" "findback-images/avatars/<uid>/"
[ "$COMMENTS_SEEDED" = "1" ] && check_gone findback-comment-media "$UID_VAL/probe.jpg" "findback-comment-media/<uid>/"

echo "== the deleted account's own session is dead (FBX-037) =="
api POST "/functions/v1/delete-account" -H "Content-Type: application/json" -d '{}'
if [ "$HTTP_CODE" = "401" ]; then
  ok "re-invoking with the deleted account's JWT is refused (401)"
else
  no "re-invoking with the deleted account's JWT returned HTTP $HTTP_CODE (expected 401): $(cat "$TMP/body")"
fi

echo "== unauthenticated invoke is refused =="
HTTP_CODE=$(curl -s -o "$TMP/body" -w "%{http_code}" -X POST "$FINDBACK_TEST_URL/functions/v1/delete-account" \
  -H "apikey: $FINDBACK_TEST_ANON_KEY" -H "Content-Type: application/json" -d '{}')
if [ "$HTTP_CODE" = "401" ]; then
  ok "unauthenticated invoke is refused (401)"
else
  no "unauthenticated invoke returned HTTP $HTTP_CODE (expected 401)"
fi

echo "== summary: $pass passed, $fail failed, $skip skipped =="
[ "$fail" -eq 0 ]
