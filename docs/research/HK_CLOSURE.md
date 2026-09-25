# Hong Kong closures: what trades while HKEX is shut, and how well it predicts the reopen

This is the research behind `curb.scorecard.mark/2` ([D-13](../DECISIONS.md)) and its out-of-sample
check ([D-14](../DECISIONS.md)). The whole study is one offline script over committed data:

```sh
node tools/research/hk-closures/fit.mjs            # writes tools/research/hk-closures/out/results.json
node tools/research/hk-closures/fit.mjs --check    # exits 1 unless results.json is exactly what it would write
```

It reproduces D-13's published numbers exactly, and exits 1 if it does not. The Yahoo files were fetched on
24 Sep 2026, and their last bars are from that day. A closed Binance minute does not change. The backtest was
extended and run on 25 Sep 2026. Everything below is a **historical backtest**, unless a section says it is
on chain.

---

## The question

While HKEX was shut, the wrapper pools on X Layer did not trade in any of the 15 closures D-11 graded, so
every mark/1 mark equalled the last print. Other markets do trade: a Binance perpetual on the same share around the clock, and the
US ADR during US hours. How much of the Hong Kong reopen gap do they predict, measured before the reopen?

## Sample

One row per overnight or weekend closure of the primary share behind each of three wrappers.

| wrapper | primary | ADR (shares per ADR) | perpetual | first cut | closures |
|---|---|---|---|---|---|
| wTCENTx | 0700.HK | TCEHY (1) | HK0700USDT | 22 Jul | 44 |
| wXIAOx | 1810.HK | XIACY (5) | HK1810USDT | 22 Jul | 44 |
| wMEITx | 3690.HK | MPNGY (2) | MEITUANUSDT | 11 Aug | 30 |

That gives 118 closures: 94 overnight and 24 over a weekend or holiday. The last reopen is 22 Sep 2026
at 01:30Z. The nights behind the six D-11 overnight rows (reopen 23 and 24 Sep) are left out, as D-13 left
them out, and so is every lunch recess. In 3 closures the ADR bar is missing and the perp leg is used
alone. No closure lacks the perp.

## Data sources

All files are in `tools/research/hk-closures/data/`. `results.json` records the sha256 of each file the
script reads, and `tools/leaderboard/build.ts` re-hashes them before it uses the results.

| file | source | read by fit.mjs |
|---|---|---|
| `0700.HK.1y.json`, `1810.HK.1y.json`, `3690.HK.1y.json` | Yahoo chart API, daily bars over one year: `https://query1.finance.yahoo.com/v8/finance/chart/0700.HK?interval=1d&range=1y` (same for each ticker). The official HKEX open and close. | yes |
| `TCEHY.1y.json`, `XIACY.1y.json`, `MPNGY.1y.json` | the same API, the three ADRs (OTC Markets, USD) | yes |
| `HKD=X.1y.json` | the same API, USD/HKD | yes |
| `klines-cache.json` | Binance USDⓈ-M one-minute klines, `https://fapi.binance.com/fapi/v1/klines?symbol=HK0700USDT&interval=1m&startTime=<ms>&limit=1`, keyed by that exact URL: 236 responses, the 07:54Z and 01:19Z minutes of every closure | yes |
| `fit.json` | the output of D-13's original run (24 Sep), kept as it was written | no |
| `rows.json` | the 15 Scorecard rows as read on 24 Sep | no |
| `0700.HK.1h.json`, `TCEHY.1h*.json`, `TCEHY.5m.json`, `TCEHY.p.json`, `HKD.5d.json`, `spark.1d.json`, `cnbc.TCEHY.*.json` | intraday probes from the D-13 source survey (Yahoo, CNBC) | no |

A closed Binance minute is byte-identical on refetch (D-13), so anyone outside the US can check the klines
cache against Binance. Binance answers HTTP 451 to US IPs. Yahoo's bytes are not reproducible on refetch,
so the committed files are the evidence for the other two legs. The script runs offline. `--fetch` only
fills a klines cache miss.

## Method

