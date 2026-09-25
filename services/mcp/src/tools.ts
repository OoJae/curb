/**
 * The six tools, as one table: name, description, input schema, and the function behind it. app.ts builds a
 * fresh McpServer from this table for every request (stateless Streamable HTTP), and GET / lists the same
 * table, so the landing page and tools/list cannot drift apart.
 *
 * Every tool is read-only and free. None of them signs, sends a transaction or pays; curb_paid_services
 * only describes how a wallet holder would. Arguments are checked twice: by the schema (shape and length),
 * then by assets.ts (the symbol must be one of the six), so nothing a caller types reaches an upstream.
 *
 * A thrown error becomes an MCP tool error (isError) with its message, which the SDK does for us; `run` adds
 * a deadline, so a hung upstream answers "timed out" instead of holding the request open, and logs the
 * failure without the caller's arguments beyond the resolved symbol.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ASSETS, requireAsset } from "./assets.ts";
import { readRegimes } from "./clock.ts";
import { nextReopen } from "./nextReopen.ts";
import type { NextReopenDeps } from "./nextReopen.ts";
import { readScorecard, DEFAULT_ROWS, MAX_ROWS } from "./scorecard.ts";
import { readCredit } from "./credit.ts";
import { readCorporateActions, readPaidServices, DEFAULT_VERSIONS, MAX_VERSIONS } from "./asp.ts";
import type { JsonFetch } from "./asp.ts";
import { TtlCache } from "./cache.ts";
import type { Log } from "./log.ts";

export const SERVER_NAME = "curb";
export const SERVER_VERSION = "1.0.0";

export interface ToolDeps extends NextReopenDeps {
  fetchJson: JsonFetch;
  /** Scorecard commit transactions already found, by closure id. Commits are final, so this only grows. */
  commitTxs: Map<string, string>;
  log: Log;
  /** Per-call deadline. Default 20 s. */
  toolTimeoutMs?: number;
}

const SYMBOL_HELP =
  "One of wTCENTx, wXIAOx, wMEITx, wSHEINx (Hong Kong, XHKG) or wNVDAx, wAAPLx (US, XNAS). The issuer ticker (TCENTx) " +
  "or the wrapper address also works, in any case.";
