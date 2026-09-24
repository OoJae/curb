/**
 * x402-core's framework-agnostic HTTPAdapter, over a bare node:http request.
 *
 * @okxweb3/x402-express is a thin shim over exactly this interface; implementing it directly keeps the
 * service on the same hand-rolled createServer as the keeper and attestor, with no framework between
 * the payment layer and the socket. The SDK reads the payment from `getHeader("payment-signature")`,
 * the route from `getMethod()`/`getPath()`, and decides "browser or agent" from `getAcceptHeader()` and
 * `getUserAgent()`.
 *
 * The URL is rebuilt on the configured public origin from the request's path and query only. A request
 * line in absolute form (`GET http://elsewhere/...`) or a Host header must never decide what URL the
 * SDK writes into a payment challenge, so neither is read.
 */
import type { IncomingMessage } from "node:http";
import type { HTTPAdapter } from "@okxweb3/x402-core/server";

export class BodyTooLarge extends Error {}

export type AdapterRefusal = { ok: false; status: number; body: Record<string, unknown> };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A POST body's parameters as name/value pairs: a flat JSON object of strings, numbers or booleans, or a
 * form-encoded body. Null values count as absent. Anything else is a refusal naming what is accepted.
 */
function bodyParams(body: Buffer, contentType: string): Array<[string, string]> | AdapterRefusal {
  const text = body.toString("utf8");
  if (text.trim() === "") return [];
  const refusal = (detail: string): AdapterRefusal => ({ ok: false, status: 400, body: { error: "bad-body", detail } });
  if (contentType.includes("x-www-form-urlencoded")) return [...new URLSearchParams(text)];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return refusal("the body must be a JSON object of parameters, or form-encoded"); }
  if (!isPlainObject(parsed)) return refusal("the body must be a JSON object of parameters");
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      return refusal(`parameter ${JSON.stringify(k.slice(0, 64))} must be a string or a number`);
    }
    out.push([k, String(v)]);
  }
  return out;
}

/** Buffer the request body, refusing past `limitBytes` so a slow upload cannot hold memory. */
export async function bufferBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.byteLength;
    if (size > limitBytes) throw new BodyTooLarge(`request body over ${limitBytes} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export class NodeHttpAdapter implements HTTPAdapter {
  readonly req: IncomingMessage;
  readonly body: Buffer;
  readonly url: URL;
  readonly method: string;

  // Explicit fields rather than constructor parameter properties: Node's type stripping only accepts
  // erasable TypeScript syntax. `view` is for asGet() only: the same request under another method and URL.
  constructor(req: IncomingMessage, body: Buffer, publicOrigin: string, view?: { method: string; url: URL }) {
    this.req = req;
    this.body = body;
    if (view) {
      this.method = view.method;
      this.url = view.url;
      return;
    }
    this.method = (req.method ?? "GET").toUpperCase();
    const raw = req.url ?? "/";
    // Parse against a throwaway base, keep only path + query, then re-root on the public origin.
    const parsed = new URL(raw.startsWith("/") ? raw : "/", "http://request.invalid");
    this.url = new URL(parsed.pathname + parsed.search, publicOrigin);
  }

  /**
   * This request as the GET it stands for. A priced route answers POST exactly as it answers GET: OKX's
   * A2MCP self-check probes an endpoint with `curl -i -X POST` and no parameters, and a buyer agent may send
   * its parameters as a body rather than a query string. Body parameters join the query string, so a
   * route's `accept` parses one set of parameters however they arrived; a name given in both with a
   * different value is refused, since it is then ambiguous what is being bought. The view has no body.
   */
  asGet(): { ok: true; adapter: NodeHttpAdapter } | AdapterRefusal {
    if (this.method === "GET") return { ok: true, adapter: this };
    const params = bodyParams(this.body, this.getHeader("content-type") ?? "");
    if (!Array.isArray(params)) return params;
    const url = new URL(this.url);
    for (const [k, v] of params) {
      const inUrl = url.searchParams.getAll(k);
      if (inUrl.length === 0) url.searchParams.append(k, v);
      else if (inUrl.length > 1 || inUrl[0] !== v) {
        return { ok: false, status: 400, body: { error: "conflicting-parameter", parameter: k.slice(0, 64) } };
      }
    }
    return { ok: true, adapter: new NodeHttpAdapter(this.req, Buffer.alloc(0), url.origin, { method: "GET", url }) };
  }

  getHeader(name: string): string | undefined {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(", ") : v;
  }

  getMethod(): string {
    return this.method;
  }

  getPath(): string {
    return this.url.pathname;
  }

  getUrl(): string {
    return this.url.toString();
  }

  getAcceptHeader(): string {
    return this.getHeader("accept") ?? "";
  }

  getUserAgent(): string {
    return this.getHeader("user-agent") ?? "";
  }

  getQueryParams(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const key of new Set(this.url.searchParams.keys())) {
      const all = this.url.searchParams.getAll(key);
      out[key] = all.length === 1 ? all[0] : all;
    }
    return out;
  }

  getQueryParam(name: string): string | string[] | undefined {
    const all = this.url.searchParams.getAll(name);
    if (all.length === 0) return undefined;
    return all.length === 1 ? all[0] : all;
  }

  getBody(): unknown {
    if (this.body.byteLength === 0) return undefined;
    const text = this.body.toString("utf8");
    if ((this.getHeader("content-type") ?? "").includes("json")) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return text;
  }
}
