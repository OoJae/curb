# [ARFC] A risk framework for tokenized equities on Aave V3 X Layer, with wTCENTx as the worked example

**Status: draft, not posted.** Awaiting review before it goes to governance.aave.com.

---

## Summary

Aave V3 on X Layer holds no tokenized equities, and no xStock has ever been proposed on this
instance. This post does not ask for a listing. It supplies the input that a listing would require
and that does not currently exist anywhere: a measured, onchain, continuously-published answer to
**when a tokenized equity's primary market is switched off**, and what that does to the parameters.

The core fact is not a data-availability problem. For a tokenized equity, "closed" is not an oracle
flag — it is the period during which the **issuer's own contract caps creation and redemption at
exactly zero**, which switches off the arbitrage that pins the token to the underlying. Trading does
not stop; only the mechanism that makes the price mean anything stops. For the 79 Hong Kong names
live on X Layer, that is **140.5 of every 168 hours — 83.6% of the week.** For a US name it is 48.

We built and operate `MarketClock` (free, MIT, unlicensed) to publish that state. It has run
continuously on X Layer mainnet since 14 September 2026.

## Motivation

Aave spent July 2026 retiring 50 low-adoption reserves and six whole markets. A new listing must
therefore argue demand and safety, not novelty. We think the honest position is:

**A tokenized equity cannot be safely listed under static parameters, and the reason is measurable.**

A collateral asset whose arbitrage is switched off 83.6% of the week has two different risk profiles
depending on the hour, and no existing Aave parameter expresses that. A single LTV must therefore be
sized for the *worse* state at all times — which makes the asset unattractive — or it is
under-collateralised for most of the week.

What has been missing is not appetite. It is the input. This post supplies it.

## What we measured, and how

All figures are from live X Layer mainnet (chain 196) and are reproducible from published evidence.

### 1. The closure is a scheduled, published event — and it is 5 minutes longer than the exchange's

The issuer **ends every trading period 300 seconds before its scheduled end**, and starts the next
one on time. The rule is asymmetric. It held **16 of 16** Hong Kong period-ends across four
consecutive trading days, observed from three independent vantage points on three networks:

| day | last `market` observed | first `closed` observed | onchain CLOSED round | capacity returned |
|---|---|---|---|---|
| Tue 15 Sep | 03:54:52.6Z | 03:55:00.4Z | block 70,675,471 | 05:00:04.5Z |
| Wed 16 Sep | 03:54:57.0Z | 03:55:04.2Z | block 70,761,870 | 04:59:59.6Z |
| Thu 17 Sep | 03:54:53.8Z | 03:55:01.0Z | block 70,848,267 | 05:00:02.2Z |
| Fri 18 Sep | 03:54:57.5Z | 03:55:04.5Z | block 70,934,670 | 04:59:59.3Z |

So the Hong Kong lunch recess is **~65 minutes onchain, not the exchange's 60**, and a Hong Kong name
has non-zero primary capacity for only **320 of the venue's 370 published session minutes** each day.

For five minutes a day the venue's own API says `isOpen: true` while the asset's capacity is already
zero. A risk system reading the exchange calendar is wrong during exactly that window.

### 2. A closure is not the same as a session boundary

The Hong Kong afternoon closure spans **four** boundaries: 15:55 capacity off → 16:00 extended
session (capacity still zero) → 16:10 venue shut → 09:00 next day extended (still zero) → **09:30
capacity returns**. That is **17½ hours**, and any system that treats the next boundary as the reopen
reads it as five minutes.

### 3. Depth, measured by execution rather than estimated

No Uniswap quoter is deployed on chain 196, so we do not estimate: we execute real swaps against live
mainnet pool state on a fork, walking every tick, each size against a fresh snapshot of the same
block. Selling the equity leg into the stable:

| pool | spot | $1k | $5k | $10k | $25k | $50k | $100k |
|---|---|---|---|---|---|---|---|
| wTCENTx/USDG | $54.96 | 9bp | 26bp | 47bp | 113bp | 281bp | **545bp, only 62% filled** |
| wNVDAx/USDG | $219.60 | 5bp | 8bp | 13bp | 37bp | 88bp | 196bp |
| wAAPLx/USDG | $334.50 | 17bp | 47bp | 82bp | 185bp | 349bp | 693bp |

**Depth varies by more than an order of magnitude between assets**, so a single global haircut is
wrong for every asset simultaneously. And **wTCENTx cannot fill a $100k order at all** — it stops at
roughly **$58,300 of proceeds**. That is the entire sellable depth of wrapped Tencent on this chain,
against $3.48M of daily volume through the same pool.

*(A depth curve for the full registered cohort — adding wSHEINx, wXIAOx and wMEITx — is being
measured and will be appended. The table above is the set measured to date; we would rather post a
partial table and say so than extrapolate.)*

### 4. The asset is a wrapper, and this is where integrators get it wrong

The traded asset is not the rebasing xStock. It is a Backed-deployed **ERC-4626 wrapper** whose share
price already contains every corporate action ever applied:

```
wAAPLx.convertToAssets(1e18) == AAPLx.multiplier() == 1003269012539818700
```

Equal to the wei, with a passing fork test asserting it. So **comparing a wrapper price to underlying
spot is wrong by the accrued multiplier, and the error never resets** — today 33bp on Apple, 57bp on
SPY, 77bp on AGNC.

Worse for a lending market: **the multiplier is not monotonic.** It encodes every corporate action
and it can fall. `NFLXx` sits at exactly 10.0 (a 10-for-1 forward split); `HONx` went 1.0241 → 0.5120
(reverse split) → 0.9991 (spin-off) in 8h14m. **336 of 732 assets have a multiplier ≠ 1.** Any engine
that books a balance increase as income hands out free credit on a split and force-liquidates on the
price leg. The only safe discriminator is `caType` from the issuer's versioned corporate-actions
feed, and **rebases emit no event at all** — a ±5,000-block log scan around an activation finds
nothing, because activation is on a timestamp.

## Specification

### The ask

Not a general listing. Following the precedent already set on this instance for assets with unusual
risk profiles: **non-borrowable, usable as collateral only within a dedicated isolated eMode, with a
supply cap sized to measured sellable depth rather than to headline liquidity.**

A tokenized equity that cannot be arbitraged for 140.5 hours a week has no business being borrowable.

### Market configuration — wTCENTx, illustrative

| parameter | value | derivation |
|---|---|---|
| Borrowable | **No** | the asset has no reliable price for 83.6% of the week |
| Collateral | **Isolated eMode only** | |
| Supply cap | **$50,000** | below the $58.3k of total sellable depth measured above |
| Borrow cap | n/a | |
| LTV | **see below** | not expressible as one number |
| Liquidation threshold | conservative, sized for the closed state | |
| Liquidation bonus | must exceed the measured closed-state impact at liquidation size | 281bp at $50k |
| Reserve factor | standard | |

### The parameter Aave does not currently have

The honest finding is that **LTV for this asset class is a function of time, not a constant**, and
Aave V3 has no mechanism to express that. Two options, and we have no stake in which:

**Option A — static, sized for the closed state.** One LTV, low enough to be safe during the 140.5
hours when creation and redemption are off. Simple, requires nothing new, and makes the asset
unattractive most of the week.

**Option B — a regime-aware Risk Steward.** A steward reads `MarketClock.primaryCapNow(wrapper)` and
steps LTV down when it reads zero. This is the parameter that actually matches the risk. It requires
a steward with a narrow, published mandate, and it is a governance question rather than a technical
one — the oracle already exists and is free.

We are not asking for Option B. We are pointing out that Option A is the only currently expressible
choice, and that it prices the asset as if it were always shut.

