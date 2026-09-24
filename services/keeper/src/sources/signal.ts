/**
 * mark/2's cross-market evidence: which bytes, and how a number is read out of them.
 *
 * Pure. Imported by the keeper (to build a round) and by every verifier (to re-derive it), so a third
 * party reads the committed bytes with exactly the rules the keeper used. No network, no clock: every
 * instant comes from the committed round (the observed cut, the settleAfter, and `evaluatedAtMs`, which
 * is the commit time).
 *
 * The rules, all deterministic:
 *
 *   perp, cut      the 1-minute kline that closed at the observed cut:
 *                  openTime = floor(cutAtMs / 60 000) x 60 000 - 60 000
 *   perp, commit   the last 1-minute kline that closed at least 5 s before the commit:
 *                  openTime = floor((evaluatedAtMs - 5 000) / 60 000) x 60 000 - 60 000
 *                  Each must be exactly one row, with that openTime and openTime + 59 999 as closeTime.
 *                  The price is the kline's close.
 *   ADR            the latest US regular trading period (Yahoo `meta.tradingPeriods`) that ENDED inside
 *                  (cut, commit]. Its close is the close of the last hourly bar inside that period, and
 *                  that bar must start within the period's final hour -- otherwise the session is stale
 *                  or missing (Yahoo has dropped whole daily bars; D-11's 22 Sep session is one) and the
 *                  leg is absent rather than silently one day old.
 *   primary        the primary's trading period that the cut ended: the latest one starting at or before
 *                  the cut, ending within an hour of it and before the commit. Close = last bar inside it,
 *                  again within its final hour.
 *   FX             the last USD->primary-currency bar at or before the ADR session's end, no more than
 *                  three hours before it.
 *
 * A leg that fails any rule is absent, with the reason recorded; mark.ts decides what absence means.
 */
import type { AdrLeg, PerpLeg, SignalInput, SignalProxy } from "../mark.ts";
import { SIGNAL_PROXIES, impliedE18 } from "../mark.ts";

export const BINANCE_FAPI = "https://fapi.binance.com";
export const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

/** The canonical upstream URL of one closed minute. The relay builds the identical string. */
export const binanceKlinesUrl = (symbol: string, startTimeMs: number): string =>
  `${BINANCE_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTimeMs}&limit=1`;

/** The canonical Yahoo request: hourly bars over five days, so the closure's session is in one response. */
export const yahooChartUrl = (ticker: string): string =>
  `${YAHOO_CHART}${encodeURIComponent(ticker)}?interval=1h&range=5d`;

export const cutMinuteMs = (cutAtMs: number): number => Math.floor(cutAtMs / 60_000) * 60_000 - 60_000;
export const commitMinuteMs = (commitAtMs: number): number => Math.floor((commitAtMs - 5_000) / 60_000) * 60_000 - 60_000;

/** The evidence leaves a mark/2 closure can carry, by name. */
export const SIGNAL_KEYS = ["perp:cut", "perp:commit", "yahoo:adr", "yahoo:primary", "yahoo:fx"] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

/** What a verifier needs from one committed response: where it claims to be from, and the bytes. */
export interface SignalBytes { url: string; body: string }
export type SignalEvidenceBytes = Partial<Record<SignalKey, SignalBytes>>;

export interface SignalContext {
  symbol: string;
  cutAtMs: number;
  /** The round's evaluatedAtMs. */
  commitAtMs: number;
  settleAfterS: number;
}

/** Which proxy an asset uses, or null. */
export const proxyFor = (symbol: string): SignalProxy | null => SIGNAL_PROXIES[symbol] ?? null;

/** Does this closure get the ADR leg at all? Only a closure long enough to contain a US session. */
export const wantsAdr = (closureS: number, minSignalClosureS: number): boolean => closureS >= minSignalClosureS;

export const closureSOf = (ctx: SignalContext): number => ctx.settleAfterS - Math.floor(ctx.cutAtMs / 1000);

// ---------------------------------------------------------------------------------------------
// decimal handling: exact, no floating point after the source's own text
// ---------------------------------------------------------------------------------------------

/**
 * A decimal string ("438.80000", "55.90999984741211", "1.5e-7") to an integer scaled by 1e18, truncated.
 * Null for anything that is not a plain finite decimal.
 */
export function decToE18(s: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = m[3] ?? "";
  const exp = Number(m[4] ?? "0") - frac.length + 18;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null;
  let v = BigInt(m[2] + frac);
  v = exp >= 0 ? v * 10n ** BigInt(exp) : v / 10n ** BigInt(-exp);
  return m[1] === "-" ? -v : v;
}

