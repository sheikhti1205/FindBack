# Changelog

FindBack is beta/pre-public. Historical product milestones are being audited;
this file is not evidence of a stable release or completed consumer-final programme.

## Unreleased — consumer-final work in progress

The repository contains ongoing work on report matching and recovery, private
communication, and moderation appeals. These additions are **not release-ready**:
backend correctness/security, client integration, and acceptance work remain.
Private chat, backup/restore and reciprocal read receipts must not be advertised
as shipped merely because SQL declarations exist.

Earlier safety fixes remain preserved at `8ab29dc`, `cb03f16` and `0d1438e`, with
their individual test/review evidence retained. They are not blanket approval of
later changes. See the detailed
[acceptance status](docs/history/ACCEPTANCE_EVIDENCE_REPORT_2026-10-24.md).

## Historical release notes — verification pending

The previous generated changelog attributed later R3 work to the frozen
r0697–r0854 interval, treated package declarations as accepted milestones, and
listed unimplemented chat behavior. Those assertions are withdrawn, not silently
carried into a new release history. Original text remains recoverable in Git.

The [history inventory](docs/history/VERSION_HISTORY.md) retains original commit
identities and observed package declarations, including the historical `1.0.0`
label without treating it as stable acceptance. Release-level product notes,
truthful tags/artifacts and the reconstructed current beta version will follow
actual meaningful-diff review. No historical work has been collapsed into a
replacement baseline, and no new version number is assigned here.
