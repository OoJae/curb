/**
 * The two inputs of the corporate-actions feed (corporateActions.ts): the issuer's versioned history, page by
 * page, and the current multiplier state of the cohort's raw tokens.
 *
 * The issuer: `GET /corporate-actions/history?pageSize=100&page=N`. Measured 24 Sep 2026: `limit` is ignored,
 * `pageSize=100` is honoured (776 nodes over 8 pages), the body is `{page: {currentPage, pageSize, totalPages,
 * totalNodes, hasNextPage, hasPreviousPage}, nodes: [...]}`, and nodes are sorted by effective time descending
 * with future and Cancelled versions included. A new action lands on page 1 and pushes every later node down,
 * so nothing short of a full sweep is ever complete. The endpoint answers 503 now and then, so every page is
 * retried with backoff, and every attempt has its own deadline.
 *
 * The chain: one Multicall3 batch, pinned by block hash, of getCurrentMultiplier() and the pending
 * newMultiplier / newMultiplierNonce / newMultiplierActivationTime for each raw token. Only the current state is
 * read -- no archive calls -- and only for the tokens MarketClock has registered.
 */
import { XStocksClient, API_BASE } from "./xstocks.ts";
import { pinLatest, multicallAt, rawTokenCalls, decodeRawToken } from "./chain.ts";
import type { PinnedBlock, RawTokenState } from "./chain.ts";

export const CA_PAGE_SIZE = 100;
/** A sweep that has not ended after this many pages is refused rather than run forever: 776 nodes today is 8. */
export const CA_MAX_PAGES = 100;

export interface CaPage {
  url: string;
  page: number;
  totalPages: number;
  totalNodes: number;
  hasNextPage: boolean;
  nodes: unknown[];
  /** keccak256 of the exact body bytes, for the log line. */
  bodyHash: string;
}

export interface CaClientOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Deadline for one HTTP attempt. */
  timeoutMs?: number;
  /** Attempts per page, the first included. */
  attempts?: number;
  /** Backoff before attempt k+1 is backoffMs * 2^(k-1). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export class CorporateActionsClient {
  readonly base: string;
  private readonly http: XStocksClient;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: CaClientOptions = {}) {
    this.base = o.base ?? API_BASE;
    this.http = new XStocksClient(this.base, o.fetchImpl ?? fetch, o.now ?? Date.now);
    // Measured 24 Sep 2026: 1.3-3.6 s a page, uncached (cf-cache-status DYNAMIC), with stalls past 10 s.
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.attempts = Math.max(1, o.attempts ?? 4);
    this.backoffMs = o.backoffMs ?? 1_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  pageUrl(page: number): string {
    return `${this.base}/corporate-actions/history?pageSize=${CA_PAGE_SIZE}&page=${page}`;
  }

  /**
   * One page, parsed and shape-checked. A 4xx other than 429 is not retried: asking again will not change it.
   * Throws with the last attempt's reason.
   */
  async page(page: number): Promise<CaPage> {
    const url = this.pageUrl(page);
    let last = "";
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const ex = await this.http.get(url, this.timeoutMs);
      // The client keeps a fetch log for the attestor's rounds; this feed has no round to commit it to.
      this.http.takeLog();
      if (ex.ok && ex.body && ex.bodyHash) {
        try {
          return parsePage(url, page, ex.body, ex.bodyHash);
        } catch (e) {
          last = describe(e);
        }
      } else {
        last = ex.error ?? `http ${ex.status}`;
        if (ex.status >= 400 && ex.status < 500 && ex.status !== 429) break;
      }
      if (attempt < this.attempts) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
    }
    throw new Error(`corporate-actions page ${page}: ${last}`);
  }
}

export function parsePage(url: string, page: number, body: Uint8Array, bodyHash: string): CaPage {
  const j = JSON.parse(new TextDecoder().decode(body)) as { page?: Record<string, unknown>; nodes?: unknown };
  const p = j?.page;
  if (!p || typeof p !== "object") throw new Error("body has no `page` object");
  if (!Array.isArray(j.nodes)) throw new Error("body has no `nodes` array");
  if (!isInt(p.totalPages) || !isInt(p.totalNodes) || typeof p.hasNextPage !== "boolean") throw new Error("`page` is missing totalPages, totalNodes or hasNextPage");
  if (p.currentPage !== undefined && p.currentPage !== page) throw new Error(`asked for page ${page}, got page ${String(p.currentPage)}`);
  return { url, page, totalPages: p.totalPages, totalNodes: p.totalNodes, hasNextPage: p.hasNextPage, nodes: j.nodes, bodyHash };
}

export interface ChainMultipliers {
  block: PinnedBlock;
  /** One entry per raw token asked for; `readFailed` marks a token whose getCurrentMultiplier did not decode. */
  tokens: RawTokenState[];
}

/** Current multiplier state for each raw token, from one pinned block. Bounded by chain.ts's own deadlines. */
export async function readMultipliers(rpcs: string[], raws: string[]): Promise<ChainMultipliers> {
  const block = await pinLatest(rpcs);
  if (raws.length === 0) return { block, tokens: [] };
  const snap = await multicallAt(block, raws.flatMap(rawTokenCalls), rpcs);
  return { block, tokens: raws.map((r) => decodeRawToken(r, snap.results)) };
}
