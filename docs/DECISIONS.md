# Curb — W0 decision record

Every claim here is a measurement taken against X Layer mainnet (chain 196, `https://rpc.xlayer.tech`)
or the unauthenticated xStocks issuer API. Reproduce with the scripts named in each section.
Status legend: **SETTLED** (measured), **PENDING** (instrumented, awaiting a scheduled event),
**OPEN** (needs a credential or a human).

---

## D-1 — What "closed" means, and which authority settles a Reopen Note

**Decision.** `closed` is defined as `limitsPerPeriod[currentPeriod].maxOrderFiatValue == 0` on the
issuer's own per-asset `trading` object — not an oracle flag, not a wall-clock rule. When that cap is
zero the creation/redemption arbitrage that pins a tokenized stock to its underlying is switched off by
the issuer, while AMM trading continues. That is the economic event Curb prices.

**Settlement authority, per asset class:**

| class | count | authority | why |
|---|---|---|---|
| XHKG, `Regular` mode | 79 | issuer `currentPeriod` returns to `market` **and** market cap non-zero, then an N-minute wrapper-pool VWAP, cross-checked against a manipulation-guarded TWAP | No Chainlink equity stream exists for HK names. The issuer's own record of when its primary market reopened is both stronger evidence and a better story in front of an xStocks judge. |
| US (`XNYS`/`XNAS`/`ARCX`/`BATS`), `TwentyFourFive` | 632 | Chainlink Data Streams report verified onchain through VerifierProxy 2.0.0, predicate `marketStatus == Regular` | Independent second witness. **Not** single-point: if unavailable we fall back to the same issuer-transition rule as HK. |

**Status: SETTLED.** Verified by `script/w0/observe_hkex_flip.py` (single snapshot, 2026-09-12T08:45Z,
HKEX shut): `TCENTx` → `mode=Regular, period=closed, openNow=false, applicableCap=0`, and the identical
shape for `XIAOx`, `MEITx`, `SHEINx`. Control `NVDAx` → `mode=TwentyFourFive`.

---

## D-2 — Chainlink Data Streams on X Layer is live and fee-free

**Measured** (`test/fork/VerifierProxy.t.sol`, 2 tests passing at block 70,433,328):

```
VerifierProxy 0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7
  typeAndVersion() = "VerifierProxy 2.0.0"
  s_feeManager()   = 0x0000000000000000000000000000000000000000   <- no billing
  owner()          = 0x53E56FefC450cd72149d6545e699c762348e19b9
```

A fee manager of zero means `verify()` skips billing entirely: **no LINK, no WOKB**. The proxy also
routes rather than being an empty shell — a report carrying an unregistered config digest reverts.
Selector extraction from its bytecode confirms `verify(bytes,bytes)` `0x3d3ac1b5`,
`getVerifier(bytes32)` `0xeeb7b248`, `setVerifier(...)` `0x6e914094`.

**Status: SETTLED for cost. OPEN for coverage.** We cannot confirm an *equity* feed is served on 196
without Data Streams credentials, which are request-gated. This is precisely the dependency four of five
judges flagged as a kill risk.

**Consequence, and it is load-bearing:** the demo runs on **Hong Kong names**, whose settlement authority
is the issuer transition and therefore has **no Chainlink dependency at all**. Data Streams is an
enhancement for the US contrast panel, never the critical path. If credentials never arrive, nothing in
the demo changes.

---

## D-3 — Real depth, and the note-notional cap

No Uniswap quoter is deployed on chain 196, so depth is measured by **executing real swaps against live
mainnet pool state on a fork** (`test/fork/DepthProbe.t.sol`), which walks every tick exactly as
production would. Each size runs against a fresh snapshot of the same block.

**Result — all five wrapped-equity pools, price impact when selling the equity leg.**
A percentage in brackets means the order only *partially filled*: the book ran out before the
size was met.

| pool | spot | $1k | $5k | $10k | $25k | $50k | $100k |
|---|---|---|---|---|---|---|---|
| wTCENTx/USDG | $54.96 | 9bp | 26bp | 47bp | 113bp | 281bp | **545bp, only 62% filled** |
| wNVDAx/USDG | $219.60 | 5bp | 8bp | 13bp | 37bp | 88bp | 196bp |
| wAAPLx/USDG | $334.50 | 17bp | 47bp | 82bp | 185bp | 349bp | 693bp |
| wQQQx/USDC | $718.21 | 5bp | 9bp | 14bp | 28bp | 52bp | 100bp |
| USDC/wTSLAx | $365.16 | 6bp | 16bp | 33bp | 88bp | 180bp | 385bp |

Two findings.

**Depth varies by more than an order of magnitude between assets**, so a single global haircut —
which is what the one competing product in this lane uses — is wrong for every asset
simultaneously. wQQQx absorbs $100k for 100bp; wAAPLx costs 693bp for the same size.

**wTCENTx is the only pool that cannot fill a $100k order at all.** It stops at roughly $58,300 of
proceeds, so the entire sellable depth of wrapped Tencent on X Layer is about **$58k** — against
$3.48M of daily volume through that pool. That is also the asset whose primary market is shut
83.6% of the week: the thinnest book against the longest closure.

**Erratum, 21 Sept 2026 — the concentration figure moved, and the superlative moved with it.**
This section originally read "98.9% of the token's supply sitting inside it", measured on 13 Sept.
Re-measured on chain today, wTCENTx is **86.01%** (1,659.19 of 1,929.07). It is no longer the most
concentrated asset in the cohort. Today's readings:

| asset | supply | in its pool | concentration |
|---|---|---|---|
| **wSHEINx** | 5,351.22 | 5,301.94 | **99.08%** |
| wXIAOx | 37,945.44 | 34,836.92 | 91.81% |
| wTCENTx | 1,929.07 | 1,659.19 | 86.01% |
| wMEITx | 9,755.46 | 7,989.48 | 81.90% |

Concentration is a **live quantity that moves with every mint and burn**, so it is quoted with its
measurement date or not at all. wTCENTx stays the demo asset on the strength of the depth curve and
the closure length, which is what the beat actually rests on — not on being the most concentrated.
Note the irony in the new leader: wSHEINx is the most concentrated asset in the cohort *and* the one
Curb refuses to price, because its only live pool has an observation cardinality of 1.

**Decision.** ReopenNote notional is capped **per asset** at the size that fills under **50bp**,
never at a fraction of headline liquidity:

| asset | cap | rationale |
|---|---|---|
| wTCENTx | $10,000 | 47bp; $25k already costs 113bp |
| wNVDAx | $50,000 | 88bp at $50k, still fills at $100k |
| wAAPLx | $5,000 | 47bp; the thinnest book per dollar of price |
| wQQQx | $50,000 | deepest pool measured; 52bp at $50k |
| wTSLAx | $10,000 | 33bp |

A borrower who cannot exit is the entire reason the instrument exists, so a note that cannot clear
would reproduce the problem it was built to solve.

**Status: SETTLED.** All five pools measured, full output in `artifacts/w0/depth_curve.txt`,
reproducible with `forge test --match-path test/fork/DepthProbe.t.sol -vv`.

One methodology note worth recording, because it nearly produced a wrong answer: three of these
five pools list the **stable as token0**, so a hardcoded "equity is token0" flag silently measures
the wrong side of the book. The probe now detects the equity leg at runtime by elimination against
the known stables and asserts exactly one stable leg per pool.

---

## D-4 — The HKEX recess flip

**The single binary that decides whether the demo is staged live.** HKEX's published schedule
(`GET /exchanges/XHKG`) is Extended 09:00–09:30, Regular 09:30–12:00, Regular 13:00–16:00,
Extended 16:00–16:10, Mon–Fri, with **no session covering 12:00–13:00**, and a forward holiday list that
spans but does not contain **6 October** — positive evidence HKEX trades on finale day. SGT = HKT, so the
recess falls inside the 10:00–14:00 window. *(The holiday list read 25 Sep, 28 Sep, 1 Oct, 19 Oct when this
was written. The issuer corrected it to 1 Oct and 19 Oct on 18 Sep, which matches HKEX's published 2026
calendar: there are no September closures. Either way 6 Oct trades.)*

The question this entry existed to settle — whether the issuer API actually *flips* `currentPeriod` away
from `market` across the recess, or holds it open until 16:00 — is now answered by measurement.

**Status: CONFIRMED on four consecutive trading days (Tue 15 – Fri 18 Sep 2026), by two independent
witnesses, with the onchain record matching. See "D-4 settled" at the end of this entry.**

**The observation gap, stated plainly.** The first observer ran under `nohup` on a MacBook and died
when the laptop entered clamshell sleep at 2026-09-12 20:12 UTC (last row 20:10:20Z). Nothing was
recorded from then until 2026-09-14 07:46Z, so **Monday's 01:00Z open and 04:00–05:00Z recess were
missed and cannot be recovered** — the issuer API is not historical. The observer now runs on Railway
(service `w0-observer`, deployment `d20033f7`, persistent volume) with a second local copy as an
independent witness.

*Correction, recorded 14 Sep 09:05Z:* this entry originally said the observer ran in Singapore with
restart policy `ALWAYS`. **Both were false.** The deployed manifest showed region **`sfo`** and restart
policy **`ON_FAILURE` with 10 retries**: `railway.json` Config-as-Code is not honoured for new Railway
services, so only its builder setting took effect, and the volume (attached before the first deploy) was
created in the workspace default region. The restart policy was fixed to `ALWAYS` through Railway
Infrastructure as Code (`.railway/railway.ts`). The observer stays in `sfo`: moving it would force a
volume migration with downtime, and an HTTP poller's region does not affect its evidence. Its rows in
the table below are therefore labelled by what they are — a US-West egress, not Singapore.

