# LP outreach: targets, message, and what we are honestly asking

**Status: READY FOR APPROVAL. Nothing has been sent.** Nothing goes out until the user approves the exact text
and the exact recipients below. Three more conditions must also hold:

1. `curb.markets` serves a real page. Sending people to a dead URL is worse than not sending.
2. For variant C only: `DepthCert` is deployed and Sourcify-verified, and its address is filled in from
   `docs/DEPLOYMENTS.md`.
3. Any number quoted in a message was re-measured on the day it is sent (see "Re-check before quoting").

*Last revised 24 Sept 2026.*

## Why this exists

Without one external counterparty, Curb is writer, lender, borrower and bidder all at once. That is a four-hat
wallet cluster. OKX's AI judges resolve it in a single query, and the T&Cs treat it as disqualifying. One
genuinely unrelated wallet, funded from an exchange and with its own prior history, removes that entirely.

- **Hard go/no-go: 1 Oct.** The original plan was to send by 23 Sept, which has passed. Send on approval, and
  leave at least four days for a reply.
- **Finale: Singapore, 7 Oct 2026.**
- **If nobody commits by 1 Oct**, the loan beat is cut. The irreversible onstage moment becomes the proved fade
  and slash, which needs no counterparty, no price move and no open market.

## Who actually holds the liquidity

*Measured 21 Sept 2026.*

All six wrapped-equity pools are Uniswap V3-style from factory `0x4B2ab38DBF28D31D467aA8993f6c2585981D6804`.
Positions are **not** held by EOAs directly. Every `Mint` and `Burn` names the NonfungiblePositionManager
`0x315e413A11AB0df498eF83873012430ca36638Ae` as owner (`name()` = "Uniswap V3 Positions NFT-V1", and
`factory()` matches). The real LP is `ownerOf(tokenId)`.

Across a window of about 40 hours (145,100 blocks, paged 100 at a time because the public RPC caps `eth_getLogs`
there), **57 distinct LP addresses** were active. Every one returns `0x` from `eth_getCode`. They are **all
EOAs**, with no vaults, no multisigs and nothing custodial in between, so they are directly contactable.

**None of the 57 matches any wallet in `docs/WALLETS.md`.** That includes `curb-desk`, added 24 Sept. The LP set
is genuinely third-party, and that is the property the whole outreach exists to establish.

### Targets, verified on chain

Ranked by position count and by whether they hold Hong Kong names. Those are the assets whose primary market is
shut 141 h 20 m of every 168. Position counts and nonces are as of 21 Sept.

| # | address | positions | nonce | pools | why |
|---|---|---|---|---|---|
| 1 | `0x12C41Db9BbC678b5707EEb81cE814fa23421C34d` | 659 | 6,815 | wTCENTx, wMEITx, wNVDAx | **First contact.** The only LP with live positions in two HK pools at once, and the only one seen calling the position manager directly rather than through the router, so it runs its own tooling. |
| 2 | `0x7be689c6732D2d0ac194f2D019aB56ea63b97241` | 1,798 | 12,780 | wMEITx | Largest position count in the cohort by a wide margin. |
| 3 | `0xb5240c4b1408A293F5aF3341E29Fcee67f5C7018` | 993 | 5,869 | wAAPLx | Largest LP in the book with the worst measured impact per dollar (D-3). |
| 4 | `0x9c9dD25D94bC9f965B22E1c888e1d4510C9a4BF4` | 744 | 6,083 | wMEITx | |
| 5 | `0x18A0E936bAC7fbc873E330587738259e6BF64aeE` | 526 | 5,842 | wSHEINx | Largest mover in the most concentrated asset in the cohort (99.08% of supply in its pool, measured 21 Sept). |
| 6 | `0x01b554D75b9d2aA1C97592B3EAA44498d7033b29` | 246 | 1,488 | wSHEINx | |
| 7 | `0x7e349f84732Ee499a464d118d32635cBaFdfd189` | 235 | 1,860 | wSHEINx, wMEITx | Cross-HK. |
| 8 | `0x1Bb84BcF9852A63e2b95C660e4b6C1098Cc1236d` | 125 | 472 | wTCENTx | The demo asset. |
| 9 | `0x1294394faCc6B4EEe808AeF886ee13eA590F8608` | 6 | 95 | wXIAOx | Holds the single largest *live* position found in any of the six pools. A small operator making a big bet. |

**Send to five, not fifty.** Five specific, well-chosen messages read as research. Fifty read as spam, and the
record is public forever. **Recommended first five: rows 1, 2, 5, 8 and 9.** Together they cover all four Hong
Kong names and both ends of the operator-size range.

Two notes for choosing the asset named in each message:

- DepthCert takes any wrapper. CurbCredit (W4) accepts only the five priced wrappers, so **wSHEINx certs would
  not count toward any LTV** (it has no Scorecard price source). For row 5, name wSHEINx only as the reason for
  writing, not as something Curb can lend against.
