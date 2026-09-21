/**
 * Standby coordination: when host B writes instead of host A.
 *
 * Model: single writer, chain-decided takeover. Host A writes. Host B derives every tick exactly as A
 * does, but writes only when the CHAIN shows that A has not done what it should have. The hosts never
 * talk to each other; the only shared state is MarketClock itself, which cannot be partitioned.
 *
 * "Primary alive" means someone other than B wrote within heartbeat + staleGrace (390s). While the
 * primary is alive, B's authority is deliberately narrow:
 *
 * - Calendar-forced close (the venue's own published schedule says shut). derive() makes this decision
 *   from the schedule alone, so A must agree within its 5s dense tick. B writes once, 25s after first
 *   seeing it.
 * - Nonce activation. It is read from the chain, so both hosts see the same value. A's slowest tick is
 *   30s, so B writes once after 45s.
 * - Any other change is driven by the issuer API, and B NEVER writes it while A is alive. CDN edges
 *   disagree for up to ~90s, and an A that is alive and writing has seen the state and disagrees. B
 *   alarms instead. Writing would start a war.
 * - A never-attested (newly registered) asset that A has not attested after 90s means A's cohort is
 *   wrong. B pages; it does not write an asset A will never keep fresh.
 *
 * Once the primary is silent (the oldest asset A covers is older than heartbeat + 90s), B writes
 * everything and follows every change, including API-driven ones after 150s.
 *
 * Rules that prevent corrupting the record (each found in the pre-deploy review):
 * - A takeover round carries ALL of B's claims. So a non-stale takeover is blocked if B has any other
 *   divergence it is not entitled to write: a degraded claim (B could not read the issuer), an API
 *   divergence while A is alive, or a divergence still inside its grace. B pages instead.
 * - A stale takeover while B is blind for some asset waits, up to 20 minutes of total age, so one failed
 *   fetch at B does not stamp CLOSED over a healthy asset. After that, CLOSED is the fail-closed policy.
 * - No write wars. A write by someone else that leaves a divergence standing restarts B's grace once,
 *   to allow for a write already in flight. A second one stands B down for that divergence. A primary
 *   reverting B's own write within 30 minutes stands B down immediately. Stand-downs last 12 hours,
 *   survive degraded ticks, and are persisted across restarts by the caller (snapshot/restore).
 * - Staleness is measured only over the assets the primary itself last covered. An asset only B
 *   writes can never make B a permanent second writer.
 */
import { clockAbi, decodeRawToken } from "./sources/chain.ts";
import type { CallResult } from "./sources/chain.ts";
import type { CohortEntry, RoundKind } from "./round.ts";
import { Regime } from "./regime.ts";

export interface ChainState {
  wrapper: string;
  symbol: string;
  readable: boolean;
  regime: number;
  cap: bigint;
  observedAt: number;
  storedNonce: number;
  halted: boolean;
  /** Current nonce on the raw token, or null if the read failed. */
  rawNonce: number | null;
}

export function readChainStates(cohort: CohortEntry[], results: CallResult[]): ChainState[] {
  return cohort.map((c) => {
    const st = results.find((r) => r.label === `stateOf:${c.wrapper}`);
    const raw = decodeRawToken(c.raw, results);
    const rawNonce = !raw.readFailed && raw.nonce !== null ? Number(raw.nonce) : null;
    if (!st || !st.success) {
      return { wrapper: c.wrapper, symbol: c.symbol, readable: false, regime: 0, cap: 0n, observedAt: 0, storedNonce: 0, halted: false, rawNonce };
    }
    const s = clockAbi.decodeFunctionResult("stateOf", st.returnData)[0];
    return {
      wrapper: c.wrapper, symbol: c.symbol, readable: true,
      regime: Number(s[0]), cap: BigInt(s[1]), observedAt: Number(s[3]), storedNonce: Number(s[4]), halted: Boolean(s[5]), rawNonce,
    };
  });
}

export interface StandbyConfig {
  heartbeatS: number;
  staleGraceS: number;
  closeGraceS: number;
  activationGraceS: number;
  apiDiffGraceS: number;
  neverGraceS: number;
  /** A stale takeover waits for B's own blind spots to clear until the record is this old. */
  degradedStaleLimitS: number;
  /** A revert of B's write within this window is a revert, not a new transition. */
  rememberWritesMs: number;
  standDownMs: number;
}

