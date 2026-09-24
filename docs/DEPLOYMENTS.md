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

**Not yet done, deliberately:** the three R2 API tokens (host A, host B, keeper) are created when the
publisher exists, so the secrets go straight to where they are used instead of sitting unused.

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

**Not yet done:** a paid call from an external wallet holding USDT0 (the end-to-end gate), and the OKX
marketplace listing itself, which needs the `onchainos` CLI, an Agentic Wallet email login and an avatar.

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
