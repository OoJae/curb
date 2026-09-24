/**
 * Writing responses: the SDK's HTTPResponseInstructions, and our own JSON and byte bodies.
 *
 * Everything leaves through `send`, so every response carries the same CORS headers. Agents that run in
 * a browser (and the OKX marketplace's own console) need to READ the x402 headers, which a browser hides
 * from script unless they are listed in Access-Control-Expose-Headers -- a challenge an agent cannot see
 * is a challenge it cannot pay.
 *
 * Header names are lower-cased on the way out. The SDK writes `Content-Type` and `PAYMENT-REQUIRED`;
 * merging those with our own `content-type` in two spellings would leave which one wins to Node.
 */
import type { ServerResponse } from "node:http";
import type { HTTPResponseInstructions } from "@okxweb3/x402-core/server";

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, Accept",
  "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, x-curb-receipt",
};

function lower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

export function send(res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}): void {
  const h = { ...CORS_HEADERS, ...lower(headers) };
  h["content-length"] = String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);
  res.writeHead(status, h);
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(body), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
}

/** Apply the SDK's instructions verbatim: its status, its headers (the challenge lives in PAYMENT-REQUIRED), its body. */
export function applyInstructions(res: ServerResponse, instr: HTTPResponseInstructions, extra: Record<string, string> = {}): void {
  const headers = lower(instr.headers ?? {});
  let body: string;
  if (typeof instr.body === "string") {
    body = instr.body;
    headers["content-type"] ??= instr.isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  } else {
    body = JSON.stringify(instr.body ?? {});
    headers["content-type"] ??= "application/json";
  }
  send(res, instr.status, body, { "cache-control": "no-store", ...headers, ...lower(extra) });
}
