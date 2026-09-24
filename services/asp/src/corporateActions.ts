/**
 * Corporate actions as a free, read-only feed. Nothing here reaches the attestor or any writer.
 *
 * Why it exists. An xStock's multiplier moves for dividends, splits, spin-offs and mergers, and on-chain the
 * move is only a timestamp and a counter: getCurrentMultiplier() starts returning a new value and a new nonce
 * at the activation time, with no event. The ONLY record of what a step was -- income or a 2:1 reverse split --
 * is the issuer's versioned corporate-actions history. That history is not a log either. The same `eventId`
 * comes back at higher versions, a version can be Cancelled and re-issued as Corrected, and future actions are
 * listed before they happen. A one-shot import gives confidently wrong numbers (docs/MARKETCLOCK.md).
 *
 * So this module:
 *   - sweeps EVERY page of /corporate-actions/history every 30 minutes (sources/corporateActions.ts). Nodes are
 *     sorted by effective time descending and new ones land on page 1, so only a full sweep is complete;
 *   - persists every (eventId, version) it ever sees, write-once, under DATA_DIR/corporate-actions/versions/.
 *     Cancelled and Corrected versions are kept, and nothing is overwritten. If the issuer later serves
 *     different content under a key already stored, the first copy stands, and the new one is kept beside it
 *     under conflicts/ and counted;
 *   - reads the current multiplier, nonce and pending action of the cohort's raw tokens (one pinned multicall),
 *     and keeps the first sighting of each (raw, nonce) write-once under chain/;
 *   - links each on-chain nonce step to the version whose multiplierNew matches it (buildLineage). The walk is
 *     anchored on the chain's current (nonce, multiplier) and goes back through each matched version's
 *     multiplierOld to nonce 0. A split must also hold as integers: new * fromUnits == old * toUnits;
 *   - reports every step it cannot explain in /healthz (`corporateActions.unexplained`).
 *
 * Serving is memory-only: /v1/corporate-actions and /v1/corporate-actions/lineage read what the last pass left,
 * and /healthz reads a precomputed status. The loop (run) is detached and nothing awaits it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import { hashJson } from "./hash.ts";
import { persistOnce } from "./persist.ts";
import type { Asset } from "./cohort.ts";
import type { Log } from "./log.ts";
import { silentLog } from "./log.ts";
import { CA_MAX_PAGES } from "./sources/corporateActions.ts";
import type { CaPage, ChainMultipliers } from "./sources/corporateActions.ts";
import type { RawTokenState } from "./sources/chain.ts";

export const CA_SCHEMA = "curb.asp.corporate-actions/1";
export const CA_LINEAGE_SCHEMA = "curb.asp.corporate-action-lineage/1";
export const CA_VERSION_FILE_SCHEMA = "curb.asp.corporate-action-version/1";
export const CA_OBSERVATION_SCHEMA = "curb.asp.multiplier-observation/1";

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

/** One issuer node, verbatim. Only the fields this module reads are typed; the rest are kept and served as-is. */
export interface CaRecord {
  eventId: string;
  version: number;
  xstockSymbol: string;
  caType: string;
  status: string;
  effectiveTimeUtc?: string | null;
  createdTimeUtc?: string | null;
  multiplierOld?: string | null;
  multiplierNew?: string | null;
  fromUnits?: string | null;
  toUnits?: string | null;
  [k: string]: unknown;
}

export interface StoredVersion {
  record: CaRecord;
  /** keccak256 of the record's RFC 8785 canonical JSON (hash.ts hashJson). */
  recordHash: string;
  firstSeenMs: number;
}

/** The node itself when it carries what a version needs, otherwise null. Never copies: stored bytes are the node's. */
export function validateNode(n: unknown): CaRecord | null {
  if (typeof n !== "object" || n === null || Array.isArray(n)) return null;
  const r = n as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!str(r.eventId, 128) || !str(r.xstockSymbol, 32) || !str(r.caType, 64) || !str(r.status, 32)) return null;
  if (typeof r.version !== "number" || !Number.isSafeInteger(r.version) || r.version < 0) return null;
  return r as CaRecord;
}

export const versionKey = (eventId: string, version: number) => `${eventId}#${version}`;

const SAFE_ID = /^[A-Za-z0-9-]{1,80}$/;
/** A file name for a key. eventId comes off the network, so anything but a plain id is hashed first. */
export function versionFileName(eventId: string, version: number): string {
  const id = SAFE_ID.test(eventId) ? eventId : `x${hashJson(eventId).slice(2, 42)}`;
  return `${id}.v${version}.json`;
}

const timeOf = (s: unknown) => {
  const t = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/** Newest first: by the version's own creation time, then the higher version, then eventId for a total order. */
export function newestFirst(a: StoredVersion, b: StoredVersion): number {
  const ta = timeOf(a.record.createdTimeUtc), tb = timeOf(b.record.createdTimeUtc);
  if (ta !== tb) return tb > ta ? 1 : -1;
  if (a.record.version !== b.record.version) return b.record.version - a.record.version;
  return a.record.eventId < b.record.eventId ? -1 : a.record.eventId > b.record.eventId ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// exact decimals: the feed's multipliers are decimal strings, the chain's are 18-decimal integers
// ---------------------------------------------------------------------------------------------

/** A non-negative decimal as an integer and a count of decimal places: "0.5120473566533945" = {5120473566533945n, 16}. */
export interface Dec { int: bigint; scale: number }

export function parseDec(v: unknown): Dec | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,40})(?:\.(\d{1,40}))?$/.exec(v.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  return { int: BigInt(m[1] + frac), scale: frac.length };
}