**First trading-hours evidence — the 16:00 HKT boundary, Mon 14 Sep 2026.** Two independent witnesses
(Railway US-West egress, and the team's Mac on a home connection), polling every 5 seconds:

| UTC | Railway (sfo egress) | the team's Mac |
|---|---|---|
| 07:49:36 | TCENTx `market` $100k · NVDAx `overnight` $200k | — |
| 07:54:33 | (no change yet) | TCENTx `market` · **NVDAx `closed` 0** |
| 07:55:03 | **TCENTx `closed` 0 · NVDAx `closed` 0** | — |
| 07:55:14 | — | **TCENTx `closed` 0** |
| 07:59:52 | — | TCENTx `closed` · **NVDAx `extended` $1M** |
| 07:59:57 | TCENTx `closed` · NVDAx `closed` | — |
| 08:00:04 | **TCENTx `extended` 0 · NVDAx `extended` $1M** | — |
| 08:00:07 | — | **TCENTx `extended` 0**; XHKG session now `Extended` |

*Correction, recorded 14 Sep 12:20Z:* this table first labelled the caps $10M / $20M / $100M. The issuer's
own API spec defines `maxOrderFiatValue` in **fiat cents**, so the raw values 10,000,000 / 20,000,000 /
100,000,000 are **$100k / $200k / $1M**. See D-7.

**Finding 1 — the issuer applies its own five-minute primary cutoff before a session boundary.**
TCENTx went `market` → `closed` at ≈07:55:00Z (15:55 HKT), five minutes *before* HKEX's 16:00
boundary, and only then `closed` → `extended` at 08:00. NVDAx did the same moving between two open US
sessions (`overnight` → `closed` at ≈03:55 ET → `extended` at 04:00). So primary creation/redemption
is switched off for ~5 minutes before each boundary even when the next session is also open.
**Implication for the demo:** if the same rule holds at the recess, the primary cap on Hong Kong names
goes to zero at **11:55 HKT**, five minutes before the exchange itself breaks for lunch. The calendar
alone would attest that 5 minutes late. **Confirmed four times over: see "D-4 settled" below.**

**Finding 2 — different egress points see the same flip up to ~30 seconds apart.** The MacBook saw
NVDAx `closed` 30s before the Railway (sfo) copy did, and saw it `extended` at 07:59:52 while that copy still saw
`closed` at 07:59:57. This matches the API's Cloudflare `s-maxage=30, stale-while-revalidate=60`
caching. It confirms two design rules: never let two hosts independently write API-derived rounds (they
will disagree and flap the public record), and commit exact bytes plus response headers in every round.

**Finding 1 repeated at the 16:10 extended close, with sub-second precision.** The local witness
recorded TCENTx `extended` → **`closed` at 08:04:59.672Z (16:05 HKT)** — five minutes before the 16:10
session end — while `GET /exchanges/XHKG` still reported `isOpen: true` with the `Extended` session
running until 08:10Z. So the rule has now held twice in one afternoon: **the issuer's asset-level
period goes to `closed` five minutes before a published session ends**, independent of the venue object.

**Consequences, adopted now:**
- The planner schedules an API burst from **T − 6 min** for every boundary that ends a session, not
  only at T. The pre-built schedule-only close at T remains as the backstop.
- `derive()` needs no change: when the issuer reports `closed` and the venue is still open, it already
  resolves `CLOSED` with cap 0 and flags a disagreement. Those pre-boundary disagreements are expected
  and will be classified as such rather than alarmed on.
- **Prediction confirmed.** The Hong Kong primary cap goes to zero at **03:55Z (11:55 HKT)** and returns at
  **05:00Z (13:00 HKT)**, on every trading day observed. The demo beat stands: *"the issuer switches off
  creation and redemption at 11:55 — five minutes before the exchange itself breaks for lunch."*

**Finding 3 — `resolve()` is correct against live data.** A live end-to-end `derive()` run 53 seconds
after the boundary resolved all six cohort assets with no degradation and no calendar disagreement.

**Finding 4 — the full write path works against the deployed contract, with nothing sent.** At
08:08Z a live round (18 leaves, 74.8 KB bundle) passed offline re-derivation, and `eth_call`
`attestBatch` from the registered attestor `0x4c3e…7fb8` succeeded. `eth_estimateGas` returned
**492,319** for this first, cold round — above the 393,400 the fork test measured, as the red team
predicted — so the sender's gas floor of 600,000 stands. The same call from an unregistered address
reverts with `0xdde328f8` = `NotAttestor()`.

### D-4 settled — the recess, measured

Evidence: host B's observer on the Tencent VPS (`/var/lib/curb/w0/hkex_flip.jsonl`, 5s polling inside
transition windows), the Railway `sfo` observer, and host A's own committed round bundles. Three vantage
points, three egress networks.

**The rule, stated exactly:** every issuer period **ENDS 300 seconds before its scheduled end**, and the
next period **STARTS on schedule**. It is asymmetric. The five-minute gap is reported as
`currentPeriod: "closed"` with cap 0. It held 16/16 for Hong Kong period-ends (4 days × 4 ends) and on every
tightly-sampled US period-end.

| day | last `market` seen | first `closed` seen | onchain CLOSED round | reopen (cap back) |
|---|---|---|---|---|
| Tue 15 Sep | 03:54:52.6Z | 03:55:00.4Z | 03:55:07Z, block 70,675,471 | 05:00:04.5Z |
| Wed 16 Sep | 03:54:57.0Z | 03:55:04.2Z | 03:55:06Z, block 70,761,870 | 04:59:59.6Z |
| Thu 17 Sep | 03:54:53.8Z | 03:55:01.0Z | 03:55:03Z, block 70,848,267 | 05:00:02.2Z |
| Fri 18 Sep | 03:54:57.5Z | 03:55:04.5Z | 03:55:06Z, block 70,934,670 | 04:59:59.3Z |

Intersecting the four brackets puts the cut in **(−302.5, −299.0] seconds** before 04:00:00Z — it contains
exactly −300s. The return lands in **(−2.3, −0.4] seconds** of 05:00:00Z: on time, not early. Quote it as
"within about five seconds", never "±2s": first-sighting offsets run +0.4s to +4.5s, bounded by the ~7s poll.

**At the moment of the cut the venue object still says open.** On all four days `GET /exchanges/XHKG`
reported `isOpen: true`, `currentSession: Regular`, `nextChangeAt: 04:00:00Z` while the assets were already
capped at zero. XHKG only flips at 04:00:00Z. So for five minutes a day the issuer and the venue disagree,
and MarketClock records it: all four cutoff rounds carry
`reason: "period=closed cap=0 | DISAGREEMENT venueOpen=true assetOpen=false"`.

**Consequences measured onchain:** the shut window is **~65 minutes**, not the exchange's 60 (3894.8s to
3904.1s). The onchain state changed +1.5s to +6.6s after the issuer flip at the close, and −2.5s to +3.7s at
the reopen. The Hong Kong primary cap is non-zero for only **320 of the venue's 370 published session
minutes**.

**Also found, not previously recorded:**
- The **09:00–09:30 Extended session ends 5 minutes early too** (≈09:25 HKT), so the rule is universal, not
  specific to a close. It is not a cap event: Hong Kong `extended` already carries cap 0.
- `nextAt` during 11:55–12:00 points at 12:00, the next *published session boundary*, not at the 13:00
  reopen. Do not put `nextAt` on screen during that beat.
- The four Hong Kong names flip together **to within one poll cycle**, not atomically: the observer reads the
  seven endpoints sequentially under one timestamp, so three rounds caught a flip mid-cycle. Say "together,
  to within the time it takes to poll them".

**A defect this surfaced.** Between 06:00Z and 08:00Z on 18 Sep the issuer's XHKG holiday list shrank from 4
entries to 2, dropping a 25 Sep half-day and a 28 Sep closure. Checked against HKEX's published 2026
calendar, **the issuer was correcting itself**: HKEX has no September 2026 holidays, and its only closures
near the finale are 1 Oct and 19 Oct — exactly the two entries that remain. **6 Oct is a trading day,
now confirmed from two independent sources.** The lesson stands regardless: the issuer's copy of the venue
calendar changes silently, so a change in it should raise an alarm rather than pass unnoticed.

**Fallback if it does not flip.** `MarketClock` attests the closure from HKEX's own published session
schedule, which is authoritative regardless of how the issuer resolves it; the demo states the
distinction out loud; and the US weekend closure becomes the live leg with the recess as contrast.
Either way the plan survives — but we will know before contract work begins.

---

## D-5 — Operational constraints discovered

- **`eth_getLogs` is capped at a 100-block range** on the public X Layer RPC. Any indexer must page in
  100-block windows or use a private endpoint. Budget for this in the attestor.
- **Rebases emit no event.** A ±5,000-block scan around AAPLx's activation found zero logs; the
  multiplier is pre-published and flips on a **timestamp**. The attestor **polls**
  `multiplier()` / `getCurrentMultiplier()` on a schedule and ingests the versioned corporate-actions
  feed. It must never listen for logs.
- **The multiplier is not monotonic and is not only dividends.** Verified: NFLXx = 10.000000 exactly
  (10-for-1 forward split), PPLTx = 10.0, KLACx = 10.0168, CRWDx = 4.0; 336 of 732 assets have
  multiplier ≠ 1. `caType` from `/corporate-actions/history` is the only discriminator between income
  and a non-taxable split.
- **`getCurrentMultiplier()` returns a 3-tuple** whose third word is a nonce matching the event count
  exactly (AAPLx `(1003269012539818700, 0, 5)`, AGNCx `(1007706422018348700, 1, 1)`). This is the
  anti-race key. Never hardcode a 00:30 UTC blackout — measured activations include 23:55Z, 02:30Z and
  11:20Z.

---

## D-7 — Erratum: the first seven mainnet rounds overstated primary capacity 100x

**Status: CORRECTED on 14 Sep 2026 at 12:16:13Z (block 70,619,137). The earlier rounds stay onchain unchanged
and are documented here.**

**What was wrong.** The issuer's OpenAPI spec (`api.xstocks.fi/api-docs`) defines `minOrderFiatValue` and
`maxOrderFiatValue` in **fiat cents**. MarketClock's `primaryCapUsd` is whole US dollars, and that is
immutable. The attestor copied the raw issuer value straight across. So every round from host A's first write
until the fix published a cap **100 times too large**: wNVDAx and wAAPLx read **100,000,000** during US
extended hours, when the issuer's real per-order cap was **$1,000,000**. Regimes were correct in every round.
A consumer that only checks `primaryCapNow == 0` got the right answer, and one that reads the size did not.

