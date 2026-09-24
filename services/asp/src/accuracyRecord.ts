/**
 * The accuracy record: every mark Curb committed before a reopen, and how Scorecard graded it.
 *
 * Nothing here is Curb's opinion of itself. Every number is a Scorecard getter read at one pinned block
 * (index/scorecard.ts): the mark and its two baselines were fixed on chain at commit time, the reopen price
 * was read by the contract from the pool's own TWAP-guarded price, and the three error figures were
 * computed by `settle()`, which anyone may call. This service only arranges them, and adds two things the
 * contract does not store per row:
 *
 *   beatLastPrint / beatClosingVwap / tie   derived with the contract's own rule, STRICT: a row beats a
 *       baseline only when curbErrorBps < that baseline's error, exactly the comparison settle() uses to
 *       increment skill(). Equal errors are a tie, and a tie is not a win. The recount over every row is
 *       checked against skill() itself, and a disagreement is printed, never smoothed over.
 *   medians per asset                       order statistics of the settled rows (stats.ts), nothing fitted.
 *
 * The evidence link is stated as what it is. Each row names its input bundle by inputRoot, the Merkle root
 * committed on chain; the archive that will serve those bundles publicly is not live yet, so every row
 * says evidenceStatus "pending-publisher" instead of implying the link resolves today.
 */
import { grade, recount } from "./index/scorecard.ts";
import type { ScorecardRow, ScorecardSnapshot } from "./index/scorecard.ts";
import { methodDigestOf } from "./sources/scorecard.ts";
import { median } from "./stats.ts";

export const RECORD_SCHEMA = "curb.asp.record/1";
export const RECORD_PREVIEW_SCHEMA = "curb.asp.record.preview/1";
export const EVIDENCE_BASE_URL = "https://archive.curb.markets/marks/";
export const EVIDENCE_STATUS = "pending-publisher";
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Mark methods whose digest this service can name. A row under any other digest reports method null. */
const KNOWN_METHODS = new Map(
  ["curb.scorecard.mark/1", "curb.scorecard.mark/2"].map((m) => [methodDigestOf(m).toLowerCase(), m]),
);

export interface RecordRow {
  id: string;
  wrapper: string;
  symbol: string | null;
  committedAt: number;
  committedBlock: number;
  settleAfter: number;
  settledAt: number | null;
  settledBlock: number | null;
  markE18: string;
  bandBps: number;
  lastPrintE18: string;
  closingVwapE18: string;
  reopenPrintE18: string | null;
  curbErrorBps: number | null;
  lastPrintErrorBps: number | null;
  closingVwapErrorBps: number | null;
  beatLastPrint: boolean | null;
  beatClosingVwap: boolean | null;
  tie: boolean | null;
  tieClosingVwap: boolean | null;
  inputRoot: string;
  methodDigest: string;
  method: string | null;
  settled: boolean;
  evidenceUrl: string;
  evidenceStatus: typeof EVIDENCE_STATUS;
}

export interface SymbolRecord {
  wrapper: string;
  committed: number;
  settled: number;
  beatLast: number;
  beatVwap: number;
  ties: number;
  tiesClosingVwap: number;
  medianCurbErrorBps: number | null;
  medianLastPrintErrorBps: number | null;
}

export interface RecordAnswer {
  schema: typeof RECORD_SCHEMA;
  scorecard: string;
  chainId: number;
  asOfBlock: number;
  asOfBlockHash: string;
  asOfBlockTimestamp: number;
  asOfMs: number;
  symbol: string | null;
  limit: number;
  /** skill() at asOfBlock, verbatim: contract-wide, whatever `symbol` is. */
  skill: { settled: number; beatLastPrint: number; beatClosingVwap: number };
  perSymbol: Record<string, SymbolRecord>;
  totalRows: number;
  rowsOrder: "newest-first";
  rows: RecordRow[];
  note: string;
  evidenceNote: string;
  definitions: Record<string, string>;
  warnings: string[];
}

export interface RecordPreview {
  schema: typeof RECORD_PREVIEW_SCHEMA;
  skill: RecordAnswer["skill"];
  rowCount: number;
}

