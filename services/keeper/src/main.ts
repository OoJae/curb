/**
 * curb-keeper: publishes a mark for every closure, before the market reopens.
 *
 * The attestor records WHEN a primary market is shut. This records WHAT the asset is worth while it
 * is, and then lets the Scorecard grade that against the reopen. The only thing that makes such a
 * claim worth anything is that it was committed first and cannot be revised, so the order is strict:
 * gather the evidence, fsync the bundle, then sign. A row whose evidence was never published is a
 * number we are asking people to believe.
 *
 * Three authorities, deliberately separated:
 *   - MarketClock decides open vs shut. It is what `Scorecard.commit` and `settle` enforce, so the
 *     keeper cannot hold an opinion the contract would reject.
 *   - The venue's published schedule decides when capacity returns (see reopen.ts). MarketClock
 *     cannot: a closure spans several of its boundaries.
 *   - The pool decides price. `settle(id)` takes no price argument at all; nobody, Curb included,
 *     supplies the number the mark is graded against.
 *
 * MODE=shadow (the default) does everything except send.
 */
import { createServer } from "node:http";
import {
  mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync,
  renameSync, openSync, fsyncSync, closeSync, rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes } from "ethers";

import { pinLatest, multicallAt, clockAbi, balanceCall, decodeBalance, DEFAULT_RPCS } from "./sources/chain.ts";
import type { Call, MulticallSnapshot } from "./sources/chain.ts";
import { readPools, scanSwaps, swapsInRange, vwap } from "./sources/pools.ts";
import type { PoolSpec, SwapRow } from "./sources/pools.ts";
import { XStocksClient } from "./sources/xstocks.ts";
import { MARK_METHODS, MARK_METHOD_VERSION, hasSignal } from "./mark.ts";
import { buildMarkRound } from "./markRound.ts";
import { gatherSignal, DEFAULT_RELAY_BASE } from "./sources/signalFetch.ts";
import type { GatheredSignal } from "./sources/signalFetch.ts";
import type { VenueEvidence } from "./markRound.ts";
import { nextCapReturnMs } from "./reopen.ts";
import type { PeriodLimits } from "./reopen.ts";
import type { ExchangeSchedule, TradingObject } from "./regime.ts";
import { loadOrCreateKey } from "./tx/keys.ts";
import { Sender, RevertedInSimulation, PendingUnresolved, normalizeDataSuffix, builderCodes } from "./tx/sender.ts";
import { publisherFromEnv } from "./publish.ts";

const MODES = ["shadow", "live"];
const ZERO = "0x0000000000000000000000000000000000000000";

const scorecardAbi = new Interface([
  "function commit((address wrapper,uint64 committedAt,uint64 committedBlock,uint64 settleAfter,uint128 mark,uint32 bandBps,bytes32 inputRoot,bytes32 methodDigest,uint128 lastPrint,uint128 closingVwap,uint128 staleOracle) c) returns (bytes32)",
  "function settle(bytes32 id)",
  "function priceSources(address) view returns (address pool, bool equityIsToken0, uint32 twapWindow, uint8 equityDecimals, uint8 stableDecimals)",
  "function isKeeper(address) view returns (bool)",
  "function settlements(bytes32) view returns (uint64 settledAt,uint64 settledBlock,uint128 reopenPrint,uint32 curbErrorBps,uint32 lastPrintErrorBps,uint32 closingVwapErrorBps,uint32 staleOracleErrorBps,uint8 source,bool settled)",
  "error NotKeeper()", "error BadMark()", "error MarketStillOpen(address)", "error MarketStillShut(address)",
  "error ClosureExists(bytes32)", "error UnknownClosure(bytes32)", "error AlreadySettled(bytes32)",
  "error TooEarly(bytes32,uint64)", "error TooLate(bytes32,uint64)", "error NoPriceSource(address)",
  "error PriceDeviates(int24,int24)", "error PriceUnreadable(address)",
]);
const capAbi = new Interface(["function primaryCapNow(address) view returns (uint128)"]);
const erc20 = new Interface(["function symbol() view returns (string)"]);

// ---------------------------------------------------------------------------------------------
// configuration: collected, never thrown from at import time
// ---------------------------------------------------------------------------------------------