| block | UTC | tx | method | kind | offline verify |
|---|---|---|---|---|---|
| 70,617,365 | 11:46:41 | `0x8e87d0f0…` | derive/1 | heartbeat* | claims ✓ · label ✗ |
| 70,617,695 | 11:52:11 | `0x2e70a07c…` | derive/1 | heartbeat | ✓ |
| 70,618,025 | 11:57:41 | `0x90a76e09…` | derive/1 | heartbeat | ✓ |
| 70,618,355 | 12:03:11 | `0xcb91e9d9…` | derive/1 | heartbeat | ✓ |
| 70,618,681 | 12:08:37 | `0xc4380de1…` | derive/1 | heartbeat | ✓ |
| 70,619,011 | 12:14:07 | `0x8d501b61…` | derive/1 | heartbeat | ✓ |
| **70,619,137** | **12:16:13** | **`0xaec29e1a…`** | **derive/2** | **diff** | **✓, caps 1,000,000** |

\* Round 1's bundle had a top-level label of `diff` while its committed PARAMS leaf says `heartbeat`. The
label was not yet covered by the root. The round builder has committed the kind since the 12:06:48Z
deploy, and the verifier now checks every top-level field against PARAMS, and it flags this round correctly.

**How it was fixed without rewriting history.** Derivation rules are now **versioned, never edited in
place**. Each round commits its method id in the PARAMS leaf, and the verifier re-derives the round with
exactly that method:

- `curb.marketclock.derive/1` keeps the raw issuer value. Only `market` with a zero cap became CLOSED.
- `curb.marketclock.derive/2` converts cents to whole USD (floor). Any open-labelled period with a zero cap
  is CLOSED, including a positive cent value that floors to $0, so `cap == 0 ⇔ CLOSED` holds. UNKNOWN is
  never written.

All six derive/1 rounds were fetched by the root in their calldata and re-derived under derive/1. Every
claim reproduced exactly. The derive/2 round reproduced exactly under derive/2, and onchain
`primaryCapNow(wNVDAx)` now returns 1,000,000.

**A second finding from the same review, also fixed before any write.** HKEX reports `extended` with a
zero cap from 09:00–09:30 and 16:00–16:10 HKT. Under derive/1 that would have been written as EXTENDED with
cap 0, and a consumer checking `regime != CLOSED` would treat issuance as open. No round was affected: all
seven rounds fell outside HKEX hours. Rounds written between 12:06Z and 12:16Z ran code that already had the
derive/2 regime rule but committed `derive/1`. They re-derive identically under both rules, because no HK
asset was in an extended period.

**Why it was caught.** An adversarial review of the first live round checked the unit against the issuer's
spec instead of the field name. The cost was seven rounds and 30 minutes of mis-sized public record, now
disclosed. Leaving it in the record would have been worse.

---

## D-8 — Host B runs on a shared VPS, with its own key

**Decided 14 Sep 2026 by the team.** Host B runs on an existing VPS (`Sonar-VPS2`, Tencent Cloud
Lighthouse, Silicon Valley), not the planned dedicated Hetzner box in Singapore.

**What it gains.**
- It is a second provider (Tencent vs Railway) and a second continent and CDN edge. That makes it a more
  independent witness than a second Singapore box would be.
- Its clock is chrony-synced to within 0.2 ms, and it is 0.19 s from the X Layer RPC, which is ample for a
  takeover budget of seconds.
- It has been up 38 days.

**The accepted risk, stated plainly.** Most of the other services on that box run as **root**, including
public web apps and agent processes that handle outside input. A compromise of any of them could read
host B's keystore and its password. Containers and a dedicated uid do not stop root. A stolen host B key
can call only `attest`/`attestBatch`. Its writes would be visible and falsifiable: there would be no
bundle, or a witness saying `reproduced: false`, and an alarm on any write from host B. They are
revocable with one admin transaction (`setAttestor(0x50Fa…39fB, false)`). The team chose to accept this
rather than pay for and wait on a dedicated box.

**Mitigations in place:**
- Its own container: read-only root, all capabilities dropped, uid 10001, and a 384 MB hard cap.
- No inbound port.
- A small OKB balance.
- Every write host B makes pages.
- Host B alarms on any MarketClock write from an address outside the expected set.

**How host B decides to write** (`services/attestor/src/coord.ts`). The rules came from an adversarial
review whose confirmed defects were fixed before B held any power:
- While host A is alive, B writes only a calendar-forced close (after 25 s) or a nonce activation (after
  45 s), once each.
- B never writes an API-driven change while A is alive, because CDN edges disagree for up to 90 s. It
  pages instead.
- Once A is silent for 390 s, B covers everything.
- A takeover round never carries a claim B is not entitled to write, including B's own blind spots.
- A contradicting write from A stands B down for 12 hours, and that survives restarts.

---

## D-6 — Open, needs a human

- **LP outreach** to the wallets providing liquidity to wSHEINx / wTCENTx / wXIAOx. Longest human latency
  in the plan; **hard go/no-go 1 Oct**. If nobody commits, the loan beat is cut and the onstage
  irreversible moment becomes the proved fade and slash, which needs no counterparty.
- **Data Streams credentials** (`app.chain.link`). Enhancement only — see D-2.
- **Slot request** to the organisers: "late morning, ideally spanning noon", without explaining why.

---

## D-9 — derive/3: cohort coherence and confirm-before-open

**Live from block 71,173,967 (20 Sep 2026 22:26Z, tx `0x20dd8be0…`).** Rounds before it keep their own
method and re-derive unchanged; `METHOD_BLOCKS` in `services/attestor/src/witness.ts` now refuses derive/2
after that block, so a rollback cannot pass as honest.

Six days of live record (1,702 rounds, zero gaps, all reproduced) surfaced two ways the issuer's CDN can
put a wrong state onchain. Each object is cached independently, with `s-maxage=30` and
`stale-while-revalidate=60`, so one asset's body can be up to ~90s older than its neighbour's.

**Rule 1 — cohort coherence.** Assets sharing a venue *and* an hours mode run on the same primary
schedule. When one says the primary is shut and another says open inside the same fetch batch, the open
ones are closed (`venue-cohort-shut`). Measured cause, 17 Sep 13:25:05Z: one edge served AAPLx `closed`
and NVDAx `extended` 475 ms apart, so wNVDAx was written EXTENDED / $1,000,000 for ~20 s after its cap had
actually gone to zero.

A witness must be speaking **for the venue** and **for now**, which an adversarial review reduced to three
conditions — without them the rule inverts and one stale object shuts a healthy cohort:
- not halted, not degraded: those assets are shut for their own reasons;
- its own period label must not still be `market`/`extended`/`overnight`. A zero cap under an open label is
  a per-asset suspension (D-1), not a venue closure;
- it must not have outlived its own announced transition. During a closure the issuer publishes
  `nextChangeAt` = the reopen (verified in the archived round for 18 Sep 04:00:07Z: TCENTx `closed`,
  `nextChangeAt 05:00:00Z`), so a body still reading `closed` after that moment is stale, not evidence.

The rule also stands down for **120 s after any published session start**, where the objects that lag are
by construction the ones still reading shut.

**Rule 2 — confirm before open.** A wrapper is only written open when the **previous tick's raw
observation** also saw it open; otherwise it is held CLOSED for one tick
(`awaiting-reopen-confirmation`). Closing is never delayed. One stale cached body can no longer reopen an
asset mid-closure; a real reopen costs one tick, 5 s inside a boundary window. With no usable prior (fresh
boot, a prior older than 90 s, or no entry for that wrapper) the round opens anyway and says so
(`open-unconfirmed`).

The prior is an **input to the claims**, so it is committed as a `PRIOR` leaf (LeafKind 8) and the verifier
re-derives the hold from the bundle alone. The committed prior is the **raw** observation, never the held
claim — otherwise a hold would perpetuate itself. A changed prior changes the root.

**What offline verification does and does not prove.** The PRIOR leaf is attestor-asserted, like the fetch
log: `reproduced: true` means a round is internally consistent under its committed method. Independence
comes from host B's signed second reading (`observation`), taken from a different provider, continent and
CDN edge — not from the prior. Three review claims that the prior should be chained to the previous round
were refuted: the prior comes from the previous *tick* (5–30 s), while rounds are ~5.5 minutes apart, so
chaining it would make every prior stale and silently disable the rule.

**Also changed:** a forced close now restates `nextAt` from the venue's published schedule instead of
carrying the open period's value; and host B's takeover planner treats a `venue-cohort-shut` claim as weak
evidence, exactly like an unreadable body, so a stale edge at B cannot turn a failover into a CLOSED write
over a healthy cohort.

**Verification:** 124 tests under four host timezones, including the replayed 17 Sep incident, a reopen with
a stale witness, the quiet window, and byte-identical re-derivation of derive/1 and derive/2 rounds. First
live round witnessed `reproduced: true`, `labelsConsistent: true`, independent observation `AGREE`.

---

## D-10 — Scorecard settles at a price nobody supplies (21 Sept 2026)

**Settled.** Scorecard v1 was replaced before it ever recorded a row.

**The defect.** `settle(bytes32 id, uint128 reopenPrint, uint8 source)` was `external` with no keeper
gate and no validation of `reopenPrint`. Its only checks were that the closure existed, was
unsettled, that `block.timestamp >= settleAfter`, and that the price was non-zero. Settlement is
permissionless *on purpose* — the record has to keep accruing even if Curb's own keeper dies — but
combined with a caller-supplied price and a deliberate absence of any revision path, it meant any
passer-by could grade every Curb row against an invented number, permanently. Found by reading the
deployed contract line by line before writing a producer for it.

**The decision.** `settle(bytes32 id)` takes no price and no source. The contract reads the wrapper's
registered pool itself. The settler still chooses the *moment*; they never choose the *number*. This
is a strictly stronger claim than v1 made, and it cost one redeploy (~$0.017) while the record was
empty. See `docs/DEPLOYMENTS.md` for the v2 address, the pinned price sources, and the two further
defects that measurement caught before deployment (a cardinality-1 pool's `observe()` returning spot,
and a guard window that would have refused to settle exactly the largest reopen gaps).

**The reopen instant is evidence, not an assertion.** `settleAfter` is half the closure id
(`keccak256(wrapper, settleAfter, inputRoot)`) and the moment the mark is graded against, so it is
the one number a reader most needs to be able to check. MarketClock cannot supply it: its
`nextTransitionAt` is the next *schedule* boundary, and a closure routinely spans several. The Hong
Kong afternoon cut runs 15:55 (capacity off) → 16:00 (extended session, capacity still zero) → 16:10
(venue shut) → 09:00 next day (extended, still zero) → **09:30 (capacity back)**. Trusting the next
boundary would have committed a 17½-hour closure as a 5-minute one and marked it on five minutes of
drift. So the keeper walks the venue's published boundaries forward to the first instant whose period
carries a non-zero issuer cap (`services/keeper/src/reopen.ts`), and every mark bundle commits the
schedule and the per-period caps it used. A verifier re-runs the same pure function and either gets
the same instant or catches us.