export const DEFAULT_STANDBY: StandbyConfig = {
  heartbeatS: 300,
  staleGraceS: 90,
  closeGraceS: 25,
  activationGraceS: 45,
  apiDiffGraceS: 150,
  neverGraceS: 90,
  degradedStaleLimitS: 20 * 60,
  rememberWritesMs: 30 * 60_000,
  standDownMs: 12 * 3_600_000,
};

export interface StandbyClaim {
  wrapper: string;
  symbol: string;
  regime: number;
  capUsd: bigint;
  halted: boolean;
  disagreement: boolean;
  degraded: string[];
  reason: string;
}

export type EpisodeKind = "close" | "api" | "activation" | "never";

export interface Alarm {
  sev: 1 | 2;
  key: string;
  message: string;
}

export interface Plan {
  send: boolean;
  kind: RoundKind | null;
  reasons: string[];
  alarms: Alarm[];
  /** Divergences this round would settle; pass to markWrote once it is mined. */
  coveredKeys: string[];
  primaryAlive: boolean;
}

export interface PlannerSnapshot {
  written: [string, number][];
  stoodDown: [string, number][];
}

interface Episode {
  kind: EpisodeKind;
  wrapper: string;
  symbol: string;
  firstSeenMs: number;
  baselineNewestS: number;
  contested: number;
  alarmed: boolean;
}

/** The calendar, not the issuer API, forced this close: the venue's published schedule says shut. */
export function isCalendarForcedClose(c: StandbyClaim): boolean {
  return c.regime === Regime.CLOSED && c.disagreement && /venueOpen=false/.test(c.reason);
}

const lc = (s: string) => s.toLowerCase();

export class TakeoverPlanner {
  private readonly cfg: StandbyConfig;
  private readonly episodes = new Map<string, Episode>();
  private readonly written = new Map<string, number>();
  private readonly stoodDown = new Map<string, number>();

  constructor(cfg: Partial<StandbyConfig> = {}, snapshot?: PlannerSnapshot) {
    this.cfg = { ...DEFAULT_STANDBY, ...cfg };
    for (const [k, t] of snapshot?.written ?? []) this.written.set(k, t);
    for (const [k, t] of snapshot?.stoodDown ?? []) this.stoodDown.set(k, t);
  }

  snapshot(): PlannerSnapshot {
    return { written: [...this.written], stoodDown: [...this.stoodDown] };
  }

  private grace(kind: EpisodeKind): number {
    const c = this.cfg;
    return (kind === "close" ? c.closeGraceS : kind === "activation" ? c.activationGraceS : kind === "never" ? c.neverGraceS : c.apiDiffGraceS) * 1000;
  }

  private standDown(ep: Episode, key: string, nowMs: number, why: string, alarms: Alarm[]) {
    this.stoodDown.set(key, nowMs);
    ep.contested = Math.max(ep.contested, 2);
    if (ep.alarmed) return;
    ep.alarmed = true;
    alarms.push({ sev: ep.kind === "api" ? 2 : 1, key: `standby:stand-down:${key}`, message: `${why} for ${ep.symbol} (${key}); host B stands down for 12h` });
  }

