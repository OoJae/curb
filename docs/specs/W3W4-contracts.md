# W3–W5 contract spec — frozen 24 Sep 2026 for parallel build

Source: design review of the repo + read-only chain checks, 24 Sep 2026. This is the single source of truth
for packages P0–P4. If something here is wrong, stop and tell the lead; do not improvise an interface.

## 0. Chain facts this design rests on (read-only checks)

- Agentic Wallet `0x055ba8acd60a2287b2d01cb3bf237e4424357105` carries EIP-7702 delegation code (`0xef0100e40c…`);
  its `onERC1155Received` returns `0xf23a6e61` and `supportsInterface(0x4e2312e0)` is true, so it can receive
  ERC-1155 notes.
- Deployer `0x78a5955b433988198bccA2E8bdC671444798f809`: 0.0033 OKB; gas ~0.02 gwei; W3+W4 ≈ 12M gas ≈ 0.00024 OKB.
- USDG `0x4ae46a509F6b1D9056937BA4500cb143933D2dc8`: 6 decimals, EIP-1967 proxy. The wTCENTx pool holds ~83.7k
  USDG, so fork tests fund USDG by pranking the pool `0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f`.
- Wrappers are 18 decimals. `priceNow` today: wTCENTx 55.78, wNVDAx 223.35, wAAPLx 337.89.
- Build: solc 0.8.28, evm `prague`, legacy codegen (as the deployed contracts). `lib/forge-std` is vendored.
- No Universal Router, TickMath or OpenZeppelin needed.
- Deployed: MarketClock `0x160Dc415902971a7a9B5ade7f43005b36FE5B09b`, Scorecard v2
  `0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f` (see `src/interfaces/IMarketClock.sol`, `src/Scorecard.sol`).
- Host A attestor `0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4` (prank it calling `attest` to flip regimes on a fork;
  re-attest after any warp > 30 min, since MarketClock returns UNKNOWN when stale).

## 1. Units (everywhere)

S = wrapper-share wei (18 dp). USDG amounts 6 dp. P = `Scorecard.priceNow` in 1e18 USD per whole share.
`bidPx` = USDG units per whole share (1e18 wei).

```
valueUsdg(S,P) = mulDiv(S, P, 1e30)
notional(S,px) = mulDiv(S, px, 1e18)
sharesFor(u,P) = mulDiv(u, 1e30, P)
```
All maths via `src/lib/MulDiv.sol`. Every mutating function: inline storage-slot `nonReentrant` (no `transient`).
Only EligibilityRegistry and CurbCredit (reserve management) have an admin; ReopenPointer, ReopenNote,
ClosedAuction and DepthCert have **no admin at all**.

## P0 — shared scaffold (frozen before fan-out)

```solidity
// src/interfaces/IScorecardPrice.sol — matches deployed Scorecard v2 getters exactly (verify against src/Scorecard.sol)
interface IScorecardPrice {
    function priceNow(address wrapper) external view returns (uint128);
    function priceSources(address wrapper) external view
        returns (address pool, bool equityIsToken0, uint32 twapWindow, uint8 equityDecimals, uint8 stableDecimals);
}
// src/interfaces/IEligibility.sol
interface IEligibility { function isEligible(address who) external view returns (bool); }
// src/interfaces/IERC20.sol  (decimals, balanceOf, allowance, approve, transfer, transferFrom)
// src/interfaces/IReopenPointer.sol, IReopenNote.sol, IDepthCert.sol — exactly as below (frozen)
// src/lib/SafeTransfer.sol   safeTransfer / safeTransferFrom with return-data check; error TransferFailed(address token)
// src/lib/ERC1155Min.sol     abstract, MIT, ~130 lines: balanceOf, balanceOfBatch, setApprovalForAll,
//   isApprovedForAll, safeTransferFrom, safeBatchTransferFrom, supportsInterface(0xd9b67a26,0x01ffc9a7,0x0e89341c),
//   uri(id) -> base string; internal _mint/_burn; receiver check iff to.code.length > 0 (7702 EOAs have code).
// test/mocks/{MockERC20 (with freeze + returnFalse toggles), MockWrapper4626 (settable convertToAssets rate),
//   MockClock (settable regime/cap/blackout/stateOf nonce/rawToShares), MockScorecardPrice (settable price, revert toggle)}.sol
```
(If the deployed `priceSources` getter returns a different tuple, match the deployed one and note it.)

