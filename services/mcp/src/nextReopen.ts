/**
 * curb_next_reopen: when primary capacity is expected back for one wrapper.
 *
 * Why this computes rather than proxies. The free preview at api.curb.markets (the body of the 402 on
 * /v1/closure-calendar) carries `marketOpen` and `nextClosure`, the next cut that has NOT started yet. While a
 * market is shut, the reopen an agent is waiting for is the end of the closure already in progress, and that
 * is only in the paid calendar. MarketClock cannot answer it either: `nextTransitionAt` is the next schedule
 * boundary, and a Hong Kong overnight closure crosses three of them (16:00, 16:10, 09:00) before 09:30.
 *
 * So the answer is computed here from the issuer's published schedule and limits (issuer.ts) with the asp's
 * own calendar code, copied verbatim (closureCalendar.ts, reopen.ts): the same `curb.reopen/1` rule the keeper
 * commits every Scorecard row's settleAfter under, and the same 300 s early cut (DECISIONS D-4). For the same
 * issuer bytes it gives the instant the paid calendar gives. What stays paid: the full 1-14 day window list
 * and the evidence trail kept for every answer. This returns the closure in progress, if any, and the next one.
 *
 * MarketClock is read alongside, at one pinned block, because it is the on-chain authority: when the chain
 * and the schedule disagree (a change the attestor has not recorded yet, an issuer halt, a holiday the
 * schedule missed), the answer says so rather than picking one quietly.
 */
import { buildCalendar, CALENDAR_METHOD, ISSUER_EARLY_CUT_MS } from "./closureCalendar.ts";
import type { ClosureWindow, TimelineCache } from "./closureCalendar.ts";
import type { IssuerCache } from "./issuer.ts";
import { readRegimes, usd } from "./clock.ts";
import type { RegimeAnswer } from "./clock.ts";
import type { Asset } from "./assets.ts";
import type { AsOf, ChainReader } from "./sources/chain.ts";

const PAID_CALENDAR = "https://api.curb.markets/v1/closure-calendar";

