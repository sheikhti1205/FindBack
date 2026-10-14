/** Initial URLs never contain credentials. Signed HF redirects are ephemeral native-only state. */
export function safeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      [...url.searchParams].every(([key, val]) => key === "download" && val === "true") &&
      url.port === "" && url.hostname.includes(".") &&
      !/^(localhost|.*\.local|.*\.internal|\d[\d.]*|\[)/i.test(url.hostname);
  } catch { return false; }
}

export function retryableSourceFailure(code: string): boolean {
  return ["TIMEOUT", "NETWORK_ERROR", "HTTP_404", "HTTP_410", "HTTP_429"].includes(code) || /^HTTP_5\d\d$/.test(code);
}

/** Preserve bridge codes, not potentially credential-bearing native exception messages. */
export function nativeFailureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,60}$/.test(code) ? code : "DOWNLOAD_FAILED";
}