**Coverage.** Every closure, all five priceable assets — the lunch recess, the ~17-hour overnight
closure, weekends and holidays, plus the US names' own closures. Holidays need no special case: they
fall out of `sessionAt()`, so a Friday close predicts Monday and 30 Sep predicts 2 Oct.

> **Note, ⟨DATE_D16⟩ (D-16).** "Holidays need no special case" was true of the prediction and not of the evidence.
> The keeper predicted 2 Oct from 30 Sep, and 20 Oct from 16 Oct, correctly. But each bundle committed the holiday list
> as it stood ten minutes before the reopen, after the issuer had dropped the holiday the closure spanned, so a
> verifier walking that schedule from the cut "gets a different instant" for six rows that are not wrong, and
> `curb-verify` 0.1.0 prints `NOT REPRODUCED` for them. From block ⟨N⟩ the committed schedule keeps every holiday seen
> during the closure.

**A closure whose start was not witnessed is not marked.** After a restart the keeper has no observed
last print, and "the mid at the cut" would really be a mid from the middle of the closure. The row
would quietly claim a baseline it never saw. One fewer row is the correct answer.

**The commit is frozen and idempotent.** The closure id covers `inputRoot`, and the root covers
`evaluatedAtMs` — so rebuilding the round after a lost receipt would produce a *different* id, and a
commit that actually mined would become a second row for the same closure, double-counted by
`skill()` forever. The round is therefore built once and retried byte for byte; a retry either lands
the same row or is refused with `ClosureExists`, which is itself proof the first one mined.

---

## D-11 — The first three Scorecard rows, and what they say about `curb.scorecard.mark/1` (22 Sept 2026)

**The pipeline worked exactly as designed.** At the 22 Sept Hong Kong lunch cut the keeper saw
capacity go to zero at 03:55:09Z for wTCENTx, wXIAOx and wMEITx, predicted the reopen at 05:00:00Z
by walking the venue schedule, committed all three marks at 04:50:14–40Z on the 600-second lead
(blocks 71,283,582 / 594 / 604), and settled them at 05:05:16–25Z, reopen + `SETTLE_DELAY`
(blocks 71,284,480 / 484 / 489). The contract read the settlement price from the pool itself. The US
names' five-minute boundary gaps (23:55Z, 07:55Z, 13:25Z) were correctly skipped by `MIN_CLOSURE_S`.

**And all three are ties.** `skill()` = (3 settled, 0 beat the last print, 0 beat the closing VWAP).

| asset | mark | last print | reopen print | Curb error | last-print error | VWAP error |
|---|---|---|---|---|---|---|
| wTCENTx | 58.243190 | 58.243190 | 58.237919 | 0bp | 0bp | 0bp |
| wXIAOx | 3.541073 | 3.541073 | 3.538410 | 7bp | 7bp | 7bp |
| wMEITx | 9.402172 | 9.402172 | 9.398584 | 3bp | 3bp | 3bp |

**The cause is plain and it is in the committed evidence:** all three bundles carry the flags
`no-drift` and `no-closing-vwap`. **Not one swap occurred in any of the three pools during the
55-minute recess, nor in the 15 minutes before the cut.** The method had no information to move on,
so the mark equalled the last print by construction, and `skill()` counts strict wins only.

This is the risk the W2 plan named in advance — "a pool may be silent through a closure, which makes
the mark equal the last print; honest, but it ties rather than beats" — and it is now measured rather
than hypothetical. It is also the right outcome: a method that moved its mark with no evidence would
be exactly what the Scorecard exists to expose.

**What happens next, decided now so it is not decided under pressure.** One recess is not enough to
change a method. The next rows are the ~17½-hour overnight closure (cut 07:55Z, reopen 01:30Z on
23 Sept), which is where drift should appear if it appears anywhere. If the recess stays silent across
several days, the lunch closure will never be winnable under `mark/1`, and the method gains a
cross-market term as `curb.scorecard.mark/2` — with old rows keeping the method that produced them,
exactly as the attestor's derivation methods are versioned. **No row is ever re-marked.**

### D-11 update, 24 Sept 2026 — fifteen rows, fifteen ties, and the overnight is silent too

By 24 Sept 05:05Z the Scorecard held **15 settled rows: 0 wins, 15 ties, 0 losses.** Nine are lunch
recesses and **six are the ~17½-hour overnight closures** (settleAfter 01:30Z) — the case D-11 named as
the one where drift should appear if it appears anywhere. It did not. In every row the mark equals the
last print exactly, because the pools did not trade while primary capacity was off.

The reopens were not quiet. They moved **30 to 105 bp**: wXIAOx +105 bp (24 Sept lunch), −73 bp and
−72 bp; wMEITx −64 bp and +30 bp; wTCENTx −53 bp and −32 bp. Real information arrives at every reopen, and
none of it is in the pool beforehand.

**So the contingency D-11 fixed in advance is now met.** `curb.scorecard.mark/1` cannot beat the last
print on these assets, by construction: its only input is the wrapper's own pool, and that pool carries
no information while the market is shut. Beating the baseline requires a signal from outside the pool —
something that does trade while HKEX is shut (Hang Seng index futures in HKEX's after-hours session,
US-listed ADRs and China ETFs during US hours, USD/CNH) — introduced as `curb.scorecard.mark/2`, with
every existing row keeping the method that produced it. No row is ever re-marked.

> **Erratum, 25 Sept 2026 (found by an independent fact-check of the Aave ARFC, confirmed on chain).** The claim
> above that "the pools did not trade while primary capacity was off", and that the pool "carries no
> information while the market is shut", is **wrong**. The three Scorecard price pools printed 15 swaps in the
> 22 Sept lunch recess, 63 in the 23 Sept recess and 141 in the 24 Sept recess (most on wXIAOx's USDC pool;
> wTCENTx had 1), and in 14 of the 15 closures the pool price one second before the reopen differed from its
> price at the cut. The 15 ties stand, but for a different reason: `mark/1` *is* the last print, so a mark/1
> row can only tie the last-print baseline, whatever the pool does. The keeper's `no-drift` flag on those
> marks therefore did not detect trades that did happen; it is to be investigated after the finale (the
> keeper is not changed while the first mark/2 rows are being recorded). The reopen range is 0 to 105 bp,
> not 30 to 105.

> **Erratum, ⟨DATE⟩ (the open item above, closed in D-15).** The `no-drift` flag was not detecting anything. The
> keeper failed to decode every pool `Swap` log, so it counted zero swaps in every closure and applied no drift.
> Four statements in this entry are wrong, not one. (1) 22 Sept: "Not one swap occurred in any of the three pools
> during the 55-minute recess, nor in the 15 minutes before the cut". The pools printed 15 swaps in that recess
> (wTCENTx 5, wXIAOx 4, wMEITx 6) and one on wXIAOx in the 15 minutes before the cut; "it is in the committed
> evidence" was true only because the evidence was the defect. (2) 24 Sept: "none of it is in the pool beforehand".
> In 14 of the 15 closures the pool's price had moved before the reopen, and in the first row the pool already stood
> at its reopen print, to the wei, when the mark was committed. (3) 24 Sept: "`mark/1` cannot beat the last print on
> these assets, by construction". (4) The erratum of 25 Sept: "`mark/1` *is* the last print, so a mark/1 row can only
> tie". `mark/1` is the last print moved by half the pool's drift. The fifteen marks equalled the last print because
> the drift was recorded as zero. The ties stand as graded. The 25 Sept swap counts (15, 63, 141) were recounted and
> are right; "wTCENTx had 1" is right for 23 and 24 Sept and wrong for 22 Sept, when it had 5, and on 22 Sept most of
> the swaps were not on wXIAOx (4 of 15).

The public record says so already: `https://api.curb.markets/v1/accuracy-record` previews
`{"settled": 15, "beatLastPrint": 0, "beatClosingVwap": 0}`. That is the honest number.

---

## Erratum to D-4 (24 Sept 2026): the finale is 7 October, not 6 October

D-4 names **6 October** as finale day three times. The OKX Dev Day finale in Singapore is **Wednesday 7 October
2026**. The conclusion does not change, and the same evidence covers the corrected date. The issuer's XHKG
holiday list, re-read on 24 Sept at about 13:05Z, still holds exactly two entries near the finale: 1 Oct and 19 Oct.
So 7 Oct is a Hong Kong trading day, and the 11:55 HKT cut would fall inside a late-morning slot (SGT = HKT). D-4 stays
as written. Read "6 Oct" there as "7 Oct". `docs/WALLETS.md` says "top-up to clear 6 Oct", and the funding it
describes should be re-checked against 7 Oct.

---

## D-12 — W3/W4 cut to six contracts; what was cut and why (24 Sept 2026)

**Decided 24 Sept 2026.** The design was frozen for a one-day parallel build in `docs/specs/W3W4-contracts.md`,
which stays the source of truth for every interface and constant. This entry records the shape of the reduction
and the cuts.

**What is built, deploying 25 Sept:**

| wave | contract | job | admin |
|---|---|---|---|
| W3 | `EligibilityRegistry` | thin allowlist for bidders and borrowers; every entry carries an evidence hash | yes, two-step handover copied from MarketClock |
| W3 | `ReopenPointer` | monotonic record of shut → open transitions observed on MarketClock, plus one write-once reopen print per asset and epoch, from `Scorecard.priceNow` | **none** |
| W3 | `ReopenNote` | ERC-1155 claim that escrows wrapper shares while the market is shut and delivers exactly those shares after the verified reopen (10-day fallback) | **none** |
| W3 | `ClosedAuction` | descending-price clock that clears with a single bidder, only while the market is still shut and the epoch unchanged | **none** |
| W4 | `DepthCert` | bonded firm bid (bond ≥ 10% of notional); a fade is proved in the same transaction and the whole bond goes to the taker | **none** |
| W4 | `CurbCredit` | fixed-rate reserve (5% simple APR) with a published `ltvFor`, refusals that emit an event and change nothing, and a cure clock that counts only witnessed open time | reserve management and realising seized collateral only |

