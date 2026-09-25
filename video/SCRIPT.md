# Curb demo — voiceover script v1.2 (8 beats, ~410 words ≈ 3:05–3:12 at 145 wpm)

Record this in Clipchamp. It follows these rules:
- It never speaks a number that will change, such as row counts or tallies. Those appear on screen from live
  captures. Every number it does speak is fixed: the published timetable, a contract constant, or a dated
  on-chain fact. Each one is listed under "Where the spoken numbers come from".
- It's date-neutral: no "today", "tonight" or "this week".
- Numbers are written the way you say them.
- The first words of each beat are its alignment anchor. They are the same eight openings as v1.1, and
  `capture/align/align-beats.mjs` matches them, so read them exactly.
- `⏸` marks a breath of about half a second. Each one is a possible cut point.
- There is one beat 7 read (instruments live on mainnet). 7B is gone; see the note at the end.

Recording: one continuous take at about 145 words a minute, with about one second of silence between
beats. If you fluff a line, pause two seconds and repeat the whole sentence, or cut the fluff in Clipchamp
so no line appears twice. Export as .mp4, .m4a or .wav. Say "OKX" as O-K-X, "x-four-oh-two" as written,
"USDG" as U-S-D-G, "MarketClock" as market clock, and "curb dot markets" as written.

**1 · 11:55** (grid 0:00–0:14 · read ≈ 11 s) — *Picture: the live hero flips from paper to ink.*
> At eleven fifty-five in Hong Kong, the primary market for Tencent shuts for lunch. ⏸ On X Layer, its
> tokenized share keeps trading.

**2 · The week** (grid 0:14–0:40 · read ≈ 25 s) — *Picture: the Week Ring fills; "84%" arrives, with 141 h 20 m of 168 on screen.*
> That isn't a glitch. For a Hong Kong stock, the exchange is shut eighty-four percent of every week. ⏸
> While it's shut, the issuer caps creation and redemption at zero, so nothing pulls the token back to
> the real share. ⏸ Lenders can't value those hours, and holders can't get out without selling into a
> thin pool.

*Delivery: "eighty-four percent of every week" is the number to remember. Take a small pause before it and
land it. Don't say "a hundred and forty-one hours": the screen carries that.*

**3 · The name** (grid 0:40–0:52 · read ≈ 8 s) — *Picture: type card; the mark resolves; the card shows the tagline.*
> A century ago, New York's Curb Market traded outside the exchange. ⏸ Curb trades outside its hours.

*Delivery: one line, light. The card on screen says the rest.*

**4 · MarketClock** (grid 0:52–1:24 · read ≈ 28 s) — *Picture: /clock; an OKLink attestation; the terminal.*
> Curb starts with MarketClock: a free, on-chain oracle that says whether each stock's home market is
> really open. ⏸ One host attests it every few minutes; a second, independent host checks and signs every
> round. Each round commits the exact issuer data behind it, so anyone can re-derive it with one
> command. ⏸ And every transaction carries our X Layer Builder Code.

**5 · Scorecard** (grid 1:24–1:56 · read ≈ 35 s) — anchor: "Before a reopen" — *Picture: a row committed, then graded; the terminal verifying it; the method card.*
> Before a reopen, Curb commits its price on chain. ⏸ After the reopen, the contract reads the pool
> itself, guarded by its own two-minute average, and grades us against the last price. ⏸ Every mark
> under the old method tied it, and a tie isn't a win. ⏸ So we changed the method, not the rows: the
> new mark listens to markets that trade while Hong Kong is shut, and its first rows are graded like
> every other: win, lose or tie.

*Delivery: "guarded by its own two-minute average" replaces v1.1's "Nobody supplies the answer, not even us".
That line overclaimed: whoever settles first picks the moment, and the guard only bounds how far that can
move the price. v1.1's "When the pools went quiet" is dropped too, because swap logs show the pools kept
trading through the recesses (`docs/AAVE_ARFC_CHANGES.md` items 9–11). The certain fact is that every
mark/1 row tied the last print. Say "win, lose or tie" evenly, not as a boast. Before recording, check that
at least one `curb.scorecard.mark/2` row has settled (see below). If none has, say "and its rows are graded
like every other" instead of "its first rows".*

**6 · Agents pay** (grid 1:56–2:32 · read ≈ 30 s) — *Picture: marketplace #13869; the 402; onchainos paying; the receipt.*
> Agents can buy all of this. Curb is registered on OKX's AI marketplace, with three paid services over
> x-four-oh-two. ⏸ Ask without paying, and you get a price and a free preview. ⏸ Pay one cent from an
> OKX Agentic Wallet, and you get the answer and a receipt tied to the exact bytes. ⏸ This one is our
> own wallet paying us: it proves the rail, not demand.

**7 · Instruments** (grid 2:32–2:58 · read ≈ 40 s) — *Picture: /notes, the note and its auction; /depth, the LTV read from chain.*
> If you need out while Hong Kong is shut, sell a Reopen Note, not the stock: a claim that settles at
> the verified reopen, through a falling-price auction. ⏸ We sold the first one to ourselves at three
> twenty-four in the morning, Hong Kong time: five point five nine five USDG, thirty-five basis points
> under the reference. ⏸ A lender reads one number: sixty percent open, thirty shut, never more than
> bonded bids would pay. ⏸ A refusal is a transaction, and nobody is liquidated while the exchange is
> shut.

*Delivery: "to ourselves" is deliberate. Both wallets are Curb's and the film says so, so don't soften it.
Say the price digit by digit, then give "thirty-five basis points" a beat on its own.*

