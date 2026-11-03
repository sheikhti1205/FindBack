---
name: findback-device-audit
description: Use when validating FindBack on a physical Android device, collecting screenshots/logcat/UI evidence, reproducing owner-reported defects, or deciding whether a host-complete feature is actually device-accepted.
---

# Physical-device audit

## Mandatory consent gate — before any connection or inspection

Require explicit owner consent for this specific session and scope before
connecting to or using a phone, tablet, laptop, personal emulator, browser session,
ADB interface or device-bound test; installing an APK; or accessing device logs.
Availability, a checklist/handoff, another agent's approval or earlier permission
does not grant access. Without consent, stop the device procedure and report that
acceptance as deferred/unverified. Continue authorized source/static/synthetic
tests, CI inspection and read-only backend audits without touching personal state.

Treat the phone as the source of truth for touch, IME, native plugins, camera/media, Google Credential Manager, Google Maps, haptics, push notifications, memory, thermal behavior, and visual density.

For each defect:
1. Record exact build SHA/version/signing identity.
2. Reproduce twice when practical.
3. Capture before/after screenshot or screen recording, UI hierarchy, and relevant logcat.
4. Record device/OS/display density/text scale/theme.
5. Trace to source; write a failing regression test where host-testable.
6. Fix forward; rebuild exact new SHA; re-run the same physical scenario.

Do not mark a row PASS from emulator/DOM tests when the requirement is physical behavior. Do not dismiss a physical failure because CI is green.
