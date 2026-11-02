# P11 corrective contracts

Implementation/review candidate only; no acceptance bump, tag or release.

- `20261102120000` is immutable and restored to its originally applied contents.
  `20261102180000` fixes the compatibility candidate reader forward and removes
  raw attachment SELECT (including column grants). Shipping matching remains V2,
  with relevance before its 80-candidate cap and explicit target/candidate access.
- `20261102181000` hides provisional accounts in username/people/mention/raw
  profile reads. Confirmation reveals the existing profile. Never-activated
  signups older than 30 days can be purged only by service-role maintenance,
  bounded to 100, with Auth row locks and content/Storage/role exclusions.
- Cleanup HTTP `max_batches` is an integer from 1–10; invalid input does not
  touch queue or Storage. Queue claim/remove/ack and stale leases are unchanged.
  Production uses canonical secret-key authentication, reusing the provisioned
  maintenance credential. Missing scheduler configuration fails, not skips.
- The old server `ai-help` route is retired, not optional BYOK Chat. There is no
  current deploy entry or server capability mirror; Git history preserves it.
- Legal/Privacy describes sanitized anonymous share previews, text/category/
  date/location matching (not photo matching/probabilities), optional local text
  search, and no consumer Drive backup in this beta.
- Backend deployment is manual, opt-in per action (all defaults false). This
  correction deploys only report cleanup, chat wake and push dispatch. Leaked
  password protection is enabled separately with readback; unsupported plans
  require an explicit owner-console/plan decision, never a silent PASS.

Focused host/SQL and live schema/deployment evidence does not prove real-account,
physical-device, Sentry ingestion or owner-corpus acceptance. Those remain
separate, unpassed gates until actually observed.
