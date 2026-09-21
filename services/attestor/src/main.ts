/**
 * curb-attestor: keeps MarketClock publishing.
 *
 * Every tick it fetches the issuer's asset and exchange bodies, pins one chain read, derives what
 * MarketClock should say, and compares that with what MarketClock currently says. It writes a round
 * when something is different, when the record is getting old, or when a corporate action has
 * activated. Every round's evidence bundle is written to disk BEFORE anything is signed, and served
 * publicly at /rounds/<inputRoot>.json.
 *
 * Modes (MODE is required to be one of these; anything else is a fatal config error):
 *   - shadow  (default when unset) build and publish bundles, send nothing.
 *   - live    host A: the writer.
 *   - standby host B: derive every tick like A, witness and sign every onchain round, and write only
 *             when the chain shows A has missed (coord.ts). Every write B makes pages.
 *
 * Safety defaults:
 *   - Even in live/standby it refuses to send unless this host's key is a registered attestor onchain.
 *   - A round that would revert is refused in simulation, never broadcast.
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, readFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, getAddress } from "ethers";

import { XStocksClient } from "./sources/xstocks.ts";
import type { Exchange } from "./sources/xstocks.ts";
import {
  pinLatest, multicallAt, rawTokenCalls, decodeRawToken, clockCalls, clockAbi, balanceCall, decodeBalance, DEFAULT_RPCS,
  rpcAny, attestedRounds, getTransaction, blockTimestamp,
} from "./sources/chain.ts";
import type { Call, TxInfo } from "./sources/chain.ts";
import { buildRound } from "./round.ts";
import type { CohortEntry, RoundKind } from "./round.ts";
import { toAttestBatchArgs } from "./derive.ts";
import type { PriorObservation } from "./derive.ts";
import { boundaries } from "./calendar.ts";
import type { ExchangeSchedule } from "./regime.ts";
import { loadOrCreateKey } from "./tx/keys.ts";
import { Sender, RevertedInSimulation, PendingUnresolved } from "./tx/sender.ts";
import { TakeoverPlanner, readChainStates } from "./coord.ts";
import type { Alarm, PlannerSnapshot } from "./coord.ts";
import { checkRound, compareObservation, signWitness, Observation, isBundleShaped } from "./witness.ts";
import type { Sample, RoundCheck } from "./witness.ts";

// ---------------------------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------------------------

const MODES = ["shadow", "live", "standby"] as const;
type Mode = (typeof MODES)[number];

/**
 * Parsed without throwing. A bad value is recorded and raised inside main(), so it goes through the
 * logged fatal path with backoff instead of crashing at import time into a hot restart loop.
 */
function loadConfig() {
  const env = (k: string, d?: string) => process.env[k] ?? d;
  const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const errors: string[] = [];
  const addr = (name: string, v: string, fallback: string) => {
    try { return getAddress(v); } catch { errors.push(`${name} is not a valid checksummed address: ${JSON.stringify(v)}`); return fallback; }
  };
  const rawMode = (env("MODE") ?? "shadow").trim();
  if (!(MODES as readonly string[]).includes(rawMode)) errors.push(`MODE must be one of ${MODES.join("|")}, got ${JSON.stringify(rawMode)}`);
  const zero = "0x0000000000000000000000000000000000000000";
  const cfg = {
    chainId: Number(env("CHAIN_ID", "196")),
    clock: addr("CLOCK", env("CLOCK", "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b")!, zero),
    rpcs: list(env("RPCS") ?? DEFAULT_RPCS.join(",")),
    dataDir: env("DATA_DIR", "/data")!,
    // An invalid MODE can never reach a writer branch: it falls back to shadow AND main() refuses to start.
    mode: ((MODES as readonly string[]).includes(rawMode) ? rawMode : "shadow") as Mode,
    hostId: env("HOST_ID", "host-a")!,
    hcUrl: env("HC_URL", "")!.trim(),
    /** healthchecks.io check that pages: sev-1 pings <url>/fail, sev-2 pings <url>/log. */
    alarmUrl: env("HC_ALARM_URL", "")!.trim().replace(/\/+$/, ""),
    port: Number(env("PORT", "8080")),
    heartbeatS: Number(env("HEARTBEAT_S", "300")),
    minGapMs: 15_000,
    lowBalanceWei: 5_000_000_000_000_000n, // 0.005 OKB
    // standby only
    primaryBundleBase: env("PRIMARY_BUNDLE_URL", "https://attestor-a-production.up.railway.app")!.replace(/\/+$/, ""),
    expectedAttestors: list(env("EXPECTED_ATTESTORS", "0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4,0x4c3eD38809FA6469871F4e0cbEa7ae7dBdA87fb8"))
      .map((a, i) => addr(`EXPECTED_ATTESTORS[${i}]`, a, zero)),
    witnessFromBlock: env("WITNESS_FROM_BLOCK") ? Number(env("WITNESS_FROM_BLOCK")) : null,
    witnessMaxBlocksPerTick: 3000,
  };
  if (!Number.isInteger(cfg.chainId)) errors.push("CHAIN_ID is not an integer");
  if (cfg.rpcs.length === 0) errors.push("RPCS is empty");
  if (!(cfg.heartbeatS > 0)) errors.push("HEARTBEAT_S must be positive");
  return { cfg, errors };
}

const { cfg: CFG, errors: CONFIG_ERRORS } = loadConfig();

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), host: CFG.hostId, event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

/** sha256 over this service's own source, so every bundle names the exact code that produced it. */
function codeDigest(): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".ts") && !f.name.endsWith(".test.ts")) files.push(p);
    }
  };
  walk(root);
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(f.slice(root.length)).update("\0").update(readFileSync(f)).update("\0");
  return "sha256:" + h.digest("hex");
}

// ---------------------------------------------------------------------------------------------
// cohort discovery: read from MarketClock itself, so the attestor can never drift from the registry
// ---------------------------------------------------------------------------------------------

const erc20 = new Interface(["function symbol() view returns (string)"]);
/** registeredCount at the last successful cohort read (the cohort itself may be smaller: see exclusions). */
let registryCountAtRead = -1;

