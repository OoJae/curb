/**
 * Retention, disk and memory (deploy 2, W3): what the keeper keeps on a shared disk, and seeing the disk fill
 * before it stops a commit.
 *
 * - A closure's swap file (`DATA_DIR/closures/<wrapper-lowercase>-<cutBlock>.jsonl`) is deleted through the
 *   swap store when its row is settled (any path) or expired, and when its closure is abandoned. A committed but
 *   unsettled row keeps its file. That happens in main.ts; this module only finds and measures.
 * - At boot this module REPORTS orphans and never deletes them (CO B2): a file no open or pending closure names
 *   exists only after a state loss or a restore, and it is exactly the file a later restore would need. A
 *   person deletes orphans; at about 75 B per swap they are small.
 * - `DATA_DIR/marks/` is kept: it is the first copy of every bundle, served at `/marks/<root>.json`.
 * - Free space is read with `statfs` every tick; the two byte counts at most once every 10 minutes. sev-2
 *   `keeper:disk-low` below 2,048 MB free, sev-1 `keeper:disk-critical` below 512 MB (CO M2).
 *
 * Nothing here throws.
 */
import { readdirSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

export const DISK_LOW_MB = 2_048;
export const DISK_CRITICAL_MB = 512;
export const DISK_BYTES_EVERY_MS = 10 * 60_000;

export interface DiskUsage { freeMb: number | null; marksBytes: number; closuresBytes: number }
interface ClosureRef { wrapper: string; cutBlock: number }

const CLOSURE_FILE = /^0x[0-9a-f]{40}-\d+\.jsonl$/;

/** The file name of a closure's swap file, as main.ts and the swap store name it. */
export const closureFileName = (c: ClosureRef) => `${c.wrapper.toLowerCase()}-${c.cutBlock}.jsonl`;

/** Names (not paths) of the closure swap files in `DATA_DIR/closures/`, sorted; [] when the directory is missing. */
export function closureFilesIn(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, "closures"), { withFileTypes: true })
      .filter((f) => f.isFile() && CLOSURE_FILE.test(f.name))
      .map((f) => f.name)
      .sort();
  } catch { return []; }
}

/** Closure swap files that no open or pending closure names. Reported, never deleted. */
export function orphanClosureFiles(
  dataDir: string,
  state: { open: Record<string, ClosureRef>; pending: ClosureRef[] },
): string[] {
  const named = new Set<string>();
  for (const c of Object.values(state.open ?? {})) if (c?.wrapper) named.add(closureFileName(c));
  for (const c of state.pending ?? []) if (c?.wrapper) named.add(closureFileName(c));
  return closureFilesIn(dataDir).filter((f) => !named.has(f));
}

/** The boot report: `closure-file-orphans {files, bytes}`. */
export function orphanReport(
  dataDir: string,
  state: { open: Record<string, ClosureRef>; pending: ClosureRef[] },
): { files: string[]; bytes: number } {
  const files = orphanClosureFiles(dataDir, state);
  let bytes = 0;
  for (const f of files) { try { bytes += statSync(join(dataDir, "closures", f)).size; } catch { /* gone meanwhile */ } }
  return { files, bytes };
}

/** Total size of the regular files directly in `dir`; 0 when it is missing or unreadable. */
function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      try { total += statSync(join(dir, f.name)).size; } catch { /* gone meanwhile */ }
    }
  } catch { /* missing */ }
  return total;
}

/** Free space for an unprivileged writer on the volume holding `dataDir`, in MiB (bavail * bsize / 2^20); null if statfs throws. */
export function freeMbOf(dataDir: string): number | null {
  try {
    const s = statfsSync(dataDir, { bigint: true });
    return Number((s.bavail * s.bsize) / 1_048_576n);
  } catch { return null; }
}

/** freeMb from `fs.statfsSync(dataDir)`; null if statfs throws. Never throws. */
export function diskUsage(dataDir: string): DiskUsage {
  return {
    freeMb: freeMbOf(dataDir),
    marksBytes: dirBytes(join(dataDir, "marks")),
    closuresBytes: dirBytes(join(dataDir, "closures")),
  };
}

/** `statfs` on every read; the two directory walks at most once every `bytesEveryMs`. */
export function createDiskMonitor(dataDir: string, o: { now?: () => number; bytesEveryMs?: number } = {}) {
  const now = o.now ?? Date.now;
  const every = o.bytesEveryMs ?? DISK_BYTES_EVERY_MS;
  let bytesAt = Number.NEGATIVE_INFINITY;
  let marksBytes = 0;
  let closuresBytes = 0;
  return {
    read(): DiskUsage {
      const t = now();
      if (t - bytesAt >= every) {
        marksBytes = dirBytes(join(dataDir, "marks"));
        closuresBytes = dirBytes(join(dataDir, "closures"));
        bytesAt = t;
      }
      return { freeMb: freeMbOf(dataDir), marksBytes, closuresBytes };
    },
  };
}

/** The disk alarm for this tick, if any: sev-1 below 512 MB free, sev-2 below 2,048 MB. Unknown free space raises nothing. */
export function diskAlarm(freeMb: number | null): [1 | 2, string, string] | null {
  if (freeMb === null) return null;
  if (freeMb < DISK_CRITICAL_MB) {
    return [1, "keeper:disk-critical", `only ${freeMb} MB free on the keeper's volume: commits and settles stop when it is full`];
  }
  if (freeMb < DISK_LOW_MB) return [2, "keeper:disk-low", `${freeMb} MB free on the keeper's volume`];
  return null;
}

/** `/healthz` `mem`. */
export function memUsage(): { rssMb: number; heapUsedMb: number } {
  try {
    const m = process.memoryUsage();
    return { rssMb: Math.round(m.rss / 1_048_576), heapUsedMb: Math.round(m.heapUsed / 1_048_576) };
  } catch { return { rssMb: -1, heapUsedMb: -1 }; }
}
