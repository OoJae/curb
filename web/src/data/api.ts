/**
 * api.curb.markets: the free routes, and unpaid calls to the priced ones.
 *
 * An unpaid call to a priced route answers HTTP 402 with the x402 challenge base64-encoded in the
 * PAYMENT-REQUIRED header (exposed to browsers via Access-Control-Expose-Headers) and a free preview in
 * the body. "Ask without paying" on /api and the home page's agent section render exactly that.
 * Data rule: never use the API for a number that lives on chain; this is the fallback and the demo.
 */
import { API_BASE } from "./addresses.ts";
import { fixture, isMock } from "./mock.ts";
import type { ApiHealth, ApiPreview, ApiRoute, AssetsListing, PaymentRequired, UnpaidCall, X402Discovery } from "./types.ts";

export const PRICED_ROUTES = ["/v1/closure-calendar", "/v1/accuracy-record", "/v1/discount-curve"] as const;
export type PricedRoute = (typeof PRICED_ROUTES)[number];

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: http ${res.status}`);
  return (await res.json()) as T;
}

/** base64 → UTF-8 JSON (the header carries non-ASCII, e.g. "USD₮0"). */
export function decodePaymentRequired(header: string): PaymentRequired {
  const bin = atob(header.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as PaymentRequired;
}

/** "10000" base units of a 6-dp token → "$0.01". */
export function formatUsd6(amount: string): string {
  const n = Number(amount) / 1e6;
  return `$${n < 1 ? n.toFixed(2) : n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

type RawRoute = Omit<ApiRoute, "amount" | "asset" | "network" | "payTo" | "scheme" | "maxTimeoutSeconds"> & {
  accepts: { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number }[];
};

/** GET /.well-known/x402, with each route's first `accepts` entry flattened onto it. */
export async function getX402(signal?: AbortSignal): Promise<X402Discovery> {
  if (isMock()) return fixture("x402");
  const raw = await getJson<Omit<X402Discovery, "routes"> & { routes: RawRoute[] }>("/.well-known/x402", signal);
  return {
    ...raw,
    routes: raw.routes.map(({ accepts, ...r }) => {
      const a = accepts?.[0];
      return {
        ...r,
        amount: a?.amount ?? "0",
        asset: (a?.asset ?? "0x") as ApiRoute["asset"],
        network: a?.network ?? "",
        payTo: (a?.payTo ?? "0x") as ApiRoute["payTo"],
        scheme: a?.scheme ?? "",
        maxTimeoutSeconds: a?.maxTimeoutSeconds ?? 0,
      };
    }),
  };
}

export async function getHealth(signal?: AbortSignal): Promise<ApiHealth> {
  if (isMock()) return fixture("health");
  return getJson<ApiHealth>("/healthz", signal);
}

export async function getAssets(signal?: AbortSignal): Promise<AssetsListing> {
  if (isMock()) return fixture("assets");
  return getJson<AssetsListing>("/v1/assets", signal);
}

/**
 * Call a priced route without paying: {status, paymentRequired (decoded header), preview (body)}.
 * Nothing is signed or sent but a plain GET.
 */
export async function askWithoutPaying<P = ApiPreview>(
  path: PricedRoute | string,
  query: Record<string, string | number> = {},
  signal?: AbortSignal,
): Promise<UnpaidCall<P>> {
  if (isMock()) {
    const all = await fixture("unpaid");
    const hit = all[path];
    if (!hit) throw new Error(`no unpaid fixture for ${path}`);
    return hit as UnpaidCall<P>;
  }
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  const header = res.headers.get("payment-required");
  let paymentRequired: PaymentRequired | null = null;
  if (header) {
    try {
      paymentRequired = decodePaymentRequired(header);
    } catch {
      paymentRequired = null;
    }
  }
  let preview: P | null = null;
  try {
    preview = (await res.json()) as P;
  } catch {
    preview = null;
  }
  return { url, status: res.status, paymentRequired, preview, readAtMs: Date.now(), source: "api" };
}