async function readCohort(): Promise<CohortEntry[]> {
  const block = await pinLatest(CFG.rpcs);
  const countSnap = await multicallAt(block, [{ label: "count", target: CFG.clock, callData: clockAbi.encodeFunctionData("registeredCount") }], CFG.rpcs);
  const count = Number(clockAbi.decodeFunctionResult("registeredCount", countSnap.results[0].returnData)[0]);
  const countAtRead = count;

  const idxCalls: Call[] = Array.from({ length: count }, (_, i) => ({ label: `reg:${i}`, target: CFG.clock, callData: clockAbi.encodeFunctionData("registered", [i]) }));
  const idxSnap = await multicallAt(block, idxCalls, CFG.rpcs);
  const wrappers = idxSnap.results.map((r) => getAddress(clockAbi.decodeFunctionResult("registered", r.returnData)[0] as string));

  const assetSnap = await multicallAt(block, wrappers.map((w) => ({ label: `asset:${w}`, target: CFG.clock, callData: clockAbi.encodeFunctionData("assets", [w]) })), CFG.rpcs);
  const raws = assetSnap.results.map((r) => clockAbi.decodeFunctionResult("assets", r.returnData));

  const symSnap = await multicallAt(block, raws.map((a, i) => ({ label: `sym:${i}`, target: a[0] as string, callData: erc20.encodeFunctionData("symbol") })), CFG.rpcs);

  // attest() reads the raw token's nonce, so ONE registered raw with no code reverts every attestBatch. Such an
  // asset is left out of the cohort: it stays UNKNOWN (fail-closed) while every other asset keeps its record.
  const codes = await Promise.all(raws.map((a) => rpcAny<string>(CFG.rpcs, "eth_getCode", [a[0], "0x" + block.number.toString(16)])));
  const kept: number[] = [];
  for (const [i, code] of codes.entries()) {
    if (code && code !== "0x") kept.push(i);
    else log("cohort-raw-has-no-code", { wrapper: wrappers[i], raw: raws[i][0], note: "excluded; it would revert every attestBatch" });
  }

  registryCountAtRead = countAtRead;
  return kept.map((i) => {
    const wrapper = wrappers[i];
    const micHex = (raws[i][1] as string).slice(2);
    const mic = Buffer.from(micHex, "hex").toString("ascii").replace(/\0+$/, "");
    // One asset whose raw token has no readable symbol() must not stop attestation for all of them. It keeps
    // a placeholder symbol, the issuer lookup fails, and derive() closes that asset alone.
    let symbol = `unknown:${wrapper}`;
    try {
      if (symSnap.results[i].success) symbol = erc20.decodeFunctionResult("symbol", symSnap.results[i].returnData)[0] as string;
    } catch { /* keep placeholder */ }
    if (symbol.startsWith("unknown:")) log("cohort-symbol-unreadable", { wrapper, raw: raws[i][0] });
    return { wrapper, raw: getAddress(raws[i][0] as string), symbol, mic };
  });
}

// ---------------------------------------------------------------------------------------------
// health and alarms
// ---------------------------------------------------------------------------------------------

interface Health {
  lastTickOkMs: number;
  lastRound?: { root: string; kind: RoundKind; tx?: string; atMs: number };
  isAttestor: boolean;
  balanceWei?: bigint;
  address?: string;
  mode: string;
  /** standby: able to take over right now (enabled attestor with enough OKB). */
  armed?: boolean;
  witness?: {
    cursor: number;
    pending: number;
    lastOkTickMs: number;
    lagBlocks?: number;
    last?: { root: string; tx: string; attestor: string; reproduced: boolean; labelsConsistent: boolean; observation: number; atMs: number };
  };
  lastTakeover?: { root: string; tx: string; kind: RoundKind; reasons: string[]; atMs: number };
}

/** key -> when and at what severity it was last delivered. A higher severity is never suppressed by a lower one. */
const alarmSentAt = new Map<string, { at: number; sev: number }>();
let lastSev1Ms = 0;
/**
 * Whether the healthchecks alarm check may be down, so that a bare /fail would not notify. Unknown after
 * any restart, so it starts true: re-arming an up check is a no-op, while skipping it would lose a page.
 */
let alarmCheckDown = true;
const ALARM_COOLDOWN_MS = 15 * 60_000;
/** sev-1 pages not yet accepted by healthchecks. Retried every tick and persisted, so none is lost. */
const undelivered = new Map<string, Alarm>();
const undeliveredPath = () => join(CFG.dataDir, "alarms-undelivered.json");

function saveUndelivered() {
  try { persistReplace(undeliveredPath(), JSON.stringify([...undelivered.values()])); } catch { /* best effort */ }
}

function loadUndelivered() {
  try {
    if (existsSync(undeliveredPath())) for (const a of JSON.parse(readFileSync(undeliveredPath(), "utf8")) as Alarm[]) undelivered.set(a.key, a);
  } catch { /* a corrupt file must not stop the service */ }
}

async function flushUndelivered() {
  if (undelivered.size === 0) return;
  for (const a of [...undelivered.values()]) {
    alarmSentAt.delete(a.key);
    if (!(await raise(a))) break; // the endpoint is failing; the rest would time out the same way
  }
}

/**
 * Log every alarm; page at most once per key per cooldown. A page counts as sent only once healthchecks
 * accepted it. An undelivered sev-1 is queued (and persisted) and retried every tick, so a one-shot
 * alarm is never lost to a single failed delivery. Monitoring never breaks attestation.
 */
async function raise(a: Alarm, fields: Record<string, unknown> = {}): Promise<boolean> {
  const now = Date.now();
  const prev = alarmSentAt.get(a.key);
  if (prev !== undefined && now - prev.at < ALARM_COOLDOWN_MS && prev.sev <= a.sev) return true;
  if (!undelivered.has(a.key)) log("alarm", { sev: a.sev, key: a.key, message: a.message, ...fields });
  if (a.sev === 1) lastSev1Ms = now;
  for (const [k, v] of alarmSentAt) if (now - v.at > ALARM_COOLDOWN_MS) alarmSentAt.delete(k);
  if (!CFG.alarmUrl) { alarmSentAt.set(a.key, { at: now, sev: a.sev }); return true; }
  let delivered = false;
  try {
    const body = `[${CFG.hostId}] sev-${a.sev} ${a.message}`.slice(0, 9_000);
    let armed = true;
    if (a.sev === 1 && alarmCheckDown) {
      // healthchecks only notifies on a state CHANGE. Flip the check up first so this page is delivered.
      const r = await fetch(CFG.alarmUrl, { method: "POST", body: "re-arm for next page", signal: AbortSignal.timeout(5000) });
      armed = await hcAccepted(r);
    }
    if (armed) {
      const res = await fetch(`${CFG.alarmUrl}/${a.sev === 1 ? "fail" : "log"}`, { method: "POST", body, signal: AbortSignal.timeout(5000) });
      delivered = await hcAccepted(res);
      if (delivered && a.sev === 1) alarmCheckDown = true;
    }
  } catch { /* retried below */ }
  if (delivered) {
    alarmSentAt.set(a.key, { at: now, sev: a.sev });
    if (undelivered.delete(a.key)) saveUndelivered();
  } else if (a.sev === 1 && !undelivered.has(a.key)) {
    undelivered.set(a.key, a);
    saveUndelivered();
  }
  return delivered;
}

// ---------------------------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------------------------