export interface RecordInput {
  snapshot: ScorecardSnapshot;
  chainId: number;
  /** Lower-cased wrapper -> symbol, from the MarketClock cohort. */
  symbols: ReadonlyMap<string, string>;
  /** The filter, already resolved to a cohort asset, or null for every row. */
  filter: { symbol: string; wrapper: string } | null;
  limit: number;
  nowMs: number;
  warnings?: string[];
}

export function recordRow(r: ScorecardRow, symbol: string | null): RecordRow {
  const s = r.settlement;
  const g = s ? grade(s) : null;
  return {
    id: r.id,
    wrapper: r.wrapper,
    symbol,
    committedAt: r.committedAt,
    committedBlock: r.committedBlock,
    settleAfter: r.settleAfter,
    settledAt: s?.settledAt ?? null,
    settledBlock: s?.settledBlock ?? null,
    markE18: r.markE18,
    bandBps: r.bandBps,
    lastPrintE18: r.lastPrintE18,
    closingVwapE18: r.closingVwapE18,
    reopenPrintE18: s?.reopenPrintE18 ?? null,
    curbErrorBps: s?.curbErrorBps ?? null,
    lastPrintErrorBps: s?.lastPrintErrorBps ?? null,
    closingVwapErrorBps: s?.closingVwapErrorBps ?? null,
    beatLastPrint: g?.beatLastPrint ?? null,
    beatClosingVwap: g?.beatClosingVwap ?? null,
    tie: g?.tie ?? null,
    tieClosingVwap: g?.tieClosingVwap ?? null,
    inputRoot: r.inputRoot,
    methodDigest: r.methodDigest,
    method: KNOWN_METHODS.get(r.methodDigest.toLowerCase()) ?? null,
    settled: s !== null,
    evidenceUrl: `${EVIDENCE_BASE_URL}${r.inputRoot.toLowerCase()}.json`,
    evidenceStatus: EVIDENCE_STATUS,
  };
}

function symbolRecord(wrapper: string, rows: readonly ScorecardRow[]): SymbolRecord {
  const settled = rows.filter((r) => r.settlement !== null);
  let beatLast = 0, beatVwap = 0, ties = 0, tiesClosingVwap = 0;
  for (const r of settled) {
    const g = grade(r.settlement!);
    if (g.beatLastPrint) beatLast++;
    if (g.beatClosingVwap) beatVwap++;
    if (g.tie) ties++;
    if (g.tieClosingVwap) tiesClosingVwap++;
  }
  return {
    wrapper,
    committed: rows.length,
    settled: settled.length,
    beatLast, beatVwap, ties, tiesClosingVwap,
    medianCurbErrorBps: median(settled.map((r) => r.settlement!.curbErrorBps)),
    medianLastPrintErrorBps: median(settled.map((r) => r.settlement!.lastPrintErrorBps)),
  };
}

