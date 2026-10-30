# Security policy

FindBack is a pre-public beta. Security reports are welcome and are taken
seriously, but there is no bug-bounty programme and no guaranteed response time.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Email **sheikhti1205@outlook.com** with:

- a short description and the impact you believe it has;
- steps to reproduce, or a proof of concept;
- the affected surface (Android app, web build, API, Edge Function, database policy);
- whether any real user data or credentials were involved.

Please do not include real credentials, other people's personal data, or
screenshots of private conversations. Redact what you can.

You will get an acknowledgement when the report is read. If the issue is valid it
will be fixed before public disclosure, and you can be credited if you want.

## Scope

In scope: authentication and session handling, database row-level security and
function grants, private chat and media access, moderation/staff authorization,
account deletion and data retention, push/realtime delivery, share links and deep
links, and any path that exposes one user's data to another.

Out of scope: reports that require a rooted device with the app's private storage,
denial of service through unrealistic volumes, missing headers with no demonstrated
impact, and social engineering of project maintainers.

## Known limits you should not report as new

- Private chat is **not** end-to-end encrypted; the server can read message bodies
  while they are in transit or stored.
- Push notifications are wake-only and do not carry message text.
- Phone verification is not enabled in this beta.
- An internal engineering checkpoint is not a security audit or a release approval.

## Safe harbour

Good-faith research that respects other users' privacy, does not degrade the service
and does not exfiltrate real data will not be pursued. Stop and report if you reach
real user data.
