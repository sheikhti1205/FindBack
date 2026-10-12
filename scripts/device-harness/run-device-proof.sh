#!/usr/bin/env bash
# run-device-proof.sh — orchestrator: fresh-install proof + evidence collection.
#
# Usage (owner, on a device-authorized host, heavy lock held):
#   scripts/device-harness/run-device-proof.sh --apk <file.apk> [--serial S] [--mode fresh|upgrade]
#
# Creates Communication/DEVICE_<SHA12>_<YYYY-MM-DD>/ with deterministic
# subfolders, runs provenance + install + baseline captures, scrubs every
# collected log of secret patterns, then writes manifest.json:
#   <evidence>/
#     provenance/provenance.json   (apk-provenance.mjs)
#     install/install.log          (fresh or upgrade transcript)
#     baseline/                    (screenshot, uixml, perf all, logcat dump)
#     notification/ map/ media/ ai-bench/   (captures.sh stubs; NOTES.md each)
#     manifest.json                (write-manifest.mjs; fail-closed on secrets)
#
# Heavy-lock rule: NEVER overlap this proof with npm gates (build/lint/test)
# or another emulator proof. Acquire Communication/heavy.lock first; the script
# refuses to run when the lock directory is non-empty, unless --force is given
# with a written reason (recorded in manifest notes).
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

APK=""
SERIAL="${ANDROID_SERIAL:-$FINDBACK_SERIAL}"
MODE="fresh"
FORCE=""
while (($#)); do
  case "$1" in
    --apk) APK="${2:-}"; shift 2 ;;
    --serial) SERIAL="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --force) FORCE="${2:-}"; shift 2 ;;
    *) harness_err "unknown arg: $1"; exit 1 ;;
  esac
done
[[ -n "$APK" && -f "$APK" ]] || {
  harness_err "--apk <existing .apk> required"
  exit 1
}
[[ "$MODE" == "fresh" || "$MODE" == "upgrade" ]] || {
  harness_err "--mode must be fresh|upgrade"
  exit 1
}

# Heavy-lock mutual exclusion (never overlap emulator proofs with npm gates).
LOCK_DIR="$REPO_ROOT/Communication/heavy.lock"
if [[ -n "$(ls -A "$LOCK_DIR" 2>/dev/null)" && -z "$FORCE" ]]; then
  harness_err "heavy lock held ($(ls "$LOCK_DIR")) — refusing to run. See docs/runbooks/device-harness.md. Pass --force '<reason>' only with owner approval."
  exit 1
fi

SHA12="$(git -C "$REPO_ROOT" rev-parse HEAD | cut -c1-12)"
DATE="$(date -u +%Y-%m-%d)"
EVDIR="$REPO_ROOT/Communication/DEVICE_${SHA12}_${DATE}"
[[ -e "$EVDIR" ]] && {
  harness_err "$EVDIR already exists — historical evidence is never overwritten. Remove it only with owner approval, or run on a new date/SHA."
  exit 1
}
mkdir -p "$EVDIR"/{provenance,install,baseline,notification,map,media,ai-bench}
harness_log "evidence dir: $EVDIR"

export ANDROID_SERIAL="$SERIAL"
export HARNESS_OUT="$EVDIR/baseline"

require_adb
"$SCRIPT_DIR/devices.sh" list

node "$SCRIPT_DIR/apk-provenance.mjs" --apk "$APK" --out "$EVDIR/provenance"

"$SCRIPT_DIR/install.sh" "$MODE" --apk "$APK" --serial "$SERIAL" 2>&1 | tee "$EVDIR/install/install.log"

harness_log "launching app for baseline captures…"
adb shell monkey -p "$FINDBACK_PACKAGE" -c android.intent.category.LAUNCHER 1
sleep 8

"$SCRIPT_DIR/capture.sh" screenshot --serial "$SERIAL" --out "$EVDIR/baseline" --name launch
"$SCRIPT_DIR/capture.sh" uixml --serial "$SERIAL" --out "$EVDIR/baseline" --name launch
"$SCRIPT_DIR/perf.sh" all --serial "$SERIAL" --out "$EVDIR/baseline" --name launch
"$SCRIPT_DIR/logcat.sh" dump --serial "$SERIAL" --out "$EVDIR/baseline"

for area in notification map media ai-bench; do
  HARNESS_OUT="$EVDIR" "$SCRIPT_DIR/captures.sh" "$area" --serial "$SERIAL" --out "$EVDIR" || true
done

# Scrub every collected text log (presence labels stay, values go).
while IFS= read -r -d '' f; do scrub_file "$f"; done < <(find "$EVDIR" -type f \( -name '*.txt' -o -name '*.log' -o -name '*.xml' \) -print0)

[[ -n "$FORCE" ]] && printf 'heavy-lock override reason: %s\n' "$FORCE" >"$EVDIR/LOCK_OVERRIDE.txt"

node "$SCRIPT_DIR/write-manifest.mjs" --dir "$EVDIR"

harness_log "proof skeleton complete -> $EVDIR"
harness_log "next: fill each area NOTES.md on device day; rerun write-manifest.mjs after adding files."
