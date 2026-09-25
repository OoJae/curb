# AAVE_ARFC.md: changes since the approved text (25 Sept 2026)

Every change from the text you approved (git `HEAD:docs/AAVE_ARFC.md`, revised 24 Sept). Each line gives the old text, the new text and the evidence. Sources:
**FORUM** = Aave forum and chain check. **CREDIT** / **V-CREDIT** = CurbCredit replacement and its verifier. **FACTS** / **V-FACTS** = claim check and its independent re-check. Where a verifier wrote its own fix, the post uses that fix.

## Header
1. Status "READY FOR APPROVAL", *Last revised 24 Sept 2026* → "FINAL DRAFT", pending approval of this revision, *Last revised 25 Sept 2026*. (task)

## Summary
2. Added after the first sentence: equity work is on another instance, the Coinbase B20 Equities Hub on Aave V4 Base ([t/25427](https://governance.aave.com/t/arfc-deploy-aave-v4-on-base/25427)). Backed's bCSPX was proposed for V3 Gnosis in 2025 ([t/21113](https://governance.aave.com/t/arfc-add-bcspx-to-aave-v3-gnosis-instance/21113)) and never listed. (FORUM, no-xStock item: 11 X Layer reserves read on chain, forum search, address book)
3. "that we could not find published anywhere" → "that, for the names live on X Layer, we could not find published". Adds one sentence each citing LlamaRisk's V4 Base parameters ([25427/5](https://governance.aave.com/t/arfc-deploy-aave-v4-on-base/25427/5)) and contrasting feed hours with issuer creation and redemption. (FORUM, stale)
4. "Its first six days held 1,702 rounds with zero gaps, every one of which re-derived…" → "…writing its first 1,702 rounds between 14 and 20 September, and any round can be re-derived from its published evidence." (V-FACTS fix: host A nonce was 1,604 at exactly six days and 1,702 at 20 Sept 20:38:58Z. Both checkers left "zero gaps" and "every one re-derived" unverified, so those words were dropped.)

## Motivation
5. "Aave spent July 2026 retiring 50 low-adoption reserves and six whole markets." → "In July 2026 LlamaRisk proposed offboarding 49 low-adoption reserves and 21 matured Pendle PTs, and winding down six whole deployments ([ARFC](https://governance.aave.com/t/arfc-low-adoption-asset-deprecation-on-aave-v3/25401)). It passed Snapshot in August and executed as AIP 521 in September." (FORUM, wrong: post v4 text; Snapshot 12–15 Aug; AIP 521 Executed on Ethereum, payload 20 Sept. eBTC was removed 11 Aug, hence the press's "50".)

## Finding 3 (contradicted by the chain; rewritten)
6. Heading "The pool carries no information while the market is shut" → "The pool keeps trading while the market is shut, with no primary market to anchor it". (V-FACTS fix. FACTS's "nothing to anchor it" overstated, because 24/7 perps exist.)
7. "a contract grades it" → "a contract, `Scorecard`, grades it". The new text refers to it by name. (FACTS evidence, src/Scorecard.sol; naming only)
8. "By 24 Sept the record held 15 settled closures…" → "As of 24 Sept 2026 22:53Z (Scorecard v2, block 71,521,360)… (wTCENTx, wXIAOx and wMEITx)… All fifteen tied the last print exactly (`skill()` = 15 settled, 0 beat the last print, 0 beat the closing VWAP)." (V-FACTS fix. FACTS misread `skill()`'s third field as "losses".)
9. "**In every one, the pool did not trade while primary capacity was off.**" → "**The pools did not stop trading…**: 15 / 63 / 141 swaps in the 22 / 23 / 24 Sept recesses. In 14 of 15 closures, the price one second before the reopen differed from the price at the cut." (FACTS and V-FACTS, wrong: Swap logs on the three `priceSources()` pools; archive `slot0`)
10. "The reopens were not quiet: they moved **30 to 105 bp**." → "From the last print before the cut to the settled reopen print, prices moved 0 to 105 bp; seven of the fifteen moved 30 bp or more." (V-FACTS fix from the 15 on-chain rows)
11. "…the price a lender would have read during a closure was the last print before the cut, unchanged… The information arrived all at once, at the reopen." → "…the price still moved during closures, with no creation or redemption to anchor it. On 22 Sept, the prints the Scorecard graded at the reopen had already been set by trades inside the recess." (V-FACTS fix: `slot0` at 04:59:59Z equals each reopen print)

## Finding 4
12. "No Uniswap quoter is deployed on chain 196" → "We found no Uniswap quoter deployed on chain 196". (FACTS and V-FACTS, unverified: the canonical quoter addresses are empty, but the factory is non-canonical)
13. "**Depth varies by more than an order of magnitude between assets**" → "**Depth varies several-fold between assets** (at $10k, 13bp on wNVDAx against 82bp on wAAPLx)". (FACTS and V-FACTS, wrong: the table's largest ratio is about 6.3×)
14. "That was the entire sellable depth of wrapped Tencent on this chain, against $3.48M of daily volume through the same pool." → "That was all the sellable depth in the only wTCENTx pool we found on this chain." (V-FACTS wording: only one factory was checked. The $3.48M figure has no artifact or date; V-FACTS rejected the proposed "on 13 Sept", so it was dropped.)
15. The `forge test … DepthProbe.t.sol` command gains a link to [test/fork/DepthProbe.t.sol](https://github.com/OoJae/curb/blob/main/test/fork/DepthProbe.t.sol). (FACTS, stale link)

## Finding 5
16. "a passing fork test" → linked to [test/fork/MarketClock.t.sol](https://github.com/OoJae/curb/blob/main/test/fork/MarketClock.t.sol). (FACTS/V-FACTS evidence, lines 44-55; link only)
17. "all within 8h14m" → "all within 8h25m on 29 June 2026". (FACTS and V-FACTS, wrong: HONx multiplier by block, 15:30:00Z → 23:55:00Z)

## Specification
18. The ask: "Following the precedent already set on this instance for assets with unusual risk profiles… dedicated isolated eMode" now names WOKB ([t/23175](https://governance.aave.com/t/arfc-deploy-aave-v3-on-x-layer/23175)) and PT-USDG-29OCT2026 ([t/25464](https://governance.aave.com/t/direct-to-aip-pt-usdg-x-layer/25464)): non-borrowable, zero LTV in the general market, collateral only in their own E-Mode. The ask itself becomes "dedicated E-Mode", and the text adds that LlamaRisk recommends the same shape for V4 Base: equities collateral only, USDC the only borrowable asset. (FORUM: `getReserveConfigurationData`, `getDebtCeiling` = 0. The USDC wording was re-read from raw post 25427/5 on 25 Sept.)
19. Table "Collateral | **Isolated eMode only** |" → "**Dedicated E-Mode only** | as WOKB and PT-USDG-29OCT2026 on this instance". (FORUM, wrong: Isolation Mode is a separate debt-ceiling feature)
20. Supply-cap derivation "below the ~$58.3k of total sellable depth measured on 13 Sept" → "…of sellable depth measured in the wTCENTx/USDG pool on 13 Sept". (same basis as #14)

## A reference implementation of Option B (section replaced)
21. "we are deploying a small, immutable credit line on X Layer on 25 Sept 2026, `CurbCredit`" → "on 24 Sept 2026 we deployed…" with the CurbCredit, DepthCert and maker-allowlist addresses. All three are Sourcify `exact_match` and cannot be upgraded, and the parameters are constants. New: the deployer is admin and runs both allowlists; it can withdraw idle reserve but cannot change a parameter or touch a borrower's collateral. (CREDIT, plus V-CREDIT must-fix 1)
22. "at launch it lends only between disclosed team wallets" → "It lends USDG at a fixed 5% a year, simple interest, and only to allowlisted borrowers: today, two disclosed team wallets." (CREDIT; V-CREDIT: `APR_BPS` = 500, borrowers are curb-desk and the Agentic Wallet)
23. "when nobody has bonded any depth" → "when no qualifying bid is posted". (CREDIT stale, V-CREDIT ok)
24. "what bonded bids would actually pay… valued at the lowest bid, as a fraction of its pool value" → "the lowest qualifying bid per share as a fraction of the pool's own price", plus the pro-rata `ltvEffective` shrink and the lending-past-bids limit. (CREDIT wrong, V-CREDIT ok)
25. New: only allowlisted makers can post. "Today the makers are two team wallets, curb-desk and the deployer, and curb-desk is also an allowlisted borrower, so one team wallet can both borrow and set the LTV." (CREDIT; V-CREDIT optional tightening; EligibilitySet at blocks 71,503,711 / 71,507,852 / 71,507,854)
26. "Bids expiring within the hour don't count." → the maker must cover all its bids, and the bid must outlive the slowest liquidation: 90 min while open, 73½ h around a close, 73½ h and past the next transition while shut. (CREDIT wrong, V-CREDIT ok: live `minCertExpiry` was 73h30m ahead)
27. "A breach starts a cure clock… seizure is bounded by a 5% bonus at the breach-time price" → "Anyone can flag a breach…". Checks count only if they are ≤10 min apart with the market open at both. Liquidation needs 30 such minutes, and seizure is never more than a 5%-bonus liquidation at the breach-time price. (CREDIT; V-CREDIT optional tightening: `flagBreach` is permissionless)
28. New sentence: the first borrow was refused (block 71,516,369, `Refusal(NoDepth)`, tx `0x8bd873d7…5c7a`). (CREDIT; V-CREDIT re-read the receipt)
29. "The full spec is public (`docs/specs/W3W4-contracts.md`…). The addresses will be in `docs/DEPLOYMENTS.md` once deployed. ⟨placeholder⟩" → "The rules are written out in the NatSpec of" CurbCredit.sol and DepthCert.sol (linked), plus a linked DEPLOYMENTS.md. The spec link is dropped because its LTV text predates review; "exactly" is dropped. (CREDIT, plus V-CREDIT must-fix 2)

## Oracle
30. "**This is where every tokenized-equity listing fails…**" → "**For the names live on X Layer, this is the hardest part of a listing…**". (FORUM, wrong: V4 Base prices equities through Chainlink tokenized-equity feeds)
31. "Aave's existing X Layer reserves are priced by Chainlink feeds with CAPO adapters." → "…priced from Chainlink feeds, except GHO, which is fixed at $1." xBTC, xETH, xSOL and WOKB read the feeds directly; USDT0, USDG, USDC, xBETH and xOKSOL go through CAPO, and PT-USDG through a capped linear-discount adapter (address-book link). (FORUM replacement, reconciled with V-FACTS: the PT source is "PT Capped USDG USDG/USD linear discount 29OCT2026", and GHO returns a fixed 1e8)
32. Verifier bullet "…`curb-verify bundle <url>`. A `tx <hash>` verb… is being added." → `tx`, `range` and `bundle` verbs, with a link to [tools/curb-verify](https://github.com/OoJae/curb/tree/main/tools/curb-verify). (FACTS and V-FACTS, stale: cli.ts:37-42, commit 08f2a11. The link uses `/tree/` because the path is a directory.)
33. Errata "Seven rounds…" → "Six rounds…". (FACTS and V-FACTS, wrong: StateAttested logs show nonces 0–5 wrong and nonce 6, at 70,619,137, as the fix)

## Disclosure
34. "…listed on the OKX AI marketplace" → "…offered through its agent on the OKX AI marketplace, [#13869](https://www.okx.ai/agents/13869), whose listing was still under OKX review on 24 Sept". (FACTS, wrong: `serviceList` empty, page says under review. V-FACTS never received this item, so did not reject it.)
35. `docs/WALLETS.md` → [full URL](https://github.com/OoJae/curb/blob/main/docs/WALLETS.md). (FACTS, stale link)

## Internal checklist and formatting
36. Rewritten: finished items are ticked, and the rest is an exact list of what you still need to do before posting.
37. Formatting only: above the internal line, each paragraph and list item is now one line instead of being hard-wrapped at about 115 characters, because Discourse renders a single newline as a line break. A whitespace-normalised comparison confirmed that no wording changed.

## Checked but deliberately not changed
- "336 of 732 … in our September 2026 survey": kept. V-FACTS found the past-survey wording appropriate, though no survey artifact exists.
- "A second host… EIP-712-signs every round": kept. Both checkers marked it ok; host B began on 14 Sept 20:02Z, so the first few hours of rounds have no witness.
- LlamaRisk "reaches the same point" sentence under *The parameter Aave does not currently have*: not added. It was an optional suggestion on an ok item.
- The Aave Risk Framework (asset class not yet ratified): not added. It is listed as a recommendation in the checklist.

## Changes on 25 Sept, after the repo went public

38. Title prefix `[ARFC]` → `[Discussion]`. Under Aave Governance Framework v2 (https://governance.aave.com/t/arfc-governance-framework-v2/25348) an ARFC is a binding Snapshot stage opened by approved authors or 80,000 AAVE, and asset listings are proposed by the service providers; this post asks for no vote. Precedent for [Discussion] risk posts: /t/24882.
39. Finding 3's tally re-read at block 71,579,624 (25 Sept 15:04Z): 21 settled, 0 wins. It now says the first 15 tied by construction, the first three mark/2 overnight rows lost (HKEX opened all three names down), and three lunch rows tied (the recess has no weight). Source: `skill()`, `closureCount()` at that block; docs/DECISIONS.md D-13.
40. "only to allowlisted borrowers: today, two disclosed team wallets" → "one disclosed team wallet", and the maker sentence now records that curb-desk left the borrower list after the demo (tx 0xc505987a…). Source: EligibilityRegistry `isEligible` read back.
41. Marketplace: "whose listing was still under OKX review on 24 Sept" → "listed on 25 Sept 2026". Source: `onchainos agent get-my-agents` (Listed — eligible for task recommendations).
