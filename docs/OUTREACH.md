# LP outreach: targets, message, and what we are honestly asking

**Status: SENT 25 Sept 14:22–14:23Z to three LPs (rows 1, 3, 8); rows 7 and 9 were dropped by the send-time guard.** Log below. Earlier status: APPROVED by the user 24 Sept ~22:30Z (Variant C). The five messages below passed an
adversarial re-verification on 24–25 Sept and a live send-time guard at 01:16Z on 25 Sept. They are sent with
`bash script/outreach/send.sh`, which re-checks every recipient immediately before its send; the automated
session was not permitted to send third-party messages, so the user runs it. Earlier rule, kept: nothing goes out
until the user approves the exact text and the exact recipients below. Three more conditions must also hold:

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
shut 141 h 20 m of every 168. Position counts and nonces are as of 21 Sept; the **status** column is the full
position walk of 24 Sept 23:36Z (block 71,523,963), and four of the nine have since left every wrapper pool.

| # | address | positions | nonce | pools (21 Sept) | why | status, 24 Sept (block 71,523,963) |
|---|---|---|---|---|---|---|
| 1 | `0x12C41Db9BbC678b5707EEb81cE814fa23421C34d` | 659 | 6,815 | wTCENTx, wMEITx, wNVDAx | **First contact.** The only LP with live positions in two HK pools at once, and the only one seen calling the position manager directly rather than through the router, so it runs its own tooling. | live: wTCENTx 46637 and wMEITx 46639 in range. (Its 46637 mint went through a helper contract 0x9025…7926, so the "calls the position manager directly" note no longer holds.) **Send, wTCENTx.** |
| 2 | `0x7be689c6732D2d0ac194f2D019aB56ea63b97241` | 1,798 | 12,780 | wMEITx | Largest position count in the cohort by a wide margin. | exited every wrapper pool (all 1,800 positions walked). Dropped. |
| 3 | `0xb5240c4b1408A293F5aF3341E29Fcee67f5C7018` | 993 | 5,869 | wAAPLx | Largest LP in the book with the worst measured impact per dollar (D-3). | exited wAAPLx; live in wTCENTx 38240 and wXIAOx 39012 (in range), wMEITx and wSHEINx out of range. **Send, wTCENTx** (replaces row 5). |
| 4 | `0x9c9dD25D94bC9f965B22E1c888e1d4510C9a4BF4` | 744 | 6,083 | wMEITx | | exited (780 walked, none live). Dropped. |
| 5 | `0x18A0E936bAC7fbc873E330587738259e6BF64aeE` | 526 | 5,842 | wSHEINx | Largest mover in the most concentrated asset in the cohort (99.08% of supply in its pool, measured 21 Sept). | exited every wrapper pool (541 walked). Dropped. |
| 6 | `0x01b554D75b9d2aA1C97592B3EAA44498d7033b29` | 246 | 1,488 | wSHEINx | | exited every wrapper pool (327 walked; nonce 1,939, still active elsewhere). Dropped. |
| 7 | `0x7e349f84732Ee499a464d118d32635cBaFdfd189` | 235 | 1,860 | wSHEINx, wMEITx | Cross-HK. | exited wSHEINx; live wMEITx 46622 in range (the largest wMEITx position among these rows). **Send, wMEITx** (replaces row 2). |
| 8 | `0x1Bb84BcF9852A63e2b95C660e4b6C1098Cc1236d` | 125 | 472 | wTCENTx | The demo asset. | live: wTCENTx 44883 and wMEITx 42876 in range. **Send, wTCENTx.** |
| 9 | `0x1294394faCc6B4EEe808AeF886ee13eA590F8608` | 6 | 95 | wXIAOx | Holds the single largest *live* position found in any of the six pools. A small operator making a big bet. | live: wXIAOx 37071 in range, 22.6% of the pool's in-range liquidity (the cross-pool "largest" claim was not re-verified). **Send, wXIAOx.** |

