/**
 * W3: retention and disk. Boot reports orphan swap files and deletes nothing; free space is visible before it
 * stops a commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closureFilesIn, orphanClosureFiles, orphanReport, diskUsage, createDiskMonitor, diskAlarm, memUsage, closureFileName,
  DISK_LOW_MB, DISK_CRITICAL_MB,
} from "./retention.ts";

const W1 = "0x41333Df9E7639188BBfca5522dC4844398Af9f9E";
const W2 = "0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417";
const W3 = "0x85AB0FebdFa7201E65eA01bd3e4CC6F9c0Ac4471";

function dataDir() {
  const d = mkdtempSync(join(tmpdir(), "curb-retention-"));
  mkdirSync(join(d, "closures"));
  mkdirSync(join(d, "marks"));
  return d;
}

test("orphans are files no open or pending closure names", () => {
  const d = dataDir();
  const open = { wrapper: W1, cutBlock: 75_773_120 };
  const pending = { wrapper: W2, cutBlock: 75_772_000 };
  const orphan = { wrapper: W3, cutBlock: 75_700_000 };
  const line = '{"b":1,"i":0,"q":"1","p":"1"}\n';
  for (const c of [open, pending, orphan]) writeFileSync(join(d, "closures", closureFileName(c)), line);
  writeFileSync(join(d, "closures", `${closureFileName(open)}.123.tmp`), "x");     // a transient rewrite file is not an orphan
  assert.equal(closureFileName(open), `${W1.toLowerCase()}-75773120.jsonl`);
  const state = { open: { [W1]: open }, pending: [pending] };
  assert.deepEqual(orphanClosureFiles(d, state), [closureFileName(orphan)]);
  assert.deepEqual(orphanReport(d, state), { files: [closureFileName(orphan)], bytes: line.length });
  assert.equal(closureFilesIn(d).length, 3);
  assert.equal(readdirSync(join(d, "closures")).length, 4, "nothing deleted");
  rmSync(d, { recursive: true, force: true });
});

test("orphan reporting never throws: no closures directory, odd state", () => {
  const d = mkdtempSync(join(tmpdir(), "curb-retention-"));
  assert.deepEqual(closureFilesIn(d), []);
  assert.deepEqual(orphanClosureFiles(d, { open: {}, pending: [] }), []);
  assert.deepEqual(orphanReport(join(d, "missing"), { open: {}, pending: [] }), { files: [], bytes: 0 });
  rmSync(d, { recursive: true, force: true });
});

test("diskUsage reports free space and never throws", () => {
  const d = dataDir();
  writeFileSync(join(d, "marks", "0xaa.json"), "a".repeat(1_000));
  writeFileSync(join(d, "marks", "0xbb.json"), "b".repeat(234));
  writeFileSync(join(d, "closures", closureFileName({ wrapper: W1, cutBlock: 1 })), "c".repeat(75));
  const u = diskUsage(d);
  assert.ok(u.freeMb !== null && u.freeMb > 0, String(u.freeMb));
  assert.equal(u.marksBytes, 1_234);
  assert.equal(u.closuresBytes, 75);
  let missing: ReturnType<typeof diskUsage> | undefined;
  assert.doesNotThrow(() => { missing = diskUsage(join(d, "does-not-exist")); });
  assert.deepEqual(missing, { freeMb: null, marksBytes: 0, closuresBytes: 0 });
  rmSync(d, { recursive: true, force: true });
});

test("the disk monitor reads statfs every tick and walks the directories at most every 10 minutes", () => {
  const d = dataDir();
  const clock = { t: 0 };
  const m = createDiskMonitor(d, { now: () => clock.t });
  assert.equal(m.read().marksBytes, 0);
  writeFileSync(join(d, "marks", "0xaa.json"), "a".repeat(500));
  clock.t += 9 * 60_000;
  const r = m.read();
  assert.equal(r.marksBytes, 0, "cached");
  assert.ok(r.freeMb !== null);
  clock.t += 60_000;
  assert.equal(m.read().marksBytes, 500);
  rmSync(d, { recursive: true, force: true });
});

test("disk alarms: sev-2 below 2,048 MB, sev-1 below 512 MB", () => {
  assert.equal(diskAlarm(null), null);
  assert.equal(diskAlarm(DISK_LOW_MB), null);
  assert.deepEqual(diskAlarm(DISK_LOW_MB - 1)?.slice(0, 2), [2, "keeper:disk-low"]);
  assert.deepEqual(diskAlarm(DISK_CRITICAL_MB)?.slice(0, 2), [2, "keeper:disk-low"]);
  assert.deepEqual(diskAlarm(DISK_CRITICAL_MB - 1)?.slice(0, 2), [1, "keeper:disk-critical"]);
  assert.deepEqual(diskAlarm(0)?.slice(0, 2), [1, "keeper:disk-critical"]);
});

test("memUsage reports the process's rss and heap in MB", () => {
  const m = memUsage();
  assert.ok(m.rssMb > 0 && m.heapUsedMb > 0 && m.heapUsedMb <= m.rssMb, JSON.stringify(m));
});