export function buildRecord(i: RecordInput): RecordAnswer {
  const snap = i.snapshot;
  const symbolOf = (w: string) => i.symbols.get(w.toLowerCase()) ?? null;
  const scope = i.filter ? snap.rows.filter((r) => r.wrapper.toLowerCase() === i.filter!.wrapper.toLowerCase()) : snap.rows;

  const groups = new Map<string, ScorecardRow[]>();
  for (const r of scope) {
    const k = r.wrapper.toLowerCase();
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const perSymbol: Record<string, SymbolRecord> = {};
  const keyed = [...groups.values()].map((rows) => ({ key: symbolOf(rows[0].wrapper) ?? rows[0].wrapper, rows }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { key, rows } of keyed) perSymbol[key] = symbolRecord(rows[0].wrapper, rows);

  const newestFirst = [...scope].sort((a, b) => b.index - a.index);
  const rows = newestFirst.slice(0, i.limit).map((r) => recordRow(r, symbolOf(r.wrapper)));

  const warnings = [...(i.warnings ?? [])];
  const again = recount(snap.rows);
  if (again.settled !== snap.skill.settled || again.beatLast !== snap.skill.beatLast || again.beatVwap !== snap.skill.beatVwap) {
    warnings.push(
      `skill() at block ${snap.block.number} is (${snap.skill.settled}, ${snap.skill.beatLast}, ${snap.skill.beatVwap}) but a strict recount of the ` +
      `contract's own rows gives (${again.settled}, ${again.beatLast}, ${again.beatVwap}); the rows are served as read, and the discrepancy is being investigated`,
    );
  }
  const unnamed = scope.filter((r) => symbolOf(r.wrapper) === null).length;
  if (unnamed) warnings.push(`${unnamed} row(s) are for wrappers outside MarketClock's current cohort; their symbol is null and perSymbol keys them by wrapper address`);

  const settledScope = scope.filter((r) => r.settlement !== null);
  const tiesScope = settledScope.filter((r) => grade(r.settlement!).tie).length;
  const underMark1 = scope.some((r) => KNOWN_METHODS.get(r.methodDigest.toLowerCase()) === "curb.scorecard.mark/1");
  const underMark2 = scope.some((r) => KNOWN_METHODS.get(r.methodDigest.toLowerCase()) === "curb.scorecard.mark/2");
  const note =
    "Wins are strict, exactly as Scorecard.settle() counts them: a settled row beats a baseline only when curbErrorBps is strictly " +
    "less than that baseline's error, and skill() is the contract's own running count of those wins. A tie is not a win. " +
    `${tiesScope} of the ${settledScope.length} settled rows${i.filter ? ` for ${i.filter.symbol}` : ""} tie the last print exactly.` +
    (underMark1
      ? " Under curb.scorecard.mark/1 a closure in which the pool does not trade leaves the mark equal to the last print, so such a row can only tie it."
      : "") +
    (underMark2
      ? " curb.scorecard.mark/2 moves the last print by 0.79 x the mean return of a Binance perpetual on the same share and the US ADR" +
        " over an overnight or weekend closure. In the 65-minute lunch recess, and whenever neither signal could be fetched, it applies" +
        " no move: the mark is exactly mark/1's, and the row can only tie. That is deliberate. Measured over 23 recesses, the perpetual's" +
        " recess move made the mark worse on all three names. Each row keeps the method that produced it, and none is re-marked."
      : "");

  return {
    schema: RECORD_SCHEMA,
    scorecard: snap.scorecard,
    chainId: i.chainId,
    asOfBlock: snap.block.number,
    asOfBlockHash: snap.block.hash,
    asOfBlockTimestamp: snap.block.timestamp,
    asOfMs: i.nowMs,
    symbol: i.filter?.symbol ?? null,
    limit: i.limit,
    skill: { settled: snap.skill.settled, beatLastPrint: snap.skill.beatLast, beatClosingVwap: snap.skill.beatVwap },
    perSymbol,
    totalRows: scope.length,
    rowsOrder: "newest-first",
    rows,
    note,
    evidenceNote:
      "evidenceUrl is where Curb's archive will serve each row's input bundle, named by the inputRoot committed on chain. " +
      `The archive publisher is not live yet: evidenceStatus is "${EVIDENCE_STATUS}" and the link does not resolve today.`,
    definitions: {
      errorBps: "|estimate - reopenPrint| * 10000 / reopenPrint, floored, computed on chain by Scorecard.settle() (curbErrorBps for the mark, then the last print and the closing VWAP)",
      reopenPrintE18: "the pool price Scorecard read for itself at settlement, refused unless within 50 ticks of the pool's own TWAP; settle() is permissionless and takes no price argument",
      tie: "curbErrorBps == lastPrintErrorBps (tieClosingVwap: == closingVwapErrorBps); null until settled",
      prices: "*E18 fields are USD per wrapper share with 18 decimals, as decimal strings",
      times: "unix seconds of block time; settleAfter is the reopen the row was committed with, and settlement opens 300 s after it",
      perSymbol: "computed over every row in scope, not only the rows returned under `limit`",
    },
    warnings,
  };
}

/** The free sample: the contract's headline and the size of the record, nothing per row. */
export function recordPreviewOf(a: RecordAnswer): RecordPreview {
  return { schema: RECORD_PREVIEW_SCHEMA, skill: a.skill, rowCount: a.totalRows };
}