**The rules that shaped the reduction:**

- **No new oracle.** Open versus shut comes from MarketClock, and price comes from Scorecard v2's `priceNow`: the
  same guarded pool price that grades Scorecard rows. Every instrument settles on numbers that are already public
  and already verified.
- **Physical delivery in wrapper shares.** A note delivers the shares it escrowed. The ERC-4626 share absorbs
  every corporate action, so delivery never has to interpret one. The raw multiplier and nonce at mint are kept
  as provenance only.
- **Caps come from measured depth, not headline liquidity** (D-3's under-50 bp rule). The caps are 175 wTCENTx,
  220 wNVDAx and 14 wAAPLx shares: about $9.8k, $49k and $4.7k at the spec's 24 Sept prices of 55.78, 223.35 and
  337.89.
- **Four of the six contracts have no admin.** This follows the principle behind Scorecard's write-once price
  sources (D-10): an admin who could change the inputs after the fact could choose the outcome.
- **A refusal is a record, not a revert.** `borrow` and `withdraw` that CurbCredit refuses emit `Refusal(who,
  asset, reason, requested, allowed)` and return false. The refusal leaves an on-chain trace in a transaction
  that succeeds.
- **Nobody is liquidated while shut.** Liquidation needs 30 minutes of witnessed open-market cure time. Seizure is
  bounded by a 5% bonus at the breach-time price.

**Cut or deferred.** The reason column quotes the spec where the spec gives one. Where it does not, the reason is
stated as scope, not invented.

| item | reason |
|---|---|
| RefutationBond | It needs a judge, and rows are already falsifiable off chain: `curb-verify` re-derives every mark, and Scorecard settles at a price nobody supplies (D-10). |
| CurbMark AggregatorV3 feed | Nothing consumes it. |
| Cash settlement / `caType`-aware delivery | Physical wrapper-share delivery is multiplier-independent, so there is nothing to convert. |
| Chainlink Data Streams adapter | Equity coverage on chain 196 is still unconfirmed without request-gated credentials (D-2), and nothing in the Hong Kong path depends on it. |
| DepthCert extras: EIP-712 off-chain quotes, two-sided depth, bands, ERC-6909, fee share | Scope, deferred. The spec keeps DepthCert to a one-sided bid at one price per cert. That is enough for a fade to be proved inside the same `take` call, and several certs already form a curve. |
| Standalone BreachClock | Folded into CurbCredit's cure clock. |
| ConsentRegistry, utilisation curve, auto-liquidation into certs | Scope. The fixed 5% APR and an admin-called `realise` on seized shares only are enough to show the mechanism. |
| Keeper patch to poke `observe` / `recordPrint` | Operator script `script/w3/poke.sh` for now. Accepted risk: without a poke at the reopen, the epoch opens and the print is taken only when someone next calls `observe` (`recordPrint` accepts 5 to 35 minutes after that). Delivery is unaffected, and `bid` and `redeem` call `observe` themselves. |
| wXIAOx / wMEITx notes | No measured depth (D-3 measured neither), so no cap can be sized under the 50 bp rule. wSHEINx is excluded for a different reason: it has no Scorecard price source. |

**Risks accepted, from the spec:**

- `recordPrint` refuses on a TWAP deviation of more than 50 ticks. The fix is to retry inside the window.
- A stale MarketClock makes every path refuse, and the cure clock freezes. This is by design.
- The Agentic Wallet's policy may block calls to new contracts. The fallback is a second disclosed keystore
  wallet.
- USDG `transferFrom` gas has to sit well under DepthCert's 150,000 stipend. A fork test measures it before
  deploy.
- Every contract is immutable. The mitigation is parameterised scripts and fork dry runs.

**The demo is between team wallets, and says so.** `curb-desk` (disclosed in `docs/WALLETS.md` before its
first transaction) is the note seller, cert maker and reserve funder. The team's Agentic Wallet is the bidder,
taker and borrower. The demo budget is about $38. None of it is third-party usage, and none of it is presented
as such.

---

## D-13 — `curb.scorecard.mark/2`: a signal from markets that trade while Hong Kong is shut (24 Sept 2026)

**Why.** D-11's contingency was met. All 15 rows settled under `curb.scorecard.mark/1` were ties, because
mark/1 is the last print by construction (the pools do trade while shut; see the D-11 erratum), yet the reopens moved 0–105 bp.
Beating the last print needs information from outside the pool.

> **Erratum, ⟨DATE⟩ (D-15).** "mark/1 is the last print by construction" is wrong, and so is "The mark stays the last
> print" for the lunch recess below. mark/1 moves the last print by half the pool's drift, and a recess row under mark/2
> is mark/1's mark. In every row before block ⟨N⟩ the keeper recorded a drift of zero because it decoded no swaps, so
> the premise above ("needs information from outside the pool") was never tested. The β fit and the walk-forward use no
> pool data and are unaffected.

**Which signals exist.** Surveyed and tested 24 Sept, 12:07–12:30Z:

- **Binance USDⓈ-M perpetuals trade 24/7 on the Hong Kong names:** `HK0700USDT` (Tencent, HKD/share),
  `HK1810USDT` (Xiaomi, HKD/share) and `MEITUANUSDT` (Meituan, USD/share). They are keyless. **A closed
  minute's kline is byte-identical on refetch**, so a third party can reproduce the evidence exactly.
- **US ADRs** (TCEHY 1 share/ADR, XIACY 5, MPNGY 2) trade in US hours, which fall entirely inside the Hong
  Kong overnight closure. Yahoo's chart API needs a User-Agent and no key. Its bytes are *not*
  reproducible on refetch, so this leg is verified against the committed bytes only, and the bundle says so.
- **Rejected:**
  - Stooq: now behind a JavaScript challenge.
  - Pyth Hermes: prices now need a key.
  - HSI futures: Hong Kong futures also break 12:00–13:00, and the only free night-session quote (Sina) is
    GBK-encoded JavaScript that can change without notice.
  - OKX: lists only Xiaomi, and its index is 58% Binance.
  - Binance `indexPrice`: it drifts toward the perp during closures.

**The method.**

    mark = lastPrint × (1 + β · r),   β = 0.79

- `r` is the mean of the perp return and the FX-adjusted ADR return, each measured from the cut to the
  commit. One leg alone is used if the other is missing (flag `perp-missing` / `adr-missing`). A leg that
  moves more than 20% is set aside as a bad print.
- **Lunch recess (closures under 4 h): weight 0.** The mark stays the last print, flag `recess-no-edge`.
  Over 23 recesses, the perp-adjusted mark *lost* on all three names (Tencent 26 vs 18 bp, Xiaomi 29 vs 22,
  Meituan 32 vs 19), and halving the weight was still worse. The perp's move is still committed as
  evidence.

  > **Erratum, ⟨DATE⟩ (D-15).** Weight 0 on the signal leaves mark/1's rule, which moves the last print by half the
  > pool's drift. A recess row stayed at the last print only because the keeper recorded the drift as zero. From block
  > ⟨N⟩ recess rows move with the pool.
- **wNVDAx / wAAPLx:** no proxy (`no-proxy`); mark/1 behaviour.
- **Nothing available:** `no-signal`, and the mark equals mark/1's.
- **β** was fitted on 118 overnight and weekend closures (22 Jul – 22 Sep, ending *before* the D-11 rows),
  regressing the Hong Kong open-over-close on `r` through the origin:

  | sample | β | std. error |
  |---|---|---|
  | pooled | 0.983 | 0.093 |
  | Tencent | 1.048 | — |
  | Xiaomi | 0.901 | — |
  | Meituan | 0.976 | — |

  Pooled uncentred R² 0.49. Published damped as round(0.8 × 0.983, 2) = 0.79. In-sample mean error fell
  from 92.7 → 58.2 bp (Tencent), 96.6 → 78.5 (Xiaomi) and 93.2 → 67.3 (Meituan) against the opening
  auction. That is not the pool print the Scorecard grades.

**Evidence.** Each response's exact bytes are committed as a `signal:<wrapper>:<leg>` leaf with its
upstream URL, keccak256 and sha256. Every fetch attempt, including failures, goes into a fetch-log leaf.
`verifyMarkBundleOffline` re-derives `r` and the mark from the committed bytes with the same pure function
(`services/keeper/src/sources/signal.ts`), and checks the committed β and proxies against the method's
own. The bundle shape is unchanged (`markbundle/1`). The method digest is `keccak256("curb.scorecard.mark/2")`.

**Geography.** Binance answers HTTP 451 to US IPs, and the keeper runs in Silicon Valley. The perp leg
therefore goes through curb-asp in Singapore (`GET /v1/relay/binance/klines`). The relay forwards the
upstream bytes verbatim and adds `x-curb-upstream-url` and `x-curb-upstream-sha256`. The bundle commits
the *upstream* URL, so anyone outside the US can refetch from Binance directly and compare hashes. Verified
live 24 Sept: the relay's sha256 for `HK0700USDT` @ 1790236440000 matched the expected
`2457e23f…767e11`.

**An honest out-of-sample replay** on the six D-11 overnight rows, graded the way the Scorecard grades:
mark/2 would have **won 4 of 6** outright, but its mean error was slightly worse (47.0 vs 44.3 bp). Both
losses were the 22→23 Sept night, when both signals pointed up and the pool's post-reopen print came in
down. Six rows prove nothing either way; the live record will.

**Known limit.** A keeper could omit a leg's bytes it didn't like. The fetch log makes that visible but
cannot prove it. The perp leg can be checked by refetching; the Yahoo leg cannot.

**Unchanged rule:** every existing row keeps the method that produced it. **No row is ever re-marked.**
The mark/1 verification range closes at block 71,486,953 (`MARK2_CUTOVER_BLOCK`).

**First mark/2 rows (25 Sept 01:30Z reopen): three losses.** Committed 01:20:31–01:20:47Z (txs `0xebd87019…62f4`,
`0x90125dac…3104`, `0x7e9104f8…9b29`, blocks 71,530,195–71,530,211), settled by the keeper at 01:35:26–01:35:30Z
(`0x5ca722b5…ed0e`, `0x37f5b51b…a142`, `0x55d3a7c7…fb4c`). Curb error against the pool's own reopen price, against
the last print's: wTCENTx 152 vs 13 bp, wXIAOx 381 vs 336 bp, wMEITx 204 vs 193 bp. `skill()` = (18, 0, 0).
All three marks called the gap up (wTCENTx +139 bp); HKEX opened all three down (0700.HK −78 bp, 1810.HK −143 bp,
3690.HK −76 bp at the 09:30 HKT open). So the signal pointed the wrong way: a real miss, not a grading artefact.
A second finding: five minutes after the reopen, when the Scorecard reads it, the pool had moved far less than
the market (wTCENTx pool −13 bp, 0700.HK −114 bp by 09:35), so a baseline of "no change" is favoured by a pool
that lags the reopen. Both stay on the record; no row is ever re-marked.

---

## D-14 — Benchmarks for mark/2: walk-forward, named baselines and the band (25 Sept 2026)

**Published 25 Sept 2026.** The evidence for mark/2 now sits in a Benchmarks section on `/scorecard`. It is
shown next to the on-chain tally and kept apart from it. The study is `tools/research/hk-closures/fit.mjs`,
written up with its sources and limits in [docs/research/HK_CLOSURE.md](research/HK_CLOSURE.md). The script
reproduces D-13's numbers exactly and exits 1 if they differ. It adds three things. All of them are
historical backtests against the HKEX official open.

- **Walk-forward.** Before each closure, β is refitted on the closures that reopened earlier, using the
  published rule. Over 87 closures (reopens 13 Aug to 22 Sep), mark/2's mean error was 68.9 bp and the last
  close's was 95.4 bp. mark/2 beat the last close on 55 of the 87. β ranged from 0.63 to 0.82.
- **Named baselines.** In the same walk-forward, pooled, the ADR alone matched mark/2 (68.6 against 68.9 bp).
  The ADR alone was better on Meituan, and the perp alone was better on Tencent. mark/2 hedges between two
  legs. It is not the best leg for each name.
- **The band.** The committed band is 25 bp plus half of r. It held 47 of the 87 walk-forward closures, and
  the pooled p68 error is 77.8 bp. On chain, the 25 bp band on the first 15 rows held 8 of 15. The page states
  both numbers.

**The first live mark/2 rows lost.** Three mark/2 rows were marked for the overnight closure that reopened at
01:30Z on 25 Sep, and all three lost to the last print (D-13 records their transactions). The signal moved the
marks up by 139, 44 and 11 bp (wTCENTx, wXIAOx, wMEITx). Each pool reopened below its last print, and the last
print's own error was 13, 336 and 193 bp. None of the three reopens landed inside its band. Against the HKEX
official open, the target this backtest scores, the signal also pointed the wrong way: D-13 records all three
names opening down. As of block 71,531,157 the record is 18 settled rows: 0 wins, 15 ties and 3 losses. Three
rows prove nothing either way, and the walk-forward lost 32 of its 87 closures. Both are shown as they are.

**Nothing in the keeper changes.** mark/2, its β and its band stay as D-13 set them while the first
out-of-sample mark/2 rows accrue. Any change will get a new method id, and no row is ever re-marked.

> **Note, ⟨DATE⟩ (D-15).** The keeper changed on ⟨DATE⟩ to fix swap decoding. The method id is unchanged: mark/2,
> its β and its band are as D-13 set them, `computeMark` is the same function, and every earlier row re-derives under
> it. What changed is that its inputs are now true, so from block ⟨N⟩ the drift term acts in lunch-recess and US
> rows. "The 25 bp band on the first 15 rows held 8 of 15" above is right; each of those bands was the 25 bp floor,
> because the drift was recorded as 0.

**Limits.** 118 closures in two months. The damping and the two-leg average were chosen on the full sample.
The target is the official open, not the pool print Scorecard settles at. The recess weight of 0 is D-13's
and is not re-tested here.

`tools/leaderboard/build.ts` writes `web/public/data/leaderboard.json` (`curb.leaderboard/1`), which holds
both records and the sha256 of every input. It refuses to write unless its recount of the rows equals
`skill()` at the same block.

---

## D-15 — Erratum: the keeper decoded no swaps, so every row before block ⟨N⟩ carries no drift, no closing VWAP and no swap evidence (⟨DATE⟩)

**Status: CORRECTED on ⟨DATE⟩ at ⟨DEPLOY_TIME⟩ (keeper code digest `⟨DIGEST⟩`, release commit `⟨RELEASE_COMMIT⟩`);
the fixed keeper's evidence starts at block ⟨N⟩. The ⟨ROWS_PRE⟩ rows committed before it stay on chain unchanged and
are documented here.**

**What was wrong.** `services/keeper/src/sources/pools.ts` decoded every pool `Swap` log with
`poolAbi.decodeEventLog("Swap", l.data, [])`. With ethers 6.17.0 an empty topics array fails the event's topic check,
so the call threw `fragment/topic mismatch` on every log, and the `catch` beside it ("a malformed log is evidence of
nothing; skip it") dropped all of them and reported nothing. Both call sites, `swapsInRange` and `scanSwaps`, carried
the line from the initial commit (`cc03fa7`, 21 Sept). The keeper never saw a swap on any pool, from its first tick.
No test fed a log through either function.

**What that did to a row.** Three inputs of a mark come from swaps, and so does one leaf of its evidence.

| | what the method says | what every row before block ⟨N⟩ got |
|---|---|---|
| swaps during the closure | if the pool traded, move the last print by half its drift from the cut to the commit | a count of 0, so the flag `no-drift` and a drift of 0, whatever the pool did |
| last print | the pool price after the last swap at or before the cut | the pool price the keeper last read before the cut (it reads every 30 s) |
| closing VWAP | the volume-weighted price of the 15 minutes before the cut, or the last print if nothing traded in them | always the last print, with the flag `no-closing-vwap` |
| evidence | the swaps behind all three, in the bundle's `swaps:<wrapper>` leaf | two empty lists |

**How far it reached.** Checked on 14 Nov 2026 against all 233 rows then on chain, their 233 archived bundles, and
Scorecard storage at block 75,902,478. The rows committed after that and before block ⟨N⟩ came from the same decoding
code and are affected in the same way.

- **Every row.** 233 of 233 (15 under `mark/1`, 218 under `mark/2`; commit blocks 71,283,582 to 75,776,412; keeper
  code digests `sha256:1d38ade9…` and `sha256:b3b4220c…`) carry `no-drift`, `no-closing-vwap`,
  `swapsDuringClosure: 0` and empty swap lists. On chain `closingVwap` equals `lastPrint` in all 233, so `skill()`'s
  two win counts have been one comparison from the first row: (232, 43, 43). Rows committed from 16 Nov until the
  deploy carry `sha256:53bf436f…`, the build of the 14 Nov redeploy, which has the same decoding line.
- **The pools were trading.** Read from the chain, not from the keeper (wTCENTx / wXIAOx / wMEITx):

  | closure | rows | keeper cut block | swaps in the 15 min before the cut | swaps from the cut to the commit | the bundles say |
  |---|---|---|---|---|---|
  | 22 Sept lunch | 0-2 | 71,280,271 | 0 / 1 / 0 | 5 / 3 / 6 | 0 and 0 |
  | 22 Sept overnight | 3-5 | 71,294,677 | 0 / 1 / 1 | not scanned | 0 and 0 |
  | 23 Sept lunch | 6-8 | 71,366,676 | 0 / 50 / 0 | 1 / 32 / 1 | 0 and 0 |
  | 23 Sept overnight | 9-11 | 71,381,082 | 2 / 25 / 0 | not scanned | 0 and 0 |
  | 24 Sept lunch | 12-14 | 71,453,081 | 0 / 118 / 0 | 1 / 103 / 0 | 0 and 0 |
  | 24 Sept overnight | 15-17 | 71,467,483 | 5 / 4 / 1 | 101 / 257 / 49 | 0 and 0 |
  | 25 Sept lunch | 18-20 | 71,539,489 | 1 / 2 / 0 | 1 / 29 / 1 | 0 and 0 |
  | 13 Nov lunch | 230-232 | 75,773,120 | 2 / 9 / 0 | 1 / 14 / 0 | 0 and 0 |

  The cut-to-commit counts come from two scans that bound a closure slightly differently, so either can differ by a
  swap or two from what the keeper would have counted. On 13 Nov the wNVDAx pool alone printed 1,418 swaps between 03:40Z
  and 07:57Z. Over all 233 rows, 146 had at least one swap in the 15 minutes before the cut.
- **The bundles show it themselves.** In 215 of the 233, the committed pool price at the commit differs from the
  committed price at the cut, in a bundle that records no swap between them. A V3 pool's price moves only on a swap.
- **Marks that should have followed the pool and did not.** 131 settled rows carry no cross-market term: the 15
  `mark/1` rows, the 102 lunch-recess rows under `mark/2` (`recess-no-edge`) and the 14 US weekend rows (`no-proxy`).
  Their rule is `mark = lastPrint × (1 + 0.5 × drift)`. With the drift recorded as 0, every one equalled the last
  print and tied. Each committed the 25-bp band floor for the same reason.
- **Marks that did not depend on it.** 102 rows applied `mark/2`'s cross-market signal (78 overnight, one of them
  never settled, and 24 over a weekend or holiday). The signal replaces the drift, so their move is what the method
  says. All 43 wins and all 55 losses on the record are in this group. Their flag should read `drift-superseded`
  where the pool moved (99 of the 102), and reads `no-drift`.
- **The last print.** In 27 rows the committed last print differs from the pool price at the keeper's cut block,
  because a swap landed between its last reading and the cut: by a median of 1.4 bp, by 5 bp or more in 3 rows, and
  by 53.7 bp in one (wXIAOx, 29 Sept lunch). In the other 206 the two are the same number.

**What the record would have read.** A replay of all 233 rows with the swaps the keeper missed, each row under its
own method exactly as written, the same reopen prints, and the corrected last print and closing VWAP as baselines
(run 14 Nov from the chain and the archive; every committed row reproduces exactly before anything is changed):

| | settled | wins / ties / losses against the last print | mean error, mark | mean error, last print | band held |
|---|---|---|---|---|---|
| as committed | 232 | 43 / 134 / 55 | 61.49 bp | 57.88 bp | 128 |
| with the swaps counted | 232 | 97 / 64 / 71 | 58.08 bp | 57.79 bp | 150 |

70 rows change outcome: 54 ties become wins and 16 become losses (40 and 10 of the 111 lunch-recess rows, 11 and 3 of
the 14 US weekend rows, 3 and 3 of the six `mark/1` overnight rows). None of the 43 wins or 55 losses changes. Against a
real closing VWAP the second tally would read 110 wins, 52 ties and 70 losses. On the whole record the corrected mark
is still slightly worse than the corrected last print (58.08 against 57.79 bp), because the 101 settled signal rows
average 109.3 bp against the last print's 100.8 bp.

Most of the gain is not forecasting. The Scorecard grades the pool's own price five minutes after the reopen, and the
pool moves little between the commit and that read: in 36 of the 111 recess rows the price graded at the reopen was,
to the wei, the pool price at the commit fifteen minutes earlier. A mark that follows the drift mostly carries a thin
pool's current price forward. The replay is in-sample, over seven and a half weeks, on three Hong Kong names that
share every closure day, and it says nothing about the Hong Kong official open. The rows keep the grades they have.

**What stands.** Every row, mark, band, baseline and grade is on chain as it was committed, and `skill()` counts them
as it always did. Each bundle still rebuilds to its committed root, and each mark still follows from its committed
inputs: the inputs were wrong, the arithmetic was not. (Six rows of two holiday closures fail a different check, which
this defect did not cause; it has its own entry.) MarketClock, the reopen times, the cross-market signal bytes and the
contract's own reopen prices do not pass through this code.

**What this record said that was wrong.**

- D-11, 22 Sept: "Not one swap occurred in any of the three pools during the 55-minute recess, nor in the 15 minutes
  before the cut." There were 15 in the recess and one in the 15 minutes before it. "The cause is plain and it is in
  the committed evidence": the evidence was the defect.
- D-11, 24 Sept: "`mark/1` cannot beat the last print on these assets, by construction: its only input is the
  wrapper's own pool, and that pool carries no information while the market is shut." `mark/1` moves with the pool,
  and the pool moved.
- The erratum of 25 Sept found the trades (15, 63 and 141, recounted here and right) and then gave a second wrong
  reason: "`mark/1` *is* the last print, so a mark/1 row can only tie the last-print baseline, whatever the pool does."
  It left the flag "to be investigated after the finale". This entry is that investigation.
- D-13: "mark/1 is the last print by construction", and for the lunch recess "The mark stays the last print". A recess
  row under `mark/2` is `mark/1`'s mark, and that moves with the pool.
- Outside this file: `docs/DEPLOYMENTS.md` ("nothing traded in the 15 minutes before any cut"), the README's Honest
  limits, the method notes on /scorecard, the notes in the paid API's answers, `docs/research/HK_CLOSURE.md`,
  `docs/SUBMISSION.md` and finding 3 of the Aave post each repeat one of these reasons. Each carries, or is getting, a
  correction or an erratum that points here.

**What it means for D-11's reasoning.** D-11 fixed in advance that if marks kept tying, the method would gain a
cross-market term. The contingency was met by the defect, not by the pools. `mark/2` was adopted on the premise that
the pool held nothing `mark/1` could use, and that premise was never tested, because the drift term never ran. On the
101 settled rows where `mark/2` applied its signal, `mark/1`'s rule with the swaps counted would have scored a mean
error of 82.3 bp, against 109.3 bp for `mark/2` and 100.8 bp for the last print. The same caveats apply in full: that
is in-sample, it grades against the pool five minutes after the reopen rather than the Hong Kong open that β was
fitted to, and most of the drift's edge is the persistence described above. It does not show that the drift forecasts
the reopen. `mark/2`'s own evidence does not depend on the keeper: D-13's fit and D-14's walk-forward read Yahoo bars
and Binance klines only, and `tools/research/hk-closures/fit.mjs --check` still passes. Whatever the comparison shows,
the rows keep the method that produced them.

**How it was found.** On 14 Nov 2026, in a read-only investigation of the open item in the 25 Sept erratum. The
keeper's log since its boot of 24 Sept 20:34Z held 218 marks, every one with `swaps=0`, `drift=0` and both flags. The
chain held 1,418 swaps on one pool in four hours. Run over blocks 75,772,400 to 75,772,499, the keeper's own
`scanSwaps` returned no rows where the node returned 19 logs, and the decode call threw on each of them.

**Why it was not caught sooner.** The `catch` was written to survive one malformed log and said nothing when it
swallowed all of them. Its output, `no-drift` and `no-closing-vwap`, read as an honest finding about a quiet pool, and
D-11 took it as one. The fact-check of 25 Sept proved the pools traded, and the flag was parked until after the
finale. The verifier re-runs the method on the committed inputs and never compares them with the committed swap
lists, so 233 empty lists verified. The cost was every row from 22 Sept to ⟨DATE⟩ (⟨ROWS_PRE⟩ rows) with incomplete
evidence, 131 of the first 233 marked without the pool's move, a second baseline that was a copy of the first, and a
wrong reason for the ties repeated in the README, on the site, in the API, in the submission and in the Aave post. It
is now disclosed.

**How it is fixed without rewriting history.** Release commit `⟨RELEASE_COMMIT⟩`, deployed ⟨DATE⟩ at ⟨DEPLOY_TIME⟩
with code digest `⟨DIGEST⟩`; the old keeper was stopped before the new one started, and block ⟨N⟩ is the chain head
read right after the deploy, before the new keeper had built any mark.

- **Decoding.** Each log is decoded with its own topics. A log no endpoint can decode is never dropped in silence: its
  block becomes a gap in the closure's scan coverage, and the keeper pages. `services/keeper/src/sources/pools.test.ts`
  decodes 18 real mainnet logs and fails on the old line.
- **The method is unchanged.** `curb.scorecard.mark/2` as D-13 published it: β, band and drift weight as written,
  `computeMark` the same function, so every earlier row still re-derives under it and the method id stays. What
  changed is that its inputs are now true. That changes what new rows do: a lunch-recess row and a US weekend row now
  move the last print by half the pool's drift from the cut to the commit, and can win or lose; their band is 25 bp
  plus half that move. An overnight or weekend Hong Kong row with the signal applied is marked as before, from a last
  print that is now the price after the last swap at or before the cut. Both baselines are now what the contract's
  NatSpec calls them: the last print before the closure, and the pool's VWAP at the closure (over the 15 minutes before
  the cut, or the last print when nothing traded in them).