const pow10 = (n: number) => 10n ** BigInt(n);
export const fromWei = (w: bigint): Dec => ({ int: w, scale: 18 });
export const ONE: Dec = { int: 1n, scale: 0 };

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.scale, b.scale);
  return [a.int * pow10(s - a.scale), b.int * pow10(s - b.scale), s];
}

export function decEq(a: Dec, b: Dec): boolean {
  const [x, y] = align(a, b);
  return x === y;
}

/** The 18-decimal integer the chain would hold, or null when the value carries more than 18 places. */
export function toWei(d: Dec): bigint | null {
  return d.scale <= 18 ? d.int * pow10(18 - d.scale) : null;
}

export function decString(d: Dec): string {
  if (d.scale === 0) return d.int.toString();
  const s = d.int.toString().padStart(d.scale + 1, "0");
  const out = `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

export type MatchKind = "exact" | "feed-precision";
/** A shorter string is only allowed to stand for a longer value when it still carries this many places. */
const MIN_PRECISION_SCALE = 8;

/**
 * Exact when equal as numbers. "feed-precision" when the two differ by less than one unit in the last place
 * of the coarser one, and that one still carries at least 8 places. So "1.0011576563945983" matches
 * 1001157656394598300 wei exactly, a 16-place string can stand for an 18-place value, and "2" can never
 * stand for 2.4.
 */
export function matchDec(a: Dec, b: Dec): MatchKind | null {
  const [x, y, s] = align(a, b);
  if (x === y) return "exact";
  const coarse = Math.min(a.scale, b.scale);
  if (coarse < MIN_PRECISION_SCALE) return null;
  const d = x > y ? x - y : y - x;
  return d < pow10(s - coarse) ? "feed-precision" : null;
}

export interface SplitCheck {
  fromUnits: string;
  toUnits: string;
  /** new * fromUnits == old * toUnits, in integers. */
  exact: boolean;
}

/**
 * The integer check a split must pass. `newM` is the multiplier the step moved TO (the chain's value when it is
 * on-chain), `oldM` the one it moved from. Null when the version declares no units.
 */
export function splitCheck(r: CaRecord, newM: Dec, oldM: Dec | null): SplitCheck | null {
  if (r.fromUnits == null && r.toUnits == null) return null;
  const from = parseDec(r.fromUnits), to = parseDec(r.toUnits);
  const fromUnits = String(r.fromUnits), toUnits = String(r.toUnits);
  if (!from || !to || !oldM) return { fromUnits, toUnits, exact: false };
  const lhs: Dec = { int: newM.int * from.int, scale: newM.scale + from.scale };
  const rhs: Dec = { int: oldM.int * to.int, scale: oldM.scale + to.scale };
  return { fromUnits, toUnits, exact: decEq(lhs, rhs) };
}

/** A version whose units must hold as a ratio for the step to be explained. */
const isSplit = (caType: string) => /Split$/.test(caType);

// ---------------------------------------------------------------------------------------------
// lineage: each on-chain nonce step, linked to the version that explains it
// ---------------------------------------------------------------------------------------------

export interface VersionRef {
  eventId: string;
  version: number;
  status: string;
  caType: string;
  effectiveTimeUtc: string | null;
  createdTimeUtc: string | null;
  multiplierOld: string | null;
  multiplierNew: string | null;
  fromUnits: string | null;
  toUnits: string | null;
}

export interface ChainState {
  nonce: bigint;
  multiplier: bigint;
  newNonce: bigint | null;
  newMultiplier: bigint | null;
  newActivationTime: bigint | null;
  block: number;
  blockTimestamp: number;
  readAtMs: number;
}

export interface Observation {
  nonce: number;
  multiplier: string;
  block: number;
  blockTimestamp: number;
  readAtMs: number;
}

export type UnexplainedReason =
  /** The chain's current nonce step: no version's multiplierNew matches the current multiplier. */
  | "no-matching-version"
  /** A step below the current nonce: the walk back reached a multiplier no version moved to. */
  | "lineage-gap"
  /** The only version that matches was Cancelled. */
  | "only-cancelled-version-matches"
  /** A split whose units do not hold as an integer ratio of the two multipliers. */
  | "split-ratio-mismatch"
  /** A (raw, nonce) seen earlier at a different multiplier than the version the lineage matched. */
  | "observed-step-mismatch"
  /** The multiplier moved while the nonce did not. */
  | "multiplier-changed-without-nonce"
  /** A published, not yet active, multiplier that no version announces. */
  | "pending-without-version";

export interface Unexplained {
  symbol: string;
  wrapper: string;
  raw: string;
  nonce: number;
  /** 18-decimal integer string where the value is on-chain or representable; otherwise the decimal. */
  multiplier: string;
  reason: UnexplainedReason;
}

export interface LineageStep {
  nonce: number;
  /** The multiplier the step moved TO, as the chain holds it (18-decimal integer string) where representable. */
  multiplier: string;
  multiplierDecimal: string;
  /** "chain": read on-chain (the current nonce, or a sighting kept under chain/). "feed": reached by the walk. */
  source: "chain" | "feed";
  observed: Observation | null;
  match: MatchKind | null;
  version: VersionRef | null;
  /** A later version of the same event exists (the matched one was re-issued or cancelled afterwards). */
  supersededBy: number | null;
  split: SplitCheck | null;
}

export interface Lineage {
  symbol: string;
  wrapper: string;
  raw: string;
  chain: {
    block: number;
    blockTimestamp: number;
    readAtMs: number;
    nonce: number;
    multiplier: string;
    pending: null | {
      nonce: number;
      multiplier: string;
      activationTime: number | null;
      activationIso: string | null;
      match: MatchKind | null;
      version: VersionRef | null;
      /** The pending version starts from the current multiplier. */
      followsCurrent: boolean | null;
    };
  } | null;
  /** Newest first: the current nonce down to 1. */
  steps: LineageStep[];
  /** Where the walk ended at nonce 0, with the multiplier it implies there; null when it stopped early. */
  origin: { nonce: 0; multiplier: string; unity: boolean } | null;
  complete: boolean;
  unexplained: Unexplained[];
}

const ref = (r: CaRecord): VersionRef => ({
  eventId: r.eventId, version: r.version, status: r.status, caType: r.caType,
  effectiveTimeUtc: r.effectiveTimeUtc ?? null, createdTimeUtc: r.createdTimeUtc ?? null,
  multiplierOld: r.multiplierOld ?? null, multiplierNew: r.multiplierNew ?? null,
  fromUnits: r.fromUnits ?? null, toUnits: r.toUnits ?? null,
});

const weiOrDecimal = (d: Dec) => toWei(d)?.toString() ?? decString(d);

interface Candidate { r: CaRecord; kind: MatchKind }

/**
 * The version that best explains a move TO `m`: its multiplierNew matches, it actually moved the multiplier
 * (a Cancelled no-op carries new == old), and it has not already explained another step. Ranked: not
 * Cancelled, then exact before feed-precision, then the higher version, then the later creation time.
 */
function bestVersion(versions: readonly CaRecord[], m: Dec, used: ReadonlySet<string>): Candidate | null {
  let best: Candidate | null = null;
  const rank = (c: Candidate) => [c.r.status === "Cancelled" ? 0 : 1, c.kind === "exact" ? 1 : 0, c.r.version, timeOf(c.r.createdTimeUtc)];
  for (const r of versions) {
    if (used.has(versionKey(r.eventId, r.version))) continue;
    const nw = parseDec(r.multiplierNew);
    if (!nw) continue;
    const od = parseDec(r.multiplierOld);
    if (od && decEq(od, nw)) continue;
    const kind = matchDec(m, nw);
    if (!kind) continue;
    const c = { r, kind };
    if (!best) { best = c; continue; }
    const [a, b] = [rank(c), rank(best)];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] > b[i]) best = c;
      break;
    }
  }
  return best;
}

export interface LineageInput {
  symbol: string;
  wrapper: string;
  raw: string;
  /** Every stored version of this symbol, any order. */
  versions: readonly CaRecord[];
  chain: ChainState | null;
  /** The first sighting of each nonce for this raw token (nonce -> observation). */
  observed?: ReadonlyMap<number, Observation>;
}

/** Pure. See the module comment for the walk. */
export function buildLineage(i: LineageInput): Lineage {
  const out: Lineage = { symbol: i.symbol, wrapper: i.wrapper, raw: i.raw, chain: null, steps: [], origin: null, complete: false, unexplained: [] };
  const c = i.chain;
  if (!c) return out;
  const flag = (nonce: number, m: Dec | null, reason: UnexplainedReason) =>
    out.unexplained.push({ symbol: i.symbol, wrapper: i.wrapper, raw: i.raw, nonce, multiplier: m ? weiOrDecimal(m) : "unknown", reason });
  const latestOf = new Map<string, number>();
  for (const r of i.versions) latestOf.set(r.eventId, Math.max(latestOf.get(r.eventId) ?? -1, r.version));

  const anchor = Number(c.nonce);
  const used = new Set<string>();
  let cur: Dec = fromWei(c.multiplier);
  const seenAtAnchor = i.observed?.get(anchor);
  if (seenAtAnchor) {
    const first = parseDec(seenAtAnchor.multiplier);
    if (first && !decEq(fromWei(first.int), cur)) flag(anchor, cur, "multiplier-changed-without-nonce");
  }

  let n = anchor;
  let walked = true;
  while (n > 0) {
    const obs = n === anchor ? (seenAtAnchor ?? null) : (i.observed?.get(n) ?? null);
    const best = bestVersion(i.versions, cur, used);
    const step: LineageStep = {
      nonce: n, multiplier: weiOrDecimal(cur), multiplierDecimal: decString(cur),
      source: n === anchor || obs ? "chain" : "feed", observed: obs,
      match: best?.kind ?? null, version: best ? ref(best.r) : null,
      supersededBy: null, split: null,
    };
    out.steps.push(step);
    if (!best) {
      flag(n, cur, n === anchor ? "no-matching-version" : "lineage-gap");
      walked = false;
      break;
    }
    used.add(versionKey(best.r.eventId, best.r.version));
    const latest = latestOf.get(best.r.eventId) ?? best.r.version;
    step.supersededBy = latest > best.r.version ? latest : null;
    if (best.r.status === "Cancelled") flag(n, cur, "only-cancelled-version-matches");
    if (obs && n !== anchor) {
      const seen = parseDec(obs.multiplier);
      const nw = parseDec(best.r.multiplierNew);
      if (!seen || !nw || !matchDec(fromWei(seen.int), nw)) flag(n, seen ? fromWei(seen.int) : cur, "observed-step-mismatch");
    }
    const old = parseDec(best.r.multiplierOld);
    step.split = splitCheck(best.r, cur, old);
    if (step.split && !step.split.exact && isSplit(best.r.caType)) flag(n, cur, "split-ratio-mismatch");
    if (!old) {
      // The step is explained, but its version does not say what it moved FROM, so the walk cannot go on.
      flag(n - 1, null, "lineage-gap");
      walked = false;
      break;
    }
    cur = old;
    n--;
  }
  if (walked) {
    out.origin = { nonce: 0, multiplier: decString(cur), unity: decEq(cur, ONE) };
    out.complete = true;
  }

  let pending: NonNullable<Lineage["chain"]>["pending"] = null;
  if (c.newNonce !== null && c.newMultiplier !== null && c.newNonce > c.nonce) {
    const pm = fromWei(c.newMultiplier);
    const p = bestVersion(i.versions, pm, used);
    const at = c.newActivationTime !== null && c.newActivationTime > 0n ? Number(c.newActivationTime) : null;
    const pOld = p ? parseDec(p.r.multiplierOld) : null;
    pending = {
      nonce: Number(c.newNonce), multiplier: c.newMultiplier.toString(),
      activationTime: at, activationIso: at === null ? null : new Date(at * 1000).toISOString(),
      match: p?.kind ?? null, version: p ? ref(p.r) : null,
      followsCurrent: pOld ? matchDec(fromWei(c.multiplier), pOld) !== null : null,
    };
    if (!p) flag(Number(c.newNonce), pm, "pending-without-version");
  }
  out.chain = {
    block: c.block, blockTimestamp: c.blockTimestamp, readAtMs: c.readAtMs,
    nonce: anchor, multiplier: c.multiplier.toString(), pending,
  };
  return out;
}

// ---------------------------------------------------------------------------------------------
// the feed: store, sweep, chain read, and what the routes and /healthz serve
// ---------------------------------------------------------------------------------------------

export interface PageSource {
  base: string;
  page(n: number): Promise<CaPage>;
}

export interface CorporateActionsOptions {
  /** DATA_DIR/corporate-actions. */
  dir: string;
  client: PageSource;
  /** Current multiplier state for these raw tokens (sources/corporateActions.ts readMultipliers). */
  readChain: (raws: string[]) => Promise<ChainMultipliers>;
  cohort: () => readonly Asset[];
  /** Full sweep cadence. Default 30 minutes. */
  sweepMs?: number;
  /** Chain read cadence. Default 5 minutes: one multicall. */
  chainMs?: number;
  /** A sweep that has not finished after this long is abandoned. Default 5 minutes. */
  sweepDeadlineMs?: number;
  /** An unexplained step is only published once a sweep at most this old has confirmed it. Default 5 minutes. */
  confirmMs?: number;
  now?: () => number;
  log?: Log;
}

export interface SweepResult {
  ok: boolean;
  pages: number;
  /** Distinct (eventId, version) the sweep returned. */
  records: number;
  totalNodes: number | null;
  added: number;
  conflicts: number;
  malformed: number;
  error: string | null;
}

export interface CorporateActionsHealth {
  /** Pages in the last complete sweep. */
  pages: number | null;
  /** Distinct versions the issuer served in the last complete sweep. */
  records: number | null;
  /** Distinct versions kept, all time (never fewer than any sweep served). */
  versions: number;
  events: number;
  lastSweepMs: number | null;
  lastAttemptMs: number | null;
  stale: boolean;
  lastError: string | null;
  /** A version served with different content under a key already kept. The first copy stands. */
  conflicts: number;
  chain: { asOfBlock: number | null; readAtMs: number | null; lastError: string | null };
  unexplained: Unexplained[];
}

export interface RouteReply { status: number; body: unknown; headers?: Record<string, string> }

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,32}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CACHE = { "cache-control": "public, max-age=60" };

export interface Resolved {
  /** The issuer's symbol, e.g. HONx. */
  symbol: string;
  asset: Asset | null;
  via: "issuer-symbol" | "wrapper-symbol" | "wrapper-address" | "raw-address";
}

export class CorporateActionsFeed {
  readonly dir: string;
  readonly sweepMs: number;
  readonly chainMs: number;
  private readonly client: PageSource;
  private readonly readChainImpl: CorporateActionsOptions["readChain"];
  private readonly cohort: () => readonly Asset[];
  private readonly sweepDeadlineMs: number;
  private readonly confirmMs: number;
  private readonly now: () => number;
  private readonly log: Log;

  private readonly byKey = new Map<string, StoredVersion>();
  private readonly eventIds = new Set<string>();
  /** Lower-cased issuer symbol -> its versions, newest first. */
  private bySymbol = new Map<string, StoredVersion[]>();
  /** Lower-cased issuer symbol -> the symbol as the issuer spells it. */
  private readonly spelling = new Map<string, string>();
  private readonly conflictKeys = new Set<string>();
  /** Lower-cased raw -> nonce -> first sighting. */
  private readonly observed = new Map<string, Map<number, Observation>>();
  /** Lower-cased raw -> last good chain state. */
  private readonly chainState = new Map<string, ChainState>();
  /** Lower-cased raw -> lineage. */
  private lineages = new Map<string, Lineage>();

  private lastSweep: SweepResult | null = null;
  private lastSweepMs: number | null = null;
  private lastAttemptMs: number | null = null;
  private lastError: string | null = null;
  private chainBlock: number | null = null;
  private chainReadAtMs: number | null = null;
  private chainError: string | null = null;
  private chainCohortKey: string | null = null;
  private nextSweepAtMs = 0;
  private nextChainAtMs = 0;
  private sweepBackoffMs = 0;
  private unexplained: Unexplained[] = [];
  private unexplainedKey = "";

  constructor(o: CorporateActionsOptions) {
    this.dir = o.dir;
    this.client = o.client;
    this.readChainImpl = o.readChain;
    this.cohort = o.cohort;
    this.sweepMs = o.sweepMs ?? 30 * 60_000;
    this.chainMs = o.chainMs ?? 5 * 60_000;
    this.sweepDeadlineMs = o.sweepDeadlineMs ?? 5 * 60_000;
    this.confirmMs = o.confirmMs ?? 5 * 60_000;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? silentLog;
  }

  private get versionsDir() { return join(this.dir, "versions"); }
  private get conflictsDir() { return join(this.dir, "conflicts"); }
  private get chainDir() { return join(this.dir, "chain"); }

  // --- persistence ---------------------------------------------------------------------------

  /** Everything a previous process kept. A file that does not parse or does not hash to what it claims is skipped and logged. */
  load(): void {
    for (const f of this.jsonFiles(this.versionsDir)) {
      try {
        const p = JSON.parse(readFileSync(join(this.versionsDir, f), "utf8")) as { schema?: string; recordHash?: string; firstSeenMs?: number; record?: unknown };
        const rec = validateNode(p.record);
        if (p.schema !== CA_VERSION_FILE_SCHEMA || !rec || typeof p.firstSeenMs !== "number" || hashJson(rec) !== p.recordHash) {
          this.log("corporate-actions-skip-file", { file: f, reason: "schema, record or hash does not check" });
          continue;
        }
        this.index({ record: rec, recordHash: p.recordHash, firstSeenMs: p.firstSeenMs });
      } catch (e) {
        this.log("corporate-actions-skip-file", { file: f, reason: describe(e) });
      }
    }
    this.resort(null);
    for (const f of this.jsonFiles(this.conflictsDir)) this.conflictKeys.add(f);
    for (const f of this.jsonFiles(this.chainDir)) {
      try {
        const p = JSON.parse(readFileSync(join(this.chainDir, f), "utf8")) as Observation & { schema?: string; raw?: string };
        if (p.schema !== CA_OBSERVATION_SCHEMA || typeof p.raw !== "string" || !Number.isSafeInteger(p.nonce) || !parseDec(p.multiplier)) continue;
        this.remember(p.raw, { nonce: p.nonce, multiplier: p.multiplier, block: p.block, blockTimestamp: p.blockTimestamp, readAtMs: p.readAtMs });
      } catch (e) {
        this.log("corporate-actions-skip-file", { file: f, reason: describe(e) });
      }
    }
  }

  /** Never throws: load() runs at boot, and an unreadable feed directory must not take the paid routes down with it. */
  private jsonFiles(dir: string): string[] {
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch (e) {
      this.log("corporate-actions-skip-file", { file: dir, reason: describe(e) });
      return [];
    }
  }

  private index(v: StoredVersion): void {
    this.byKey.set(versionKey(v.record.eventId, v.record.version), v);
    this.eventIds.add(v.record.eventId);
    const k = v.record.xstockSymbol.toLowerCase();
    if (!this.spelling.has(k)) this.spelling.set(k, v.record.xstockSymbol);
    const list = this.bySymbol.get(k);
    if (list) list.push(v); else this.bySymbol.set(k, [v]);
  }

  private resort(symbols: Set<string> | null): void {
    for (const [k, list] of this.bySymbol) if (!symbols || symbols.has(k)) list.sort(newestFirst);
  }

  private remember(raw: string, o: Observation): void {
    const k = raw.toLowerCase();
    let m = this.observed.get(k);
    if (!m) this.observed.set(k, (m = new Map()));
    if (!m.has(o.nonce)) m.set(o.nonce, o);
  }

  /**
   * One node into the store. Write-once: a new key is persisted before it is indexed, so memory never holds a
   * version the disk does not. A known key with different content keeps the first copy, and the new one goes
   * to conflicts/ under its own hash.
   */
  private ingest(node: unknown, nowMs: number): "added" | "same" | "conflict" | "malformed" {
    const rec = validateNode(node);
    if (!rec) return "malformed";
    const key = versionKey(rec.eventId, rec.version);
    const recordHash = hashJson(rec);
    const prior = this.byKey.get(key);
    const file = { schema: CA_VERSION_FILE_SCHEMA, firstSeenMs: nowMs, recordHash, record: rec };
    if (prior) {
      if (prior.recordHash === recordHash) return "same";
      const name = versionFileName(rec.eventId, rec.version).replace(/\.json$/, `.${recordHash.slice(2, 18)}.json`);
      if (this.conflictKeys.has(name)) return "same";
      mkdirSync(this.conflictsDir, { recursive: true });
      persistOnce(join(this.conflictsDir, name), JSON.stringify(file));
      this.conflictKeys.add(name);
      this.log("corporate-actions-conflict", { eventId: rec.eventId, version: rec.version, kept: prior.recordHash, served: recordHash });
      return "conflict";
    }
    mkdirSync(this.versionsDir, { recursive: true });
    persistOnce(join(this.versionsDir, versionFileName(rec.eventId, rec.version)), JSON.stringify(file));
    this.index({ record: rec, recordHash, firstSeenMs: nowMs });
    return "added";
  }

  // --- the sweep -----------------------------------------------------------------------------

  /**
   * Every page, until the issuer says there is no next one. A node inserted mid-sweep shifts the rest down a
   * page, so a sweep that saw fewer distinct versions than the issuer's own totalNodes is run once more.
   * Whatever a failed sweep did read is kept: each version is a fact on its own.
   */
  async sweep(): Promise<SweepResult> {
    const started = this.now();
    this.lastAttemptMs = started;
    let result: SweepResult = { ok: false, pages: 0, records: 0, totalNodes: null, added: 0, conflicts: 0, malformed: 0, error: null };
    const touched = new Set<string>();
    for (let round = 1; round <= 2; round++) {
      const seen = new Set<string>();
      result = { ...result, ok: false, pages: 0, records: 0, totalNodes: null, malformed: 0, error: null };
      try {
        for (let n = 1; ; n++) {
          if (n > CA_MAX_PAGES) throw new Error(`more than ${CA_MAX_PAGES} pages`);
          if (this.now() - started > this.sweepDeadlineMs) throw new Error(`sweep deadline of ${this.sweepDeadlineMs} ms passed at page ${n}`);
          const p = await this.client.page(n);
          result.pages++;
          result.totalNodes = p.totalNodes;
          const at = this.now();
          for (const node of p.nodes) {
            const r = this.ingest(node, at);
            if (r === "malformed") { result.malformed++; continue; }
            const rec = node as CaRecord;
            seen.add(versionKey(rec.eventId, rec.version));
            touched.add(rec.xstockSymbol.toLowerCase());
            if (r === "added") result.added++;
            if (r === "conflict") result.conflicts++;
          }
          if (!p.hasNextPage || p.nodes.length === 0) break;
        }
        result.records = seen.size;
        result.ok = true;
      } catch (e) {
        result.records = seen.size;
        result.error = describe(e);
      }
      if (!result.ok || result.totalNodes === null || seen.size + result.malformed >= result.totalNodes) break;
      this.log("corporate-actions-short-sweep", { round, seen: seen.size, totalNodes: result.totalNodes });
    }
    this.resort(touched);
    this.lastSweep = result.ok ? result : this.lastSweep;
    if (result.ok) {
      this.lastSweepMs = this.now();
      this.lastError = null;
    } else {
      this.lastError = result.error;
    }
    this.log(result.ok ? "corporate-actions-sweep" : "corporate-actions-error", {
      pages: result.pages, records: result.records, totalNodes: result.totalNodes, added: result.added,
      conflicts: result.conflicts, malformed: result.malformed, versions: this.byKey.size, ms: this.now() - started,
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  // --- the chain -----------------------------------------------------------------------------

  private cohortRaws(): { key: string; raws: string[] } {
    const raws = [...new Set(this.cohort().map((a) => getAddress(a.raw)))].sort();
    return { key: raws.join(",").toLowerCase(), raws };
  }

  /** The cohort's raw tokens at one block. A token whose read failed keeps its previous state. */
  async readChain(): Promise<boolean> {
    const { key, raws } = this.cohortRaws();
    if (raws.length === 0) {
      this.chainCohortKey = key;
      return true;
    }
    try {
      const snap = await this.readChainImpl(raws);
      const readAtMs = this.now();
      for (const t of snap.tokens) this.observe(t, snap.block.number, snap.block.timestamp, readAtMs);
      this.chainBlock = snap.block.number;
      this.chainReadAtMs = readAtMs;
      this.chainCohortKey = key;
      const failed = snap.tokens.filter((t) => t.readFailed).map((t) => t.raw);
      this.chainError = failed.length ? `getCurrentMultiplier unreadable for ${failed.join(", ")}` : null;
      return true;
    } catch (e) {
      this.chainError = describe(e);
      this.log("corporate-actions-chain-error", { error: this.chainError });
      return false;
    }
  }

  private observe(t: RawTokenState, block: number, blockTimestamp: number, readAtMs: number): void {
    if (t.readFailed || t.multiplier === null || t.nonce === null) return;
    const k = t.raw.toLowerCase();
    this.chainState.set(k, {
      nonce: t.nonce, multiplier: t.multiplier, newNonce: t.newNonce, newMultiplier: t.newMultiplier,
      newActivationTime: t.newActivationTime, block, blockTimestamp, readAtMs,
    });
    const nonce = Number(t.nonce);
    if (this.observed.get(k)?.has(nonce)) return;
    const o: Observation = { nonce, multiplier: t.multiplier.toString(), block, blockTimestamp, readAtMs };
    try {
      mkdirSync(this.chainDir, { recursive: true });
      persistOnce(join(this.chainDir, `${k}.n${nonce}.json`), JSON.stringify({ schema: CA_OBSERVATION_SCHEMA, raw: getAddress(t.raw), ...o }));
      this.remember(k, o);
    } catch (e) {
      this.log("corporate-actions-chain-error", { error: `observation not kept: ${describe(e)}` });
    }
  }

  // --- lineage and the loop ------------------------------------------------------------------

  /** Rebuild every cohort lineage from what the store and the last chain read hold. */
  recompute(): Unexplained[] {
    const next = new Map<string, Lineage>();
    const flagged: Unexplained[] = [];
    for (const a of this.cohort()) {
      const k = a.raw.toLowerCase();
      const chain = this.chainState.get(k);
      if (!chain) continue;
      const l = buildLineage({
        symbol: a.rawSymbol, wrapper: a.wrapper, raw: getAddress(a.raw),
        versions: (this.bySymbol.get(a.rawSymbol.toLowerCase()) ?? []).map((v) => v.record),
        chain, observed: this.observed.get(k),
      });
      next.set(k, l);
      flagged.push(...l.unexplained);
    }
    this.lineages = next;
    return flagged;
  }

  /**
   * Nothing is flagged until this process has completed one full sweep. A partial sweep leaves the store short
   * of versions, and every missing one would read as a lineage gap: an alarm about our own read, not the chain.
   */
  private publish(flagged: Unexplained[]): void {
    if (this.lastSweepMs === null) return;
    this.unexplained = flagged;
    const key = JSON.stringify(flagged);
    if (key !== this.unexplainedKey) {
      this.unexplainedKey = key;
      this.log("corporate-actions-unexplained", { count: flagged.length, unexplained: flagged });
    }
  }

  /**
   * One pass: a sweep if one is due, a chain read, the lineages. An unexplained step is only published once a
   * sweep no older than confirmMs agrees: the issuer lists an action before it activates, so a step that only
   * looks unexplained because the last sweep predates its record gets one fresh sweep first.
   */
  async pass(o: { sweep?: boolean } = {}): Promise<void> {
    let swept = false;
    if (o.sweep ?? this.nextSweepAtMs <= this.now()) {
      const r = await this.sweep();
      swept = true;
      this.sweepBackoffMs = r.ok ? 0 : Math.min(this.sweepMs, this.sweepBackoffMs ? this.sweepBackoffMs * 2 : 60_000);
      this.nextSweepAtMs = this.now() + (r.ok ? this.sweepMs : this.sweepBackoffMs);
    }
    const chainOk = await this.readChain();
    this.nextChainAtMs = this.now() + (chainOk ? this.chainMs : Math.min(this.chainMs, 60_000));
    let flagged = this.recompute();
    const fresh = this.lastSweepMs !== null && this.now() - this.lastSweepMs <= this.confirmMs;
    // Only a NEW flag earns a confirming sweep; one already published does not re-sweep every chain read.
    const published = new Set(this.unexplained.map(flagKey));
    if (flagged.some((f) => !published.has(flagKey(f))) && !swept && !fresh) {
      const r = await this.sweep();
      if (r.ok) this.nextSweepAtMs = this.now() + this.sweepMs;
      flagged = this.recompute();
    }
    this.publish(flagged);
  }

  /** Whether a pass is due now: a sweep or chain read on schedule, or a cohort the last chain read did not cover. */
  due(): boolean {
    const t = this.now();
    return this.nextSweepAtMs <= t || this.nextChainAtMs <= t || this.cohortRaws().key !== this.chainCohortKey;
  }

  /** The background loop. Checks every checkMs whether a pass is due; nothing awaits it. */
  async run(o: { signal?: AbortSignal; checkMs?: number } = {}): Promise<void> {
    const checkMs = o.checkMs ?? 30_000;
    while (!o.signal?.aborted) {
      try {
        // An empty cohort at boot is the tick not having read MarketClock yet: sweep, but wait for it to read the chain.
        if (this.due() && (this.cohort().length > 0 || this.nextSweepAtMs <= this.now())) await this.pass();
      } catch (e) {
        this.log("corporate-actions-error", { error: describe(e) });
      }
      await sleep(checkMs, o.signal);
    }
  }

  // --- what is served ------------------------------------------------------------------------

  health(nowMs: number): CorporateActionsHealth {
    return {
      pages: this.lastSweep?.pages ?? null,
      records: this.lastSweep?.records ?? null,
      versions: this.byKey.size,
      events: this.eventIds.size,
      lastSweepMs: this.lastSweepMs,
      lastAttemptMs: this.lastAttemptMs,
      stale: this.isStale(nowMs),
      lastError: this.lastError,
      conflicts: this.conflictKeys.size,
      chain: { asOfBlock: this.chainBlock, readAtMs: this.chainReadAtMs, lastError: this.chainError },
      unexplained: this.unexplained,
    };
  }

  /** Two missed sweeps, or none yet in this process. */
  private isStale(nowMs: number): boolean {
    return this.lastSweepMs === null || nowMs - this.lastSweepMs > 2 * this.sweepMs + 5 * 60_000;
  }

  /** Issuer symbol, wrapper symbol, wrapper address or raw address, to the issuer's symbol. */
  resolve(q: string, cohort: readonly Asset[]): Resolved | null {
    const s = q.trim();
    if (ADDRESS_RE.test(s)) {
      const lower = s.toLowerCase();
      const byWrapper = cohort.find((a) => a.wrapper.toLowerCase() === lower);
      if (byWrapper) return { symbol: byWrapper.rawSymbol, asset: byWrapper, via: "wrapper-address" };
      const byRaw = cohort.find((a) => a.raw.toLowerCase() === lower);
      if (byRaw) return { symbol: byRaw.rawSymbol, asset: byRaw, via: "raw-address" };
      return null;
    }
    if (!SYMBOL_RE.test(s)) return null;
    const lower = s.toLowerCase();
    const inCohort = cohort.find((a) => a.rawSymbol.toLowerCase() === lower);
    if (inCohort) return { symbol: inCohort.rawSymbol, asset: inCohort, via: "issuer-symbol" };
    const wrapped = cohort.find((a) => a.symbol.toLowerCase() === lower);
    if (wrapped) return { symbol: wrapped.rawSymbol, asset: wrapped, via: "wrapper-symbol" };
    const known = this.spelling.get(lower);
    if (known) return { symbol: known, asset: null, via: "issuer-symbol" };
    const unwrapped = lower.startsWith("w") ? this.spelling.get(lower.slice(1)) : undefined;
    if (unwrapped) return { symbol: unwrapped, asset: null, via: "wrapper-symbol" };
    return { symbol: s, asset: null, via: "issuer-symbol" };
  }

  private symbolParam(q: string | string[] | undefined): { ok: true; value: string } | { ok: false; reply: RouteReply } {
    if (q === undefined || q === "") return { ok: false, reply: { status: 400, body: { error: "symbol-required", detail: "?symbol= an issuer symbol (HONx), a wrapper symbol (wHONx), or a cohort wrapper or raw address" } } };
    if (Array.isArray(q)) return { ok: false, reply: { status: 400, body: { error: "symbol-repeated" } } };
    return { ok: true, value: q };
  }

  /** GET /v1/corporate-actions?symbol= : every version kept for the symbol, newest first. */
  versionsRoute(q: string | string[] | undefined, cohort: readonly Asset[], nowMs: number): RouteReply {
    const p = this.symbolParam(q);
    if (!p.ok) return p.reply;
    if (this.byKey.size === 0) {
      return { status: 503, body: { error: "corporate-actions-unavailable", detail: this.lastError ?? "no sweep has completed yet" } };
    }
    const r = this.resolve(p.value, cohort);
    if (!r) return { status: 404, body: { error: "unknown-symbol", detail: "an address must be a wrapper or raw token MarketClock registers; see /v1/assets" } };
    const list = this.bySymbol.get(r.symbol.toLowerCase()) ?? [];
    return {
      status: 200,
      headers: CACHE,
      body: {
        schema: CA_SCHEMA,
        symbol: r.symbol,
        query: p.value,
        resolvedVia: r.via,
        inCohort: r.asset !== null,
        wrapper: r.asset?.wrapper ?? null,
        raw: r.asset ? getAddress(r.asset.raw) : null,
        asOfMs: nowMs,
        lastSweepMs: this.lastSweepMs,
        stale: this.isStale(nowMs),
        source: `${this.client.base}/corporate-actions/history`,
        events: new Set(list.map((v) => v.record.eventId)).size,
        versions: list.map((v) => ({ ...v.record, firstSeenMs: v.firstSeenMs, recordHash: v.recordHash })),
      },
    };
  }

  /** GET /v1/corporate-actions/lineage?symbol= : the cohort asset's on-chain nonce steps, each linked to its version. */
  lineageRoute(q: string | string[] | undefined, cohort: readonly Asset[], nowMs: number): RouteReply {
    const p = this.symbolParam(q);
    if (!p.ok) return p.reply;
    const r = this.resolve(p.value, cohort);
    if (!r?.asset) {
      return { status: 404, body: { error: "not-in-cohort", detail: "lineage reads the chain only for the raw tokens MarketClock registers; see /v1/assets" } };
    }
    const l = this.lineages.get(r.asset.raw.toLowerCase());
    if (!l) return { status: 503, body: { error: "lineage-unavailable", detail: this.chainError ?? "the chain has not been read yet" } };
    return {
      status: 200,
      headers: CACHE,
      body: {
        schema: CA_LINEAGE_SCHEMA,
        query: p.value,
        asOfMs: nowMs,
        lastSweepMs: this.lastSweepMs,
        stale: this.isStale(nowMs),
        method: "each nonce step is linked to the version whose multiplierNew equals the multiplier it moved to; the walk starts at the chain's current (nonce, multiplier) and follows multiplierOld down to nonce 0; a split must satisfy new * fromUnits == old * toUnits in integers",
        ...l,
      },
    };
  }
}

const flagKey = (u: Unexplained) => `${u.raw.toLowerCase()}:${u.nonce}:${u.reason}:${u.multiplier}`;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", done); resolve(); }, ms);
    const done = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", done, { once: true });
  });
}