## EligibilityRegistry (P2) — thin allowlist (~40 lines)

`constructor(address admin)`; `isEligible(address) → bool` (public mapping); `setEligible(address who, bool ok,
bytes32 evidence)` onlyAdmin; two-step `transferAdmin`/`acceptAdmin` copied from MarketClock.
Event `EligibilitySet(address indexed who, bool ok, bytes32 evidence)`. Errors `NotAdmin`, `NotPendingAdmin`, `ZeroAddress`.

## ReopenPointer (P1) — monotonic reopen record

```solidity
interface IReopenPointer {
    struct Epoch { uint64 shutSeenAt; uint64 openedAt; uint64 openedBlock; uint128 print; uint64 printedAt; }
    event Shut(address indexed wrapper, uint32 indexed epoch, uint64 at);
    event Reopened(address indexed wrapper, uint32 indexed epoch, uint64 shutSeenAt, uint64 openedAt, uint128 primaryCapUsd);
    event Printed(address indexed wrapper, uint32 indexed epoch, uint128 print, uint64 at);
    function observe(address wrapper) external returns (uint32 epoch, bool open);   // permissionless
    function recordPrint(address wrapper, uint32 epoch) external returns (uint128);  // permissionless
    function epochOf(address wrapper) external view returns (uint32);
    function isOpen(address wrapper) external view returns (bool);
    function epochInfo(address wrapper, uint32 epoch) external view returns (Epoch memory);
}
```
`constructor(IMarketClock clock, IScorecardPrice scorecard)`; `PRINT_DELAY = 300` (= Scorecard SETTLE_DELAY);
`PRINT_WINDOW = 30 minutes`. State `struct Head { uint32 epoch; bool open; uint64 lastShutAt; uint64 lastObservedAt; }`.
Errors `UnknownEpoch`, `PrintTooEarly(uint64 readyAt)`, `PrintTooLate(uint64 deadline)`, `AlreadyPrinted`, `MarketShut`.

`observe`:
- `regime == UNKNOWN` (stale) → no state change, return current head.
- `primaryCapNow == 0` → `open = false`, `lastShutAt = now`; emit `Shut` only on open→shut.
- `cap > 0 && !open`: if `lastShutAt != 0` → `epoch++`, store `Epoch{shutSeenAt: lastShutAt, openedAt: now, openedBlock}`,
  emit `Reopened` (true reopen ∈ (shutSeenAt, openedAt]). If `lastShutAt == 0` (never witnessed shut) → `open = true`, **no** epoch.
- So the epoch advances only on a verified open observation whose last positive predecessor was not-open.

`recordPrint(w, e)`: requires `1 ≤ e ≤ head.epoch`, `now ∈ [openedAt+300, openedAt+300+1800]`, `primaryCapNow(w) > 0`,
no print yet; stores `print = scorecard.priceNow(w)` (the same guarded spot that graded Scorecard rows). Write-once
per (asset, epoch): every note of that asset/epoch shares one print; no cherry-picking.

## ReopenNote (P1) — ERC-1155, physically settled in wrapper shares

