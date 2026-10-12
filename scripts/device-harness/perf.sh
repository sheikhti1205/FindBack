#!/usr/bin/env bash
# perf.sh — meminfo/PSS, frame stats, package/activity state (offline capture).
#
# Usage:
#   scripts/device-harness/perf.sh mem    [--serial S] [--out DIR] [--name NAME]
#   scripts/device-harness/perf.sh gfx    [--serial S] [--out DIR] [--name NAME]
#   scripts/device-harness/perf.sh state  [--serial S] [--out DIR] [--name NAME]
#   scripts/device-harness/perf.sh all    [--serial S] [--out DIR] [--name NAME]
#
# mem:   dumpsys meminfo <package> (TOTAL PSS/Private Dirty) + procstatus.
# gfx:   dumpsys gfxinfo <package> framestats (jank/frame-time evidence).
# state: top resumed activity, process importance, package version, battery/thermal
#        snapshot header (thermal zones where exposed; never claimed as calibrated).
# Writes one text file per probe under $OUT/perf/ plus a perf-summary.txt with
# the TOTAL PSS line extracted for the performance template table.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

cmd="${1:-}"
shift || true
SERIAL="${ANDROID_SERIAL:-$FINDBACK_SERIAL}"
OUT="$HARNESS_OUT"
NAME="probe"
while (($#)); do
  case "$1" in
    --serial) SERIAL="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    *) harness_err "unknown arg: $1"; exit 1 ;;
  esac
done

require_adb
export ANDROID_SERIAL="$SERIAL"
PERF="$OUT/perf"
ensure_outdir "$PERF" >/dev/null
TS="$(date -u +%Y%m%dT%H%M%SZ)"

do_mem() {
  local f="$PERF/${TS}_${NAME}_meminfo.txt"
  {
    echo "# dumpsys meminfo $FINDBACK_PACKAGE @ $TS"
    adb shell dumpsys meminfo "$FINDBACK_PACKAGE"
    echo
    echo "# procstatus"
    adb shell cat "/proc/$(adb shell pidof "$FINDBACK_PACKAGE" | tr -d '\r' | awk '{print $1}')/status" 2>/dev/null | grep -E "VmRSS|VmHWM" || echo "(procstatus unavailable)"
  } >"$f" 2>&1
  scrub_file "$f"
  grep -E "TOTAL" "$f" | head -3 >"$PERF/${TS}_${NAME}_pss.txt" || true
  harness_log "meminfo -> $f"
}

do_gfx() {
  local f="$PERF/${TS}_${NAME}_gfxinfo.txt"
  {
    echo "# dumpsys gfxinfo $FINDBACK_PACKAGE framestats @ $TS"
    adb shell dumpsys gfxinfo "$FINDBACK_PACKAGE" framestats
  } >"$f" 2>&1
  scrub_file "$f"
  harness_log "gfxinfo -> $f"
}

do_state() {
  local f="$PERF/${TS}_${NAME}_state.txt"
  {
    echo "# package/activity state @ $TS"
    echo "== top activity =="
    adb shell dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity" | head -3
    echo "== process =="
    adb shell ps -A | grep "$FINDBACK_PACKAGE" || echo "(process not running)"
    echo "== package =="
    adb shell dumpsys package "$FINDBACK_PACKAGE" | grep -E "versionName|versionCode|lastUpdateTime|firstInstallTime" | head -5
    echo "== thermal/battery =="
    adb shell dumpsys battery | grep -E "level|temperature|status" | head -5
    for z in /sys/class/thermal/thermal_zone0/temp /sys/class/thermal/thermal_zone1/temp; do
      echo -n "$z: "
      adb shell cat "$z" 2>/dev/null | tr -d '\r' || echo "(unavailable)"
    done
  } >"$f" 2>&1
  scrub_file "$f"
  harness_log "state -> $f"
}

case "$cmd" in
  mem) do_mem ;;
  gfx) do_gfx ;;
  state) do_state ;;
  all)
    do_mem
    do_gfx
    do_state
    {
      echo "# perf summary @ $TS ($NAME)"
      echo "## PSS extracts"
      grep -H "" "$PERF/${TS}_${NAME}_pss.txt" 2>/dev/null || echo "(no PSS extract)"
    } >"$PERF/${TS}_${NAME}_summary.txt"
    harness_log "summary -> $PERF/${TS}_${NAME}_summary.txt"
    ;;
  *)
    harness_err "expected mem|gfx|state|all"
    exit 1
    ;;
esac
