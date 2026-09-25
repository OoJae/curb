/**
 * The HTTP surface.
 *
 *   GET  /         what this is and the tools, as JSON (built from the same table tools/list serves)
 *   GET  /healthz  liveness, and the last chain head any tool read (no upstream call of its own)
 *   POST /mcp      MCP over Streamable HTTP, stateless: a fresh server and transport per request, JSON
 *                  responses rather than SSE, no session id. GET and DELETE /mcp are 405, because a stateless
 *                  server has no stream to resume and no session to end. The body is capped at 64 KiB.
 *
 * Every response carries CORS headers, so a browser-based MCP client or a page can call it. Every route except
 * /healthz (which Railway's healthcheck polls) takes a token from the caller's rate-limit bucket first, and a
 * refusal is 429 with Retry-After (a JSON-RPC error body on /mcp, so an MCP client can show it).
 *
 * Nothing here is secret and nothing needs a key: the service reads public RPCs, the issuer's public API and
 * curb-asp's free routes. Error strings name RPC endpoints by origin only (sources/chain.ts endpointLabel).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ASSETS, CONTRACTS, CHAIN_ID } from "./assets.ts";
import { TOOLS, SERVER_NAME, SERVER_VERSION, buildServer } from "./tools.ts";
import type { ToolDeps } from "./tools.ts";
import type { TtlCache } from "./cache.ts";
import { RateLimiter, clientIp } from "./rateLimit.ts";
import type { Log } from "./log.ts";

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "access-control-expose-headers": "Mcp-Session-Id, Mcp-Protocol-Version, Retry-After",
  "access-control-max-age": "600",
};

/** An MCP request is a few hundred bytes; nothing legitimate comes near this. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface AppState {
  bootMs: number;
  requests: number;
  mcpRequests: number;
  rateLimited: number;
}

export interface AppDeps {
  tools: ToolDeps;
  caches: Map<string, TtlCache<object>>;
  limiter: RateLimiter;
  trustProxyHops: number;
  publicUrl: string;
  state: AppState;
  now: () => number;
  log: Log;
  /** For /healthz: the last head a tool pinned, if any. */
  lastHead?: () => { block: number; timestamp: number } | null;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

/**
 * The request body, read here rather than by the transport so it can be bounded and normalised first. Over
 * `max` bytes is a 413 as soon as the limit is crossed (the rest is never buffered); unparseable JSON is the
 * JSON-RPC parse error.
 */
export async function readJson(req: IncomingMessage, max: number): Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: number; message: string }> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (declared > max) return { ok: false, status: 413, code: -32600, message: `request body over ${max} bytes` };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return { ok: false, status: 413, code: -32600, message: `request body over ${max} bytes` };
    chunks.push(chunk as Buffer);
  }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; } catch {
    return { ok: false, status: 400, code: -32700, message: "Parse error: the body is not JSON" };
  }
}

/**
 * JSON-RPC lets a tools/call leave out `arguments`, and the SDK then validates `undefined` against the tool's
 * object schema and refuses. For a tool whose arguments are all optional (curb_regime with no symbol,
 * curb_paid_services) that refusal is wrong, so a missing `arguments` is read as `{}`. Nothing else is touched.
 */
export function withDefaultArguments(body: unknown): unknown {
  const fix = (m: unknown) => {
    if (m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call") {
      const p = (m as { params?: unknown }).params;
      if (p && typeof p === "object" && !Array.isArray(p) && (p as { arguments?: unknown }).arguments === undefined) {
        (p as { arguments?: unknown }).arguments = {};
      }
    }
    return m;
  };
  return Array.isArray(body) ? body.map(fix) : fix(body);
}