/** Exported so tests can check parsing; calling it has no side effects beyond reading process.env. */
export function loadConfig() {
  const env = (k: string, d?: string) => process.env[k] ?? d;
  const errors: string[] = [];
  const addr = (name: string, v: string) => {
    if (v.trim() === "") return ZERO;   // unset, which each caller decides the meaning of
    try { return getAddress(v.trim()); } catch { errors.push(`${name} is not an address: ${JSON.stringify(v)}`); return ZERO; }
  };
  const num = (name: string, v: string, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) { errors.push(`${name} must be in [${min},${max}], got ${JSON.stringify(v)}`); return min; }
    return n;
  };
  const suffix = (name: string, v: string) => {
    try { return normalizeDataSuffix(v.trim()); } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); return ""; }
  };
  const onOff = (name: string, v: string) => {
    const x = v.trim().toLowerCase();
    if (["on", "1", "true"].includes(x)) return true;
    if (["off", "0", "false"].includes(x)) return false;
    errors.push(`${name} must be on|off, got ${JSON.stringify(v)}`);
    return false;
  };
  const baseUrl = (name: string, v: string) => {
    const x = v.trim().replace(/\/+$/, "");
    if (x === "") return "";
    if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(x)) { errors.push(`${name} is not a base URL: ${JSON.stringify(v)}`); return ""; }
    return x;
  };
  const rawMode = (env("MODE") ?? "shadow").trim();
  if (!MODES.includes(rawMode)) errors.push(`MODE must be one of ${MODES.join("|")}, got ${JSON.stringify(rawMode)}`);

  const cfg = {
    chainId: num("CHAIN_ID", env("CHAIN_ID", "196")!, 1, 2 ** 31),
    clock: addr("CLOCK", env("CLOCK", "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b")!),
    scorecard: addr("SCORECARD", env("SCORECARD", ZERO)!),
    rpcs: (env("RPCS") ?? DEFAULT_RPCS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    dataDir: env("DATA_DIR", "/data")!,
    mode: MODES.includes(rawMode) ? rawMode : "shadow",
    hostId: env("HOST_ID", "keeper")!,
    hcUrl: env("HC_URL", "")!.trim(),
    alarmUrl: env("HC_ALARM_URL", "")!.trim().replace(/\/+$/, ""),
    port: num("PORT", env("PORT", "8080")!, 1, 65535),
    tickMs: num("TICK_MS", env("TICK_MS", "30000")!, 5_000, 300_000),
    /** Commit this long before capacity is expected back: late enough to see the closure, early
     *  enough that the transaction certainly lands while the contract still accepts it. */
    commitLeadS: num("COMMIT_LEAD_S", env("COMMIT_LEAD_S", "600")!, 120, 7200),
    /** Never commit inside this much of the reopen. */
    commitFloorS: num("COMMIT_FLOOR_S", env("COMMIT_FLOOR_S", "120")!, 30, 3600),
    /**
     * Closures shorter than this are not marked.
     *
     * The issuer ends EVERY period 300s early (D-4), so a US name whose overnight and extended caps
     * are both non-zero shows a five-minute capacity gap at each session boundary -- 09:25, 15:55,
     * 19:55, 03:55 ET. Those are real zero-capacity windows, but nothing happens in them: the pool
     * barely trades, the mark equals the last print by construction, and `skill()` counts strict
     * wins, so each one would be a guaranteed tie. Committing them would pad the record with rows
     * that cannot say anything, which is the opposite of what it is for. The meaningful closures --
     * the 65-minute Hong Kong lunch recess, the 17-hour overnight, weekends, holidays -- are all
     * far above this floor.
     */
    minClosureS: num("MIN_CLOSURE_S", env("MIN_CLOSURE_S", "1800")!, 0, 86_400),
    /** Must equal Scorecard.SETTLE_DELAY. */
    settleDelayS: num("SETTLE_DELAY_S", env("SETTLE_DELAY_S", "300")!, 0, 86_400),
    /** MarketClock.MAX_ATTESTATION_AGE: past this the clock reads UNKNOWN and we are blind. */
    maxAttestationAgeS: num("MAX_ATTESTATION_AGE_S", env("MAX_ATTESTATION_AGE_S", "1800")!, 60, 86_400),
    venueRefreshMs: num("VENUE_REFRESH_MS", env("VENUE_REFRESH_MS", "600000")!, 60_000, 3_600_000),
    lowBalanceWei: BigInt(env("LOW_BALANCE_WEI", "3000000000000000")!),
    /**
     * ERC-8021 attribution: the X Layer Builder Code suffix the Sender appends to every commit and settle
     * this keeper signs. Empty, the default, is off. It is applied inside the Sender and nowhere else:
     * CommitPlan.data stays the bare `commit` encoding, frozen and reused byte for byte, and the closure
     * id comes from the arguments -- so turning attribution on mid-closure cannot change a row's id or
     * turn a retry into a second row. Checked here too, so a typo is fatal at boot, not on the first send.
     */
    dataSuffix: suffix("DATA_SUFFIX", env("DATA_SUFFIX", "")!),
    /**
     * mark/2's cross-market signal (mark.ts). SIGNAL=off fetches nothing, so every row takes the no-signal
     * path -- still mark/2, numerically mark/1 -- which is the kill switch that needs no code change.
     */
    signal: onOff("SIGNAL", env("SIGNAL", "on")!),
    /** curb-asp's byte-exact Binance relay. Binance refuses US hosts, and this keeper runs on one. Empty skips it. */
    signalRelayBase: baseUrl("SIGNAL_RELAY_BASE", env("SIGNAL_RELAY_BASE", DEFAULT_RELAY_BASE)!),
    /** Fall back to fapi.binance.com directly when the relay fails. Useless from the US, right anywhere else. */
    signalBinanceDirect: onOff("SIGNAL_BINANCE_DIRECT", env("SIGNAL_BINANCE_DIRECT", "on")!),
    /** Per request. A leg costs at most two (relay, then direct), all legs run in parallel. */
    signalFetchMs: num("SIGNAL_FETCH_MS", env("SIGNAL_FETCH_MS", "4000")!, 500, 20_000),
  };
  // Unset is legitimate exactly once: the first boot on a new host, whose only job is to generate
  // the key that the Scorecard is then deployed with. Live mode always needs it.
  if (cfg.scorecard === ZERO && cfg.mode === "live") errors.push("SCORECARD is required in live mode");
  if (cfg.commitFloorS >= cfg.commitLeadS) errors.push("COMMIT_FLOOR_S must be below COMMIT_LEAD_S");
  return { cfg, errors };
}

const { cfg: CFG, errors: CONFIG_ERRORS } = loadConfig();

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify(
    { t: new Date().toISOString(), host: CFG.hostId, event, ...fields },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  ));

/** Second copy of every mark bundle, in the locked R2 archive (publish.ts). Off in shadow mode and while R2_* is unset. */
const publisher = publisherFromEnv(CFG.dataDir, CFG.mode, log);

/** Hash of every non-test source file, committed in each bundle so a row names the code that made it. */
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
// state, persisted so a restart never loses a committed row
// ---------------------------------------------------------------------------------------------

interface Committed {
  id: string;
  root: string;
  settleAfterS: number;
  markE18: string;
  bandBps: number;
  /** True once the row is on chain (or proved to be, by the contract refusing a duplicate). */
  onChain: boolean;
  txHash: string;
  atMs: number;
}

/**
 * The frozen commit, built once and reused byte for byte on every retry.
 *
 * The closure id is `keccak256(wrapper, settleAfter, inputRoot)` and the root covers `evaluatedAtMs`,
 * so rebuilding the round after a failed send would produce a DIFFERENT id -- and a commit that
 * actually landed but whose receipt we lost would become a second row for the same closure, double
 * counted by `skill()` forever. Freezing it means a retry either lands the same row or is refused by
 * the contract with ClosureExists, which is itself the proof that the first one mined.
 */
