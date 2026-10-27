/**
 * Lane isolation for the shared push dispatcher.
 *
 * The chat wake queue was added to an Edge function that already owned report
 * notification delivery. Chat is an additional lane: a transient chat SQL, RPC,
 * lease or FCM failure must never stop the report lane from running, and must
 * never be reported as if it were the report lane's failure.
 *
 * `isolateLane` runs one lane and converts any throw into a bounded, redacted,
 * loggable failure value. Callers keep dispatching the other lane and surface the
 * degraded lane in the response.
 */

export type LaneOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Patterns whose matched text is never allowed into a log line or an HTTP body.
 * An unexpected runtime error can carry a credential-bearing URL, an
 * Authorization header, a JWT or a PEM fragment; truncation is not redaction, so
 * the sensitive shape is removed before the message is bounded.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private-key blocks, complete or truncated mid-block.
  [
    /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END[^-]{0,40}PRIVATE KEY-----|$)/gi,
    "[redacted private key]",
  ],
  // JWTs (three base64url segments).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted token]"],
  // Supabase and Firebase/Google keys.
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted key]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}/g, "[redacted key]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted key]"],
  // Authorization headers.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // `key=value` / `key: value` credential assignments, including compound and
  // quoted names. `client_secret`, `access_token`, `refresh_token`, `id_token`,
  // `x-api-key`, `private_key` and `service_role_key` are ordinary credential
  // names, and `_` is a word character, so a bare `\b` name list misses them.
  //
  // The value is taken to the end of its line, not to the first space, comma or
  // semicolon: a bounded or delimiter-stopped capture leaves a tail (`two words`,
  // `a;b`, a >512-char secret) that then reaches the log and the response.
  //
  // A delimiter with no value on its own line means the secret is on a following
  // line, so the run of blank lines and the next non-blank line are removed as
  // well. `\n[^\n]*` alone was not enough: it consumes one line, so
  // `secret=\n\nSECRET` left `SECRET` behind. `\r?\n` is used so a CRLF message
  // ends its value where the sender meant it to. Only the first 200 characters are
  // kept afterwards, so this never returns unbounded text.
  [
    /(["']?[\w.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|credential|signature|private[_-]?key|service[_-]?role)[\w.-]*["']?)\s*(?::=|[:=])[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*[^\r\n]*|"[^"]*"|'[^']*'|[^\r\n]+)/gi,
    "$1=[redacted]",
  ],
  // Credentials embedded in a URL: scheme://user:pass@host.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  // A bare long opaque blob (base64/hex token) with no word breaks.
  [/\b[A-Za-z0-9+/=_-]{40,}\b/g, "[redacted]"],
];

/** Remove credential-shaped substrings from arbitrary error text. */
export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

/**
 * Message-only, redacted, length-bounded: never leak a stack, token, key or
 * credential-bearing URL into logs or the HTTP response. Redaction runs before
 * truncation so a cut cannot leave a key prefix behind.
 */
export function boundedLaneError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "lane failed";
  // Redact while line structure still exists. The assignment rule's value class
  // stops at a newline, so `client_secret=two words` is removed whole rather than
  // leaving `words`, and the multi-line PEM rule can still span lines. Flattening
  // first would destroy both properties.
  const flat = redactSecrets(raw).replace(/\s+/g, " ").trim();
  return (flat || "lane failed").slice(0, 200);
}

export async function isolateLane<T>(
  name: string,
  run: () => Promise<T>,
  onError: (message: string) => void = () => {},
): Promise<LaneOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const message = boundedLaneError(error);
    try {
      onError(`${name} lane failed: ${message}`);
    } catch {
      /* logging must never escalate into a dispatcher failure */
    }
    return { ok: false, error: message };
  }
}

/** Names of lanes that did not complete, for an honest response body. */
export function degradedLanes(...lanes: Array<[string, LaneOutcome<unknown>]>): string[] {
  return lanes.filter(([, outcome]) => !outcome.ok).map(([name]) => name);
}
