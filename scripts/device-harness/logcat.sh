#!/usr/bin/env bash
# logcat.sh — filtered per-package logcat capture (no secret values recorded).
#
# Usage:
#   scripts/device-harness/logcat.sh start [--serial S] [--out DIR]   # background capture, prints PID
#   scripts/device-harness/logcat.sh dump  [--serial S] [--out DIR] [--lines 5000]
#   scripts/device-harness/logcat.sh stop   [--pid PID]
#
# start: clears logcat, begins `adb logcat -v threadtime` filtered to the app
#   PID (resolved via pidof) into $OUT/logcat-raw.txt in the background.
# dump:  one-shot `adb logcat -d -v threadtime` filtered the same way into
#   $OUT/logcat-dump.txt, then scrubbed via common.sh scrub_file.
# Raw files are scrubbed on dump/stop so the evidence dir never holds secrets.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

cmd="${1:-}"
shift || true
SERIAL="${ANDROID_SERIAL:-$FINDBACK_SERIAL}"
OUT="$HARNESS_OUT"
LINES=5000
PID=""
while (($#)); do
  case "$1" in
    --serial) SERIAL="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --lines) LINES="${2:-}"; shift 2 ;;
    --pid) PID="${2:-}"; shift 2 ;;
    *) harness_err "unknown arg: $1"; exit 1 ;;
  esac
done

require_adb
export ANDROID_SERIAL="$SERIAL"
ensure_outdir "$OUT" >/dev/null

app_pid() { adb shell pidof "$FINDBACK_PACKAGE" 2>/dev/null | tr -d '\r' | awk '{print $1}'; }

case "$cmd" in
  start)
    adb logcat -c
    P="$(app_pid)"
    [[ -n "$P" ]] || {
      harness_err "${FINDBACK_PACKAGE} is not running — launch the app first."
      exit 1
    }
    harness_log "capturing logcat for pid $P -> $OUT/logcat-raw.txt"
    # --pid filter keeps only this package's lines; values still scrubbed later.
    nohup adb logcat -v threadtime --pid="$P" >"$OUT/logcat-raw.txt" 2>"$OUT/logcat.err" &
    echo $! | tee "$OUT/logcat.pid"
    ;;
  dump)
    P="$(app_pid)"
    if [[ -z "$P" ]]; then
      harness_log "app not running; dumping last $LINES unfiltered lines (scrubbed)."
      adb logcat -d -v threadtime -t "$LINES" >"$OUT/logcat-dump.txt"
    else
      adb logcat -d -v threadtime --pid="$P" -t "$LINES" >"$OUT/logcat-dump.txt"
    fi
    scrub_file "$OUT/logcat-dump.txt"
    harness_log "dumped + scrubbed -> $OUT/logcat-dump.txt"
    ;;
  stop)
    [[ -z "$PID" && -f "$OUT/logcat.pid" ]] && PID="$(cat "$OUT/logcat.pid")"
    [[ -n "$PID" ]] || {
      harness_err "no capture PID (pass --pid or run start first)"
      exit 1
    }
    kill "$PID" 2>/dev/null || true
    scrub_file "$OUT/logcat-raw.txt"
    harness_log "stopped pid $PID; scrubbed -> $OUT/logcat-raw.txt"
    ;;
  *)
    harness_err "expected start|dump|stop"
    exit 1
    ;;
esac
