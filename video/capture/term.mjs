// Record one real terminal command, verbatim, with UTC stamps.
//
// Terminal shots in the film are not screen recordings. They are the saved stdout+stderr of a real
// command, replayed by the terminal block in index.html at the pace the bytes actually arrived. So
// what is recorded here is exactly what the film types: nothing is retyped, trimmed or prettified.
//
//   node capture/term.mjs T1 --show 'cast call … stateOf(address) … --rpc-url https://rpc.xlayer.tech' \
//        -- cast call 0x160D… 'stateOf(address)((uint8,uint128,uint64,uint64,uint32,bool))' 0x4133… --rpc-url …
//
// Options before `--`:
//   --out <dir>     where <ID>.json and <ID>.txt go (default: terminal/, relative to video/)
//   --show <text>   the command line as the film prints it after the prompt (default: argv joined)
//   --title <text>  the window title (default: the program name)
//   --cwd <dir>     working directory for the command
//   --shell         run the command string through /bin/sh -c (for pipes); argv after -- is joined
//
// Spending guard: anything that can sign, pay or broadcast is refused unless CURB_ALLOW_SPEND=1 is
// set in the environment by a human. The video lane never sets it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VIDEO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SPEND = [
  /\bpayment\s+(pay|pay-local|charge|a2a-pay|session|subscription)\b/i,
  /\bcast\s+(send|publish)\b/i,
  /--broadcast\b/i,
  /\bwallet\s+(send|transfer|contract-call|swap|bridge|approve)\b/i,
  /\bswap\s+(execute|swap)\b/i,
];

export function assertNoSpend(line) {
  if (process.env.CURB_ALLOW_SPEND === "1") return;
  for (const re of SPEND) {
    if (re.test(line)) {
      throw new Error(`refusing to run a command that can spend or broadcast: ${line}\n` +
        `(a human sets CURB_ALLOW_SPEND=1 for the one paid call; the video lane never does)`);
    }
  }
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Run a command and record it. Resolves to the record (also written to disk).
 * stdout and stderr are merged in arrival order, the way a terminal shows them.
 */
export function record({ id, argv, show, title, cwd, shell = false, out = path.join(VIDEO_DIR, "terminal"), env, quiet = false }) {
  const line = shell ? argv.join(" ") : argv.map((a) => (/[\s'"$`\\|&;()<>*?]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");
  assertNoSpend(line);
  fs.mkdirSync(out, { recursive: true });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = shell
      ? spawn("/bin/sh", ["-c", line], { cwd, env: { ...process.env, ...env } })
      : spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    const chunks = [];
    const push = (stream) => (buf) => {
      const s = buf.toString("utf8");
      chunks.push({ t: Date.now() - t0, s, stream });
      if (!quiet) process.stdout.write(s);
    };
    child.stdout.on("data", push("stdout"));
    child.stderr.on("data", push("stderr"));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const t1 = Date.now();
      const rec = {
        schema: "curb.video.terminal/1",
        id,
        title: title ?? path.basename(argv[0]),
        show: show ?? line,
        command: line,
        cwd: cwd ? path.relative(VIDEO_DIR, path.resolve(cwd)) || "." : ".",
        startedAt: iso(t0),
        endedAt: iso(t1),
        durationMs: t1 - t0,
        exitCode: code,
        signal: signal ?? null,
        output: chunks.map((c) => c.s).join(""),
        chunks,
      };
      fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
      fs.writeFileSync(path.join(out, `${id}.txt`),
        `# ${id} · started ${rec.startedAt} · exit ${code}\n$ ${rec.show}\n${rec.output}`);
      resolve(rec);
    });
  });
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dd = args.indexOf("--");
  if (dd < 1) {
    console.error("usage: node capture/term.mjs <ID> [--out dir] [--show text] [--title text] [--cwd dir] [--shell] -- <cmd> [args…]");
    process.exit(2);
  }
  const head = args.slice(0, dd), argv = args.slice(dd + 1);
  const opt = (k) => { const i = head.indexOf(k); return i >= 0 ? head[i + 1] : undefined; };
  try {
    const rec = await record({
      id: head[0], argv, show: opt("--show"), title: opt("--title"), cwd: opt("--cwd"),
      shell: head.includes("--shell"), out: opt("--out") ? path.resolve(opt("--out")) : undefined,
    });
    console.error(`\n[term] ${rec.id} exit ${rec.exitCode} · ${rec.startedAt} → ${rec.endedAt}`);
    process.exit(0);
  } catch (e) {
    console.error(`[term] ${e.message}`);
    process.exit(3);
  }
}
