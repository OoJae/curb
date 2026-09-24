# [ARFC] A risk framework for tokenized equities on Aave V3 X Layer, with wTCENTx as the worked example

**Status: READY FOR APPROVAL. Not posted.** It goes to governance.aave.com only after the user approves this
exact text and the checklist at the end is ticked. *Last revised 24 Sept 2026.*

---

## Summary

Aave V3 on X Layer holds no tokenized equities, and as far as we can find, no xStock has been proposed on this
instance. This post does not ask for a listing. It supplies an input that a listing would require and that we
could not find published anywhere: a measured, on-chain, continuously-published answer to **when a tokenized
equity's primary market is switched off**, and what that does to the parameters.

The core fact is not a data-availability problem. For a tokenized equity, "closed" is not an oracle flag. It is
the period during which the **issuer caps creation and redemption at exactly zero**, which switches off the
arbitrage that pins the token to the underlying. Trading does not stop; only the mechanism that makes the price
mean anything stops. For the 79 Hong Kong names live on X Layer, that is **141 h 20 m of every 168 hours, 84.1% of
the week**: the published HKEX timetable, plus the issuer's own measured five-minute early cut before every
period end. For a US name it is the weekend, about 48 hours, plus a five-minute gap at each session boundary.

We built and operate `MarketClock` (MIT, free to read, no key) to publish that state. It has run continuously
on X Layer mainnet since 14 September 2026. Its first six days held 1,702 rounds with zero gaps, every one of
which re-derived from its published evidence.

## Motivation

Aave spent July 2026 retiring 50 low-adoption reserves and six whole markets. A new listing must therefore
argue demand and safety, not novelty. We think the honest position is:

**A tokenized equity cannot be safely listed under static parameters, and the reason is measurable.**

A collateral asset whose arbitrage is switched off 84% of the week has two different risk profiles depending
on the hour, and no existing Aave parameter expresses that. A single LTV must therefore be sized for the *worse*
state at all times, which makes the asset unattractive. Otherwise it is under-collateralised for most of the
week.

What has been missing is not appetite. It is the input. This post supplies it.

## What we measured, and how

All figures are from live X Layer mainnet (chain 196) or the issuer's public API, and are reproducible from
published evidence. Figures that move with the market are dated.

### 1. The closure is a scheduled, published event, and it is 5 minutes longer than the exchange's

The issuer **ends every trading period 300 seconds before its scheduled end**, and starts the next one on time.
The rule is asymmetric. It held **16 of 16** Hong Kong period-ends across four consecutive trading days, observed
from three independent vantage points on three networks:

| day | last `market` observed | first `closed` observed | on-chain CLOSED round | capacity returned |
|---|---|---|---|---|
| Tue 15 Sep | 03:54:52.6Z | 03:55:00.4Z | block 70,675,471 | 05:00:04.5Z |
| Wed 16 Sep | 03:54:57.0Z | 03:55:04.2Z | block 70,761,870 | 04:59:59.6Z |
| Thu 17 Sep | 03:54:53.8Z | 03:55:01.0Z | block 70,848,267 | 05:00:02.2Z |
| Fri 18 Sep | 03:54:57.5Z | 03:55:04.5Z | block 70,934,670 | 04:59:59.3Z |

So the Hong Kong lunch recess is **about 65 minutes on chain, not the exchange's 60**. A Hong Kong name has
non-zero primary capacity for only **320 of the venue's 370 published session minutes** each day.

For five minutes a day, the venue's own API says `isOpen: true` while the asset's capacity is already zero. A
risk system reading the exchange calendar is wrong during exactly that window.

### 2. A closure is not the same as a session boundary

The Hong Kong afternoon closure spans **four** boundaries. Capacity goes off at 15:55. The extended session
starts at 16:00 with capacity still zero. The venue shuts at 16:10. The next day's extended session starts at
09:00, still at zero. **Capacity returns at 09:30.** That is **17½ hours**, and any system that treats the next
boundary as the reopen reads it as five minutes.

