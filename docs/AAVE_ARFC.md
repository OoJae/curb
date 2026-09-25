# [Discussion] A risk framework for tokenized equities on Aave V3 X Layer, with wTCENTx as the worked example

**Status: FINAL DRAFT. Not posted.** Fact-checked after approval in principle; every change since is listed in `docs/AAVE_ARFC_CHANGES.md`. It goes to governance.aave.com only after the user approves this revision and the checklist at the end is complete. *Last revised 25 Sept 2026.*

---

## Summary

Aave V3 on X Layer holds no tokenized equities, and as far as we can find, no xStock has been proposed on this instance. The tokenized-equity work in front of Aave governance is on another instance: the Coinbase B20 Equities Hub proposed for Aave V4 on Base ([ARFC](https://governance.aave.com/t/arfc-deploy-aave-v4-on-base/25427)). Earlier, Backed's bCSPX was proposed for Aave V3 Gnosis in 2025 ([ARFC](https://governance.aave.com/t/arfc-add-bcspx-to-aave-v3-gnosis-instance/21113)) and has not been listed.

This post does not ask for a listing. It supplies an input that a listing would require and that, for the names live on X Layer, we could not find published: a measured, on-chain, continuously-published answer to **when a tokenized equity's primary market is switched off**, and what that does to the parameters. The closest published work is LlamaRisk's initial parameters for tokenized equities on Aave V4 Base ([post](https://governance.aave.com/t/arfc-deploy-aave-v4-on-base/25427/5)), which sizes the market around the hours a 24/5 price feed stops publishing. This post measures the hours the issuer stops creating and redeeming, which is the event that removes the arbitrage.

The core fact is not a data-availability problem. For a tokenized equity, "closed" is not an oracle flag. It is the period during which the **issuer caps creation and redemption at exactly zero**, which switches off the arbitrage that pins the token to the underlying. Trading does not stop; only the mechanism that makes the price mean anything stops. For the 79 Hong Kong names live on X Layer, that is **141 h 20 m of every 168 hours, 84.1% of the week**: the published HKEX timetable, plus the issuer's own measured five-minute early cut before every period end. For a US name it is the weekend, about 48 hours, plus a five-minute gap at each session boundary.

We built and operate `MarketClock` (MIT, free to read, no key) to publish that state. It has run continuously on X Layer mainnet since 14 September 2026, writing its first 1,702 rounds between 14 and 20 September, and any round can be re-derived from its published evidence.

## Motivation

In July 2026 LlamaRisk proposed offboarding 49 low-adoption reserves and 21 matured Pendle PTs, and winding down six whole deployments ([ARFC](https://governance.aave.com/t/arfc-low-adoption-asset-deprecation-on-aave-v3/25401)). It passed Snapshot in August and executed as AIP 521 in September. A new listing must therefore argue demand and safety, not novelty. We think the honest position is:

**A tokenized equity cannot be safely listed under static parameters, and the reason is measurable.**

A collateral asset whose arbitrage is switched off 84% of the week has two different risk profiles depending on the hour, and no existing Aave parameter expresses that. A single LTV must therefore be sized for the *worse* state at all times, which makes the asset unattractive. Otherwise it is under-collateralised for most of the week.

What has been missing is not appetite. It is the input. This post supplies it.

## What we measured, and how

All figures are from live X Layer mainnet (chain 196) or the issuer's public API, and are reproducible from published evidence. Figures that move with the market are dated.

### 1. The closure is a scheduled, published event, and it is 5 minutes longer than the exchange's

The issuer **ends every trading period 300 seconds before its scheduled end**, and starts the next one on time. The rule is asymmetric. It held **16 of 16** Hong Kong period-ends across four consecutive trading days, observed from three independent vantage points on three networks:

| day | last `market` observed | first `closed` observed | on-chain CLOSED round | capacity returned |
|---|---|---|---|---|
| Tue 15 Sep | 03:54:52.6Z | 03:55:00.4Z | block 70,675,471 | 05:00:04.5Z |
| Wed 16 Sep | 03:54:57.0Z | 03:55:04.2Z | block 70,761,870 | 04:59:59.6Z |
| Thu 17 Sep | 03:54:53.8Z | 03:55:01.0Z | block 70,848,267 | 05:00:02.2Z |
| Fri 18 Sep | 03:54:57.5Z | 03:55:04.5Z | block 70,934,670 | 04:59:59.3Z |

So the Hong Kong lunch recess is **about 65 minutes on chain, not the exchange's 60**. A Hong Kong name has non-zero primary capacity for only **320 of the venue's 370 published session minutes** each day.

For five minutes a day, the venue's own API says `isOpen: true` while the asset's capacity is already zero. A risk system reading the exchange calendar is wrong during exactly that window.

### 2. A closure is not the same as a session boundary

The Hong Kong afternoon closure spans **four** boundaries. Capacity goes off at 15:55. The extended session starts at 16:00 with capacity still zero. The venue shuts at 16:10. The next day's extended session starts at 09:00, still at zero. **Capacity returns at 09:30.** That is **17½ hours**, and any system that treats the next boundary as the reopen reads it as five minutes.

### 3. The pool keeps trading while the market is shut, with no primary market to anchor it

Curb commits a reopen price on chain before each eligible reopen, and a contract, `Scorecard`, grades it after the reopen against the pool's own price. The contract reads that price itself, so nobody supplies it. As of 25 Sept 2026 15:04Z (Scorecard v2, block 71,579,624), the record held 21 settled closures on three Hong Kong names (wTCENTx, wXIAOx and wMEITx), and none beat the last print (`skill()` = 21 settled, 0 beat the last print, 0 beat the closing VWAP). The first 15 used a mark that is the last print by construction, so they tied. Three overnight rows under a second method, which moves the mark by US-listed ADRs and a perpetual future that trade while Hong Kong is shut, all lost at the 25 Sept reopen: the signal called the gap up and HKEX opened all three names down. Three lunch-recess rows under that method tied, because it gives the recess no weight. We publish the losses as they are.

**The pools did not stop trading while primary capacity was off.** The three pools printed 15 swaps during the 22 Sept lunch recess, 63 during the 23 Sept recess and 141 during the 24 Sept recess, and in 14 of the 15 closures the pool price one second before the reopen differed from its price at the cut. From the last print before the cut to the settled reopen print, prices moved 0 to 105 bp; seven of the fifteen moved 30 bp or more.

For a lending market this is the point. On these pools the price still moved during closures, with no creation or redemption to anchor it. On 22 Sept, the prints the Scorecard graded at the reopen had already been set by trades inside the recess.

### 4. Depth, measured by execution rather than estimated

We found no Uniswap quoter deployed on chain 196, so we do not estimate. We execute real swaps against live mainnet pool state on a fork, walking every tick, each size against a fresh snapshot of the same block. Selling the equity leg into the stable (measured 13 Sept 2026):

| pool | spot | $1k | $5k | $10k | $25k | $50k | $100k |
|---|---|---|---|---|---|---|---|
| wTCENTx/USDG | $54.96 | 9bp | 26bp | 47bp | 113bp | 281bp | **545bp, only 62% filled** |
| wNVDAx/USDG | $219.60 | 5bp | 8bp | 13bp | 37bp | 88bp | 196bp |
| wAAPLx/USDG | $334.50 | 17bp | 47bp | 82bp | 185bp | 349bp | 693bp |

**Depth varies several-fold between assets** (at $10k, 13bp on wNVDAx against 82bp on wAAPLx), so a single global haircut is wrong for every asset simultaneously. And **wTCENTx could not fill a $100k order at all.** It stopped at roughly **$58,300 of proceeds**. That was all the sellable depth in the only wTCENTx pool we found on this chain.

*(The other Hong Kong names, wSHEINx, wXIAOx and wMEITx, have not been measured yet. The table is the set measured to date. We would rather post a partial table and say so than extrapolate. Depth moves: re-run `forge test --match-path test/fork/DepthProbe.t.sol -vv` ([DepthProbe.t.sol](https://github.com/OoJae/curb/blob/main/test/fork/DepthProbe.t.sol)) for today's numbers.)*

### 5. The asset is a wrapper, and this is where integrators get it wrong

The traded asset is not the rebasing xStock. It is a Backed-deployed **ERC-4626 wrapper** whose share price already contains every corporate action ever applied:

```
wAAPLx.convertToAssets(1e18) == AAPLx.multiplier() == 1003269012539818700
```

Equal to the wei, with a passing [fork test](https://github.com/OoJae/curb/blob/main/test/fork/MarketClock.t.sol) asserting it. So **comparing a wrapper price to underlying spot is wrong by the accrued multiplier, and the error never resets.** When measured in September 2026 it was 33bp on Apple, 57bp on SPY and 77bp on AGNC.

Worse for a lending market: **the multiplier is not monotonic.** It encodes every corporate action, and it can fall. `NFLXx` sits at exactly 10.0, a 10-for-1 forward split. `HONx` went from 1.0241 to 0.5120 (a reverse split) and then to 0.9991 (a spin-off), all within 8h25m on 29 June 2026. **336 of 732 assets had a multiplier other than 1** in our September 2026 survey. Any engine that books a balance increase as income hands out free credit on a split and force-liquidates on the price leg. The only safe discriminator is `caType` from the issuer's versioned corporate-actions feed. And **rebases emit no event at all**: activation is on a timestamp, so a ±5,000-block log scan around one finds nothing.

## Specification

### The ask

This is not a general listing. On this instance WOKB ([deployment ARFC](https://governance.aave.com/t/arfc-deploy-aave-v3-on-x-layer/23175)) and PT-USDG-29OCT2026 ([listing](https://governance.aave.com/t/direct-to-aip-pt-usdg-x-layer/25464)) are both non-borrowable, have zero LTV in the general market, and count as collateral only inside their own E-Mode. Following that pattern, we propose that a tokenized equity be **non-borrowable, usable as collateral only within a dedicated E-Mode, with a supply cap sized to measured sellable depth rather than to headline liquidity.** LlamaRisk recommends the same shape for the tokenized equities market proposed on Aave V4 Base, with equities as collateral only and USDC as the only borrowable asset ([parameters](https://governance.aave.com/t/arfc-deploy-aave-v4-on-base/25427/5)).

A tokenized equity that cannot be arbitraged for 141 hours a week has no business being borrowable.

### Market configuration: wTCENTx, illustrative

| parameter | value | derivation |
|---|---|---|
| Borrowable | **No** | the asset has no arbitraged price for 84% of the week |
| Collateral | **Dedicated E-Mode only** | as WOKB and PT-USDG-29OCT2026 on this instance |
| Supply cap | **$50,000** | below the ~$58.3k of sellable depth measured in the wTCENTx/USDG pool on 13 Sept; re-measure before any vote |
| Borrow cap | n/a | |
| LTV | **see below** | not expressible as one number |
| Liquidation threshold | conservative, sized for the closed state | |
| Liquidation bonus | must exceed the measured closed-state impact at liquidation size | 281bp at $50k (13 Sept) |
| Reserve factor | standard | |

### The parameter Aave does not currently have

The honest finding is that **LTV for this asset class is a function of time, not a constant**, and Aave V3 has no mechanism to express that. There are two options, and we have no stake in which one is chosen:

**Option A: static, sized for the closed state.** One LTV, low enough to be safe during the 141 hours a week when creation and redemption are off. It is simple and requires nothing new, and it makes the asset unattractive most of the week.

**Option B: a regime-aware Risk Steward.** A steward reads `MarketClock.primaryCapNow(wrapper)` and steps LTV down when it reads zero. This is the parameter that actually matches the risk. It needs a steward with a narrow, published mandate. That is a governance question rather than a technical one, because the oracle already exists and is free.

We are not asking for Option B. We are pointing out that Option A is the only choice expressible today, and that it prices the asset as if it were always shut.

### A reference implementation of Option B, outside Aave

To show that Option B is buildable, on 24 Sept 2026 we deployed a small credit line on X Layer mainnet: `CurbCredit` (`0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339`), with its bid book `DepthCert` (`0x702b1a988765f85162F4829175EF4232197e9C6D`) and a maker allowlist (`0xbA1aB5027e826D564EA913b3f7acb95Fd651758E`). All three are Sourcify `exact_match` and cannot be upgraded, and the parameters of `CurbCredit` and `DepthCert` are constants. The team's deployer is `CurbCredit`'s admin and runs its borrower and maker allowlists. It can withdraw idle reserve, but it cannot change a parameter or touch a borrower's collateral. It is not a proposal for Aave to adopt. It lends USDG at a fixed 5% a year, simple interest, and only to allowlisted borrowers: today, one disclosed team wallet (the team's OKX Agentic Wallet). Its published `ltvFor(asset)` works like this:

- It reads **0** when MarketClock is stale (fail closed), when the price is unreadable, or when no qualifying bid is posted.
- Otherwise it is the lower of two numbers: a regime cap, **60% while primary capacity is on and 30% while it is shut**, and the lowest qualifying bid per share as a fraction of the pool's own price. If bids leave and the rest no longer cover everything lent, every position's limit shrinks pro rata (`ltvEffective`), and no new borrow may take total lending past what the bids would pay.
- The bids are firm bids in `DepthCert`, each bonded at least 10%, and the bond goes to the taker if the bid fades. Only an allowlisted maker can post one for the credit line, since it sets every borrower's LTV. Today the makers are two team wallets, curb-desk and the deployer. Until 25 Sept 2026 curb-desk was also an allowlisted borrower, so one team wallet could both borrow and set the LTV; after the demo it was removed from the borrower list ([tx](https://www.oklink.com/xlayer/tx/0xc505987a875c78e43d222bfa498b4f84d63e008b45933ee6aca205996a33b0a6)), and no maker can borrow now. A bid qualifies while its maker's USDG balance and allowance cover all the maker's bids, and only if it will still be there after the slowest liquidation: while the market is open, for 90 minutes, or for 73½ hours after a close due within 90 minutes; while it is shut, for 73½ hours and until 90 minutes after the next scheduled transition.
- Anyone can flag a breach, which starts a cure clock that counts only **witnessed open-market time**: the time between two checks counts only when they are at most 10 minutes apart and the market is open at both. Liquidation needs 30 such minutes and an open market, so nobody is liquidated while the market is shut, and it never seizes more than a 5%-bonus liquidation at the breach-time price would.
- A refused borrow does not revert. It emits `Refusal(who, asset, reason, requested, allowed)` and changes nothing, so every refusal is on the record.

The first borrow was refused: in block 71,516,369 the team's Agentic Wallet asked for 1.4 USDG from a reserve another team wallet had funded, and with no bid posted, the transaction succeeded, changed nothing and emitted `Refusal(NoDepth)` (tx `0x8bd873d77176dab81ad860c1496937d2e7535c8a6b91f0be5902936b408b5c7a`).

The rules are written out in the NatSpec of [`CurbCredit.sol`](https://github.com/OoJae/curb/blob/main/src/CurbCredit.sol) and [`DepthCert.sol`](https://github.com/OoJae/curb/blob/main/src/DepthCert.sol). Transactions and the changes made in review are in [`docs/DEPLOYMENTS.md`](https://github.com/OoJae/curb/blob/main/docs/DEPLOYMENTS.md).

## Oracle

**For the names live on X Layer, this is the hardest part of a listing, and it is the section this post exists for.**

Aave's existing X Layer reserves are priced from Chainlink feeds, except GHO, which is fixed at $1. xBTC, xETH, xSOL and WOKB read the feeds directly; USDT0, USDG, USDC, xBETH and xOKSOL go through Aave's price-cap (CAPO) adapters, and PT-USDG through a capped linear-discount adapter ([Aave address book](https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3XLayer.sol)). **We found no Chainlink equity stream for the Hong Kong names.** X Layer's VerifierProxy is live and fee-free (`typeAndVersion()` = "VerifierProxy 2.0.0", `s_feeManager()` = `address(0)`, so no LINK and no WOKB). But equity coverage on chain 196 cannot be confirmed without request-gated credentials, which we do not have.

`MarketClock` at `0x160Dc415902971a7a9B5ade7f43005b36FE5B09b` (Sourcify `exact_match`) does not replace a price feed. It answers the prior question: *is this price arbitraged right now?*

```solidity
if (clock.primaryCapNow(wrapper) == 0) {
    // Creation/redemption is switched off. Any "price" here is unarbitraged.
    // Defer, widen, or take the forward -- but do not mark a borrower at it.
    revert MarketShut();
}
```

Views: `regime`, `primaryCapNow`, `secondsToNextTransition`, `isInMultiplierBlackout`, `rawToShares`.

Properties a risk reviewer should check rather than take on trust:

- **It fails closed.** An attestation older than 30 minutes reports `UNKNOWN`, and `primaryCapNow` returns **0**, never the last known value. A dead attestor can never leave an asset looking open.
- **`UNKNOWN` is the zero value**, so an unregistered asset cannot be mistaken for an open one.
- **Blackouts are driven by an observed nonce change, not a clock**, because corporate actions activate on a timestamp and emit no event. Measured activations include 23:55Z, 02:30Z and 11:20Z. Never hardcode a fixed daily window.
- **Every state is reproducible.** Each round commits a Merkle root of its exact inputs under a versioned method. The open-source verifier in the Curb repository ([`tools/curb-verify`](https://github.com/OoJae/curb/tree/main/tools/curb-verify)) re-derives any round on a clean machine. `curb-verify tx <hash>` starts from the transaction and checks what was written on chain against the round's published bundle, `curb-verify range <from>..<to>` checks every Curb write in a block range, and `curb-verify bundle <url>` verifies a bundle offline.
- **`secondsToNextTransition()` is the next schedule boundary, not the reopen.** See finding 2. Walk the venue's published boundaries to the first period with non-zero capacity.

### Two limitations we would rather state than have found

1. **Attestation is single-signer today.** The deployed contract's NatSpec says "quorum-signed off-chain". That describes the intended design, not what currently runs, and the deployed source is immutable. A second host, on a different provider and continent, independently re-derives and EIP-712-signs every round. That is an attributable second check, **not a quorum**.
2. **`stateOf()` deliberately does not fail closed.** It returns the stored struct verbatim, so `stateOf().primaryCapUsd` on a dead attestor returns the last known capacity rather than 0. The staleness guard is in `regime()` and `primaryCapNow()`. Any integration must read those.

We also publish our own errata. Six rounds at the very start of the record (blocks 70,617,365 to 70,619,011, 14 Sept) wrote the issuer's *cents* value into a whole-USD field, overstating capacity 100×. Regimes were correct throughout, so a consumer checking `primaryCapNow == 0` got the right answer and one reading the size did not. This was corrected at block 70,619,137. Derivation methods are versioned and never edited in place, so every historical round stays reproducible under the rules that produced it.

## Disclosure

- MarketClock and this framework were built by the Curb team. **Reading MarketClock is free:** MIT, no key, no fee, no token.
- **Curb does earn revenue from the same data.** It sells a paid API over x402 (a closure calendar, the graded record of its reopen prices, and a closure-discount curve), offered through its agent on the OKX AI marketplace, [#13869](https://www.okx.ai/agents/13869), listed on 25 Sept 2026. Nothing in this proposal routes fees to Curb.
- We are not compensated by Aave, by Backed, or by any party to this proposal.
- We operate products that consume MarketClock, including the credit line described above. We therefore have an interest in the asset class being listable, and we state that plainly rather than presenting this as disinterested research.
- The funding graph of **every** wallet we control is published in advance in the repository's [`docs/WALLETS.md`](https://github.com/OoJae/curb/blob/main/docs/WALLETS.md), including which addresses must be excluded from any claim about third-party usage.

## Next steps

1. Feedback from Risk Service Providers on whether a regime-stepped LTV is expressible today, or whether Option A is the only path.
2. We will append the depth curve for the remaining Hong Kong names when that measurement completes.
3. If a listing is not appropriate, a documented "no" with a parameter set attached is a useful outcome, and we will publish it as such. **Nothing Curb does depends on this proposal passing**, and we would rather say so here than have it inferred.

## Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

---

*Internal. Delete everything below this line before posting.*

**Done (25 Sept 2026):**

- [x] Every placeholder is resolved; *Last revised* is 25 Sept 2026.
- [x] The two first-draft claims are source-checked against the Aave forum and chain, corrected and linked: the
      July 2026 deprecation (49 reserves, 21 matured PTs, six deployments; AIP 521) and the precedent (WOKB,
      PT-USDG-29OCT2026). "Isolated eMode" is now "dedicated E-Mode". The oracle sentence and the "every listing
      fails" / "not published anywhere" lines are corrected, with the B20 Equities Hub and bCSPX context.
- [x] Re-checked that no tokenized equity has been proposed on Aave V3 X Layer (11 reserves read on chain, forum
      searched; only USDe pending).
- [x] Every repo mention is a full `github.com/OoJae/curb` URL.
- [x] The CurbCredit section matches what is deployed: CurbCredit `0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339`,
      DepthCert `0x702b1a988765f85162F4829175EF4232197e9C6D`, maker registry
      `0xbA1aB5027e826D564EA913b3f7acb95Fd651758E`, all Sourcify `exact_match`. Read-only spot check at block
      71,530,930 (25 Sept ~01:33Z): `reserve()` = 3,000,000, `ltvFor(wTCENTx)` = 0, DepthCert `nextId()` = 1,
      borrowers = curb-desk + Agentic Wallet, makers = curb-desk + deployer, `admin()` = deployer, `APR_BPS` = 500.
- [x] Finding 3 rewritten to match the chain (the pools traded during closures).
- [x] Depth figures dated (13 Sept); Scorecard tally dated (25 Sept 15:04Z, block 71,579,624).
- [x] `curb-verify tx` and `range` have landed (commit 08f2a11); the verifier bullet is updated.
- [x] `docs/DEPLOYMENTS.md` no longer says a borrower can never be a maker (commit bee9454), so the linked file
      matches the chain.

**Still to do before posting:**

1. Review `docs/AAVE_ARFC_CHANGES.md` and approve this revision. Finding 3 and the CurbCredit section changed in
   substance since the text was approved.
2. Done 25 Sept ~14:50Z: `main` pushed and https://github.com/OoJae/curb made public; every repo link returns 200
   logged out.
3. Done: `docs/DECISIONS.md` D-11 carries a public erratum (the pools do trade while shut), and D-13 was corrected.
   The keeper's `no-drift` flag is to be investigated after the finale.
4. Post from your own governance.aave.com account as a **[Discussion]** in **Risk > General** (not an ARFC: under
   Governance Framework v2 an ARFC is a binding-vote stage opened by approved authors, and new listings come from
   the service providers; this post asks for no vote). Title: the H1 without "# ". Body: from "## Summary" through
   the CC0 line; leave out the status line and everything below the internal line. Step-by-step guide:
   `docs/AAVE_POSTING_GUIDE.md`.
5. On the day of posting, re-read every live figure and update or re-date it:
   - Scorecard v2 `closureCount()` / `skill()`. The post's tally is dated 24 Sept 22:53Z; at 25 Sept ~01:33Z
     `closureCount()` was already 18 (three rows unsettled) and `skill()` still (15, 0, 0).
   - CurbCredit `reserve()`, `ltvFor(wTCENTx)`, DepthCert `nextId()`, and both allowlists. "Today, two disclosed
     team wallet" must still be true (curb-desk left the borrower registry on 25 Sept, tx 0xc505987a…). "The first
     borrow was refused" stays true.
   - OKX agent #13869: listed 25 Sept 2026 (done).
   - Aave forum: no new tokenized-equity proposal on Aave V3 X Layer; the B20 Equities Hub Snapshot closes
     25 Sept 13:49 UTC (the post says only "proposed", which stays true); LlamaRisk's 25427/5 post still says what
     the post cites.

Recommended, not blocking: fix the repo documents with the errors the post has dropped (`docs/DECISIONS.md` D-7
heading says seven bad rounds, not six; `docs/MARKETCLOCK.md:51` says 8h14m, not 8h25m; `docs/MARKETCLOCK.md:24`
says 140.5 h / 83.6%, as does the immutable NatSpec at `src/MarketClock.sol:26`, against the post's 141 h 20 m /
84.1%). Consider one sentence acknowledging that the Aave Risk Framework
(https://governance.aave.com/t/arfc-aave-risk-framework/25114) requires a ratified asset class and tokenized
equity is not yet one on V3. Optionally re-run DepthProbe, including the Hong Kong cohort, and replace the 13 Sept
depth figures with newly dated ones.
