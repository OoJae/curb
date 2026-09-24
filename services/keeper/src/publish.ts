/**
 * Publishing evidence to the public archive: the Cloudflare R2 bucket `curb-archive`, served read-only
 * at https://archive.curb.markets.
 *
 * The local disk stays the first copy, and the host keeps serving it. This adds a second copy that
 * outlives the host. Once an object lands under rounds/, marks/ or witness/, a bucket lock stops anyone
 * deleting or overwriting it, including us and anyone holding the object-level token this process uses.
 *
 * The order matches the rest of the service. The caller fsyncs the bundle first. Then enqueue() writes a
 * pointer to it durably, and a background loop PUTs it. So:
 *   - nothing is published that is not already on disk;
 *   - a crash or restart loses nothing queued, because pointers are re-read at start;
 *   - publishing never blocks a tick or throws into one. enqueue() is synchronous, cheap and total, and
 *     every network call runs in the background with a per-attempt timeout and bounded retries.
 *
 * Every evidence PUT carries `If-None-Match: *`. The first write wins, a repeat answers 412, and 412
 * counts as success. That makes the queue, a restart and the Mac backfill idempotent against each other.
 *
 * SigV4 is done here with node:crypto alone, with no AWS SDK, and checked against AWS's published vectors.
 *
 * ONE FILE, TWO COPIES. services/attestor/src/publish.ts and services/keeper/src/publish.ts are byte-
 * identical, and a test enforces it. Each service is built from its own directory and its codeDigest
 * covers only its own src/, so the file cannot be shared by import.
 *
 * Secrets: R2_SECRET_ACCESS_KEY is used for signing and nothing else. It is never logged or put in
 * /healthz, and every stored error message is scrubbed of both key values first.
 */