interface CommitPlan {
  root: string;
  id: string;
  settleAfterS: number;
  markE18: string;
  bandBps: number;
  /** The bare `commit` encoding. Attribution (DATA_SUFFIX) is added by the Sender per send, never stored here. */
  data: string;
  attempts: number;
}

interface Closure {
  wrapper: string;
  symbol: string;
  cutAtMs: number;
  cutBlock: number;
  midAtCutE18: string;
  /** Last pool mid seen while capacity was still on; null when we booted mid-closure. */
  preCutMidE18: string | null;
  /** Did we see this asset OPEN before it shut? If not, we have no last print and no mark. */
  witnessedCut: boolean;
  /** Predicted from the venue schedule, refreshed until commit and frozen by it. */
  reopenMs: number | null;
  swapCount: number;
  plan?: CommitPlan;
  committed?: Committed;
  settleAttempts?: number;
  skipLogged?: boolean;
  settled?: { txHash: string; atMs: number };
}

interface State {
  lastScannedBlock: number;
  lastPrint: Record<string, { priceE18: string; atMs: number }>;
  /** One per wrapper, while its capacity is at zero. */
  open: Record<string, Closure>;
  /** Committed rows still owing a settle. */
  pending: Closure[];
}

const statePath = () => join(CFG.dataDir, "keeper-state.json");
const swapsPath = (c: Closure) => join(CFG.dataDir, "closures", `${c.wrapper.toLowerCase()}-${c.cutBlock}.jsonl`);

function loadState(): State {
  const empty: State = { lastScannedBlock: 0, lastPrint: {}, open: {}, pending: [] };
  try {
    if (existsSync(statePath())) return { ...empty, ...JSON.parse(readFileSync(statePath(), "utf8")) };
  } catch (e) { log("state-unreadable", { error: String(e) }); }
  return empty;
}

function persistReplace(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), "r"); fsyncSync(dfd); closeSync(dfd);
}

/** Write-once: a published bundle is the thing a row is checked against, so it is never rewritten. */
function persistOnce(path: string, content: string) {
  if (existsSync(path)) return;
  persistReplace(path, content);
}

const readSwapFile = (c: Closure): SwapRow[] => {
  const p = swapsPath(c);
  if (!existsSync(p)) return [];
  const out: SwapRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      out.push({ blockNumber: r.b, logIndex: r.i, equityAbs: BigInt(r.q), priceE18: BigInt(r.p) });
    } catch { /* a torn final line costs one swap, never the file */ }
  }
  return out;
};

const appendSwaps = (c: Closure, rows: SwapRow[]) => {
  if (rows.length === 0) return;
  appendFileSync(swapsPath(c), rows.map((r) =>
    JSON.stringify({ b: r.blockNumber, i: r.logIndex, q: r.equityAbs.toString(), p: r.priceE18.toString() })).join("\n") + "\n");
};

// ---------------------------------------------------------------------------------------------
// health and alarms
// ---------------------------------------------------------------------------------------------

interface Health {
  bootMs: number;
  ticks: number;
  lastTickOkMs: number;
  mode: string;
  address: string;
  isKeeper: boolean;
  armed: boolean;
  balanceWei?: string;
  assets: number;
  open: number;
  pending: number;
  committedTotal: number;
  settledTotal: number;
  lastCommit?: Record<string, unknown>;
  lastSettle?: Record<string, unknown>;
  /** ERC-8021 Builder Code attribution. The suffix is in every transaction's calldata, so it is public. */
  attribution: { on: boolean; dataSuffix: string | null; codes: string[] };
}

/**
 * What /healthz says about attribution: what the live Sender appends, not what DATA_SUFFIX says.
 *
 * They differ whenever the keeper runs without a key (shadow with no password set). There is then no
 * Sender, so no commit or settle is signed and nothing is attributed however DATA_SUFFIX is set -- and a
 * health page reading `on: true` there would be taken as proof that attribution is live when no
 * transaction carries it. The codes are decoded so a person can read the Builder Code itself; 34 bytes of
 * hex hide a mistyped one. (The boot log's `attribution` line reports the configuration, before the key is
 * loaded; this is the one to trust.)
 */
export function attributionHealth(sender: { readonly dataSuffix: string } | null): Health["attribution"] {
  const dataSuffix = sender?.dataSuffix || null;
  return { on: dataSuffix !== null, dataSuffix, codes: builderCodes(dataSuffix ?? "") };
}

const alarmSentAt = new Map<string, { at: number; sev: number }>();
let alarmCheckDown = false;
const ALARM_COOLDOWN_MS = 15 * 60_000;

async function hcAccepted(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  // healthchecks.io answers "OK (rate limited)" with a 200; only an exact OK was actually recorded.
  try { return (await res.text()).trim() === "OK"; } catch { return false; }
}

async function ping(url: string): Promise<boolean> {
  if (!url) return false;
  try { return await hcAccepted(await fetch(url, { signal: AbortSignal.timeout(5_000) })); } catch { return false; }
}

async function raise(sev: 1 | 2, key: string, message: string): Promise<void> {
  const now = Date.now();
  const prev = alarmSentAt.get(key);
  if (prev !== undefined && now - prev.at < ALARM_COOLDOWN_MS && prev.sev <= sev) return;
  log("alarm", { sev, key, message });
  if (!CFG.alarmUrl) { alarmSentAt.set(key, { at: now, sev }); return; }
  try {
    // A check left failing never pages again, so re-arm before a new sev-1.
    if (sev === 1 && alarmCheckDown) {
      if (!(await hcAccepted(await fetch(CFG.alarmUrl, { method: "POST", body: "re-arm", signal: AbortSignal.timeout(5_000) })))) return;
      alarmCheckDown = false;
    }
    const res = await fetch(`${CFG.alarmUrl}/${sev === 1 ? "fail" : "log"}`, {
      method: "POST", body: `[${CFG.hostId}] sev-${sev} ${message}`.slice(0, 9_000), signal: AbortSignal.timeout(5_000),
    });
    if (await hcAccepted(res)) {
      alarmSentAt.set(key, { at: now, sev });
      if (sev === 1) alarmCheckDown = true;
    }
  } catch { /* monitoring must never break the keeper; the next tick retries */ }
}

