// Reading append-only JSONL session stores incrementally, by byte offset.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface JsonlEntry { value: Record<string, any>; /** byte offset just after the line */ end: number }

const TAIL_BYTES = 16 * 1024 * 1024;

/**
 * The JSON objects of `file` after byte offset `after`. With `after` = 0 a large file is read from
 * its last 16 MiB only (from the first complete line). Undefined when the file is unreadable or
 * `after` lies past its end.
 */
export function jsonlFrom(file: string, after: number): { entries: JsonlEntry[]; size: number } | undefined {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return undefined;
  }
  if (after < 0 || after > size) return undefined;
  const start = after > 0 ? after : Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try {
    if (buffer.length) readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  let pos = 0;
  if (after === 0 && start > 0) {
    const nl = buffer.indexOf(10);
    if (nl < 0) return { entries: [], size };
    pos = nl + 1;
  }
  const entries: JsonlEntry[] = [];
  while (pos < buffer.length) {
    const nl = buffer.indexOf(10, pos);
    if (nl < 0) break;                                     // a line still being written
    const line = buffer.subarray(pos, nl).toString('utf8').trim();
    pos = nl + 1;
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') entries.push({ value, end: start + pos });
    } catch { /* a partial or foreign line */ }
  }
  return { entries, size };
}

/** The store's current size in bytes: the replay point after everything it holds. */
export function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