import { createHash, createHmac } from "node:crypto";
import {
  closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------------------------

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignRequest {
  method: string;
  /** Full URL. Host, path and query are taken from it. */
  url: string;
  /** Headers to sign besides `host`, which comes from the URL. Names are case-insensitive. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the exact body bytes. */
  payloadHash: string;
  region: string;
  service: string;
  /** ISO 8601 basic format, e.g. 20150830T123600Z. */
  amzDate: string;
  credentials: Credentials;
}

export interface Signed {
  canonicalRequest: string;
  stringToSign: string;
  signedHeaders: string;
  signature: string;
  authorization: string;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986: only A-Z a-z 0-9 - _ . ~ pass. Everything else is %XX with upper-case hex, as SigV4 requires. */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * S3-style canonical URI: each path segment encoded once. (Other AWS services encode twice. S3, and so
 * R2, do not, and they are the only services this signs for. For a path of "/" the two agree.)
 */
function canonicalUri(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";
  return pathname.split("/").map((seg) => {
    let raw = seg;
    try { raw = decodeURIComponent(seg); } catch { /* not percent-encoded: sign it as given */ }
    return uriEncode(raw);
  }).join("/");
}

function canonicalQuery(u: URL): string {
  const pairs = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export function signV4(r: SignRequest): Signed {
  const u = new URL(r.url);
  const headers = new Map<string, string>([["host", u.host]]);
  for (const [k, v] of Object.entries(r.headers)) headers.set(k.toLowerCase(), String(v).trim().replace(/\s+/g, " "));
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    r.method.toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u),
    names.map((n) => `${n}:${headers.get(n)}\n`).join(""),
    signedHeaders,
    r.payloadHash,
  ].join("\n");
  const day = r.amzDate.slice(0, 8);
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", r.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + r.credentials.secretAccessKey, day), r.region), r.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalRequest, stringToSign, signedHeaders, signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------------------------------
// R2: configuration, key policy, one PUT
// ---------------------------------------------------------------------------------------------

export interface R2Config extends Credentials {
  accountId: string;
  bucket: string;
  /** https://<accountId>.r2.cloudflarestorage.com. Overridable only in code, for tests. */
  endpoint: string;
}

/**
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default curb-archive).
 *
 * All three credentials unset means publishing is off, which is the normal state before tokens exist.
 * A partial or malformed set also means off, never a crash: the archive is a second copy, and a typo in
 * it must not stop the first one being written. The reason is on /healthz and in the boot log. It names
 * the variables and never their values.
 */
export function loadR2Config(env: Record<string, string | undefined> = process.env): { config: R2Config | null; reason: string } {
  const v = (k: string) => (env[k] ?? "").trim();
  const accountId = v("R2_ACCOUNT_ID").toLowerCase();
  const accessKeyId = v("R2_ACCESS_KEY_ID");
  const secretAccessKey = v("R2_SECRET_ACCESS_KEY");
  const bucket = v("R2_BUCKET") || "curb-archive";
  const missing = Object.entries({ R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey })
    .filter(([, x]) => x === "").map(([k]) => k);
  if (missing.length === 3) return { config: null, reason: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are unset" };
  if (missing.length) return { config: null, reason: `incomplete R2 configuration: ${missing.join(", ")} unset` };
  if (!/^[0-9a-f]{32}$/.test(accountId)) return { config: null, reason: "R2_ACCOUNT_ID is not a 32-character hex Cloudflare account id" };
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return { config: null, reason: `R2_BUCKET ${JSON.stringify(bucket)} is not a valid bucket name` };
  return { config: { accountId, accessKeyId, secretAccessKey, bucket, endpoint: `https://${accountId}.r2.cloudflarestorage.com` }, reason: "" };
}

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const INDEX_CACHE = "public, max-age=60";
const EVIDENCE_KEY = /^(rounds|marks|witness|witness\/tx)\/0x[0-9a-f]{64}\.json$/;
const INDEX_KEY = /^index\/[a-z0-9][a-z0-9._-]*$/;

/**
 * Evidence (rounds/, marks/, witness/) is write-once and cached for a year. The index is a rebuildable
 * convenience: overwritten in place, briefly cached. Any other key is refused, so a bug cannot write
 * outside the layout the bucket locks were set up for.
 */
export function objectPolicy(key: string): { cacheControl: string; writeOnce: boolean } {
  if (EVIDENCE_KEY.test(key)) return { cacheControl: IMMUTABLE_CACHE, writeOnce: true };
  if (INDEX_KEY.test(key)) return { cacheControl: INDEX_CACHE, writeOnce: false };
  throw new Error(`refusing to publish ${JSON.stringify(key)}: not a rounds/, marks/, witness/ or index/ key`);
}

export interface PutResult {
  /** Stored, or already there (412). */
  ok: boolean;
  status: number;
  /** A write-once key that already existed. */
  existed: boolean;
  error?: string;
}

export interface PutOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** The whole attempt, response included, is abandoned at this deadline even if fetch ignores its signal. */
  timeoutMs?: number;
}

/** One signed PUT. Total for network and HTTP failures: they come back as `{ ok: false }`, never thrown. */
export async function putObject(cfg: R2Config, key: string, body: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
  const policy = objectPolicy(key);
  const url = `${cfg.endpoint}/${cfg.bucket}/${key.split("/").map(uriEncode).join("/")}`;
  const payloadHash = sha256Hex(body);
  const date = amzDate((opts.now ?? Date.now)());
  const headers: Record<string, string> = {
    "cache-control": policy.cacheControl,
    "content-type": "application/json",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  if (policy.writeOnce) headers["if-none-match"] = "*";
  const { authorization } = signV4({ method: "PUT", url, headers, payloadHash, region: "auto", service: "s3", amzDate: date, credentials: cfg });

  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
  deadline.catch(() => { /* observed through the races below */ });
  try {
    const res = await Promise.race([
      (opts.fetch ?? fetch)(url, { method: "PUT", headers: { ...headers, authorization }, body: new Uint8Array(body), signal: ctrl.signal }),
      deadline,
    ]);
    if (res.status === 412 || res.ok) {
      res.body?.cancel().catch(() => { /* nothing to read */ });
      return { ok: true, status: res.status, existed: res.status === 412 };
    }
    const text = await Promise.race([res.text(), deadline]).catch(() => "");
    return { ok: false, status: res.status, existed: false, error: scrub(`HTTP ${res.status}${s3Error(text)}`, cfg) };
  } catch (e) {
    return { ok: false, status: 0, existed: false, error: scrub(describe(e), cfg) };
  } finally {
    clearTimeout(timer);
  }
}

/** Only the <Code> and <Message> of an S3 error body, bounded. */
function s3Error(xml: string): string {
  const code = xml.match(/<Code>([^<]{0,100})<\/Code>/)?.[1];
  const msg = xml.match(/<Message>([^<]{0,300})<\/Message>/)?.[1];
  return code || msg ? ` ${[code, msg].filter(Boolean).join(": ")}` : "";
}

/** Neither key value may reach a log line, /healthz or a stored error, whatever produced the message. */
export function scrub(message: string, c: Credentials): string {
  let out = message;
  for (const s of [c.secretAccessKey, c.accessKeyId]) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return `${e.name}: ${e.message}${cause ? ` (${cause.code ?? cause.message})` : ""}`;
}

/** fsync the file, rename it into place, fsync the directory. */
function writeDurable(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), "r"); fsyncSync(dfd); closeSync(dfd);
}

// ---------------------------------------------------------------------------------------------
// the durable queue
// ---------------------------------------------------------------------------------------------

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export interface PublisherOptions {
  dataDir: string;
  /** null disables publishing: enqueue() becomes a no-op and nothing touches the disk. */
  config: R2Config | null;
  /** Shown on /healthz when config is null. Names variables, never values. */
  disabledReason?: string;
  log?: LogFn;
  fetch?: typeof fetch;
  now?: () => number;
  /** Per PUT, response included. */
  attemptTimeoutMs?: number;
  /** After this many failed attempts an item is parked until the next restart. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface PublishHealth {
  enabled: boolean;
  /** Why publishing is off, when it is. */
  reason?: string;
  bucket?: string;
  /** Waiting to be published, parked items included. */
  queued: number;
  /** Items that used up their attempts. They are retried after the next restart. */
  parked: number;
  /** Confirmed in the bucket since boot (stored now, or already there). */
  published: number;
  /** The subset of `published` that answered 412: the object was already there. */
  alreadyPresent: number;
  /** Failed attempts since boot. Each is retried with backoff until the item is parked. */
  failed: number;
  lastPublished: { key: string; atMs: number } | null;
  lastError: { key: string; message: string; atMs: number } | null;
}

interface Item {
  key: string;
  /** Relative to dataDir when inside it, so a pointer survives the volume being mounted elsewhere. */
  file: string;
  enqueuedAtMs: number;
  attempts: number;
  nextTryMs: number;
  parked: boolean;
  /** The pointer file, or null if it could not be written (the item is then held in memory only). */
  pointer: string | null;
}

const pointerName = (key: string) => key.replace(/\//g, "~") + ".ptr";

export class Publisher {
  readonly dir: string;
  private readonly o: PublisherOptions;
  private readonly now: () => number;
  private readonly items = new Map<string, Item>();
  private reason: string;
  private started = false;
  private stopped = false;
  private dirReady = false;
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private published = 0;
  private alreadyPresent = 0;
  private failed = 0;
  private lastPublished: PublishHealth["lastPublished"] = null;
  private lastError: PublishHealth["lastError"] = null;

  constructor(o: PublisherOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.dir = join(o.dataDir, "publish-queue");
    this.reason = o.config ? "" : (o.disabledReason || "R2 is not configured");
  }

  get enabled(): boolean {
    return this.o.config !== null && this.reason === "";
  }

  /** Re-read the queue left by the previous process and start the background loop. Never throws. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) { this.log("archive", { enabled: false, reason: this.reason }); return; }
    try {
      this.ensureDir();
      for (const name of readdirSync(this.dir)) {
        const p = join(this.dir, name);
        if (name.endsWith(".tmp")) { try { unlinkSync(p); } catch { /* best effort */ } continue; }
        if (!name.endsWith(".ptr")) continue;
        try {
          const j = JSON.parse(readFileSync(p, "utf8")) as { key?: unknown; file?: unknown; enqueuedAtMs?: unknown };
          if (typeof j.key !== "string" || typeof j.file !== "string" || pointerName(j.key) !== name) throw new Error("malformed pointer");
          objectPolicy(j.key);
          this.items.set(j.key, { key: j.key, file: j.file, enqueuedAtMs: Number(j.enqueuedAtMs) || 0, attempts: 0, nextTryMs: 0, parked: false, pointer: p });
        } catch (e) {
          this.noteError(name, `unreadable queue pointer set aside as .bad: ${describe(e)}`);
          try { renameSync(p, `${p}.bad`); } catch { /* it is retried, and set aside, at the next start */ }
        }
      }
    } catch (e) {
      this.reason = `publish queue at ${this.dir} is unusable: ${describe(e)}`;
      this.log("archive", { enabled: false, reason: this.reason });
      return;
    }
    this.log("archive", { enabled: true, bucket: this.o.config!.bucket, queued: this.items.size });
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Queue `path` for upload as `key`. Call it only AFTER the file is fsynced. Synchronous and total: it
   * writes one small pointer file and returns, and a failure is recorded on /healthz, never thrown.
   */
  enqueue(key: string, path: string): void {
    if (!this.enabled) return;
    try {
      objectPolicy(key);
      const have = this.items.get(key);
      if (have) {
        // The same evidence again (a write-once file re-persisted). A parked item gets a fresh budget.
        if (have.parked) { have.parked = false; have.attempts = 0; have.nextTryMs = 0; }
        this.kick();
        return;
      }
      const abs = resolve(path);
      const rel = relative(resolve(this.o.dataDir), abs);
      const file = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
      const enqueuedAtMs = this.now();
      let pointer: string | null = join(this.dir, pointerName(key));
      try {
        this.ensureDir();
        writeDurable(pointer, JSON.stringify({ v: 1, key, file, enqueuedAtMs }));
      } catch (e) {
        // Still try to publish from memory; only a restart before it lands could lose this one.
        pointer = null;
        this.noteError(key, `queue pointer not written (held in memory only): ${describe(e)}`);
        this.log("publish-enqueue-degraded", { key, error: this.lastError?.message });
      }
      this.items.set(key, { key, file, enqueuedAtMs, attempts: 0, nextTryMs: 0, parked: false, pointer });
      this.kick();
    } catch (e) {
      this.noteError(key, `enqueue refused: ${describe(e)}`);
      this.log("publish-enqueue-failed", { key, error: this.lastError?.message });
    }
  }

  /**
   * One pass over every item that is due, oldest first, one PUT at a time. The background loop calls it;
   * so can tests. With `deadlineMs`, no new attempt starts once the clock reaches it.
   */
  drain(opts: { deadlineMs?: number } = {}): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.draining) return this.draining;
    this.draining = (async () => {
      const due = [...this.items.values()]
        .filter((i) => !i.parked && i.nextTryMs <= this.now())
        .sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs);
      for (const it of due) {
        if (this.stopped) break;
        if (opts.deadlineMs !== undefined && this.now() >= opts.deadlineMs) break;
        try { await this.attempt(it); } catch (e) { this.noteError(it.key, describe(e)); }
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  health(): PublishHealth {
    const all = [...this.items.values()];
    return {
      enabled: this.enabled,
      ...(this.enabled ? { bucket: this.o.config!.bucket } : { reason: this.reason }),
      queued: all.length,
      parked: all.filter((i) => i.parked).length,
      published: this.published,
      alreadyPresent: this.alreadyPresent,
      failed: this.failed,
      lastPublished: this.lastPublished,
      lastError: this.lastError,
    };
  }

  // -------------------------------------------------------------------------------------------

  private async attempt(it: Item): Promise<void> {
    let body: Buffer;
    try {
      body = readFileSync(isAbsolute(it.file) ? it.file : join(this.o.dataDir, it.file));
    } catch (e) {
      // The evidence is gone from this disk, so there is nothing left to publish. Drop it loudly
      // instead of retrying forever. (The Mac backfill re-reads the chain and would catch the gap.)
      this.failed++;
      this.noteError(it.key, `local file unreadable, dropped from the queue: ${describe(e)}`);
      this.log("publish-dropped", { key: it.key, file: it.file, error: this.lastError?.message });
      this.remove(it);
      return;
    }
    it.attempts++;
    const r = await putObject(this.o.config!, it.key, body, { fetch: this.o.fetch, now: this.now, timeoutMs: this.o.attemptTimeoutMs ?? 20_000 });
    if (r.ok) {
      this.published++;
      if (r.existed) this.alreadyPresent++;
      this.lastPublished = { key: it.key, atMs: this.now() };
      this.remove(it);
      this.log("published", { key: it.key, status: r.status, existed: r.existed, attempts: it.attempts });
      return;
    }
    this.failed++;
    this.noteError(it.key, r.error ?? `HTTP ${r.status}`);
    const max = this.o.maxAttempts ?? 16;
    if (it.attempts >= max) {
      it.parked = true;
      this.log("publish-parked", { key: it.key, attempts: it.attempts, error: this.lastError?.message, note: "retried after the next restart" });
      return;
    }
    const base = this.o.backoffBaseMs ?? 5_000;
    const cap = this.o.backoffMaxMs ?? 30 * 60_000;
    const waitMs = Math.round(Math.min(cap, base * 2 ** (it.attempts - 1)) * (0.8 + 0.4 * Math.random()));
    it.nextTryMs = this.now() + waitMs;
    this.log("publish-retry", { key: it.key, attempt: it.attempts, waitMs, error: this.lastError?.message });
  }

  private remove(it: Item) {
    this.items.delete(it.key);
    if (!it.pointer) return;
    // A lost unlink only means one repeat PUT after a restart, which answers 412.
    try { unlinkSync(it.pointer); } catch { /* already gone */ }
  }

  private ensureDir() {
    if (this.dirReady) return;
    mkdirSync(this.dir, { recursive: true });
    this.dirReady = true;
  }

  private kick() {
    if (this.started && !this.stopped) this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.loop(); }, ms);
    this.timer.unref?.();
  }

  private async loop() {
    // drain() hands back the pass already in flight, if any, so this always reschedules after it ends.
    try { await this.drain(); } catch (e) { this.noteError("", describe(e)); }
    const waiting = [...this.items.values()].filter((i) => !i.parked).map((i) => i.nextTryMs);
    const next = waiting.length ? Math.min(...waiting) - this.now() : 60_000;
    this.schedule(Math.max(0, Math.min(60_000, next)));
  }

  private noteError(key: string, message: string) {
    const c = this.o.config;
    this.lastError = { key, message: c ? scrub(message, c) : message, atMs: this.now() };
  }

  private log(event: string, fields: Record<string, unknown>) {
    try { this.o.log?.(event, fields); } catch { /* logging must never break publishing */ }
  }
}

/**
 * The service wiring in one call. R2_* comes from the environment, and nothing is published in shadow
 * mode. A shadow host's rounds and marks are never written on chain, and the evidence prefixes are
 * locked forever, so archiving them would be permanent noise.
 */
export function publisherFromEnv(dataDir: string, mode: string, log?: LogFn, env: Record<string, string | undefined> = process.env): Publisher {
  if (mode === "shadow") {
    return new Publisher({ dataDir, config: null, log, disabledReason: "MODE=shadow: nothing a shadow host builds is written on chain, so none of it is archived" });
  }
  const { config, reason } = loadR2Config(env);
  return new Publisher({ dataDir, config, disabledReason: reason, log });
}
