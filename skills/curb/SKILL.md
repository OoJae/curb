---
name: curb
description: Check whether a tokenized stock's home market is open before acting on it. Use when trading, pricing, lending against, liquidating or settling an xStock wrapper on X Layer (wTCENTx, wXIAOx, wMEITx, wSHEINx, wNVDAx, wAAPLx, or their tickers TCENTx, NVDAx, ...), when asked whether Hong Kong or US primary markets are open for these tokens, when they reopen, how Curb's reopen marks were graded, what CurbCredit would lend, or how to buy Curb's closure calendar over x402 with onchainos and verify it.
---

# Curb

A tokenized stock on X Layer is held to its real share only while the issuer's primary market is open. When
the issuer's order cap for the current period is zero, creation and redemption stop, and nothing arbitrages
the pool back to the share, but the pool keeps trading. For a Hong Kong name that is most of the week. Curb
publishes that state on chain (MarketClock), commits a price mark before each reopen and has the chain grade
it (Scorecard), and sells the forward calendar over x402 (curb-asp).

Chain: X Layer mainnet, chain 196. MarketClock `0x160Dc415902971a7a9B5ade7f43005b36FE5B09b`, Scorecard v2
`0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f`, CurbCredit `0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339`,
DepthCert `0x702b1a988765f85162F4829175EF4232197e9C6D`.

| wrapper | ticker | venue | address |
|---|---|---|---|
| wTCENTx | TCENTx | Hong Kong (XHKG) | `0x41333Df9E7639188BBfca5522dC4844398Af9f9E` |
| wXIAOx | XIAOx | Hong Kong (XHKG) | `0x076CF393E701839FC7a5832D2c68AaFA235682AE` |
| wMEITx | MEITx | Hong Kong (XHKG) | `0xad1b65C8556957cf23d1B5e9accdc449b415fA97` |
| wSHEINx | SHEINx | Hong Kong (XHKG) | `0xff637d2d435D6745Df3faf61272B1216e7e8b727` |
| wNVDAx | NVDAx | US (XNAS) | `0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5` |
| wAAPLx | AAPLx | US (XNAS) | `0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f` |

## Connect

The `curb` MCP server has every tool below, free and read-only:

```bash
claude mcp add --transport http curb https://mcp.curb.markets/mcp
```

Without MCP, read the contract directly (examples at the end).

## Before you act on one of these tokens: `curb_regime`

Call `curb_regime` with the symbol (or with none for all six) before a trade, a quote, a loan, a liquidation or
a settlement that depends on the token tracking its share.

- **OPEN**: a known regime and a non-zero cap. Creation and redemption are available; arbitrage can hold the
  pool to the share.
- **SHUT**: the cap is zero. The pool price is not anchored to the share. Do not treat it as the share's value,
  do not liquidate on it alone, and tell the user the market is shut and when it reopens.
- **UNKNOWN**: MarketClock has no fresh attestation (older than 30 minutes), so it fails closed. Treat it as SHUT.
- **`multiplierBlackout: true`**: a corporate action just changed the multiplier. Nothing denominated in token
  balances should settle until `blackoutUntil`.

Read the status from `regime()` and `primaryCapNow()`, which is what the tool does. Never decide open or shut
from `stateOf()`: it returns the last attestation whatever its age.

## When does it reopen: `curb_next_reopen`

Returns the closure in progress and when capacity is expected back (`expectedReopen.endsAt`, and
`endsAtVenue` in the venue's time), or the next closure if the market is open. It is computed from the issuer's
published schedule with Curb's reopen rule: the issuer cuts capacity 5 minutes before each period ends, and it
returns at the first period with a non-zero cap (a Hong Kong lunch cut runs 11:55 to 13:00, the overnight one
15:55 to 09:30). If `disagreement` is set, MarketClock and the schedule differ: act on MarketClock, and say so.

## Other tools

- `curb_scorecard`: Curb's graded record. `skill()` counts strict wins against the last print and the closing
  VWAP; a tie is not a win. Quote the numbers the tool returns with their block, never a remembered figure.
- `curb_credit`: CurbCredit's LTV for a wrapper (60% cap while open, 30% while shut, and never more than the
  lowest bonded DepthCert bid would pay), with the reason when it is 0. wSHEINx is not collateral there.