For a closure from the close on day D to the open on day D':

    y      = HK open(D') / HK close(D) − 1                        the gap to predict
    r_perp = perp close(01:19Z minute, D') / perp close(07:54Z minute, D) − 1
    r_adr  = ADR close(last US session ending inside the closure) × USD/HKD / sharesPerADR / HK close(D) − 1
    r      = mean(r_perp, r_adr), or the one leg that exists

The perp window runs from the issuer's 15:55 HKT cut to 09:20 HKT, when the keeper commits (ten minutes
before the reopen). β is an OLS fit of y on r through the origin, pooled across the three names. The
published rule is `β = round(0.8 × pooled fit, 2)`, clamped to [0, 1].

**Four estimators of the gap**, all scored on the same closures:

| estimator | predicted gap |
|---|---|
| last close | 0: the HK close itself. This is the baseline Scorecard grades against. |
| perp alone | r_perp, applied in full (β 1) |
| ADR alone | r_adr, applied in full (β 1); the last close where the ADR bar is missing |
| mark/2 | β × r |

**Error.** |estimate − HK open| / HK close, in bp. For a mark `close × (1 + β r)` this is exactly |y − β r|.
This is D-13's metric. Scorecard divides by the reopen print instead. The band section counts how many
coverage calls that difference changes.

**Win.** Strict, as Scorecard counts: the estimator's error must be smaller than the last close's. mark/2
has no exact ties in this sample. A single leg ties when it predicts no move at all: the ADR where its bar
is missing (3 closures), and the perp where its price did not change (1 walk-forward closure, 3 in-sample).

**Direction.** The estimator's sign matches the gap's sign. This is counted only on closures where both the
estimate and the gap are non-zero, so the denominator is below n.

**Quantiles.** Nearest rank on the absolute errors.

**Walk-forward.** Closures are taken in reopen order. Each one is marked with the published rule applied to a
fit on the closures whose reopen date is strictly earlier. The other names' closures from the same night are
excluded, because their opens are not known at 01:20Z. No closure is marked until 30 earlier closures exist.
That warm-up covers the first 31 closures, so the walk-forward scores 87 closures, reopening 13 Aug to 22
Sep. Over that run β ranged from 0.63 to 0.82 and ended at 0.77.

**Band.** This is the keeper's rule for the band committed with each mark (`services/keeper/src/mark.ts`):
`min(2000, max(25, 25 + floor(|r| / 2)))` bp. Here r is the mean of the legs in whole bp, each leg
truncated toward zero, and any leg beyond ±2000 bp set aside. A closure is covered when its error is at most
its band.

## Results

### D-13, reproduced

| | pooled | Tencent | Xiaomi | Meituan |
|---|---|---|---|---|
| closures | 118 | 44 | 44 | 30 |
| fitted β | 0.983 (se 0.093) | 1.048 | 0.901 | 0.976 |
| last close, mean error (bp) | 94.3 | 92.7 | 96.6 | 93.2 |
| mark/2 at β 0.79, mean error (bp) | 68.1 | 58.2 | 78.5 | 67.3 |

The pooled uncentred R² is 0.486. The published β is round(0.8 × 0.983, 2) = 0.79. Every figure D-13
printed matches to the digit it printed.

### Walk-forward (out of sample)

Mean absolute error in bp, 87 closures reopening 13 Aug to 22 Sep.

| closures | n | last close | perp alone | ADR alone | mark/2 | mark/2 beat last close | mark/2 direction right |
|---|---|---|---|---|---|---|---|
| Tencent (wTCENTx) | 29 | 106.7 | **50.4** | 67.8 | 63.1 | 21 of 29 | 22 of 27 (81%) |
| Xiaomi (wXIAOx) | 29 | 85.8 | 83.4 | 80.7 | **72.5** | 15 of 29 | 16 of 25 (64%) |
| Meituan (wMEITx) | 29 | 93.7 | 94.5 | **57.2** | 71.1 | 19 of 29 | 20 of 25 (80%) |
| all three | 87 | 95.4 | 76.1 | **68.6** | 68.9 | 55 of 87 | 58 of 77 (75%) |
| overnight | 69 | 95.7 | 78.5 | **68.8** | 69.0 | 43 of 69 | 46 of 61 (75%) |
| weekend or holiday | 18 | 94.0 | **66.9** | 67.7 | 68.6 | 12 of 18 | 12 of 16 (75%) |

For comparison, the single legs beat the last close on 51 of 87 closures (perp) and 59 of 87 (ADR). They
called the direction right on 55 of 76 (perp) and 62 of 74 (ADR).

### In-sample

The same 118 closures that β was fitted on, at β 0.79. These numbers flatter mark/2.

| closures | n | last close | perp alone | ADR alone | mark/2 | mark/2 beat last close | mark/2 direction right |
|---|---|---|---|---|---|---|---|
| Tencent (wTCENTx) | 44 | 92.7 | 62.2 | 65.5 | **58.2** | 28 of 44 | 33 of 41 (80%) |
| Xiaomi (wXIAOx) | 44 | 96.6 | 97.2 | 88.5 | **78.5** | 22 of 44 | 24 of 39 (62%) |
| Meituan (wMEITx) | 30 | 93.2 | 94.2 | **55.6** | 67.3 | 19 of 30 | 21 of 26 (81%) |
| all three | 118 | 94.3 | 83.4 | 71.5 | **68.1** | 69 of 118 | 78 of 106 (74%) |
| overnight | 94 | 96.8 | 87.7 | 72.3 | **69.6** | 54 of 94 | 61 of 84 (73%) |
| weekend or holiday | 24 | 84.7 | 66.4 | 68.5 | **62.1** | 15 of 24 | 17 of 22 (77%) |

### Residuals

mark/2's absolute error in bp (nearest rank):

| | walk-forward p50 | p68 | p90 | in-sample p50 | p68 | p90 |
|---|---|---|---|---|---|---|
| Tencent | 62.8 | 77.8 | 125.0 | 58.5 | 70.6 | 105.0 |
| Xiaomi | 42.0 | 57.2 | 172.6 | 44.2 | 82.5 | 135.9 |
| Meituan | 56.1 | 92.1 | 179.4 | 51.4 | 81.2 | 115.9 |
| all three | 56.1 | **77.8** | 132.2 | 52.6 | **76.0** | 128.2 |
| overnight | 54.5 | 76.7 | 134.9 | 53.7 | 76.0 | 134.3 |
| weekend or holiday | 56.1 | 79.0 | 128.9 | 51.4 | 70.6 | 119.5 |

### The committed band

| | closures | mark/2 band (25 bp + half of r) held | a flat 25 bp band held | band width, min / median / max |
|---|---|---|---|---|
| walk-forward | 87 | 47 (54%) | 14 (16%) | 25 / 52 / 188 bp |
| in-sample | 118 | 65 (55%) | 22 (19%) | 25 / 53 / 188 bp |

Scored with the contract's metric instead, where the error is divided by the reopen print and floored,
one in-sample coverage call changes and no walk-forward call changes.

**The band is not a confidence interval.** It is a floor of 25 bp plus half the signal's move, and it held
about half the time. A band that held 68% of the time would need to be about 78 bp wide, which is the pooled
walk-forward p68.

### On chain, for contrast

This is Scorecard v2 at block 71,531,157 (25 Sep 2026, 01:36:33Z). It holds 18 settled rows, and
`skill()` equals the strict recount: 18 settled, 0 beat the last print, 0 beat the closing VWAP.

- **15 rows under `curb.scorecard.mark/1`:** 0 wins, 15 ties, 0 losses. In none of them did the mark move off
  the last print. Each row committed a 25 bp band, and the reopen print landed inside it on 8 of the 15.
- **The first 3 rows under `curb.scorecard.mark/2`:** these are the first live out-of-sample marks, for the
  overnight closure that reopened at 01:30Z on 25 Sep. All three lost to the last print. The signal moved each
  mark up. Every pool reopened below its last print.

| asset | mark moved | band | reopen vs last print | Curb error | last-print error | commit | settle |
|---|---|---|---|---|---|---|---|
| wTCENTx | +139 bp | 113 bp | −13 bp | 152 bp | 13 bp | [`0xebd87019…62f4`](https://www.oklink.com/xlayer/tx/0xebd87019a2c1bef804e09ed5c5ab606568565bbc1f148c9a1bf1e3b104f062f4) | [`0x5ca722b5…ed0e`](https://www.oklink.com/xlayer/tx/0x5ca722b538a42ca7ca20d5bb447f5d98be518c8a9d5d7d21e53480035c13ed0e) |
| wXIAOx | +44 bp | 53 bp | −336 bp | 381 bp | 336 bp | [`0x90125dac…3104`](https://www.oklink.com/xlayer/tx/0x90125dac7ec5d6332131fe94e0b48b254e37f59580780551b94b3b695e673104) | [`0x37f5b51b…a142`](https://www.oklink.com/xlayer/tx/0x37f5b51b4eb4e594cac66083ae38ccccba0fd684e18a9b1613148fc56474a142) |
| wMEITx | +11 bp | 32 bp | −193 bp | 204 bp | 193 bp | [`0x7e9104f8…9b29`](https://www.oklink.com/xlayer/tx/0x7e9104f844718fcf6f11c934f891ae4a8329da92dc1a558b6dd3d5e3e39a9b29) | [`0x55d3a7c7…fb4c`](https://www.oklink.com/xlayer/tx/0x55d3a7c7dec45134dc06ab235c2c1814ef58b65320a721a5b7fb90d844fafb4c) |

All 18 rows were settled by the Curb keeper, `0xd3D9…1AF6`. The "mark moved" column is truncated to whole
bp. The reopen column is the last-print error, and its sign comes from the two prices. Three rows prove
nothing either way (D-13). The walk-forward backtest lost to the last close on 32 of 87 closures. The live
tally is on [curb.markets/scorecard](https://curb.markets/scorecard). `web/public/data/leaderboard.json`
holds the snapshot the site was built with.

## What it says

- **Out of sample, mark/2 cut the mean error against the HK open by about 28%:** 95.4 bp for the last close
  against 68.9 bp for mark/2, over 87 closures, 55 of them wins. The in-sample cut was similar (94.3 → 68.1).
  The walk-forward β stayed between 0.63 and 0.82, so the edge does not depend on fitting β after the fact.
- **The average of the two legs is not the best single estimator for each name.** Out of sample, the perp
  alone was best on Tencent (50.4 bp), the ADR alone was best on Meituan (57.2 bp), and pooled, the ADR alone
  (68.6) matched mark/2 (68.9). mark/2 was never the worst of the three signals on any name, and it was
  the best on Xiaomi, the noisiest name. It hedges between two legs that each fail on some name. It is
  not an optimum.
- **Xiaomi is the weak name:** its direction is right 64% of the time out of sample, and its p90 error is
  173 bp.
- **Weekends are no harder than single nights** in this sample (68.6 against 69.0 bp out of sample), but
  there are only 18 of them.

## Limits

- **Sample size.** 118 closures in two months, and 87 out of sample, with 29 per name. It is one market
  regime. A difference of a few bp between estimators is inside the noise. For example, the pooled
  difference between ADR alone and mark/2 is 0.3 bp.
- **In-sample against walk-forward.** β 0.79 was fitted on all 118 closures and is in-sample by
  construction. The walk-forward refits β before each closure, but the rule it applies, including the damping
  factor 0.8 and the choice to average the two legs, was chosen after seeing the whole sample. The
  walk-forward is out of sample for β, not for the design.
- **The target is not the one Scorecard grades.** The backtest predicts the HKEX official open (the opening
  auction) from the official close. Scorecard grades a mark against the wrapper pool's TWAP-guarded price
  at least 300 s after the reopen, from the pool's last print before the cut. D-11 found that pool reopens
  move 30 to 105 bp. D-13 replayed its six overnight rows the way Scorecard grades them: mark/2 won 4 of 6
  with a slightly worse mean error (47.0 against 44.3 bp). Only the live record can settle this.
- **The lunch recess is not tested here, and it has weight 0 in mark/2.** D-13 set the recess weight to
  zero after 23 recesses in which the perp-adjusted mark lost to the last print on all three names. That
  analysis used minute data this folder does not hold, so `fit.mjs` does not reproduce it. On chain, every
  recess row under mark/2 is mark/1's mark by construction, and it can only tie.
- **Timing is idealised.** The backtest uses the scheduled 07:55Z cut and a 01:20Z commit. The keeper uses the
  cut it observed and commits 600 s before the reopen it derived (D-10, D-11). The ADR leg here uses daily bars.
  The keeper reads hourly bars over five days (`yahooChartUrl`). Both give the same session close when Yahoo
  is consistent.
- **Selection.** These are the three Hong Kong names that have both a perpetual and an ADR. wSHEINx has
  no Scorecard price source, and the US names have no proxy that trades while they are shut.
- **Yahoo is not reproducible.** The perp leg can be refetched and compared byte for byte. The ADR, FX
  and HK bars can only be checked against the committed files.

## Files

| path | what |
|---|---|
| `tools/research/hk-closures/fit.mjs` | the study, offline, deterministic (no timestamp in its output) |
| `tools/research/hk-closures/data/` | its inputs (above) |
| `tools/research/hk-closures/out/results.json` | `curb.hk-closures.results/1`: D-13's figures, both evaluations by name, pooled and by closure length, the band, and every row with its walk-forward β |
| `tools/leaderboard/build.ts` | reads Scorecard v2 at one block with curb-asp's own index, asserts the recount equals `skill()`, and writes `web/public/data/leaderboard.json` (`curb.leaderboard/1`) with the on-chain rows and this backtest kept apart |
| `tools/leaderboard/leaderboard.test.ts` | checks that `results.json` is current, that walk-forward never looks ahead, and that the on-chain tally in `leaderboard.json` is a strict recount matching `skill()` and matches what the page computes live |
