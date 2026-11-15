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
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
  renameSync, openSync, fsyncSync, closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes } from "ethers";

import { pinLatest, multicallAt, clockAbi, balanceCall, decodeBalance, DEFAULT_RPCS } from "./sources/chain.ts";
import type { Call, MulticallSnapshot } from "./sources/chain.ts";
import { readPools } from "./sources/pools.ts";
import type { PoolSpec, SwapRow } from "./sources/pools.ts";
import { readHeads, scanRange } from "./sources/logscan.ts";
import type { ScanResult } from "./sources/logscan.ts";
import { ClosureSwapStore, backfillJob, domainFrom, fillForCommit, ingest } from "./swapstore.ts";
import type { Coverage, IngestReport, Tracked } from "./swapstore.ts";
import { blockCount, gapsWithin, normalizeRanges } from "./ranges.ts";
import { cutReadOf } from "./swapEvidence.ts";
import type { CutRead } from "./swapEvidence.ts";
import { XStocksClient } from "./sources/xstocks.ts";
import { MARK_METHODS, MARK_METHOD_VERSION, hasSignal } from "./mark.ts";
import { buildMarkRound, verifyMarkBundleOffline } from "./markRound.ts";
import { assembleSwapEvidence } from "./evidence.ts";
import { gatherSignal, DEFAULT_RELAY_BASE } from "./sources/signalFetch.ts";
import type { GatheredSignal } from "./sources/signalFetch.ts";
import { nextCapReturnMs } from "./reopen.ts";
import type { PeriodLimits } from "./reopen.ts";
import { applyRecut, checkCut, closureSchedule, foldHolidays, venueEvidenceFor } from "./venueTime.ts";
import type { CutCheck, HolidayLedger } from "./venueTime.ts";
import type { ExchangeSchedule, TradingObject } from "./regime.ts";
import { loadOrCreateKey } from "./tx/keys.ts";
import { Sender, normalizeDataSuffix, builderCodes } from "./tx/sender.ts";
import { publisherFromEnv } from "./publish.ts";
import type { PublishHealth } from "./publish.ts";
import { createAlarms, ALARM_FLUSH_BUDGET_MS } from "./alarms.ts";
import { orphanReport, orphanClosureFiles, createDiskMonitor, diskAlarm, memUsage, DISK_BYTES_EVERY_MS } from "./retention.ts";
import type { AlarmsHealth } from "./alarms.ts";
import {
  sendOnce, maxNonceRpc, commitAttempt, canSettle, settleStep, settleOutcome, settleLateAlarm, settleWindow, SETTLE_EXPIRY_GRACE_S,
} from "./outcome.ts";
import type { MinedEarlier } from "./outcome.ts";
import {
  reconcileCalls, readChainBook, reconcile, applyCorrections, recordSettled, recordExpired, rowFromRecent, pruneRecent,
  closureCountCall, decodeClosureCount, RECONCILE_DEADLINE_MS,
} from "./reconcile.ts";
import type { SettledRef, ExpiredRef } from "./reconcile.ts";

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
  const int = (name: string, v: string, min: number, max: number) => {
    const n = Number(v.trim() === "" ? NaN : v);
    if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${name} must be in [${min},${max}], got ${JSON.stringify(v)}`); return min; }
    return n;
  };
  const wei = (name: string, v: string, fallback: bigint) => {
    const x = v.trim();
    if (!/^[0-9]+$/.test(x)) { errors.push(`${name} must be a decimal integer, got ${JSON.stringify(v)}`); return fallback; }
    return BigInt(x);
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
     * 19:55, 03:55 ET. Those are real zero-capacity windows, but a mark for such a gap would be
     * committed seconds after the cut, with almost no closure behind it: the primary market is shut
     * for five minutes while the pool keeps trading through them (wNVDAx had 1,418 swaps in four
     * hours on 13 Nov). Committing them would pad the record with rows that say almost nothing about
     * pricing a closure, which is the opposite of what it is for. The meaningful closures -- the
     * 65-minute Hong Kong lunch recess, the 17-hour overnight, weekends, holidays -- are all far
     * above this floor.
     */
    minClosureS: num("MIN_CLOSURE_S", env("MIN_CLOSURE_S", "1800")!, 0, 86_400),
    /** Must equal Scorecard.SETTLE_DELAY. */
    settleDelayS: num("SETTLE_DELAY_S", env("SETTLE_DELAY_S", "300")!, 0, 86_400),
    /** MarketClock.MAX_ATTESTATION_AGE: past this the clock reads UNKNOWN and we are blind. */
    maxAttestationAgeS: num("MAX_ATTESTATION_AGE_S", env("MAX_ATTESTATION_AGE_S", "1800")!, 60, 86_400),
    venueRefreshMs: num("VENUE_REFRESH_MS", env("VENUE_REFRESH_MS", "600000")!, 60_000, 3_600_000),
    lowBalanceWei: wei("LOW_BALANCE_WEI", env("LOW_BALANCE_WEI", "3000000000000000")!, 3_000_000_000_000_000n),
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
    /**
     * W2.7: at most this many 100-block chunks of backfill per tick (closing windows, and the closures open at a
     * deploy), only in ticks with no commit, settle or send in progress. 0 disables the backfill.
     */
    backfillChunksPerTick: int("BACKFILL_CHUNKS_PER_TICK", env("BACKFILL_CHUNKS_PER_TICK", "20")!, 0, 60),
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
  /** Receipt block of the commit, when known (deploy 2, W5); absent after a ClosureExists proof. */
  block?: number;
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
  // W2 (deploy 2). Optional: a closure opened by the old build has none of them, and the old build keeps them.
  /** block.hash of the opening tick; null when unknown. */
  cutBlockHash?: string | null;
  /** The opening tick's slot0 read of this pool (cutReadOf); null when the read failed. */
  cutRead?: CutRead | null;
  /** Block ranges the closure file is known to cover, and its row count when last claimed (swapstore.ts). */
  coverage?: Coverage;
  // W7 (deploy 2). Optional: absent on a closure the old build opened; the old build ignores and keeps them.
  /**
   * Was the cut a scheduled one (venueTime.ts checkCut)? false: confirmed. true: the chain shut while the schedule
   * says open (a host A blip, or a blip merged into a real cut); waiting for the schedule's own cut. "unanchorable":
   * the true cut is unknown; never planned. Absent: not checked yet (no venue so far); never planned either.
   */
  cutSuspect?: boolean | "unanchorable";
  /** The last tick at which the schedule said open, while suspect. */
  schedOpenSeenMs?: number | null;
  /** Set when the cut was re-anchored at the schedule's own cut: where the chain first showed it. */
  recut?: { fromCutAtMs: number; fromCutBlock: number };
  /** Every holiday list read while the closure was open (forward-only pruning, venueTime.ts foldHolidays). */
  holidayLedger?: HolidayLedger;
  /** W4b: how many times planning this closure was refused (health only). */
  refusals?: number;
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
  /** Written by saveState (deploy 2, W6); never required on load. */
  v?: 2;
  /** W5: rows this keeper settled (or saw settled), kept 24 h and re-read on chain by the reconciliation. */
  recent?: SettledRef[];
  /** W5: rows whose settle window closed unsettled, or that Scorecard does not know (last 50). */
  expired?: ExpiredRef[];
}

const statePath = () => join(CFG.dataDir, "keeper-state.json");

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

/**
 * The ONLY writer of keeper-state.json (W6). Called with the frozen plan right after it is built, with each
 * commit attempt's number before the transaction is signed, and at the end of every tick. `persistReplace` is
 * tmp + fsync + rename + directory fsync, so a crash leaves the old or the new file whole: after any restart a
 * plan that was ever signed for is on disk, and `buildPlan` only runs for a closure without one. Throws on I/O
 * error; every caller decides what not to do when it does.
 */
function saveState(state: State): void {
  state.v = 2;
  persistReplace(statePath(), JSON.stringify(state));
}

/** Write-once: a published bundle is the thing a row is checked against, so it is never rewritten. */
function persistOnce(path: string, content: string) {
  if (existsSync(path)) return;
  persistReplace(path, content);
}

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
  // Deploy 2 (W10.3). Every field below is a view; none is persisted. Absent until its package fills it.
  /** W2: the per-tick swap scan, the backfill, and per open closure {symbol, cutBlock, cutSuspect, coveredTo, gaps, gapBlocks, rows}. */
  swapScan?: Record<string, unknown>;
  backfill?: Record<string, unknown>;
  closures?: Array<Record<string, unknown>>;
  /** W3: free space on DATA_DIR's volume and what the keeper keeps there; the process's memory. */
  disk?: { freeMb: number | null; marksBytes: number; closuresBytes: number; orphans: number };
  mem?: { rssMb: number; heapUsedMb: number };
  /** W5: Scorecard's own count beside the keeper's books, and the reconciliation's last good read. */
  onchain?: {
    closureCount: number | null; pending: number; pendingPastDue: string[]; recent: number; expired: number;
    reconcile: { lastOkBlock: number | null; skipped: number };
  };
  /** W10.7: wall clock minus the pinned block's timestamp, at the moment the block was pinned. */
  clock: { skewS: number | null };
  /** When each asset was last evaluated by the per-asset loop (W2's loop sets it). */
  assetsLastEvaluatedMs: Record<string, number>;
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

/**
 * Alarms (W10.1, alarms.ts). `raise` is synchronous and never touches the network: it logs `alarm`, applies the
 * 15-minute cooldown and queues the alarm. Nothing is delivered between building a plan and sending it; the
 * queue is flushed once per tick after the commit and settle passes (`alarms.flush`, 5 s budget, every sev-1 of
 * the flush coalesced into one page), and in the main loop's catch. Never `await` a raise.
 */
const alarms = createAlarms({ url: CFG.alarmUrl, hostId: CFG.hostId, log });

function raise(sev: 1 | 2, key: string, message: string): void { alarms.raise(sev, key, message); }

async function hcAccepted(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  // healthchecks.io answers "OK (rate limited)" with a 200; only an exact OK was actually recorded.
  try { return (await res.text()).trim() === "OK"; } catch { return false; }
}

/** The heartbeat (HC_URL), after a good tick. */
async function ping(url: string): Promise<boolean> {
  if (!url) return false;
  try { return await hcAccepted(await fetch(url, { signal: AbortSignal.timeout(5_000) })); } catch { return false; }
}

/** W10.7: |skew| above this on CLOCK_SKEW_TICKS consecutive ticks pages. X Layer makes one block per second. */
export const CLOCK_SKEW_MAX_S = 30;
export const CLOCK_SKEW_TICKS = 3;
/**
 * One tick's clock-skew reading. `pinnedAtMs` is the wall clock taken right after `pinLatest` returned, so the
 * reading is not inflated by however long the rest of the tick took. The commit window and `cutAtMs` run on
 * the VPS clock, the contract on `block.timestamp`.
 */
export function clockSkewStep(streak: number, pinnedAtMs: number, blockTimestampS: number): { skewS: number; streak: number; alarm: boolean } {
  const skewS = Math.round(pinnedAtMs / 1000 - blockTimestampS);
  const next = Math.abs(skewS) > CLOCK_SKEW_MAX_S ? streak + 1 : 0;
  return { skewS, streak: next, alarm: next >= CLOCK_SKEW_TICKS };
}

/** W10.7: archive items waiting (parked ones excluded: they page on their own) this long raise a sev-2. */
export const ARCHIVE_BACKLOG_MS = 60 * 60_000;
/**
 * One tick's archive reading. `publish.ts` stays byte-identical with the attestor's and exposes no age, so how
 * long items have been waiting is tracked here: `backlogSinceMs` is when the waiting count last became non-zero.
 */
export function archiveStep(backlogSinceMs: number | null, h: { queued: number; parked: number }, nowMs: number):
  { backlogSinceMs: number | null; parked: boolean; backlog: boolean } {
  const waiting = h.queued - h.parked;
  const since = waiting > 0 ? (backlogSinceMs ?? nowMs) : null;
  return { backlogSinceMs: since, parked: h.parked > 0, backlog: since !== null && nowMs - since >= ARCHIVE_BACKLOG_MS };
}

/** In-memory watch state for tick step 13 (W10.7). */
const watch = { skewStreak: 0, archiveBacklogSinceMs: null as number | null };

/** Tick step 13, the W10 part: clock skew and the archive. Never throws; raises are queued, never awaited. */
function observeTick(health: Health, block: { timestamp: number }, pinnedAtMs: number, nowMs: number): void {
  try {
    const sk = clockSkewStep(watch.skewStreak, pinnedAtMs, block.timestamp);
    watch.skewStreak = sk.streak;
    health.clock = { skewS: sk.skewS };
    if (sk.alarm) {
      raise(1, "keeper:clock-skew", `the VPS clock is ${sk.skewS}s off the chain on ${sk.streak} consecutive ticks; the commit window runs on it`);
    }
  } catch (e) { log("clock-check-error", { error: String(e) }); }
  try {
    const ph = publisher.health();
    const ar = archiveStep(watch.archiveBacklogSinceMs, ph, nowMs);
    watch.archiveBacklogSinceMs = ar.backlogSinceMs;
    if (ar.parked) {
      raise(1, "keeper:archive-parked", `${ph.parked} archive item(s) parked after their retries: restart the keeper outside commit and settle windows to re-queue`);
    }
    if (ar.backlog) {
      raise(2, "keeper:archive-backlog", `${ph.queued - ph.parked} archive item(s) waiting since ${new Date(ar.backlogSinceMs!).toISOString()}`);
    }
  } catch (e) { log("archive-check-error", { error: String(e) }); }
}

/** W3: free space every tick (statfs), the two byte counts and the orphan count at most every 10 minutes. */
const diskMonitor = createDiskMonitor(CFG.dataDir);
const diskWatch = { orphans: 0, orphansAtMs: Number.NEGATIVE_INFINITY };

/** Tick step 13, the W3 part: disk and memory on /healthz; sev-2 below 2,048 MB free, sev-1 below 512 MB. Never throws. */
function observeDisk(state: State, health: Health): void {
  try {
    const du = diskMonitor.read();
    const t = Date.now();
    if (t - diskWatch.orphansAtMs >= DISK_BYTES_EVERY_MS) {
      diskWatch.orphans = orphanClosureFiles(CFG.dataDir, state).length;
      diskWatch.orphansAtMs = t;
    }
    health.disk = { ...du, orphans: diskWatch.orphans };
    health.mem = memUsage();
    const alarm = diskAlarm(du.freeMb);
    if (alarm) raise(...alarm);
  } catch (e) { log("disk-check-error", { error: String(e) }); }
}

/** /healthz body: health plus the views kept outside it (the archive's backlog age, the alarm queue). */
function healthBody(health: Health, ok: boolean): Record<string, unknown> {
  const alarmsHealth: AlarmsHealth = alarms.health();
  const body = { ok, ...health, archive: publisher.health() as PublishHealth & { backlogSinceMs?: number | null }, alarms: alarmsHealth };
  body.archive.backlogSinceMs = watch.archiveBacklogSinceMs;   // health() returns a fresh object each call
  return body;
}

// ---------------------------------------------------------------------------------------------
// swap evidence (W2): the per-tick scan, the closure store, the backfill
// ---------------------------------------------------------------------------------------------

/**
 * One closure store and one block-hash memory for the process (W2.4). Every closure's file holds every Swap of its
 * pool from `cutBlock - 900` on; `coverage` in the state says which blocks it is known to hold. The store never
 * raises alarms itself: it returns resets and errors, and the callers below raise them.
 */
const store = new ClosureSwapStore(CFG.dataDir, log);
const recentHashes = new Map<string, string>();

/** In-memory bookkeeping for the W2.9 alarms and /healthz. Nothing here is persisted. */
const scanWatch = {
  /** When the per-tick scan last advanced the cursor or reached its target. */
  lastProgressMs: Date.now(),
  lastOkMs: null as number | null,
  failingSinceMs: null as number | null,
  lastStopReason: null as string | null,
  lastError: null as string | null,
  lastTick: null as null | { from: number; to: number; servedTo: number; chunks: number; logs: number },
  /** Consecutive ticks on which the two endpoints' heads differed by more than RPC_LAG_BLOCKS. */
  lagStreak: 0,
  totals: { logs: 0, decoded: 0, holes: 0, decodeRetries: 0, unmatched: 0, anomalies: 0, late: 0, dupes: 0, refusals: 0, programmingErrors: 0, resets: 0 },
  backfill: { active: false, level: 0, left: 0, chunksLastTick: 0, chunksTotal: 0, pendingBlocks: 0, lastError: null as string | null },
  /** "wrapper:cutBlock" of closures whose backfill-done line was logged. */
  backfillDone: new Set<string>(),
};
/** W2.9: four times the worst head lag measured between the two public RPCs (rpc-behaviour.md 5.3). */
const RPC_LAG_BLOCKS = 30;
const RPC_LAG_TICKS = 3;

/** Open closures whose file the scans fill: witnessed, no plan, not committed, and a pool in the cohort. */
function trackedClosures(state: State, assets: Asset[]): Array<Tracked & { c: Closure }> {
  const out: Array<Tracked & { c: Closure }> = [];
  for (const c of Object.values(state.open)) {
    if (!c.witnessedCut || c.plan || c.committed) continue;
    const a = assets.find((x) => x.wrapper === c.wrapper);
    if (a) out.push({ c, pool: getAddress(a.pool) });
  }
  return out;
}

/** Counters and alarms for one scan (per-tick or backfill). Never throws. */
function noteScan(where: string, scan: ScanResult): void {
  try {
    const st = scan.stats, t = scanWatch.totals;
    t.logs += st.logs; t.decoded += st.decoded; t.decodeRetries += st.decodeRetries; t.unmatched += st.unmatched;
    t.anomalies += st.anomalies; t.refusals += st.refusals.length; t.programmingErrors += st.programmingErrors;
    for (const h of scan.holes.values()) t.holes += h.length;
    const odd = st.unmatched + st.anomalies + st.decodeRetries;
    if (scan.stopReason !== null || odd > 0 || st.decodeFailed.length > 0 || st.programmingErrors > 0) {
      log("swap-scan", {
        where, from: scan.from, to: scan.to, servedTo: scan.servedTo, chunks: st.chunks, logs: st.logs, stopReason: scan.stopReason,
        unmatched: st.unmatched, anomalies: st.anomalies, decodeRetries: st.decodeRetries, decodeFailed: st.decodeFailed.slice(0, 5),
        refusals: st.refusals.slice(0, 5),
      });
    }
    if (st.decodeFailed.length > 0) {
      raise(1, "keeper:swap-decode-failed", `${where} scan: no endpoint decoded ${st.decodeFailed.length} Swap log(s); their blocks stay gaps: `
        + st.decodeFailed.slice(0, 3).map((f) => `${f.pool} block ${f.blockNumber} log ${f.logIndex}: ${f.error}`).join("; "));
    }
    if (odd > 0) {
      raise(2, "keeper:rpc-anomaly", `${where} scan ${scan.from}..${scan.servedTo}: ${st.unmatched} unmatched log(s), ${st.anomalies} answer(s) rejected, ${st.decodeRetries} set aside for a log that did not decode`);
    }
    if (st.programmingErrors > 0) {
      raise(1, "keeper:rpc-programming-error", `${where} scan: ${st.programmingErrors} malformed request(s): `
        + st.refusals.filter((x) => x.kind === "malformed-request").slice(0, 2).map((x) => `${x.code} ${x.message}`).join("; "));
    }
  } catch (e) { log("swap-scan-note-error", { error: String(e) }); }
}

/** Counters and alarms for one ingest. Never throws. */
function noteIngest(where: string, rep: IngestReport, tracked: Tracked[]): void {
  try {
    const t = scanWatch.totals;
    t.late += rep.late; t.dupes += rep.dupes; t.resets += rep.resets.length;
    if (rep.late > 0) raise(2, "keeper:late-log", `${where}: ${rep.late} Swap log(s) arrived in blocks already covered`);
    if (rep.reorgAt !== null) {
      log("reorg-suspected", { where, block: rep.reorgAt, closures: tracked.map((x) => x.c.symbol) });
      raise(1, "keeper:reorg-suspected", `${where}: a block hash changed at block ${rep.reorgAt}; open closures truncated from it and re-scanned: ${tracked.map((x) => x.c.symbol).join(",") || "none"}`);
    }
    for (const sym of rep.resets) {
      raise(1, `keeper:swap-file-lost:${sym}`, `${sym}: closure file shorter than its coverage, or corrupt; coverage reset, rebuilding by backfill`);
    }
    for (const e of rep.appendErrors) {
      log("swap-store-write-failed", { where, symbol: e.symbol, error: e.error });
      raise(1, `keeper:swap-store-write-failed:${e.symbol}`, `${e.symbol}: cannot write the closure file, nothing claimed (re-scanned later): ${e.error}`);
    }
  } catch (err) { log("swap-ingest-note-error", { error: String(err) }); }
}

/** W2.9 per open closure: how far its file is known to be complete. */
function closuresHealth(state: State): Array<Record<string, unknown>> {
  return Object.values(state.open).map((c) => {
    const d = domainFrom(c);
    const ranges = normalizeRanges(c.coverage?.ranges ?? []);
    const gaps = gapsWithin(ranges, d, state.lastScannedBlock);
    return {
      symbol: c.symbol, cutBlock: c.cutBlock,
      cutSuspect: c.cutSuspect ?? null,
      coveredTo: ranges.length > 0 && ranges[0][0] <= d ? ranges[0][1] : d - 1,
      gaps: gaps.length, gapBlocks: blockCount(gaps), rows: c.coverage?.rows ?? 0,
    };
  });
}

/**
 * W2.7: a tick is busy while any closure is inside its commit window (it is filled by `fillForCommit` instead), any
 * row is inside its settle window, or this tick sent a transaction. The backfill never runs in a busy tick.
 */
export function backfillBusy(
  s: {
    open: Array<{ committed?: unknown; witnessedCut: boolean; reopenMs: number | null; cutAtMs: number }>;
    pending: Array<{ committed?: { settleAfterS: number }; settled?: unknown }>;
  },
  nowMs: number, chainNowS: number, sentThisTick: boolean,
  cfg: { minClosureS: number; commitLeadS: number; settleDelayS: number },
): boolean {
  return s.open.some((c) => !c.committed && c.witnessedCut && c.reopenMs !== null
      && c.reopenMs - c.cutAtMs >= cfg.minClosureS * 1000
      && c.reopenMs - nowMs <= (cfg.commitLeadS + 120) * 1000 && c.reopenMs - nowMs >= -60_000)
    || s.pending.some((c) => c.committed !== undefined && !c.settled
      && chainNowS >= c.committed.settleAfterS + cfg.settleDelayS - 60
      && chainNowS <= c.committed.settleAfterS + cfg.settleDelayS + 600)
    || sentThisTick;
}

/**
 * Transactions handed to the Sender since boot (W5): every commit and settle goes through `sendTx`, so comparing
 * the count before and after the two passes says whether this tick sent anything (the backfill's busy rule).
 */
const sendWatch = { sends: 0 };

/** Closures the backfill fills (W2.7): tracked closures, due earliest first. */
function backfillEligible(state: State, assets: Asset[]): Array<Tracked & { dueMs: number }> {
  // W7: a closure whose cut the schedule has not confirmed (unchecked, suspect, unanchorable) is never backfilled:
  // a suspect one is re-anchored (a new domain) or never committed.
  return trackedClosures(state, assets)
    .filter((t) => t.c.cutSuspect === false)
    .map((t) => ({ ...t, dueMs: t.c.reopenMs ?? Number.POSITIVE_INFINITY }));
}

/**
 * Tick step 15 (W2.7), after the flush: one bounded backfill query for the closure due first, then ingest and save.
 * Never throws; its alarms are delivered by the next tick's flush.
 */
async function backfillStep(state: State, assets: Asset[], heads: number[], busy: boolean, tickStartMs: number): Promise<void> {
  const bf = scanWatch.backfill;
  bf.active = false;
  bf.chunksLastTick = 0;
  try {
    const eligible = backfillEligible(state, assets);
    bf.pendingBlocks = eligible.reduce((n, t) => n + blockCount(gapsWithin(t.c.coverage?.ranges ?? [], domainFrom(t.c), state.lastScannedBlock)), 0);
    if (bf.left > 0) { bf.left--; return; }                       // back-off after a rate limit
    if (busy) return;
    const deadlineMs = Math.min(12_000, CFG.tickMs - (Date.now() - tickStartMs) - 3_000);
    if (deadlineMs < 2_000) return;
    const job = backfillJob(eligible, state.lastScannedBlock, CFG.backfillChunksPerTick);
    if (!job) return;
    const specs = assets.filter((a) => job.pools.includes(getAddress(a.pool)));
    bf.active = true;
    const r = await scanRange(CFG.rpcs, specs, job.from, job.to,
      { maxChunks: CFG.backfillChunksPerTick, deadlineMs, heads, endpointOrder: "roundRobin" });
    noteScan("backfill", r);
    bf.chunksLastTick = r.stats.chunks;
    bf.chunksTotal += r.stats.chunks;
    if (r.stats.chunks > 0) bf.level = 0;
    if (r.stopReason === "unserved" && r.stats.refusals.some((x) => x.kind === "rate-limit")) {
      bf.level = Math.min(8, Math.max(1, 2 * bf.level));
      bf.left = bf.level;
    }
    bf.lastError = r.stopReason === "unserved" ? (r.stats.refusals.at(-1)?.message ?? "unserved") : null;
    const riders = eligible.filter((t) => job.pools.includes(t.pool));
    const rep = ingest(store, riders, r, recentHashes);
    noteIngest("backfill", rep, riders);
    if (rep.claimed > 0) {
      try { saveState(state); }
      catch (e) {
        log("state-persist-failed", { where: "backfill", error: String(e) });
        raise(1, "keeper:state-persist-failed", `cannot write keeper-state.json after a backfill: ${String(e)}`);
      }
    }
    for (const t of eligible) {
      const key = `${t.c.wrapper}:${t.c.cutBlock}`;
      if (scanWatch.backfillDone.has(key)) continue;
      const ranges = t.c.coverage?.ranges ?? [];
      if (gapsWithin(ranges, domainFrom(t.c), state.lastScannedBlock).length > 0) continue;
      scanWatch.backfillDone.add(key);
      log("backfill-done", { symbol: t.c.symbol, cutBlock: t.c.cutBlock, coveredTo: state.lastScannedBlock, rows: t.c.coverage?.rows ?? 0 });
    }
  } catch (e) {
    bf.lastError = e instanceof Error ? e.message : String(e);
    log("backfill-error", { error: bf.lastError });
  }
}

/** /healthz views of the scan and the backfill (W2.9). */
function swapHealth(state: State, health: Health, pinned: number): void {
  health.swapScan = {
    ok: scanWatch.failingSinceMs === null && scanWatch.lastOkMs !== null,
    cursor: state.lastScannedBlock, lagBlocks: pinned - state.lastScannedBlock,
    lastOkMs: scanWatch.lastOkMs, failingSinceMs: scanWatch.failingSinceMs,
    lastStopReason: scanWatch.lastStopReason, lastError: scanWatch.lastError,
    lastTick: scanWatch.lastTick, totals: { ...scanWatch.totals },
  };
  const bf = scanWatch.backfill;
  health.backfill = {
    active: bf.active, pendingBlocks: bf.pendingBlocks, chunksLastTick: bf.chunksLastTick, chunksTotal: bf.chunksTotal,
    backoffTicks: bf.left, lastError: bf.lastError,
  };
  health.closures = closuresHealth(state);
}

// ---------------------------------------------------------------------------------------------
// W7: the schedule a closure is predicted and committed with, and the check that its cut was a real one
// ---------------------------------------------------------------------------------------------

/** The issuer's holiday entries in a venue read, keeping only well-formed ones (a ledger must never throw). */
function holidaysOf(v: Pick<Venue, "sched">): Array<{ startsAt: string; endsAt: string; kind: string }> {
  const h: unknown = v.sched?.schedule?.holidays;
  return (Array.isArray(h) ? h : []).filter((x) => x && typeof x.startsAt === "string" && typeof x.endsAt === "string" && typeof x.kind === "string");
}

/**
 * The closure's venue schedule (W7.2): the latest read's sessions, with its holidays plus every entry the closure's
 * ledger kept after the issuer dropped it (venueTime.ts closureSchedule). The keeper predicts the reopen with it and
 * checks the cut with it; venueEvidenceFor commits the same schedule, and a verifier walks it from the cut. With
 * nothing kept it is the latest read, so a closure's first tick predicts exactly as HEAD did.
 */
export function closureVenueSchedule(venue: Pick<Venue, "mic" | "sched">, ledger: HolidayLedger | undefined): ExchangeSchedule {
  return { ...venue.sched, mic: venue.mic, schedule: closureSchedule(venue.sched.schedule, ledger).schedule };
}

/** A new closure's holiday ledger: the list as read now; undefined while there is no venue. */
export function openLedger(venue: Pick<Venue, "sched" | "atMs"> | undefined): HolidayLedger | undefined {
  return venue ? foldHolidays(undefined, holidaysOf(venue), venue.atMs) : undefined;
}

/**
 * Tick step 6 (W7.2): a FRESH venue read joins the ledger of the wrapper's open closure, so a holiday the issuer
 * prunes once it has started stays in the schedule the row commits (the six holiday rows of D-16). Frozen once the
 * closure has a plan.
 */
export function foldVenueRead(
  open: Record<string, { plan?: unknown; committed?: unknown; holidayLedger?: HolidayLedger }>, wrapper: string, v: Pick<Venue, "sched" | "atMs">,
): void {
  const c = open[wrapper];
  if (!c || c.plan || c.committed) return;
  c.holidayLedger = foldHolidays(c.holidayLedger, holidaysOf(v), v.atMs);
}

/** Where a recut re-anchors a closure: this tick's pinned block and this pool's read in it. */
export interface CutAnchor { nowMs: number; block: { number: number; hash: string }; midE18: bigint; poolSnap: MulticallSnapshot; pool: string }

/**
 * W7.4: act on checkCut's answer for a closure without a plan.
 * - ok: confirmed (`cutSuspect = false`); only now may it be backfilled and planned.
 * - suspect: the chain shut while the schedule says open; remember the tick, wait for the schedule's own cut.
 * - recut: the schedule shut within two ticks of last showing it open: re-anchor at this tick. The old file is named
 *   by the old cutBlock, so it is removed FIRST; then applyRecut; then any file at the new name (it starts empty, as
 *   its coverage does). This tick's ingest fills the new domain and the backfill its closing window.
 * - unanchorable: the true cut is unknown; never planned, abandoned when capacity returns. Sev-1 once.
 */
export function onCutCheck(c: Closure, r: CutCheck, at: CutAnchor): void {
  const iso = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
  switch (r.kind) {
    case "ok":
      c.cutSuspect = false;
      return;
    case "suspect":
      if (c.cutSuspect !== true) {
        log("closure-cut-suspect", { symbol: c.symbol, cutBlock: c.cutBlock, cutAt: iso(c.cutAtMs), scheduleOpenAt: iso(r.schedOpenSeenMs) });
      }
      c.cutSuspect = true;
      c.schedOpenSeenMs = r.schedOpenSeenMs;
      return;
    case "recut": {
      const from = { cutBlock: c.cutBlock, cutAtMs: c.cutAtMs };
      try { store.remove(c); } catch (e) { log("swap-file-remove-failed", { symbol: c.symbol, cutBlock: c.cutBlock, error: String(e) }); }
      applyRecut(c, { nowMs: at.nowMs, blockNumber: at.block.number, blockHash: at.block.hash, midE18: at.midE18, cutRead: cutReadOf(at.poolSnap, at.pool) });
      try { store.remove(c); } catch (e) { log("swap-file-remove-failed", { symbol: c.symbol, cutBlock: c.cutBlock, error: String(e) }); }
      log("closure-recut", { symbol: c.symbol, fromCutBlock: from.cutBlock, fromCutAt: iso(from.cutAtMs), cutBlock: c.cutBlock, cutAt: iso(c.cutAtMs) });
      return;
    }
    case "unanchorable":
      if (c.cutSuspect !== "unanchorable") {
        log("closure-cut-unanchorable", { symbol: c.symbol, cutBlock: c.cutBlock, cutAt: iso(c.cutAtMs), reason: r.reason });
        raise(1, `keeper:cut-unconfirmed-by-schedule:${c.symbol}`,
          `${c.symbol}: capacity went to zero at ${iso(c.cutAtMs)} (block ${c.cutBlock}) while the venue schedule said open, and ${r.reason}; no row will be committed for this closure`);
      }
      c.cutSuspect = "unanchorable";
      return;
  }
}

/** The previous tick's observation instant (its nowMs), for the cut check's tick length. In memory only. */
const cutWatch = { lastNowMs: null as number | null };

/**
 * W7.4: the tick length the cut check allows between two sightings: the interval this keeper actually observed since
 * its previous tick, never less than the configured tick. With the configured tick alone, one slow tick (RPC
 * deadlines, a commit-time fill, an alarm flush) straddling the schedule's cut made a merged-blip closure
 * unanchorable, a lost row.
 */
export function cutCheckTickMs(nowMs: number, lastNowMs: number | null, cfgTickMs: number): number {
  return lastNowMs === null ? cfgTickMs : Math.max(cfgTickMs, nowMs - lastNowMs);
}

/**
 * W7.5: an uncommitted closure that capacity has returned to. A cut the schedule never confirmed is a host A blip
 * (sev-2); a confirmed, witnessed closure at least minClosureS long that ended without a row lost one (sev-1: a
 * mispredicted reopen, such as a holiday withdrawn on the day, or a missed commit window). Returns which, for tests.
 */
export function abandonAlarms(
  c: Pick<Closure, "symbol" | "cutBlock" | "cutAtMs" | "cutSuspect" | "witnessedCut">, nowMs: number, minClosureS: number,
): "phantom" | "missed" | null {
  const lastedS = Math.round((nowMs - c.cutAtMs) / 1000);
  if (c.cutSuspect !== false) {
    log("closure-phantom", { symbol: c.symbol, cutBlock: c.cutBlock, lastedS, cutSuspect: c.cutSuspect ?? null });
    raise(2, `keeper:phantom-closure:${c.symbol}`,
      `${c.symbol}: capacity was at zero for ${lastedS}s from block ${c.cutBlock} without the venue schedule confirming the cut (${c.cutSuspect === undefined ? "never checked" : String(c.cutSuspect)}): a host A blip`);
    return "phantom";
  }
  if (c.witnessedCut && nowMs - c.cutAtMs >= minClosureS * 1000) {
    raise(1, `keeper:closure-missed:${c.symbol}`,
      `${c.symbol}: a ${(lastedS / 3600).toFixed(1)}-hour closure the schedule confirmed (cut block ${c.cutBlock}) ended without a row: a mispredicted reopen or a missed commit window`);
    return "missed";
  }
  return null;
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
  // Whether a sev-1 can page anyone, before any disk access. Never the URLs.
  log("alarms", { paging: CFG.alarmUrl !== "", heartbeat: CFG.hcUrl !== "" });
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
    raise(CFG.scorecard === ZERO ? 2 : 1, "keeper:no-priceable-assets",
      CFG.scorecard === ZERO
        ? "bootstrap boot: no SCORECARD configured yet, so nothing is marked; the key exists and the address is on /healthz"
        : "no registered asset has a Scorecard price source; nothing can be marked");
  }

  const sender = key ? new Sender({
    wallet: key.wallet, rpcs: CFG.rpcs, chainId: CFG.chainId, dbPath: join(CFG.dataDir, "keeper-outbox.sqlite"),
    errorInterface: scorecardAbi,
    dataSuffix: CFG.dataSuffix,
    // W5 (KM 6.4): the pending nonce is the HIGHEST count any endpoint reports within 1.5 s of the first answer,
    // never the first endpoint's (a lagging one twice returned an old count). Every other method passes through.
    rpc: maxNonceRpc(async (url, method, params) => {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(method === "eth_sendRawTransaction" ? 5_000 : 4_000),
      });
      const j = (await res.json()) as { result?: unknown; error?: { message: string; data?: string } };
      if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
      return j.result;
    }, CFG.rpcs),
  }) : null;

  const client = new XStocksClient();
  const venues = new Map<string, Venue>();
  const state = loadState();
  // W3: report, never delete (CO B2). A swap file no open or pending closure names exists only after a state loss or
  // a restore, and it is exactly the file a later restore would need. A person deletes orphans.
  const orphans = orphanReport(CFG.dataDir, state);
  diskWatch.orphans = orphans.files.length;
  diskWatch.orphansAtMs = Date.now();
  if (orphans.files.length > 0) log("closure-file-orphans", { files: orphans.files, bytes: orphans.bytes });
  const health: Health = {
    bootMs: Date.now(), ticks: 0, lastTickOkMs: Date.now(), mode: CFG.mode, address, isKeeper: false, armed: false,
    assets: assets.length, open: 0, pending: state.pending.length, committedTotal: 0, settledTotal: 0,
    attribution: attributionHealth(sender),
    clock: { skewS: null }, assetsLastEvaluatedMs: {},
  };
  startHttp(health);

  let lastTickS = 0;   // the previous tick's duration (W4b: when the next tick can be expected)
  for (;;) {
    const tickStart = Date.now();
    try {
      await tick(state, assets, venues, client, sender, health, digest, { tickStartMs: tickStart, lastTickS });
      health.lastTickOkMs = Date.now();
      health.ticks++;
      await ping(CFG.hcUrl);
    } catch (e) {
      log("tick-error", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      if (Date.now() - health.lastTickOkMs > 10 * 60_000) {
        raise(1, "keeper:ticks-failing", `no successful tick for ${Math.round((Date.now() - health.lastTickOkMs) / 60_000)} minutes`);
      }
      // A tick that threw skipped its own flush (step 14): deliver what it raised now, within the budget.
      const delivered = alarms.flush(ALARM_FLUSH_BUDGET_MS);
      await delivered;
    }
    lastTickS = (Date.now() - tickStart) / 1000;
    const wait = CFG.tickMs - (Date.now() - tickStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

async function tick(
  state: State, assets: Asset[], venues: Map<string, Venue>, client: XStocksClient,
  sender: Sender | null, health: Health, digest: string, loop: { tickStartMs: number; lastTickS: number },
) {
  const tickStartMs = loop.tickStartMs;
  const block = await pinLatest(CFG.rpcs);
  const pinnedAtMs = Date.now();   // W10.7: the clock-skew reading is taken against the moment of pinning
  const calls: Call[] = [
    ...assets.flatMap((a) => [
      { label: `cap:${a.wrapper}`, target: CFG.clock, callData: capAbi.encodeFunctionData("primaryCapNow", [a.wrapper]) },
      { label: `state:${a.wrapper}`, target: CFG.clock, callData: clockAbi.encodeFunctionData("stateOf", [a.wrapper]) },
    ]),
    { label: "isKeeper", target: CFG.scorecard, callData: scorecardAbi.encodeFunctionData("isKeeper", [health.address]) },
    balanceCall(health.address),
    closureCountCall(CFG.scorecard),   // W5: /healthz only (no arithmetic on it, CO m2)
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
  // W5: found by label (the multicall no longer ends with it), and an unreadable balance keeps the last one that
  // decoded instead of reading as 0. Settles decide on that same last known balance (canSettle).
  const balRes = chain.results.find((r) => r.label === balanceCall(health.address).label);
  const bal = decodeOr<bigint | null>(null, () => decodeBalance(balRes!), balRes);
  if (bal !== null) { onchainWatch.lastBalanceWei = bal; health.balanceWei = bal.toString(); }
  const knownBal = onchainWatch.lastBalanceWei;
  health.armed = CFG.mode === "live" && health.isKeeper && knownBal !== null && knownBal >= CFG.lowBalanceWei;
  onchainWatch.closureCount = decodeClosureCount(chain.results.find((r) => r.label === "closureCount")) ?? onchainWatch.closureCount;

  // 5. (W5) The books against Scorecard at the pinned block: its own multicall, raced against 5 s, in its own try.
  // It runs before both passes and never blocks a send: on a timeout or an error nothing is corrected this tick.
  await reconcileStep(state, block, nowMs, health);

  // Refresh the issuer/venue inputs on their own slow clock; they change on the order of days.
  for (const a of assets) {
    const have = venues.get(a.wrapper);
    if (have && nowMs - have.atMs < CFG.venueRefreshMs) continue;
    try {
      const v = await readVenue(client, a);
      if (v) {
        venues.set(a.wrapper, v);
        // W7.2: the fresh holiday list joins the open closure's ledger (frozen once it has a plan).
        foldVenueRead(state.open, a.wrapper, v);
      }
      else if (!have) log("venue-unavailable", { symbol: a.symbol });
    } catch (e) { log("venue-error", { symbol: a.symbol, error: String(e) }); }
  }
  client.takeLog();

  // 7. (W2) Every endpoint's head in parallel (3 s), then the per-tick swap scan: [cursor + 1 - 60, pinned - 5], at
  // most 10 chunks and 10 s. The 60-block overlap gives every block a second look; the 5-block trail is never
  // asked of an endpoint whose head has not reached it. A scan failure never stops a closure transition, a commit or
  // a settle: scanRange is total, and what it could not serve is scanned again next tick or filled at commit time.
  const rawHeads = await readHeads(CFG.rpcs);
  const heads = [...rawHeads];
  const bi = CFG.rpcs.indexOf(block.rpc);
  if (bi >= 0) heads[bi] = Math.max(heads[bi], block.number);   // the endpoint that served the pinned head has at least it
  scanWatch.lagStreak = rawHeads.length >= 2 && rawHeads[0] >= 0 && rawHeads[1] >= 0 && Math.abs(rawHeads[0] - rawHeads[1]) > RPC_LAG_BLOCKS
    ? scanWatch.lagStreak + 1 : 0;
  const scanTo = block.number - 5;
  const scanFrom = state.lastScannedBlock === 0
    ? Math.max(0, scanTo - 200)
    : Math.max(0, state.lastScannedBlock + 1 - 60);
  const cursorBefore = state.lastScannedBlock;
  let scan: ScanResult | null = null;
  try {
    scan = await scanRange(CFG.rpcs, assets, scanFrom, scanTo, { maxChunks: 10, deadlineMs: 10_000, heads, endpointOrder: "first" });
    if (scan.servedTo > state.lastScannedBlock) state.lastScannedBlock = scan.servedTo;   // never moves backwards
    noteScan("tick", scan);
  } catch (e) {
    // scanRange is total; this only guards a programming error.
    scanWatch.lastError = String(e);
    log("swap-scan-error", { error: String(e) });
  }
  {
    const now = Date.now();
    const reached = scan !== null && scan.stopReason === null;   // everything asked for was served (or nothing was due)
    if (scan !== null && (reached || state.lastScannedBlock > cursorBefore)) scanWatch.lastProgressMs = now;
    if (reached) { scanWatch.lastOkMs = now; scanWatch.failingSinceMs = null; }
    else scanWatch.failingSinceMs ??= now;
    if (scan) {
      scanWatch.lastStopReason = scan.stopReason;
      scanWatch.lastError = scan.stopReason === "unserved" ? (scan.stats.refusals.at(-1)?.message ?? "unserved") : null;
      scanWatch.lastTick = { from: scan.from, to: scan.to, servedTo: scan.servedTo, chunks: scan.stats.chunks, logs: scan.stats.logs };
    }
  }

  // W7.4: the interval since the previous tick's observation, for this tick's cut checks.
  const cutTickMs = cutCheckTickMs(nowMs, cutWatch.lastNowMs, CFG.tickMs);
  cutWatch.lastNowMs = nowMs;

  // 8. The per-asset loop: opens, closes and abandons closures. No swap handling: the scan's rows go to the
  // closure files in step 9, whatever this loop decides.
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
      raise(1, "keeper:clock-stale", `MarketClock is stale for ${a.symbol} (observedAt=${observedAt}); holding all closure decisions`);
      continue;
    }
    const capRead = decodeOr(null, () => BigInt(capAbi.decodeFunctionResult("primaryCapNow", capRes.returnData)[0]), capRes);
    if (capRead === null) continue;
    const cap = capRead;
    const open = state.open[w];
    health.assetsLastEvaluatedMs[a.symbol] = nowMs;

    if (cap > 0n) {
      state.lastPrint[w] = { priceE18: read.priceE18.toString(), atMs: nowMs };
      if (open?.committed) { state.pending.push(open); delete state.open[w]; log("closure-closed", { symbol: a.symbol, id: open.committed.id }); }
      else if (open) {
        // Review F2: a closure whose plan was sent may be on chain; abandon it only once reconcile read it absent.
        const decision = abandonStep(open, block.number, nowMs);
        if (decision === "hold") continue;
        log("closure-abandoned", {
          symbol: a.symbol, cutBlock: open.cutBlock, reason: "capacity returned before the commit point",
          cutSuspect: open.cutSuspect ?? null, lastedS: Math.round((nowMs - open.cutAtMs) / 1000),
        });
        // W7.5: a blip the schedule never confirmed (sev-2), or a confirmed, witnessed, long closure that lost its row (sev-1).
        abandonAlarms(open, nowMs, CFG.minClosureS);
        if (decision === "abandon") {
          try { store.remove(open); } catch (e) { log("swap-file-remove-failed", { symbol: a.symbol, cutBlock: open.cutBlock, error: String(e) }); }
        }
        delete state.open[w];
      }
      continue;
    }

    const venue = venues.get(w);
    // W7.3: a closure the old build opened has no ledger; it starts from the first read after this build's boot.
    if (open && venue && !open.plan && !open.committed && !open.holidayLedger) open.holidayLedger = openLedger(venue);
    // W7.2: the reopen is predicted with the closure's schedule: the latest sessions, the latest holidays and every
    // entry the ledger kept. On the opening tick that is the latest read itself.
    const sched = venue ? closureVenueSchedule(venue, open?.holidayLedger) : null;
    const reopenMs = venue && sched ? nextCapReturnMs(venue.limits, sched, nowMs) : null;
    const anchor: CutAnchor = { nowMs, block, midE18: read.priceE18, poolSnap, pool: a.pool };

    if (!open) {
      const last = state.lastPrint[w];
      const witnessed = Boolean(last && nowMs - last.atMs < 5 * CFG.tickMs);
      const fresh: Closure = {
        wrapper: w, symbol: a.symbol, cutAtMs: nowMs, cutBlock: block.number,
        midAtCutE18: read.priceE18.toString(),
        preCutMidE18: witnessed ? last!.priceE18 : null,
        witnessedCut: witnessed,
        reopenMs, swapCount: 0,
        // W2: the cut block's hash and this pool's slot0 read at it (committed in the swaps leaf), and an empty
        // coverage: the closing window [cutBlock - 900, cutBlock] and the closure are filled by the scans.
        cutBlockHash: block.hash,
        cutRead: cutReadOf(poolSnap, a.pool),
        coverage: { ranges: [], rows: 0 },
        // W7: the holiday list as read now starts the closure's ledger.
        holidayLedger: openLedger(venue),
      };
      // W7.4: was this a scheduled cut? The opening tick is the only one that sees the schedule at the cut itself.
      // No venue: cutSuspect stays unset, which blocks the backfill and planning until a venue is read.
      if (venue && sched) {
        try { onCutCheck(fresh, checkCut(fresh, venue.limits, sched, nowMs, cutTickMs), anchor); }
        catch (e) { log("cut-check-error", { symbol: a.symbol, error: String(e) }); }
      }
      state.open[w] = fresh;
      // A file left at this path is a re-cut at the same block: start it empty, as its coverage is.
      try { store.remove(fresh); } catch (e) { log("swap-file-remove-failed", { symbol: a.symbol, cutBlock: block.number, error: String(e) }); }
      log("closure-open", {
        symbol: a.symbol, cutBlock: block.number, midAtCut: read.priceE18,
        reopen: reopenMs === null ? null : new Date(reopenMs).toISOString(),
        witnessedCut: witnessed, cutSuspect: fresh.cutSuspect ?? null,
      });
      continue;
    }

    // W7.4: the cut check and recut of an open closure, every tick until it has a plan. A recut moves the cut to
    // this tick (new cutBlock, hash, read, mid; empty coverage) and removes the old file first.
    if (venue && sched && !open.plan && !open.committed) {
      try { onCutCheck(open, checkCut(open, venue.limits, sched, nowMs, cutTickMs), anchor); }
      catch (e) { log("cut-check-error", { symbol: a.symbol, error: String(e) }); }
    }
    // The predicted reopen is refreshed until a plan exists, then frozen: the plan's settleAfter is what counts.
    if (reopenMs !== null && !open.committed && !open.plan) open.reopenMs = reopenMs;
  }

  // 9. (W2) The scan's rows into every tracked open closure (store.ensure inside ingest): rows reach the file before
  // coverage claims their blocks, a failed append claims nothing, a hole is never claimed.
  if (scan) {
    const tracked = trackedClosures(state, assets);
    try { noteIngest("tick", ingest(store, tracked, scan, recentHashes), tracked); }
    catch (e) { log("swap-ingest-error", { error: String(e) }); }
  }

  const sendsBefore = sendWatch.sends;
  await commitPass(state, assets, venues, poolSnap, reads, sender, health, digest, { heads, chainNowS: block.timestamp, lastTickS: loop.lastTickS, tickStartMs });
  await settlePass(state, sender, health, block.timestamp, nowMs);
  const sentThisTick = sendWatch.sends !== sendsBefore;

  health.open = Object.keys(state.open).length;
  health.pending = state.pending.length;
  health.onchain = onchainHealth(state, block.timestamp);

  // 12. The end-of-tick write (W6). A failure pages and fails the tick, but only after this tick's alarms are out.
  let persistError: unknown = null;
  try { saveState(state); }
  catch (e) {
    persistError = e;
    log("state-persist-failed", { where: "tick", error: String(e) });
    raise(1, "keeper:state-persist-failed", `cannot write keeper-state.json: ${String(e)}`);
  }

  // 13. Health and alarm conditions.
  if (CFG.mode === "live" && !health.armed) {
    raise(2, "keeper:not-armed", `cannot commit: isKeeper=${health.isKeeper} balanceWei=${health.balanceWei}`);
  }
  observeTick(health, block, pinnedAtMs, Date.now());
  observeDisk(state, health);
  // W2.9: the scan's own health. A failing scan never fails the tick; it pages instead.
  try {
    const now = Date.now();
    const sinceMs = now - scanWatch.lastProgressMs;
    const behind = block.number - 5 - state.lastScannedBlock;
    const dueSoon = Object.values(state.open).find((c) => c.witnessedCut && !c.committed && c.reopenMs !== null
      && c.reopenMs - now >= 0 && c.reopenMs - now <= (CFG.commitLeadS + 300) * 1000);
    if (sinceMs > 60 * 60_000 || (dueSoon && behind > 500)) {
      raise(1, "keeper:swap-scan-stalled", dueSoon && behind > 500
        ? `the swap scan is ${behind} blocks behind and ${dueSoon.symbol} reopens at ${new Date(dueSoon.reopenMs!).toISOString()}`
        : `the swap scan has not advanced for ${Math.round(sinceMs / 60_000)} minutes (cursor ${state.lastScannedBlock}, head ${block.number})`);
    } else if (sinceMs > 10 * 60_000) {
      raise(2, "keeper:swap-scan-failing", `the swap scan has not advanced for ${Math.round(sinceMs / 60_000)} minutes: ${scanWatch.lastError ?? scanWatch.lastStopReason ?? "unknown"}`);
    }
    if (scanWatch.lagStreak >= RPC_LAG_TICKS) {
      raise(2, "keeper:rpc-lagging", `RPC heads ${JSON.stringify(rawHeads)} differ by more than ${RPC_LAG_BLOCKS} blocks on ${scanWatch.lagStreak} consecutive ticks`);
    }
    swapHealth(state, health, block.number);
  } catch (e) { log("swap-health-error", { error: String(e) }); }

  // 14. Deliver what this tick raised: after the commit and settle passes, never between a plan and its send.
  // The flush is the only network wait for alarms, bounded by its budget; `raise` itself is never awaited.
  const delivered = alarms.flush(ALARM_FLUSH_BUDGET_MS);
  await delivered;
  if (persistError) throw persistError;

  // 15. (W2.7) The backfill, after the flush: never on the first tick after boot, never in a busy tick, bounded by
  // BACKFILL_CHUNKS_PER_TICK and the time left in the tick; it saves through saveState(state) when it claimed coverage.
  if (health.ticks >= 1 && CFG.backfillChunksPerTick > 0) {
    const busy = backfillBusy({ open: Object.values(state.open), pending: state.pending }, Date.now(), block.timestamp, sentThisTick, CFG);
    await backfillStep(state, assets, heads, busy, tickStartMs);
    swapHealth(state, health, block.number);
  }
}

// ---------------------------------------------------------------------------------------------
// transactions and the books (W5): the one send path, commit outcomes, settles, reconciliation
// ---------------------------------------------------------------------------------------------

/** In-memory W5 state. Nothing here is persisted. */
const onchainWatch = {
  /** The last balance read that decoded (null until one does): `armed` and canSettle use it. */
  lastBalanceWei: null as bigint | null,
  /** Scorecard.closureCount() at the last tick that read it; shown on /healthz, never compared. */
  closureCount: null as number | null,
  /** The reconciliation's rotation through `recent` and its two-read streaks (reconcile.ts). */
  cursor: { recent: 0 },
  streak: new Map<string, number>(),
  lastOkBlock: null as number | null,
  skipped: 0,
  /** This tick's settlements(id) reads (review F3), reset at the start of every reconcileStep: null when not read. */
  settledNow: null as Map<string, boolean | null> | null,
  /** Plan ids of sent-but-unrecorded closures read as absent at `atBlock` (review F2), reset every reconcileStep. */
  planAbsent: { atBlock: -1, ids: new Set<string>() },
};

/**
 * Review F5: the receipt the outbox recorded for an earlier attempt of the same row (`commit:<root>:` or
 * `settle:<root>:`), so a ClosureExists or AlreadySettled refusal is booked as ours, with its hash and block. Opens the
 * Sender's outbox read-only on its own connection; never throws (null when unknown).
 */
export function outboxMinedIn(dbPath: string, idPrefix: string): { hash: string; block: number } | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      "select hash, block_number from outbox where substr(id, 1, ?) = ? and state = 'mined' and block_number is not null order by updated_ms desc limit 1",
    ).get(idPrefix.length, idPrefix) as { hash: string; block_number: number } | undefined;
    return row ? { hash: row.hash, block: Number(row.block_number) } : null;
  } catch { return null; }
  finally { try { db?.close(); } catch { /* ignore */ } }
}
const outboxMined: MinedEarlier = (prefix) => outboxMinedIn(join(CFG.dataDir, "keeper-outbox.sqlite"), prefix);

/**
 * Review F2: a closure whose plan was sent (attempts > 0) but is not recorded as committed may still be on chain (an
 * attempt that timed out and mined, a crash before the save). When capacity returns it is abandoned only once this
 * tick's reconciliation read commitments(plan.id) as absent at this very block: capacity is back at it, so no commit
 * can land after it. Without that read the closure is held (its file kept) for up to ABANDON_HOLD_MAX_MS, then
 * abandoned with its file KEPT and a sev-1, so a person can check and settle by hand.
 */
export const ABANDON_HOLD_MAX_MS = 15 * 60_000;
export type AbandonDecision = "abandon" | "hold" | "abandon-keep-file";

/** The rule above, pure: `absent` is this tick's reconciliation (plan ids read as absent at `absent.atBlock`). */
export function abandonDecision(
  plan: { id: string; attempts: number } | undefined, absent: { atBlock: number; ids: Set<string> },
  atBlock: number, heldSinceMs: number | undefined, nowMs: number,
): AbandonDecision {
  if (!plan || plan.attempts === 0) return "abandon";                                      // never sent: nothing on chain
  if (absent.atBlock === atBlock && absent.ids.has(plan.id.toLowerCase())) return "abandon";   // read absent at this block
  if (heldSinceMs === undefined || nowMs - heldSinceMs < ABANDON_HOLD_MAX_MS) return "hold";
  return "abandon-keep-file";
}

const abandonHolds = new Map<string, number>();

/** The abandon branch's decision for one closure, with its hold bookkeeping, log line and alarm. */
function abandonStep(open: Closure, atBlock: number, nowMs: number): AbandonDecision {
  const key = `${open.wrapper.toLowerCase()}:${open.cutBlock}`;
  const decision = abandonDecision(open.plan, onchainWatch.planAbsent, atBlock, abandonHolds.get(key), nowMs);
  if (decision === "hold") {
    if (!abandonHolds.has(key)) {
      abandonHolds.set(key, nowMs);
      log("closure-abandon-held", { symbol: open.symbol, cutBlock: open.cutBlock, plan: open.plan?.id, attempts: open.plan?.attempts,
        reason: "capacity returned; the plan was sent and Scorecard has not been read for it yet" });
    }
    return decision;
  }
  abandonHolds.delete(key);
  if (decision === "abandon-keep-file") {
    raise(1, `keeper:abandon-unconfirmed:${open.symbol}`,
      `${open.symbol}: plan ${open.plan!.id} was sent ${open.plan!.attempts} time(s) and Scorecard could not be read for it in ${Math.round(ABANDON_HOLD_MAX_MS / 60_000)} min; `
      + `abandoning the closure and KEEPING its swap file: check commitments(${open.plan!.id}) and settle by hand if it is on chain`);
  }
  return decision;
}

/** Review F2: a sent plan found on chain by the reconciliation is recorded as committed, as a ClosureExists would. */
function adoptPlan(c: Closure, nowMs: number, health: Health): void {
  const plan = c.plan;
  if (!plan || c.committed) return;
  const m = outboxMined(`commit:${plan.root}:`);
  c.committed = {
    id: plan.id, root: plan.root, settleAfterS: plan.settleAfterS, markE18: plan.markE18, bandBps: plan.bandBps,
    onChain: true, txHash: m?.hash ?? "", atMs: nowMs, ...(m ? { block: m.block } : {}),
  };
  health.committedTotal++;
  health.lastCommit = { symbol: c.symbol, id: plan.id, root: plan.root, mark: plan.markE18, tx: m?.hash ?? "", block: m?.block ?? null };
  log("committed", {
    symbol: c.symbol, id: plan.id, root: plan.root, settleAfter: new Date(plan.settleAfterS * 1000).toISOString(),
    mark: plan.markE18, band: plan.bandBps, tx: m?.hash ?? "", block: m?.block ?? null, attempt: plan.attempts, via: "reconcile",
  });
}

type SendPort = Pick<Sender, "prepare" | "broadcastAndWait">;

/** The keeper's only send path (W5.2): every commit and settle goes through sendOnce, which reads the receipt status. */
function sendTx(sender: SendPort, to: string, data: string, meta: { id: string; kind: "commit" | "settle"; targetMs: number }) {
  sendWatch.sends++;
  return sendOnce(sender, to, data, meta);
}

/**
 * W5.3: everything that happens to a closure after its frozen plan is on disk (W6). The ONE caller of
 * commitAttempt, and so the one place a commit is signed. commitPass (W4b's loop) calls it once per due closure
 * per tick, after `saveState` returned with `c.plan` set:
 *
 *     await sendCommit(c, { sender, health, nowMs, lastChance, save: () => saveState(state) });
 *
 * - `CFG.mode !== "live"`: the shadow branch, as HEAD (log shadow-mark; committed {onChain: false}).
 * - live without a Sender, or not armed (isKeeper and LOW_BALANCE_WEI): nothing is recorded; log
 *   commit-held-unarmed and sev-1 keeper:commit-held-unarmed:<symbol>; retried next tick. (HEAD turned this into a
 *   permanent shadow mark, SFS B1.)
 * - otherwise commitAttempt: attempts++ then `d.save()` before the send (an attempt that cannot be saved sends
 *   nothing), sendOnce, the outcome applied to `c.committed` (only status 1 of our transaction, an earlier attempt of
 *   the same plan, or a ClosureExists refusal records it), `d.save()` again if the books changed.
 * `lastChance`: the next tick would fall below COMMIT_FLOOR_S, so an unresolved transaction pages sev-1, not sev-2.
 * It never throws for an outcome; alarms are queued, never awaited. `cfg` exists for tests only.
 */
export async function sendCommit(
  c: Closure,
  d: { sender: SendPort | null; health: Health; nowMs: number; lastChance: boolean; save(): void; minedEarlier?: MinedEarlier },
  cfg: { mode: string; scorecard: string } = CFG,
): Promise<void> {
  const plan = c.plan;
  if (!plan || c.committed) return;
  if (cfg.mode !== "live") {
    log("shadow-mark", {
      symbol: c.symbol, id: plan.id, root: plan.root,
      settleAfter: new Date(plan.settleAfterS * 1000).toISOString(),
      mark: plan.markE18, band: plan.bandBps,
    });
    c.committed = { id: plan.id, root: plan.root, settleAfterS: plan.settleAfterS, markE18: plan.markE18, bandBps: plan.bandBps, onChain: false, txHash: "", atMs: d.nowMs };
    return;
  }
  if (!d.health.armed || !d.sender) {
    log("commit-held-unarmed", { symbol: c.symbol, root: plan.root, sender: d.sender !== null, isKeeper: d.health.isKeeper, balanceWei: d.health.balanceWei ?? null });
    raise(1, `keeper:commit-held-unarmed:${c.symbol}`,
      `commit for ${c.symbol} is due but the keeper cannot send it (sender=${d.sender !== null}, isKeeper=${d.health.isKeeper}, balanceWei=${d.health.balanceWei ?? "unknown"}); retrying every tick`);
    return;
  }
  const sender = d.sender;
  const r = await commitAttempt(c as Closure & { plan: CommitPlan }, {
    save: d.save, nowMs: d.nowMs, lastChance: d.lastChance, minedEarlier: d.minedEarlier ?? outboxMined,
    send: (id) => sendTx(sender, cfg.scorecard, plan.data, { id, kind: "commit", targetMs: d.nowMs }),
  });
  log(r.event, r.fields);
  if (r.alarm) raise(...r.alarm);
  if (r.saveError) log("state-persist-failed", { where: "commit-outcome", symbol: c.symbol, error: r.saveError });
  const recorded = c.committed as Committed | undefined;   // set by commitAttempt
  if (r.result === "committed" && recorded) {
    d.health.committedTotal++;
    d.health.lastCommit = { symbol: c.symbol, id: plan.id, root: plan.root, mark: plan.markE18, tx: recorded.txHash, block: recorded.block ?? null };
  }
}

function dropPending(state: State, c: Closure): void {
  state.pending = state.pending.filter((x) => x !== c);
}

type RemoveFile = (c: { wrapper: string; cutBlock: number }) => void;

/**
 * W3: delete a finished row's swap file through the store. Never throws (EIO, a full disk: logged, and the file is
 * then an orphan that /healthz counts). A row put back in `pending` from an old `recent` entry may carry no file
 * name (wrapper ""): there is nothing to delete.
 */
function removeSwapFile(c: { symbol: string; wrapper: string; cutBlock: number }, remove: RemoveFile = (x) => store.remove(x)): void {
  if (!c.wrapper || !c.cutBlock) return;
  try { remove({ wrapper: c.wrapper, cutBlock: c.cutBlock }); }
  catch (e) { log("swap-file-remove-failed", { symbol: c.symbol, cutBlock: c.cutBlock, error: e instanceof Error ? e.message : String(e) }); }
}

/** A row the chain has settled (by us or anyone): out of `pending`, into `recent`, its swap file deleted (W3). */
function settleRow(state: State, c: Closure & { committed: Committed }, how: { tx: string; block?: number; by: "keeper" | "chain"; atMs: number }, remove?: RemoveFile): void {
  dropPending(state, c);
  c.settled = { txHash: how.tx, atMs: how.atMs };
  recordSettled(state, c, how);
  removeSwapFile(c, remove);
}

/** A row that can no longer be settled: out of `pending`, into `expired` (last 50), its swap file deleted (W3). */
function expireRow(state: State, c: Closure & { committed: Committed }, reason: ExpiredRef["reason"], atMs: number, remove?: RemoveFile): void {
  dropPending(state, c);
  recordExpired(state, c, reason, atMs);
  removeSwapFile(c, remove);
}

/** A recent row the chain shows unsettled, back in `pending` with its attempt numbering (reconcile.ts). */
function closureFromRecent(ref: SettledRef): Closure {
  const r = rowFromRecent(ref);
  return {
    wrapper: r.wrapper, symbol: r.symbol, cutAtMs: 0, cutBlock: r.cutBlock, midAtCutE18: "0", preCutMidE18: null,
    witnessedCut: true, reopenMs: null, swapCount: 0, settleAttempts: r.settleAttempts,
    committed: {
      id: r.committed.id, root: r.committed.root, settleAfterS: r.committed.settleAfterS, markE18: "", bandBps: 0,
      onChain: true, txHash: r.committed.txHash, atMs: r.committed.atMs,
      ...(r.committed.block !== undefined ? { block: r.committed.block } : {}),
    },
  };
}

/**
 * Tick step 5 (W5.5): settlements(id) for every owed and recent row, commitments(id) for every open closure recorded
 * on chain, at the pinned block, raced against 5 s. Corrections need two consecutive disagreeing reads and a read at
 * least 10 blocks past a known receipt. Never throws; a skipped reconciliation corrects nothing.
 */
async function reconcileStep(state: State, block: { number: number; hash: string; timestamp: number; rpc: string }, nowMs: number, health: Health): Promise<void> {
  onchainWatch.settledNow = null;
  onchainWatch.planAbsent = { atBlock: -1, ids: new Set() };
  try {
    pruneRecent(state, nowMs);
    if (CFG.scorecard === ZERO) return;
    const calls = reconcileCalls(state, CFG.scorecard, onchainWatch.cursor);
    if (calls.length > 0) {
      const book = await readChainBook(block, calls, CFG.rpcs, RECONCILE_DEADLINE_MS);
      const corr = reconcile(state, book, block.timestamp, CFG.settleDelayS, onchainWatch.streak);
      onchainWatch.settledNow = book.settled;
      onchainWatch.planAbsent = { atBlock: block.number, ids: new Set(corr.planNotOnChain.map((id) => id.toLowerCase())) };
      const rep = applyCorrections(state, corr, {
        nowMs,
        canRetryCommit: (c) => c.plan !== undefined && Math.floor((c.plan.settleAfterS * 1000 - Date.now()) / 1000) >= CFG.commitFloorS,
        revive: closureFromRecent,
        adoptPlan: (c) => adoptPlan(c, nowMs, health),
        remove: (c) => store.remove(c),
        raise, log,
      });
      if (rep.settled + rep.reopened + rep.expired + rep.uncommitted + rep.commitLost + rep.adopted > 0) log("reconciled", { block: block.number, ...rep });
    }
    onchainWatch.lastOkBlock = block.number;
  } catch (e) {
    onchainWatch.skipped++;
    log("reconcile-skipped", { block: block.number, error: e instanceof Error ? e.message : String(e) });
  }
}

/** /healthz `onchain` (W10.3): Scorecard's own count beside the keeper's books. */
function onchainHealth(state: State, chainNowS: number): NonNullable<Health["onchain"]> {
  const pastDue = state.pending
    .filter((c) => c.committed?.onChain && chainNowS > settleWindow(c.committed.settleAfterS, CFG.settleDelayS).readyAt + 600)
    .map((c) => c.committed!.id);
  return {
    closureCount: onchainWatch.closureCount, pending: state.pending.length, pendingPastDue: pastDue.slice(0, 10),
    recent: state.recent?.length ?? 0, expired: state.expired?.length ?? 0,
    reconcile: { lastOkBlock: onchainWatch.lastOkBlock, skipped: onchainWatch.skipped },
  };
}

/** W4b: stop waiting for data about 6.5 minutes before the reopen; leaves about 8 ticks to send. */
const MUST_COMMIT_MARGIN_S = 240;
/** What a tick hands commitPass and buildPlan (W4b.1). `lastTickS` is the previous tick's duration in seconds. */
export interface TickCtx { heads: number[]; chainNowS: number; lastTickS: number; tickStartMs: number }

/**
 * W4b.1, per closure: when the next tick can be expected (a tick's length, or the last tick's duration plus slack
 * if it ran long); `mustCommit` when no later tick could still plan and leave time to send (stop waiting for data,
 * commit an honest row); `lastChance` when no later tick could still send above COMMIT_FLOOR_S.
 */
export function commitTiming(toReopenS: number, lastTickS: number, cfg: { tickMs: number; commitFloorS: number }):
  { nextTickS: number; mustCommit: boolean; lastChance: boolean } {
  const nextTickS = Math.max(cfg.tickMs / 1000, lastTickS + 10);
  return {
    nextTickS,
    mustCommit: toReopenS - nextTickS < cfg.commitFloorS + MUST_COMMIT_MARGIN_S,
    lastChance: toReopenS - nextTickS < cfg.commitFloorS,
  };
}

/**
 * W4b.1: every due closure, earliest reopen first, each with its own clock and its own try. A closure without a
 * plan is planned (buildPlan: bounded network work, a self-checked bundle on disk); the plan is saved (W6) before
 * sendCommit (W5) signs anything. Before the must-commit point the plan defers while data can still arrive; at it,
 * buildPlan commits an honestly degraded row; `lastChance` is the last tick that can still land a transaction.
 */
async function commitPass(
  state: State, assets: Asset[], venues: Map<string, Venue>, poolSnap: MulticallSnapshot,
  reads: Map<string, { priceE18: bigint }>, sender: Sender | null, health: Health, digest: string, t: TickCtx,
) {
  const due = (c: Closure) => (c.plan ? c.plan.settleAfterS * 1000 : c.reopenMs ?? Number.POSITIVE_INFINITY);
  const order = Object.keys(state.open).sort((x, y) => {
    const dx = due(state.open[x]), dy = due(state.open[y]);
    return dx < dy ? -1 : dx > dy ? 1 : 0;
  });
  for (const w of order) {
    const c = state.open[w];
    try {
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
        const nowMs = Date.now();
        if (nowMs - c.cutAtMs > 30 * 60_000) {
          raise(1, `keeper:no-reopen:${c.symbol}`, `${c.symbol} has been shut for ${Math.round((nowMs - c.cutAtMs) / 60_000)}m with no venue schedule; no row can be committed`);
        }
        continue;
      }
      // W7: a closure whose cut the venue schedule has not confirmed (unchecked, suspect or unanchorable) is never
      // planned. A plan that already exists (frozen before this build) is sent as frozen.
      // The keeper/verifier reopen agreement is buildPlan's first step: venueEvidenceFor commits this closure's
      // schedule (ledger included), defers when the live prediction moved, and refuses unless that schedule walked
      // from the cut gives settleAfterS (I10, what every verifier re-derives) and says the market is shut now (I11).
      if (!c.plan && c.cutSuspect !== false) continue;
      if (c.reopenMs - c.cutAtMs < CFG.minClosureS * 1000) {
        if (!c.skipLogged) {
          c.skipLogged = true;
          log("closure-too-short", { symbol: c.symbol, seconds: Math.round((c.reopenMs - c.cutAtMs) / 1000), floor: CFG.minClosureS });
        }
        continue;
      }

      const nowMs = Date.now();                                            // per closure (CO B1)
      const toReopenS = Math.floor((due(c) - nowMs) / 1000);
      if (toReopenS > CFG.commitLeadS) continue;
      if (toReopenS < CFG.commitFloorS) {
        // We arrived too late to land a transaction that the contract would still accept.
        raise(1, `keeper:commit-missed:${c.symbol}:${c.cutBlock}`, `missed the commit window for ${c.symbol}: ${toReopenS}s to reopen`);
        continue;
      }
      const { mustCommit, lastChance } = commitTiming(toReopenS, t.lastTickS, CFG);

      if (!c.plan) {
        const built = await buildPlan(c, a, venue, assets, poolSnap, read.priceE18, digest, { ...t, nowMs, mustCommit });
        if (!built) continue;                                // deferred or refused: nothing signed, nothing to persist
        c.plan = built;
        // W6: the frozen plan is on disk before any transaction carrying it is signed, so a restart can only
        // reuse it (buildPlan runs only for a closure without one). If it cannot be saved, it stays in memory and
        // nothing is sent; the attempt below saves it again before the first signature.
        try { saveState(state); }
        catch (e) {
          log("state-persist-failed", { where: "plan", symbol: c.symbol, error: String(e) });
          raise(1, "keeper:state-persist-failed", `cannot persist the plan for ${c.symbol}; nothing is sent until it is: ${String(e)}`);
          continue;
        }
      }
      // W5.3: everything after the saved plan is sendCommit's: shadow, held-unarmed, or one commitAttempt.
      await sendCommit(c, { sender, health, nowMs, lastChance, save: () => saveState(state) });
    } catch (e) {
      log("plan-error", { symbol: c.symbol, error: e instanceof Error ? e.message : String(e) });
      raise(2, `keeper:plan-error:${c.symbol}`, String(e));                // the closure is retried next tick
    }
  }
}

/**
 * W4b.2: build the round, publish its evidence, and freeze the exact calldata. Undefined when deferred, refused or
 * unmarkable (nothing is signed). In this order, so the only network work is the closure's own remaining gaps:
 *  1. the venue evidence and the reopen agreement (no network); 2. fillForCommit, bounded; 3. the pure assembly of
 *  the swap evidence (W4a); 4. block-time sanity; 5. the signal; 6. the round; 7. the strict self-check of exactly
 *  what a stranger will download; 8. evidence on disk and queued for the archive; 9. the frozen plan.
 * Exported for the W4b end-to-end test (main.test.ts), which drives it on the real 13 Nov recess evidence.
 */
export async function buildPlan(
  c: Closure, a: Asset, venue: Venue, assets: Asset[], poolSnap: MulticallSnapshot,
  midNowE18: bigint, digest: string, t: TickCtx & { nowMs: number; mustCommit: boolean },
): Promise<CommitPlan | undefined> {
  const settleAfterS = Math.floor(c.reopenMs! / 1000);
  const method = MARK_METHODS[MARK_METHOD_VERSION];
  const pinnedBlock = poolSnap.block.number;
  const nowMs = t.nowMs;

  // 1. Schedule checks, no network (W7): the committed schedule, I10, I11.
  const ve = venueEvidenceFor(c, venue, nowMs, settleAfterS);
  if (ve.kind === "defer") {
    if (ve.reopenMs !== null) c.reopenMs = ve.reopenMs;
    log("plan-deferred", { symbol: c.symbol, reason: ve.reason });
    return undefined;
  }
  if (ve.kind === "refuse") {
    c.refusals = (c.refusals ?? 0) + 1;
    log("mark-refused", { symbol: c.symbol, key: ve.alarmKey, reason: ve.message });
    raise(1, ve.alarmKey, ve.message);
    return undefined;
  }

  // 2. The closure's own gaps, bounded (W2.6): normally one chunk, the tail. Every wait has a deadline.
  const tracked: Tracked = { c, pool: getAddress(a.pool) };
  const fill = await fillForCommit(store, tracked, a, pinnedBlock, {
    rpcs: CFG.rpcs, heads: t.heads, maxChunks: 20,
    deadlineMs: Math.min(10_000, Math.max(2_000, CFG.tickMs - (Date.now() - t.tickStartMs) - 5_000)), recentHashes,
    onScan: (scan, rep) => { noteScan("fill", scan); noteIngest("fill", rep, [tracked]); },
  });
  if (fill.reset) raise(1, `keeper:swap-file-lost:${c.symbol}`, `${c.symbol}: closure file shorter than its coverage; rebuilding`);
  if (fill.error) log("swap-fill-error", { symbol: c.symbol, error: fill.error });
  // The file as it is now. A file that cannot be read counts as nothing covered (all gaps), never as an empty pool.
  let rows: SwapRow[] = [];
  let ranges: Array<[number, number]> = [];
  try {
    const file = store.read(c, pinnedBlock);
    if (file.reset) raise(1, `keeper:swap-file-lost:${c.symbol}`, `${c.symbol}: closure file shorter than its coverage at commit time; rebuilding`);
    rows = file.rows;
    ranges = c.coverage?.ranges ?? [];
  } catch (e) {
    log("swap-file-read-failed", { symbol: c.symbol, error: String(e) });
    raise(1, `keeper:swap-store-write-failed:${c.symbol}`, `${c.symbol}: cannot read the closure file at commit time; treated as uncovered: ${String(e)}`);
  }

  // 3. Pure assembly (W4a): the input is derived from the swap lists; defer while gaps or inconsistencies can still
  // be fixed; at the must-commit point degrade honestly. The one refusal left is D2's.
  const ev = assembleSwapEvidence({
    symbol: c.symbol, pool: getAddress(a.pool), cutBlock: c.cutBlock, cutAtMs: c.cutAtMs,
    cutBlockHash: c.cutBlockHash ?? null, cutRead: c.cutRead ?? null, pinnedBlock, closingWindowMs: method.closingVwapWindowMs,
    rows, ranges, midAtCutE18: BigInt(c.midAtCutE18), midNowE18,
    preCutMidE18: c.preCutMidE18 === null ? null : BigInt(c.preCutMidE18), mustCommit: t.mustCommit,
  });
  if (ev.kind === "defer") {
    log("plan-deferred", { symbol: c.symbol, reason: ev.reason, gapsLeft: fill.gapsLeft.length, fillStop: fill.stopReason });
    return undefined;
  }
  if (ev.kind === "refuse") {
    c.refusals = (c.refusals ?? 0) + 1;
    log("mark-refused", { symbol: c.symbol, key: ev.alarmKey, reason: ev.message });
    raise(1, ev.alarmKey, ev.message);
    return undefined;
  }
  if (!ev.closingComplete) {
    raise(1, `keeper:closing-window-incomplete:${c.symbol}`, `${c.symbol}: committing without a closing window (${ev.degraded.join(",") || "gap"}); closingVwap falls back to the last print`);
  }
  if (!ev.complete) {
    raise(ev.degraded.includes("closure-inconsistent") ? 1 : 2, `keeper:swap-coverage-incomplete:${c.symbol}`,
      `${c.symbol}: committing with gaps ${JSON.stringify(ev.gaps)}; ${ev.input.swapsDuringClosure} swaps recorded`);
  }

  // 4. Block-time sanity (CV m4): the 900-block closing window assumes one block per second. Never a refusal.
  const cutTsS = c.cutRead?.blockTimestamp ?? Math.floor(c.cutAtMs / 1000);
  const driftS = (poolSnap.block.timestamp - cutTsS) - (pinnedBlock - c.cutBlock);
  if (Math.abs(driftS) > 60) {
    raise(1, `keeper:block-time-drift:${c.symbol}`, `${c.symbol}: ${pinnedBlock - c.cutBlock} blocks took ${poolSnap.block.timestamp - cutTsS}s since the cut (drift ${driftS}s); the closing window assumes one block per second`);
  }

  // 5. mark/2's cross-market evidence, fetched now (the commit time) with a per-request timeout. It can
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

  // 6. The round: the mark input from the assembled evidence, the venue from venueEvidenceFor.
  const round = buildMarkRound({
    chainId: CFG.chainId, clock: CFG.clock, scorecard: CFG.scorecard,
    evaluatedAtMs: nowMs, codeDigest: digest, specs: assets, chain: poolSnap,
    closures: [{
      wrapper: c.wrapper, symbol: c.symbol, cutAtMs: c.cutAtMs, cutBlock: c.cutBlock, settleAfterS,
      input: {
        wrapper: c.wrapper, symbol: c.symbol,
        lastPrintE18: ev.input.lastPrintE18,
        midAtCutE18: BigInt(c.midAtCutE18),
        midNowE18,
        closingVwapE18: ev.input.closingVwapE18,
        swapsDuringClosure: ev.input.swapsDuringClosure,
      },
      closingSwaps: ev.closingSwaps, closureSwaps: ev.closureSwaps, swapEvidence: ev.swapEvidence, venue: ve.evidence,
      ...(signal ? { signal: { exchanges: signal.exchanges, attempts: signal.attempts } } : {}),
    }],
  });
  const built = round.marks[0];
  if (!built) { log("mark-skipped", { symbol: c.symbol, reason: "not enough evidence for a mark" }); return undefined; }

  // 7. The strict self-check, on exactly the bytes a stranger will download: never sign what the verifier rejects.
  const check = verifyMarkBundleOffline(JSON.parse(JSON.stringify(round.bundle)), { era: "swap-evidence" });
  if (!check.ok) {
    log("mark-self-check-failed", { symbol: c.symbol, root: round.root, failures: check.failures });
    raise(1, `keeper:mark-self-check-failed:${c.symbol}`, check.failures.slice(0, 5).join("; "));
    return undefined;
  }

  // 8. Evidence first, always: a row whose bundle was not on disk before the signature is a number
  // we would be asking people to take on trust.
  persistOnce(join(CFG.dataDir, "marks", `${round.root}.json`), JSON.stringify(round.bundle));
  publisher.enqueue(`marks/${round.root.toLowerCase()}.json`, join(CFG.dataDir, "marks", `${round.root}.json`));
  log("mark-built", {
    symbol: c.symbol, root: round.root, mark: built.mark.markE18, band: built.mark.bandBps,
    drift: built.mark.driftBps, closingSwaps: ev.closingSwaps.length, swaps: ev.input.swapsDuringClosure, flags: built.mark.flags,
    complete: ev.complete, closingComplete: ev.closingComplete, gaps: ev.gaps, omitted: ev.swapEvidence.closureOmitted,
    degraded: ev.degraded, mustCommit: t.mustCommit,
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

  // 9. The frozen plan (unchanged shape).
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

/**
 * W5.4: settle every row this keeper owes, on chain time (`chainNowS` is the pinned block's timestamp: Scorecard
 * compares block.timestamp, not the VPS clock). Each row is isolated: a throw keeps that row and moves on.
 * - Sent only inside [readyAt, deadline - 60] (readyAt = settleAfter + SETTLE_DELAY, deadline = readyAt +
 *   SETTLE_WINDOW) and only when canSettle: live, a Sender, the last known balance >= 0.0001 OKB. No isKeeper:
 *   settle is permissionless (CO m6). The attempt counter is saved first; if that save fails the settle still goes
 *   out (settle is idempotent on chain, and the next attempt number is new either way).
 * - Only a status-1 receipt of OUR settle, or of an earlier attempt of the same row that a replacement superseded,
 *   settles a row. A status-0 receipt (row 151: PriceDeviates on chain) keeps it owed, and the next tick retries.
 * - Refused AlreadySettled: settled by the chain. TooLate, or past deadline - 60: expired, sev-1. UnknownClosure:
 *   expired as commit-lost, sev-1. NoPriceSource: kept, sev-1. Anything else: kept, retried.
 * - Still owed an hour after readyAt: sev-1 keeper:settle-late:<id> (5 of the 6 hours are left for a person).
 */
async function settlePass(state: State, sender: Sender | null, health: Health, chainNowS: number, nowMs: number): Promise<void> {
  await settleRows(state, {
    mode: CFG.mode, scorecard: CFG.scorecard, settleDelayS: CFG.settleDelayS, sender, health,
    balanceWei: onchainWatch.lastBalanceWei, chainNowS, nowMs, save: () => saveState(state), raise, log,
    minedEarlier: outboxMined,
    settledRead: (id) => onchainWatch.settledNow?.get(id.toLowerCase()) ?? null,
  });
}

/** settlePass with its configuration and effects passed in (exported for the W5 tests). */
export async function settleRows(
  state: State,
  d: {
    mode: string; scorecard: string; settleDelayS: number; sender: SendPort | null;
    health: Pick<Health, "settledTotal" | "lastSettle">; balanceWei: bigint | null; chainNowS: number; nowMs: number;
    save(): void; raise(sev: 1 | 2, key: string, message: string): void; log(event: string, fields?: Record<string, unknown>): void;
    /** W3: how a finished row's swap file is deleted (default: the module's store; tests pass a recorder). */
    removeFile?: RemoveFile;
    /** Review F5: an earlier attempt's mined receipt from the outbox, by id prefix. */
    minedEarlier?: MinedEarlier;
    /** Review F3: this tick's settlements(id).settled read at the pinned block; null when not read. */
    settledRead?(id: string): boolean | null;
  },
): Promise<void> {
  const { chainNowS, nowMs } = d;
  const can = canSettle(d.mode, d.sender !== null, d.balanceWei);
  for (const c of [...state.pending]) {
    try {
      if (!c.committed || c.settled) { dropPending(state, c); continue; }   // as HEAD: nothing left to settle
      const owed = c as Closure & { committed: Committed };
      const row = { symbol: c.symbol, committed: owed.committed };
      const step = settleStep(row, chainNowS, d.settleDelayS, can);
      if (step.action === "drop-shadow") {
        dropPending(state, c);
        removeSwapFile(c, d.removeFile);   // W3: a shadow row past its window needs its file no more than a settled one
        d.log("shadow-row-dropped", { symbol: c.symbol, id: owed.committed.id });
        continue;
      }
      if (step.action === "expire") {
        // Review F3: a settle sent near deadline - 61 may still mine. Such a row is expired only on a read past the
        // deadline that shows it unsettled (after the deadline nothing can mine), or SETTLE_EXPIRY_GRACE_S after it.
        if ((c.settleAttempts ?? 0) > 0) {
          const { deadline } = settleWindow(owed.committed.settleAfterS, d.settleDelayS);
          const read = d.settledRead?.(owed.committed.id) ?? null;
          if (read === true) {
            const m = d.minedEarlier?.(`settle:${owed.committed.root}:`) ?? null;
            settleRow(state, owed, { tx: m?.hash ?? "", block: m?.block, by: m ? "keeper" : "chain", atMs: nowMs }, d.removeFile);
            if (m) { d.health.settledTotal++; d.health.lastSettle = { symbol: c.symbol, id: owed.committed.id, tx: m.hash, block: m.block }; }
            d.log(m ? "settled" : "settled-by-other", { symbol: c.symbol, id: owed.committed.id, via: "settlements-read", ...(m ? { tx: m.hash, block: m.block } : {}) });
            continue;
          }
          if (!(read === false && chainNowS > deadline) && chainNowS <= deadline + SETTLE_EXPIRY_GRACE_S) {
            d.log("settle-expiry-deferred", { symbol: c.symbol, id: owed.committed.id, read, deadline });
            continue;
          }
        }
        expireRow(state, owed, step.reason, nowMs, d.removeFile);
        d.log("settle-expired", { symbol: c.symbol, id: owed.committed.id, reason: step.reason });
        d.raise(...step.alarm);
        continue;
      }
      if (step.action === "send" && d.sender) {
        c.settleAttempts = (c.settleAttempts ?? 0) + 1;
        const attempt = c.settleAttempts;
        try { d.save(); }
        catch (e) { d.log("settle-counter-unsaved", { symbol: c.symbol, id: owed.committed.id, attempt, error: String(e) }); }
        // A sender id distinct from the commit's, and distinct per attempt: the outbox is keyed on it.
        const o = await sendTx(d.sender, d.scorecard, scorecardAbi.encodeFunctionData("settle", [owed.committed.id]),
          { id: `settle:${owed.committed.root}:${attempt}`, kind: "settle", targetMs: nowMs });
        const v = settleOutcome(o, row, attempt, d.minedEarlier);
        d.log(v.event, v.fields);
        if (v.books === "settled") {
          settleRow(state, owed, { tx: v.tx, block: v.block, by: v.by, atMs: nowMs }, d.removeFile);
          if (v.by === "keeper") {
            d.health.settledTotal++;
            d.health.lastSettle = { symbol: c.symbol, id: owed.committed.id, tx: v.tx, block: v.block ?? null };
          }
          continue;
        }
        if (v.books === "expire") {
          expireRow(state, owed, v.reason, nowMs, d.removeFile);
          d.raise(...v.alarm);
          continue;
        }
        if (v.alarm) d.raise(...v.alarm);
      }
      const late = settleLateAlarm(row, chainNowS, d.settleDelayS);
      if (late) d.raise(...late);
    } catch (e) {
      d.log("settle-error", { symbol: c.symbol, id: c.committed?.id ?? null, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function startHttp(health: Health) {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/healthz") {
      const ok = health.ticks > 0 && Date.now() - health.lastTickOkMs < 6 * CFG.tickMs;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(healthBody(health, ok)));
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
