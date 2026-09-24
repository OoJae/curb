// Read an X Layer transaction and decode the ERC-8021 attribution suffix at the end of its calldata.
//
//   node capture/decode-8021.mjs <txHash> [--rpc https://rpc.xlayer.tech]
//
// Schema 0 (what OKX's integration guide uses): codes ‖ codesLength (1) ‖ schemaId (1) ‖ 0x8021×8.
// The tail is parsed by hand AND by OKX's own decoder (ox, Attribution.fromData); both must agree.
// Read-only: one eth_getTransactionByHash and one eth_getTransactionReceipt.

import { Attribution } from "ox/erc8021";

const args = process.argv.slice(2);
const tx = args.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
const rpcI = args.indexOf("--rpc");
const RPC = rpcI >= 0 ? args[rpcI + 1] : "https://rpc.xlayer.tech";
if (!tx) { console.error("usage: node capture/decode-8021.mjs <txHash> [--rpc url]"); process.exit(2); }

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const t = await rpc("eth_getTransactionByHash", [tx]);
if (!t) { console.error(`not found: ${tx}`); process.exit(1); }
const r = await rpc("eth_getTransactionReceipt", [tx]);
const input = t.input.toLowerCase();
const bytes = (input.length - 2) / 2;

const MARKER = "80218021802180218021802180218021";
const hex = input.slice(2);
const hasMarker = hex.endsWith(MARKER);
const schemaId = parseInt(hex.slice(-MARKER.length - 2, -MARKER.length), 16);
const codesLen = parseInt(hex.slice(-MARKER.length - 4, -MARKER.length - 2), 16);
const codesHex = hex.slice(-MARKER.length - 4 - codesLen * 2, -MARKER.length - 4);
const codes = Buffer.from(codesHex, "hex").toString("utf8");
const suffixBytes = codesLen + 1 + 1 + MARKER.length / 2;
const ox = Attribution.fromData(input);

const pad = (k) => k.padEnd(10);
const n = (x) => Number(x).toLocaleString("en-US");
console.log(`${pad("tx")}${tx}`);
console.log(`${pad("block")}${n(BigInt(t.blockNumber))}  status ${r ? Number(r.status) : "?"}`);
console.log(`${pad("from")}${t.from}`);
console.log(`${pad("to")}${t.to}`);
console.log(`${pad("selector")}${input.slice(0, 10)}`);
console.log(`${pad("calldata")}${n(bytes)} bytes; the last ${suffixBytes} are the attribution suffix`);
console.log(`${pad("tail")}…${hex.slice(-suffixBytes * 2)}`);
console.log("");
const w = Math.max(codesHex.length, MARKER.length) + 3;
const row = (k, h, v) => console.log(`  ${k.padEnd(8)}${h.padEnd(w)}${v}`);
row("codes", codesHex, JSON.stringify(codes));
row("length", hex.slice(-MARKER.length - 4, -MARKER.length - 2), `${codesLen} bytes`);
row("schema", hex.slice(-MARKER.length - 2, -MARKER.length), `schema ${schemaId}`);
row("marker", hasMarker ? MARKER : "(absent)", hasMarker ? "ERC-8021" : "no ERC-8021 marker");
console.log("");
console.log(`${pad("ox")}Attribution.fromData → ${JSON.stringify(ox)}`);
const agree = ox && ox.id === schemaId && JSON.stringify(ox.codes) === JSON.stringify(codes.split(","));
console.log(`${pad("result")}${hasMarker && agree ? "Builder Code " + codes + " attached" : "NO ATTRIBUTION"}`);
process.exit(hasMarker && agree ? 0 : 1);
