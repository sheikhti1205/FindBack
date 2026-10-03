/**
 * Download journal file (v1): `<stagingPath>.journal.json`.
 *
 * Crash-safe sidecar for process-death resume: written atomically (tmp +
 * rename) on the flush cadence, read tolerantly on open. `offset` is the
 * sole resume truth, reconciled against the staged file size — a journal
 * ahead of the file means torn state and restarts from the file size with
 * the hash state reset (a hasher cannot resume mid-stream).
 */

export const JOURNAL_VERSION = 1;

export interface JournalFile {
  readonly v: number;
  readonly modelId: string;
  readonly revision: string;
  readonly filePath: string;
  readonly url: string;
  readonly offset: number;
  readonly total: number | null;
  readonly sha: string;
  readonly updatedAt: string;
}

export interface JournalWriteInput {
  readonly modelId: string;
  readonly revision: string;
  readonly filePath: string;
  readonly url: string;
  readonly offset: number;
  readonly total: number | null;
  readonly sha: string;
}

export interface JournalFs {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export function journalPathFor(stagingPath: string): string {
  return `${stagingPath}.journal.json`;
}

export function buildJournal(input: JournalWriteInput, nowIso?: string): JournalFile {
  const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  return {
    v: JOURNAL_VERSION,
    modelId: input.modelId,
    revision: input.revision,
    filePath: input.filePath,
    url: input.url,
    offset,
    total: input.total,
    sha: input.sha,
    updatedAt: nowIso ?? new Date().toISOString(),
  };
}

/** Atomic write: tmp + rename, so a crash leaves at most a tmp behind. */
export async function writeJournal(
  fs: JournalFs,
  stagingPath: string,
  input: JournalWriteInput,
): Promise<JournalFile> {
  const journal = buildJournal(input);
  const encoded = new TextEncoder().encode(`${JSON.stringify(journal)}\n`);
  const target = journalPathFor(stagingPath);
  await fs.writeFile(`${target}.tmp`, encoded);
  await fs.rename(`${target}.tmp`, target);
  return journal;
}

/**
 * Tolerant read: missing file, invalid JSON, wrong version, or a shape
 * mismatch all yield null (resume from staged size instead). Never throws
 * for stored-data problems.
 */
export async function readJournal(
  fs: JournalFs,
  stagingPath: string,
): Promise<JournalFile | null> {
  let raw: Uint8Array;
  try {
    raw = await fs.readFile(journalPathFor(stagingPath));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== JOURNAL_VERSION) return null;
  if (
    typeof record["url"] !== "string" ||
    typeof record["sha"] !== "string" ||
    typeof record["modelId"] !== "string" ||
    typeof record["revision"] !== "string" ||
    typeof record["filePath"] !== "string" ||
    typeof record["updatedAt"] !== "string"
  ) {
    return null;
  }
  const offset = record["offset"];
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    return null;
  }
  const total = record["total"];
  if (total !== null && (typeof total !== "number" || !Number.isFinite(total) || total < 0)) {
    return null;
  }
  return {
    v: JOURNAL_VERSION,
    modelId: record["modelId"] as string,
    revision: record["revision"] as string,
    filePath: record["filePath"] as string,
    url: record["url"] as string,
    offset,
    total: total as number | null,
    sha: record["sha"] as string,
    updatedAt: record["updatedAt"] as string,
  };
}

export interface ResumeDecision {
  /** Byte offset the next fetch starts at. */
  readonly offset: number;
  /** True when the hasher must restart from byte 0 (journal unusable). */
  readonly restartHash: boolean;
}

/**
 * Reconcile journal against staged size. The journal never wins over the
 * file: a journal ahead of staged bytes means torn state, so resume from
 * the file size and restart the hash. A missing journal resumes from the
 * staged size (also with a restarted hash); nothing staged starts at 0.
 */
export function resolveResumeOffset(
  journal: JournalFile | null,
  stagedSize: number | null,
): ResumeDecision {
  const staged = stagedSize !== null && Number.isInteger(stagedSize) && stagedSize > 0 ? stagedSize : 0;
  if (journal === null) {
    return { offset: staged, restartHash: staged > 0 };
  }
  if (journal.offset > staged) {
    return { offset: staged, restartHash: true };
  }
  return { offset: journal.offset, restartHash: false };
}