- **The evidence says what was scanned.** The `swaps:<wrapper>` leaf now commits, beside the two lists, the pool and
  the event topic, the exact block ranges scanned (`closingRange`, the 900 blocks up to the cut; `closureRange`, from
  the block after the cut to the block of the commit's chain read), any `gaps`, the swap counts, a digest of the full
  closure list, and the pool's own read at the cut block (`cutRead`). A closure list longer than 10,000 swaps keeps the
  first and last 5,000 and commits the count and digest of all of them (`closureOmitted`). Old keys are unchanged, so
  the published verifier still reads these bundles.
- **What a degraded row means.** The keeper keeps filling gaps until about six and a half minutes before the reopen,
  then commits what it has, honestly, and pages:
  - `complete: false`: some blocks of the closure were not scanned in time; `gaps` lists them, and
    `swapsDuringClosure` counts the swaps recorded outside them. It is committed only when at least one swap was
    recorded or the pool price did not move, so the mark, band and baselines are those that complete evidence would
    give (the drift comes from the pool's prices at the cut and at the commit); only the count can be short.
  - `closingComplete: false`: the 15 minutes before the cut were not fully scanned, or their last swap did not match
    the pool price read at the cut. The closing list is committed empty, `closingVwap` falls back to the last print
    (flag `no-closing-vwap`), and the last print is the pool price at the cut block, bound by `cutRead` when it is present.
  - `cutRead: null`: the pool read at the cut is not committed, because the closure was opened by an earlier keeper
    build (a closure already open at a deploy). The cut price is then the keeper's own reading, as before.
  - One case is refused instead of degraded: no swap recorded and a pool price that moved. A V3 pool's price moves
    only on a swap, so that row would knowingly leave out a move; the keeper commits nothing for that closure and
    pages. It is exactly the shape of every row before block ⟨N⟩.
- **A cut the schedule does not confirm is not committed as it stands.** Host A sometimes writes a zero cap for a
  minute or so when one issuer fetch fails. If such a blip opens a closure, or runs into a real cut, the keeper now
  checks the cut against the venue schedule. If the schedule itself shuts within two keeper ticks of when the keeper
  last saw it open, the closure is re-anchored at the schedule's own cut (a recut: new cut time, cut block, cut price
  and swap file, logged as `closure-recut`); otherwise it is never committed, and the keeper pages. Whether a committed cut is a
  scheduled cut can be checked from the bundle: the committed schedule must say the market was shut at the committed
  cut time.
- The same release reads the receipt status of every transaction it sends, and keeps every holiday seen during a
  closure in the schedule it commits. Each of those has its own entry.

First row read by the fixed keeper: ⟨FIRST_ROW⟩.

**The rule for rows committed before block ⟨N⟩.** No row is re-marked and no bundle is rewritten: the archive is
write-once and the roots are on chain. The verifier in this repository decides a row's era from the block of the chain
read its bundle commits, bound to the commit block. For a row read before block ⟨N⟩ it still prints `REPRODUCED` when
the mark follows from its committed inputs, and adds notes that never change the exit code: that the build which wrote
it decoded no Swap logs, so its empty lists, `no-drift`, `no-closing-vwap` and `closingVwap = lastPrint` record what
that keeper saw, not what the pool did; where the bundle's own pool prices moved while it lists no swaps, by how much;
and where its last print is the keeper's last reading before the cut rather than the price at the cut block, by how
much. For a row read from block ⟨N⟩ the swap evidence is checked strictly: the last print, the closing VWAP and the
swap count must follow from the committed lists, the lists must agree with the committed pool prices, and anything
else is `NOT REPRODUCED`. `curb-verify` prints the notes as `EVIDENCE` lines. The npm package gets all of this in
0.2.0; until then `npx -y curb-verify` (0.1.0) prints none of it: it re-derives new rows' marks from inputs that are
now true, and treats old rows as it always did.

/scorecard, the paid API and the MCP tool say the same against those rows (each is deployed separately from the
keeper). From block ⟨N⟩ an empty swap list in a complete bundle means the pool did not trade.

**Reproduce.** The swap counts above: `eth_getLogs` for the Swap topic
`0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` on the pools in `Scorecard.priceSources`, in
100-block steps (the public RPC refuses wider ranges). The bundles: `https://archive.curb.markets/marks/<inputRoot>.json`,
whose `swaps:<wrapper>` leaves are empty and whose `markinput` leaves carry `midAtCutE18` and `midNowE18`. The decode:
`services/keeper/src/sources/pools.test.ts`.

---

## D-16 — Six holiday rows that the published verifier cannot re-derive (⟨DATE_D16⟩)

**Status: FIXED for rows read from block ⟨N⟩ (deploy 2, ⟨DATE⟩). The six rows stay on chain unchanged. Their marks,
reopen times and grades are right; their evidence does not show the holiday that justifies the reopen time.**

**What happened.** The keeper predicts a row's reopen by walking the venue schedule forward from the present, every
tick, and commits the venue schedule as it last read it, ten minutes before the reopen. The issuer's holiday list
looks forward only: it drops a holiday once it has passed. The XHKG entry for 1 Oct (`2026-09-30T16:00Z` to
`2026-10-01T16:00Z`) was last seen in a bundle on 30 Sep at 04:50Z and was gone by the 2 Oct 01:20Z commits, whose
schedule lists 19 Oct and 24–25 Dec. A verifier walks the committed schedule from the committed cut. For the 30 Sep
cut that walk reopens on Thu 1 Oct at 01:30Z, a day before the committed reopen of Fri 2 Oct at 01:30Z, and the check
fails. The 16 Oct closure failed the same way over the 19 Oct holiday. Read from the 20 Oct bundle, the issuer already
lists 24–25 Dec and 31 Dec, so without a fix the same would happen there.

| row | asset | cut (UTC) | reopen committed | commit block | input root | graded against the last print (Curb / last print, bp) |
|---|---|---|---|---|---|---|
| 41 | wTCENTx | 30 Sep 07:55:31 | 2 Oct 01:30 | 72,134,989 | `0xfa506041…` | win (25 / 26) |
| 42 | wXIAOx | 30 Sep 07:55:31 | 2 Oct 01:30 | 72,134,994 | `0x3dafc1b6…` | loss (125 / 113) |
| 43 | wMEITx | 30 Sep 07:55:31 | 2 Oct 01:30 | 72,134,999 | `0xd81c7e07…` | loss (61 / 52) |
| 113 | wTCENTx | 16 Oct 07:55:37 | 20 Oct 01:30 | 73,690,190 | `0xf1da8c47…` | win (16 / 92) |
| 114 | wXIAOx | 16 Oct 07:55:37 | 20 Oct 01:30 | 73,690,194 | `0x4db753ad…` | loss (154 / 55) |
| 115 | wMEITx | 16 Oct 07:55:37 | 20 Oct 01:30 | 73,690,199 | `0x67daecc7…` | win (130 / 214) |

What `curb-verify` (0.1.0, and this repository before deploy 2) prints for each of them, here for row 41:

```
  FAIL    reopen mismatch for wTCENTx: schedule gives 1790818200, row settles after 1790904600
  NOT REPRODUCED
```

The marks re-derive; only the reopen check fails. This was not caused by the swap defect of D-15, and nothing about it
changes the grades: the rows settled after the reopens they predicted, and the contract read the reopen price itself.

**What this record said that was wrong.** D-10: "Holidays need no special case … 30 Sep predicts 2 Oct" (true of the
prediction, not of the evidence), and "A verifier re-runs the same pure function and either gets the same instant or
catches us": for these six rows it gets a different instant without anything being wrong. D-10 carries a note.

**The fix (deploy 2).** Each open closure keeps a holiday ledger: the union of every holiday list the keeper read
during the closure. An entry the issuer drops after its start, or less than 24 hours before it, is kept, because that
is the forward-only pruning above. An entry withdrawn more than 24 hours before its start is dropped, because that is
a correction (the issuer withdrew two mistaken XHKG entries 7 to 10 days ahead on 18 Sept, D-4). The schedule a row is
predicted with and committed with is the latest read plus the kept entries, and the venue leaf says which entries were
kept and since when the ledger ran (`holidaysKept`, `latestReadAtMs`, `holidayLedgerSinceMs`). Before signing, the
keeper walks the committed schedule from the cut and refuses to commit unless it gives the committed reopen. With the
pruned entry added back, the cut-walk of the 2 Oct and 20 Oct bundles gives `2026-10-02T01:30:00Z` and
`2026-10-20T01:30:00Z`, their committed reopens.

It had to be running before the Thanksgiving closure (cut Thu 26 Nov 00:55Z, reopen Fri 27 Nov 01:00Z): walked from
that cut, the US schedule gives 27 Nov with the entry and 26 Nov without it, so a row committed after the issuer
pruned it would have failed like these six. The 27 Nov early close (rows of Mon 30 Nov) is the second case.

One risk is accepted with the 24-hour margin: an entry the issuer withdraws on the day itself (a typhoon closure
cancelled hours ahead, say) is kept, the predicted reopen is a day late, capacity returns first, and that closure gets
no row. The keeper pages it as `closure-missed`.

**What the verifier says now about the six.** For rows read before block ⟨N⟩ only, when the walk from the cut misses
the committed reopen, the verifier in this repository walks the same committed schedule from the commit instant,
which is how the keeper computed the reopen. It accepts the row if, and only if, the walk from the cut lands before
the commit and the walk from the commit gives the committed reopen, and it prints `REPRODUCED` with a note that never
changes the exit code (one line; here for the 2 Oct rows):

```
  EVIDENCE reopen re-derived from the commit instant: walked from the cut, the committed schedule gives 2026-10-01T01:30:00.000Z, before the commit at <evaluatedAt>; walked from the commit instant it gives the committed settleAfter 2026-10-02T01:30:00.000Z, which is how the keeper computed it. The bundle does not show whether a holiday dropped from the issuer's list or the closure was not continuous.
```

The note is worded to say only what the bytes show. The rule cannot prove the market stayed shut from the cut to the
commit: a keeper that was down across a reopen would write exactly such a row, and the rule would accept it. That is
why the cause for these six is stated here, from the issuer's lists, and not by the tool. Over the 233 bundles archived
by 14 Nov the rule fires on exactly these six roots. Before the repository is pushed and before npm 0.2.0, the set of
rows that get this note must be exactly these six; the run over every row before block ⟨N⟩ gave: ⟨E6_GATE⟩. Rows read
from block ⟨N⟩ never get the fallback. `npx -y curb-verify` (0.1.0) keeps printing `NOT REPRODUCED` for the six until
0.2.0 is published.

---

## D-17 — One row was never graded: a reverted settle was counted as settled (28 Oct 2026, disclosed ⟨DATE_D16⟩)

**Status: FIXED from deploy 2 (⟨DATE⟩): the keeper reads the status of every transaction it sends. Row 151 can never
be graded. It stays on chain, committed and unsettled, and `skill()` counts 232 settled of the 233 rows committed by
14 Nov.**

**What happened.** Row 151: wTCENTx, the 27→28 Oct overnight closure, committed 28 Oct at 01:20:09Z (block 74,381,373,
tx `0x5b77fe39…28ff`, id `0xfc88b5db…2ecf`), reopen 01:30:00Z. On chain its mark is `49941465598571907502` and its
last print `49218252594941832220` (USD per share × 10¹⁸: 49.94146… and 49.21825…; `curb-verify` prints the mark
truncated to four decimals, 49.9414), band 118 bp. The keeper's settle,
[`0x287805da…9af5`](https://www.oklink.com/xlayer/tx/0x287805daf1ad38c0cfc6a89d53f75857475c53dd825b86db7e7c065f55ca9af5),
was mined in block 74,382,270 at 01:35:06Z with status 0: reverted, 118,167 gas, no logs. Replayed at the block before
it, `settle(id)` reverts `PriceDeviates(-237294, -237347)`: the pool's spot sat 53 ticks from its 120-second average,
and the guard allows 50. The keeper had simulated the call a block or two earlier, when it would have succeeded; a
swap at 01:35:02Z moved the spot before its transaction landed. The other two rows of that closure settled in blocks
74,382,272 and 74,382,274.

`settlePass` did not read the receipt's status. It logged the row as settled, dropped it from the rows it owed, and
never retried. A settle at any moment from 01:35:11Z to about 07:25Z would have succeeded. The six-hour window closed
at 07:35:00Z (`settleAfter` + 300 s + 6 h), and `settle` now reverts `TooLate`. The keeper's `/healthz` counted 218
settles since its 24 Sept boot; the chain holds 217. The commit path had the same omission; no commit has reverted
(every commitment the keeper recorded exists on chain).

Not a hidden win: had the settle read the pool at the spot of that moment (tick −237294, price 49.5422), the mark's
error would have been about 81 bp and the last print's about 65 bp. That is an estimate; a settle at any later moment
would have read a different price.

**What the public surfaces said.** The MCP tool labels the row `expired-unsettled`, which is right. /scorecard counts
it as waiting ("1 more mark is committed and waiting for the reopen", and the row as pending), which is wrong, and the
paid discount curve reports it in `pendingSettlement`. The README's Honest limits names the row.

**The fix (deploy 2).** Every transaction goes through one send path that reads the receipt: a reverted settle stays
owed and is retried on later ticks inside its window, and pages if it is still owed an hour after it became settleable;
a window that closes moves the row to an `expired` list and pages; a reverted commit pages; a replaced transaction that
mines instead of the keeper's own is never taken for it. Each tick the keeper also checks its books against Scorecard
and pages when they disagree. The guard trips on about 3% of settles (6 of 218 since 24 Sept, 5 of them caught in
simulation), because the keeper settles on the first tick after the reopen plus 300 s, when the pool is busiest; a
retry inside the window removes the loss.

**What the verifier says.** `curb-verify tx` on the commit transaction of such a row prints, as its `settled`
field, `not settled; settle window closed <deadline> (TooLate: this row can no longer be graded)`; for row 151 the
deadline is `2026-10-28T07:35:00Z` (in this repository from the `curb-verify` 0.2.0 change, on npm once 0.2.0 is
published). No row is re-committed or re-marked; row 151 keeps its mark and has no grade.