// ---------------------------------------------------------------------------------------------
// the cohort: what MarketClock knows AND Scorecard can settle
// ---------------------------------------------------------------------------------------------

interface Asset extends PoolSpec {
  /** Raw (rebasing) token; its symbol is the issuer's key, e.g. wTCENTx -> TCENTx. */
  raw: string;
  rawSymbol: string;
}

interface Venue {
  mic: string;
  assetUrl: string;
  assetBodyHash: string;
  exchangeUrl: string;
  exchangeBodyHash: string;
  limits: PeriodLimits;
  sched: ExchangeSchedule;
  atMs: number;
}

async function readCohort(): Promise<Asset[]> {
  if (CFG.scorecard === ZERO) return [];   // bootstrap boot: no contract to read price sources from
  const block = await pinLatest(CFG.rpcs);
  const countSnap = await multicallAt(block, [{ label: "count", target: CFG.clock, callData: clockAbi.encodeFunctionData("registeredCount") }], CFG.rpcs);
  if (!countSnap.results[0].success) throw new Error("registeredCount reverted");
  const count = Number(clockAbi.decodeFunctionResult("registeredCount", countSnap.results[0].returnData)[0]);
  if (count === 0) return [];

  const idx = await multicallAt(block, Array.from({ length: count }, (_, i) => ({
    label: `reg:${i}`, target: CFG.clock, callData: clockAbi.encodeFunctionData("registered", [i]),
  })), CFG.rpcs);
  const wrappers = idx.results
    .filter((r) => r.success)
    .map((r) => getAddress(String(clockAbi.decodeFunctionResult("registered", r.returnData)[0])));

  const meta = await multicallAt(block, [
    ...wrappers.map((w) => ({ label: `src:${w}`, target: CFG.scorecard, callData: scorecardAbi.encodeFunctionData("priceSources", [w]) })),
    ...wrappers.map((w) => ({ label: `asset:${w}`, target: CFG.clock, callData: clockAbi.encodeFunctionData("assets", [w]) })),
    ...wrappers.map((w) => ({ label: `sym:${w}`, target: w, callData: erc20.encodeFunctionData("symbol") })),
  ], CFG.rpcs);
  const at = (label: string) => meta.results.find((r) => r.label === label);

  const out: Asset[] = [];
  for (const w of wrappers) {
    const src = at(`src:${w}`);
    if (!src?.success) continue;
    const d = scorecardAbi.decodeFunctionResult("priceSources", src.returnData);
    const pool = getAddress(String(d[0]));
    // No registered price source means no settleable row. We refuse to mark it rather than commit
    // something the contract could never grade.
    if (pool === ZERO) continue;

    const a = at(`asset:${w}`);
    if (!a?.success) continue;
    const raw = getAddress(String(clockAbi.decodeFunctionResult("assets", a.returnData)[0]));

    let symbol = w;
    const sym = at(`sym:${w}`);
    try { if (sym?.success) symbol = String(erc20.decodeFunctionResult("symbol", sym.returnData)[0]); } catch { /* keep the address */ }

    out.push({
      wrapper: w, symbol, pool, raw,
      rawSymbol: symbol.replace(/^w/, ""),
      equityIsToken0: Boolean(d[1]),
      equityDecimals: Number(d[3]),
      stableDecimals: Number(d[4]),
    });
  }
  return out;
}

