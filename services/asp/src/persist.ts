/**
 * Durable writes, as in services/keeper/src/main.ts: write to a temp file, fsync it, rename it over the
 * target, fsync the directory. A crash at any point leaves either the old file or the new one, never a
 * torn one -- which matters most for receipts, because a receipt is the only record that a buyer's
 * money bought a specific set of bytes.
 */
import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function persistReplace(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), "r"); fsyncSync(dfd); closeSync(dfd);
}

/**
 * Write-once. A published receipt or evidence file is the thing a claim is checked against, so it is
 * never rewritten; the name is a hash of the content, so a second write would only repeat the first.
 * Returns false when the file already existed.
 */
export function persistOnce(path: string, content: string | Uint8Array): boolean {
  if (existsSync(path)) return false;
  persistReplace(path, content);
  return true;
}
