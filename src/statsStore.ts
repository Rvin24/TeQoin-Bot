/**
 * Persistent activity-stats store for the auto-24h loop.
 *
 * The auto loop accumulates per-wallet send/receive/bridge counts across
 * cycles in memory. To make those counts survive a restart of the
 * process (Ctrl+C, machine reboot, …) we mirror them to a small JSON
 * file in the project root.
 *
 * The store is intentionally tiny:
 *
 *   {
 *     "version": 1,
 *     "lastUpdated": "2026-05-06T03:00:00.000Z",
 *     "totals": {
 *       "0x...": { "send": 5, "recv": 12, "bridge": 3 },
 *       ...
 *     }
 *   }
 *
 * Address keys are lowercased. Values are raw transaction counters
 * (TePoints are computed from these on the fly — see dashboard.ts).
 *
 * The file path is project-relative (`./auto-stats.json`) and is
 * gitignored. Manual transfer/bridge runs do NOT write to this file —
 * only the auto-loop does — so users running ad-hoc commands won't
 * accidentally bump their persisted counters.
 *
 * Reset semantics: there is no command to reset. Users who want a
 * fresh start can simply delete the file; the auto loop will re-create
 * it after the first cycle.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AddressStats {
  send: number;
  recv: number;
  bridge: number;
}

export type PersistedStats = Record<string, AddressStats>;

interface StatsFile {
  version: number;
  lastUpdated: string;
  totals: PersistedStats;
}

const STATS_FILE = "auto-stats.json";
const CURRENT_VERSION = 1;

export function statsStorePath(): string {
  return resolve(process.cwd(), STATS_FILE);
}

/**
 * Load persisted stats from disk. Returns an empty object when the
 * file does not exist or is unreadable / malformed; callers always
 * get a usable map even on a fresh checkout.
 *
 * Parse errors are reported on stderr but do NOT throw — losing the
 * activity log is preferable to crashing the auto loop. The next
 * successful save will overwrite the broken file.
 */
export function loadPersistedStats(): PersistedStats {
  const path = statsStorePath();
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.warn(`[stats] could not read ${path}: ${describe(err)}. Starting from empty totals.`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[stats] could not parse ${path}: ${describe(err)}. Starting from empty totals.`);
    return {};
  }
  if (!isStatsFile(parsed)) {
    console.warn(`[stats] ${path} has unexpected schema. Starting from empty totals.`);
    return {};
  }
  if (parsed.version !== CURRENT_VERSION) {
    console.warn(`[stats] ${path} is version ${parsed.version}, expected ${CURRENT_VERSION}. Starting from empty totals.`);
    return {};
  }
  // Re-key addresses to lowercase defensively in case an older write
  // used mixed case.
  const out: PersistedStats = {};
  for (const [addr, entry] of Object.entries(parsed.totals)) {
    out[addr.toLowerCase()] = {
      send: nonNegInt(entry.send),
      recv: nonNegInt(entry.recv),
      bridge: nonNegInt(entry.bridge),
    };
  }
  return out;
}

/**
 * Atomically save the current totals to disk. Writes to a tmp file
 * first and renames so a crash mid-write can't corrupt the store.
 *
 * Errors are caught and logged so a transient I/O failure does not
 * abort the auto loop — the next cycle will retry the write with the
 * latest totals.
 */
export function savePersistedStats(totals: PersistedStats): void {
  const path = statsStorePath();
  const tmp = `${path}.tmp`;
  const file: StatsFile = {
    version: CURRENT_VERSION,
    lastUpdated: new Date().toISOString(),
    // Sort keys for stable diffs if the user ever inspects the file.
    totals: Object.fromEntries(
      Object.entries(totals)
        .map(([k, v]): [string, AddressStats] => [k.toLowerCase(), v])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
    // Node's fs.renameSync is atomic on POSIX and best-effort on
    // Windows (good enough — collisions here would only swap a
    // valid-but-stale file with another valid file).
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[stats] could not save ${path}: ${describe(err)}. Totals stay in memory.`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nonNegInt(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function isStatsFile(value: unknown): value is StatsFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<StatsFile>;
  if (typeof v.version !== "number") return false;
  if (typeof v.lastUpdated !== "string") return false;
  if (!v.totals || typeof v.totals !== "object") return false;
  for (const entry of Object.values(v.totals)) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Partial<AddressStats>;
    if (typeof e.send !== "number" || typeof e.recv !== "number" || typeof e.bridge !== "number") {
      return false;
    }
  }
  return true;
}
