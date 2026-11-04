/**
 * Drive REST v3 store over the narrow `appDataFolder`.
 *
 * `drive.appdata` is the only scope the app requests, and it hides every object
 * from the user's ordinary Drive UI: the backup is app-private, not a folder the
 * user browses. Objects are addressed by id; names are transport labels the
 * backup manifest owns.
 *
 * Failures are classified for the scheduler: `unauthorized` needs a new token or
 * a fresh consent, `throttled` carries Google's own retry delay, `unavailable`
 * is transient, and `invalid` is a permanent contract violation.
 */
import type { BackupDriveFile, BackupDriveStore } from "./backupDrive";

export type DriveFailure = "unauthorized" | "throttled" | "unavailable" | "invalid";

export class DriveStoreError extends Error {
  constructor(public kind: DriveFailure, public retryAfterMs = 0) {
    super(`drive: ${kind}`);
    this.name = "DriveStoreError";
  }
}

/** Short-lived access tokens; a 401 asks the auth port for one renewal. */
export interface DriveTokenSource {
  token(force: boolean): Promise<string>;
}

export interface DriveStoreOptions {
  fetch?: typeof fetch;
  /** Upper bound on objects listed in the app folder. */
  maxFiles?: number;
}

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
const MAX_FILES = 2000;
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Bounded number of objects accepted from one page/list. */
const PAGE = 1000;

function token(value: string): string {
  if (!TOKEN.test(value)) throw new DriveStoreError("unauthorized");
  return value;
}

function driveId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new DriveStoreError("invalid");
  return value;
}

function file(row: unknown): BackupDriveFile {
  if (!row || typeof row !== "object") throw new DriveStoreError("invalid");
  const value = row as Record<string, unknown>;
  const size = typeof value.size === "string" ? Number(value.size) : value.size;
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 512
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new DriveStoreError("invalid");
  }
  return { id: driveId(value.id), name: value.name, size };
}

function retryAfter(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 3600) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 3_600_000)) : 0;
}

async function failure(response: Response): Promise<DriveStoreError> {
  if (response.status === 401) return new DriveStoreError("unauthorized");
  if (response.status === 429) return new DriveStoreError("throttled", retryAfter(response));
  if (response.status === 403) {
    // Google reports quota errors as 403 with a reason; rate limits are the
    // retryable ones, an outright scope refusal is not.
    const body = await response.text().catch(() => "");
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/.test(body)) {
      return new DriveStoreError("throttled", retryAfter(response));
    }
    return new DriveStoreError("invalid");
  }
  if (response.status >= 500) return new DriveStoreError("unavailable");
  if (response.status === 404) return new DriveStoreError("invalid");
  return new DriveStoreError("invalid");
}

function multipart(metadata: Record<string, unknown>, bytes: ArrayBuffer): {
  body: Uint8Array; contentType: string } {
  const boundary = `norfold-${crypto.randomUUID().replace(/-/g, "")}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(new Uint8Array(bytes), head.byteLength);
  body.set(tail, head.byteLength + bytes.byteLength);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export class DriveRestStore implements BackupDriveStore {
  private readonly request: typeof fetch;
  private readonly maxFiles: number;

  constructor(private readonly auth: DriveTokenSource, options: DriveStoreOptions = {}) {
    this.request = options.fetch ?? fetch.bind(globalThis);
    this.maxFiles = Math.min(options.maxFiles ?? MAX_FILES, MAX_FILES);
  }

  /** One 401 retry with a forced renewal; a second 401 is a consent problem. */
  private async send(path: string, init: RequestInit, attempt = 0): Promise<Response> {
    const access = token(await this.auth.token(attempt > 0));
    let response: Response;
    try {
      response = await this.request(path, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${access}` },
      });
    } catch {
      // A dropped connection or DNS failure is transient, never a contract break.
      throw new DriveStoreError("unavailable");
    }
    if (response.status === 401 && attempt === 0) {
      void response.body?.cancel().catch(() => undefined);
      return this.send(path, init, 1);
    }
    return response;
  }

  async list(): Promise<BackupDriveFile[]> {
    const files: BackupDriveFile[] = [];
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({
        spaces: "appDataFolder",
        pageSize: String(PAGE),
        q: "trashed=false",
        fields: "nextPageToken,files(id,name,size)",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.send(`${API}/files?${query.toString()}`, { method: "GET" });
      if (!response.ok) throw await failure(response);
      const data = await response.json() as { nextPageToken?: unknown; files?: unknown };
      if (!Array.isArray(data.files)) throw new DriveStoreError("invalid");
      for (const row of data.files) files.push(file(row));
      if (files.length > this.maxFiles) throw new DriveStoreError("invalid");
      if (typeof data.nextPageToken !== "string" || !data.nextPageToken) return files;
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(data.nextPageToken)) throw new DriveStoreError("invalid");
      pageToken = data.nextPageToken;
    }
    // Ten pages without an end is not a folder this app produced.
    throw new DriveStoreError("invalid");
  }

  async read(id: string): Promise<ArrayBuffer> {
    const response = await this.send(`${API}/files/${driveId(id)}?alt=media`, { method: "GET" });
    if (!response.ok) throw await failure(response);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_READ_BYTES) throw new DriveStoreError("invalid");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_READ_BYTES) throw new DriveStoreError("invalid");
    return bytes;
  }

  async write(input: { id?: string; name: string; bytes: ArrayBuffer }): Promise<BackupDriveFile> {
    if (input.name.length < 1 || input.name.length > 512 || input.bytes.byteLength < 1) {
      throw new DriveStoreError("invalid");
    }
    const query = new URLSearchParams({ uploadType: "media", fields: "id,name,size" });
    let response: Response;
    if (input.id) {
      response = await this.send(`${UPLOAD}/files/${driveId(input.id)}?${query.toString()}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/octet-stream" },
        body: input.bytes,
      });
    } else {
      const envelope = multipart({ name: input.name, parents: ["appDataFolder"] }, input.bytes);
      response = await this.send(`${UPLOAD}/files?uploadType=multipart&fields=id,name,size`, {
        method: "POST",
        headers: { "Content-Type": envelope.contentType },
        body: envelope.body as unknown as BodyInit,
      });
    }
    if (!response.ok) throw await failure(response);
    const data = await response.json() as unknown;
    return file(data);
  }

  async remove(id: string): Promise<void> {
    const response = await this.send(`${API}/files/${driveId(id)}`, { method: "DELETE" });
    if (response.status === 404) return; // already gone is the desired state
    if (!response.ok) throw await failure(response);
    void response.body?.cancel().catch(() => undefined);
  }
}

/** Build the production store from the shared drive authorization port. */
export function driveStore(auth: { current(): { token: string } | null;
  authorize(): Promise<{ token: string }>; renew(): Promise<{ token: string } | null> },
  options: DriveStoreOptions = {}): DriveRestStore {
  return new DriveRestStore({
    async token(force) {
      const access = force ? await auth.renew() : auth.current() ?? await auth.renew();
      if (!access) throw new DriveStoreError("unauthorized");
      return access.token;
    },
  }, options);
}
