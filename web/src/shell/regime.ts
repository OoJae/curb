/**
 * The site regime: which hours the site keeps. Paper ("open") only when MarketClock reports
 * wTCENTx MARKET with primaryCapNow > 0; otherwise ink ("shut"), or ink + stale copy ("unknown").
 *
 * The reading comes from an injectable `getRegime()`. Lane B's real one lives in
 * `src/data/regime.ts` (export `getRegime`); it is picked up automatically when that file exists.
 * Until then a local fallback returns 'shut'. `?regime=open|shut` forces the displayed regime.
 */
import { flags, type ForcedRegime } from './flags';

export type SiteRegime = 'open' | 'shut' | 'unknown';

export interface RegimeReading {
  /** open = MARKET && cap > 0; shut = any other fresh state; unknown = stale / no attestation */
  regime: SiteRegime;
  /** primaryCapNow in USD (display units), null when unknown */
  cap: number | null;
  /** when MarketClock last attested this asset (observedAt × 1000), epoch ms */
  asOfMs: number;
  /** block number the reading was taken at */
  block: number | null;
  /** next scheduled open/shut change (from data/schedule.ts), epoch ms; drives polling and copy */
  nextChangeAtMs?: number | null;
  /** where the reading came from */
  source?: 'chain' | 'api' | 'fixture' | 'fallback';
}

export type RegimeSource = () => Promise<RegimeReading>;

export interface RegimeState {
  /** last successful reading (null until the first one lands) */
  reading: RegimeReading | null;
  /** the chain's regime (from `reading`; 'shut' before the first reading) */
  live: SiteRegime;
  /** what the page shows: forced ?? preview ?? live */
  shown: SiteRegime;
  /** ?regime= override */
  forced: ForcedRegime | null;
  /** the viewer is previewing the other hours */
  preview: boolean;
  /** last read error, if the latest attempt failed */
  error: unknown;
  /** set once the first attempt (success or failure) has finished */
  settled: boolean;
}

type Listener = (state: RegimeState, prev: RegimeState) => void;

const CACHE_KEY = 'curb:regime';
const MIN_POLL = 5_000;
const MAX_POLL = 60_000;
const ERROR_POLL = 30_000;

/** Local fallback until lane B's data/regime.ts lands: always 'shut', labelled as such. */
export const fallbackRegime: RegimeSource = async () => ({
  regime: 'shut',
  cap: 0,
  asOfMs: Date.now(),
  block: null,
  nextChangeAtMs: null,
  source: 'fallback',
});

// Lane B's module, if present. import.meta.glob resolves to {} when the file does not exist.
const bModules = import.meta.glob<{ getRegime?: () => Promise<unknown> }>('../data/regime.ts', { eager: true });
const bGetRegime = Object.values(bModules)[0]?.getRegime;
const schedModules = import.meta.glob<{ nextChange?: (nowMs: number) => { atMs: number } | null }>('../data/schedule.ts', { eager: true });
const bNextChange = Object.values(schedModules)[0]?.nextChange;

/**
 * Lane B's `getRegime` returns the chain's own vocabulary (data/types.ts RegimeState: `regime`
 * 'CLOSED' | 'MARKET' | …, `paper`, `stale`); the shell speaks SiteRegime. Map one to the other:
 * paper → open, stale or UNKNOWN → unknown, anything else → shut. A source that already returns a
 * RegimeReading passes through unchanged.
 */
function adaptDataRegime(fn: () => Promise<unknown>): RegimeSource {
  return async () => {
    const r = (await fn()) as {
      regime?: string; paper?: boolean; stale?: boolean; cap?: number | null;
      asOfMs?: number; block?: number | null; source?: string; nextChangeAtMs?: number | null;
    };
    if (r.regime === 'open' || r.regime === 'shut' || r.regime === 'unknown') return r as RegimeReading;
    const regime: SiteRegime = r.stale || r.regime === 'UNKNOWN' ? 'unknown' : r.paper ? 'open' : 'shut';
    let nextChangeAtMs: number | null = null;
    try { nextChangeAtMs = bNextChange?.(Date.now())?.atMs ?? null; } catch { nextChangeAtMs = null; }
    return {
      regime,
      cap: typeof r.cap === 'number' ? r.cap : null,
      asOfMs: r.asOfMs ?? Date.now(),
      block: r.block ?? null,
      nextChangeAtMs,
      source: r.source === 'override' || r.source === 'fixture' ? 'fixture' : r.source === 'api' ? 'api' : 'chain',
    };
  };
}

