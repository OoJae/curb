# Verifying Curb

Curb writes two kinds of number to X Layer mainnet (chain 196):

- **MarketClock rounds**: whether each tokenized equity's home market is open, and how much it will
  take. `attestBatch` on [`0x160Dc415902971a7a9B5ade7f43005b36FE5B09b`](https://www.oklink.com/xlayer/address/0x160Dc415902971a7a9B5ade7f43005b36FE5B09b).
- **Scorecard marks**: what an asset is worth while its market is shut, committed before the reopen and
  graded against it afterwards. `commit` on [`0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f`](https://www.oklink.com/xlayer/address/0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f).

Every write commits an `inputRoot`, a Merkle root over the exact inputs used. The inputs are published
as a bundle at `https://archive.curb.markets/{rounds,marks}/<inputRoot>.json`. Objects there are under
an indefinite bucket lock, so nobody can delete or rewrite them, including Curb. `curb-verify` fetches
the bundle, rebuilds the root, and re-runs the committed method on the committed inputs. Then it
checks the result against what the transaction actually wrote.

## The one-liner

Take any Curb transaction hash from OKLink:

```sh
npx -y curb-verify tx 0x8e87d0f08af4025a742c377dce985449b3b131b3a61e64b0bb793b822fcd47e1
```

This needs Node 22.18 or newer (`node --version`). There is nothing else to install and no key or
account. `curb-verify` is published on npm by Curb (maintainer `oojae`, 25 Sep 2026; the package is built from this
repository's `tools/curb-verify`). `npx -y github:OoJae/curb` runs the same code straight from GitHub. That hash is the first round MarketClock ever received. The output:

```
(hashes shortened here; the tool prints them in full)
round 0xe48cde50188a98adf457f121f308c89f29176b92ccc56728f2e0647f992956b5
  tx         0x8e87…47e1  block 70,617,365  2026-09-14T11:46:41Z
  attestor   0x842e9eee514c419183ca79d4cb0dc30ad29feec4
  source     https://…/rounds/0xe48c…56b5.json
  method     curb.marketclock.derive/1
  evaluated  2026-09-14T11:46:40Z
  claims     XIAOx:CLOSED TCENTx:CLOSED AAPLx:EXTENDED NVDAx:EXTENDED MEITx:CLOSED SHEINx:CLOSED
  LABEL   top-level kind="diff" contradicts committed PARAMS.kind="heartbeat"
  REPRODUCED  (but the uncommitted labels disagree -- see LABEL above)
```

`REPRODUCED` means the number on chain follows from the published evidence. This first round also
shows the second kind of finding. A convenience label outside the Merkle tree is wrong, and the tool
says so without calling the round wrong. A committed Scorecard mark works the same way:

```sh
npx -y curb-verify tx 0x1c839166a27d48e30a51da725b07e3b57bd00a6cc173395838e15d4b6481294e
```

To see the tool reject something, run `npx -y curb-verify selftest`. It verifies two real mainnet
rounds that ship inside the package, then replaces a committed preimage in each and shows the check
failing. It needs no network. From 0.2.0 (and in this repository) it also verifies two real mainnet
marks: the 2 Oct holiday row `0x3dafc1b6…`, whose reopen re-derives only from the commit instant (see
"The six holiday rows" below), and the 13 Nov lunch-recess row `0x06a92e82…`, written by a keeper that
decoded no swaps; it checks that each gets its `EVIDENCE` notes, changes the committed mark in the
second and shows that failing, and prints the build's era cutover, `era cutover: block <N>` or
`era cutover: NOT SET (pre-release build)`, before `selftest passed: <k> checks over 2 real mainnet
rounds and 2 real mainnet marks, no network`.

## Exit codes

| code | meaning | what to conclude |
|---|---|---|
| **0** | verified | The bundle rebuilds to the committed root, and re-running the committed method on its inputs gives exactly what the transaction wrote. A `LABEL` line may still report an uncommitted convenience field that disagrees; that does not change the number. `EVIDENCE` lines may say what a row's evidence does not record (see below); they never change the exit code either. |
| **1** | NOT reproduced | The published evidence does not back the number on chain. Every failure is printed, none elided. |
| **2** | usage error | Bad arguments: not a 32-byte hash, a malformed range, a plain-`http` archive. Nothing was checked. |
| **3** | unavailable | Nothing was concluded. The RPC or every archive was unreachable, or no archive serves this bundle yet. Try again, or pass `--archive` / `--rpc`. This is never an accusation. |
| **4** | unsupported | Not something this version verifies: a transaction that is not a Curb `attestBatch` or `commit` (or that reverted, so it wrote nothing), or a bundle whose schema this version does not know. |

`range` exits with its worst item: any 1 first, then 4, then 3.

## Other commands

```sh
npx -y curb-verify range 70617365..70620000     # every Curb write in a block range; "..latest" works
npx -y curb-verify bundle <inputRoot|url|path>  # a bundle on its own, offline, without the chain side
npx -y curb-verify witness <inputRoot|url|path> # recover the signer of host B's witness statement
npx -y curb-verify tx <hash> --json             # one JSON object per item, for scripts
```

- `--archive <base>` (repeatable) sets where evidence comes from, tried in order. The default is
  `https://archive.curb.markets`, then host A (`https://attestor-a-production.up.railway.app`, which
  serves rounds only).
- `--rpc <url>` (repeatable) sets the X Layer RPC. The default is `https://rpc.xlayer.tech`, then
  `https://xlayer.drpc.org`. Use your own node if you do not want to trust a public one about what the
  transaction says.
- Plain `http` is refused except on loopback, because a network in the middle could rewrite it.

## What `tx` checks

For a **round** (`checkRound`, the same function host B runs to witness every round):

- the transaction called `attestBatch` on MarketClock and succeeded; the `inputRoot` comes from its
  calldata, never from the archive;
- every leaf's preimage hashes to its leaf, and the tree rebuilds to that root;
- re-running the committed derivation method on the committed issuer responses reproduces every claim
  exactly, and the calldata writes exactly those claims, in order;
- the method was valid at that block, the committed chain id and contract match, the pinned chain read
  comes before the write, and the inputs were fresh when written. A replay of stale evidence fails.

For a **mark** (`checkMarkRound`):

- the transaction called `commit` on Scorecard and succeeded, and its `ClosureCommitted` event agrees
  with the calldata;
- the bundle rebuilds to the committed root, and re-running the committed mark method on the committed
  inputs gives the committed mark, band and baselines;
- the closure id equals `keccak256(wrapper, settleAfter, inputRoot)` and the method digest equals
  `keccak256(method)`;
- the committed reopen time re-derives from the committed venue schedule, walked from the cut (six rows of
  two 2026 holiday closures re-derive only from the commit instant; see "The six holiday rows" below);
- the mark was committed before the reopen it predicts, and after the cut it describes; if the row is
  settled, it settled no earlier than `settleAfter + 300 s`, and if it is not, whether its settle window is
  still open or has closed (a row whose window closed can never be graded);
- the price source the bundle names for the wrapper is the one `Scorecard.priceSources(wrapper)` returns
  (one `eth_call` at `latest`). A mismatch fails the row (`REGISTRY entry for <symbol> (pool, equityIsToken0,
  decimals) is not Scorecard.priceSources: …`). A read that fails, or answers no pool, is only a `warn`
  line, because the comparison could not be made;
- for a row whose evidence was read from block 76,038,603 on, the swap evidence itself: the committed swap lists
  lie inside the committed block ranges, the last print, the closing VWAP and the swap count follow from
  them, the last closing swap is the pool price at the cut, the last closure swap is the pool price at the
  commit (or, with no swaps, the price did not move), the committed pool read at the cut prices to the
  committed cut mid, the list digest and counts match, and the committed schedule says the market was shut
  at the committed cut. Any mismatch is a failure, so `NOT REPRODUCED`.

**Not checked:** the chain reads a bundle commits to (block hash and raw return data) are covered by
the root, but they are not re-queried against an archive node. The issuer's API responses are not
re-fetched either, because that API only serves the present. What gets re-run is the copy the bundle
committed to. The pools' Swap logs are not re-fetched either: from block 76,038,603 the committed lists are
checked against the committed ranges and pool prices, but a log the keeper never saw would be missed by
both. Before block 76,038,603 the swap lists were not checked at all, only the method re-run on the committed
inputs, and that is the gap a keeper defect went through: every row committed before block 76,038,603 has empty
swap lists and a swap count of 0 whatever the pool did ([DECISIONS D-15](DECISIONS.md)). The verifier
prints `EVIDENCE` lines saying so on each of those rows, and still prints `REPRODUCED`, because the mark
does follow from what was committed.

## `EVIDENCE` lines

An `EVIDENCE` line describes what a row's evidence does or does not record. It is printed after the
checks, every one, never elided, and it never changes the exit code. Which lines a mark can get depends on
its era, decided from the block of the chain read its bundle commits (online, that block must also be at
most 1,800 blocks before the commit). A bundle with no usable chain read is checked as the newer era. With
`--json`, the same notes are in an `evidence` field beside `ok`, which keeps its meaning.

Each note is printed on one line, as `  EVIDENCE <note>`; the examples below are those lines verbatim,
with `<…>` for the values. `tx` also prints, for every mark, `flags`, `drift <d> bp` and a `swaps` field:
`not recorded (pre-fix keeper)` before block 76,038,603, and from it `closing <a> in <from>..<to>, closure <b> in
<from>..<to>`, followed where they apply by `, gaps <from>..<to> …`, `, closing window not committed` or
`, truncated (<n> total)`. `bundle` prints an `era` field, `<era> (offline: the era is bound to the commit block
only by 'tx')`, and a bundle with no usable chain read gets the note `era unknown: checked as swap-evidence`.
`range` adds `(<k> from evidence known to omit pool swaps: rows read before block <N>)` to its summary, and lists
every row whose reopen re-derived from the commit instant.

**Rows read before block 76,038,603** (every row committed until 16 Nov 2026). The keeper that wrote them decoded no pool
Swap logs, so every such row gets this line:

```
  EVIDENCE pre-fix row (evidence read at block <b>, before block 76,038,603): the keeper build that wrote it decoded no pool Swap logs (DECISIONS D-15). Its swap lists are empty whether or not the pool traded; no-drift, no-closing-vwap and closingVwap = lastPrint record what that keeper saw, not what the pool did.
```

A build in which the era's first block is not yet set (a pre-release build: `selftest` prints `era cutover:
NOT SET`) checks every row as pre-fix, and the parenthesis reads `(evidence read at block <b>; this build sets
no first block for the swap-evidence era)` instead.

Where the bundle's own numbers show it, one or both of these follow (215 and 27 of the first 233 rows):

```
  EVIDENCE the bundle's own pool reads moved <±x.x> bp between the cut and the commit while it lists 0 swaps.
  EVIDENCE lastPrint is the keeper's last pre-cut reading, <±x.x> bp from the pool mid at the cut block.
```

A V3 pool's price moves only on a swap. The closing line of such a row is `  REPRODUCED  (from the evidence as
published; that evidence omits pool swaps -- see EVIDENCE above)`, and `  REPRODUCED  (pre-fix row: swap
evidence was not recorded -- see EVIDENCE above)` when neither of the two applies.

A pre-fix bundle that does list swaps (none of the archived rows; a rebuilt test round, say) gets
`pre-fix row (…): swap lists present but not checked.` instead of the first line (a newer-format bundle with
empty lists, `swap evidence present but not checked.`), plus a line for each committed
figure that does not follow from its lists (`committed swapsDuringClosure=<n> but closureSwaps lists <m> rows.`,
`committed closingVwap <x> is not the volume-weighted price of the <k> committed closing swaps (<y>).`,
`committed lastPrint <x> is not the price after the last committed closing swap (<y>).`). Unless one of the two
lines above applies, its closing line is `  REPRODUCED  (pre-fix row: its swap lists were not checked -- see
EVIDENCE above)`. No row is ever re-marked, so these lines are permanent.

**Rows read from block 76,038,603** are checked strictly (above). The keeper commits a degraded row rather than none
when it cannot finish a scan before its deadline, and says so; each case gets a line:

```
  EVIDENCE closure scan incomplete: gaps <ranges>; swapsDuringClosure counts the swaps recorded outside them
  EVIDENCE closing window not committed (incomplete or inconsistent scan); closingVwap is null and falls back to the last print
  EVIDENCE closure list truncated: the first 5,000 and last 5,000 of <n> are committed; closureDigest commits all <n>
  EVIDENCE the cut mid is not bound to a committed pool read (closure opened before this keeper build)
  EVIDENCE between the cut and the read the chain did not run at one block per second (<±d> s off); the 900-block closing window may not be 15 minutes
```

In order: some blocks of the closure were not scanned in time, and the swap count covers the rest (the keeper
commits such a row only when it recorded a swap or the pool price did not move, so the mark is the one complete
evidence would give); the 15 minutes before the cut were not scanned in full, or did not match the pool price at
the cut, so the closing VWAP falls back to the last print, which is the pool price at the cut block; more than
10,000 swaps, of which the first and last 5,000 are committed and a digest commits all; the closure was opened by
an earlier keeper build; the chain's clock and block count drifted apart between the cut and the read.

**The six holiday rows.** The three Hong Kong rows of the 30 Sep to 2 Oct closure and the three of the 16 Oct
to 20 Oct closure commit the issuer's holiday list as it stood at the commit, after the issuer had dropped the
holiday the closure spanned (1 Oct, 19 Oct). Walked from the cut, that schedule reopens a day early, so the
reopen check alone fails. For rows read before block 76,038,603 the verifier then walks the same committed schedule
from the commit instant, which is how the keeper computed the reopen, and accepts the row only if that gives
the committed `settleAfter`:

```
  EVIDENCE reopen re-derived from the commit instant: walked from the cut, the committed schedule gives 2026-10-01T01:30:00.000Z, before the commit at <evaluatedAt>; walked from the commit instant it gives the committed settleAfter 2026-10-02T01:30:00.000Z, which is how the keeper computed it. The bundle does not show whether a holiday dropped from the issuer's list or the closure was not continuous.
```

(the line for the three 2 Oct rows; `range` marks each such row `(D-16 holiday row)`, and any other row
`NOT one of the six D-16 holiday rows: explain it in DECISIONS before any release`.)

The line says only what the bytes show. They cannot prove the market stayed shut from the cut to the commit;
the cause for these six rows, and the change that keeps a closure's holidays in the schedule it commits, are
in [DECISIONS](DECISIONS.md) D-16. Rows read from block 76,038,603 never get this fallback.

**A row that can never be graded.** For an unsettled row whose settle window has closed, `tx` prints the
`settled` field as `not settled; settle window closed <deadline> (TooLate: this row can no longer be graded)`;
for row 151 of 28 Oct
([DECISIONS](DECISIONS.md) D-17) the deadline is `2026-10-28T07:35:00Z`. While the window is open it prints
`not yet (window open until <deadline>)`, and if the latest block cannot be read, `not yet`.

**On npm.** `curb-verify` 0.2.0, published on 20 Nov 2026, carries everything described here:
`npx -y curb-verify tx <hash>`. The earlier 0.1.0 (25 Sep 2026) predates it: it prints no `EVIDENCE` lines, it
prints `NOT REPRODUCED` for the six holiday rows, and on a new row it re-derives the mark without checking the swap
evidence. Pin `curb-verify@0.2.0` if a cached 0.1.0 answers instead.

## Running from a checkout instead of npm

```sh
cd services/attestor && npm ci && cd ../keeper && npm ci && cd ../..
node tools/curb-verify/src/cli.ts tx <hash>
```
