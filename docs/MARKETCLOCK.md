# MarketClock — integration guide

**MIT. Unlicensed. No key. Free to read.**
If you are building anything on tokenized equities on X Layer, you need this and you should not
write it yourself. Curb depends on it; it is deliberately useful without Curb.

---

## The problem it solves

A tokenized equity is not a token that happens to track a stock. It is a claim whose price is
held to its underlying by a creation-and-redemption mechanism — and on X Layer that mechanism is
**switched off most of the week**.

The issuer publishes a per-asset order cap for the current period. When that cap is zero, nobody
can create or redeem, so no arbitrage can close a gap between the token and the stock. The AMM
keeps trading anyway. That interval is not a data outage to route around; it is a scheduled,
published, priceable event, and it is invisible unless you go looking for it.

How much of the week it covers, measured:

| cohort | count | hours mode | primary market shut |
|---|---|---|---|
| Hong Kong (`XHKG`) | 79 | `Regular` — no overnight session at all | **140.5 of every 168 hours (83.6%)** |
| United States | 632 | `TwentyFourFive` | 48 of every 168 hours |
| ETFs (`MarketHours`) | 10 | regular hours only | similar to HK |

Meanwhile those same Hong Kong pools are the most violently churned on the chain — wrapped SHEIN
turns **$15.4M a day through a $69,784 book**, roughly 220 times its own depth.

## The second problem: wrapper units

The asset that trades on X Layer is **not** the rebasing xStock. It is a Backed-deployed ERC-4626
wrapper, and its share price already contains every corporate action ever applied.

```
wAAPLx.convertToAssets(1e18) == AAPLx.multiplier() == 1003269012539818700
```

Both sides are equal to the wei, and there is a passing fork test asserting it
(`test/fork/MarketClock.t.sol::test_rawToShares_matches_issuer_multiplier`).

So **comparing a wrapper price to underlying spot is wrong by the accrued multiplier, and the
error never resets.** Today that is 33bp on Apple, 57bp on SPY, 77bp on AGNC. Call
`rawToShares()` and denominate obligations in share-equivalents rather than wrapper balances.

And the multiplier is **not** a dividend accumulator that only rises:

- `NFLXx` = **10.000000** exactly (10-for-1 forward split)
- `PPLTx` = 10.0, `KLACx` = 10.0168, `CRWDx` = 4.0
- `HONx` went 1.0241 → **0.5120** (reverse split) → 0.9991 (spin-off) in 8h14m
- **336 of 732 assets have multiplier ≠ 1**

Any code that treats a balance increase as income will hand out free credit on a split and
force-liquidate on the price leg. The only discriminator is `caType` from the issuer's versioned
corporate-actions feed.

## Interface

```solidity
enum Regime { UNKNOWN, CLOSED, OVERNIGHT, EXTENDED, MARKET }  // UNKNOWN is 0, deliberately

function regime(address wrapper) external view returns (Regime);
function primaryCapNow(address wrapper) external view returns (uint128);   // whole USD, 0 = shut
function secondsToNextTransition(address wrapper) external view returns (uint256);
function isInMultiplierBlackout(address wrapper) external view returns (bool);
function rawToShares(address wrapper, uint256 wrapperShares) external view returns (uint256);
function stateOf(address wrapper) external view returns (State memory);
```

### Typical use — do not liquidate into a shut primary market

```solidity
if (clock.primaryCapNow(wrapper) == 0) {
    // Creation/redemption is switched off. Any "price" here is unarbitraged.
    // Defer, widen, or take the forward — but do not mark a borrower at it.
    revert MarketShut();
}
```

### Guard every balance-denominated settlement

```solidity
require(!clock.isInMultiplierBlackout(wrapper), "corporate action in flight");
uint256 shares = clock.rawToShares(wrapper, wrapperBalance);
```

## Design decisions you should know about before depending on it

- **It fails closed, always.** An attestation older than `MAX_ATTESTATION_AGE` (30 minutes)
  reports `UNKNOWN` and `primaryCapNow` returns **0**, not the last known value. A dead attestor
  can never leave an asset looking open. If you consume this, treat `UNKNOWN` as shut.