/** A JSON number as Yahoo sent it, to E18. `String(n)` is the shortest round-trip form, fixed by ECMAScript. */
const numToE18 = (n: unknown): bigint | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? decToE18(String(n)) : null);

// ---------------------------------------------------------------------------------------------
// Binance klines
// ---------------------------------------------------------------------------------------------

/** The close of exactly one closed 1-minute kline at `openTimeMs`, or the reason it is not usable. */
export function klineClose(body: string, openTimeMs: number): { closeE18: bigint } | { error: string } {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return { error: "unparseable" }; }
  if (!Array.isArray(j)) return { error: "not-an-array" };
  if (j.length !== 1) return { error: `rows=${j.length}` };
  const row = j[0];
  if (!Array.isArray(row) || row.length < 7) return { error: "bad-row" };
  if (row[0] !== openTimeMs) return { error: "wrong-minute" };
  if (row[6] !== openTimeMs + 59_999) return { error: "not-a-1m-kline" };
  const c = typeof row[4] === "string" ? decToE18(row[4]) : null;
  if (c === null || c <= 0n) return { error: "bad-close" };
  return { closeE18: c };
}

// ---------------------------------------------------------------------------------------------
// Yahoo chart
// ---------------------------------------------------------------------------------------------

export interface YahooChart {
  symbol: string;
  currency: string;
  periods: Array<{ start: number; end: number }>;
  bars: Array<{ t: number; close: bigint | null }>;
}

export function parseYahooChart(body: string): YahooChart | null {
  try {
    const j = JSON.parse(body) as { chart?: { result?: Array<Record<string, unknown>> } };
    const r = j.chart?.result?.[0];
    if (!r) return null;
    const meta = r.meta as Record<string, unknown> | undefined;
    if (!meta || typeof meta.symbol !== "string") return null;
    const tp = meta.tradingPeriods as unknown;
    const periods: Array<{ start: number; end: number }> = [];
    const take = (p: unknown) => {
      const x = p as { start?: unknown; end?: unknown };
      if (x && Number.isSafeInteger(x.start) && Number.isSafeInteger(x.end)) periods.push({ start: x.start as number, end: x.end as number });
    };
    if (Array.isArray(tp)) for (const day of tp) { if (Array.isArray(day)) day.forEach(take); else take(day); }
    else if (tp && typeof tp === "object" && Array.isArray((tp as { regular?: unknown }).regular)) {
      for (const day of (tp as { regular: unknown[] }).regular) { if (Array.isArray(day)) day.forEach(take); else take(day); }
    }
    periods.sort((a, b) => a.start - b.start);
    const ts = (r.timestamp as unknown[] | undefined) ?? [];
    const closes = ((r.indicators as { quote?: Array<{ close?: unknown[] }> } | undefined)?.quote?.[0]?.close) ?? [];
    const bars: YahooChart["bars"] = [];
    for (let i = 0; i < ts.length; i++) {
      if (!Number.isSafeInteger(ts[i])) continue;
      bars.push({ t: ts[i] as number, close: numToE18(closes[i]) });
    }
    return { symbol: meta.symbol, currency: typeof meta.currency === "string" ? meta.currency : "", periods, bars };
  } catch { return null; }
}

/** Close of the last bar inside [start, end] (unix s), which must begin within the final `freshS`. */
function closeIn(c: YahooChart, start: number, end: number, freshS: number): { closeE18: bigint } | { error: string } {
  let last: { t: number; close: bigint } | null = null;
  for (const b of c.bars) if (b.t >= start && b.t <= end && b.close !== null) last = { t: b.t, close: b.close };
  if (!last) return { error: "no-bar" };
  if (last.t < end - freshS) return { error: "stale" };
  return { closeE18: last.close };
}

// ---------------------------------------------------------------------------------------------
// the derivation
// ---------------------------------------------------------------------------------------------

function derivePerp(ctx: SignalContext, p: SignalProxy, ev: SignalEvidenceBytes, missing: string[]): PerpLeg | null {
  const cm = cutMinuteMs(ctx.cutAtMs);
  const km = commitMinuteMs(ctx.commitAtMs);
  const read = (key: "perp:cut" | "perp:commit", minute: number): bigint | null => {
    const e = ev[key];
    if (!e) { missing.push(`${key}:absent`); return null; }
    if (e.url !== binanceKlinesUrl(p.perp, minute)) { missing.push(`${key}:wrong-url`); return null; }
    const k = klineClose(e.body, minute);
    if ("error" in k) { missing.push(`${key}:${k.error}`); return null; }
    return k.closeE18;
  };
  const a = read("perp:cut", cm);
  const b = read("perp:commit", km);
  if (a === null || b === null) return null;
  if (km <= cm) { missing.push("perp:commit-not-after-cut"); return null; }
  return { symbol: p.perp, cutMinuteMs: cm, commitMinuteMs: km, cutE18: a.toString(), commitE18: b.toString() };
}

