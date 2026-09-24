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
account. That hash is the first round MarketClock ever received. The output:

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
rounds that ship inside the package, then tampers with one byte of each and shows the check failing.
It needs no network.

## Exit codes

| code | meaning | what to conclude |
|---|---|---|
| **0** | verified | The bundle rebuilds to the committed root, and re-running the committed method on its inputs gives exactly what the transaction wrote. A `LABEL` line may still report an uncommitted convenience field that disagrees; that does not change the number. |
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
- the committed reopen time re-derives from the committed venue schedule;
- the mark was committed before the reopen it predicts, and after the cut it describes; if the row is
  settled, it settled no earlier than `settleAfter + 300 s`.

**Not checked:** the chain reads a bundle commits to (block hash and raw return data) are covered by
the root, but they are not re-queried against an archive node. The issuer's API responses are not
re-fetched either, because that API only serves the present. What gets re-run is the copy the bundle
committed to.

## Running from a checkout instead of npm

```sh
cd services/attestor && npm ci && cd ../keeper && npm ci && cd ../..
node tools/curb-verify/src/cli.ts tx <hash>
```
