/**
 * Who is asking, for per-client limits.
 *
 * The service runs behind Railway's edge, so the socket's peer is always the edge. Railway documents
 * X-Real-IP as the client's remote address ("Networking > Specs & Limits"), and that is the only source
 * read here. X-Forwarded-For is not: its leftmost entries are whatever the client wrote.
 *
 * No usable header means no key, and a caller without a key is held only by the global limits that already
 * apply to everyone. That is the safe way round: a missing or garbled header must never pool every client
 * into one bucket (a limit meant for one caller would then throttle all of them, the keeper included).
 * Deployed, the edge always sets it; locally and in tests there is no edge and so no per-client limit.
 *
 * IPv6 clients are keyed by their /64: one host is routinely handed a whole /64, and keying on the full
 * address would give it 2^64 buckets. An IPv4-mapped address is keyed as the IPv4 address it carries.
 */
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/** A full IPv6 address as eight 16-bit groups, or null. `s` has passed isIP(s) === 6. */
function ipv6Groups(s: string): number[] | null {
  let text = s.toLowerCase();
  const tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    tail.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
    text = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const [head, rest] = text.includes("::") ? text.split("::") : [text, null];
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const left = parse(head);
  const right = rest === null ? [] : parse(rest);
  const fill = 8 - left.length - right.length - tail.length;
  if (fill < 0 || (rest === null && fill !== 0)) return null;
  const groups = [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The per-client key for one address literal, or null when it is not one. */
export function clientKeyOf(address: string): string | null {
  const a = address.trim();
  const kind = isIP(a);
  if (kind === 4) return a;
  if (kind !== 6) return null;
  const g = ipv6Groups(a);
  if (!g) return null;
  // ::ffff:a.b.c.d is an IPv4 client seen through a dual-stack socket.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The request's client key from X-Real-IP, or null when there is none to trust (see above). */
export function clientKey(req: IncomingMessage): string | null {
  const v = req.headers["x-real-ip"];
  // Node joins a repeated unknown header with ", ", which is not an address and so yields no key.
  return typeof v === "string" ? clientKeyOf(v) : null;
}