function chartOf(key: SignalKey, want: string, currency: string, ev: SignalEvidenceBytes, missing: string[]): YahooChart | null {
  const e = ev[key];
  if (!e) { missing.push(`${key}:absent`); return null; }
  if (e.url !== yahooChartUrl(want)) { missing.push(`${key}:wrong-url`); return null; }
  const c = parseYahooChart(e.body);
  if (!c) { missing.push(`${key}:unparseable`); return null; }
  if (c.symbol !== want) { missing.push(`${key}:wrong-symbol`); return null; }
  if (currency && c.currency !== currency) { missing.push(`${key}:wrong-currency`); return null; }
  return c;
}

function deriveAdr(ctx: SignalContext, p: SignalProxy, ev: SignalEvidenceBytes, missing: string[]): AdrLeg | null {
  const cutS = ctx.cutAtMs / 1000;
  const commitS = ctx.commitAtMs / 1000;

  const adr = chartOf("yahoo:adr", p.adr, "USD", ev, missing);
  if (!adr) return null;
  const sessions = adr.periods.filter((x) => x.end > cutS && x.end <= commitS);
  if (sessions.length === 0) { missing.push("yahoo:adr:no-session-in-closure"); return null; }
  const s = sessions[sessions.length - 1];
  const ac = closeIn(adr, s.start, s.end, 3600);
  if ("error" in ac) { missing.push(`yahoo:adr:${ac.error}`); return null; }

  const pri = chartOf("yahoo:primary", p.primary, p.primaryCurrency, ev, missing);
  if (!pri) return null;
  const ps = pri.periods.filter((x) => x.start <= cutS);
  const pp = ps[ps.length - 1];
  if (!pp || pp.end > commitS || Math.abs(pp.end - cutS) > 3600) { missing.push("yahoo:primary:no-session-at-cut"); return null; }
  const pc = closeIn(pri, pp.start, pp.end, 3600);
  if ("error" in pc) { missing.push(`yahoo:primary:${pc.error}`); return null; }

  const fx = chartOf("yahoo:fx", p.fx, "", ev, missing);
  if (!fx) return null;
  let fxBar: { t: number; close: bigint } | null = null;
  for (const b of fx.bars) if (b.t <= s.end && b.close !== null) fxBar = { t: b.t, close: b.close };
  if (!fxBar) { missing.push("yahoo:fx:no-bar"); return null; }
  if (fxBar.t < s.end - 3 * 3600) { missing.push("yahoo:fx:stale"); return null; }

  return {
    adr: p.adr, sessionEndS: s.end, adrCloseE18: ac.closeE18.toString(),
    fxE18: fxBar.close.toString(), sharesPerAdr: p.sharesPerAdr,
    impliedE18: impliedE18(ac.closeE18, fxBar.close, p.sharesPerAdr).toString(),
    primary: p.primary, primarySessionEndS: pp.end, primaryCloseE18: pc.closeE18.toString(),
  };
}

/**
 * Read mark/2's signal out of the committed bytes. The keeper calls this on what it fetched; a verifier
 * calls it on what was published, and the two must agree exactly.
 */
export function deriveSignal(ctx: SignalContext, ev: SignalEvidenceBytes, minSignalClosureS: number): SignalInput {
  const closureS = closureSOf(ctx);
  const p = proxyFor(ctx.symbol);
  if (!p) return { closureS, proxy: null, perp: null, adr: null, missing: ["no-proxy"] };
  const missing: string[] = [];
  const perp = derivePerp(ctx, p, ev, missing);
  // A recess has no US session in it; the ADR leg is not looked for, so its absence is not a gap.
  const adr = wantsAdr(closureS, minSignalClosureS) ? deriveAdr(ctx, p, ev, missing) : null;
  return { closureS, proxy: ctx.symbol, perp, adr, missing };
}

/** The (url, body) pairs `deriveSignal` reads, from committed exchanges. */
export function evidenceBytes(exchanges: Array<{ key: string; url: string; body: string }>): SignalEvidenceBytes {
  const ev: SignalEvidenceBytes = {};
  for (const e of exchanges) if ((SIGNAL_KEYS as readonly string[]).includes(e.key)) ev[e.key as SignalKey] = { url: e.url, body: e.body };
  return ev;
}
