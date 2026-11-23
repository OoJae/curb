#!/usr/bin/env node
// Does OKX's x402 Broker accept curb-asp's API key? Run it yourself; it never prints the key.
//
//   node script/asp/okx-key-check.mjs [path-to-env-file]      (default ~/.foundry/curb-secrets/okx-api.env)
//
// It signs two requests exactly as @okxweb3/x402-core 0.1.0 does (OK-ACCESS-* headers, HMAC-SHA256 over
// timestamp + method + path + body) and prints only each HTTP status and OKX's own {code, msg}:
//   GET  /api/v6/pay/x402/supported   a key OKX accepts answers 200
//   POST /api/v6/pay/x402/verify      with an empty payment: a key OKX accepts gets a validation error
//                                     (4xx other than 401), a rejected key gets 401, as curb-asp did on
//                                     23 Nov 2026 ("OKX verify failed: 401")
// Nothing is paid, settled or changed. Any occurrence of the key, secret or passphrase in OKX's reply is
// replaced with [redacted] before printing.
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const file = process.argv[2] ?? join(homedir(), ".foundry", "curb-secrets", "okx-api.env");
const env = {};
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}
const need = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"];
const missing = need.filter((k) => !env[k]);
if (missing.length) { console.log(`missing in ${file}: ${missing.join(", ")} (names only)`); process.exit(2); }
const secrets = need.map((k) => env[k]);
const redact = (s) => secrets.reduce((acc, v) => (v ? acc.split(v).join("[redacted]") : acc), s);

const BASE = "https://web3.okx.com";
function headers(method, path, body = "") {
  const ts = new Date().toISOString();
  const sign = createHmac("sha256", env.OKX_SECRET_KEY).update(ts + method + path + body).digest("base64");
  return {
    "OK-ACCESS-KEY": env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": env.OKX_PASSPHRASE, "Content-Type": "application/json",
  };
}
async function call(method, path, body) {
  try {
    const res = await fetch(BASE + path, { method, headers: headers(method, path, body ?? ""), body, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let summary = text.slice(0, 300);
    try { const j = JSON.parse(text); summary = JSON.stringify({ code: j.code ?? null, msg: j.msg ?? j.message ?? j.error ?? null }); } catch {}
    console.log(`${method} ${path} -> HTTP ${res.status} ${redact(summary)}`);
    return res.status;
  } catch (e) {
    console.log(`${method} ${path} -> no answer (${redact(String(e?.cause?.code ?? e?.name ?? e))})`);
    return 0;
  }
}

const s = await call("GET", "/api/v6/pay/x402/supported");
const v = await call("POST", "/api/v6/pay/x402/verify", JSON.stringify({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} }));
console.log(
  s === 200 && v !== 401 && v !== 0 ? "VERDICT: OKX accepts this key (verify reached payment validation)."
  : s === 401 || v === 401 ? "VERDICT: OKX rejects this key (401). Create a new API key in the OKX developer portal."
  : "VERDICT: unclear; send the two lines above (they contain no secret).",
);