- Reopen Notes (W3) exist only for wTCENTx, wNVDAx and wAAPLx.

### Re-check before quoting

- **Depth and volume.** The "$58k sellable, can't fill $100k" figure for wTCENTx is a fork measurement from W0
  (D-3). Re-run `forge test --match-path test/fork/DepthProbe.t.sol -vv` on the day of sending, and quote the new
  number with that date, or leave it out.
- **Burn/Mint asymmetry.** The 21 Sept scan saw **104 `Burn` events and zero `Mint` events** in about 40 hours:
  nobody added liquidity, and people only withdrew and harvested fees. But the window covered a weekend, when HK is
  shut anyway. **Re-run across a full trading day before it goes in any message**, or leave it out.
- **Positions.** Re-read `ownerOf` for each target's positions on the day. An address that has fully exited is
  dropped, not messaged.

## The message

Sent as a zero-value transaction carrying UTF-8 calldata. Each message is at most ~240 bytes, costs ~3,200 gas
(about $0.0001), and stays permanently readable in OKLink's input-data view.

**From the deployer `0x78a5955b433988198bccA2E8bdC671444798f809`**, which is already published as a Curb
wallet. The lead logs every sent message in `docs/WALLETS.md` beside the admin transactions. Outreach that hid
which wallet it came from would undercut the exact property it exists to establish.

**Whether to add the Builder Code suffix:** no. These are messages, not product transactions. Attributing them
would pad the Builder Code's count with outreach.

### Variant A: the observation (recommended while DepthCert is not yet live)

> Curb (curb.markets): you LP wTCENTx. Its issuer caps creation and redemption at zero for over 141 of every
> 168 hours, so nothing pins the pool then. We are deploying DepthCert on 25 Sep: bonded bids for that depth.
> Interested? Reply here.

### Variant B: the number (only with a same-day depth measurement)

> Curb (curb.markets): the wTCENTx pool sold ~$⟨N⟩k before a $100k sell ran dry (fork test, ⟨date⟩), and its
> primary market is shut 84% of the week. DepthCert, deploying 25 Sep, lets a desk bond depth it quotes. Reply here.

### Variant C: after DepthCert is live (only once condition 2 holds)

> Curb (curb.markets): DepthCert is live at ⟨address⟩. Post a bonded bid for wTCENTx shares; a faded fill is
> proved on chain and the bond goes to the taker. You LP this book. Interested? Reply here.

Per-asset substitutions: swap in wMEITx or wXIAOx and that asset's own figure. The 141-hour and 84% figures apply
to Hong Kong names only, so never use them with wNVDAx or wAAPLx. wSHEINx: see the note above.
Byte check before sending, with every placeholder filled: `printf %s "<text>" | wc -c` must be 240 or less.
As drafted, A is 238 bytes, B about 220, and C 229 with a real address.

## What we are honestly asking for

**DepthCert is designed and being deployed on 25 Sept.** It is not live as this is written, and variants A and B
say "deploying", not "live". The spec is `docs/specs/W3W4-contracts.md`, and the cuts are in D-12. Overstating
it to a desk that can read the chain is the fastest way to lose the only counterparty that matters.

What a maker could do once it is live:

- **Post** a one-sided firm bid: `post(wrapper, beneficiary, sizeShares, bidPx, expiry, bond)`, with bidPx in
  USDG per whole wrapper share. The bond must be at least 10% of the bid's notional. The cert lives between 10
  minutes and 30 days. Naming `CurbCredit` as beneficiary makes the bid count toward that asset's `ltvFor`.
  Only bids with at least an hour left count.
- **What it risks.** If a taker delivers shares and the maker's USDG does not arrive (allowance revoked,
  balance short, or the transfer fails), the cert is marked FADED in the same transaction and **the whole bond
  goes to the taker**. A taker can never cause a fade, because the taker's shares are pulled first.
- **What it gets.** In this version, **no fee**: the fee share was cut (D-12). What it does get is flow at a
  price it chose. A cert naming CurbCredit can be hit only by the credit line, and only with seized collateral,
  and the maker buys at the bid it set. It also gets a public on-chain record of depth it quoted and honoured,
  and its bond back after expiry.
- **Reopen Notes.** Bidding in a `ClosedAuction` needs an entry in `EligibilityRegistry`: one admin transaction,
  with an evidence hash, done only after the counterparty agrees. It is not something to offer in a first
  message.

This is **not** "buy this today". It is an expression of interest that sets up a real transaction once the
contract is live.

## If nobody replies

Decided **1 Oct**, not on the day. The loan beat is cut. The irreversible onstage moment becomes the **proved
fade and slash** between two disclosed team wallets. That needs no counterparty, no price move and no open
market, and it is presented as a demonstration of the mechanism, never as usage.