let source: RegimeSource = bGetRegime ? adaptDataRegime(bGetRegime) : fallbackRegime;

/** Inject a regime source (tests, fixtures, or a page that already reads the chain). */
export function setRegimeSource(fn: RegimeSource): void {
  source = fn;
  if (started) void refreshRegime();
}

function initialShown(): SiteRegime {
  if (typeof document === 'undefined') return 'shut';
  const r = document.documentElement.getAttribute('data-regime');
  return r === 'open' || r === 'unknown' ? r : 'shut';
}

const init = initialShown();
let state: RegimeState = {
  reading: null,
  // The early script may have restored a cached live regime; treat it as the provisional live one.
  live: flags.regime ? 'shut' : init,
  shown: flags.regime ?? init,
  forced: flags.regime,
  preview: false,
  error: null,
  settled: false,
};

const listeners = new Set<Listener>();

function paperOpposite(r: SiteRegime): SiteRegime {
  return r === 'open' ? 'shut' : 'open';
}

function computeShown(s: Pick<RegimeState, 'forced' | 'preview' | 'live'>): SiteRegime {
  if (s.forced) return s.forced;
  return s.preview ? paperOpposite(s.live) : s.live;
}

function set(patch: Partial<RegimeState>): void {
  const prev = state;
  const next = { ...state, ...patch };
  next.shown = computeShown(next);
  state = next;
  for (const fn of listeners) {
    try {
      fn(state, prev);
    } catch (err) {
      console.error(err);
    }
  }
}

export function getRegimeState(): RegimeState {
  return state;
}

/** Subscribe to regime changes. Called immediately with the current state unless `immediate` is false. */
export function subscribeRegime(fn: Listener, immediate = true): () => void {
  listeners.add(fn);
  if (immediate) fn(state, state);
  return () => listeners.delete(fn);
}

/** Toggle "preview the other hours" (keyboard-accessible control in the regime chip). */
export function setPreview(on: boolean): void {
  if (state.forced) return;
  set({ preview: on });
}

function writeCache(r: RegimeReading): void {
  try {
    const now = Date.now();
    const until = Math.min(r.nextChangeAtMs ?? now + 10 * 60_000, now + 10 * 60_000);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ regime: r.regime, until }));
  } catch {
    /* storage unavailable: fine */
  }
}

let inflight: Promise<RegimeState> | null = null;

export function refreshRegime(): Promise<RegimeState> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const reading = await source();
      if (reading.source !== 'fallback') writeCache(reading);
      set({ reading, live: reading.regime, error: null, settled: true });
    } catch (error) {
      set({ error, settled: true });
    } finally {
      inflight = null;
      schedule();
    }
    return state;
  })();
  return inflight;
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastRead = 0;

/** Polling interval: clamp((transitionAt − now) / 10, 5 s, 60 s); 30 s after an error. */
export function pollDelay(s: RegimeState = state, now = Date.now()): number {
  if (s.error) return ERROR_POLL;
  const next = s.reading?.nextChangeAtMs;
  if (!next) return MAX_POLL;
  return Math.min(MAX_POLL, Math.max(MIN_POLL, (next - now) / 10));
}

function schedule(): void {
  clearTimeout(timer);
  if (!started || document.hidden) return;
  timer = setTimeout(() => {
    lastRead = Date.now();
    void refreshRegime();
  }, pollDelay());
}

/** Start reading + polling (idempotent). Polling pauses while the tab is hidden. */
export function startRegime(): Promise<RegimeState> {
  if (started) return inflight ?? Promise.resolve(state);
  started = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
    } else if (Date.now() - lastRead > MIN_POLL) {
      lastRead = Date.now();
      void refreshRegime();
    } else {
      schedule();
    }
  });
  lastRead = Date.now();
  return refreshRegime();
}

/** Minutes since the last attestation (for "Clock stale: no attestation for N min."). */
export function staleMinutes(s: RegimeState = state, now = Date.now()): number | null {
  if (!s.reading) return null;
  return Math.max(0, Math.round((now - s.reading.asOfMs) / 60_000));
}