const symbol = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9]+$/, "letters and digits only").describe(SYMBOL_HELP);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Seconds an identical answer is shared for. Every answer names the block or time it was read at. */
  cacheS: number;
  run(deps: ToolDeps, args: Record<string, unknown>): Promise<object>;
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "curb_regime",
    title: "Is the home market open?",
    description:
      "Whether a tokenized stock's home market is open right now, read live from Curb's MarketClock contract on X Layer " +
      "(chain 196). Call this before trading, lending against or liquidating a Hong Kong or US xStock wrapper: while the " +
      "primary market is shut the issuer's order cap is zero, creation and redemption stop, and the pool price is no longer " +
      "held to the underlying share. Returns status OPEN / SHUT / UNKNOWN, the regime code in words, the issuer's order cap " +
      "in USD, any corporate-action blackout, the next published schedule boundary, and when the attestor last read the " +
      "issuer, all at one block. Omit symbol for all six assets.",
    inputSchema: { symbol: symbol.optional() },
    cacheS: 5,
    run: async (d, a) => readRegimes(d.chain, a.symbol === undefined ? ASSETS : [requireAsset(String(a.symbol))]),
  },
  {
    name: "curb_next_reopen",
    title: "When does the home market reopen?",
    description:
      "When primary capacity is expected back for one asset, computed from the issuer's published schedule and limits with " +
      "the rule Curb's keeper commits every Scorecard row under (curb.reopen/1: the issuer cuts capacity 5 minutes before " +
      "each period ends, and it returns at the first period with a non-zero cap). Returns the closure in progress and its " +
      "expected end, or the next closure if the market is open, in UTC and venue-local time, next to MarketClock's live " +
      "state, and says so when the chain and the schedule disagree. The full 1-14 day calendar is a paid route; see curb_paid_services.",
    inputSchema: { symbol },
    cacheS: 5,
    run: async (d, a) => nextReopen(d, requireAsset(String(a.symbol))),
  },
  {
    name: "curb_scorecard",
    title: "Curb's graded record",
    description:
      "Curb's accuracy record from its Scorecard v2 contract on X Layer: skill() (settled rows, and strict wins of Curb's " +
      "reopen mark against the last print and against the closing VWAP; a tie is not a win) and the most recent rows, newest " +
      "first, each with its mark, both baselines, the reopen price the contract read from the pool itself, and the errors in " +
      "basis points, plus the commit transaction to check with curb-verify. Every value is read at one block.",
    inputSchema: { limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Rows to return, newest first. 1-${MAX_ROWS}, default ${DEFAULT_ROWS}.`) },
    cacheS: 15,
    run: async (d, a) => readScorecard(d.chain, a.limit === undefined ? DEFAULT_ROWS : Number(a.limit), d.commitTxs),
  },
  {
    name: "curb_credit",
    title: "What would CurbCredit lend?",
    description:
      "CurbCredit's published loan-to-value for one wrapper on X Layer: ltvFor (min of a regime cap, 60% while the primary " +
      "market is open and 30% while shut, and what the lowest bonded DepthCert bid would pay), ltvEffective, the USDG reserve, " +
      "and the honoured bonded depth behind it, read at one block, with the reason when ltvFor is 0. wSHEINx is not listed " +
      "as collateral.",
    inputSchema: { symbol },
    cacheS: 10,
    run: async (d, a) => readCredit(d.chain, requireAsset(String(a.symbol))),
  },
  {
    name: "curb_corporate_actions",
    title: "Corporate actions",
    description:
      "Every version of the issuer's corporate actions for one asset (dividends, splits, spin-offs; Cancelled and Corrected " +
      "versions included), newest first, from curb-asp's free feed at api.curb.markets. Check it before comparing a wrapper " +
      "price with the underlying share: the wrapper's share price already contains every multiplier change.",
    inputSchema: {
      symbol,
      limit: z.number().int().min(1).max(MAX_VERSIONS).optional().describe(`Versions to return, newest first. 1-${MAX_VERSIONS}, default ${DEFAULT_VERSIONS}.`),
    },
    cacheS: 60,
    run: async (d, a) => readCorporateActions(d.fetchJson, requireAsset(String(a.symbol)), a.limit === undefined ? DEFAULT_VERSIONS : Number(a.limit), d.now),
  },
  {
    name: "curb_paid_services",
    title: "Curb's paid x402 services",
    description:
      "The three answers curb-asp sells over x402 (closure calendar $0.01, accuracy record $0.05, discount by duration $0.10, " +
      "paid in USD₮0 on X Layer): route, parameters, terms read live from api.curb.markets/.well-known/x402, the exact " +
      "onchainos commands to quote and pay, and how to verify the receipt. This tool never pays.",
    inputSchema: {},
    cacheS: 300,
    run: async (d) => readPaidServices(d.fetchJson, d.now),
  },
];

export function toolResult(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

async function withDeadline<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${Math.round(ms / 1000)} s waiting on an upstream (X Layer RPC, the issuer API or api.curb.markets); try again`)), ms);
  });
  try { return await Promise.race([p, deadline]); } finally { clearTimeout(timer); }
}

/** The shared answer caches, one per tool; built once per process and handed to every per-request server. */
export function makeCaches(now: () => number): Map<string, TtlCache<object>> {
  return new Map(TOOLS.map((t) => [t.name, new TtlCache<object>(t.cacheS * 1000, now)]));
}

/** Cache key: the resolved asset, never the caller's spelling, so "TCENTx" and "wtcentx" share an answer. */
function cacheKey(args: Record<string, unknown>): string {
  const sym = typeof args.symbol === "string" ? requireAsset(args.symbol).symbol : "*";
  return `${sym}|${args.limit ?? ""}`;
}

export function buildServer(deps: ToolDeps, caches: Map<string, TtlCache<object>>): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Curb" },
    {
      instructions:
        "Curb reports whether a tokenized stock's home market is open (MarketClock), when it reopens, and how Curb's reopen " +
        "marks were graded on chain (Scorecard), for six xStock wrappers on X Layer. Before trading, lending against or " +
        "liquidating one of them, call curb_regime: a SHUT or UNKNOWN status means creation and redemption are off and the " +
        "pool price is not held to the underlying share. Every answer names the block or time it was read at.",
    },
  );
  const timeoutMs = deps.toolTimeoutMs ?? 20_000;
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...READ_ONLY } },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        try {
          const key = cacheKey(args);
          const value = await withDeadline(caches.get(t.name)!.get(key, () => t.run(deps, args)), timeoutMs, t.name);
          deps.log("tool", { tool: t.name, key, ms: Date.now() - started });
          return toolResult(value);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          deps.log("tool-error", { tool: t.name, ms: Date.now() - started, error: error.slice(0, 300) });
          throw e;
        }
      },
    );
  }
  return server;
}