## Oracle

**This is where every tokenized-equity listing fails, and it is the section this post exists for.**

Aave's existing X Layer reserves are priced by Chainlink feeds with CAPO adapters. **There is no
Chainlink equity stream for the Hong Kong names** — verified: X Layer's VerifierProxy is live and
fee-free (`typeAndVersion()` = "VerifierProxy 2.0.0", `s_feeManager()` = `address(0)`, so no LINK and
no WOKB), but equity coverage cannot be confirmed without request-gated credentials, and the HK names
have no feed at all.

`MarketClock` at `0x160Dc415902971a7a9B5ade7f43005b36FE5B09b` (Sourcify `exact_match`) does not
replace a price feed. It answers the prior question — *is this price arbitraged right now?*

```solidity
if (clock.primaryCapNow(wrapper) == 0) {
    // Creation/redemption is switched off. Any "price" here is unarbitraged.
    // Defer, widen, or take the forward -- but do not mark a borrower at it.
    revert MarketShut();
}
```

Views: `regime`, `primaryCapNow`, `secondsToNextTransition`, `isInMultiplierBlackout`, `rawToShares`.

Properties a risk reviewer should check rather than take on trust:

- **It fails closed.** An attestation older than 30 minutes reports `UNKNOWN` and `primaryCapNow`
  returns **0**, never the last known value. A dead attestor can never leave an asset looking open.
- **`UNKNOWN` is the zero value**, so an unregistered asset cannot be mistaken for an open one.
- **Blackouts are driven by an observed nonce change, not a clock**, because corporate actions
  activate on a timestamp and emit no event. Measured activations include 23:55Z, 02:30Z and 11:20Z —
  never hardcode a fixed daily window.
- **Every state is reproducible.** Each round commits a Merkle root of its exact inputs; `npx
  curb-verify tx <hash>` re-derives the number from the published evidence on a clean machine.

### Two limitations we would rather state than have found

1. **Attestation is single-signer today.** The deployed contract's NatSpec says "quorum-signed
   off-chain"; that describes the intended design, not what currently runs, and the deployed source
   is immutable. A second host independently witnesses and EIP-712-signs every round, which is an
   attributable second check, **not a quorum**.
2. **`stateOf()` deliberately does not fail closed.** It returns the stored struct verbatim, so
   `stateOf().primaryCapUsd` on a dead attestor returns the last known capacity rather than 0. The
   staleness guard is in `regime()` and `primaryCapNow()`. Any integration must read those.

We also publish our own errata. Seven rounds at the very start of the record (blocks 70,617,365 →
70,619,011) wrote the issuer's *cents* value into a whole-USD field, overstating capacity 100×.
Regimes were correct throughout, and a consumer checking `primaryCapNow == 0` got the right answer;
one reading the size did not. Corrected at block 70,619,137. Derivation methods are versioned and
never edited in place, so every historical round stays reproducible under the rules that produced it.

## Disclosure

- MarketClock and this framework were built by the Curb team. It is **free, MIT-licensed and
  unlicensed by us** — there is no fee, no token, and no revenue to Curb from its use.
- We are not compensated by Aave, by Backed, or by any party to this proposal.
- We operate a product that consumes MarketClock. We therefore have an interest in the asset class
  being listable, and we state that plainly rather than presenting this as disinterested research.
- The funding graph of **every** wallet we control is published in advance at `docs/WALLETS.md`,
  including which addresses must be excluded from any claim about third-party usage.

## Next steps

1. Feedback from Risk Service Providers on whether a regime-stepped LTV is expressible today, or
   whether Option A is the only path.
2. We will append the full cohort depth curve when the measurement completes.
3. If a listing is not appropriate, a documented "no" with a parameter set attached is a useful
   outcome and we will publish it as such. **Nothing Curb does depends on this proposal passing**, and
   we would rather say so here than have it inferred.

## Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