async function main() {
  if (CONFIG_ERRORS.length) throw new Error(`invalid configuration: ${CONFIG_ERRORS.join("; ")}`);
  mkdirSync(join(CFG.dataDir, "outbox"), { recursive: true });
  loadUndelivered();
  const digest = codeDigest();

  // Shadow mode needs no key: it builds and publishes bundles and sends nothing. This lets a new host
  // start its dry run before a human has set the sealed password. Live and standby refuse to start without one.
  const password = process.env.ATTESTOR_KEY_PASSWORD;
  if (!password && CFG.mode === "shadow") {
    log("keyless-shadow", { note: "ATTESTOR_KEY_PASSWORD not set; running shadow rounds only, no key generated" });
  }
  // standby needs a key even before it is an attestor: witness statements are signed with it.
  const key = password || CFG.mode !== "shadow"
    ? await loadOrCreateKey(join(CFG.dataDir, "keys", "attestor.keystore.json"), password)
    : null;
  // The ONLY key-related output, ever: the public address, so the admin can enable it.
  if (key) log("key", { address: key.address, created: key.created });
  const address = key?.address ?? "0x0000000000000000000000000000000000000000";

  // Cohort discovery retries forever with capped backoff: a transient network failure at boot must
  // delay the first round, never kill the process and burn restart budget.
  let cohort: CohortEntry[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      cohort = await readCohort();
      break;
    } catch (e) {
      const waitMs = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
      log("cohort-retry", { attempt, waitMs, error: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  log("boot", { mode: CFG.mode, clock: CFG.clock, rpcs: CFG.rpcs, cohort, codeDigest: digest, address, expectedAttestors: CFG.mode === "standby" ? CFG.expectedAttestors : undefined });

  const sender = key && new Sender({
    wallet: key.wallet, rpcs: CFG.rpcs, chainId: CFG.chainId, dbPath: join(CFG.dataDir, "outbox.sqlite"),
    rpc: async (url, method, params) => {
      // Bounded: a hanging endpoint must fail over, not freeze the only writer for minutes.
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        // Short read timeouts: a hanging endpoint must fail over within a takeover's staleness budget.
        signal: AbortSignal.timeout(method === "eth_sendRawTransaction" ? 5_000 : 4_000),
      });
      const j = (await res.json()) as { result?: unknown; error?: { message: string; data?: string } };
      if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
      return j.result;
    },
    errorInterface: new Interface(["error NotAttestor()", "error UnknownAsset(address)", "error NotAdmin()"]),
  });

  const health: Health = { lastTickOkMs: 0, isAttestor: false, mode: CFG.mode, address };
  startHttp(health);

  const x = new XStocksClient();
  let mics = [...new Set(cohort.map((c) => c.mic))];
  let lastSentMs = 0;
  let lastShadowFingerprint = "";
  const lastSchedules = new Map<string, ExchangeSchedule>();
  let lastLivenessPingMs = 0;
  let lastCohortAttemptMs = 0;
  // A failed tick keeps the previous cadence: dropping to 30s inside a boundary window would miss the flip.
  let lastDense = false;
  // derive/3 confirms a reopen against the previous tick's observation; it is committed in every round.
  let prior: PriorObservation | null = null;
  // Starts at boot, not 0: the first clear is an hour after start, so a restart cannot acknowledge a page.
  let lastAlarmClearMs = Date.now();
  const bootMs = Date.now();

  // standby state
  const standby = CFG.mode === "standby" && key && sender
    ? await openStandby(key.wallet, address)
    : null;
  if (CFG.mode === "standby") {
    if (!CFG.alarmUrl) log("warn-no-alarm-url", { note: "HC_ALARM_URL not set: standby alarms are logged but nobody is paged" });
    health.witness = { cursor: standby?.witness.state.cursor ?? 0, pending: 0, lastOkTickMs: 0 };
  }

  for (;;) {
    const tickStart = Date.now();
    let dense: boolean = lastDense;
    try {
      x.takeLog(); // FETCH_LOG must hold only this tick's fetches, even if the previous tick was abandoned
      const schedEx = await Promise.all(mics.map((m) => x.getWithRetry(x.exchangeUrl(m))));
      const assetEx = await Promise.all(cohort.map((c) => x.getWithRetry(x.assetUrl(c.symbol))));
      const block = await pinLatest(CFG.rpcs);
      const calls: Call[] = [
        ...cohort.flatMap((c) => [...rawTokenCalls(c.raw), ...clockCalls(CFG.clock, c.wrapper)]),
        { label: "isAttestor", target: CFG.clock, callData: clockAbi.encodeFunctionData("isAttestor", [address]) },
        { label: "registeredCount", target: CFG.clock, callData: clockAbi.encodeFunctionData("registeredCount") },
        balanceCall(address),
      ];
      const chain = await multicallAt(block, calls, CFG.rpcs);
      const evaluatedAtMs = Date.now();

      // The registry can grow while this process runs. A host whose cohort is stale never attests the new
      // asset, and a standby would become its only (and permanent) writer. Re-read and start a fresh tick.
      const countRes = chain.results.find((r) => r.label === "registeredCount");
      const count = countRes?.success ? Number(clockAbi.decodeFunctionResult("registeredCount", countRes.returnData)[0]) : registryCountAtRead;
      if (count !== registryCountAtRead && Date.now() - lastCohortAttemptMs >= 60_000) {
        lastCohortAttemptMs = Date.now();
        try {
          const next = await readCohort();
          log("cohort-changed", { from: cohort.length, to: next.length, cohort: next });
          cohort = next;
          mics = [...new Set(cohort.map((c) => c.mic))];
          continue; // start a fresh tick with fetches for the new cohort
        } catch (e) {
          // Keep attesting the assets we have. A registry we cannot read must not stop the record.
          await raise({ sev: 1, key: "cohort:reread-failed", message: `registry has ${count} assets but re-reading it failed: ${e instanceof Error ? e.message : String(e)}` });
        }
      }

      // Untrusted bodies are shape-checked first. An invalid one is treated as missing, so the round, the
      // bundle and every verifier see the same "unavailable" input instead of the whole tick aborting.
      for (const [i, m] of mics.entries()) schedEx[i] = neutralizeIfInvalid(schedEx[i], validScheduleBody, `schedule:${m}`);
      for (const [i, c] of cohort.entries()) assetEx[i] = neutralizeIfInvalid(assetEx[i], validAssetBody, `asset:${c.symbol}`);
      const scheduleExchanges = new Map<string, Exchange>(mics.map((m, i) => [m, schedEx[i]]));
      for (const [m, ex] of scheduleExchanges) {
        if (!ex.body) continue;
        try {
          const s = JSON.parse(new TextDecoder().decode(ex.body));
          if (s && typeof s === "object" && s.schedule && typeof s.schedule === "object") lastSchedules.set(m, s as ExchangeSchedule);
        } catch { /* derive() treats an unparseable body as schedule-unavailable; polling keeps the last good one */ }
      }
      dense = inDenseWindow(lastSchedules, evaluatedAtMs);
      lastDense = dense;

      const isAttestorRes = chain.results.find((r) => r.label === "isAttestor")!;
      health.isAttestor = isAttestorRes.success && Boolean(clockAbi.decodeFunctionResult("isAttestor", isAttestorRes.returnData)[0]);
      // Only meaningful with a real key: keyless shadow mode queries the zero address, whose "balance"
      // is burned OKB and would look like a funded attestor in /healthz.
      health.balanceWei = key ? decodeBalance(chain.results.at(-1)!) ?? undefined : undefined;

      const roundInputs = {
        chainId: CFG.chainId, clock: CFG.clock, targetMs: evaluatedAtMs, evaluatedAtMs,
        codeDigest: digest, cohort,
        assetExchanges: new Map(cohort.map((c, i) => [c.symbol, assetEx[i]])),
        scheduleExchanges, fetchLog: x.takeLog(), chain, prior,
      };
      // Build once to learn the claims, decide, then build the round that is actually published WITH
      // its real kind. The kind is committed in the PARAMS leaf; an earlier version overwrote only the
      // uncommitted outer label, so the published kind contradicted the committed one. derive() is
      // pure, so the second build yields identical claims.
      const preview = buildRound({ ...roundInputs, kind: "heartbeat" });
      const decision = decide(cohort, chain.results, preview.claims, evaluatedAtMs, CFG.heartbeatS);
      health.lastTickOkMs = Date.now();

      if (CFG.mode === "standby") {
        if (!standby) throw new Error("standby mode without a key/sender");
        standby.samples.push({ evaluatedAtMs, claims: preview.claims });
        while (standby.samples.length > 60) standby.samples.shift();
        // Takeover planning runs FIRST and witnessing gets only the remaining time budget, so a slow
        // witness backfill can never delay a takeover. A failure in one never skips the other.
        try {
          const armed = health.isAttestor && health.balanceWei !== undefined && health.balanceWei >= CFG.lowBalanceWei;
          health.armed = armed;
          if (!armed) await raise({ sev: 2, key: "standby:not-armed", message: `host B cannot take over: isAttestor=${health.isAttestor} balanceWei=${health.balanceWei}` });
          const sent = await standbyTick(standby, {
            cohort, chainResults: chain.results, claims: preview.claims, evaluatedAtMs, lastSentMs, armed, health, sender: sender!,
            build: (kind) => buildRound({ ...roundInputs, kind }),
          });
          if (sent) lastSentMs = evaluatedAtMs;
        } catch (e) {
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          log("standby-error", { error: msg });
          await raise({ sev: 1, key: "standby:tick-failed", message: `host B takeover planning failed: ${msg}` });
        }
        try {
          await witnessTick(standby, address, lastSchedules, health, tickStart + WITNESS_BUDGET_MS);
          health.witness!.lastOkTickMs = Date.now();
        } catch (e) {
          log("witness-error", { error: e instanceof Error ? e.message : String(e) });
        }
        if (Date.now() - lastLivenessPingMs >= 60_000) {
          lastLivenessPingMs = Date.now();
          await ping(CFG.hcUrl);
        }
        // The alarm check stays down after a page until a success ping. Clear it only after an hour with
        // no sev-1: persistent conditions re-page every 15 minutes and so keep it down.
        if (Date.now() - bootMs > 10 * 60_000 && Date.now() - health.witness!.lastOkTickMs > 10 * 60_000) {
          await raise({ sev: 1, key: "witness:stalled", message: `host B has not completed a witness pass for ${Math.round((Date.now() - health.witness!.lastOkTickMs) / 60_000)} min` });
        }
        if (CFG.alarmUrl && alarmCheckDown && undelivered.size === 0 && Date.now() - lastSev1Ms > 3_600_000 && Date.now() - lastAlarmClearMs > 3_600_000) {
          lastAlarmClearMs = Date.now();
          if (await ping(CFG.alarmUrl)) alarmCheckDown = false;
        }
      } else if (CFG.mode === "shadow") {
        // In shadow nothing onchain changes, so compare against the previous shadow round instead.
        const fp = JSON.stringify(preview.claims.map((c) => [c.wrapper, c.regime, c.capUsd.toString(), c.halted]));
        const heartbeatDue = evaluatedAtMs - lastSentMs >= CFG.heartbeatS * 1000;
        if (fp !== lastShadowFingerprint || heartbeatDue) {
          const kind: RoundKind = fp !== lastShadowFingerprint && lastShadowFingerprint ? "diff" : "heartbeat";
          const round = kind === "heartbeat" ? preview : buildRound({ ...roundInputs, kind });
          persistBundle(round.root, round.bundle);
          log("shadow-round", { kind, root: round.root, dense, claims: summarize(round.claims) });
          health.lastRound = { root: round.root, kind, atMs: evaluatedAtMs };
          lastShadowFingerprint = fp;
          lastSentMs = evaluatedAtMs;
          await ping(CFG.hcUrl);
        }
      } else if (CFG.mode === "live" && decision.kind) {
        const gapOk = evaluatedAtMs - lastSentMs >= CFG.minGapMs || decision.kind === "activation";
        if (!sender || !health.isAttestor) {
          log("refuse-not-attestor", { address, wouldSend: decision.kind });
        } else if (gapOk) {
          const round = decision.kind === "heartbeat" ? preview : buildRound({ ...roundInputs, kind: decision.kind });
          persistBundle(round.root, round.bundle); // evidence first, then the signature
          const data = clockAbi.encodeFunctionData("attestBatch", toAttestBatchArgs(round.claims, round.root));
          try {
            const prepared = await sender.prepare(CFG.clock, data, { id: round.root, kind: decision.kind, targetMs: evaluatedAtMs });
            const receipt = await sender.broadcastAndWait(prepared);
            lastSentMs = evaluatedAtMs;
            health.lastRound = { root: round.root, kind: decision.kind, tx: receipt.hash, atMs: evaluatedAtMs };
            log("round", { kind: decision.kind, reasons: decision.reasons, root: round.root, tx: receipt.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, status: receipt.status, claims: summarize(round.claims) });
            await ping(CFG.hcUrl);
          } catch (e) {
            if (e instanceof RevertedInSimulation) log("refused-revert", { reason: e.reason, root: round.root });
            else if (e instanceof PendingUnresolved) log("pending-unresolved", { nonce: e.nonce, note: e.message, root: round.root });
            else log("send-error", { error: String(e), root: round.root });
          }
        }
      }

      if (key && health.balanceWei !== undefined && health.balanceWei < CFG.lowBalanceWei && health.isAttestor) {
        log("low-balance", { address, balanceWei: health.balanceWei });
      }
      // Every round this tick built used `prior`; only now does this tick's own observation replace it.
      // It carries the RAW observation, so a hold lasts exactly one tick.
      prior = preview.observed;

      // Retried after the round/takeover work, never between evaluation and send.
      await flushUndelivered();
    } catch (e) {
      log("tick-error", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
    const wait = (dense ? 5_000 : 30_000) - (Date.now() - tickStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

// ---------------------------------------------------------------------------------------------
// decision: when does MarketClock need a new round? (host A)
// ---------------------------------------------------------------------------------------------

export function decide(
  cohort: CohortEntry[],
  results: { label: string; success: boolean; returnData: string }[],
  claims: { wrapper: string; regime: number; capUsd: bigint; halted: boolean }[],
  nowMs: number,
  heartbeatS: number,
): { kind: RoundKind | null; reasons: string[] } {
  const reasons: string[] = [];
  let activation = false;
  let diff = false;
  let stale = false;

  for (const c of cohort) {
    const st = results.find((r) => r.label === `stateOf:${c.wrapper}`);
    if (!st || !st.success) { stale = true; reasons.push(`${c.symbol}:state-unreadable`); continue; }
    const s = clockAbi.decodeFunctionResult("stateOf", st.returnData)[0];
    const [regime, cap, , observedAt, storedNonce, halted] = [Number(s[0]), BigInt(s[1]), s[2], Number(s[3]), Number(s[4]), Boolean(s[5])];
    const claim = claims.find((k) => k.wrapper.toLowerCase() === c.wrapper.toLowerCase());
    const raw = decodeRawToken(c.raw, results as never);

    if (observedAt === 0) { stale = true; reasons.push(`${c.symbol}:never-attested`); }
    else if (nowMs / 1000 - observedAt >= heartbeatS) { stale = true; reasons.push(`${c.symbol}:age`); }

    // A never-attested wrapper is a heartbeat, not a "diff": there is no prior state to differ from.
    if (observedAt !== 0 && claim && (claim.regime !== regime || claim.capUsd !== cap || claim.halted !== halted)) {
      diff = true;
      reasons.push(`${c.symbol}:${regime}/${cap}->${claim.regime}/${claim.capUsd}`);
    }
    if (!raw.readFailed && raw.nonce !== null && observedAt !== 0 && Number(raw.nonce) !== storedNonce) {
      activation = true;
      reasons.push(`${c.symbol}:nonce ${storedNonce}->${raw.nonce}`);
    }
  }
  const kind: RoundKind | null = activation ? "activation" : diff ? "diff" : stale ? "heartbeat" : null;
  return { kind, reasons };
}

/** Fast polling from 7 minutes before to 3 minutes after any published boundary: the issuer's
 *  primary cutoff lands 5 minutes before a session ends, and caches can lag the flip by ~30s.
 *  A malformed schedule is skipped, never allowed to abort a tick. */
export function inDenseWindow(schedules: Map<string, ExchangeSchedule>, nowMs: number): boolean {
  for (const s of schedules.values()) {
    try {
      if (boundaries(s, nowMs - 3 * 60_000, nowMs + 7 * 60_000).length > 0) return true;
    } catch { /* skip this schedule */ }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// standby: takeover
// ---------------------------------------------------------------------------------------------

interface StandbyFile extends PlannerSnapshot {
  /** Block timestamp of this host's newest mined write; equals chain observedAt iff we wrote last. */
  ownLastWriteS: number | null;
}

interface Standby {
  /** Consecutive ticks on which a needed takeover did not land. */
  starved: number;
  wallet: Parameters<typeof signWitness>[0];
  planner: TakeoverPlanner;
  file: StandbyFile;
  witness: WitnessState;
  samples: Sample[];
}

async function openStandby(wallet: Standby["wallet"], me: string): Promise<Standby> {
  const path = join(CFG.dataDir, "standby.json");
  const file: StandbyFile = existsSync(path)
    ? { written: [], stoodDown: [], ownLastWriteS: null, ...JSON.parse(readFileSync(path, "utf8")) }
    : { written: [], stoodDown: [], ownLastWriteS: null };
  const planner = new TakeoverPlanner({ heartbeatS: CFG.heartbeatS }, file);
  const witness = await openWitnessState(CFG.witnessFromBlock, me);
  log("standby-open", { stoodDown: file.stoodDown.length, written: file.written.length, ownLastWriteS: file.ownLastWriteS });
  return { starved: 0, wallet, planner, file, witness, samples: [] };
}

function saveStandby(s: Standby) {
  s.file = { ...s.planner.snapshot(), ownLastWriteS: s.file.ownLastWriteS };
  persistReplace(join(CFG.dataDir, "standby.json"), JSON.stringify(s.file));
}

async function standbyTick(
  s: Standby,
  a: {
    cohort: CohortEntry[]; chainResults: Parameters<typeof readChainStates>[1]; claims: Parameters<TakeoverPlanner["plan"]>[0]["claims"];
    evaluatedAtMs: number; lastSentMs: number; armed: boolean; health: Health; sender: Sender;
    build: (kind: RoundKind) => ReturnType<typeof buildRound>;
  },
): Promise<boolean> {
  const states = readChainStates(a.cohort, a.chainResults);
  const newestS = Math.max(0, ...states.map((st) => st.observedAt));
  const lastWriterIsSelf = s.file.ownLastWriteS !== null && newestS === s.file.ownLastWriteS;
  const plan = s.planner.plan({
    nowMs: a.evaluatedAtMs, states, claims: a.claims, lastWriterIsSelf,
    primaryCoverage: s.witness.state.latestNonSelf?.wrappers ?? null,
  });
  saveStandby(s);
  // Alarm I/O must not sit between evaluation and a takeover send: page after deciding and sending.
  try {
    return await executePlan(s, a, plan, newestS);
  } finally {
    for (const al of plan.alarms) await raise(al);
  }
}

async function executePlan(
  s: Standby, a: Parameters<typeof standbyTick>[1], plan: ReturnType<TakeoverPlanner["plan"]>, newestS: number,
): Promise<boolean> {
  if (!plan.send || !plan.kind) return false;

  if (!a.armed) {
    await raise({ sev: 1, key: "standby:takeover-needed-not-armed", message: `takeover needed (${plan.reasons.join("; ")}) but host B is not an enabled, funded attestor` });
    return false;
  }
  if (a.evaluatedAtMs - a.lastSentMs < CFG.minGapMs) return false;

  // Last look, at the latest block: a write that landed after our pinned read, or a primary transaction
  // already in flight, means the primary is alive. Stand down for this tick.
  const look = await lastLook(a.cohort, s.witness.me);
  if (look.newestS > newestS || look.primaryInFlight.length) {
    log("takeover-aborted", { newestS, freshNewestS: look.newestS, primaryInFlight: look.primaryInFlight, reasons: plan.reasons });
    return false;
  }

  const kind = plan.kind;
  // Our round's inputs age while we look and prepare. Never stamp a stale evaluation with a fresh block.
  if (Date.now() - a.evaluatedAtMs > TAKEOVER_MAX_AGE_MS) {
    log("takeover-dropped-stale", { stage: "before-prepare", ageMs: Date.now() - a.evaluatedAtMs });
    await noteStarved(s, plan, "inputs aged before prepare");
    return false;
  }
  const round = a.build(kind);
  persistBundle(round.root, round.bundle);
  const data = clockAbi.encodeFunctionData("attestBatch", toAttestBatchArgs(round.claims, round.root));
  try {
    const prepared = await a.sender.prepare(CFG.clock, data, { id: round.root, kind, targetMs: a.evaluatedAtMs });
    if (Date.now() - a.evaluatedAtMs > TAKEOVER_MAX_AGE_MS) {
      await a.sender.discard(prepared.id); // release its nonce, or the next takeover would leave a gap
      log("takeover-dropped-stale", { stage: "after-prepare", root: round.root, ageMs: Date.now() - a.evaluatedAtMs });
      await noteStarved(s, plan, `preparing took ${Date.now() - a.evaluatedAtMs}ms (RPC slow)`);
      return false;
    }
    const receipt = await a.sender.broadcastAndWait(prepared);
    const ts = await blockTimestamp(CFG.rpcs, receipt.blockNumber).catch(() => null);
    // On failure keep the previous value; the witness attributes this write by sender address next tick.
    if (ts !== null) s.file.ownLastWriteS = Math.max(s.file.ownLastWriteS ?? 0, ts);
    s.witness.state.ownTxHashes = [...s.witness.state.ownTxHashes, receipt.hash.toLowerCase()].slice(-500);
    s.planner.markWrote(plan.coveredKeys, Date.now());
    s.starved = 0;
    saveStandby(s);
    s.witness.save();
    a.health.lastRound = { root: round.root, kind, tx: receipt.hash, atMs: a.evaluatedAtMs };
    a.health.lastTakeover = { root: round.root, tx: receipt.hash, kind, reasons: plan.reasons, atMs: a.evaluatedAtMs };
    log("takeover-round", { kind, reasons: plan.reasons, root: round.root, tx: receipt.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, status: receipt.status, claims: summarize(round.claims) });
    await raise({ sev: 1, key: `standby:wrote:${receipt.hash}`, message: `host B wrote a takeover round (${plan.reasons.join("; ")}) tx ${receipt.hash}` });
    return true;
  } catch (e) {
    if (e instanceof PendingUnresolved) {
      log("takeover-pending-unresolved", { nonce: e.nonce, note: e.message });
      await noteStarved(s, plan, e.message);
      return false;
    }
    const msg = e instanceof RevertedInSimulation ? `refused in simulation: ${e.reason}` : String(e);
    log("takeover-send-error", { error: msg, root: round.root });
    await raise({ sev: 1, key: "standby:takeover-failed", message: `takeover round failed: ${msg}` });
    return false;
  }
}

/** A takeover's inputs may be this old when it is signed; beyond it the tick re-evaluates instead. */
const TAKEOVER_MAX_AGE_MS = 45_000;

/** A takeover the planner wants but that keeps not landing is a failover that is failing: page it. */
async function noteStarved(s: Standby, plan: ReturnType<TakeoverPlanner["plan"]>, why: string) {
  s.starved++;
  if (s.starved >= 2) {
    await raise({ sev: 1, key: "standby:takeover-starved", message: `host B has needed to take over for ${s.starved} ticks but cannot land a round (${why}); reasons: ${plan.reasons.join("; ")}` });
  }
}

/** Fresh read at the latest block: newest observedAt, and any other attestor with a transaction in flight. */
async function lastLook(cohort: CohortEntry[], me: string): Promise<{ newestS: number; primaryInFlight: string[] }> {
  const block = await pinLatest(CFG.rpcs);
  const snap = await multicallAt(block, cohort.map((c) => ({ label: `stateOf:${c.wrapper}`, target: CFG.clock, callData: clockAbi.encodeFunctionData("stateOf", [c.wrapper]) })), CFG.rpcs);
  let newestS = 0;
  for (const r of snap.results) {
    if (!r.success) throw new Error(`stateOf unreadable on the pre-send check (${r.label})`);
    newestS = Math.max(newestS, Number(clockAbi.decodeFunctionResult("stateOf", r.returnData)[0][3]));
  }
  const primaryInFlight: string[] = [];
  const others = CFG.expectedAttestors.filter((x) => x.toLowerCase() !== me.toLowerCase());
  await Promise.all(others.map(async (other) => {
    // pending and latest from the SAME endpoint, raced across endpoints, so one slow node cannot stall us
    // and two nodes at different heights cannot fake an in-flight transaction.
    const pair = await Promise.any(CFG.rpcs.map((url) => Promise.all([
      rpcAny<string>([url], "eth_getTransactionCount", [other, "pending"], 4_000),
      rpcAny<string>([url], "eth_getTransactionCount", [other, "latest"], 4_000),
    ])));
    if (BigInt(pair[0]) > BigInt(pair[1])) primaryInFlight.push(other);
  }));
  return { newestS, primaryInFlight };
}

// ---------------------------------------------------------------------------------------------
// standby: witnessing every onchain round
// ---------------------------------------------------------------------------------------------

interface PendingRound {
  txHash: string;
  blockNumber: number;
  inputRoot: string;
  wrappers: string[];
  firstSeenMs: number;
  attempts: number;
  tx?: TxInfo;
  writtenAtS?: number;
  alarmedSev?: number;
  /** Retry backoff for rounds whose bundle is not yet available, so they cannot block the queue. */
  nextTryMs?: number;
}

interface WitnessStateFile {
  cursor: number;
  lowWater: number;
  /** Rounds at or above this block page when they fail; below it is historical backfill (log only). */
  liveFromBlock: number;
  pending: PendingRound[];
  ownTxHashes: string[];
  /** The newest write not made by this host: its block and the wrappers it covered. */
  latestNonSelf?: { blockNumber: number; txHash: string; wrappers: string[] };
}

/** Rescan this many blocks behind the cursor every tick, so a node that answered late cannot hide a write. */
const LOG_OVERLAP_BLOCKS = 60;
/** Stay behind the head by more than pinLatest's accepted lag, so a lagging node is never asked for the tip. */
const LOG_SAFETY_BLOCKS = 10;
const RECENT_S = 2 * 3600;
/** Witnessing may use the tick until this long after it started; the rest waits for the next tick. */
const WITNESS_BUDGET_MS = 20_000;
/** While catching up, scan at most this many blocks per tick (10 log queries). */
const WITNESS_SCAN_BLOCKS = 1000;
const BUNDLE_SEV2_MS = 5 * 60_000;
const BUNDLE_SEV1_MS = 30 * 60_000;
const BUNDLE_GIVE_UP_MS = 24 * 3_600_000;

class WitnessState {
  readonly dir: string;
  readonly state: WitnessStateFile;
  readonly me: string;

  constructor(dir: string, state: WitnessStateFile, me: string) {
    this.dir = dir;
    this.state = state;
    this.me = me;
  }

  save() {
    persistReplace(join(this.dir, "state.json"), JSON.stringify(this.state));
  }

  isOwn(txHash: string) {
    return this.state.ownTxHashes.includes(txHash.toLowerCase());
  }
}

async function openWitnessState(fromBlock: number | null, me: string): Promise<WitnessState> {
  const dir = join(CFG.dataDir, "witness");
  mkdirSync(join(dir, "tx"), { recursive: true });
  let head = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      head = Number(BigInt(await rpcAny<string>(CFG.rpcs, "eth_blockNumber", [])));
      break;
    } catch (e) {
      const waitMs = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
      log("witness-open-retry", { attempt, waitMs, error: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  const path = join(dir, "state.json");
  const start = fromBlock ?? head - 300;
  const state: WitnessStateFile = existsSync(path)
    ? { lowWater: start, ownTxHashes: [], pending: [], ...JSON.parse(readFileSync(path, "utf8")) }
    : { cursor: start, lowWater: start, liveFromBlock: head - RECENT_S, pending: [], ownTxHashes: [] };
  state.liveFromBlock ??= Math.min(state.cursor, head - RECENT_S);
  log("witness-open", { cursor: state.cursor, pending: state.pending.length, head });
  return new WitnessState(dir, state, me);
}

async function fetchBundle(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = await res.json();
    return isBundleShaped(body) ? body : null;
  } catch {
    return null;
  }
}

async function witnessTick(s: Standby, me: string, schedules: Map<string, ExchangeSchedule>, health: Health, deadlineMs: number) {
  const ws = s.witness;
  // Scanning and processing are independent: a failed log scan still lets queued rounds be witnessed. But a
  // tick whose scan failed is not a healthy tick, or a permanently broken scan would never page.
  let scanOk = false;
  try {
    const head = Number(BigInt(await rpcAny<string>(CFG.rpcs, "eth_blockNumber", [])));
    const safeHead = head - LOG_SAFETY_BLOCKS;
    const from = Math.max(ws.state.lowWater, ws.state.cursor - LOG_OVERLAP_BLOCKS);
    if (from > safeHead) {
      scanOk = true;
    } else {
      // Always scan at least one chunk; the time budget only shrinks how far.
      const span = Date.now() < deadlineMs ? Math.min(CFG.witnessMaxBlocksPerTick, WITNESS_SCAN_BLOCKS + LOG_OVERLAP_BLOCKS) : LOG_OVERLAP_BLOCKS + 100;
      const to = Math.min(safeHead, from + span - 1);
      const rounds = await attestedRounds(CFG.rpcs, CFG.clock, from, to); // throws rather than skip unindexed blocks
      for (const r of rounds) {
        const hash = r.txHash.toLowerCase();
        if (existsSync(join(ws.dir, "tx", `${hash}.json`)) || ws.state.pending.some((p) => p.txHash === hash)) continue;
        ws.state.pending.push({ txHash: hash, blockNumber: r.blockNumber, inputRoot: r.inputRoot.toLowerCase(), wrappers: r.wrappers, firstSeenMs: Date.now(), attempts: 0 });
      }
      ws.state.cursor = Math.max(ws.state.cursor, to + 1);
      ws.save();
      scanOk = true;
    }
    health.witness!.lagBlocks = Math.max(0, safeHead - ws.state.cursor);
  } catch (e) {
    log("witness-scan-error", { error: e instanceof Error ? e.message : String(e) });
  }

  ws.state.pending.sort((p, q) => p.blockNumber - q.blockNumber);
  const now = Date.now();
  const due = ws.state.pending.filter((p) => (p.nextTryMs ?? 0) <= now).slice(0, 20);
  let completed = 0;
  let attempted = 0;
  for (const p of due) {
    if (Date.now() >= deadlineMs && attempted > 0) break; // always make progress on at least one item
    attempted++;
    // One bad round must never stop the queue behind it.
    try {
      await witnessOne(s, p, me, schedules, health);
      completed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      p.nextTryMs = Date.now() + Math.min(10 * 60_000, 30_000 * 2 ** Math.min(p.attempts, 5));
      log("witness-item-error", { tx: p.txHash, root: p.inputRoot, attempts: p.attempts, error: msg });
      if (Date.now() - p.firstSeenMs > BUNDLE_SEV1_MS && p.alarmedSev !== 1) {
        if (await raise({ sev: 1, key: `witness:stuck:${p.txHash}`, message: `cannot witness tx ${p.txHash} for 30 minutes: ${msg}` })) p.alarmedSev = 1;
      }
    }
  }
  ws.save();
  health.witness!.cursor = ws.state.cursor;
  health.witness!.pending = ws.state.pending.length;
  // Unhealthy only when rounds were attempted and every attempt failed; an empty or backed-off queue is fine.
  if (!scanOk) throw new Error("witness log scan failed this tick");
  if (attempted > 0 && completed === 0) throw new Error(`all ${attempted} witness attempts failed this tick`);
}

async function witnessOne(s: Standby, p: PendingRound, me: string, schedules: Map<string, ExchangeSchedule>, health: Health) {
  const ws = s.witness;
  p.attempts++;
  if (!p.tx) {
    const tx = await getTransaction(CFG.rpcs, p.txHash);
    if (!tx) return;
    p.tx = tx;
  }
  if (p.writtenAtS === undefined) p.writtenAtS = await blockTimestamp(CFG.rpcs, p.tx.blockNumber);
  const tx = p.tx;
  const writtenAtS = p.writtenAtS;
  // Decided by height, not by age at processing time: a late bundle or a long outage must not cost a page.
  const recent = p.blockNumber >= ws.state.liveFromBlock;
  const isSelf = tx.from.toLowerCase() === me.toLowerCase();

  // Attribute by sender address, not by which code path returned: a takeover that timed out and mined later,
  // or one sent before a restart, is still ours.
  if (isSelf) {
    if (!ws.isOwn(p.txHash)) {
      ws.state.ownTxHashes = [...ws.state.ownTxHashes, p.txHash].slice(-500);
      // Not recorded by the send path, so its page never went out. Every host B write must page.
      if (recent) await raise({ sev: 1, key: `standby:wrote:${tx.hash}`, message: `host B write discovered by the witness (mined after a timeout or restart): tx ${tx.hash}` });
    }
    if ((s.file.ownLastWriteS ?? 0) < writtenAtS) {
      s.file.ownLastWriteS = writtenAtS;
      saveStandby(s);
    }
  } else if (!ws.state.latestNonSelf || tx.blockNumber >= ws.state.latestNonSelf.blockNumber) {
    ws.state.latestNonSelf = { blockNumber: tx.blockNumber, txHash: p.txHash, wrappers: p.wrappers };
  }

  if (!isSelf && !CFG.expectedAttestors.some((x) => x.toLowerCase() === tx.from.toLowerCase())) {
    const alarm: Alarm = { sev: 1, key: `witness:unexpected-attestor:${tx.from}`, message: `MarketClock write from unexpected attestor ${tx.from} (tx ${tx.hash}). Possible key compromise: revoke with setAttestor(${tx.from}, false)` };
    if (recent) await raise(alarm); else log("witness-backfill-note", { note: alarm.message });
  }

  // A root may appear in only one write. A second transaction with a known root is a replay or a resend.
  const rootIndex = join(ws.dir, `${p.inputRoot}.json`);
  if (existsSync(rootIndex)) {
    const prior = JSON.parse(readFileSync(rootIndex, "utf8")) as { message?: { txHash?: string } };
    if (prior.message?.txHash && prior.message.txHash !== p.txHash) {
      const alarm: Alarm = { sev: 1, key: `witness:root-reused:${p.txHash}`, message: `tx ${p.txHash} from ${tx.from} reuses inputRoot ${p.inputRoot} already written by ${prior.message.txHash}` };
      if (recent) await raise(alarm); else log("witness-backfill-note", { note: alarm.message });
    }
  }

  const local = join(CFG.dataDir, "outbox", `${p.inputRoot}.json`);
  const bundle = isSelf && existsSync(local)
    ? JSON.parse(readFileSync(local, "utf8"))
    : await fetchBundle(`${CFG.primaryBundleBase}/rounds/${p.inputRoot}.json`);

  let check: RoundCheck;
  if (!bundle) {
    const waited = Date.now() - p.firstSeenMs;
    if (recent && waited > BUNDLE_SEV1_MS && p.alarmedSev !== 1) {
      if (await raise({ sev: 1, key: `witness:bundle-unavailable:sev1:${p.inputRoot}`, message: `evidence bundle for round ${p.inputRoot} (tx ${tx.hash}) unavailable for 30 minutes` })) p.alarmedSev = 1;
    } else if (recent && waited > BUNDLE_SEV2_MS && !p.alarmedSev) {
      if (await raise({ sev: 2, key: `witness:bundle-unavailable:${p.inputRoot}`, message: `evidence bundle for round ${p.inputRoot} (tx ${tx.hash}) unavailable for 5 minutes` })) p.alarmedSev = 2;
    }
    if (waited < BUNDLE_GIVE_UP_MS) {
      p.nextTryMs = Date.now() + Math.min(10 * 60_000, 15_000 * 2 ** Math.min(p.attempts, 6));
      return;
    }
    check = { reproduced: false, labelsConsistent: false, method: "", evaluatedAtMs: null, failures: [`bundle unavailable for 24h (${p.attempts} attempts)`], labelFailures: [], warnings: [], claims: [] };
  } else {
    check = checkRound(bundle, tx, CFG.chainId, CFG.clock, writtenAtS);
  }

  let obs: ReturnType<typeof compareObservation> = { observation: Observation.NO_SAMPLE, sampleAtMs: null, detail: [] };
  let nearBoundary = false;
  try {
    obs = compareObservation(check.claims, check.evaluatedAtMs, s.samples);
    nearBoundary = check.evaluatedAtMs !== null && Number.isFinite(check.evaluatedAtMs) && inDenseWindow(schedules, check.evaluatedAtMs);
  } catch { /* observation is advisory */ }

  const doc = await signWitness(s.wallet, {
    chainId: CFG.chainId, clock: CFG.clock, tx, writtenAtS, inputRoot: p.inputRoot, check, observation: obs,
    checkedAtS: Math.floor(Date.now() / 1000), hostId: CFG.hostId,
  });
  const content = JSON.stringify(doc);
  persistOnce(join(ws.dir, "tx", `${p.txHash}.json`), content);
  persistOnce(rootIndex, content);
  ws.state.pending = ws.state.pending.filter((q) => q.txHash !== p.txHash);

  health.witness!.last = {
    root: p.inputRoot, tx: tx.hash, attestor: tx.from, reproduced: check.reproduced,
    labelsConsistent: check.labelsConsistent, observation: obs.observation, atMs: Date.now(),
  };
  log("witness", {
    root: p.inputRoot, tx: tx.hash, block: tx.blockNumber, attestor: tx.from, method: check.method,
    reproduced: check.reproduced, labelsConsistent: check.labelsConsistent, observation: obs.observation, nearBoundary,
    failures: check.failures, labelFailures: check.labelFailures, warnings: check.warnings, observationDetail: obs.detail, recent,
  });
  if (!recent) return;
  if (!check.reproduced) {
    await raise({ sev: 1, key: `witness:not-reproduced:${p.txHash}`, message: `round ${p.inputRoot} (tx ${tx.hash}, attestor ${tx.from}) does NOT reproduce: ${check.failures.slice(0, 3).join("; ")}` });
  } else if (!check.labelsConsistent) {
    await raise({ sev: 2, key: `witness:labels:${p.txHash}`, message: `round ${p.inputRoot} reproduces but its uncommitted labels disagree: ${check.labelFailures.join("; ")}` });
  }
  if (check.warnings.length) {
    await raise({ sev: 2, key: `witness:late:${p.txHash}`, message: `round ${p.inputRoot} reproduces with warnings: ${check.warnings.join("; ")}` });
  }
  if (obs.observation === Observation.DISAGREE && !nearBoundary) {
    await raise({ sev: 2, key: `witness:observation:${p.txHash}`, message: `independent reading disagrees with round ${p.inputRoot} away from any boundary: ${obs.detail.join("; ")}` });
  }
}

// ---------------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------------

function summarize(claims: { symbol: string; regime: number; capUsd: bigint; nextAt: number; disagreement: boolean; degraded: string[] }[]) {
  return claims.map((c) => `${c.symbol}:${c.regime}/${c.capUsd}${c.disagreement ? "!" : ""}${c.degraded.length ? "~" + c.degraded.join("|") : ""}`).join(" ");
}

/** Durable, atomic: fsync the file, rename into place, fsync the directory. */
function persistReplace(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  const fd = openSync(tmp, "r+");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), "r");
  fsyncSync(dfd);
  closeSync(dfd);
}

/** Write-once variant: evidence and witness statements are never rewritten. */
function persistOnce(path: string, content: string) {
  if (existsSync(path)) return;
  persistReplace(path, content);
}

function persistBundle(root: string, bundle: unknown) {
  persistOnce(join(CFG.dataDir, "outbox", `${root}.json`), JSON.stringify(bundle));
}

async function ping(url: string): Promise<boolean> {
  if (!url) return false;
  try { return await hcAccepted(await fetch(url, { signal: AbortSignal.timeout(5000) })); } catch { return false; /* never let monitoring break attestation */ }
}

/**
 * healthchecks.io answers 200 even when it IGNORES a ping: the body is "OK (rate limited)" or "OK (not found)".
 * Only a plain "OK" means the ping changed anything.
 */
async function hcAccepted(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  try { return (await res.text()).trim() === "OK"; } catch { return false; }
}

/** Shape check for GET /exchanges/{mic}: exactly what regime.ts and calendar.ts dereference. */
export function validScheduleBody(v: unknown): boolean {
  try {
    const s = (v as { schedule?: Record<string, unknown> })?.schedule;
    if (!s || typeof s !== "object" || typeof s.timezone !== "string") return false;
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone }); // throws RangeError on an unknown zone
    if (!Array.isArray(s.sessions ?? []) || !Array.isArray(s.holidays ?? [])) return false;
    const hhmm = /^\d{2}:\d{2}$/;
    for (const x of (s.sessions ?? []) as Record<string, unknown>[]) {
      if (!x || typeof x.open !== "string" || typeof x.close !== "string" || !hhmm.test(x.open) || !hhmm.test(x.close) || !Array.isArray(x.days)) return false;
    }
    for (const h of (s.holidays ?? []) as Record<string, unknown>[]) {
      if (!h || typeof h.startsAt !== "string" || typeof h.endsAt !== "string" || Number.isNaN(Date.parse(h.startsAt)) || Number.isNaN(Date.parse(h.endsAt))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const PERIODS = new Set(["market", "extended", "overnight", "closed"]);

/** Shape check for GET /assets/{symbol}: the trading object derive() reads. */
export function validAssetBody(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const t = ((v as { trading?: unknown }).trading ?? v) as Record<string, unknown>;
  if (!t || typeof t !== "object") return false;
  if (t.currentPeriod !== null && t.currentPeriod !== undefined && !(typeof t.currentPeriod === "string" && PERIODS.has(t.currentPeriod))) return false;
  if (t.limitsPerPeriod !== undefined && (typeof t.limitsPerPeriod !== "object" || t.limitsPerPeriod === null)) return false;
  if (t.nextChangeAt !== null && t.nextChangeAt !== undefined && (typeof t.nextChangeAt !== "string" || Number.isNaN(Date.parse(t.nextChangeAt)))) return false;
  // Both reach calldata: a non-boolean halt flag diffs every tick, and a cap beyond uint128 fails encoding.
  if (typeof t.isTradingHalted !== "boolean") return false;
  const limits = t.limitsPerPeriod as Record<string, { maxOrderFiatValue?: unknown }> | undefined;
  const cap = typeof t.currentPeriod === "string" ? limits?.[t.currentPeriod]?.maxOrderFiatValue : undefined;
  if (cap !== undefined && !(typeof cap === "number" && Number.isFinite(cap) && cap >= 0 && cap < 1e30)) return false;
  return true;
}

function neutralizeIfInvalid(ex: Exchange, valid: (v: unknown) => boolean, what: string): Exchange {
  if (!ex.body) return ex;
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(ex.body)); } catch { parsed = undefined; }
  if (parsed !== undefined && valid(parsed)) return ex;
  log("body-invalid", { what, url: ex.url, bytes: ex.bytes });
  // Only the body is withheld. `ok` and the fetch log stay as fetched, so round.ts and the offline verifier
  // take the identical "unparseable" path and the round still re-derives exactly.
  return { ...ex, body: null };
}

function startHttp(health: Health) {
  createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/healthz") {
      const tickFresh = Date.now() - health.lastTickOkMs < 120_000;
      // standby: a witness loop that has stopped succeeding is unhealthy even if ticks run.
      const witnessFresh = !health.witness || Date.now() - health.witness.lastOkTickMs < 10 * 60_000;
      const ok = tickFresh && witnessFresh;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, ...health, balanceWei: health.balanceWei?.toString() }));
      return;
    }
    const m = url.match(/^\/(rounds|witness|witness\/tx)\/(0x[0-9a-f]{64})\.json$/);
    if (m) {
      const dir = m[1] === "rounds" ? "outbox" : m[1] === "witness" ? "witness" : join("witness", "tx");
      const p = join(CFG.dataDir, dir, `${m[2]}.json`);
      if (existsSync(p)) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable" });
        res.end(readFileSync(p));
        return;
      }
    }
    res.writeHead(404).end();
  }).listen(CFG.port, () => log("http", { port: CFG.port }));
}

// import.meta.main is true only for the entry module (also through symlinks), so tests can import
// decide() and inDenseWindow() without starting the service.
if (import.meta.main) {
  main().catch(async (e) => {
    log("fatal", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    // Back off before exiting so a missing sealed variable does not become a hot restart loop.
    await new Promise((r) => setTimeout(r, 60_000));
    process.exit(1);
  });
}