### 3. The pool carries no information while the market is shut

Curb commits a reopen price on chain before each eligible reopen, and a contract grades it after the reopen
against the pool's own price. The contract reads that price itself, so nobody supplies it. By 24 Sept the
record held 15 settled closures on three Hong Kong names: nine lunch recesses and six ~17½-hour overnights.
**In every one, the pool did not trade while primary capacity was off.** The reopens were not quiet: they moved
**30 to 105 bp**.

For a lending market this is the point. On these pools, the price a lender would have read during a closure was
the last print before the cut, unchanged. It was not a live estimate. The information arrived all at once, at
the reopen.

### 4. Depth, measured by execution rather than estimated

No Uniswap quoter is deployed on chain 196, so we do not estimate. We execute real swaps against live mainnet
pool state on a fork, walking every tick, each size against a fresh snapshot of the same block. Selling the
equity leg into the stable (measured 13 Sept 2026):

| pool | spot | $1k | $5k | $10k | $25k | $50k | $100k |
|---|---|---|---|---|---|---|---|
| wTCENTx/USDG | $54.96 | 9bp | 26bp | 47bp | 113bp | 281bp | **545bp, only 62% filled** |
| wNVDAx/USDG | $219.60 | 5bp | 8bp | 13bp | 37bp | 88bp | 196bp |
| wAAPLx/USDG | $334.50 | 17bp | 47bp | 82bp | 185bp | 349bp | 693bp |

**Depth varies by more than an order of magnitude between assets**, so a single global haircut is wrong for
every asset simultaneously. And **wTCENTx could not fill a $100k order at all.** It stopped at roughly **$58,300
of proceeds**. That was the entire sellable depth of wrapped Tencent on this chain, against $3.48M of daily
volume through the same pool.

