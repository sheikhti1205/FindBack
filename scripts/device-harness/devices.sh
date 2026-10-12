#!/usr/bin/env bash
# devices.sh — adb discovery + connect + Norfold_API36 boot/wait (documents only
# the commands; running them requires the owner on a device-authorized host).
#
# Usage:
#   scripts/device-harness/devices.sh list
#   scripts/device-harness/devices.sh wait [--serial emulator-5554] [--timeout 300]
#   scripts/device-harness/devices.sh boot-emulator [--avd Norfold_API36]
#   scripts/device-harness/devices.sh connect [--host 127.0.0.1:5555]
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

cmd="${1:-list}"
SERIAL_DEFAULT="${FINDBACK_SERIAL}"

case "$cmd" in
  list)
    require_adb
    harness_log "adb devices (long):"
    adb devices -l
    ;;
  wait)
    require_adb
    serial="${ANDROID_SERIAL:-$SERIAL_DEFAULT}"
    timeout_s=300
    [[ "${2:-}" == "--serial" && -n "${3:-}" ]] && serial="$3"
    [[ "${2:-}" == "--timeout" && -n "${3:-}" ]] && timeout_s="$3"
    harness_log "waiting for $serial (timeout ${timeout_s}s) + boot_completed…"
    ANDROID_SERIAL="$serial" adb wait-for-device
    end=$((SECONDS + timeout_s))
    while ((SECONDS < end)); do
      if [[ "$(ANDROID_SERIAL="$serial" adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
        harness_log "$serial booted (sys.boot_completed=1)."
        ANDROID_SERIAL="$serial" adb shell getprop ro.build.version.release || true
        exit 0
      fi
      sleep 5
    done
    harness_err "$serial did not finish booting within ${timeout_s}s."
    exit 1
    ;;
  boot-emulator)
    # Norfold lab emulator. Foreground example (blocks); use -read-only / snapshot
    # flags per lab policy. NEVER run while an npm gate or another proof holds
    # the heavy lock (see docs/runbooks/device-harness.md).
    avd="${FINDBACK_AVD}"
    [[ "${2:-}" == "--avd" && -n "${3:-}" ]] && avd="$3"
    cat <<EOF
device-harness: Norfold_API36 boot commands (run by owner, one at a time):
  emulator -avd $avd -no-snapshot-load -no-boot-anim &
  ANDROID_SERIAL=$SERIAL_DEFAULT adb wait-for-device
  ANDROID_SERIAL=$SERIAL_DEFAULT adb shell 'while [ "\$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
  ANDROID_SERIAL=$SERIAL_DEFAULT adb shell getprop sys.boot_completed  # expect 1
EOF
    ;;
  connect)
    require_adb
    host="127.0.0.1:5555"
    [[ "${2:-}" == "--host" && -n "${3:-}" ]] && host="$3"
    adb connect "$host"
    adb devices
    ;;
  *)
    harness_err "expected list|wait|boot-emulator|connect"
    exit 1
    ;;
esac
