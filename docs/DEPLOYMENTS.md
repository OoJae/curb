# Deployments

## X Layer mainnet (chain 196) — 13 Sept 2026

| contract | address | source |
|---|---|---|
| **MarketClock** | [`0x160Dc415902971a7a9B5ade7f43005b36FE5B09b`](https://www.oklink.com/xlayer/address/0x160Dc415902971a7a9B5ade7f43005b36FE5B09b) | Sourcify `exact_match` |
| **Scorecard** *(superseded)* | [`0x0527930187a879B3D8704a92734641679567EddD`](https://www.oklink.com/xlayer/address/0x0527930187a879B3D8704a92734641679567EddD) | Sourcify `exact_match` |
| **Scorecard v2** | [`0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f`](https://www.oklink.com/xlayer/address/0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f) | Sourcify `exact_match` — see below |

Deployer / admin `0x78a5955b433988198bccA2E8bdC671444798f809` · attestor `0x4c3eD38809FA6469871F4e0cbEa7ae7dBdA87fb8` ·
keeper `0x4b150c0e37c9BFdb8B1FE4608A5465aE6B9a8669` — **retired 21 Sep**, never sent a transaction, drained to
the live keeper `0xd3D9Bf9Ff2A80Aa13D9C0299fadc9775343a1AF6`; see `docs/WALLETS.md`.
Total cost **0.0000578 OKB**. All 9 transactions `status=1`.

### Verified post-deploy state (read back from chain, not from the script)

- `MarketClock.admin()` = deployer; `isAttestor(attestor)` = true; `isAttestor(deployer)` = false.
- `MarketClock.registeredCount()` = 6, and every registered raw token equals that wrapper's own onchain `asset()`.
- `MarketClock.regime(wTCENTx)` = 0 (`UNKNOWN`) — correct: it fails closed until the first attestation.
- `MarketClock.rawToShares(wAAPLx, 1e18)` = `1003269012539818700`, equal to `AAPLx.multiplier()`.
- `Scorecard.clock()` = MarketClock; `Scorecard.isKeeper(keeper)` = true; `Scorecard.admin()` = deployer.
- Both contracts have a two-step `transferAdmin` / `acceptAdmin` handover.

### Registered cohort

| wrapper | raw | venue | hours mode |
|---|---|---|---|
| wTCENTx `0x41333Df9…9f9E` | `0xfa15e42C…Fe42` | XHKG | Regular |
| wSHEINx `0xff637d2d…b727` | `0x4d0ba049…3Bd6` | XHKG | Regular |
| wXIAOx `0x076CF393…82AE` | `0xfb4f81f5…DFc0` | XHKG | Regular |
| wMEITx `0xad1b65C8…fA97` | `0x0024Af2C…5f86` | XHKG | Regular |
| wNVDAx `0xa8ddb5Cd…50D5` | `0xc845b289…849d` | XNAS | TwentyFourFive |
| wAAPLx `0x943BF64D…De8f` | `0x9d275685…890a` | XNAS | TwentyFourFive |

### Transactions

| block | action | tx |
|---|---|---|
| 70,545,887 | deploy MarketClock | [`0xf07b183b…`](https://www.oklink.com/xlayer/tx/0xf07b183bb2ea147687cf6eac2058f4c48e0825b16963c822bdbd67f5135f4524) |
| 70,545,892 | deploy Scorecard | [`0xb9e217be…`](https://www.oklink.com/xlayer/tx/0xb9e217be351010fc4955d21a91431ddcbf7515b444800f69509bd8f8bc18e1a9) |
| 70,545,896 | setKeeper | [`0xd40bd220…`](https://www.oklink.com/xlayer/tx/0xd40bd220fe284fbeb42a1796eb372f617bba2c831b4a8b7d5b926154628b63c0) |
| 70,545,901 | registerAsset(0x41333Df9…) | [`0x2f608076…`](https://www.oklink.com/xlayer/tx/0x2f608076716e12f9f1618502cedcd69e6364813c4906126eae34c6103fc2eb86) |
| 70,545,905 | registerAsset(0xff637d2d…) | [`0x98419c2e…`](https://www.oklink.com/xlayer/tx/0x98419c2edf1dba4c22c4bb9b58bdb2120c56e0ef853c7b744e9145cc98ce2eeb) |
| 70,545,909 | registerAsset(0x076CF393…) | [`0xd04d6834…`](https://www.oklink.com/xlayer/tx/0xd04d6834c14c308f7408f62bfce3fafe3f4765419c63adf7ad9ae5d1d2aaac3a) |
| 70,545,914 | registerAsset(0xad1b65C8…) | [`0x4b5eaed2…`](https://www.oklink.com/xlayer/tx/0x4b5eaed2d816a44bbefd1bdb9d19e9e261b8313343dbd6660855c7b000f283d2) |
| 70,545,919 | registerAsset(0xa8ddb5Cd…) | [`0x61822596…`](https://www.oklink.com/xlayer/tx/0x618225963d13c3cccd7859dc16cb481cb4ca5e915ba21c090bbdd912ad9e2cf4) |
| 70,545,923 | registerAsset(0x943BF64D…) | [`0x149969af…`](https://www.oklink.com/xlayer/tx/0x149969afcb1bd0e60d83d1c3f0b669c2b287d0d021361d947567d58d2a9c4fda) |

Reproduce: `forge script script/Deploy.s.sol --rpc-url xlayer --account curb-deployer --sender <deployer>`
(without `--broadcast` to simulate). Raw broadcast log: `broadcast/Deploy.s.sol/196/run-latest.json`.

---

## Scorecard v2 — 21 Sept 2026

**`0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f`**, Sourcify `exact_match` (creation and runtime).
Deployed in one script: constructor, `setKeeper`, and five `setPriceSource` calls. 3,727,316 gas,
**0.000149 OKB (~$0.017)**.

The v1 address above is **kept, not deleted**. It never recorded a row, and the reason it was
replaced is part of the record:

> `settle(bytes32 id, uint128 reopenPrint, uint8 source)` was `external` with no keeper gate and no
> validation of the price. Settlement is permissionless *by design* — the record must keep accruing
> if Curb's keeper dies — but v1 let any passer-by grade every row against an invented number, with
> no revision path to undo it. Found by reading the deployed contract before writing a producer for
> it, while zero rows existed.

**v2 `settle(bytes32 id)` takes no price at all.** Nobody, Curb included, supplies the number the
mark is graded against; the contract reads the wrapper's registered pool itself.

### Price sources — pinned, write-once, validated on registration

`setPriceSource` is admin-only and **write-once per wrapper**: an admin who could re-point the oracle
after seeing a mark could choose their own grade.

| wrapper | pool | pair | side | cardinality | `priceNow()` at deploy |
|---|---|---|---|---|---|
| wTCENTx | `0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f` | /USDG f500 | token0 | 32 | 54.597441 |
| wXIAOx | `0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417` | /**USDC** f500 | token0 | 32 | 3.504446 |
| wMEITx | `0x54E89e9acaFb073e7fd8471312E753A661b470C7` | /USDG f500 | token1 | 32 | 9.328504 |
| wNVDAx | `0x2a2B11730C2b6d99a58034A869dd810D7300a7b2` | /USDG f500 | token1 | 256 | 223.772851 |
| wAAPLx | `0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2` | /USDG f500 | token1 | 256 | 338.063874 |
| **wSHEINx** | *none* | — | — | **1** | reverts `NoPriceSource` |

Pools are **pinned constants, not discovered at runtime**. A full sweep of 6 wrappers × 3 stables ×
4 fee tiers on 21 Sep found 17 pools: 11 hold zero liquidity, one (`wAAPLx/USDC`) was never
initialised, and `wMEITx/USDG` at the 1% tier quotes **6.1% away** from the real book on a stale
print with no trades in 11 hours. `getPool()` would have picked it.

### Three measured findings that changed the contract before it was deployed

1. **`observe()` on a cardinality-1 pool returns spot, successfully.** With one stored observation
   the pool extrapolates it forward at the *current* tick, so the "average" is arithmetically equal
   to spot with zero smoothing — and `observe()` does not fail to tell you. Verified live: every
   cardinality-1 pool returned a tick deviation of exactly **+0** at both 300s and 1800s. A guard
   comparing spot to that TWAP compares spot with itself, forever. v2 therefore requires
   `observationCardinality >= MIN_OBSERVATION_CARDINALITY (32)` at registration, which is why
   **wSHEINx has no price source**: its only live pool is cardinality 1. It gets one when that pool's
   cardinality is raised and has filled — not before.
2. **The guard window must close before settlement opens.** v2 originally averaged the 5 minutes
   *ending at* settlement, which reached back across the reopen itself. A genuine overnight gap would
   then read as manipulation and revert — so the closures with the biggest gaps, the ones the whole
   record exists to show, would have been the only ones that could never be settled. `setPriceSource`
   now enforces `twapWindow < SETTLE_DELAY`; registered at **120s**, so at `settleAfter + 300` the
   averaged window covers reopen+180 … reopen+300, wholly after the market came back.
3. **A cardinality-1 pool's `observe()` also reverts `OLD` non-deterministically** — its lookback is
   only as long as the time since the last trade. Demonstrated live on the wSHEINx pool inside 12
   minutes: `observe([0,1800])` succeeded at 13:48Z (last write 7,329s earlier) and reverted at
   14:02Z (last write 600s earlier). A settlement depending on it would fail precisely when someone
   was trading against it.

Counter-intuitively the quiet Hong Kong pools are the **better**-provisioned oracles: 32 slots on a
thin book retain 6–47 hours of history, while 256 slots on wNVDAx/wAAPLx retain under 2 hours because
they trade every ~25 seconds.

### Verified post-deploy state (read back from chain)

- `admin()` = deployer, `clock()` = MarketClock, `isKeeper(0xd3D9…1AF6)` = true.
- `SETTLE_DELAY()` = 300, `SETTLE_WINDOW()` = 6h, `MIN_OBSERVATION_CARDINALITY()` = 32.
- Five `priceNow()` values as tabled above; `priceNow(wSHEINx)` reverts `NoPriceSource`.
- Every pinned pool independently re-checked for token side, non-zero liquidity and cardinality
  before the script ran.

## The archive — `archive.curb.markets`, 22 Sept 2026

Domain `curb.markets` registered at Cloudflare Registrar (registry Identity Digital); RDAP returned
404 on 21 Sept and 200 on 22 Sept. Zone delegated to `ezra`/`penny.ns.cloudflare.com`.

R2 bucket **`curb-archive`**, Asia-Pacific, Standard class (the free tier covers Standard only).
S3 endpoint `https://e38cb9baf5a71676deda49343e9d53d3.r2.cloudflarestorage.com/curb-archive`.
The account id in that hostname is not a secret; it appears in every dashboard URL.

| setting | value | verified from outside |
|---|---|---|
| custom domain | `archive.curb.markets`, Active | `curl -I` → **404 from the bucket** (not NXDOMAIN, not 522), `cf-ray …-SIN` |
| public r2.dev URL | **disabled** | — |
| bucket lock `lock-rounds` | prefix `rounds/`, **indefinite** | read back from a fresh page load |
| bucket lock `lock-marks` | prefix `marks/`, **indefinite** | read back from a fresh page load |
| bucket lock `lock-witness` | prefix `witness/` (covers `witness/tx/`), **indefinite** | read back from a fresh page load |
| `index/` | deliberately **unlocked** — rebuildable convenience, rewritten | — |
| CORS | `*` may `GET`/`HEAD`; max-age 86400 | preflight `GET` → 204 with `allow-origin: *`; preflight `PUT` → **403** |

**What the lock does and does not protect against.** A lock rule blocks both deletion *and*
overwriting of any object under its prefix. The rule itself can be removed by the account owner, so
this is not protection against the owner; it is protection against a leaked **object-level** API
token, which has no permission to change bucket configuration. That is the threat model: a
compromised host must not be able to rewrite the record.

**Cache headers are set per object, not by a zone rule.** Evidence objects are immutable and get
`public, max-age=31536000, immutable`; the index is rewritten and must not. A zone-wide cache rule
on the hostname would make the index immutable too, so the publisher sets `Cache-Control` on each PUT.

### Publisher live — 24 Sept 2026 20:32Z

Three **Account API tokens**, one per writer, each **Object Read & Write on `curb-archive` only** (no bucket
configuration, so none can lift a lock): `curb-archive-a` (host A), `curb-archive-b` (host B),
`curb-archive-keeper`. Created in the dashboard and written straight to where they are used: Railway variables on
`attestor-a` (kept by `preserve()` in `.railway/railway.ts`), and root-owned `0600` files
`/etc/curb/attestor-b.r2.env` and `/etc/curb/keeper.r2.env` on the VPS. The Mac keeps a `0600` copy in
`~/.foundry/curb-secrets/` for the backfill. No value was printed or committed.

| writer | deployed | `/healthz` `archive` after the deploy |
|---|---|---|
| host A (`railway up services/attestor`, deployment `016bc550`) | 20:28Z | `enabled: true`, first object `rounds/0x0d42afa2…5374.json` published in the first minute, `failed: 0` |
| host B (`script/hostb/deploy.sh`) | 20:33Z | `enabled: true`, `armed: true`, standby |
| keeper (same script, `KEEPER_MODE=live`) | 20:33Z | `enabled: true`, `mode: live` |

`https://archive.curb.markets/rounds/0x0d42afa253ba138690564fa19f3ab0dc6a6d2f0e9d80b7df2af8849581da5374.json`
→ **200**. Everything written before 20:32Z is filled by `tools/archive/backfill.ts`, which checks each object
against the chain (`curb-verify tx`'s own pipeline) before it uploads it; log in `artifacts/archive/`.

**A superseded token.** A first token, `curb-archive-host-a`, was created on 24 Sep ~14:00Z. Its value was
exposed in an automation log while the dashboard was being read, so it was never used; it had the same
object-only scope on this one bucket. **Deleted by the user in the dashboard, 24 Sep ~22:30Z** (the dashboard
refuses deletes from automation).

## X Layer Builder Code — `dd7u50nckt5e729f`, 24 Sept 2026

Minted from the OKX developer portal by `0xacaf…e490`: tx
[`0xc3315eb4…051b`](https://www.oklink.com/xlayer/tx/0xc3315eb4785c394567ee74e86ee6210443bb0ea80fac8564d15a4598482f051b),
block 71,444,945, status 1, 110,651 gas. Registry (ERC-721 "Builder Codes" / `BUILDERCODE`):
mainnet `0xd6c426f9c077358735622ae5a83468dc0510823b`; testnet `0x33907e98d7392d95212b05ab03f091e02d7815bf`.

ERC-8021 **schema 0**, per OKX's own integration guide (no registry address or chain id embedded).
The suffix is a 34-byte constant, derived with OKX's `ox@1.7.5` `Attribution.toDataSuffix` and
checked byte-for-byte against the hand formula `utf8(code) ‖ 0x10 ‖ 0x00 ‖ 0x8021×8`:

```
0x6464377535306e636b74356537323966100080218021802180218021802180218021
```

It round-trips through `Attribution.fromData` to `{codes: ["dd7u50nckt5e729f"], id: 0}`. **Not yet
attached to any Curb transaction.** It goes inside `Sender.prepare()` before the `eth_call`
simulation, after one mainnet `eth_call` confirms the target functions ignore trailing calldata.
Attribution is visible on OKLink next to each transaction hash.

## `curb-asp` — the paid API at `https://api.curb.markets`, 24 Sept 2026

Railway service `curb-asp` (region `sin`, volume `asp-data` at `/data`), deployed by upload from
`services/asp` with its own Dockerfile. Custom domain attached with `railway domain` (Railway's config
file cannot register one) behind a **DNS-only** Cloudflare CNAME `api → i9sejppz.up.railway.app`, plus
the TXT ownership record `_railway-verify.api`. Never proxied: a proxy may cache or rewrite a 402.

Payments settle through OKX's own Broker with the team's Onchain OS API key; the three credentials were
piped into Railway from `~/.foundry/curb-secrets/okx-api.env` and never typed into a command. Receives
to the receive-only `curb-revenue` wallet `0x277cA91276A3801667B76C97Da3872Ccb6E96068`.

Verified live from outside, 24 Sept 07:1xZ:

| check | result |
|---|---|
| `/healthz` | `ok: true`, **`payments.ready: true`** (Broker handshake with the real key succeeded), cohort 6, Scorecard 15 rows, RegimeChanged index caught up (278 transitions since block 70,617,365) |
| unpaid `GET /v1/closure-calendar` | **402**, x402 v2, `exact`, `eip155:196`, USDT0, `amount 10000` ($0.01), `payTo` curb-revenue, with a truthful preview (wTCENTx open; next closure 07:55Z → 01:30Z, 17.6 h) |
| unpaid `/v1/accuracy-record`, `/v1/discount-curve` | **402**, `50000` ($0.05) and `100000` ($0.10) |
| `/`, `/v1/assets`, `/.well-known/x402` | 200 |

### Listed on the OKX AI marketplace — agent #13869, 24 Sept 2026

Registered with `onchainos` 4.6.2 from the team's Agentic Wallet `0x055b…7105` (see `docs/WALLETS.md`)
in [`0xe2420407…ccc7`](https://www.oklink.com/xlayer/tx/0xe2420407a65b51a468f060a52496e15587ce13d1c23fccff30330d8ab293ccc7),
then submitted for listing review (`submitApproval.success: true`, under review). The exact text
submitted is `script/asp/agent-description.txt` and `script/asp/services.json`; the avatar is
`script/asp/curb-avatar.png`. Three A2MCP services: Closure Calendar ($0.01), Reopen Price Accuracy
Record ($0.05), Closure Discount by Duration ($0.10). No subscription and no free trial: A2MCP
forbids both.

Before submitting, four independent reviewers checked each claim in the text against the live endpoints
and the code. They found one blocker in the service and two claims the data did not support:

- **OKX's endpoint self-check is `curl -i -X POST <endpoint>` with no parameters, and expects 402.** The
  API answered 405 to any POST, and 400 to a bare calendar GET (`missing-symbol`). Fixed and redeployed:
  a priced route now answers POST exactly as GET, with parameters from the query string, a flat JSON body
  or a form body (the same name in two places with different values is a free 400); the calendar's
  `symbol` defaults to wTCENTx; an empty `horizonDays=` means the default, as on the other routes.
  Verified live: a bare POST to all three priced paths returns 402 with the challenge, and
  `onchainos payment quote` on each bare URL decodes it as supported, paying curb-revenue.
- **"Closing VWAP" was the last pool price in all 15 settled rows**: nothing traded in the 15 minutes
  before any cut, so the keeper committed the last print as the baseline, and the chain cannot tell the
  two apart. The listing and the route's own description now say "the pre-close price (the 15-minute
  closing VWAP, or the last pool price when nothing traded)".
- **"A mark before every reopen" overstated coverage**: wSHEINx has no price source and closures shorter
  than 30 minutes are skipped. The agent description now says "the closures it has graded".

### The first paid call — end to end through OKX's own buyer CLI, 24 Sept 2026 11:56Z

A **team** wallet paying the team, disclosed as such (`docs/WALLETS.md`): it proves the rail, not demand.

1. The team withdrew 0.01 OKB from its OKX exchange account to the Agentic Wallet `0x055b…7105`, which
   swapped 0.009 OKB → 1.061866 USDT0 through OKX's DEX aggregator (Uniswap V3, 0.04% impact) in
   [`0x60d93474…8283`](https://www.oklink.com/xlayer/tx/0x60d93474f738158a87bfff9c2018dfcd7065f9b6c70c270b0e0a7bc8145e8283),
   block 71,481,865. The wallet paid no gas for it.
2. `onchainos payment quote` on `/v1/closure-calendar?symbol=wTCENTx&horizonDays=7` → `payment pay`: the
   Agentic Wallet signed an EIP-3009 authorization in OKX's TEE, the CLI replayed the request, and the
   API answered **200** with the paid calendar (9 windows) after the OKX Broker settled.
3. Settlement [`0xe8740458…4de7`](https://www.oklink.com/xlayer/tx/0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7),
   block 71,481,945, status 1: **10000 USD₮0 units ($0.01) from `0x055b…7105` to curb-revenue
   `0x277c…6068`**, submitted by OKX's relayer `0xde95…0591`, with the token's `AuthorizationUsed` event.
4. Receipt [`/receipts/0xcee1ee75…817c.json`](https://api.curb.markets/receipts/0xcee1ee75f7323746b96afa5f4056640507a96d02316ba40f9010ac2d58a9817c.json),
   served immutable. Its id is `keccak256(transaction ‖ responseDigest)`, and `responseDigest` is the
   sha256 of the exact 2,256 bytes delivered. Checked independently: the answer the buyer received,
   serialised in the server's key order, hashes to that digest.

**A finding about OKX's CLI, for anyone checking a receipt:** `onchainos payment pay` prints the paid
answer re-serialised with its keys sorted, so its output is not the bytes the server sent, and hashing it
does not reproduce `responseDigest`. The receipt binds the exact bytes on the wire; a buyer that wants to
check it must keep the raw response body (or restore the server's key order, as above).

## W3 — ReopenPointer, ReopenNote, ClosedAuction, EligibilityRegistry — 24 Sept 2026 ~18:00Z

Deployed from `curb-deployer` with `script/DeployW3.s.sol` (`DESK`/`AGENTIC` = the two disclosed team
wallets). Every contract is verified **Sourcify `exact_match`** (solc 0.8.28, prague, 200 runs). None of the
four has an upgrade path; only the registry has an admin (the deployer), and it can only allowlist
addresses.

| contract | address | tx | block |
|---|---|---|---|
| EligibilityRegistry | `0xd7251b562eD07374ccD2436a7EfC0bA3A28ce938` | `0xbcfa3232843a3f9ab72527027b32ebea8269028f1aaf0fff5db6e89746ae2918` | 71,503,708 |
| setEligible(curb-desk) | — | `0xac68b06045aeee1856adabbace31b08e6aaa4dc2c52274ed29cbed0b9a2bb65f` | 71,503,711 |
| setEligible(Agentic Wallet) | — | `0xc87a92c1b8dc84daa7d82a3a3a47090e76f2db6a96b2d16d424bd6807e370370` | 71,503,714 |
| ReopenPointer | `0x85AB0FebdFa7201E65eA01bd3e4CC6F9c0Ac4471` | `0x5932cfa10a7cf35ffac945c1585367a9ed74f88e8a7055c11675b09cade5ac57` | 71,503,717 |
| ReopenNote (CURB-RN) | `0x7B2AcB0Db3316f7B8cf1B287796a2273871F011B` | `0xf7b5a5c2b009605692cc9a71b51260302b6e865da56db18e144a7616a71ea567` | 71,503,720 |
| ClosedAuction | `0xAc74864d69DdB940ADfDB39E69751759a32bb80D` | `0x88dffc00aac47f6e099fcad1b5278793bd7968dd0109e241f07d54a4ca640af3` | 71,503,723 |
| first `observe(wTCENTx)` (shut) | — | `0x425cafd15dc74f55a77ea9032c819db54ea6ecab67e1e7709f8e0feb89837e1a` | 71,503,726 |

Note caps (immutable, from D-3): wTCENTx 175e18, wNVDAx 220e18, wAAPLx 14e18 wrapper shares per closure.

**Before deploy, two adversarial reviews** (correctness, security/griefing, economics; every finding
independently re-verified) changed the code:
- A per-closure open-interest cap, so notes that unlocked but were never redeemed can't block later closures.
- `redeem` to the note contract itself is refused.
- Lots end by MarketClock's attested next transition (`NoCutoff` / `SpansTransition`). The pointer only
  counts *witnessed* reopens, and a session nobody observed could otherwise have allowed a bid made with
  hindsight. This also keeps overnight lots clear of HKEX's 09:00 pre-open auction.

### Oracle depth for the Hong Kong pools — 24 Sept 2026

The review also found that the wTCENTx pool's TWAP ring held only 32 observations against Scorecard's
120-second window. For well under $1 of dust mints, anyone could make `priceNow` unreadable and so block a
reopen print, or a Scorecard settlement. The deployer called the permissionless
`increaseObservationCardinalityNext(256)` on all three pools (with the Builder Code suffix):

| pool | tx | block | gas |
|---|---|---|---|
| wTCENTx/USDG `0xC89d…992f` | `0xec2a0c5ae2e9601be8e83e126583fdec1b008d3aaf4cf372f27a2735edc7cc07` | 71,503,966 | 5,010,748 |
| wXIAOx `0xdc7f…8417` | `0x25ab8c7c6489e889a9482787dcb98ab8f63eebfcf8c89e6943790020193c9379` | 71,503,972 | 5,010,748 |
| wMEITx `0x54E8…70C7` | `0x210dc4c8b91a97e66dade3f1f7582844f3818bf8284c8f95849b06e704a80056` | 71,503,979 | 5,010,748 |

The ring grows to 256 as trading writes observations into it. Once it exceeds 120, the attack can't
succeed, because the pool writes at most one observation per second.

## W4 — DepthCert, CurbCredit and the maker allowlist — 24 Sept 2026 ~19:15Z

Deployed from `curb-deployer` with `script/DeployW4.s.sol` (`REGISTRY` = the W3 borrower registry). All
three are verified **Sourcify `exact_match`**.

| contract | address | tx | block |
|---|---|---|---|
| EligibilityRegistry (makers) | `0xbA1aB5027e826D564EA913b3f7acb95Fd651758E` | `0xe41c715c4710c04601a50a04c4640e4f86b05846acb6ccff0ed12aa65b8b4393` | 71,507,846 |
| setEligible(curb-desk) (maker) | — | `0x385dcc285ed63a0f5577057b5a8164cd2dc20224880cc065803abf6cdb43573e` | 71,507,852 |
| setEligible(deployer) (maker) | — | `0x3e5f88a6cdf389fe37443c28ebab011b58a7ea6d5ffb0ba4e2cc1ca0b38652f9` | 71,507,854 |
| DepthCert | `0x702b1a988765f85162F4829175EF4232197e9C6D` | `0x0b1d619895c378e2288100684c6a2359885f997b5a7f497175c44c5f0ca3fd0f` | 71,507,861 |
| CurbCredit | `0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339` | `0x8ad640d0ed4a9e07d47bb532f59c153621c6714c427c1ceb382def061a868543` | 71,507,867 |

**Makers and borrowers are on separate allowlists.** A maker's bid sets every borrower's LTV, so a borrower
must never be able to post one. The maker registry holds only curb-desk and the deployer.

**Three adversarial review rounds changed the design before deploy.** Each finding was independently
verified with a PoC, then fixed and regression-tested.

**DepthCert**
- An expired but unwithdrawn cert no longer counts toward a maker's commitments, and anyone can withdraw
  one once it has expired.
- Open books are uncapped.
- The minimum notional is 1 USDG, and no fill can leave an unfillable dust remainder.
- A maker naming a beneficiary must be on the maker allowlist.

**CurbCredit**
- Bad debt is booked only when every share has been seized. A partial liquidation reduces the debt and
  leaves the rest owed.
- LTV is per position: `min(regimeCap, minBid/P)`, scaled down when the honoured book no longer covers
  everything lent. Idle collateral can't push anyone else into breach.
- A cert counts only if it outlives the next closure plus a full 30-minute cure. The horizon depends on
  the asset's hours mode, so a 24/5 name's routine session changes don't margin-call its loans.
- Every fallback read fails closed when starved of gas, so a starved `tick` can't bank cure time.
- `borrow` and `withdraw` refuse inside a successful transaction and emit `Refusal`.

Tests on main at deploy: **301/301**, plus fork suites against live mainnet state and the invariant runs
recorded in `artifacts/w5/`.

## Live demo on mainnet — team wallets only, 24–25 Sept 2026

Every counterparty below is a Curb team wallet (K = curb-desk `0xe1df…9A3E`, a Foundry keystore; A = the team's
OKX Agentic Wallet `0x055b…7105`; D = the deployer). Funding and every transfer between them is in
[`WALLETS.md`](WALLETS.md). This is a demonstration of the mechanism, not usage.

**Attribution on A's transactions.** The Agentic Wallet is an ERC-4337 account: OKX's bundler sends
`handleOps` to the EntryPoint, and the Builder Code suffix sits inside A's inner call (for example byte 780 of
1,061 in the bid), not at the end of the outer transaction. An explorer that reads only the outer calldata will
not show the attribution for A's rows. K's and D's transactions end in the suffix.

### W3 cycle 1 — overnight 24→25 Sept (HK shut 08:00Z → 01:30Z)

| step | who | tx | block |
|---|---|---|---|
| approve 0.1 wTCENTx to ReopenNote | K | `0xa41ec8e3cf54901dfce11e8ebec645b268c8e3442cd6b9b8f9ef59626398c4e9` | 71,508,611 |
| mint note 1 (0.1 wTCENTx escrowed) | K | `0xcf3dfa55bc02bf0cec35422cc3561a98e7bb79bb779d13c27f51f3df277a1c40` | 71,508,619 |
| setApprovalForAll(ClosedAuction) | K | `0x56b91d1fe476aae48c7a0c755d8de6fd49be2774863d8870c87e037d30d9d072` | 71,508,670 |
| list lot 1: 5.60 → 5.43 USDG, ends 01:00Z (09:00 HKT) | K | `0xaa7f91690bbba12d9291461545dc8a5a3f7c7a169076ec4ff5e7f1212f3af660` | 71,508,704 |
| approve 5.60 USDG to ClosedAuction | A | `0xad701253198a9f9a6796a7c1d0a02d4bb692def4d37f57c9a98ce6d6ae068e44` | 71,508,743 |
| bid: lot 1 sold to A at **5.595137 USDG** (03:24:03 HKT), 35 bp under the reference | A | `0xf23e727c1a37c111e339f480caf15bf67cf2671139f355d11853ec1188cfd3d3` | 71,508,807 |

Still to come: `observe` at the 01:30Z reopen (`script/w3/poke.sh`), A's `redeem` (`script/w3/redeem-after-reopen.sh`),
`recordPrint` at +300 s, then `realisedDiscountBps(1)`.

### W4 — before the reopen, 24 Sept ~21:30Z (HK shut)

| step | who | tx | block |
|---|---|---|---|
| maker-approve USDG to DepthCert (unlimited, a maker's allowance must cover all its live certs) | K | `0x0594a5e45ec693ae3c9c98978d34627a95c7b71f862936c6687d901d022dd306` | 71,516,056 |
| fund the reserve: 3 USDG | K | `0x5e2a8be6bcf09bc1ea8b5f1f948402a2769c8621faae632de9b074edd76a25fa` | 71,516,155 |
| approve exactly 0.05 wTCENTx to CurbCredit | A | `0xd75527290def9c5ac8878b77b54630960c70de5af2edca0c5825890154b04619` | |
| deposit 0.05 wTCENTx | A | `0xeb927854b5580c55350ebda8206cec05a5925cdcb73fdc01e548f4524df65b8b` | |
| borrow 1.4 USDG → **`Refusal(NoDepth)`, requested 1,400,000, allowed 0, in a successful transaction** (nothing moved) | A | `0x8bd873d77176dab81ad860c1496937d2e7535c8a6b91f0be5902936b408b5c7a` | 71,516,369 |

## Builder Code attribution — live on all three writers, 24 Sept 2026

`DATA_SUFFIX` set on host A (Railway variable, then a code upload: one restart), host B and the keeper
(`script/hostb/deploy.sh`, which validates the value on the Mac before copying anything). All three
`/healthz` report `attribution.codes: ["dd7u50nckt5e729f"]`. Host A's first round after the deploy —
[`0x5d3c92ab…605e`](https://www.oklink.com/xlayer/tx/0x5d3c92ab02abb2adbde73babc07a0eed739237f5cd36745c80ba6d123e45605e),
block 71,462,192, 32 s after the deploy finished — carries the suffix; OKX's `ox` decodes its calldata to
`{"codes":["dd7u50nckt5e729f"],"id":0}`, and host B's signed witness for it reads `reproduced: true`.

## Offchain services — Railway project `curb` — 14 Sept 2026

Managed as code in `.railway/railway.ts` (`railway config plan` / `apply`). Region and restart policy below
were **read back from the live deployment manifest**, not assumed — an earlier `railway.json` was silently
ignored for new services.

| service | region | restart | public URL | role |
|---|---|---|---|---|
| `attestor-a` | `sin` (Singapore) | ALWAYS, no deploy overlap | https://attestor-a-production.up.railway.app | Host A for MarketClock. **Live** since 14 Sep 11:46:41Z, signing as `0x842e…eEC4`. |
| `w0-observer` | `sfo` (US West) | ALWAYS | none | W0 evidence: issuer API across HKEX and US boundaries, every 5s in transition windows. |

### Host B: Tencent Cloud Silicon Valley (`Sonar-VPS2`), deployed 14 Sept 2026 13:47Z

Deployed with `script/hostb/deploy.sh`, which is idempotent and touches nothing else on the box.

| container | image | limits | exposure | role |
|---|---|---|---|---|
| `curb-attestor-b` | `curb-attestor` (same source as host A) | 384 MB, 1 CPU, read-only rootfs, all caps dropped, uid 10001 | `127.0.0.1:8091` only | `MODE=standby`: witnesses and EIP-712-signs every MarketClock round, and writes only when the chain shows host A missed. Signs as `0x50Fa…39fB`. |
| `curb-w0-observer` | `curb-w0-observer` | 96 MB, 0.25 CPU | none | Second W0 witness from a different provider and CDN edge. |

Endpoints (on the box for now; public once the domain exists): `/healthz`, `/witness/<inputRoot>.json`,
`/witness/tx/<txHash>.json`.

**Both hosts redeployed 20 Sep 2026 with `derive/3`** (host B 22:21Z, host A 22:22Z — B first, so the
witness understands the new method before the writer emits it). First derive/3 round: block 71,173,967,
tx `0x20dd8be0…`, witnessed reproduced with an agreeing independent reading. See DECISIONS D-9.

**Earlier, both hosts were redeployed 14 Sep 19:15Z** with the fixes from the fourth review round: takeover
starvation, scan-health paging, height-based alarm recency and severity-aware alarm cooldown. Code digest
`sha256:1a1e61b0883038791d0cc4451b67cb43fbd47f4d6919fb34eebbe3deb48c4ec6`. Host A's first round on it is
block 70,644,517 (tx `0x8dde6404…`). Host B witnessed it: `reproduced`, labels consistent, `observation: AGREE`,
witness lag 0 blocks.

**Earlier redeploy, 14 Sep 18:23Z**, on the code that passed three adversarial review rounds (110 tests ×
4 timezones), code digest `sha256:4be6f72542057149ae2bb8d9531ec9c638444d7cf0942de56a3bb91e159bc040`. First round
after the redeploy: host A at block 70,641,273 (tx `0xa2c51100…`). Host B witnessed it: `reproduced: true`,
`labelsConsistent: true`, `observation: AGREE`, evaluated 0.9 s before the write. The EIP-712 signature was
verified off-box and recovers to `0x50Fa…39fB`.

**Verified after the first deploy (13:47Z):**
- It backfilled and witnessed every round since block 70,617,365, and every one reproduced.
- Round 1 is flagged only for its uncommitted label.
- Its independent reading agreed with host A's live rounds.
- No restarts, and 64 MB resident.
- It was not armed at first (`isAttestor=false`, zero balance). **Armed 14 Sep 20:02Z**: enabled by `setAttestor` (block 70,647,127) and funded 0.02 OKB (block 70,647,370). Since then `/healthz` reports `armed: true`.

`attestor-a` endpoints:
- `GET /healthz` — liveness, mode, whether this host's key is a registered attestor, last round.
- `GET /rounds/<inputRoot>.json` — the full evidence bundle for a round, served immutable.

**Verified end to end on 14 Sep 09:05Z:** host A published a shadow round; its bundle was fetched over
HTTPS from a different continent and re-derived with `verifyBundleOffline` under `TZ=Pacific/Kiritimati`,
reproducing root `0x94cca239…c79738` and every claim exactly.

**Pre-go-live dry run (08:08Z):** a live round simulated with `eth_call` `attestBatch` from the registered
attestor succeeded; `eth_estimateGas` 492,319; the same call from an unregistered address reverts
`NotAttestor()`.

### `curb-keeper` — Sonar-VPS2, live 21 Sept 2026 15:17Z

Container `curb-keeper`, `127.0.0.1:8092`, same hardening array as host B: `--restart always`,
read-only rootfs, all capabilities dropped, uid 10001, 384 MB cap, no inbound port off localhost.
Deployed by `script/hostb/deploy.sh`, which now ships three services.

- Key `0xd3D9Bf9Ff2A80Aa13D9C0299fadc9775343a1AF6`, generated **inside the container on the box**,
  encrypted with a password generated on the box. Neither ever left it, and the Mac is not in the
  critical path of a service that has to act at 03:55Z.
- `MODE=live`, `COMMIT_LEAD_S=600`, `COMMIT_FLOOR_S=120`, `SETTLE_DELAY_S=300`, `MIN_CLOSURE_S=1800`.
- `/healthz` reports `armed` only when the chain agrees it is a keeper and it holds gas.
- `/marks/<inputRoot>.json` serves each published evidence bundle, write-once and immutable.

**What it does each 30-second tick:** reads `primaryCapNow` and `stateOf` for all five assets in one
pinned Multicall3; reads every pool's `slot0`; scans Swap logs for all five pools in one paged
`eth_getLogs`; opens a closure when capacity hits zero; accumulates that closure's swaps to disk;
and, ten minutes before capacity is due back, builds the mark bundle, fsyncs it, and calls `commit`.
After the reopen plus `SETTLE_DELAY` it calls `settle(id)`.

**Four rules it will not break, each of which costs rows:**

1. **A stale MarketClock stops everything.** `primaryCapNow` reads zero when an attestation is older
   than 30 minutes — conservative for a lender, but for the keeper it is "we stopped looking", not
   "the market shut". Committing off it would invent a closure. The asset is skipped and paged.
2. **A closure whose start was not witnessed is not marked.** After a restart there is no observed
   last print, and the "mid at the cut" would really be a mid from the middle of the closure.
3. **Closures under `MIN_CLOSURE_S` are not marked.** The issuer ends every period 300 s early, so a
   US name shows a five-minute capacity gap at each session boundary. Real, but empty: the mark would
   equal the last print by construction and `skill()` counts strict wins, so each would be a
   guaranteed tie padding the record.
4. **The commit is frozen and retried byte for byte.** Rebuilding after a lost receipt would change
   `inputRoot`, hence the closure id, and a commit that had actually mined would become a second row
   for the same closure — double-counted forever. A retry either lands the same row or is refused
   `ClosureExists`, which is proof the first one mined.

### Monitoring and paging — healthchecks.io, wired 21 Sept 2026

Ping URLs are the credential (anyone holding one can ping or fail a check), so they live only in
root-owned `0600` files on their host: `/etc/curb/attestor-b.alerts.env`,
`/etc/curb/keeper.alerts.env` and `/etc/curb/w0-observer.alerts.env` on the VPS, and Railway's sealed variables for host A and its observer.
They are not in this repo.

| check | period / grace | pinged by | meaning |
|---|---|---|---|
| `attestor-a` | 5 min / 3 min | host A, on every round | the writer is alive |
| `attestor-b` | 2 min / 3 min | host B, once a minute on a healthy tick | the witness/failover is alive |
| `w0-observer` | 5 min / 2 min | Railway observer, every successful poll | US-West evidence is still being collected |
| `w0-observer-vps` | 5 min / 2 min | VPS observer, every successful poll | the independent second witness is still collecting |
| `keeper` | 5 min / 3 min | `curb-keeper`, on every successful tick (30 s) and on every commit and settle | closure marks are still being published |
| `curb-alarms` | 30 days / 1 day | host B only when something is wrong | the paging channel |

`curb-alarms` never pings on success, so "Never" against its last ping is the healthy state. Host B sends
`/fail` for sev-1 (it wrote a takeover round, a round failed to reproduce, a write came from an address
outside the expected set, the witness loop stalled) and `/log` for sev-2, which records an event without
notifying. An undelivered sev-1 is queued, persisted and retried every tick, so a single failed delivery
cannot lose a page.

Both integrations — **email and Pushover at emergency priority** — are attached to all five checks.
Emergency priority repeats until acknowledged and ignores silent mode.

**Verified 21 Sep:** all four liveness checks pinging within a minute; the `HC_ALARM_URL not set` boot
warning gone from host B; one sev-2 test event accepted by `curb-alarms` (no notification, by design). A
sev-1 test was deliberately NOT fired, since that is the emergency channel.

**Known gap:** Pushover is registered only on the MacBook, so emergency pages do not yet reach a phone.

### MarketClock goes live — 14 Sept 2026

| event | block | UTC | tx |
|---|---|---|---|
| host A enabled (`setAttestor`) | 70,617,176 | 11:43:32 | [`0x982af160…`](https://www.oklink.com/xlayer/tx/0x982af1608c30833a5cefedc9664033dc889162646da5d0f8c57f700fcc96f817) |
| **first attestation ever** (6 assets, gas 487,296) | 70,617,365 | 11:46:41 | [`0x8e87d0f0…`](https://www.oklink.com/xlayer/tx/0x8e87d0f08af4025a742c377dce985449b3b131b3a61e64b0bb793b822fcd47e1) |
| steady-state heartbeats (gas ≈253k, every ≈5.5 min) | 70,617,695 → 70,619,011 | 11:52 → 12:14 | 5 rounds |
| **first `derive/2` round** — cap unit corrected (gas 258,818) | 70,619,137 | 12:16:13 | [`0xaec29e1a…`](https://www.oklink.com/xlayer/tx/0xaec29e1a3dfd80a85581d387b1a0e01ed323cbcaf74440b2298bf6e55e6eb9bd) |

> **Erratum.** Rounds in blocks 70,617,365–70,619,011 wrote the issuer's cap in cents into MarketClock's
> whole-dollar field, overstating primary capacity 100x. Regimes were correct. Fixed from block 70,619,137.
> Full record and re-derivation: `docs/DECISIONS.md` D-7.

**Verified after the fix:** all 7 rounds re-derived from the root in their own calldata, and every claim
reproduced under the method each committed. After the fix, `primaryCapNow(wNVDAx)` = 1,000,000 and
`regime(wNVDAx)` = 3 (EXTENDED). `regime(wTCENTx)` = 1 (CLOSED) and `primaryCapNow(wTCENTx)` = 0.