```solidity
interface IReopenNote {
    struct Unit { address wrapper; address issuer; uint128 wrapperShares; uint128 underlyingAtMint;
                  uint32 multiplierNonce; uint32 epochAtMint; uint64 mintedAt; uint64 mintedBlock; }
    function mint(address wrapper, uint128 wrapperShares, address to) external returns (uint256 id);
    function redeem(uint256 id, uint128 amount, address to) external;   // burns msg.sender's units
    function cancel(uint256 id) external;                               // issuer holding ALL outstanding
    function unitOf(uint256 id) external view returns (Unit memory);
    function outstanding(uint256 id) external view returns (uint128);
    function redeemable(uint256 id) external view returns (bool);
    function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external;
    function balanceOf(address, uint256) external view returns (uint256);
    function isApprovedForAll(address, address) external view returns (bool);
}
```
`constructor(IMarketClock, IReopenPointer, IScorecardPrice, address[] wrappers, uint256[] capShares, string uri)` —
reverts if any wrapper lacks a Scorecard price source. Caps fixed from D-3: **wTCENTx 175e18, wNVDAx 220e18,
wAAPLx 14e18**. wXIAOx/wMEITx excluded (no measured depth), wSHEINx excluded (no price source).
`FALLBACK_AFTER = 10 days`; `name = "Curb Reopen Note"`, `symbol = "CURB-RN"`.
Events `NoteMinted(id, issuer, wrapper, wrapperShares, underlyingAtMint, multiplierNonce, epochAtMint, to)`,
`NoteRedeemed(id, holder, to, wrapperShares, underlyingAtRedeem, nonceAtRedeem, epochNow, viaFallback)`,
`NoteCancelled(id, issuer, wrapperShares)`. Errors `UnsupportedAsset`, `MarketNotClosed`, `InBlackout`,
`CapExceeded(uint256 oi, uint256 cap)`, `ZeroAmount`, `NotReopened(uint256 id, uint32 epochAtMint, uint32 epochNow)`,
`NotWholeIssuer`, `UnknownNote`.

`mint`: `capShares[w] > 0`; `regime == CLOSED && primaryCapNow == 0`; not in multiplier blackout; `openInterest + s ≤ cap`;
`pointer.observe(w)` must report not-open → `epochAtMint` = returned epoch; pull `s` shares; mint `s` units (1 unit =
1 wei of share) to `to`; record `underlyingAtMint = clock.rawToShares(w, s)` and nonce from `stateOf`.
`redeem`: first `pointer.observe`; unlocked when `epoch > epochAtMint` or `now ≥ mintedAt + 10 days`; burn `amount`,
deliver **exactly `amount` wrapper shares**; does **not** block in a multiplier blackout (the 4626 share absorbs every
corporate action); underlying shares + nonce recorded as provenance only.

## ClosedAuction (P2) — descending clock, clears with a single bidder

`constructor(IReopenNote, IReopenPointer, IMarketClock, IScorecardPrice, IERC20 usdg, IEligibility elig /*0 = ungated*/)`.
Lot `{ seller, wrapper, noteId, amount, startPrice, floorPrice, refPrice, startAt, endAt, decaySeconds, epochAtMint,
status(NONE/LIVE/SOLD/WITHDRAWN), buyer, clearedPrice, clearedAt }`.
Functions: `list(noteId, amount, startPrice, floorPrice, decaySeconds, endAt) → lotId`; `priceAt(lotId, t)`;
`currentPrice(lotId)`; `bid(lotId, maxPrice) → price`; `withdraw(lotId)` (seller, while LIVE);
`realisedDiscountBps(lotId) → int256`; `onERC1155Received` accepts only `msg.sender == note && operator == this`;
batch receive reverts. Events (≤6 non-indexed each): `Listed(lotId, noteId, seller, wrapper, amount, startPrice, floorPrice, endAt, refPrice)`,
`Cleared(lotId, noteId, buyer, price, discountBpsVsRef, at)`, `Withdrawn(lotId, seller)`.
Errors `BadParams`, `MarketNotClosed`, `ReopenedSinceMint`, `Ineligible`, `LotNotLive`, `LotExpired`,
`PriceAboveMax(uint256 price, uint256 max)`, `NotSeller`, `NotPrinted`.

