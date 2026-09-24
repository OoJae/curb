/**
 * The archive publisher. Byte-identical in services/attestor/src and services/keeper/src, like publish.ts.
 *
 * Covers: SigV4 against AWS's own published examples; the exact PUT R2 receives; configuration that turns
 * itself off cleanly; and the durable queue driven through an injected fetch. In the queue tests a 412 is
 * a success and unlinks the pointer, a 500 stays queued, a hanging PUT is abandoned at its deadline, and a
 * restart re-reads what was left. None of it touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMMUTABLE_CACHE, INDEX_CACHE, Publisher, loadR2Config, objectPolicy, publisherFromEnv, putObject, sha256Hex, signV4,
} from "./publish.ts";
import type { R2Config } from "./publish.ts";

// ---------------------------------------------------------------------------------------------
// SigV4: AWS's published vectors
// ---------------------------------------------------------------------------------------------

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// The AWS SigV4 test suite (aws-sig-v4-test-suite): credentials, scope and date shared by every case.
const SUITE = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const suiteCase = (method: string) => signV4({
  method, url: "https://example.amazonaws.com/", headers: { "X-Amz-Date": "20150830T123600Z" },
  payloadHash: EMPTY, region: "us-east-1", service: "service", amzDate: "20150830T123600Z", credentials: SUITE,
});

test("SigV4 test suite: get-vanilla", () => {
  const s = suiteCase("GET");
  assert.equal(s.canonicalRequest, `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`);
  assert.equal(s.stringToSign,
    "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
  assert.equal(s.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});

test("SigV4 test suite: post-vanilla", () => {
  const s = suiteCase("POST");
  assert.equal(s.stringToSign,
    "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87");
  assert.equal(s.signature, "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b");
});

// The S3 developer guide's worked examples ("Signature Calculations for the Authorization Header:
// Transferring Payload in a Single Chunk"): the S3 flavour this publisher actually speaks.
const S3_DOCS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

test("S3 docs example: GET Object (x-amz-content-sha256 signed)", () => {
  const s = signV4({
    method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { Range: "bytes=0-9", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
    payloadHash: EMPTY, region: "us-east-1", service: "s3", amzDate: "20130524T000000Z", credentials: S3_DOCS,
  });
  assert.equal(s.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  assert.equal(s.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("S3 docs example: PUT Object with a body and a key that needs encoding", () => {
  const body = "Welcome to Amazon S3.";
  const payloadHash = sha256Hex(body);
  assert.equal(payloadHash, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const s = signV4({
    method: "PUT", url: "https://examplebucket.s3.amazonaws.com/test$file.text",
    headers: {
      Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-date": "20130524T000000Z",
      "x-amz-storage-class": "REDUCED_REDUNDANCY", "x-amz-content-sha256": payloadHash,
    },
    payloadHash, region: "us-east-1", service: "s3", amzDate: "20130524T000000Z", credentials: S3_DOCS,
  });
  assert.match(s.canonicalRequest, /^PUT\n\/test%24file\.text\n/);
  assert.equal(s.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

// ---------------------------------------------------------------------------------------------
// the PUT R2 receives
// ---------------------------------------------------------------------------------------------

const SECRET = "s3cr3t-DO-NOT-LEAK-0123456789abcdefghij";
const AKID = "akid-0123456789abcdef";
const CFG: R2Config = {
  accountId: "e38cb9baf5a71676deda49343e9d53d3", accessKeyId: AKID, secretAccessKey: SECRET,
  bucket: "curb-archive", endpoint: "https://e38cb9baf5a71676deda49343e9d53d3.r2.cloudflarestorage.com",
};
const ROOT = "0x" + "ab".repeat(32);
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

interface Call { url: string; method: string; headers: Record<string, string>; body: Buffer }
function recorder(respond: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(url), method: String(init?.method), headers: { ...(init?.headers as Record<string, string>) },
      body: Buffer.from(init?.body as Uint8Array),
    };
    calls.push(c);
    return respond(c, calls.length);
  }) as typeof fetch;
  return { calls, f };
}

test("an evidence PUT is write-once, immutable, JSON, and signed for R2 (region auto, service s3)", async () => {
  const body = Buffer.from('{"inputRoot":"x"}');
  const { calls, f } = recorder(() => new Response(null, { status: 200 }));
  const r = await putObject(CFG, `rounds/${ROOT}.json`, body, { fetch: f, now: () => T0 });
  assert.deepEqual(r, { ok: true, status: 200, existed: false });
  const c = calls[0];
  assert.equal(c.method, "PUT");
  assert.equal(c.url, `https://e38cb9baf5a71676deda49343e9d53d3.r2.cloudflarestorage.com/curb-archive/rounds/${ROOT}.json`);
  assert.equal(c.headers["if-none-match"], "*");
  assert.equal(c.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(c.headers["content-type"], "application/json");
  assert.equal(c.headers["x-amz-content-sha256"], sha256Hex(body));
  assert.equal(c.headers["x-amz-date"], "20260924T120000Z");
  assert.ok(c.body.equals(body), "the exact bytes on disk, not a re-serialisation");
  assert.match(c.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=akid-0123456789abcdef\/20260924\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  // The signature is the one signV4 gives for exactly these headers.
  const { authorization, ...signedHeaders } = c.headers;
  const again = signV4({ method: "PUT", url: c.url, headers: signedHeaders, payloadHash: sha256Hex(body), region: "auto", service: "s3", amzDate: "20260924T120000Z", credentials: CFG });
  assert.equal(authorization, again.authorization);
  assert.ok(!JSON.stringify(c.headers).includes(SECRET), "the secret signs; it is never sent");
});

test("every evidence prefix is write-once; the index is overwritable; anything else is refused", async () => {
  for (const key of [`rounds/${ROOT}.json`, `marks/${ROOT}.json`, `witness/${ROOT}.json`, `witness/tx/${ROOT}.json`]) {
    assert.deepEqual(objectPolicy(key), { cacheControl: IMMUTABLE_CACHE, writeOnce: true }, key);
  }
  assert.deepEqual(objectPolicy("index/latest.json"), { cacheControl: INDEX_CACHE, writeOnce: false });
  assert.deepEqual(objectPolicy("index/rounds.ndjson"), { cacheControl: INDEX_CACHE, writeOnce: false });
  for (const bad of ["rounds/../x.json", `rounds/${ROOT.toUpperCase()}.json`, `rounds/${ROOT}.json.bak`, "keys/attestor.keystore.json", "index/../rounds/x", `/rounds/${ROOT}.json`, ""]) {
    assert.throws(() => objectPolicy(bad), /refusing to publish/, bad);
  }
  const { calls, f } = recorder(() => new Response(null, { status: 200 }));
  await putObject(CFG, "index/latest.json", Buffer.from("{}"), { fetch: f, now: () => T0 });
  assert.equal(calls[0].headers["if-none-match"], undefined, "the index is rewritten, so no precondition");
  assert.equal(calls[0].headers["cache-control"], INDEX_CACHE);
});

test("412 means the object is already there: success, not an error", async () => {
  const { f } = recorder(() => new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 }));
  assert.deepEqual(await putObject(CFG, `marks/${ROOT}.json`, Buffer.from("{}"), { fetch: f }), { ok: true, status: 412, existed: true });
});

test("an HTTP failure reports only the S3 code and message, scrubbed of both keys", async () => {
  const xml = `<Error><Code>SignatureDoesNotMatch</Code><Message>bad sig for ${AKID} using ${SECRET}</Message><StringToSign>…</StringToSign></Error>`;
  const { f } = recorder(() => new Response(xml, { status: 403 }));
  const r = await putObject(CFG, `rounds/${ROOT}.json`, Buffer.from("{}"), { fetch: f });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error!, /^HTTP 403 SignatureDoesNotMatch: bad sig for \[redacted\] using \[redacted\]$/);
});

test("a PUT whose fetch ignores its abort signal is still abandoned at the deadline", async () => {
  const hang = (() => new Promise<Response>(() => { /* never settles, never looks at the signal */ })) as typeof fetch;
  const t = Date.now();
  const r = await putObject(CFG, `rounds/${ROOT}.json`, Buffer.from("{}"), { fetch: hang, timeoutMs: 60 });
  assert.ok(Date.now() - t < 1_000, "returned promptly");
  assert.equal(r.ok, false);
  assert.match(r.error!, /timed out after 60ms/);
});

