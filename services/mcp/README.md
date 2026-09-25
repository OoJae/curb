# curb-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI agent can ask Curb whether a
tokenized stock's home market is open before it trades, lends or liquidates. Streamable HTTP, stateless, JSON
responses. Every tool is read-only and free; the service holds no key, sends no transaction, pays for nothing and
needs no secret. The Agent Skill that tells an agent when to call it is [`skills/curb/SKILL.md`](../../skills/curb/SKILL.md).

```bash
claude mcp add --transport http curb https://mcp.curb.markets/mcp
```

## Tools

| tool | reads | answers |
|---|---|---|
| `curb_regime(symbol?)` | MarketClock `regime()`, `primaryCapNow()`, `isInMultiplierBlackout()`, `blackoutUntil()`, `secondsToNextTransition()`; `stateOf()` for `observedAt` only | OPEN / SHUT / UNKNOWN in words, the issuer's order cap, blackout, next published boundary. Omit `symbol` for all six |
| `curb_next_reopen(symbol)` | the issuer's public schedule and limits (api.xstocks.fi), MarketClock | the closure in progress and when capacity returns, or the next closure, in UTC and venue time; flags a chain/schedule disagreement |
| `curb_scorecard(limit?)` | Scorecard v2 `skill()`, `closureCount()`, `closureIds(i)`, `commitments(id)`, `settlements(id)`; `ClosureCommitted` for each row's commit tx | the graded record, newest rows first (1-50, default 10) |
| `curb_credit(symbol)` | CurbCredit `ltvFor`, `ltvEffective`, `reserve`, `minCertExpiry`, `realisable`, totals; DepthCert `honouredDepth` at that expiry floor; Scorecard `priceNow`; MarketClock `regime` | the LTV, what binds it, and why it is 0 when it is |
| `curb_corporate_actions(symbol, limit?)` | curb-asp's free `GET /v1/corporate-actions` | every version of the issuer's corporate actions, newest first (1-100, default 20) |
| `curb_paid_services()` | curb-asp's `/.well-known/x402` (falls back to the 24 Sep 2026 listing) | the three x402 routes, their terms, the `onchainos` commands to quote and pay, and how to check a receipt. Never pays |

`symbol` is one of wTCENTx, wXIAOx, wMEITx, wSHEINx, wNVDAx, wAAPLx, their issuer tickers (TCENTx, ...) or wrapper
addresses, in any case. Anything else is refused with the list, before any upstream read.

Every chain answer comes from one block (a head read, then Multicall3 `aggregate3` pinned by block hash) and says
which: `asOf.block`, `asOf.blockHash`, `asOf.time`. Identical calls share an answer for a few seconds (5 s for the
regime and the reopen, 15 s for the scorecard, 10 s for credit, 60 s for corporate actions, 300 s for the paid
terms), so a burst costs one set of upstream reads.

Why `curb_next_reopen` computes rather than proxies: the free preview at api.curb.markets carries the next closure
that has not started yet, not the end of the one in progress, and MarketClock's `nextTransitionAt` is the next
schedule boundary (09:00 HKT, not the 09:30 reopen). So it runs the asp's own calendar code, copied verbatim
(`closureCalendar.ts`, `reopen.ts`, `calendar.ts`, `regime.ts`, with the asp's test), on the issuer's bytes. That
is the `curb.reopen/1` rule the keeper commits every Scorecard row's `settleAfter` under. The full 1-14 day calendar
stays a paid route.

## Run and test

Node 22.18 or newer (TypeScript runs directly).

```bash
npm ci
npm test                         # four host timezones; the live test skips itself when no X Layer RPC answers
PORT=8080 PUBLIC_URL=http://localhost:8080 npm start
curl -s localhost:8080/ | jq '.tools[].name'
curl -s -X POST localhost:8080/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"curb_regime","arguments":{"symbol":"wTCENTx"}}}'
```

`CURB_MCP_OFFLINE=1 npm test` skips the live test explicitly.

## Configuration

| variable | default | |
|---|---|---|
| `PORT` | 8080 | |
| `PUBLIC_URL` | `https://mcp.curb.markets` | used in `GET /` only; must be https except on localhost |
| `RPCS` | `https://xlayer.drpc.org,https://rpc.xlayer.tech` | https only; heads are raced and a node more than 5 blocks behind is ignored |
| `TRUST_PROXY_HOPS` | 0 (the Dockerfile sets 1) | which `X-Forwarded-For` entry, from the right, is the client. 0 uses the socket address |
| `RATE_BURST`, `RATE_PER_MIN` | 60, 120 | per client IP; `/healthz` is exempt. A refusal is 429 with `Retry-After` |
| `TOOL_TIMEOUT_MS` | 20000 | a tool that waits longer on an upstream answers "timed out" |
| `HOST_ID` | `mcp` | the `host` field of every log line |

## Deploy

**In its own Railway project, never in `.railway/railway.ts`.** That file describes the `curb` project with
omit-means-delete semantics, and an apply there can restart attestor-a (the only MarketClock writer) or curb-asp
(the paid API and its payment ledger). A separate project also keeps a flood of free MCP calls away from both.

Run these from `services/mcp`, not the repository root: `railway init` links the directory it runs in, and the
root must stay linked to the `curb` project.

```bash
cd services/mcp
railway init --name curb-mcp
railway add --service curb-mcp --variables "PUBLIC_URL=https://mcp.curb.markets" --variables "TRUST_PROXY_HOPS=1"
railway up . --path-as-root --service curb-mcp --ci
railway domain mcp.curb.markets --service curb-mcp --port 8080
```

In the service's settings: region Singapore (`sin`, next to the other services), one replica, healthcheck path
`/healthz`, restart policy Always. No volume.

DNS in Cloudflare: add exactly the records `railway domain` prints (a CNAME `mcp` to the Railway target, and a TXT
verification record if it asks for one), **DNS only** (grey cloud), like `api.curb.markets`: a proxy may cache or
rewrite responses, and it would sit between the rate limit and the client's address.

Check the proxy shape once, because the rate limit keys on it: send one plain request and one with a forged header,
then read the `proxy-shape` log lines.

```bash
curl -s https://mcp.curb.markets/ >/dev/null
curl -s -H 'X-Forwarded-For: 192.0.2.1' https://mcp.curb.markets/ >/dev/null
railway logs --service curb-mcp | grep proxy-shape
```

Plain `xffEntries 1` with forged `2` (Railway appends) or `1` (Railway replaces) means `TRUST_PROXY_HOPS=1` is right.
Plain `0` means no proxy header arrives: set `TRUST_PROXY_HOPS=0`. Plain `2` means two proxies append: set 2.

Then:

```bash
curl -s https://mcp.curb.markets/healthz
claude mcp add --transport http curb https://mcp.curb.markets/mcp
claude mcp list                                   # curb: ... - Connected
# ask Claude Code "is wTCENTx's home market open?", then compare with the contract:
cast call 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b "regime(address)(uint8)" \
  0x41333Df9E7639188BBfca5522dC4844398Af9f9E --rpc-url https://xlayer.drpc.org
```

## Limits

- The reopen time is the issuer's published schedule run through Curb's rule, not a promise: a halt, an unpublished
  holiday or an early close the issuer does not publish would not be in it. MarketClock is the authority on whether
  the market is shut now, and the answer flags any disagreement between the two.
- MarketClock is attested by a single signer (README "Honest limits"). This server reports what the contract says.
- No authentication and no sessions. The limits are per client IP, and the caches are per process.
- The issuer's API is read at most once per asset every 10 minutes. After 30 minutes without a good read the
  reopen tool stops answering from the old bytes and says so.