Price: `p(t) = start − mulDiv(start − floor, min(t − startAt, decay), decay)`; non-increasing; flat at floor until `endAt`.
`refPrice = valueUsdg(amount, priceNow)` at listing (try/catch → 0). `discountBpsVsRef = ref > p ? (ref − p)·1e4/ref : 0`.
`list`: market CLOSED & cap 0; `pointer.epochOf == unit.epochAtMint`; `0 < floor ≤ start`; decay ∈ [60 s, 6 h];
`now < endAt ≤ now + 4 days`; pulls the note (seller must `setApprovalForAll` first).
`bid` (no hindsight after reopen): bidder eligible; LIVE; `now ≤ endAt`; `regime == CLOSED && cap == 0`;
`pointer.observe(w).epoch == epochAtMint`; `p ≤ maxPrice`; effects: SOLD first, then USDG `transferFrom(bidder→seller, p)`,
then note → bidder.
`realisedDiscountBps(lot) = (V − cleared)·1e4 / V`, `V = valueUsdg(amount, print(epochAtMint+1))`; reverts `NotPrinted` if unprinted.

## DepthCert (P3) — bonded firm bid, self-proving fade, no admin

```solidity
interface IDepthCert {
    enum Status { NONE, LIVE, FADED, CLOSED }
    struct Cert { address maker; address wrapper; address beneficiary; uint128 sizeShares; uint128 remainingShares;
                  uint128 bidPx; uint128 bond; uint64 postedAt; uint64 expiry; Status status; }
    function post(address wrapper, address beneficiary, uint128 sizeShares, uint128 bidPx, uint64 expiry, uint128 bond) external returns (uint256 id);
    function take(uint256 id, uint128 shares, address to) external returns (bool filled, uint256 amount);
    function withdraw(uint256 id) external;                       // maker; after expiry or remaining==0
    function claimShares(address wrapper, address to) external returns (uint256);
    function prune(address wrapper, address beneficiary) external; // permissionless book compaction
    function certOf(uint256 id) external view returns (Cert memory);
    function isHonourable(address maker) external view returns (bool);
    function honouredDepth(address wrapper, address beneficiary, uint64 minExpiry) external view
        returns (uint256 shares, uint256 notional, uint128 minBidPx, uint64 soonestExpiry);
}
```
`constructor(IERC20 usdg)`. `MIN_BOND_BPS = 1000`, `MIN_LIFE = 10 min`, `MAX_LIFE = 30 days`,
`MAX_LIVE_PER_BOOK = 8` (per wrapper×beneficiary), `TRANSFER_GAS = 150_000`.
State: `committed[maker] = Σ notional(remaining, bidPx)` over LIVE certs; `claimableShares[maker][wrapper]`;
`totalBonds`; `_book[wrapper][beneficiary]` cert id list.
Events `Posted(id, maker, wrapper, beneficiary, size, bidPx, bond, expiry)`, `Filled(id, taker, shares, paid, remaining)`,
`Faded(id, taker, maker, shares, costOwed, bondSlashed, bytes4 reason)`, `Withdrawn(id, maker, bond)`, `SharesClaimed(maker, wrapper, shares)`.
One-sided bid, one price per cert; several certs form a curve.
`post`: `bond ≥ ceil(notional(size, bidPx)·1000/1e4)`, `notional > 0`, life ∈ [MIN_LIFE, MAX_LIFE]; pulls the bond.
`take`: LIVE; `now < expiry`; `beneficiary == 0 || msg.sender == beneficiary`; `0 < shares ≤ remaining`;
`cost = notional(shares, bidPx) > 0`.
  1. **Taker delivers first**: pull `shares` from the taker (failure reverts the whole call — a taker can never cause a fade).
  2. Maker leg: fade reason `ALLOWANCE` if `allowance(maker) < cost`; `BALANCE` if `balance(maker) < cost`; else if
     `gasleft() < TRANSFER_GAS + TRANSFER_GAS/63 + 10_000` revert `InsufficientGas` (a gas-starved call can't fake a fade);
     else `usdg.call{gas: TRANSFER_GAS}(transferFrom(maker → this, cost))`, failure (incl. frozen maker) → `TRANSFER_FAILED`.
  3. Filled: reduce `remaining` and `committed`; credit maker's claimable shares (pull pattern); send `cost` USDG to `to`.
  4. Faded: status FADED; zero its `committed`; slash the full bond to `to`; return the taker's shares to `msg.sender`.
     (If USDG is paused globally the bond transfer reverts → no fade.)
`isHonourable(maker)`: balance and allowance both ≥ `committed[maker]`. `honouredDepth` counts only LIVE certs with
`expiry ≥ minExpiry`, `remaining > 0`, honourable maker (revoking allowance removes all of a maker's depth instantly).

## CurbCredit (P4) — fixed-rate reserve, published ltvFor, cure clock, refusals

`constructor(IMarketClock, IScorecardPrice, IDepthCert, IEligibility, IERC20 usdg, address admin, address[] assets)`
(the five priced wrappers). Constants `LTV_OPEN_BPS = 6000`, `LTV_SHUT_BPS = 3000`, `APR_BPS = 500` (simple),
`STALE_BONUS_BPS = 500`, `CURE_OPEN_SECONDS = 30 min`, `MAX_TICK_GAP = 10 min`, `MIN_CERT_LIFE = 1 h`.
State: `Position{collateral, principal, accrued, lastAccrual}`, `Cure{active, lastOpen, openedAt, lastTickAt,
openSecondsUsed, priceAtBreach}`, `totalCollateral[a]`, `totalPrincipal[a]`, `seized[a]`.
Views: `ltvFor(a)`, `realisable(a)`, `debtOf(b,a)`, `limitOf(b,a)`, `isBreached(b,a) → (bool known, bool breached)`, `cureOf(b,a)`.
Reserve: `fund(amt)`; `defund(amt, to)` (admin). Positions: `deposit(a, s)` (reverts if ineligible); `withdraw(a, s) → bool`;
`borrow(a, amt) → bool`; `repay(b, a, amt)` (anyone). Breach: `flagBreach(b,a)`, `tick(b,a)`, `liquidate(b,a)` (permissionless).
Admin: `realise(certId, shares)` (hits a cert naming CurbCredit, seized shares only); `sweepSeized(a, s, to)`; two-step admin.
Events `Funded`, `Defunded`, `Deposited`, `Withdrawn`, `Borrowed(b, a, amt, debtAfter, ltvBps)`, `Repaid`,
**`Refusal(address indexed who, address indexed asset, bytes4 indexed reason, uint256 requested, uint256 allowed)`**,
`BreachOpened(b, a, debt, limit, priceAtBreach, ltvBps)`, `CureTicked(b, a, open, used, required)`, `BreachCured`,
`Liquidated(b, a, seized, cleared, badDebt, pFresh, pBreach)`, `Realised(certId, shares, filled, usdgIn)`.
Refusal reasons = error selectors: `Ineligible`, `UnsupportedAsset`, `MarketUnknown`, `PriceUnavailable`, `NoDepth`,
`ExceedsLtv`, `ExceedsDepth`, `ReserveShort`, `InCure`, `WouldBreach`. **`borrow`/`withdraw` don't revert on refusal:
they emit `Refusal`, return false, change nothing** (a refusal leaves an on-chain trace in a succeeding tx).

LTV (published, monotonic):
```
regimeCap = UNKNOWN → 0 ; primaryCapNow>0 → 6000 ; CLOSED → 3000
(dS,,minBid,) = depth.honouredDepth(a, address(this), now + 1h)     // certs expiring <1h don't count
basis   = totalCollateral[a] > 0 ? totalCollateral[a] : dS ;  covered = min(basis, dS)
ltvFor  = 0 if UNKNOWN ∨ dS==0 ∨ priceNow reverts
        = min(regimeCap, mulDiv(covered·1e4, minBid·1e12, basis·P))
realisable(a) = notional(min(totalCollateral[a], dS), minBid)
limit(b,a)    = valueUsdg(coll, P) · ltvFor / 1e4
```
Invariant: `ltvFor · valueUsdg(totalColl, P) ≤ realisable · 1e4 (+1)`.
`borrow` succeeds iff eligible, asset known & priced, `ltv > 0`, `debt + x ≤ limit`, `totalPrincipal + x ≤ realisable`,
`x ≤ reserve`, no active cure. Interest: `debt = principal + accrued + mulDiv(principal, APR·Δt, 365d·1e4)`; repay pays accrued first.
Cure: `flagBreach` requires `known && breached`, records `priceAtBreach`. `tick`: `used += Δt` only if the market was
open at the last tick **and** is open now **and** `Δt ≤ 600` (unwitnessed time never counts); UNKNOWN/shut freezes it.
Clears only when `known && !breached` (a stale clock never cures or creates a breach).
Liquidation: cure active, `used ≥ 1800`, market open now, breach known, `P_fresh` readable.
`seize = min(coll, sharesFor(debt, P_fresh), sharesFor(debt·10500/1e4, P_breach))`; `cleared = min(debt, valueUsdg(seize, P_fresh))`;
`badDebt = debt − cleared`; debt → 0, borrower keeps `coll − seize` (never more lost than a 5%-bonus liquidation at the
breach-time price, and never while shut).

## Cut / deferred (record as D-12)

RefutationBond (needs a judge; rows already falsifiable off-chain) · CurbMark AggregatorV3 (nothing consumes it) ·
cash settlement / caType-aware delivery (physical wrapper-share delivery is multiplier-independent) · Data Streams
adapter · DepthCert EIP-712 quotes, two-sided depth, bands, ERC-6909, fee share · standalone BreachClock (folded) ·
ConsentRegistry, utilisation curve, auto-liquidation into certs · keeper patch to poke observe/recordPrint (operator
`script/w3/poke.sh` for now) · wXIAOx/wMEITx notes.

## Tests

Unit (mocks in `test/mocks`), fork (`vm.createSelectFork("xlayer")`, prank host A to `attest`, fund USDG by pranking the pool).
- Pointer: first open → no epoch; shut→open → epoch 1 with bracket; repeated opens don't advance; UNKNOWN no-op;
  open/shut/open → epoch 2; recordPrint too early/late/shut/twice/unknown epoch/price revert; fuzz increasing timestamps.
- Note: mint refusals (open, UNKNOWN, blackout, unsupported, over cap, zero); escrow + unit fields; redeem before reopen
  reverts; partial/full after; 10-day fallback; rate/nonce change still delivers exactly `amount`; cancel rules; ERC-1155
  receiver check; OI decrements.
- Auction + registry: list preconditions; `priceAt` linear then flat (fuzz non-increasing); single clear; second bid reverts;
  bid after endAt / open / UNKNOWN / epoch advanced / over max / ineligible reverts; seller delta = price; unsolicited 1155
  rejected; withdraw; realisedDiscountBps; registry two-step admin.
- DepthCert: post validation; fill accounting; fades (revoked allowance, short balance, frozen maker, false-returning token);
  taker without shares reverts; **fuzz gas passed to `take`: an able maker never fades**; beneficiary gating; expiry;
  withdraw rules; honouredDepth filters; book limit + prune.
- Credit: table-driven `ltvFor`; every refusal emits `Refusal` and changes no state; interest; `tick` only open→open ≤600 s;
  frozen when shut/UNKNOWN; cure clears on repay/deposit; liquidate blocked before 1800 open-s and while shut; seizure
  with each of the three limits binding; bad debt; `realise` fill and fade.
- Fork: `test/fork/W3Cycle.t.sol` (mint → list → bid → attest MARKET → observe → +300 → recordPrint on the live pool → redeem;
  negatives: bid after reopen, wSHEINx note); `test/fork/DepthCertFork.t.sol` (**measure real USDG transferFrom gas, assert
  < TRANSFER_GAS/2**, then a real fade); `test/fork/W4CreditFork.t.sol` (live price + attested regime; borrow; regime flip
  breaches; cure clock freezes).
- Builder Code: each owner adds one test per contract calling every new entry point with the ERC-8021 suffix
  `0x6464377535306e636b74356537323966100080218021802180218021802180218021` appended → identical result.
- Invariants (StdInvariant, bounded handlers, output to `artifacts/w5/invariants.txt`):
  NoteInvariant (P1): delivered + cancelled + outstanding = wrapperShares per note under random rate/nonce changes;
  note's wrapper balance = Σ outstanding; epoch never decreases; `shutSeenAt < openedAt ≤ next shutSeenAt`; prints write-once;
  every successful bid while shut in the unchanged epoch; every redeem unlocked; cleared ∈ [floor, start]; each lot sells ≤ once.
  DepthCertInvariant (P3): USDG balance = totalBonds; wrapper balance = Σ claimable; committed = Σ notional(remaining);
  no fade while the maker was able (ghost records maker state before each call, random gas); remaining never increases;
  no bond leaves before expiry except by a fade.
  CreditInvariant (P4): `ltvFor·collValue ≤ realisable·1e4`; at every borrow `totalPrincipal ≤ realisable`; seizure ≤ stale cap
  and none while shut; cure clock doesn't move across a shut tick; conservation (collateral balance = totalCollateral + seized).

## Deploy

`--account curb-deployer --sender 0x78a5955b433988198bccA2E8bdC671444798f809 --password-file ~/.foundry/curb-secrets/<deployer file>`
(never printed). Dry run, then `--broadcast --verify --verifier sourcify`; fallback `forge verify-contract <addr>
src/X.sol:X --chain 196 --verifier sourcify`.
1. `script/DeployW3.s.sol` (env `DESK`, `AGENTIC`): EligibilityRegistry(deployer) + `setEligible(DESK/AGENTIC, true,
   keccak256("team:curb-desk"|"team:agentic"))`; ReopenPointer(CLOCK, SCORECARD); ReopenNote(CLOCK, pointer, SCORECARD,
   [wTCENTx, wNVDAx, wAAPLx], [175e18, 220e18, 14e18], "https://api.curb.markets/v1/notes/{id}.json"); ClosedAuction(note,
   pointer, CLOCK, SCORECARD, USDG, registry); `pointer.observe(wTCENTx)`. Read back caps, wiring, eligibility, head, code.
2. `script/DeployW4.s.sol` (env `REGISTRY`): DepthCert(USDG); CurbCredit(CLOCK, SCORECARD, depthCert, REGISTRY, USDG,
   deployer, [five priced wrappers]).

## Packages (worktree per package; files disjoint; nobody edits MarketClock/Scorecard/existing tests)

| | owns | consumes | done by (UTC) |
|---|---|---|---|
| P0 | `src/interfaces/*`, `src/lib/SafeTransfer.sol`, `src/lib/ERC1155Min.sol`, `test/mocks/{MockERC20,MockWrapper4626,MockClock,MockScorecardPrice}.sol` | — | 24 Sep 14:00 |
| P1 | `src/ReopenPointer.sol`, `src/ReopenNote.sol`, `test/ReopenPointer.t.sol`, `test/ReopenNote.t.sol`, `test/invariant/NoteInvariant.t.sol` | P0 | unit 19:00 · invariants 23:30 |
| P2 | `src/ClosedAuction.sol`, `src/EligibilityRegistry.sol`, their tests, `test/mocks/{MockPointer,MockNote}.sol`, `test/fork/W3Cycle.t.sol`, `script/DeployW3.s.sol`, `script/w3/poke.sh` | P0 interfaces | unit 18:00 · fork 22:00 · dry-run 23:00 |
| P3 | `src/DepthCert.sol`, `test/DepthCert.t.sol`, `test/fork/DepthCertFork.t.sol`, `test/invariant/DepthCertInvariant.t.sol` | P0 | unit 20:00 · fork 23:00 · inv 03:00 |
| P4 | `src/CurbCredit.sol`, `test/CurbCredit.t.sol`, `test/mocks/MockDepthCert.sol`, `test/fork/W4CreditFork.t.sol`, `test/invariant/CreditInvariant.t.sol`, `script/DeployW4.s.sol`, `script/w4/tick.sh` | P0 | unit 01:00 · real DepthCert 03:00 · fork+script 05:00 |

Merge gate: `forge build && forge test --no-match-path 'test/fork/*'`. The lead runs fork suites before each deploy.

## Live demo (team wallets only, disclosed first; ~$38)

K = `curb-desk` (new keystore EOA; note seller, cert maker, reserve funder) · A = Agentic Wallet (buyer, taker, borrower) ·
D = deployer (admin). K's txs carry the Builder Code (`cast calldata … ‖ SUFFIX`).
Cycle 1 overnight (W3 by 00:40): K mint 0.1 wTCENTx → list(5_600_000 → 5_430_000, decay 1200, end 01:25) → A bid →
01:30:05 observe → 01:35:10 recordPrint → A redeem → read realisedDiscountBps. Cycle 2 recess 03:56: roles reversed.
Optional cycle 3 07:56 into the weekend. W4 (by 06:30): K fund 3 USDG; A deposit 0.05 wTCENTx; borrow → Refusal(NoDepth);
K post(wTCENTx, credit, 0.028e18, 52e6, now+26h, 1e6) → ltvFor 0 → ~52%; A borrow 1.4 USDG; 07:55 cut → LTV 30% → flagBreach;
cure frozen all weekend. US contrast (14:00–23:00): wNVDAx borrow; short cert expires; flagBreach; tick every 5 min; clock
runs; liquidate after 30 open-min. Fade (~20:00): K post + revoke allowance; A take → Faded, bond to A.

## Risks

No poke at the reopen (print late; delivery unaffected; poke.sh + self-witnessing redeem/bid) · recordPrint refused on a
>50-tick TWAP deviation (retry in window) · MarketClock stale → everything refuses, cure freezes · Agentic Wallet policy may
block calls to new contracts (fallback: second disclosed keystore wallet) · USDG gas under the stipend (fork measures first) ·
immutability (parameterised scripts, fork dry-runs) · stack-too-deep in legacy codegen (small events, memory structs).

## Demo amendments after the pre-deploy reviews (24 Sep, ~16:30Z)

- **Auction cutoff.** A lot must end by `clock.stateOf(w).nextTransitionAt` at list time.
  - Overnight lots end by **01:00Z (09:00 HKT)**, before HKEX's pre-open auction. So cycle 1 lists at about 00:40Z and ends by 01:00Z.
  - Lunch lots must be listed **after 04:00Z (12:00 HKT)**; before that the boundary is 12:00 itself. They end by 05:00Z.
- **Per-closure cap.** `mintedInEpoch[w][epoch]` replaces the lifetime open-interest check.
- **DepthCert.**
  - Every cert is at least 1 USDG notional.
  - Anyone can withdraw an expired cert; the bond goes to the maker.
  - `committed()` ignores expired certs.
  - Cert lists are capped per maker at 16.
- **CurbCredit.**
  - LTV is per position: `min(regimeCap, minBid/P)`. `realisable` bounds the total lent at borrow time.
  - Bad debt is booked only when every share is seized.
  - While the market is shut, a cert counts only if it expires after now + max(73h, the next transition + 1h) + 30 min.
- **K's wTCENTx cert** (posted while open, before the 07:55Z cut): expiry **Fri 2 Oct 06:00Z**. This keeps the weekend loan supported through Monday's reopen and the 1 Oct holiday.
- **Fade demo** uses **D (the deployer)** as maker, never K. D must first be made eligible (`setEligible(D, true, keccak256("team:deployer"))`). Its cert must be at least 1 USDG, e.g. 0.03e18 @ 52e6.
- **Friday 25 Sep is a normal trading day.** Recess 03:55–05:00Z, afternoon session to 07:55Z. Checked live against the issuer's schedule through curb-asp; the 25 Sep half day in older test fixtures was withdrawn by the issuer on 18 Sep (D-4).