// ---------------------------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------------------------

test("R2 config: unset is off, partial is off and names what is missing, never a value", () => {
  assert.equal(loadR2Config({}).config, null);
  assert.match(loadR2Config({}).reason, /unset/);
  const partial = loadR2Config({ R2_ACCOUNT_ID: CFG.accountId, R2_ACCESS_KEY_ID: AKID });
  assert.equal(partial.config, null);
  assert.equal(partial.reason, "incomplete R2 configuration: R2_SECRET_ACCESS_KEY unset");
  const badAcct = loadR2Config({ R2_ACCOUNT_ID: "not-an-account", R2_ACCESS_KEY_ID: AKID, R2_SECRET_ACCESS_KEY: SECRET });
  assert.equal(badAcct.config, null);
  assert.ok(!badAcct.reason.includes(SECRET) && !badAcct.reason.includes(AKID));
  const ok = loadR2Config({ R2_ACCOUNT_ID: ` ${CFG.accountId.toUpperCase()} `, R2_ACCESS_KEY_ID: AKID, R2_SECRET_ACCESS_KEY: SECRET });
  assert.deepEqual(ok.config, CFG, "trimmed, lower-cased, bucket defaults to curb-archive");
  assert.equal(loadR2Config({ R2_ACCOUNT_ID: CFG.accountId, R2_ACCESS_KEY_ID: AKID, R2_SECRET_ACCESS_KEY: SECRET, R2_BUCKET: "other-bucket" }).config!.bucket, "other-bucket");
  assert.equal(loadR2Config({ R2_ACCOUNT_ID: CFG.accountId, R2_ACCESS_KEY_ID: AKID, R2_SECRET_ACCESS_KEY: SECRET, R2_BUCKET: "Bad_Bucket" }).config, null);
});