/** The issuer's per-period caps and the venue schedule: the two inputs the reopen is derived from. */
async function readVenue(client: XStocksClient, a: Asset): Promise<Venue | null> {
  const assetUrl = client.assetUrl(a.rawSymbol);
  const assetRes = await client.getWithRetry(assetUrl, 4_000);
  if (!assetRes.ok || !assetRes.body) return null;
  const trading = (JSON.parse(new TextDecoder().decode(assetRes.body)) as { trading?: TradingObject }).trading;
  const mic = trading?.exchange?.mic;
  if (!trading || !mic) return null;

  const exchangeUrl = client.exchangeUrl(mic);
  const exRes = await client.getWithRetry(exchangeUrl, 4_000);
  if (!exRes.ok || !exRes.body) return null;
  const sched = JSON.parse(new TextDecoder().decode(exRes.body)) as ExchangeSchedule;
  if (!sched?.schedule?.sessions?.length) return null;

  return {
    mic, assetUrl, exchangeUrl,
    assetBodyHash: assetRes.bodyHash!, exchangeBodyHash: exRes.bodyHash!,
    limits: (trading.limitsPerPeriod ?? {}) as PeriodLimits,
    sched, atMs: Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------

/** A decode that treats an empty or undecodable return as absent rather than fatal. */
function decodeOr<T>(fallback: T, decode: () => T, r?: { success: boolean; returnData: string }): T {
  if (!r?.success || !r.returnData || r.returnData === "0x") return fallback;
  try { return decode(); } catch { return fallback; }
}

/** The id Scorecard computes, so a settle needs no event lookup and a duplicate is caught before sending. */
export function closureId(wrapper: string, settleAfterS: number, inputRoot: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint64", "bytes32"], [getAddress(wrapper), settleAfterS, inputRoot]));
}

const methodDigest = () => keccak256(toUtf8Bytes(MARK_METHOD_VERSION));

async function main() {
  if (CONFIG_ERRORS.length) throw new Error(`invalid configuration: ${CONFIG_ERRORS.join("; ")}`);
  // Logged before anything can fail, so every boot says whether its transactions will be attributed.
  log("attribution", CFG.dataSuffix
    ? { on: true, dataSuffix: CFG.dataSuffix, codes: builderCodes(CFG.dataSuffix), note: "ERC-8021 Builder Code suffix appended to every commit and settle this keeper signs" }
    : { on: false, note: "DATA_SUFFIX unset: transactions carry no Builder Code" });
  mkdirSync(join(CFG.dataDir, "marks"), { recursive: true });
  mkdirSync(join(CFG.dataDir, "closures"), { recursive: true });
  publisher.start();
  const digest = codeDigest();

  const password = process.env.KEEPER_KEY_PASSWORD ?? process.env.ATTESTOR_KEY_PASSWORD;
  const key = password || CFG.mode === "live"
    ? await loadOrCreateKey(join(CFG.dataDir, "keys", "keeper.keystore.json"), password)
    : null;
  if (key) log("key", { address: key.address, created: key.created });
  const address = key?.address ?? ZERO;

  let assets: Asset[] = [];
  for (let attempt = 1; ; attempt++) {
    try { assets = await readCohort(); break; } catch (e) {
      const waitMs = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
      log("cohort-retry", { attempt, waitMs, error: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  log("boot", { mode: CFG.mode, clock: CFG.clock, scorecard: CFG.scorecard, codeDigest: digest, address, assets });
  if (assets.length === 0) {
    await raise(CFG.scorecard === ZERO ? 2 : 1, "keeper:no-priceable-assets",
      CFG.scorecard === ZERO
        ? "bootstrap boot: no SCORECARD configured yet, so nothing is marked; the key exists and the address is on /healthz"
        : "no registered asset has a Scorecard price source; nothing can be marked");
  }

  const sender = key ? new Sender({
    wallet: key.wallet, rpcs: CFG.rpcs, chainId: CFG.chainId, dbPath: join(CFG.dataDir, "keeper-outbox.sqlite"),
    errorInterface: scorecardAbi,
    dataSuffix: CFG.dataSuffix,
    rpc: async (url, method, params) => {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(method === "eth_sendRawTransaction" ? 5_000 : 4_000),
      });
      const j = (await res.json()) as { result?: unknown; error?: { message: string; data?: string } };
      if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
      return j.result;
    },
  }) : null;

  const client = new XStocksClient();
  const venues = new Map<string, Venue>();
  const state = loadState();
  const health: Health = {
    bootMs: Date.now(), ticks: 0, lastTickOkMs: Date.now(), mode: CFG.mode, address, isKeeper: false, armed: false,
    assets: assets.length, open: 0, pending: state.pending.length, committedTotal: 0, settledTotal: 0,
    attribution: attributionHealth(sender),
  };
  startHttp(health);

  for (;;) {
    const tickStart = Date.now();
    try {
      await tick(state, assets, venues, client, sender, health, digest);
      health.lastTickOkMs = Date.now();
      health.ticks++;
      await ping(CFG.hcUrl);
    } catch (e) {
      log("tick-error", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      if (Date.now() - health.lastTickOkMs > 10 * 60_000) {
        await raise(1, "keeper:ticks-failing", `no successful tick for ${Math.round((Date.now() - health.lastTickOkMs) / 60_000)} minutes`);
      }
    }
    const wait = CFG.tickMs - (Date.now() - tickStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

async function tick(
  state: State, assets: Asset[], venues: Map<string, Venue>, client: XStocksClient,
  sender: Sender | null, health: Health, digest: string,
) {
  const block = await pinLatest(CFG.rpcs);
  const calls: Call[] = [
    ...assets.flatMap((a) => [
      { label: `cap:${a.wrapper}`, target: CFG.clock, callData: capAbi.encodeFunctionData("primaryCapNow", [a.wrapper]) },
      { label: `state:${a.wrapper}`, target: CFG.clock, callData: clockAbi.encodeFunctionData("stateOf", [a.wrapper]) },
    ]),
    { label: "isKeeper", target: CFG.scorecard, callData: scorecardAbi.encodeFunctionData("isKeeper", [health.address]) },
    balanceCall(health.address),
  ];
  const chain = await multicallAt(block, calls, CFG.rpcs);
  const { snapshot: poolSnap, reads } = assets.length > 0
    ? await readPools(block, assets, CFG.rpcs)
    : { snapshot: { block, results: [] }, reads: new Map() };
  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);

  // Multicall3 reports success for a call to an address with no code, so "success" is not enough:
  // an empty return must read as "not a keeper", never as a decode crash that kills the tick.
  const ik = chain.results.find((r) => r.label === "isKeeper");
  health.isKeeper = decodeOr(false, () => Boolean(scorecardAbi.decodeFunctionResult("isKeeper", ik!.returnData)[0]), ik);
  const bal = decodeBalance(chain.results[chain.results.length - 1]);
  health.balanceWei = bal === null ? undefined : bal.toString();
  health.armed = CFG.mode === "live" && health.isKeeper && (bal ?? 0n) >= CFG.lowBalanceWei;

  // Refresh the issuer/venue inputs on their own slow clock; they change on the order of days.
  for (const a of assets) {
    const have = venues.get(a.wrapper);
    if (have && nowMs - have.atMs < CFG.venueRefreshMs) continue;
    try {
      const v = await readVenue(client, a);
      if (v) venues.set(a.wrapper, v);
      else if (!have) log("venue-unavailable", { symbol: a.symbol });
    } catch (e) { log("venue-error", { symbol: a.symbol, error: String(e) }); }
  }
  client.takeLog();

  // Swaps for every pool since the last scan, in one paged query. Trailing the head by a few blocks
  // keeps a reorg from writing a swap into a closure file that the chain later drops.
  const to = block.number - 5;
  const from = state.lastScannedBlock === 0 ? Math.max(0, to - 200) : state.lastScannedBlock + 1;
  let swapsByPool = new Map<string, SwapRow[]>();
  // An empty address list is not "no pools" to every node -- some read it as "no filter" and return
  // every Swap on the chain. Never ask.
  if (to >= from && assets.length > 0) {
    swapsByPool = await scanSwaps(CFG.rpcs, assets, from, to);
    state.lastScannedBlock = to;
  }

  for (const a of assets) {
    const w = a.wrapper;
    const read = reads.get(w);
    const capRes = chain.results.find((r) => r.label === `cap:${w}`);
    const stRes = chain.results.find((r) => r.label === `state:${w}`);
    if (!read || read.priceE18 <= 0n || !capRes?.success || !stRes?.success) continue;

    const st = decodeOr(null, () => clockAbi.decodeFunctionResult("stateOf", stRes.returnData)[0] as unknown[], stRes);
    if (st === null) continue;
    const observedAt = Number(st[3]);
    // A stale attestation reads capacity as zero for the conservative reason, but it is "we stopped
    // looking", not "the market shut". Committing a closure off it would invent one. Hold everything.
    if (observedAt === 0 || nowS - observedAt > CFG.maxAttestationAgeS) {
      await raise(1, "keeper:clock-stale", `MarketClock is stale for ${a.symbol} (observedAt=${observedAt}); holding all closure decisions`);
      continue;
    }
    const capRead = decodeOr(null, () => BigInt(capAbi.decodeFunctionResult("primaryCapNow", capRes.returnData)[0]), capRes);
    if (capRead === null) continue;
    const cap = capRead;
    const open = state.open[w];

    if (cap > 0n) {
      state.lastPrint[w] = { priceE18: read.priceE18.toString(), atMs: nowMs };
      if (open?.committed) { state.pending.push(open); delete state.open[w]; log("closure-closed", { symbol: a.symbol, id: open.committed.id }); }
      else if (open) {
        log("closure-abandoned", { symbol: a.symbol, cutBlock: open.cutBlock, reason: "capacity returned before the commit point" });
        try { rmSync(swapsPath(open), { force: true }); } catch { /* best effort */ }
        delete state.open[w];
      }
      continue;
    }

    const venue = venues.get(w);
    const reopenMs = venue ? nextCapReturnMs(venue.limits, venue.sched, nowMs) : null;

    if (!open) {
      const last = state.lastPrint[w];
      const witnessed = Boolean(last && nowMs - last.atMs < 5 * CFG.tickMs);
      const fresh: Closure = {
        wrapper: w, symbol: a.symbol, cutAtMs: nowMs, cutBlock: block.number,
        midAtCutE18: read.priceE18.toString(),
        preCutMidE18: witnessed ? last!.priceE18 : null,
        witnessedCut: witnessed,
        reopenMs, swapCount: 0,
      };
      state.open[w] = fresh;
      try { rmSync(swapsPath(fresh), { force: true }); } catch { /* a re-cut at the same block is the same closure */ }
      log("closure-open", {
        symbol: a.symbol, cutBlock: block.number, midAtCut: read.priceE18,
        reopen: reopenMs === null ? null : new Date(reopenMs).toISOString(),
        witnessedCut: witnessed,
      });
      continue;
    }

    const rows = swapsByPool.get(getAddress(a.pool)) ?? [];
    const during = rows.filter((r) => r.blockNumber >= open.cutBlock);
    if (!open.committed) {
      appendSwaps(open, during);
      open.swapCount += during.length;
      if (reopenMs !== null) open.reopenMs = reopenMs;   // frozen by the commit
    }
  }

  await commitPass(state, assets, venues, poolSnap, reads, sender, health, digest, nowMs);
  await settlePass(state, sender, health, nowS, nowMs);

  health.open = Object.keys(state.open).length;
  health.pending = state.pending.length;
  persistReplace(statePath(), JSON.stringify(state));

  if (CFG.mode === "live" && !health.armed) {
    await raise(2, "keeper:not-armed", `cannot commit: isKeeper=${health.isKeeper} balanceWei=${health.balanceWei}`);
  }
}

async function commitPass(
  state: State, assets: Asset[], venues: Map<string, Venue>, poolSnap: MulticallSnapshot,
  reads: Map<string, { priceE18: bigint }>, sender: Sender | null, health: Health, digest: string, nowMs: number,
) {
  for (const w of Object.keys(state.open)) {
    const c = state.open[w];
    if (c.committed) continue;
    const a = assets.find((x) => x.wrapper === w);
    const venue = venues.get(w);
    const read = reads.get(w);
    if (!a || !read) continue;

    // A closure whose start we did not see has no last print: the "mid at the cut" would really be
    // a mid from somewhere in the middle of the closure, and the row would quietly claim a baseline
    // it never observed. This is the normal state for the first closure after a restart, and the
    // right answer is one fewer row rather than one unfalsifiable row.
    if (!c.witnessedCut) {
      if (!c.skipLogged) { c.skipLogged = true; log("closure-unwitnessed", { symbol: c.symbol, cutBlock: c.cutBlock, reason: "shut before this keeper started; no last print to mark from" }); }
      continue;
    }

    if (c.reopenMs === null || !venue) {
      // No schedule means no defensible settleAfter. Better no row than an unfalsifiable one.
      if (nowMs - c.cutAtMs > 30 * 60_000) {
        await raise(1, `keeper:no-reopen:${c.symbol}`, `${c.symbol} has been shut for ${Math.round((nowMs - c.cutAtMs) / 60_000)}m with no venue schedule; no row can be committed`);
      }
      continue;
    }
    if (c.reopenMs - c.cutAtMs < CFG.minClosureS * 1000) {
      if (!c.skipLogged) {
        c.skipLogged = true;
        log("closure-too-short", { symbol: c.symbol, seconds: Math.round((c.reopenMs - c.cutAtMs) / 1000), floor: CFG.minClosureS });
      }
      continue;
    }
    const toReopenS = Math.floor((c.reopenMs - nowMs) / 1000);
    if (toReopenS > CFG.commitLeadS) continue;
    if (toReopenS < CFG.commitFloorS) {
      // We arrived too late to land a transaction that the contract would still accept.
      await raise(1, `keeper:commit-missed:${c.symbol}:${c.cutBlock}`, `missed the commit window for ${c.symbol}: ${toReopenS}s to reopen`);
      continue;
    }

    if (!c.plan) c.plan = await buildPlan(c, a, venue, assets, poolSnap, read.priceE18, digest, nowMs);
    if (!c.plan) continue;
    const plan = c.plan;

    if (!health.armed || !sender) {
      log("shadow-mark", {
        symbol: c.symbol, id: plan.id, root: plan.root,
        settleAfter: new Date(plan.settleAfterS * 1000).toISOString(),
        mark: plan.markE18, band: plan.bandBps,
      });
      c.committed = { id: plan.id, root: plan.root, settleAfterS: plan.settleAfterS, markE18: plan.markE18, bandBps: plan.bandBps, onChain: false, txHash: "", atMs: nowMs };
      continue;
    }

    plan.attempts++;
    try {
      const receipt = await sender.broadcastAndWait(
        await sender.prepare(CFG.scorecard, plan.data, { id: `commit:${plan.root}:${plan.attempts}`, kind: "commit", targetMs: nowMs }));
      c.committed = { id: plan.id, root: plan.root, settleAfterS: plan.settleAfterS, markE18: plan.markE18, bandBps: plan.bandBps, onChain: true, txHash: receipt.hash, atMs: nowMs };
      health.committedTotal++;
      health.lastCommit = { symbol: c.symbol, id: plan.id, root: plan.root, mark: plan.markE18, tx: receipt.hash, block: receipt.blockNumber };
      log("committed", {
        symbol: c.symbol, id: plan.id, root: plan.root,
        settleAfter: new Date(plan.settleAfterS * 1000).toISOString(),
        mark: plan.markE18, band: plan.bandBps, tx: receipt.hash, block: receipt.blockNumber,
      });
    } catch (e) {
      const reason = e instanceof RevertedInSimulation ? e.reason : "";
      if (/ClosureExists/i.test(reason)) {
        // The contract refusing a duplicate is proof our earlier attempt mined.
        c.committed = { id: plan.id, root: plan.root, settleAfterS: plan.settleAfterS, markE18: plan.markE18, bandBps: plan.bandBps, onChain: true, txHash: "", atMs: nowMs };
        log("commit-already-onchain", { symbol: c.symbol, id: plan.id, root: plan.root });
        continue;
      }
      const msg = e instanceof RevertedInSimulation ? `refused: ${reason}`
        : e instanceof PendingUnresolved ? e.message
        : e instanceof Error ? e.message : String(e);
      log("commit-failed", { symbol: c.symbol, root: plan.root, attempt: plan.attempts, error: msg });
      await raise(1, `keeper:commit-failed:${c.symbol}:${c.cutBlock}`, `commit for ${c.symbol} failed: ${msg}`);
    }
  }
}

/** Build the round, publish its evidence, and freeze the exact calldata. Null when unmarkable. */
async function buildPlan(
  c: Closure, a: Asset, venue: Venue, assets: Asset[], poolSnap: MulticallSnapshot,
  midNowE18: bigint, digest: string, nowMs: number,
): Promise<CommitPlan | undefined> {
    const settleAfterS = Math.floor(c.reopenMs! / 1000);
    const method = MARK_METHODS[MARK_METHOD_VERSION];
    const closingFrom = Math.max(0, c.cutBlock - Math.ceil(method.closingVwapWindowMs / 1000));
    const closingSwaps = await swapsInRange(CFG.rpcs, a, closingFrom, c.cutBlock);
    const closureSwaps = readSwapFile(c);

    // The last print, taken from the chain where possible: the pool mid after the final swap at or
    // before the cut block IS the last print, and it re-derives from the committed evidence. Only if
    // nothing traded in the closing window do we fall back to an observation -- and in that case the
    // mid genuinely has not moved, so the mid at the cut is the same number.
    const lastPrintE18 = closingSwaps.length > 0
      ? closingSwaps[closingSwaps.length - 1].priceE18
      : BigInt(c.preCutMidE18 ?? c.midAtCutE18);

    const venueEvidence: VenueEvidence = {
      mic: venue.mic,
      assetUrl: venue.assetUrl, assetBodyHash: venue.assetBodyHash,
      exchangeUrl: venue.exchangeUrl, exchangeBodyHash: venue.exchangeBodyHash,
      cutAtMs: c.cutAtMs,
      limitsPerPeriod: venue.limits,
      schedule: venue.sched.schedule,
      predictedReopenMs: settleAfterS * 1000,
    };

    // mark/2's cross-market evidence, fetched now (the commit time) with a per-request timeout. It can
    // never block the commit: a failed or slow fetch leaves its leg absent, the row falls back to the
    // no-signal path with a flag, and every attempt is committed in the bundle's FETCH_LOG.
    let signal: GatheredSignal | null = null;
    if (hasSignal(MARK_METHOD_VERSION)) {
      try {
        signal = await gatherSignal(
          { symbol: c.symbol, cutAtMs: c.cutAtMs, commitAtMs: nowMs, settleAfterS },
          method.minSignalClosureS!,
          { enabled: CFG.signal, relayBase: CFG.signalRelayBase, binanceDirect: CFG.signalBinanceDirect, perFetchMs: CFG.signalFetchMs },
        );
      } catch (e) {
        log("signal-error", { symbol: c.symbol, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const round = buildMarkRound({
      chainId: CFG.chainId, clock: CFG.clock, scorecard: CFG.scorecard,
      evaluatedAtMs: nowMs, codeDigest: digest, specs: assets, chain: poolSnap,
      closures: [{
        wrapper: c.wrapper, symbol: c.symbol, cutAtMs: c.cutAtMs, cutBlock: c.cutBlock, settleAfterS,
        input: {
          wrapper: c.wrapper, symbol: c.symbol,
          lastPrintE18,
          midAtCutE18: BigInt(c.midAtCutE18),
          midNowE18,
          closingVwapE18: vwap(closingSwaps),
          swapsDuringClosure: closureSwaps.length,
        },
        closingSwaps, closureSwaps, venue: venueEvidence,
        ...(signal ? { signal: { exchanges: signal.exchanges, attempts: signal.attempts } } : {}),
      }],
    });

    const built = round.marks[0];
    if (!built) { log("mark-skipped", { symbol: c.symbol, reason: "not enough evidence for a mark" }); return undefined; }
    // Evidence first, always: a row whose bundle was not on disk before the signature is a number
    // we would be asking people to take on trust.
    persistOnce(join(CFG.dataDir, "marks", `${round.root}.json`), JSON.stringify(round.bundle));
    publisher.enqueue(`marks/${round.root.toLowerCase()}.json`, join(CFG.dataDir, "marks", `${round.root}.json`));
    log("mark-built", {
      symbol: c.symbol, root: round.root, mark: built.mark.markE18, band: built.mark.bandBps,
      drift: built.mark.driftBps, swaps: closureSwaps.length, flags: built.mark.flags,
      shutForS: Math.round((nowMs - c.cutAtMs) / 1000),
      method: MARK_METHOD_VERSION,
      ...(built.mark.signal ? {
        signal: {
          applied: built.mark.signal.applied, appliedBps: built.mark.signal.appliedBps, rBps: built.mark.signal.rBps,
          perpBps: built.mark.signal.perpBps, adrBps: built.mark.signal.adrBps, missing: built.mark.signal.missing,
          fetched: signal?.exchanges.map((x) => x.key) ?? [],
          failed: signal?.attempts.filter((x) => !x.ok).map((x) => `${x.key} ${x.via ? new URL(x.via).host : ""} ${x.error}`) ?? [],
        },
      } : {}),
    });

    return {
      root: round.root,
      id: closureId(c.wrapper, settleAfterS, round.root),
      settleAfterS,
      markE18: built.mark.markE18.toString(),
      bandBps: built.mark.bandBps,
      data: scorecardAbi.encodeFunctionData("commit", [{
        wrapper: c.wrapper, committedAt: 0, committedBlock: 0, settleAfter: settleAfterS,
        mark: built.mark.markE18, bandBps: built.mark.bandBps,
        inputRoot: round.root, methodDigest: methodDigest(),
        lastPrint: built.mark.lastPrintE18, closingVwap: built.mark.closingVwapE18, staleOracle: 0n,
      }]),
      attempts: 0,
    };
}

async function settlePass(state: State, sender: Sender | null, health: Health, nowS: number, nowMs: number) {
  const still: Closure[] = [];
  for (const c of state.pending) {
    if (!c.committed || c.settled) continue;
    const settleAfterS = c.committed.settleAfterS;
    if (nowS < settleAfterS + CFG.settleDelayS) { still.push(c); continue; }
    if (!health.armed || !sender || !c.committed.onChain) { still.push(c); continue; }
    c.settleAttempts = (c.settleAttempts ?? 0) + 1;
    try {
      // A sender id distinct from the commit's, and distinct per attempt: the outbox is keyed on it.
      const receipt = await sender.broadcastAndWait(
        await sender.prepare(CFG.scorecard, scorecardAbi.encodeFunctionData("settle", [c.committed.id]),
          { id: `settle:${c.committed.root}:${c.settleAttempts}`, kind: "settle", targetMs: nowMs }));
      c.settled = { txHash: receipt.hash, atMs: nowMs };
      health.settledTotal++;
      health.lastSettle = { symbol: c.symbol, id: c.committed.id, tx: receipt.hash, block: receipt.blockNumber };
      log("settled", { symbol: c.symbol, id: c.committed.id, tx: receipt.hash, block: receipt.blockNumber });
    } catch (e) {
      const reason = e instanceof RevertedInSimulation ? e.reason : "";
      if (/AlreadySettled/i.test(reason)) {
        // settle() is permissionless: someone else graded the row, which is the design working.
        c.settled = { txHash: "", atMs: nowMs };
        log("settled-by-other", { symbol: c.symbol, id: c.committed.id });
        continue;
      }
      const msg = e instanceof RevertedInSimulation ? `refused: ${reason}` : e instanceof Error ? e.message : String(e);
      log("settle-retry", { symbol: c.symbol, id: c.committed.id, error: msg });
      still.push(c);
      // settle() is permissionless, so a row that stays unsettled is not lost -- but it is ours to notice.
      if (nowS > settleAfterS + 3 * 3600) {
        await raise(1, `keeper:settle-stuck:${c.committed.id}`, `row ${c.committed.id} (${c.symbol}) unsettled 3h after its reopen: ${msg}`);
      }
    }
  }
  state.pending = still;
}

function startHttp(health: Health) {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/healthz") {
      const ok = health.ticks > 0 && Date.now() - health.lastTickOkMs < 6 * CFG.tickMs;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, ...health, archive: publisher.health() }));
      return;
    }
    const m = url.match(/^\/marks\/(0x[0-9a-fA-F]{64})\.json$/);
    if (m) {
      const p = join(CFG.dataDir, "marks", `${m[1].toLowerCase()}.json`);
      if (existsSync(p)) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable" });
        res.end(readFileSync(p));
        return;
      }
    }
    res.writeHead(404).end();
  });
  // A dropped client must never take the keeper down with it; a port clash must fail loudly.
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("error", (e: NodeJS.ErrnoException) => {
    log("http-error", { error: `${e.code ?? e.name}: ${e.message}` });
    if (e.code === "EADDRINUSE" || e.code === "EACCES") process.exit(1);
  });
  server.listen(CFG.port, () => log("http", { port: CFG.port }));
}

if (import.meta.main) {
  main().catch(async (e) => {
    log("fatal", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    // Sleep before exiting so a restart loop cannot hammer the RPCs or the issuer.
    await new Promise((r) => setTimeout(r, 60_000));
    process.exit(1);
  });
}
