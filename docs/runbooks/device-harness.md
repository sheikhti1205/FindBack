# Device Harness Runbook (offline lab scripts)

Owner-run commands for device day. Nothing here runs in CI. All scripts live
under `scripts/device-harness/`; they were syntax-verified only
(`bash -n` + `node --check`) with no device attached and no emulator booted.

Matrix wiring: acceptance rows in the handover `17_DEVICE_ACCEPTANCE_MATRIX.md`;
figures feed the `46_PERFORMANCE_MEASUREMENT_TEMPLATE.md` table; signing and
config-presence rules follow `18_BUILD_SIGNING_RELEASE.md`. No release or tag
is authorized by running any of this.

## 0. Preconditions (every run)

- Android platform-tools on PATH (`adb`, plus `emulator`, `aapt`, `apksigner`
  for provenance). Check: `adb version`.
- A signed APK built from the exact proof SHA (signeddev = canonical release
  signer; see `scripts/build-apk.mjs --variant signeddev`).
- Device or emulator authorized (`adb devices` shows `device`, not
  `unauthorized`).
- **Heavy-lock mutual exclusion:** never overlap an emulator proof with npm
  gates (build/lint/test) or with another proof. Before starting, confirm
  `Communication/heavy.lock/` is empty, then claim it, e.g.
  `date -u +%FT%TZ > Communication/heavy.lock/device-proof-<name>`; delete
  your claim file when done. `run-device-proof.sh` refuses to run while any
  other claim exists (override `--force '<reason>'` needs owner approval and
  is recorded in `LOCK_OVERRIDE.txt`).

## 1. Syntax re-verify (no device needed)

```sh
for f in scripts/device-harness/*.sh; do bash -n "$f" && echo "OK $f"; done
node --check scripts/device-harness/apk-provenance.mjs && echo "OK apk-provenance"
node --check scripts/device-harness/write-manifest.mjs && echo "OK write-manifest"
```

## 2. Norfold_API36 emulator (Norfolk lab)

Boot and wait (one at a time; see heavy-lock rule above):

```sh
scripts/device-harness/devices.sh boot-emulator --avd Norfold_API36
# then, in order:
emulator -avd Norfold_API36 -no-snapshot-load -no-boot-anim &
ANDROID_SERIAL=emulator-5554 adb wait-for-device
scripts/device-harness/devices.sh wait --serial emulator-5554 --timeout 300
scripts/device-harness/devices.sh list
```

Physical device over USB instead: connect, accept the RSA prompt,
`scripts/device-harness/devices.sh list`, then export
`ANDROID_SERIAL=<serial>` (or pass `--serial` everywhere).

## 3. Provenance first (fail-closed, presence-only)

```sh
node scripts/device-harness/apk-provenance.mjs --apk <file.apk> --out /tmp/prov
cat /tmp/prov/provenance.json
```

Records: git SHA (+dirty), package (`com.findback.app`), versionName/
versionCode, APK SHA256, signer fingerprint(s), Supabase host presence, Google
Web client PRESENT/MISSING, Maps PRESENT/ABSENT (MapLibre expected PRESENT,
Google markers must read ABSENT), Sentry PRESENT/MISSING. Names/presence/
shapes only — never values. Requires `aapt`, `apksigner`, `unzip`, `git`.

## 4. Full proof (fresh install)

```sh
scripts/device-harness/run-device-proof.sh --apk <file.apk> --mode fresh
# physical device: add --serial <serial>
```

Creates `Communication/DEVICE_<SHA12>_<YYYY-MM-DD>/` (never overwrites an
existing dir) with `provenance/`, `install/install.log`, `baseline/`
(screenshot, uixml, perf, logcat dump), `notification/`, `map/`, `media/`,
`ai-bench/` (each with a `NOTES.md` table), scrubs secret patterns from all
collected logs, and writes `manifest.json` (fail-closed on residual secrets).

Upgrade proof (over the release-key base, data preserved):

```sh
scripts/device-harness/run-device-proof.sh --apk <file.apk> --mode upgrade
```

## 5. Leaf scripts (manual / area work)

```sh
scripts/device-harness/install.sh fresh --apk <file.apk>     # uninstall + install
scripts/device-harness/install.sh upgrade --apk <file.apk>   # install -r, no wipe
scripts/device-harness/logcat.sh start --out <area-dir>      # background capture
scripts/device-harness/logcat.sh dump --out <area-dir>       # one-shot, scrubbed
scripts/device-harness/logcat.sh stop  --out <area-dir>      # stop + scrub
scripts/device-harness/capture.sh screenshot --out <d> --name <step>
scripts/device-harness/capture.sh record --out <d> --name <step> --seconds 30
scripts/device-harness/capture.sh uixml --out <d> --name <step>
scripts/device-harness/perf.sh all --out <d> --name <step>   # meminfo+gfx+state
scripts/device-harness/captures.sh notification --out <evidence-dir>
scripts/device-harness/captures.sh map --out <evidence-dir>
scripts/device-harness/captures.sh media --out <evidence-dir>
scripts/device-harness/captures.sh ai-bench --out <evidence-dir>
node scripts/device-harness/write-manifest.mjs --dir <evidence-dir>  # re-run after adding files
```

`ANDROID_SERIAL`, `FINDBACK_SERIAL` (default `emulator-5554`),
`FINDBACK_AVD` (default `Norfolk_API36`), `FINDBACK_PACKAGE` (default
`com.findback.app`), and `HARNESS_OUT` (default `/tmp/findback-device-harness`)
override defaults. `captures.sh` stubs print the manual matrix steps, run the
automatable captures, and point at `NOTES.md` — fill those tables on device
day. AI figures (Smol load/inference, Needle extraction, cloud TTFT) go to
the performance template; LFM/llama.cpp stay lab-only per
`docs/runbooks/native-model-run.md`.

## 6. After device day

1. Fill every `NOTES.md` PASS/FAIL table; attach screenshots by step name.
2. Re-run `write-manifest.mjs --dir <evidence-dir>` so the manifest covers new files.
3. Release the heavy-lock claim file.
4. Report: evidence path, provenance line, matrix rows passed/failed, perf figures.
