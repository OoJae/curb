# MarketClock — integration guide

**MIT. No licence fee. No key. Free to read.**
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
| Hong Kong (`XHKG`) | 79 | `Regular` — no overnight session at all | **141 h 20 m of every 168 hours (84.1%)**, counting the issuer's measured five-minute early cut before every period end (D-4) |
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
- `HONx` went 1.0241 → **0.5120** (reverse split) → 0.9991 (spin-off) in 8h25m
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

## Three lines to integrate

Two read-only helpers sit on top of the clock. Neither holds funds or has an admin, and neither can change
what the clock says.

**In a contract: `MarketClockGuard`** (`src/lib/MarketClockGuard.sol`). Internal functions only, so there
is nothing extra to deploy or trust. It depends only on `src/interfaces/IMarketClock.sol`, and both files
are MIT: copy them in.

```solidity
import {IMarketClock, MarketClockGuard, MarketClockGuarded} from "./MarketClockGuard.sol";   // 1

contract Pool is MarketClockGuarded(IMarketClock(MarketClockGuard.XLAYER_MARKET_CLOCK)) {     // 2
    function borrow(address wrapper, uint256 amount) external whenPrimaryOpen(wrapper) {    // 3
        // ... unchanged ...
    }
}
```

- `whenPrimaryOpen(w)` reverts `MarketShut(w, regime)` unless the regime is `OVERNIGHT`, `EXTENDED` or
  `MARKET`, `primaryCapNow` is above zero, no blackout is running and the issuer has not halted. Put it in
  front of anything that values the wrapper at a market price: a borrow, a liquidation, a mark.
- `notDuringBlackout(w)` reverts `MultiplierBlackout(w)` only while a corporate action is being applied. Put
  it in front of anything that settles in wrapper balances or share-equivalents. It does not refuse a shut
  market.
- Without inheriting: `MarketClockGuard.requireArbitraged(clock, w)`, `requireNotBlackout(clock, w)` and
  `isArbitraged(clock, w)`. A worked example is in `src/examples/ExampleLendingGuard.sol` (not deployed).
- The pinned address is MarketClock on X Layer mainnet (196). On a chain with no code there (testnet 1952
  had none on 25 Sep 2026), every guarded call reverts, which is the closed direction. Read the clock
  off-chain there instead.

**Off-chain, or from code written for Chainlink Data Streams: `MarketClockStatus`**
(`src/adapters/MarketClockStatus.sol`). `marketStatus(wrapper)` returns a `uint32` in the numbering of the
`marketStatus` field of Chainlink's RWA Advanced (v11) report. It is not a Chainlink product and reads no
Chainlink feed. Deployed 25 Sep 2026 at [`0xD5EEeD33117c7B2B39EF1Dad7e0eeEDe6b9836d9`](https://www.oklink.com/xlayer/address/0xD5EEeD33117c7B2B39EF1Dad7e0eeEDe6b9836d9)
(Sourcify `exact_match`; no admin, no storage but the clock address, no funds).

```bash
cast call 0xD5EEeD33117c7B2B39EF1Dad7e0eeEDe6b9836d9 "marketStatus(address)(uint32)" 0x41333Df9E7639188BBfca5522dC4844398Af9f9E \
  --rpc-url https://rpc.xlayer.tech
```

| MarketClock says (through its fail-closed reads) | `marketStatus` |
|---|---|
| `UNKNOWN`: never attested, not registered, or last attestation older than 30 minutes | **0**, unknown: treat as shut |
| `CLOSED`; any open label with a zero cap; a corporate-action blackout; an issuer halt | **5**, closed |
| `MARKET` with a cap above zero | **2**, regular |
| `EXTENDED` with a cap above zero | **3**, post-market. MarketClock does not split pre from post, so **1** is never returned |
| `OVERNIGHT` with a cap above zero | **4**, overnight (US names) |

`isArbitraged(w)` is true exactly when the code is 2, 3 or 4, the same predicate as the guard.
`statusMany(address[])` batches. `secondsToNextTransition(w)` passes MarketClock's value through unchanged,
with the caveat under "Design decisions" below. Two differences from a status built on the venue's calendar:

- During the issuer's five-minute cut before each period end (`docs/DECISIONS.md`, D-4), the venue's
  calendar still says open. This returns 5.
- Hong Kong names read only 0, 2 or 5: they have no overnight session, and their extended sessions carry a
  zero cap and are attested `CLOSED`. That matches v11's standard-hours feeds, which never use 1, 3 or 4.

The deploy script's dry run (a simulation against mainnet; nothing deployed) on 25 Sep 2026 at 01:08Z,
block 71,529,453, read 5 for the four Hong Kong wrappers (09:08 HKT, the pre-opening session) and 4 for
wNVDAx and wAAPLx (US overnight session, cap $200,000).

```bash
forge test --match-path 'test/MarketClock*.t.sol'                     # guard + adapter, 29 tests, no fork
forge test --match-path test/fork/MarketClockStatusFork.t.sol -vv     # 3 tests, live mainnet fork
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
  every round. Two more attestor keys are enabled: host B (`0x50Fa…39fB`), which writes only if host A
  goes silent, and a cold spare (`0x4c3e…7fb8`). Any one of the three can write a round alone.
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
