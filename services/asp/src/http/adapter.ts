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

  // Explicit fields rather than constructor parameter properties: Node's type stripping only accepts
  // erasable TypeScript syntax.
  constructor(req: IncomingMessage, body: Buffer, publicOrigin: string) {
    this.req = req;
    this.body = body;
    const raw = req.url ?? "/";
    // Parse against a throwaway base, keep only path + query, then re-root on the public origin.
    const parsed = new URL(raw.startsWith("/") ? raw : "/", "http://request.invalid");
    this.url = new URL(parsed.pathname + parsed.search, publicOrigin);
  }

  getHeader(name: string): string | undefined {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(", ") : v;
  }

  getMethod(): string {
    return (this.req.method ?? "GET").toUpperCase();
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
