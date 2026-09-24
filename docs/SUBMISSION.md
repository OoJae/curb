# OKX Dev Day — submission answers

Ready to paste. The form closes **25 Sep 2026 23:59 UTC**, and the finale is in Singapore on **7 Oct 2026**.
Facts are as of **24 Sep 2026, 13:00Z** unless dated otherwise. Before pasting, the lead fills every `⟨…⟩`
and ticks the checklist at the end.

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
credit** let a holder exit or borrow without selling into a thin book. The users are lenders and protocols
integrating xStocks, holders caught by a closure, market makers, and AI agents that need market-hours data. Core
integrations: contracts on X Layer, the Builder Code on every transaction, and x402 through the OKX Broker.

*(147 words)*

### Track(s)

- **Primary:** X Layer, RWA (tokenized equities).
- **Also:** OKX AI (a paid agent service on the OKX AI marketplace, agent #13869, paid over x402).

### Product link

https://curb.markets
<!-- If the site is not serving by submission time, use https://api.curb.markets and say "site launching". -->

### Repository

https://github.com/OoJae/curb
<!-- It must be PUBLIC before submitting. On 24 Sep it returned 404 to an anonymous request. See docs/HYGIENE.md first. -->

### Demo video (2–4 min)

⟨video link⟩ (target length 3:12; script in `video/SCRIPT.md`)

### Contract addresses (X Layer mainnet, chain 196)

- MarketClock `0x160Dc415902971a7a9B5ade7f43005b36FE5B09b` (13 Sep, Sourcify exact_match)
- Scorecard v2 `0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f` (21 Sep, Sourcify exact_match)
- Scorecard v1, superseded and never used: `0x0527930187a879B3D8704a92734641679567EddD`
- EligibilityRegistry ⟨address, 25 Sep⟩
- ReopenPointer ⟨address, 25 Sep⟩
- ReopenNote ⟨address, 25 Sep⟩
- ClosedAuction ⟨address, 25 Sep⟩
- DepthCert ⟨address, 25 Sep⟩
- CurbCredit ⟨address, 25 Sep⟩
- Builder Code: `dd7u50nckt5e729f` (registry `0xd6c426f9c077358735622ae5a83468dc0510823b`)
- Revenue wallet (x402 payTo): `0x277cA91276A3801667B76C97Da3872Ccb6E96068`

### Service / listing URL

- API: https://api.curb.markets (discovery: https://api.curb.markets/.well-known/x402)
- OKX AI marketplace: agent **#13869** "Curb" ⟨marketplace URL⟩, three A2MCP services: Closure Calendar
  $0.01, Reopen Price Accuracy Record $0.05, Closure Discount by Duration $0.10.

### Technical links

- Deployments, every transaction: `docs/DEPLOYMENTS.md`
- Design decisions, measurements and errata: `docs/DECISIONS.md`
- Wallets and funding graph, published in advance: `docs/WALLETS.md`
- MarketClock integration guide: `docs/MARKETCLOCK.md`
- W3/W4 contract spec: `docs/specs/W3W4-contracts.md`
- Verifier: `tools/curb-verify` (`node tools/curb-verify/src/cli.ts selftest`)
- MarketClock round evidence: https://attestor-a-production.up.railway.app/healthz
- Evidence archive: https://archive.curb.markets (the publisher lands during the window; see below)

### How it integrates with X Layer and OKX AI

- **X Layer contracts.** MarketClock and Scorecard have been live since 13 and 21 Sep. W3/W4 deploy 25 Sep.
- **X Layer Builder Code** `dd7u50nckt5e729f`. It is appended as an ERC-8021 suffix to every transaction
  Curb's services send (host A, host B, keeper), and was first seen on chain 24 Sep 06:27Z.
- **x402 through the OKX Broker.** Payments are USD₮0 on X Layer, scheme `exact`, verified and settled by OKX.
  Each paid answer gets a receipt bound to the exact bytes delivered.
- **OKX AI marketplace.** Curb is registered as ASP agent #13869, from an OKX Agentic Wallet, with `onchainos`.
- **OKX buyer path, tested end to end.** `onchainos payment quote`, then `pay`, then 200, then settlement
  [`0xe8740458…4de7`](https://www.oklink.com/xlayer/tx/0xe8740458e49025873da915705e05c8a1156882813e81411caea1d2f8ce1b4de7).

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
14. ⟨W3 deployed 25 Sep: addresses, txs, commit⟩
15. ⟨W4 deployed 25 Sep: addresses, txs, commit⟩
16. ⟨archive publisher / curb-verify `tx` / mark/2 / site: fill in whichever landed, with its hash⟩

Full table with links: README, "Built during the 17–25 Sep build window".

### Why it matters (optional: innovation, user value, growth)

A tokenized stock's price only means something while creation and redemption are on. On X Layer the Hong Kong
names are shut 84% of the week, and a lending market's static parameters can't express that. Curb makes the closure a first-class
on-chain fact, publishes a falsifiable record of its own prices (including the 15 ties it has scored so far),
sells the data per call to agents, and builds the instruments that the fact makes possible. They are a note that
settles at the verified reopen, and a credit line whose LTV follows the regime and the bonded depth behind it.
Any X Layer protocol listing xStocks can read MarketClock for free today.

*(113 words)*

### Ecosystem contribution (optional)

- MarketClock is MIT, free to read, with no key and no fee. It is built for any protocol that touches xStocks on
  X Layer.
- Published integrator traps: wrapper units versus raw units, a non-monotonic multiplier, rebases that emit no
  event, and `stateOf()` not failing closed (`docs/MARKETCLOCK.md`).
- A risk-framework draft for listing tokenized equities on Aave V3 X Layer (`docs/AAVE_ARFC.md`, not yet posted).
- Measured findings about X Layer infrastructure: `eth_getLogs` is capped at 100 blocks; cardinality-1 pools make
  `observe()` return spot; OKX's buyer CLI re-serialises paid bodies (`docs/DEPLOYMENTS.md`).

### Declaration notes

- **Prior work.** MarketClock and Scorecard v1 were deployed 13 Sep, and attestations began 14 Sep, all before
  the build window. The list above covers only what was added from 17 Sep.
- **Team wallets.** Every demo wallet and the first paying wallet belong to the team. They are published with
  their funding graph in `docs/WALLETS.md`. No third-party usage is claimed.
- **Honest record.** As of 24 Sep, Scorecard shows 15 settled rows, 0 wins and 15 ties. Errata are published
  (D-7), and no row is ever re-marked.
- **Third-party code.** forge-std (vendored), ethers, @openzeppelin/merkle-tree, canonicalize, and OKX's
  `@okxweb3/x402-core` and `x402-evm`.
- **No token, no fundraising.** MarketClock use is free. Curb's only revenue is the per-call API.
- ⟨lead: add any statement the form requires about AI-assisted development, team members and contact⟩

---

## Before pressing submit

- [ ] Repo is public, and `docs/HYGIENE.md` findings are resolved or accepted.
- [ ] W3/W4 addresses and txs above match `docs/DEPLOYMENTS.md`, with Sourcify status.
- [ ] If any commit history was rewritten (see HYGIENE), every commit hash in this file and the README is re-checked.
- [ ] The Scorecard tally is re-read (`skill()`), and any number above that changed is re-dated.
- [ ] `curb.markets` serves, or the product link is switched to the API.
- [ ] The agent #13869 listing status is checked (approved or still under review) and stated as it is.
- [ ] The video link opens logged-out, and the video runs 2–4 minutes.