**Send to five, not fifty.** Five specific, well-chosen messages read as research. Fifty read as spam, and the
record is public forever. **Recommended first five (re-verified 25 Sept): rows 1, 3, 7, 8 and 9**, covering wTCENTx, wMEITx and wXIAOx and
both ends of the operator-size range. Rows 2 and 5, the original picks, have left every wrapper pool. No live LP
in this table still holds an in-range wSHEINx position, so wSHEINx is not messaged.

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

Sent as a zero-value transaction carrying UTF-8 calldata. Each message is at most 240 bytes, costs about 30,500
gas (the EIP-7623 calldata floor; about 6.4e-7 OKB at 0.021 gwei, far under $0.0001), and stays permanently
readable in OKLink's input-data view.

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

**DepthCert is live since 24 Sept** at `0x702b1a988765f85162F4829175EF4232197e9C6D` (Sourcify `exact_match`), so
Variant C is the one sent; variants A and B are kept only as the record of what was drafted. The spec is
`docs/specs/W3W4-contracts.md`, and the cuts are in D-12. Overstating it to a desk that can read the chain is the
fastest way to lose the only counterparty that matters.

What a maker can do now (checked against the deployed code and on a mainnet fork, 25 Sept):

- **Post** a one-sided firm bid: `post(wrapper, beneficiary, sizeShares, bidPx, expiry, bond)`, with bidPx in
  USDG per whole wrapper share. The bond must be at least 10% of the bid's notional. The cert lives between 10
  minutes and 30 days. An **open** cert (beneficiary 0) is permissionless: any maker, any wrapper, anyone may take
  it. A cert **naming `CurbCredit`** counts toward that asset's `ltvFor`, but only makers on the maker allowlist
  (`0xbA1a…758E`) may post one, so an outside desk is added there first (one admin transaction, after it agrees).
  CurbCredit counts a cert only while it outlives its horizon (open: 1 h + 30 min; shut: 73 h or more + 30 min).
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


## Sent log

Sent 25 Sept 2026 by `bash script/outreach/send.sh` (run by the user's session), zero-value transactions from the deployer
`0x78a5955b433988198bccA2E8bdC671444798f809`, calldata = the Variant C text below, no Builder Code suffix. Each recipient
passed the send-time guard (still owns its evidence position, liquidity > 0, pool tick inside its range) seconds before
its send. Log: `artifacts/outreach-2026-09-25.log`.

| row | recipient | text names | guard | tx | block |
|---|---|---|---|---|---|
| 1 | `0x12C41Db9BbC678b5707EEb81cE814fa23421C34d` | wTCENTx | token 46637 in range | `0x72c40545155323601e8fb9b757a3d0e456a5eceff46569320cf94bda0c08352b` | 71,577,123 |
| 3 | `0xb5240c4b1408A293F5aF3341E29Fcee67f5C7018` | wTCENTx | token 38240 in range | `0x9882f1745f7f9bfd6c0fcf28843621d3e6ad3d415d9623cc34c2a27f413d2d43` | 71,577,135 |
| 7 | `0x7e349f84732Ee499a464d118d32635cBaFdfd189` | (wMEITx) | **dropped**: token 46622 had no liquidity left | not sent | |
| 8 | `0x1Bb84BcF9852A63e2b95C660e4b6C1098Cc1236d` | wTCENTx | token 44883 in range | `0xad83bcc0b1c62a37c473d6759b2a4394e7687c6fda87947dee525426f051f3a0` | 71,577,153 |
| 9 | `0x1294394faCc6B4EEe808AeF886ee13eA590F8608` | (wXIAOx) | **dropped**: token 37071 out of range (tick −264,305 vs [−264,160, −263,260)) | not sent | |

Text sent (229 bytes): "Curb (curb.markets): DepthCert is live at 0x702b1a988765f85162F4829175EF4232197e9C6D. Post a bonded bid for
wTCENTx shares; a faded fill is proved on chain and the bond goes to the taker. You LP this book. Interested? Reply here."
Replies arrive as transactions to the deployer or through curb.markets; any that do are recorded here with their funding path.
