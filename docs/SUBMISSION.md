# OKX Dev Day — submission answers

Ready to paste. The form closes **25 Sep 2026 23:59 UTC**, and the finale is in Singapore on **7 Oct 2026**.
Facts are as of **25 Sep 2026, 01:00Z** unless dated otherwise. Before pasting, the lead fills every `⟨…⟩`
and ticks the checklist at the end. Every link below is a full URL, so it still works when pasted into the form.

---

### Project name

Curb

### Tagline

The market that trades when the exchange is shut.

### Short description (product · intended user · core integration)

Tokenized Hong Kong stocks on X Layer keep trading for 141 h 20 m of every 168-hour week while the issuer caps
creation and redemption at zero. For those hours nothing pins the token to the real share. Curb is the market for
those hours. **MarketClock** is a free on-chain oracle that says when each stock's primary market is really shut.
**Scorecard** commits Curb's price before each eligible reopen and has the contract grade it against the pool.
**curb-asp** sells both to agents over x402 on the OKX AI marketplace. **Reopen Notes** and **DepthCert-backed
credit** let a holder exit or borrow without selling into a thin book (live on mainnet, demonstrated between
team wallets). The users are lenders and protocols integrating xStocks, holders caught by a closure, market
makers, and AI agents that need market-hours data. Core integrations: contracts on X Layer, the Builder Code on
every transaction, and x402 through the OKX Broker.

*(154 words)*

### Track and route

- **Track:** Build a Market. Curb's contracts are live on X Layer mainnet, and the video shows the working flow.
- **Route:** ⟨lead: "Singapore Finale" if the team can be in Singapore for the finale, otherwise "Remote Build"⟩
- **Also relevant:** curb-asp is a paid service published through OKX AI (agent #13869, paid over x402, listed
  25 Sep), which is what the Build a Company track asks for. ⟨lead: select it as well only if the form
  allows a second track⟩

### Product link

https://curb.markets
<!-- If the site is not serving by submission time, use https://api.curb.markets and say "site launching". -->

### Repository

https://github.com/OoJae/curb
<!-- It must be PUBLIC before submitting. On 24 Sep it returned 404 to an anonymous request. See docs/HYGIENE.md first. -->

### Demo video (2–4 min)