*(The other Hong Kong names, wSHEINx, wXIAOx and wMEITx, have not been measured yet. The table is the set
measured to date. We would rather post a partial table and say so than extrapolate. Depth moves: re-run
`forge test --match-path test/fork/DepthProbe.t.sol -vv` for today's numbers.)*

### 5. The asset is a wrapper, and this is where integrators get it wrong

The traded asset is not the rebasing xStock. It is a Backed-deployed **ERC-4626 wrapper** whose share price
already contains every corporate action ever applied:

```
wAAPLx.convertToAssets(1e18) == AAPLx.multiplier() == 1003269012539818700
```

Equal to the wei, with a passing fork test asserting it. So **comparing a wrapper price to underlying spot is
wrong by the accrued multiplier, and the error never resets.** When measured in September 2026 it was 33bp on
Apple, 57bp on SPY and 77bp on AGNC.

Worse for a lending market: **the multiplier is not monotonic.** It encodes every corporate action, and it can
fall. `NFLXx` sits at exactly 10.0, a 10-for-1 forward split. `HONx` went from 1.0241 to 0.5120 (a reverse split)
and then to 0.9991 (a spin-off), all within 8h14m. **336 of 732 assets had a multiplier other than 1** in our September 2026 survey. Any
engine that books a balance increase as income hands out free credit on a split and force-liquidates on the
price leg. The only safe discriminator is `caType` from the issuer's versioned corporate-actions feed. And
**rebases emit no event at all**: activation is on a timestamp, so a ±5,000-block log scan around one finds
nothing.

## Specification

### The ask

This is not a general listing. Following the precedent already set on this instance for assets with unusual risk
profiles, we propose that a tokenized equity be **non-borrowable, usable as collateral only within a dedicated
isolated eMode, with a supply cap sized to measured sellable depth rather than to headline liquidity.**

A tokenized equity that cannot be arbitraged for 141 hours a week has no business being borrowable.

### Market configuration: wTCENTx, illustrative

| parameter | value | derivation |
|---|---|---|
| Borrowable | **No** | the asset has no arbitraged price for 84% of the week |
| Collateral | **Isolated eMode only** | |
| Supply cap | **$50,000** | below the ~$58.3k of total sellable depth measured on 13 Sept; re-measure before any vote |
| Borrow cap | n/a | |
| LTV | **see below** | not expressible as one number |
| Liquidation threshold | conservative, sized for the closed state | |
| Liquidation bonus | must exceed the measured closed-state impact at liquidation size | 281bp at $50k (13 Sept) |
| Reserve factor | standard | |

### The parameter Aave does not currently have

The honest finding is that **LTV for this asset class is a function of time, not a constant**, and Aave V3 has no
mechanism to express that. There are two options, and we have no stake in which one is chosen:

**Option A: static, sized for the closed state.** One LTV, low enough to be safe during the 141 hours a week
when creation and redemption are off. It is simple and requires nothing new, and it makes the asset unattractive
most of the week.

**Option B: a regime-aware Risk Steward.** A steward reads `MarketClock.primaryCapNow(wrapper)` and steps LTV
down when it reads zero. This is the parameter that actually matches the risk. It needs a steward with a narrow,
published mandate. That is a governance question rather than a technical one, because the oracle already exists
and is free.

We are not asking for Option B. We are pointing out that Option A is the only choice expressible today, and that
it prices the asset as if it were always shut.

### A reference implementation of Option B, outside Aave

To show that Option B is buildable, we are deploying a small, immutable credit line on X Layer on 25 Sept 2026,
`CurbCredit`. It is not a proposal for Aave to adopt, and at launch it lends only between disclosed team
wallets. Its published `ltvFor(asset)` does the following:

- It reads **0** when MarketClock is stale (fail closed), when the price is unreadable, or when nobody has bonded
  any depth.
- Otherwise it is the lower of two numbers. The first is a regime cap: **60% while primary capacity is on, 30%
  while it is shut.** The second is what bonded bids would actually pay for the collateral, valued at the lowest
  bid, as a fraction of its pool value. The bids are firm bids posted to a separate contract, `DepthCert`, with a
  bond of at least 10% that goes to the taker if the bid fades. Bids expiring within the hour don't count.
- A breach starts a cure clock that counts only **witnessed open-market time**. Nobody is liquidated while the
  market is shut, and seizure is bounded by a 5% bonus at the breach-time price.
- A refused borrow does not revert. It emits `Refusal(who, asset, reason, requested, allowed)` and changes
  nothing, so every refusal is on the record.

The full spec is public (`docs/specs/W3W4-contracts.md` in the Curb repository). The addresses will be in
`docs/DEPLOYMENTS.md` once deployed. ⟨If posting after 25 Sept: replace "we are deploying" with the deployed
addresses and Sourcify status.⟩

## Oracle

**This is where every tokenized-equity listing fails, and it is the section this post exists for.**

Aave's existing X Layer reserves are priced by Chainlink feeds with CAPO adapters. **We found no Chainlink equity
stream for the Hong Kong names.** X Layer's VerifierProxy is live and fee-free (`typeAndVersion()` = "VerifierProxy
2.0.0", `s_feeManager()` = `address(0)`, so no LINK and no WOKB). But equity coverage on chain 196 cannot be
confirmed without request-gated credentials, which we do not have.

`MarketClock` at `0x160Dc415902971a7a9B5ade7f43005b36FE5B09b` (Sourcify `exact_match`) does not replace a price
feed. It answers the prior question: *is this price arbitraged right now?*

```solidity
if (clock.primaryCapNow(wrapper) == 0) {
    // Creation/redemption is switched off. Any "price" here is unarbitraged.
    // Defer, widen, or take the forward -- but do not mark a borrower at it.
    revert MarketShut();
}
```

Views: `regime`, `primaryCapNow`, `secondsToNextTransition`, `isInMultiplierBlackout`, `rawToShares`.

Properties a risk reviewer should check rather than take on trust:

- **It fails closed.** An attestation older than 30 minutes reports `UNKNOWN`, and `primaryCapNow` returns **0**,
  never the last known value. A dead attestor can never leave an asset looking open.
- **`UNKNOWN` is the zero value**, so an unregistered asset cannot be mistaken for an open one.
- **Blackouts are driven by an observed nonce change, not a clock**, because corporate actions activate on a
  timestamp and emit no event. Measured activations include 23:55Z, 02:30Z and 11:20Z. Never hardcode a fixed
  daily window.
- **Every state is reproducible.** Each round commits a Merkle root of its exact inputs under a versioned method.
  The open-source verifier in the Curb repository re-derives a round from its published bundle on a clean
  machine: `curb-verify bundle <url>`. A `tx <hash>` verb, which starts from the transaction instead, is being
  added.
- **`secondsToNextTransition()` is the next schedule boundary, not the reopen.** See finding 2. Walk the venue's
  published boundaries to the first period with non-zero capacity.

### Two limitations we would rather state than have found

1. **Attestation is single-signer today.** The deployed contract's NatSpec says "quorum-signed off-chain". That
   describes the intended design, not what currently runs, and the deployed source is immutable. A second host, on
   a different provider and continent, independently re-derives and EIP-712-signs every round. That is an
   attributable second check, **not a quorum**.
2. **`stateOf()` deliberately does not fail closed.** It returns the stored struct verbatim, so
   `stateOf().primaryCapUsd` on a dead attestor returns the last known capacity rather than 0. The staleness guard
   is in `regime()` and `primaryCapNow()`. Any integration must read those.

We also publish our own errata. Seven rounds at the very start of the record (blocks 70,617,365 to 70,619,011,
14 Sept) wrote the issuer's *cents* value into a whole-USD field, overstating capacity 100×. Regimes were correct
throughout, so a consumer checking `primaryCapNow == 0` got the right answer and one reading the size did not.
This was corrected at block 70,619,137. Derivation methods are versioned and never edited in place, so every
historical round stays reproducible under the rules that produced it.

## Disclosure

- MarketClock and this framework were built by the Curb team. **Reading MarketClock is free:** MIT, no key, no
  fee, no token.
- **Curb does earn revenue from the same data.** It sells a paid API over x402 (a closure calendar, the graded
  record of its reopen prices, and a closure-discount curve), listed on the OKX AI marketplace. Nothing in this
  proposal routes fees to Curb.
- We are not compensated by Aave, by Backed, or by any party to this proposal.
- We operate products that consume MarketClock, including the credit line described above. We therefore have an
  interest in the asset class being listable, and we state that plainly rather than presenting this as
  disinterested research.
- The funding graph of **every** wallet we control is published in advance in the repository's
  `docs/WALLETS.md`, including which addresses must be excluded from any claim about third-party usage.

## Next steps

1. Feedback from Risk Service Providers on whether a regime-stepped LTV is expressible today, or whether Option A
   is the only path.
2. We will append the depth curve for the remaining Hong Kong names when that measurement completes.
3. If a listing is not appropriate, a documented "no" with a parameter set attached is a useful outcome, and we
   will publish it as such. **Nothing Curb does depends on this proposal passing**, and we would rather say so
   here than have it inferred.

## Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

---

*Internal. Delete everything below this line before posting.*

**Before posting:**

- [ ] The user has approved this exact text.
- [ ] Every ⟨…⟩ is resolved.
- [ ] Two claims carried over from the first draft are source-checked against the Aave governance forum, or
      removed: "Aave spent July 2026 retiring 50 low-adoption reserves and six whole markets", and "the
      precedent already set on this instance for assets with unusual risk profiles" (link the precedent).
- [ ] Re-checked that no tokenized equity has since been proposed on Aave V3 X Layer.
- [ ] The repository is public, so the links to `docs/` resolve. Replace the relative mentions with full URLs.
- [ ] The CurbCredit section matches what is deployed (addresses, parameters). If W4 did not deploy, cut the
      section to one sentence saying it is being built.
- [ ] Depth figures are re-run or explicitly dated. Scorecard figures are re-read and dated on the day of posting.
- [ ] If `curb-verify tx` has landed, update the verifier bullet.
