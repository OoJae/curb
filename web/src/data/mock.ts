/**
 * `?mock=1`: every reader returns fixtures (fixtures/*.json, captured from mainnet) instead of reading
 * the chain or the API. Also the capture fallback for the video.
 * `?regime=open|shut`: forces the regime (theme, chip, favicon) for captures; everything else stays live.
 *
 * Fixtures load with dynamic imports, so they never ship in a page's initial chunk.
 */
import type {
  ApiHealth, AssetBoard, AssetsListing, AuctionLot, CertView, CreditPosition, DepthView, NoteView,
  PointerEpoch, RegimeState, ScorecardView, UnpaidCall, X402Discovery,
} from "./types.ts";

export interface Fixtures {
  regime: RegimeState;
  board: AssetBoard;
  scorecard: ScorecardView;
  x402: X402Discovery;
  health: ApiHealth;
  assets: AssetsListing;
  /** Keyed by route path, e.g. "/v1/closure-calendar". */
  unpaid: Record<string, UnpaidCall>;
  notes: NoteView[];
  lots: AuctionLot[];
  pointer: PointerEpoch[];
  certs: CertView[];
  credit: CreditPosition[];
  depth: DepthView[];
}

function params(): URLSearchParams | null {
  try {
    return typeof location === "undefined" ? null : new URLSearchParams(location.search);
  } catch {
    return null;
  }
}

let forced: boolean | null = null;
/** Tests and scripts can force mock mode on or off (null = follow the URL). */
export function setMock(on: boolean | null): void {
  forced = on;
}

export function isMock(): boolean {
  if (forced !== null) return forced;
  const m = params()?.get("mock");
  return m === "1" || m === "true";
}

export function regimeOverride(): "open" | "shut" | null {
  const r = params()?.get("regime");
  return r === "open" || r === "shut" ? r : null;
}

const J = { with: { type: "json" } } as const;

export async function fixture<K extends keyof Fixtures>(name: K): Promise<Fixtures[K]> {
  let mod: { default: unknown };
  switch (name) {
    case "regime": mod = await import("./fixtures/regime.json", J); break;
    case "board": mod = await import("./fixtures/board.json", J); break;
    case "scorecard": mod = await import("./fixtures/scorecard.json", J); break;
    case "x402": mod = await import("./fixtures/x402.json", J); break;
    case "health": mod = await import("./fixtures/health.json", J); break;
    case "assets": mod = await import("./fixtures/assets.json", J); break;
    case "unpaid": mod = await import("./fixtures/unpaid.json", J); break;
    case "notes": mod = await import("./fixtures/notes.json", J); break;
    case "lots": mod = await import("./fixtures/lots.json", J); break;
    case "pointer": mod = await import("./fixtures/pointer.json", J); break;
    case "certs": mod = await import("./fixtures/certs.json", J); break;
    case "credit": mod = await import("./fixtures/credit.json", J); break;
    case "depth": mod = await import("./fixtures/depth.json", J); break;
    default: throw new Error(`no fixture ${String(name)}`);
  }
  // A structured clone, so a page mutating its view model cannot corrupt the next read.
  return structuredClone(mod.default) as Fixtures[K];
}