test("shadow mode publishes nothing even with credentials; live and standby read R2_* from the env", () => {
  const env = { R2_ACCOUNT_ID: CFG.accountId, R2_ACCESS_KEY_ID: AKID, R2_SECRET_ACCESS_KEY: SECRET };
  const shadow = publisherFromEnv("/nonexistent", "shadow", undefined, env).health();
  assert.equal(shadow.enabled, false);
  assert.match(shadow.reason!, /shadow/);
  for (const mode of ["live", "standby"]) assert.equal(publisherFromEnv("/nonexistent", mode, undefined, env).health().enabled, true, mode);
  assert.equal(publisherFromEnv("/nonexistent", "live", undefined, {}).health().enabled, false);
});

// ---------------------------------------------------------------------------------------------
// the durable queue
// ---------------------------------------------------------------------------------------------

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "curb-publish-"));
  mkdirSync(join(dataDir, "outbox"));
  const bundle = (root: string, content = `{"inputRoot":"${root}"}`) => {
    const p = join(dataDir, "outbox", `${root}.json`);
    writeFileSync(p, content);
    return p;
  };
  const queue = () => existsSync(join(dataDir, "publish-queue")) ? readdirSync(join(dataDir, "publish-queue")).sort() : [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let clock = T0;
  const mk = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof Publisher>[0]> = {}) => new Publisher({
    dataDir, config: CFG, fetch: f, now: () => clock, log: (event, fields) => logs.push({ event, fields }), ...extra,
  });
  return { dataDir, bundle, queue, logs, mk, advance: (ms: number) => { clock += ms; }, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}