- `curb_corporate_actions`: the issuer's corporate actions. A wrapper's share price already contains every
  multiplier change, so check these, or call MarketClock's `rawToShares`, before comparing it with the share.
- `curb_paid_services`: the three paid routes, their live terms, and the commands below.

## Buying the closure calendar with onchainos

The full 1-14 day calendar (every closure window, with hashes of the issuer bytes it was computed from) costs
$0.01 in USD₮0 on X Layer, paid over x402 through the OKX Agentic Wallet. The accuracy record is $0.05 and the
discount by duration $0.10, paid the same way. An unpaid request is free: it returns HTTP 402 with the terms and
a preview.

```bash
curl -si "https://api.curb.markets/v1/closure-calendar?symbol=wTCENTx&horizonDays=7"        # free: 402 + preview
onchainos payment quote "https://api.curb.markets/v1/closure-calendar?symbol=wTCENTx&horizonDays=7"
onchainos payment pay --payment-id <paymentId from quote>                                     # asks to confirm
```

`quote` never signs; it checks the wallet can pay and prints a `paymentId`. `pay` first answers with a
confirmation prompt. **Only re-run it with `--yes` after the user has approved spending that amount.** Never
pay on your own initiative.

To check what you bought:

- The paid response has an `x-curb-receipt` header. Fetch `https://api.curb.markets/receipts/<id>.json`.
- The receipt id is `keccak256(transaction ‖ responseDigest)`, where `responseDigest` is the sha256 of the exact
  response bytes. Keep the raw body: `onchainos payment pay` prints the answer re-serialised with sorted keys,
  and hashing that output will not match.
- `onchainos payment decode-receipt` decodes the `PAYMENT-RESPONSE` header; the transaction is a USD₮0 transfer
  to curb-revenue `0x277cA91276A3801667B76C97Da3872Ccb6E96068` on X Layer.

## Verifying Curb's own numbers: curb-verify

Every MarketClock round and every Scorecard mark commits a Merkle root of its inputs, and the inputs are
published. `curb-verify` rebuilds the root and re-runs the method, then checks the result against the
transaction. It needs Node 22.18 or newer and nothing else:

```bash
npx -y github:OoJae/curb tx <MarketClock or Scorecard transaction hash>
```

`curb_scorecard` gives each row's `commitTx`. Exit code 0 means verified, 1 not reproduced, 3 unavailable
(nothing concluded), 4 not a Curb write. Use `github:OoJae/curb`, not a bare `npx curb-verify`: that npm name is
not Curb's yet.

## Without MCP

```bash
RPC=https://xlayer.drpc.org
cast call 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b "regime(address)(uint8)" 0x41333Df9E7639188BBfca5522dC4844398Af9f9E --rpc-url $RPC
#   0 UNKNOWN, 1 CLOSED, 2 OVERNIGHT, 3 EXTENDED, 4 MARKET
cast call 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b "primaryCapNow(address)(uint128)" 0x41333Df9E7639188BBfca5522dC4844398Af9f9E --rpc-url $RPC
#   whole USD; 0 means shut, whatever the regime says
cast call 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f "skill()(uint256,uint256,uint256)" --rpc-url $RPC
#   (settled, beat last print, beat closing VWAP)
curl -s "https://api.curb.markets/v1/corporate-actions?symbol=TCENTx"
```

## Limits to state when they matter

- MarketClock is attested by one signer; a second host re-derives and signs every round, but it is a witness,
  not a quorum.
- The reopen time follows the issuer's published schedule; an unpublished halt or holiday would not be in it.
- Curb's demo counterparties are team wallets, and Curb says so. Do not present them as users.
