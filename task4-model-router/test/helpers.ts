import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp directory per test file; returns the db path and a cleanup function. */
export function tempDbPath(label: string): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `task4-${label}-`));
  return { dir, dbPath: join(dir, "gateway.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A manually advanced clock. */
export function manualClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms), set: (v) => void (t = v) };
}

/** Anything matching this in a client-visible error body is a leak. */
export const FORBIDDEN = /at .*\.ts|node:internal|\/Users\/|ECONNREFUSED|better-sqlite3|sqlite/i;