const root = (n: number) => "0x" + n.toString(16).padStart(64, "0");

test("queue: a pointer is written durably at enqueue, and 412 unlinks it as a success", async () => {
  const fx = fixture();
  try {
    const { calls, f } = recorder(() => new Response(null, { status: 412 }));
    const p = fx.mk(f);
    const file = fx.bundle(root(1));
    p.enqueue(`rounds/${root(1)}.json`, file);
    assert.deepEqual(fx.queue(), [`rounds~${root(1)}.json.ptr`]);
    const ptr = JSON.parse(readFileSync(join(fx.dataDir, "publish-queue", `rounds~${root(1)}.json.ptr`), "utf8"));
    assert.deepEqual(ptr, { v: 1, key: `rounds/${root(1)}.json`, file: join("outbox", `${root(1)}.json`), enqueuedAtMs: T0 }, "relative to DATA_DIR");
    await p.drain();
    assert.equal(calls.length, 1);
    assert.deepEqual(fx.queue(), []);
    const h = p.health();
    assert.equal(h.queued, 0);
    assert.equal(h.published, 1);
    assert.equal(h.alreadyPresent, 1);
    assert.equal(h.failed, 0);
    assert.deepEqual(h.lastPublished, { key: `rounds/${root(1)}.json`, atMs: T0 });
  } finally { fx.done(); }
});

test("queue: a 500 stays queued, is not retried before its backoff, and lands on a later pass", async () => {
  const fx = fixture();
  try {
    const { calls, f } = recorder((_c, n) => new Response(n === 1 ? "<Error><Code>InternalError</Code></Error>" : null, { status: n === 1 ? 500 : 200 }));
    const p = fx.mk(f, { backoffBaseMs: 10_000 });
    p.enqueue(`marks/${root(2)}.json`, fx.bundle(root(2)));
    await p.drain();
    assert.equal(calls.length, 1);
    assert.deepEqual(fx.queue(), [`marks~${root(2)}.json.ptr`], "still queued on disk");
    let h = p.health();
    assert.equal(h.queued, 1);
    assert.equal(h.failed, 1);
    assert.match(h.lastError!.message, /HTTP 500 InternalError/);
    await p.drain();
    assert.equal(calls.length, 1, "not due yet: backoff is respected");
    fx.advance(12_001); // past 10s * the largest jitter (1.2)
    await p.drain();
    assert.equal(calls.length, 2);
    h = p.health();
    assert.equal(h.queued, 0);
    assert.equal(h.published, 1);
    assert.equal(h.alreadyPresent, 0);
    assert.deepEqual(fx.queue(), []);
  } finally { fx.done(); }
});

test("queue: a hanging PUT is abandoned at the per-attempt deadline and the item stays queued", async () => {
  const fx = fixture();
  try {
    const hang = (() => new Promise<Response>(() => { /* never settles */ })) as typeof fetch;
    const p = fx.mk(hang, { attemptTimeoutMs: 50 });
    p.enqueue(`witness/tx/${root(3)}.json`, fx.bundle(root(3)));
    const t = Date.now();
    await p.drain();
    assert.ok(Date.now() - t < 1_000, "the pass ended at the deadline, not whenever the network felt like it");
    assert.equal(p.health().queued, 1);
    assert.match(p.health().lastError!.message, /timed out after 50ms/);
    assert.equal(fx.queue().length, 1);
  } finally { fx.done(); }
});