  /**
   * @param lastWriterIsSelf the newest MarketClock write is this host's own (known from its own receipts).
   * @param primaryCoverage wrappers covered by the newest write NOT from this host, when known.
   */
  plan(a: { nowMs: number; states: ChainState[]; claims: StandbyClaim[]; lastWriterIsSelf?: boolean; primaryCoverage?: string[] | null }): Plan {
    const { nowMs, states, claims } = a;
    const nowS = nowMs / 1000;
    const selfLast = a.lastWriterIsSelf === true;
    const reasons: string[] = [];
    const alarms: Alarm[] = [];

    for (const [k, t] of this.written) if (nowMs - t > this.cfg.rememberWritesMs) this.written.delete(k);
    for (const [k, t] of this.stoodDown) if (nowMs - t > this.cfg.standDownMs) this.stoodDown.delete(k);

    if (states.some((s) => !s.readable)) {
      return { send: false, kind: null, reasons: ["state-unreadable"], alarms: [{ sev: 2, key: "standby:state-unreadable", message: "stateOf unreadable; takeover planning skipped" }], coveredKeys: [], primaryAlive: true };
    }

    const attested = states.filter((s) => s.observedAt > 0);
    const newestS = attested.length ? Math.max(...attested.map((s) => s.observedAt)) : 0;
    const coverage = a.primaryCoverage && !selfLast ? new Set(a.primaryCoverage.map(lc)) : null;
    const covered = coverage ? attested.filter((s) => coverage.has(lc(s.wrapper))) : attested;
    const basis = covered.length ? covered : attested;
    const oldestS = basis.length ? Math.min(...basis.map((s) => s.observedAt)) : 0;
    const limitS = this.cfg.heartbeatS + this.cfg.staleGraceS;
    const primaryAlive = newestS > 0 && !selfLast && nowS - newestS < limitS;
    const stale = basis.length > 0 && nowS - oldestS >= limitS;

    // 1. What differs right now.
    const present = new Map<string, { kind: EpisodeKind; wrapper: string; symbol: string }>();
    const blindWrappers = new Set<string>();
    for (const s of states) {
      const c = claims.find((k) => lc(k.wrapper) === lc(s.wrapper));
      if (c?.degraded.length) blindWrappers.add(lc(s.wrapper));
      if (s.observedAt === 0) {
        present.set(`${s.wrapper}:never`, { kind: "never", wrapper: s.wrapper, symbol: s.symbol });
        continue;
      }
      if (s.rawNonce !== null && s.rawNonce !== s.storedNonce) {
        present.set(`${s.wrapper}:nonce:${s.storedNonce}->${s.rawNonce}`, { kind: "activation", wrapper: s.wrapper, symbol: s.symbol });
      }
      if (c && (c.regime !== s.regime || c.capUsd !== s.cap || c.halted !== s.halted) && !c.degraded.length) {
        const key = `${s.wrapper}:diff:${s.regime}/${s.cap}/${s.halted}->${c.regime}/${c.capUsd}/${c.halted}`;
        present.set(key, { kind: isCalendarForcedClose(c) ? "close" : "api", wrapper: s.wrapper, symbol: s.symbol });
      }
    }
    // Blind means B could not read the issuer for that asset, AND that blindness would change what is
    // written. Flags like schedule-unavailable or non-integer-cap do not make B's claim unreliable.
    // venue-cohort-shut means B closed an asset on one peer object's word inside a single fetch batch.
    // That is exactly as weak a basis for a takeover write as an unreadable body, so it defers one too.
    const BLINDING = new Set(["source-unavailable", "period-unknown", "venue-cohort-shut"]);
    const blindDivergingWrappers = new Set(states.filter((s) => {
      const c = claims.find((k) => lc(k.wrapper) === lc(s.wrapper));
      return c && c.degraded.some((f) => BLINDING.has(f)) && s.observedAt > 0 && (c.regime !== s.regime || c.capUsd !== s.cap || c.halted !== s.halted);
    }).map((s) => lc(s.wrapper)));
    const blindDiverging = blindDivergingWrappers.size > 0;

    // 2. Advance episodes.
    const due: string[] = [];
    /** Divergences B may never write in this situation: they block a takeover and page. */
    const blocking: string[] = [];
    /** Divergences that are merely not ripe yet: they delay a takeover quietly. */
    const waiting: string[] = [];
    for (const [key, p] of present) {
      let ep = this.episodes.get(key);
      if (!ep) {
        ep = { kind: p.kind, wrapper: p.wrapper, symbol: p.symbol, firstSeenMs: nowMs, baselineNewestS: newestS, contested: 0, alarmed: false };
        this.episodes.set(key, ep);
        if (this.stoodDown.has(key)) {
          ep.contested = 2;
          ep.alarmed = true;
        } else if (this.written.has(key) && !selfLast) {
          this.standDown(ep, key, nowMs, "the primary reverted host B's takeover write", alarms);
        }
      } else if (newestS > ep.baselineNewestS) {
        ep.baselineNewestS = newestS;
        if (!selfLast) {
          ep.contested++;
          ep.firstSeenMs = nowMs;
          if (ep.contested >= 2) this.standDown(ep, key, nowMs, "the primary keeps writing a state host B disagrees with", alarms);
        }
      }

      const stoodDown = ep.contested >= 2;
      const ripe = nowMs - ep.firstSeenMs >= this.grace(ep.kind);
      if (stoodDown) {
        blocking.push(key);
        continue;
      }
      if (primaryAlive && (ep.kind === "api" || ep.kind === "never")) {
        blocking.push(key);
        if (ripe && !ep.alarmed) {
          ep.alarmed = true;
          alarms.push(ep.kind === "never"
            ? { sev: 1, key: `standby:primary-cohort-missing:${ep.wrapper}`, message: `${ep.symbol} is registered but the live primary has not attested it after ${this.cfg.neverGraceS}s: its cohort is stale` }
            : { sev: 2, key: `standby:disagree:${key}`, message: `host B's reading of ${ep.symbol} (${key}) differs from the live primary's for ${this.cfg.apiDiffGraceS}s; not writing while the primary is alive` });
        }
        continue;
      }
      if (ripe) {
        due.push(key);
        reasons.push(`takeover:${ep.kind}:${key}`);
      } else {
        waiting.push(key);
      }
    }
    // Forget an episode only when B can see that wrapper clearly and it no longer diverges. A blind tick is
    // not evidence that a divergence resolved.
    for (const [key, ep] of this.episodes) {
      if (!present.has(key) && !blindWrappers.has(lc(ep.wrapper))) this.episodes.delete(key);
    }

    // 3. Decide.
    const presentKeys = [...present.keys()];
    if (stale) {
      const ageS = Math.round(nowS - oldestS);
      // A due activation or calendar close is never deferred: a late activation defeats the blackout, and
      // stamping CLOSED over a blind asset is the fail-closed direction anyway.
      const urgent = due.some((k) => { const kind = present.get(k)!.kind; return kind === "activation" || kind === "close"; });
      if (blindDiverging && !urgent && nowS - oldestS < this.cfg.degradedStaleLimitS) {
        reasons.push(`stale-deferred:host-b-blind(${[...blindDivergingWrappers].join(",")}) age=${ageS}s`);
        if (nowS - oldestS >= limitS + this.cfg.heartbeatS) {
          alarms.push({ sev: 1, key: "standby:stale-deferred", message: `primary silent for ${ageS}s but host B cannot read the issuer for ${[...blindDivergingWrappers].join(",")}; the record fails closed at 1800s` });
        }
        return { send: false, kind: null, reasons, alarms, coveredKeys: [], primaryAlive };
      }
      reasons.push(`takeover:primary-silent age=${ageS}s`);
      const kinds = [...present.values()].map((p) => p.kind);
      const kind: RoundKind = kinds.includes("activation") ? "activation" : kinds.some((k) => k === "close" || k === "api") ? "diff" : "heartbeat";
      return { send: true, kind, reasons, alarms, coveredKeys: presentKeys, primaryAlive };
    }

    if (due.length === 0) return { send: false, kind: null, reasons, alarms, coveredKeys: [], primaryAlive };

    if (blocking.length > 0 || waiting.length > 0 || blindDiverging) {
      // The round would carry claims B is not (yet) entitled to write. Never corrupt another asset to
      // settle this one. Not-ripe and blind divergences usually clear within a tick or two, so wait
      // quietly; a permanent blocker, or a takeover delayed past its grace again, pages.
      const why = [...blocking, ...waiting, ...(blindDiverging ? ["host-b-blind-divergence"] : [])];
      reasons.push(`takeover-deferred-by:${why.join(",")}`);
      const overdue = due.some((k) => nowMs - this.episodes.get(k)!.firstSeenMs >= 2 * this.grace(this.episodes.get(k)!.kind));
      if (blocking.length > 0 || overdue) {
        alarms.push({ sev: 1, key: `standby:takeover-blocked:${due.join(",")}`, message: `host B should take over (${due.join(", ")}) but its round would also carry divergences it may not write (${why.join(", ")})` });
      }
      return { send: false, kind: null, reasons, alarms, coveredKeys: [], primaryAlive };
    }

    const kinds = due.map((k) => present.get(k)!.kind);
    const kind: RoundKind = kinds.includes("activation") ? "activation" : kinds.some((k) => k === "close" || k === "api") ? "diff" : "heartbeat";
    return { send: true, kind, reasons, alarms, coveredKeys: due, primaryAlive };
  }

  /** Call once B's round is mined. */
  markWrote(keys: string[], nowMs: number) {
    for (const k of keys) {
      this.written.set(k, nowMs);
      this.episodes.delete(k);
    }
  }
}
