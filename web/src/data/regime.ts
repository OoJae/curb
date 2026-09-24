/**
 * The site's regime: what the chip says, which theme the site wears, which glyph the favicon shows.
 *
 * Rules (docs/specs/brand-site-video.md §3):
 *   - chain first: stateOf(wTCENTx) via rpc-lite (no viem on the global path);
 *   - paper (ivory) only when regime == MARKET && primaryCapNow > 0; everything else is Street ink;
 *   - stale = the attestation is older than 30 min (MarketClock.MAX_ATTESTATION_AGE): the regime reads
 *     UNKNOWN and the cap 0, exactly as MarketClock.regime()/primaryCapNow() report it, and the chip says
 *     "Clock stale: no attestation for N min.";
 *   - polling: clamp((transitionAt − now) / 10, 5 s, 60 s), paused while the tab is hidden.
 */
import { HERO_WRAPPER, symbolOf } from "./addresses.ts";
import { fixture, isMock, regimeOverride } from "./mock.ts";
import { readStateOf, type RawState } from "./rpc-lite.ts";
import { nextChange } from "./schedule.ts";
import { REGIME_NAMES, type Address, type DataSource, type Glyph, type RegimeName, type RegimeState } from "./types.ts";

export const MAX_ATTESTATION_AGE_MS = 30 * 60_000;
export const POLL_MIN_MS = 5_000;
export const POLL_MAX_MS = 60_000;

export function regimeName(code: number): RegimeName {
  return REGIME_NAMES[code] ?? "UNKNOWN";
}

export function isPaper(regime: RegimeName, cap: number): boolean {
  return regime === "MARKET" && cap > 0;
}

export function glyphOf(regime: RegimeName, cap: number): Glyph {
  if (regime === "UNKNOWN") return "unknown";
  return cap > 0 ? "open" : "shut";
}

/** Apply MarketClock's staleness rule to a raw stateOf read. Pure. */
export function toRegimeState(raw: RawState, wrapper: Address, nowMs: number, source: DataSource = "chain"): RegimeState {
  const observedMs = raw.observedAt * 1000;
  const stale = raw.observedAt === 0 || nowMs - observedMs > MAX_ATTESTATION_AGE_MS;
  const attestedRegime = regimeName(raw.regime);
  const regime: RegimeName = stale ? "UNKNOWN" : attestedRegime;
  const cap = regime === "UNKNOWN" ? 0 : Number(raw.cap);
  return {
    symbol: symbolOf(wrapper),
    wrapper,
    regime,
    attestedRegime,
    cap,
    asOfMs: observedMs,
    readAtMs: nowMs,
    block: raw.block,
    stale,
    attestedAgoMin: raw.observedAt === 0 ? null : Math.max(0, Math.floor((nowMs - observedMs) / 60_000)),
    nextTransitionAtMs: raw.nextTransitionAt ? raw.nextTransitionAt * 1000 : null,
    halted: raw.halted,
    multiplierNonce: raw.multiplierNonce,
    paper: isPaper(regime, cap),
    glyph: glyphOf(regime, cap),
    source,
  };
}

function overridden(kind: "open" | "shut", wrapper: Address, nowMs: number): RegimeState {
  const open = kind === "open";
  return toRegimeState(
    { regime: open ? 4 : 1, cap: open ? 100_000n : 0n, nextTransitionAt: 0, observedAt: Math.floor(nowMs / 1000) - 60, multiplierNonce: 0, halted: false, block: null },
    wrapper, nowMs, "override",
  );
}

/**
 * The regime for `wrapper` (default wTCENTx): `{regime, cap, asOfMs, block, stale, …}`.
 * Honors ?regime=open|shut (captures) and ?mock=1 (fixtures).
 */
export async function getRegime(opts: { wrapper?: Address; signal?: AbortSignal; nowMs?: number } = {}): Promise<RegimeState> {
  const wrapper = opts.wrapper ?? HERO_WRAPPER;
  const now = opts.nowMs ?? Date.now();
  const o = regimeOverride();
  if (o) return overridden(o, wrapper, now);
  if (isMock()) return fixture("regime");
  return toRegimeState(await readStateOf(wrapper, opts.signal), wrapper, now);
}

/**
 * The smart polling rule: clamp((transitionAt − now) / 10, 5 s, 60 s). Near a boundary it polls every
 * 5 s so the flip shows within seconds of the attestation; far from one, once a minute. A transition
 * more than 10 minutes overdue (the chain never flipped: an attestor outage) stops forcing fast polls.
 */
export function pollDelayMs(transitionAtMs: number | null, nowMs: number): number {
  if (transitionAtMs === null) return POLL_MAX_MS;
  const delta = transitionAtMs - nowMs;
  if (delta < -10 * 60_000) return POLL_MAX_MS;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, delta / 10));
}

/**
 * The next instant the regime could change: the schedule's next cut/reopen, or the moment the
 * current attestation goes stale, whichever is sooner.
 */
export function nextTransitionMs(state: RegimeState | null, nowMs: number): number | null {
  const sched = nextChange(nowMs)?.atMs ?? null;
  const staleAt = state && !state.stale && state.asOfMs ? state.asOfMs + MAX_ATTESTATION_AGE_MS : null;
  if (sched === null) return staleAt;
  if (staleAt === null) return sched;
  return Math.min(sched, staleAt);
}

export interface WatchOptions {
  wrapper?: Address;
  onError?: (e: unknown) => void;
}

/**
 * Poll the regime with the smart rule, paused while the document is hidden (resumes with an immediate
 * read on visibility). Calls `onState` on every successful read; returns a stop function.
 * `onState` receives `changed` = regime or cap differ from the previous read (drive aria-live and the
 * theme flip from that, never from every poll).
 */
export function watchRegime(onState: (s: RegimeState, changed: boolean) => void, opts: WatchOptions = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let last: RegimeState | null = null;
  let ctl: AbortController | null = null;
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  // mock/override never changes: read once
  const isStatic = () => isMock() || regimeOverride() !== null;

  const schedule = () => {
    if (stopped || hidden()) return;
    const now = Date.now();
    timer = setTimeout(tick, pollDelayMs(nextTransitionMs(last, now), now));
  };

  const tick = async () => {
    timer = null;
    if (stopped) return;
    const my = (ctl = new AbortController());
    try {
      const s = await getRegime({ wrapper: opts.wrapper, signal: my.signal });
      const changed = !last || last.regime !== s.regime || last.cap !== s.cap || last.stale !== s.stale;
      last = s;
      onState(s, changed);
    } catch (e) {
      if (!my.signal.aborted) opts.onError?.(e);
    }
    if (my.signal.aborted || isStatic()) return;
    schedule();
  };

  const onVis = () => {
    if (hidden()) {
      if (timer) clearTimeout(timer);
      timer = null;
      ctl?.abort();
    } else if (!timer && !stopped) {
      void tick();
    }
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ctl?.abort();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
  };
}