test("queue: a pass with a deadline starts no new PUT once it has passed", async () => {
  const fx = fixture();
  try {
    const { calls, f } = recorder(() => { fx.advance(40); return new Response(null, { status: 200 }); });
    const p = fx.mk(f);
    for (let i = 10; i < 15; i++) p.enqueue(`rounds/${root(i)}.json`, fx.bundle(root(i)));
    await p.drain({ deadlineMs: T0 + 100 });
    assert.equal(calls.length, 3, "0ms, 40ms and 80ms started; 120ms did not");
    assert.equal(p.health().queued, 2);
    assert.deepEqual(calls.map((c) => c.url.slice(-71, -5)), [root(10), root(11), root(12)], "oldest first");
  } finally { fx.done(); }
});

test("queue: a restart re-reads every pointer, and the new process publishes them", async () => {
  const fx = fixture();
  try {
    const down = recorder(() => new Response(null, { status: 503 }));
    const first = fx.mk(down.f);
    first.enqueue(`rounds/${root(4)}.json`, fx.bundle(root(4)));
    first.enqueue(`witness/${root(5)}.json`, fx.bundle(root(5)));
    await first.drain();
    first.stop();
    assert.equal(fx.queue().length, 2);

    // A new process: new Publisher on the same DATA_DIR. start() loads the queue.
    const up = recorder(() => new Response(null, { status: 200 }));
    const second = fx.mk(up.f);
    writeFileSync(join(fx.dataDir, "publish-queue", "junk.ptr"), "{not json");
    second.start();
    assert.equal(second.health().queued, 2);
    await second.drain(); // the same pass its own timer would run
    second.stop();
    assert.equal(up.calls.length, 2);
    assert.deepEqual(fx.queue(), ["junk.ptr.bad"], "published pointers are gone; a corrupt one is set aside, not retried forever");
    assert.equal(second.health().published, 2);
  } finally { fx.done(); }
});

test("queue: retries are bounded; a parked item waits for the next restart", async () => {
  const fx = fixture();
  try {
    const { calls, f } = recorder(() => new Response(null, { status: 500 }));
    const p = fx.mk(f, { maxAttempts: 2, backoffBaseMs: 1 });
    p.enqueue(`rounds/${root(6)}.json`, fx.bundle(root(6)));
    await p.drain(); fx.advance(10);
    await p.drain(); fx.advance(10_000_000);
    await p.drain();
    assert.equal(calls.length, 2, "two attempts, then parked");
    assert.equal(p.health().parked, 1);
    assert.equal(fx.queue().length, 1, "still on disk for the next process");
    assert.ok(fx.logs.some((l) => l.event === "publish-parked"));
  } finally { fx.done(); }
});

test("queue: an enqueue of a key already queued is a no-op; a file gone from disk is dropped, not retried forever", async () => {
  const fx = fixture();
  try {
    const { calls, f } = recorder(() => new Response(null, { status: 200 }));
    const p = fx.mk(f);
    const file = fx.bundle(root(7));
    p.enqueue(`rounds/${root(7)}.json`, file);
    p.enqueue(`rounds/${root(7)}.json`, file);
    assert.equal(p.health().queued, 1);
    p.enqueue(`rounds/${root(8)}.json`, join(fx.dataDir, "outbox", "missing.json"));
    await p.drain();
    assert.equal(calls.length, 1);
    assert.equal(p.health().queued, 0);
    assert.match(p.health().lastError!.message, /local file unreadable, dropped/);
  } finally { fx.done(); }
});

test("disabled: enqueue does nothing and touches no disk; /healthz says why", async () => {
  const fx = fixture();
  try {
    const { calls, f } = recorder(() => new Response(null, { status: 200 }));
    const p = new Publisher({ dataDir: fx.dataDir, config: null, disabledReason: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are unset", fetch: f });
    p.start();
    p.enqueue(`rounds/${root(9)}.json`, fx.bundle(root(9)));
    await p.drain();
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(fx.dataDir, "publish-queue")), false);
    const h = p.health();
    assert.equal(h.enabled, false);
    assert.match(h.reason!, /unset/);
    assert.equal(h.queued, 0);
  } finally { fx.done(); }
});