export function landing(publicUrl: string) {
  return {
    name: "curb-mcp",
    description:
      "A Model Context Protocol server for Curb: whether a tokenized stock's home market is open, when it reopens, and how " +
      "Curb's reopen marks were graded on chain, for six xStock wrappers on X Layer. Read-only, free, no key.",
    mcp: { url: `${publicUrl}/mcp`, transport: "streamable-http (stateless, JSON responses)", protocol: "Model Context Protocol" },
    connect: {
      claudeCode: `claude mcp add --transport http curb ${publicUrl}/mcp`,
      generic: `POST ${publicUrl}/mcp with Accept: application/json, text/event-stream`,
    },
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, arguments: Object.keys(t.inputSchema) })),
    assets: ASSETS.map((a) => ({ symbol: a.symbol, ticker: a.ticker, wrapper: a.wrapper, venue: a.mic })),
    contracts: { chainId: CHAIN_ID, ...CONTRACTS },
    links: { site: "https://curb.markets", api: "https://api.curb.markets", health: `${publicUrl}/healthz` },
    server: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

export function createApp(d: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const home = landing(d.publicUrl);
  const proxyShapes = new Set<number>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    d.state.requests++;
    const method = req.method ?? "GET";
    let path: string;
    try { path = new URL(req.url ?? "/", "http://x").pathname; } catch { return send(res, 400, { error: "bad-request" }); }
    if (path.length > 1) path = path.replace(/\/+$/, "");

    if (method === "OPTIONS") {
      res.writeHead(204, { ...CORS_HEADERS, "content-length": "0" });
      return void res.end();
    }
    if (path === "/healthz") {
      if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "method-not-allowed" }, { allow: "GET, OPTIONS" });
      return send(res, 200, {
        ok: true,
        service: "curb-mcp",
        version: SERVER_VERSION,
        uptimeS: Math.round((d.now() - d.state.bootMs) / 1000),
        requests: d.state.requests,
        mcpRequests: d.state.mcpRequests,
        rateLimited: d.state.rateLimited,
        lastHead: d.lastHead?.() ?? null,
      });
    }

    const ip = clientIp(req, d.trustProxyHops);
    {
      // Without any address: each distinct count of X-Forwarded-For entries the edge delivers, logged once (at most
      // ten), so an operator can confirm TRUST_PROXY_HOPS matches the proxy in front. See the README, "Deploy".
      const xff = req.headers["x-forwarded-for"];
      const n = xff ? String(xff).split(",").filter((s) => s.trim()).length : 0;
      if (!proxyShapes.has(n) && proxyShapes.size < 10) {
        proxyShapes.add(n);
        d.log("proxy-shape", { xffEntries: n, trustProxyHops: d.trustProxyHops });
      }
    }
    const take = d.limiter.take(ip);
    if (!take.ok) {
      d.state.rateLimited++;
      const headers = { "retry-after": String(take.retryAfterS) };
      if (path === "/mcp") return send(res, 429, jsonRpcError(-32000, `rate limited: retry after ${take.retryAfterS} s`), headers);
      return send(res, 429, { error: "rate-limited", retryAfterS: take.retryAfterS }, headers);
    }

    if (path === "/") {
      if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "method-not-allowed" }, { allow: "GET, OPTIONS" });
      return send(res, 200, home, { "cache-control": "public, max-age=300" });
    }
    if (path === "/mcp") {
      if (method !== "POST") {
        return send(res, 405, jsonRpcError(-32000, "Method not allowed: this server is stateless; send JSON-RPC by POST."), { allow: "POST, OPTIONS" });
      }
      return mcp(req, res);
    }
    return send(res, 404, { error: "not-found", see: "/" });
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    d.state.mcpRequests++;
    const body = await readJson(req, MAX_BODY_BYTES);
    if (!body.ok) return send(res, body.status, jsonRpcError(body.code, body.message));
    // CORS on the transport's own responses: headers set here survive its writeHead.
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    res.setHeader("x-content-type-options", "nosniff");
    const server = buildServer(d.tools, d.caches);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, withDefaultArguments(body.value));
  }

  return (req, res) => {
    handle(req, res).catch((e) => {
      d.log("http-handler-error", { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.destroy();
    });
  };
}
