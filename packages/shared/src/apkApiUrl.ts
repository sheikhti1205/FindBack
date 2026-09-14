/**
 * Validation for the API base URL baked into an Android APK build.
 *
 * This is a build-time concern (used by `scripts/check-apk-api-url.mjs` and
 * `scripts/build-apk.mjs`), but it lives in the shared package so the browser
 * app, the tooling, and tests all agree on one implementation.
 *
 * The danger it prevents: an Android APK silently built with the development
 * default `http://localhost:4000`, where `localhost` means the phone itself, so
 * every API/socket/upload call fails on a real device.
 */

export interface ApkApiUrlOptions {
  /**
   * Permit loopback hosts. Off by default; only useful when the developer
   * forwards the port with `adb reverse tcp:4000 tcp:4000`.
   */
  allowLocalhost?: boolean;
}

export type ApkApiUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const APK_API_URL_PATTERN =
  /^(https?):\/\/(?:[^@/?#\s]+@)?([^:/?#\s]+)(?::(\d{1,5}))?(\/[^\s]*)?$/i;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/**
 * Validate a candidate `VITE_API_URL` for an Android APK build and return the
 * normalized base URL (trailing slash removed).
 */
export function resolveApkApiUrl(
  raw: string | undefined | null,
  options: ApkApiUrlOptions = {},
): ApkApiUrlResult {
  const value = (raw ?? "").trim();
  if (!value) {
    return {
      ok: false,
      error:
        "VITE_API_URL is required to build an Android APK. On a device `localhost` " +
        "means the phone itself, so the API base must be reachable over the network.",
    };
  }

  const match = APK_API_URL_PATTERN.exec(value);
  if (!match) {
    return {
      ok: false,
      error: `VITE_API_URL is not a valid http(s) URL: "${value}".`,
    };
  }

  const host = (match[2] ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    return { ok: false, error: `VITE_API_URL has no host: "${value}".` };
  }

  if (LOOPBACK_HOSTS.has(host) && !options.allowLocalhost) {
    return {
      ok: false,
      error:
        `VITE_API_URL "${value}" points at the device itself. ` +
        "Use http://10.0.2.2:4000 for the Android emulator, or " +
        "http://<computer-LAN-IP>:4000 for a physical phone.",
    };
  }

  return { ok: true, url: value.replace(/\/+$/, "") };
}