**8 · Close** (grid 2:58–3:12 · read ≈ 12 s) — *Picture: the live hero; the end card: Curb, the tagline, curb.markets and MarketClock's address.*
> The exchange keeps its hours. The market doesn't. ⏸ If you build on X Layer, read MarketClock free,
> in three lines. Start at curb dot markets.

*Delivery: the last line is an invitation, not a slogan. The end card carries the tagline, so let it
finish on "curb dot markets" and hold a second of silence.*

---

**Where the spoken numbers come from** (each re-checkable read-only; RPC `https://xlayer.drpc.org`)

| said | fact | check |
|---|---|---|
| eleven fifty-five | the issuer's cap goes to zero at 11:55 HKT, 300 s before the 12:00 lunch break (measured 16 of 16) | `docs/DECISIONS.md` D-4 |
| eighty-four percent | a regular Hong Kong week is shut 141 h 20 m of 168 = 84.1% (README, D-4); 140 h 30 m (83.6%) without the early cut | README "141 h 20 m" |
| two-minute average | every registered price source has `twapWindow` 120 s; spot must sit within `MAX_TICK_DEVIATION` = 50 ticks (~0.5%) of it | `cast call 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f "priceSources(address)(address,bool,uint32,uint8,uint8)" 0x41333Df9E7639188BBfca5522dC4844398Af9f9E` → `…, 120, 18, 6` |
| every mark under the old method tied it | all 15 settled rows are `curb.scorecard.mark/1`, whose range closed at block 71,486,953; in each, the mark equalled the last print exactly (D-11 update, ARFC item 8) | `skill()` below: (15, 0, 0) |
| its first rows (mark/2) | the first `curb.scorecard.mark/2` rows are the overnight 24→25 Sep closures (commit ~01:20Z, settle ~01:35Z, 25 Sep); mark/1's range closed at block 71,486,953, so every row after the first 15 is mark/2 | `cast call 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f "skill()(uint256,uint256,uint256)"` returned (15, 0, 0) at 00:55Z on 25 Sep, all mark/1; a first value above 15 means a mark/2 row has settled |
| three paid services, one cent | #13869's three A2MCP services at $0.01 / $0.05 / $0.10; the call shown paid $0.01 (tx `0xe8740458…4de7`, 24 Sep 11:56Z) | README "curb-asp" |
| three twenty-four in the morning; five point five nine five; thirty-five basis points | ClosedAuction lot 1 (note 1, 0.1 wTCENTx): cleared 5.595137 USDG at 1790277843 = Fri 25 Sep 03:24:03 HKT (Thu 19:24:03Z); `refPrice` 5.614962 USDG, so 35.3 bp under; seller curb-desk `0xe1df…3A3E`, buyer the Agentic Wallet `0x055B…7105`, both team wallets (WALLETS.md); bid tx `0xf23e727c…d3d3` | `cast call 0xAc74864d69DdB940ADfDB39E69751759a32bb80D "lotOf(uint256)((address,address,uint256,uint128,uint128,uint128,uint128,uint64,uint64,uint32,uint32,uint8,address,uint128,uint64,uint64))" 1` |
| sixty percent open, thirty shut, never more than bonded bids would pay | `CurbCredit.LTV_OPEN_BPS` 6000, `LTV_SHUT_BPS` 3000; `ltvFor = min(regime cap, lowest bonded bid ÷ price)`, 0 with no bonded depth | `src/CurbCredit.sol:27-30, 131-132` |
| a refusal is a transaction; nobody is liquidated while shut | `borrow` emits `Refusal` and returns false inside a successful tx; `liquidate` reverts `MarketShut` unless MarketClock reports the primary market open | `src/CurbCredit.sol:75-82, 501-508` |
| three lines | `interface` + `constant` + `if (CLOCK.primaryCapNow(w) == 0) revert …;`, the snippet on curb.markets/clock ("Read it from a contract") | `web/clock/index.html` |

*Timing notes (v1.2, 25 Sep).* The picture is cut to the scripted grid `SCRIPTED=[0,14,40,52,84,116,152,178,192]`,
i.e. beats of 14 · 26 · 12 · 32 · 32 · 36 · 26 · 14 s, and `capture/align/` retimes it to the recorded read,
anchored on the first words of each beat above (beat 5: "Before a reopen"). The grid is unchanged in v1.2,
but the read is not spread the same way: expect about 11 · 25 · 8 · 28 · 35 · 30 · 40 · 12 s, landing between
3:00 and 3:15 (at 140 wpm it reaches about 3:17, still inside the 3:00–3:20 that `retime.mjs` accepts). The
retime maps each beat's cues in proportion, so beat 3 compresses to about 0.7× and beat 7 stretches to about
1.5×. The current clips only turn live partway in: `S06.mp4` shows the /notes first paint ("Specimen · in
build") until 15.0 s, and `S07.mp4` shows the /depth first paint ("Specimen · in build", "reading…") until
22.0 s. So v1.2 starts them there (`data-media-start` 15 and 22, previously 14.5 for both), which leaves
13.0 s and 5.5 s of live footage. After the retime, S06 holds its last frame (the lot 1 auction at 5.5951
USDG) for about 7 s and S07 holds its last frame (the live LTV read) for about 14 s, while the push-in
continues. `retime.mjs --dry` prints both. A longer /depth capture, such as the S07 cert run after the
bonded bid, fixes S07; its `data-media-start` must then be re-read from the new clip. The composition's beat 2
number now rises as "eighty-four percent" is said, about a quarter of the way into the beat, not at the half.

*Beat 7 picture.* The film defaults to 7A, the live captures (`instruments` = "A"). The specimen picture
(`--variables '{"instruments":"B"}'`) stays in the composition only as a fallback in case the live captures
can't be used. It plays under the same read, and its labels say it is an illustration of the live contracts.