- **`UNKNOWN` is the zero value** so an unregistered or never-attested asset cannot be mistaken
  for an open one by an uninitialised slot.
- **`stateOf()` deliberately does NOT fail closed, and this is the one trap in the interface.** It
  returns the stored struct verbatim, so `stateOf(w).primaryCapUsd` on a dead attestor hands you the
  *last known* capacity rather than 0 — precisely the failure the contract exists to prevent. The
  staleness check lives in `regime()` and `primaryCapNow()`. Read those. `stateOf()` is for
  inspecting raw state (`observedAt`, `multiplierNonce`, `nextTransitionAt`), not for deciding
  whether a market is open.
- **`secondsToNextTransition()` is the next *schedule* boundary, not the reopen.** A closure routinely
  spans several: the Hong Kong afternoon cut runs 15:55 (capacity off) → 16:00 (extended, still zero)
  → 16:10 (venue shut) → 09:00 next day (extended, still zero) → 09:30 (capacity back). Trusting the
  next boundary would read a 17½-hour closure as a five-minute one. To find when capacity actually
  returns, walk the venue's published boundaries to the first instant whose period carries a non-zero
  issuer cap — `services/keeper/src/reopen.ts` does exactly that, and it is pure and reproducible.
- **Blackouts are driven by an observed nonce change, not a clock.** Corporate actions activate on
  a timestamp and **emit no event whatsoever** — a ±5,000-block log scan around AAPLx's activation
  found nothing. So the attestor polls `getCurrentMultiplier()`, whose third word is a monotonic
  counter, and opens a 15-minute blackout the moment it moves. Never hardcode 00:30 UTC: measured
  activations include 23:55Z, 02:30Z and 11:20Z.
- **The economic definition beats the label.** If the issuer reports `market` but the applicable
  cap is zero, the asset is resolved `CLOSED`. No capacity means no arbitrage.
- **The venue calendar wins ties, and disagreements are surfaced not hidden.** When the asset
  object and the exchange's published schedule disagree, we defer to the schedule when it says
  shut, and log the disagreement rather than silently resolving it.
- **Attestation today is single-signer, not quorum-signed.** The verified contract's NatSpec says
  "quorum-signed off-chain". That describes the intended design, **not what runs now**, and the
  deployed source cannot be edited. One host (A, Railway Singapore, `0x842e…eEC4`) signs and sends
  every round. A second attestor key (`0x4c3e…7fb8`) is enabled as a cold spare.
- **Every round is witnessed by a second, independent host.** Host B (Tencent, Silicon Valley,
  `0x50Fa…39fB`) runs on a different provider, continent and CDN edge. For each onchain write it:
  - fetches the bundle and re-derives it;
  - checks that the calldata written equals the claims committed;
  - checks the evaluation time against the block time;
  - compares the claims with its own reading of the issuer;
  - signs the result as EIP-712 typed data, pass or fail (`RoundWitness`, domain
    `Curb MarketClock Witness` v1, bound to chain 196 and this contract).

  A witness does not change what the contract stores, so it is an attributable second check, not a
  quorum. The HTTP bodies are what the attestors saw; they are witnessed, not proven.
- **Units.** `primaryCapNow` is whole US dollars. The issuer publishes caps in cents, and the
  attestor converts them under derivation method `curb.marketclock.derive/2`. Rounds before block
  70,619,137 used `derive/1` and overstate the cap 100x. Their regimes were correct. See
  `docs/DECISIONS.md` D-7.

## Operational notes for anyone running an indexer on X Layer

- `eth_getLogs` is capped at a **100-block range** on the public RPC (`rpc.xlayer.tech`). Page in
  100-block windows or use a private endpoint.
- The issuer API is unauthenticated but undocumented as to rate limits, and geoblocks US persons
  on its web properties. Snapshot what you depend on.
- Corporate-action records are **versioned**, and 13 of 694 are `Cancelled` with 16 `Corrected`.
  The same `eventId` reappears at higher versions. A one-shot import produces confidently wrong
  numbers; persist every version and re-derive.

## Verify it yourself

```bash
forge test --match-path test/fork/MarketClock.t.sol -vv   # 6 tests, live mainnet fork
```