test("enqueue never throws into a tick: a bad key or an unwritable queue is recorded, not raised", async () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.dataDir, "publish-queue"), "a file where the queue directory should be");
    const { calls, f } = recorder(() => new Response(null, { status: 200 }));
    const p = fx.mk(f);
    assert.doesNotThrow(() => p.enqueue("../../etc/passwd", "/etc/passwd"));
    assert.match(p.health().lastError!.message, /refusing to publish/);
    assert.doesNotThrow(() => p.enqueue(`rounds/${root(11)}.json`, fx.bundle(root(11))));
    assert.match(p.health().lastError!.message, /held in memory only/);
    await p.drain();
    assert.equal(calls.length, 1, "still published from memory");
    assert.equal(p.health().published, 1);
  } finally { fx.done(); }
});

test("the secret never reaches /healthz or a log line, even when an error message carries it", async () => {
  const fx = fixture();
  try {
    const leaky = (async () => { throw new Error(`connect failed with ${SECRET} and ${AKID}`); }) as typeof fetch;
    const p = fx.mk(leaky, { backoffBaseMs: 1 });
    p.enqueue(`rounds/${root(12)}.json`, fx.bundle(root(12)));
    await p.drain();
    const everything = JSON.stringify(p.health()) + JSON.stringify(fx.logs);
    assert.ok(everything.includes("[redacted]"), "the error is still reported");
    assert.ok(!everything.includes(SECRET), "secret access key leaked");
    assert.ok(!everything.includes(AKID), "access key id leaked");
  } finally { fx.done(); }
});

test("the background loop publishes on its own shortly after an enqueue", async () => {
  const fx = fixture();
  try {
    let resolveSeen: () => void;
    const seen = new Promise<void>((r) => { resolveSeen = r; });
    const { f } = recorder(() => { resolveSeen(); return new Response(null, { status: 200 }); });
    const p = new Publisher({ dataDir: fx.dataDir, config: CFG, fetch: f });
    p.start();
    p.enqueue(`rounds/${root(13)}.json`, fx.bundle(root(13)));
    await Promise.race([seen, new Promise((_, rej) => setTimeout(() => rej(new Error("loop never published")), 2_000))]);
    for (let i = 0; i < 50 && p.health().queued > 0; i++) await new Promise((r) => setTimeout(r, 10));
    p.stop();
    assert.equal(p.health().published, 1);
  } finally { fx.done(); }
});

// ---------------------------------------------------------------------------------------------
// one file, two copies; and the wiring each service depends on
// ---------------------------------------------------------------------------------------------

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("publish.ts and publish.test.ts are byte-identical in the attestor and the keeper", () => {
  assert.equal(src("attestor/src/publish.ts"), src("keeper/src/publish.ts"));
  assert.equal(src("attestor/src/publish.test.ts"), src("keeper/src/publish.test.ts"));
});

test("wiring: each service enqueues only after its fsync, and reports the queue on /healthz", () => {
  const a = src("attestor/src/main.ts");
  assert.match(a, /persistOnce\(path, JSON\.stringify\(bundle\)\);\n\s*publisher\.enqueue\(`rounds\/\$\{root\.toLowerCase\(\)\}\.json`, path\);/);
  assert.match(a, /persistOnce\(rootIndex, content\);\n(\s*publisher\.enqueue\(`witness\/[^\n]*\n){2}/);
  assert.match(a, /archive: publisher\.health\(\)/);
  assert.match(a, /publisher\.start\(\);/);
  const k = src("keeper/src/main.ts");
  assert.match(k, /persistOnce\(join\(CFG\.dataDir, "marks", `\$\{round\.root\}\.json`\), JSON\.stringify\(round\.bundle\)\);\n\s*publisher\.enqueue\(`marks\//);
  assert.match(k, /archive: publisher\.health\(\)/);
  assert.match(k, /publisher\.start\(\);/);
});