⟨video link⟩ (target length 3:12; script: https://github.com/OoJae/curb/blob/main/video/SCRIPT.md)

### Contract addresses (X Layer mainnet, chain 196)

- MarketClock `0x160Dc415902971a7a9B5ade7f43005b36FE5B09b` (13 Sep, Sourcify exact_match)
- Scorecard v2 `0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f` (21 Sep, Sourcify exact_match)
- Scorecard v1, superseded and never used: `0x0527930187a879B3D8704a92734641679567EddD`
- EligibilityRegistry (notes) `0xd7251b562eD07374ccD2436a7EfC0bA3A28ce938` (24 Sep, Sourcify exact_match)
- ReopenPointer `0x85AB0FebdFa7201E65eA01bd3e4CC6F9c0Ac4471` (24 Sep, Sourcify exact_match)
- ReopenNote (ERC-1155 CURB-RN) `0x7B2AcB0Db3316f7B8cf1B287796a2273871F011B` (24 Sep, Sourcify exact_match)
- ClosedAuction `0xAc74864d69DdB940ADfDB39E69751759a32bb80D` (24 Sep, Sourcify exact_match)
- EligibilityRegistry (makers) `0xbA1aB5027e826D564EA913b3f7acb95Fd651758E` (24 Sep, Sourcify exact_match)
- DepthCert `0x702b1a988765f85162F4829175EF4232197e9C6D` (24 Sep, Sourcify exact_match)
- CurbCredit `0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339` (24 Sep, Sourcify exact_match)
- MarketClockStatus (Chainlink-style `marketStatus` adapter over MarketClock) `0xD5EEeD33117c7B2B39EF1Dad7e0eeEDe6b9836d9` (25 Sep, Sourcify exact_match)
- Builder Code: `dd7u50nckt5e729f` (registry `0xd6c426f9c077358735622ae5a83468dc0510823b`)
- Revenue wallet (x402 payTo): `0x277cA91276A3801667B76C97Da3872Ccb6E96068`

### Service / listing URL

- API: https://api.curb.markets (discovery: https://api.curb.markets/.well-known/x402)
- OKX AI marketplace: agent **#13869** "Curb", https://www.okx.ai/agents/13869 (listed 25 Sep 2026: "Listed — eligible for task recommendations"), three A2MCP services: Closure Calendar
  $0.01, Reopen Price Accuracy Record $0.05, Closure Discount by Duration $0.10.
- MCP server for AI agents (free, read-only, six tools over Streamable HTTP):
  https://mcp.curb.markets/mcp. Any agent can ask whether a
  tokenized stock's home market is open, when it reopens, how Curb's marks were graded, and what LTV CurbCredit
  lends at; `curb_paid_services` hands it the exact onchainos command for the paid x402 routes. Agent skill:
  https://github.com/OoJae/curb/blob/main/skills/curb/SKILL.md

### Technical links

- Start here (README, with "Try Curb in 60 seconds"): https://github.com/OoJae/curb/blob/main/README.md
- Deployments, every transaction: https://github.com/OoJae/curb/blob/main/docs/DEPLOYMENTS.md
- Design decisions, measurements and errata: https://github.com/OoJae/curb/blob/main/docs/DECISIONS.md
- Wallets and funding graph, published in advance: https://github.com/OoJae/curb/blob/main/docs/WALLETS.md
- MarketClock integration guide: https://github.com/OoJae/curb/blob/main/docs/MARKETCLOCK.md
- W3/W4 contract spec (frozen 24 Sep; where it differs from the deployed code, the contracts' NatSpec governs):
  https://github.com/OoJae/curb/blob/main/docs/specs/W3W4-contracts.md
- Verifier: https://github.com/OoJae/curb/blob/main/docs/VERIFY.md (`npx -y curb-verify tx <any Curb tx hash>`)
- MarketClock round evidence: https://attestor-a-production.up.railway.app/healthz
- Evidence archive: https://archive.curb.markets/index/latest.json (object-locked; host A, host B and the keeper
  have published every new bundle and witness statement since 24 Sep 20:32Z)

### How it integrates with X Layer and OKX AI

- **X Layer contracts.** MarketClock and Scorecard have been live since 13 and 21 Sep. W3/W4 have been live since
  24 Sep (blocks 71,503,708–71,507,867).
- **X Layer Builder Code** `dd7u50nckt5e729f`. It is appended as an ERC-8021 suffix to every transaction
  Curb's services send (host A, host B, keeper), and was first seen on chain 24 Sep 06:27Z. The curb-desk demo
  wallet appends it to its W3/W4 transactions; on the Agentic Wallet's ERC-4337 transactions it sits inside the
  inner call.
- **x402 through the OKX Broker.** Payments are USD₮0 on X Layer, scheme `exact`, verified and settled by OKX.
  Each paid answer gets a receipt bound to the exact bytes delivered.
- **OKX AI marketplace.** Curb is registered as ASP agent #13869, from an OKX Agentic Wallet, with `onchainos`.
- **OKX buyer path, tested end to end.** `onchainos payment quote`, then `pay`, then 200, then settlement
  [`0xe8740458…4de7`](https://www.oklink.com/xlayer/tx/0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7).

### Live demo on mainnet (team wallets only)

Every counterparty is a Curb team wallet, disclosed before its first transaction: K = curb-desk, A = the team's
OKX Agentic Wallet (https://github.com/OoJae/curb/blob/main/docs/WALLETS.md). This demonstrates the mechanism; it
is not usage. Every transaction below has status 1. The full ledger is in
https://github.com/OoJae/curb/blob/main/docs/DEPLOYMENTS.md, section "Live demo on mainnet".

**W3 cycle 1: sell the reopen while Hong Kong is shut (the overnight closure ending 25 Sep 01:30Z)**

- K approves 0.1 wTCENTx to ReopenNote (block 71,508,611):
  https://www.oklink.com/xlayer/tx/0xa41ec8e3cf54901dfce11e8ebec645b268c8e3442cd6b9b8f9ef59626398c4e9
- K mints note 1, escrowing 0.1 wTCENTx, 24 Sep 19:20Z (block 71,508,619):
  https://www.oklink.com/xlayer/tx/0xcf3dfa55bc02bf0cec35422cc3561a98e7bb79bb779d13c27f51f3df277a1c40
- K approves ClosedAuction for its notes (block 71,508,670):
  https://www.oklink.com/xlayer/tx/0x56b91d1fe476aae48c7a0c755d8de6fd49be2774863d8870c87e037d30d9d072
- K lists lot 1, descending 5.60 → 5.43 USDG, ending 01:00Z (09:00 HKT) (block 71,508,704):
  https://www.oklink.com/xlayer/tx/0xaa7f91690bbba12d9291461545dc8a5a3f7c7a169076ec4ff5e7f1212f3af660
- A approves 5.60 USDG to ClosedAuction (block 71,508,743):
  https://www.oklink.com/xlayer/tx/0xad701253198a9f9a6796a7c1d0a02d4bb692def4d37f57c9a98ce6d6ae068e44
- A buys lot 1 for 5.595137 USDG at 03:24:03 HKT, 35 bp under the reference (block 71,508,807):
  https://www.oklink.com/xlayer/tx/0xf23e727c1a37c111e339f480caf15bf67cf2671139f355d11853ec1188cfd3d3

**W4: a refused borrow is a transaction (24 Sep, Hong Kong shut)**

- K approves USDG to DepthCert as a maker (block 71,516,056):
  https://www.oklink.com/xlayer/tx/0x0594a5e45ec693ae3c9c98978d34627a95c7b71f862936c6687d901d022dd306
- K funds the CurbCredit reserve with 3 USDG (block 71,516,155):
  https://www.oklink.com/xlayer/tx/0x5e2a8be6bcf09bc1ea8b5f1f948402a2769c8621faae632de9b074edd76a25fa
- A approves exactly 0.05 wTCENTx to CurbCredit (block 71,516,286):
  https://www.oklink.com/xlayer/tx/0xd75527290def9c5ac8878b77b54630960c70de5af2edca0c5825890154b04619
- A deposits 0.05 wTCENTx (block 71,516,299):
  https://www.oklink.com/xlayer/tx/0xeb927854b5580c55350ebda8206cec05a5925cdcb73fdc01e548f4524df65b8b
- A asks to borrow 1.4 USDG with no bonded depth, 24 Sep 21:30Z: `Refusal(NoDepth)`, requested 1,400,000,
  allowed 0, inside a successful transaction, and nothing moves (block 71,516,369):
  https://www.oklink.com/xlayer/tx/0x8bd873d77176dab81ad860c1496937d2e7535c8a6b91f0be5902936b408b5c7a

**W3 cycle 1, graded at the 25 Sep 01:30Z reopen**

- The reopen is witnessed on chain, epoch 1 opened at 01:30:32Z (block 71,530,796):
  https://www.oklink.com/xlayer/tx/0xeb01d9f84355aec74ac3e75033d68f40930033d1d234d631e1790f46b32d991c
- A redeems note 1 and receives exactly 0.1 wTCENTx (block 71,530,833):
  https://www.oklink.com/xlayer/tx/0xd102eca8ef75190302419edf008ecbb9117a71c67e9978a4179473d9be29e383
- The reopen print, 55.7357 USDG a share, recorded at openedAt + 303 s (block 71,531,111):
  https://www.oklink.com/xlayer/tx/0xce7b9189f3cf83ffbeb79f52096869aa3ded77e489f18f84d0a8674914b9fb66
- `realisedDiscountBps(1)` = −38: Tencent reopened lower, so the buyer paid 38 bp more than the reopen was worth.

**W3 cycle 2, the Friday lunch recess (03:55Z to 05:00Z)**

- K mints note 2 at 04:02Z (block 71,539,903): https://www.oklink.com/xlayer/tx/0x646922f0331dc7a63f1a05aa06edd7a7713bc64ada8ef7ddad439279f5e9bf94
- K lists lot 2, 5.57 → 5.40 USDG, ending at MarketClock's 05:00:00Z cutoff (block 71,539,949):
  https://www.oklink.com/xlayer/tx/0x97ff93d190438978ade1cccb5cf67eb7db9f4bee0900e12ff71fe6b5329d8455
- A buys lot 2 for 5.529059 USDG at 12:07 HKT (block 71,540,238): https://www.oklink.com/xlayer/tx/0x3a92efa702207705c0d8a8e041232f34b59bd39e6cb015ee1b543e878c467c31
- After the 05:00Z reopen A redeems note 2 (block 71,543,421): https://www.oklink.com/xlayer/tx/0x483a3a01bc3046808199be8d2fbb954574216676a2641af94e8383f979468f05;
  the print is 55.7375 (block 71,543,710): https://www.oklink.com/xlayer/tx/0x988f3e9b9bf913b425447b92994cdb64c104db01635d98661b3c78bd97eaaa95
- `realisedDiscountBps(2)` = +80: this time the buyer earned 80 bp for carrying the recess.

**W4: one bonded bid moves the LTV, and a fade is proved (25 Sep, Hong Kong open)**

- K posts cert 1, a bonded bid for 0.028 wTCENTx at 52 USDG naming CurbCredit, 05:16Z (block 71,544,327):
  https://www.oklink.com/xlayer/tx/0x19c80f58740a4ebb37b07613023d314a5a43119e3e8c754054f6983e40ebbd43. `ltvFor(wTCENTx)` goes from 0 to 60% in that
  one transaction.
- A borrows the 1.4 USDG it was refused the night before: `Borrowed(1.4 USDG, ltv 60%)` (block 71,544,372):
  https://www.oklink.com/xlayer/tx/0x438c26de55074b10ccce9b45341203a071e21482d91d3257ccc5e291d78fd0a4
- The fade: the deployer posts cert 2 naming A, then revokes its USDG allowance; A takes it and the contract proves the
  fade in the same transaction, `Faded(reason ALLOWANCE)`, bond 0.2 USDG to A, A's shares returned (block 71,545,313):
  https://www.oklink.com/xlayer/tx/0x6dd0bd29ebc5335ec8a68a4e9799c5d4c7fe5edf4dd6d954ca3d4b14aeebf470
- At the 07:55Z cut `ltvFor` fell from 60% to 30% with no transaction; A's 1.4 USDG loan was over its new 0.835 USDG
  limit. `flagBreach` at 07:56:43Z started the cure clock, which counts only open-market time, so it is frozen at 0
  until Hong Kong reopens on Monday, and nobody can liquidate in between (block 71,553,967):
  https://www.oklink.com/xlayer/tx/0xd598c4fb42ed4883df6067968758ef30b8e955641b15f325888e605700de2e57

**The first rows under the new mark method (25 Sep 01:30Z reopen): three losses.** Curb's `curb.scorecard.mark/2`
called Tencent, Xiaomi and Meituan up; HKEX opened all three down. The contract graded all three as losses against
the last print, and `skill()` reads (18, 0, 0). They stay on the record; no row is ever re-marked.

### Features and integrations added during the build period (17–25 Sep)

Curb started before the window. MarketClock was deployed 13 Sep and first attested 14 Sep. The git history
starts 21 Sep with one initial commit (`cc03fa7`) that holds both earlier and in-window work, so the dated
evidence below is on-chain transactions and Sourcify verification times, plus commits where they apply.
Dates are UTC.

1. **Recess rule settled, 18 Sep.** The issuer cuts every period 300 s early: 16 of 16 times over 15–18 Sep,
   seen from three vantage points (D-4).
2. **`derive/3`, 20 Sep 22:23.** Cohort coherence and confirm-before-open. First round tx `0x20dd8be0…df5c`,
   block 71,173,967 (D-9).
3. **Scorecard v2, 21 Sep 14:27.** Settlement reads the pool itself and takes no price. Deploy tx
   `0x01325c45…d30d`, block 71,231,806; Sourcify verified 14:31 (D-10).
4. **Keeper live, 21 Sep 15:17.** Marks committed before each eligible reopen. `setKeeper` tx `0xb9f80b25…37ce`.
5. **curb-verify and checkMarkRound, 21 Sep.** Commits `12ab284` and `1467312`.
6. **First Scorecard rows, 22 Sep.** Committed 04:50 (tx `0x1c839166…294e`), settled 05:05 (tx `0x84b5ccb1…fb4c`),
   commit `3e82808`.
7. **Evidence archive on R2, 22 Sep.** Object locks on `rounds/`, `marks/` and `witness/`. Commit `3e82808`.
8. **Builder Code minted, 24 Sep 01:39.** Tx `0xc3315eb4…051b`, commit `e4bd194`.
9. **Builder Code attribution live, 24 Sep 06:27.** Code in `aa0f373`; first attributed round tx `0x5d3c92ab…605e`.
10. **curb-asp, 24 Sep.** x402 via the OKX Broker at api.curb.markets. Commits `a8474dd` and `d3bfc40`.
11. **OKX AI marketplace listing, 24 Sep 09:44.** Agent #13869, tx `0xe2420407…ccc7`, commit `474e820`.
12. **First paid call, 24 Sep 11:56.** $0.01, team wallet to team (disclosed). Settlement tx `0xe8740458…4de7`,
    receipt `0xcee1ee75…817c`, commit `b70a75f`.
13. **W3/W4 scaffold and specs, 24 Sep.** Commits `b70a75f` and `0995f72`.
14. **W3 on mainnet, 24 Sep ~18:00.** ReopenPointer, ReopenNote, ClosedAuction and the note EligibilityRegistry,
    blocks 71,503,708–71,503,723, all Sourcify exact_match. Commit `424f4bf`.
15. **W4 on mainnet, 24 Sep ~19:15.** DepthCert, CurbCredit and the maker EligibilityRegistry, blocks
    71,507,846–71,507,867, all Sourcify exact_match. Commit `e0b8ae7`.
16. **`curb.scorecard.mark/2`, 24 Sep.** Marks move with markets that trade while Hong Kong is shut (Binance perp
    and the US ADRs); mark/1's range closes at block 71,486,953 (D-13). Commits `c7e80b6` and `af68ee1`.
17. **Archive publisher live, 24 Sep 20:32.** Host A, host B and the keeper each publish every new bundle and
    witness statement to the locked R2 archive after its fsync; the history was backfilled after a check
    against the chain. Commit `66d7b89`.
18. **`curb-verify tx` and range verbs, 24 Sep.** Commit `08f2a11`.
19. **Corporate actions feed and HONx replay, 24 Sep.** Commits `5761957` and `8715db2`.
20. **curb.markets, 24 Sep.** The site, with the Week Ring and the live regime. Foundation commit `35b9854`.
21. **Live W3/W4 demo on mainnet, from 24 Sep 19:20Z.** Team wallets only; every transaction is listed under
    "Live demo on mainnet" above.

Full table with links: https://github.com/OoJae/curb/blob/main/README.md, section "Built during the 17–25 Sep
build window".

### Why it matters (optional: innovation, user value, growth)

A tokenized stock's price only means something while creation and redemption are on. On X Layer the Hong Kong
names are shut 84% of the week, and a lending market's static parameters can't express that. Curb makes the closure a first-class
on-chain fact, publishes a falsifiable record of its own prices (18 graded so far: 15 ties and 3 losses, no wins),
sells the data per call to agents, and builds the instruments that the fact makes possible. They are a note that
settles at the verified reopen, and a credit line whose LTV follows the regime and the bonded depth behind it.
Any X Layer protocol listing xStocks can read MarketClock for free today. Why now: Ondo's 24/7 minting covers
six US names only, oracle market status follows the exchange calendar rather than the issuer's cap, and OKX's own
tokenized stocks price off-hours as "the last close plus a market estimate". Sources:
https://github.com/OoJae/curb/blob/main/README.md, section "Why this matters now".

*(157 words)*

### Ecosystem contribution (optional)

- MarketClock is MIT, free to read, with no key and no fee. It is built for any protocol that touches xStocks on
  X Layer.
- Published integrator traps: wrapper units versus raw units, a non-monotonic multiplier, rebases that emit no
  event, and `stateOf()` not failing closed (https://github.com/OoJae/curb/blob/main/docs/MARKETCLOCK.md).
- A risk-framework draft for listing tokenized equities on Aave V3 X Layer
  (https://github.com/OoJae/curb/blob/main/docs/AAVE_ARFC.md, not yet posted).
- Measured findings about X Layer infrastructure: `eth_getLogs` is capped at 100 blocks; cardinality-1 pools make
  `observe()` return spot; OKX's buyer CLI re-serialises paid bodies
  (https://github.com/OoJae/curb/blob/main/docs/DEPLOYMENTS.md).

### Declaration notes

- **Prior work.** MarketClock and Scorecard v1 were deployed 13 Sep, and attestations began 14 Sep, all before
  the build window. The list above covers only what was added from 17 Sep.
- **Team wallets.** Every demo wallet and the first paying wallet belong to the team. They are published with
  their funding graph in https://github.com/OoJae/curb/blob/main/docs/WALLETS.md. No third-party usage is claimed.
- **Honest record.** As of 25 Sep 01:36Z, Scorecard's `skill()` reads (18, 0, 0): 18 settled rows, 0 wins. The
  15 `curb.scorecard.mark/1` rows tied by construction (the mark is the last print). The first 3
  `curb.scorecard.mark/2` rows, graded at the 25 Sep 01:30Z reopen, all lost: the signal called the gap up and
  HKEX opened all three names down. In the walk-forward backtest (not on chain) mark/2's mean error was 68.9 bp
  against 95.4 bp for the last close; the live record is what counts, and it is shown as it is on /scorecard.
  Errata are published (D-7, and the D-11 erratum of 25 Sep), and no row is ever re-marked.
- **Third-party code.** forge-std (vendored), ethers, @openzeppelin/merkle-tree, canonicalize, and OKX's
  `@okxweb3/x402-core` and `x402-evm`.
- **No token, no fundraising.** MarketClock use is free. Curb's only revenue is the per-call API.
- ⟨lead: add any statement the form requires about AI-assisted development, team members and contact⟩

---

## Before pressing submit

- [ ] Repo is public, and `docs/HYGIENE.md` findings are resolved or accepted.
- [ ] Every `github.com/OoJae/curb` link above opens logged-out, and `npx -y curb-verify selftest` passes
      from a clean directory (both need the public repo).
- [ ] W3/W4 addresses and txs above match `docs/DEPLOYMENTS.md`, with Sourcify status.
- [ ] "Live demo on mainnet" has the 01:30Z, ~04:00Z, 05:15Z and 07:55Z transactions appended from
      `docs/DEPLOYMENTS.md`, each with its OKLink link and block.
- [ ] The track and route labels match what the form offers ("Build a Market"; "Singapore Finale" or "Remote
      Build"), and the finale date is confirmed on the official page.
- [ ] If any commit history was rewritten (see HYGIENE), every commit hash in this file and the README is re-checked.
- [ ] The Scorecard tally is re-read (`skill()`), and any number above that changed is re-dated.
- [ ] `curb.markets` serves, or the product link is switched to the API.
- [x] The agent #13869 listing status is checked: listed 25 Sep 2026.
- [ ] The video link opens logged-out, and the video runs 2–4 minutes.
