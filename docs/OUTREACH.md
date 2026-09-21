# LP outreach — targets, message, and what we are honestly asking

**Status: drafted, nothing sent.** No message goes out until the exact text below is approved and
`curb.markets` serves a real page. Sending people to a dead URL is worse than not sending.

## Why this exists

Without one external counterparty, Curb is writer, lender, borrower and bidder. That is a four-hat
wallet cluster, OKX's AI judges resolve it in a single query, and the T&Cs treat it as
disqualifying. One genuinely unrelated wallet — funded from an exchange, with its own prior history —
removes that entirely. Hard go/no-go **1 Oct**; messages out by **23 Sept** to leave room for a reply.

## Who actually holds the liquidity

All six wrapped-equity pools are Uniswap V3-style from factory `0x4B2ab38DBF28D31D467aA8993f6c2585981D6804`.
Positions are **not** held by EOAs directly: every `Mint`/`Burn` names the NonfungiblePositionManager
`0x315e413A11AB0df498eF83873012430ca36638Ae` (`name()` = "Uniswap V3 Positions NFT-V1", `factory()`
matches) as owner. The real LP is `ownerOf(tokenId)`.

Across a ~40-hour window (145,100 blocks, paged 100 at a time because the public RPC caps
`eth_getLogs` there), **57 distinct LP addresses** were active. Every one returns `0x` from
`eth_getCode` — **all EOAs, no vaults, no multisigs, nothing custodial in between**. So they are
directly contactable.

**None of the 57 matches any wallet in `docs/WALLETS.md`.** The LP set is genuinely third-party, and
that is the property the whole outreach exists to establish.

### Targets, verified on chain

Ranked by position count and by whether they hold Hong Kong names, which are the assets whose
primary market is shut 140.5 of every 168 hours.

| address | positions | nonce | pools | why |
|---|---|---|---|---|
| `0x12C41Db9BbC678b5707EEb81cE814fa23421C34d` | 659 | 6,815 | wTCENTx, wMEITx, wNVDAx | **First contact.** The only LP with live positions in two HK pools at once, and the only one observed calling the position manager directly rather than through the router — i.e. it runs its own tooling. |
| `0x7be689c6732D2d0ac194f2D019aB56ea63b97241` | 1,798 | 12,780 | wMEITx | Largest position count in the cohort by a wide margin. |
| `0xb5240c4b1408A293F5aF3341E29Fcee67f5C7018` | 993 | 5,869 | wAAPLx | Largest in the thinnest book — 693bp of impact at $100k. |
| `0x9c9dD25D94bC9f965B22E1c888e1d4510C9a4BF4` | 744 | 6,083 | wMEITx | |
| `0x18A0E936bAC7fbc873E330587738259e6BF64aeE` | 526 | 5,842 | wSHEINx | Largest mover in the most concentrated asset in the cohort (99.08% of supply in one $80.8k pool). |
| `0x01b554D75b9d2aA1C97592B3EAA44498d7033b29` | 246 | 1,488 | wSHEINx | |
| `0x7e349f84732Ee499a464d118d32635cBaFdfd189` | 235 | 1,860 | wSHEINx, wMEITx | Cross-HK. |
| `0x1Bb84BcF9852A63e2b95C660e4b6C1098Cc1236d` | 125 | 472 | wTCENTx | The demo asset. |
| `0x1294394faCc6B4EEe808AeF886ee13eA590F8608` | 6 | 95 | wXIAOx | Holds the single largest *live* position found in any of the six pools. Small operator, big bet. |

**Send to five, not fifty.** Five specific, well-chosen messages read as research; fifty read as
spam, and the record is public forever. Recommended first five: rows 1, 2, 5, 8, 9 — which covers all
four Hong Kong names and both ends of the operator-size range.

### One finding to check before quoting it

The scan saw **104 `Burn` events and zero `Mint` events** across all six pools in ~40 hours: nobody
added liquidity, only withdrew and harvested fees. That is a striking line for an approach message —
*you are withdrawing from a book you have been underwriting for free* — but the window covered a
weekend, when HK is shut anyway. **Re-run across a full trading day before it goes in any message.**

## The message

Sent as a zero-value transaction carrying UTF-8 calldata, ~240 bytes, ~3,200 gas, about **$0.0001**
each, permanently readable in OKLink's input-data view.

**From the deployer `0x78a5955b433988198bccA2E8bdC671444798f809`**, which is already published as a
Curb wallet, with every message logged in `docs/WALLETS.md` beside the admin transactions. Outreach
that hid which wallet it came from would undercut the exact property it exists to establish.

### Variant A — the observation (recommended)

> Curb (curb.markets). You're LPing wTCENTx. Its primary market is shut 140 of 168 hrs/week — the
> issuer caps creation and redemption at zero, so the arbitrage that pins it is off and you carry
> that risk for 5bp. We're building a way to sell it. Reply here.

### Variant B — the number

> Curb (curb.markets). wTCENTx trades $3.48M/day against a book that can't fill $100k — total
> sellable depth is ~$58k. Its primary market is shut 83.6% of the week. You're underwriting that
> for 5bp. We think it's worth more. Reply here.

### Variant C — the shortest

> Curb (curb.markets): you're underwriting Hong Kong closure risk on wTCENTx for 5bp, 140 hrs a
> week. We're building the instrument that pays for it. Interested?

Per-asset substitutions: wTCENTx / wSHEINx / wXIAOx / wMEITx, with the matching depth figure.

## What we are honestly asking for

`DepthCert` does not exist yet. This is **not** "buy this today" — it is an expression of interest
that sets up a real purchase later, and the message says "we're building", not "we built".
Overstating it to a desk that can read the chain is the fastest way to lose the only counterparty
that matters.

## If nobody replies

Decided **1 Oct**, not on the day. The loan beat is cut and the irreversible onstage moment becomes
the **proved fade and slash**, which needs no counterparty, no price move and no open market.