/** "Fri 2026-09-25 09:30 Asia/Hong_Kong": the venue's wall clock, read from the instant (never the host's zone). */
export function venueLocalTime(tz: string, ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("year")}-${p("month")}-${p("day")} ${String(Number(p("hour")) % 24).padStart(2, "0")}:${p("minute")} ${tz}`;
}

/** "45 min", "1 h 5 min", "2 d 17 h 35 min". Whole minutes, rounded down; under a minute is "under 1 min". */
export function humanDuration(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  if (m === 0) return "under 1 min";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const out: string[] = [];
  if (d) out.push(`${d} d`);
  if (h) out.push(`${h} h`);
  if (mm) out.push(`${mm} min`);
  return out.join(" ");
}

export interface WindowView {
  startsAt: string | null;
  startsAtVenue: string | null;
  endsAt: string | null;
  endsAtVenue: string | null;
  durationS: number | null;
  kind: ClosureWindow["kind"];
}

function view(tz: string, w: ClosureWindow): WindowView {
  return {
    startsAt: w.startIso, startsAtVenue: w.startMs === null ? null : venueLocalTime(tz, w.startMs),
    endsAt: w.endIso, endsAtVenue: w.endMs === null ? null : venueLocalTime(tz, w.endMs),
    durationS: w.durationS, kind: w.kind,
  };
}

export interface NextReopenResult {
  summary: string;
  symbol: string;
  wrapper: string;
  /** Shut now, by MarketClock (regime UNKNOWN, or primaryCapNow() == 0). */
  shutNow: boolean;
  /** The closure in progress by the issuer's schedule, and when it is expected to end. Null when the schedule says open. */
  expectedReopen: (WindowView & { inSeconds: number | null }) | null;
  /** The next closure that has not started yet, by the schedule. */
  nextClosure: WindowView | null;
  disagreement: string | null;
  marketClock: { asOf: AsOf; status: RegimeAnswer["status"]; regime: string; primaryCapUsd: string; nextTransitionAt: string | null; note: string };
  schedule: {
    method: string;
    rule: string;
    computedAt: string;
    venue: string | null;
    timezone: string | null;
    period: string | null;
    capUsd: number | null;
    open: boolean | null;
    issuer: { assetUrl: string; assetBodyHash: string; exchangeUrl: string; exchangeBodyHash: string; fetchedAt: string; ageSeconds: number } | null;
  };
  warnings: string[];
  fullCalendar: { route: string; price: string; how: string };
}

export interface NextReopenDeps {
  chain: ChainReader;
  issuer: IssuerCache;
  timelines: TimelineCache;
  now: () => number;
}

export async function nextReopen(d: NextReopenDeps, a: Asset): Promise<NextReopenResult> {
  const [clock, venueStatus] = await Promise.all([readRegimes(d.chain, [a]), d.issuer.get(a.ticker)]);
  const r = clock.assets[0];
  const nowMs = d.now();
  const shutNow = r.status !== "OPEN";
  const warnings: string[] = [];
  const marketClock = {
    asOf: clock.asOf, status: r.status, regime: r.regime.name, primaryCapUsd: r.primaryCapUsd, nextTransitionAt: r.nextTransitionAt,
    note: "nextTransitionAt is the next schedule boundary the attestor published, not necessarily when capacity returns",
  };
  const base = {
    symbol: a.symbol, wrapper: a.wrapper, shutNow, marketClock,
    fullCalendar: {
      route: `GET ${PAID_CALENDAR}?symbol=${a.symbol}&horizonDays=7`,
      price: "$0.01 in USD₮0 on X Layer (x402)",
      how: "every closure window for 1-14 days with the hashes of the issuer bytes used; see curb_paid_services for the onchainos commands",
    },
  };
  const rule =
    "reopen = the first published schedule boundary after the cut at which the issuer's cap for the period is non-zero; " +
    `each cut starts ${ISSUER_EARLY_CUT_MS / 1000} s before the boundary where a capacity-bearing period ends (DECISIONS D-4)`;

  const v = venueStatus.venue;
  if (!v) {
    warnings.push(`the issuer's public API could not be read (${venueStatus.lastError ?? "no usable response"}), so no schedule-based reopen can be given; the paid calendar keeps its own copy of the issuer bytes and may still answer`);
    return {
      summary: `${a.symbol}: primary market ${shutNow ? "shut" : "open"} now (MarketClock ${r.regime.name}, cap ${usd(r.primaryCapUsd)}). The issuer's schedule is unavailable, so no reopen time is given.`,
      ...base,
      expectedReopen: null, nextClosure: null, disagreement: null,
      schedule: { method: CALENDAR_METHOD, rule, computedAt: new Date(nowMs).toISOString(), venue: null, timezone: null, period: null, capUsd: null, open: null, issuer: null },
      warnings,
    };
  }

  if (venueStatus.stale && venueStatus.ageMs !== null) {
    warnings.push(`the issuer bytes are ${Math.round(venueStatus.ageMs / 1000)} s old because the latest refresh failed (${venueStatus.lastError}); the answer is correct unless the issuer changed its schedule or limits since`);
  }
  const tz = v.sched.schedule.timezone;
  const cal = buildCalendar({
    symbol: a.symbol, wrapper: a.wrapper, venue: v,
    timeline: d.timelines.get(a.wrapper, v, nowMs), nowMs, horizonDays: 7, warnings,
  });
  const current = cal.windows.find((w) => w.startMs === null || w.startMs <= nowMs) ?? null;
  const expectedReopen = current
    ? { ...view(tz, current), inSeconds: current.endMs === null ? null : Math.max(0, Math.round((current.endMs - nowMs) / 1000)) }
    : null;
  const nextClosure = cal.nextClosure ? view(tz, cal.nextClosure) : null;

  let disagreement: string | null = null;
  if (shutNow && cal.marketOpen) {
    disagreement =
      `MarketClock reads ${r.regime.name} with cap ${usd(r.primaryCapUsd)}, but the issuer's schedule has capacity on now. ` +
      "Contracts that read MarketClock (Scorecard, CurbCredit, ReopenNote) treat the market as shut until the attestor records the reopen; so should you.";
  } else if (!shutNow && !cal.marketOpen) {
    const why = v.halted
      ? "the issuer reported trading halted when its bytes were fetched"
      : `by the issuer's schedule a closure has begun${current?.startIso ? ` (cut at ${current.startIso})` : ""}`;
    disagreement =
      `MarketClock still reads ${r.regime.name} with cap ${usd(r.primaryCapUsd)}, but ${why}. ` +
      "Contracts that read MarketClock treat the market as open until the attestor records the change; do not start anything that needs primary capacity to last.";
  }

  let summary: string;
  const head = `${a.symbol}: primary market ${shutNow ? "shut" : "open"} now (MarketClock ${r.regime.name}, cap ${usd(r.primaryCapUsd)}).`;
  if (expectedReopen && expectedReopen.endsAt) {
    summary = `${head} By the issuer's schedule capacity returns at ${expectedReopen.endsAt} (${expectedReopen.endsAtVenue}), in ${humanDuration(expectedReopen.inSeconds ?? 0)}.`;
  } else if (expectedReopen) {
    summary = `${head} The issuer's schedule shows no reopen within 14 days.`;
  } else if (nextClosure) {
    summary = `${head} Next closure by the issuer's schedule: ${nextClosure.startsAt} (${nextClosure.startsAtVenue}) to ${nextClosure.endsAt ?? "no reopen within 14 days"}` +
      `${nextClosure.endsAtVenue ? ` (${nextClosure.endsAtVenue})` : ""}${nextClosure.durationS !== null ? `, ${humanDuration(nextClosure.durationS)}` : ""}, ${nextClosure.kind}.`;
  } else {
    summary = `${head} No closure in the next 7 days by the issuer's schedule.`;
  }
  if (disagreement) summary += " The chain and the schedule disagree: see disagreement.";

  return {
    summary,
    ...base,
    expectedReopen, nextClosure, disagreement,
    schedule: {
      method: CALENDAR_METHOD, rule, computedAt: new Date(nowMs).toISOString(),
      venue: v.mic, timezone: tz, period: cal.nowPeriod, capUsd: cal.nowCapFiat, open: cal.marketOpen,
      issuer: {
        assetUrl: v.assetUrl, assetBodyHash: v.assetBodyHash, exchangeUrl: v.exchangeUrl, exchangeBodyHash: v.exchangeBodyHash,
        fetchedAt: new Date(v.atMs).toISOString(), ageSeconds: Math.round((venueStatus.ageMs ?? 0) / 1000),
      },
    },
    warnings: cal.warnings,
  };
}
