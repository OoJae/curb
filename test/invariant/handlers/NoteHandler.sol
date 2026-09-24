// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReopenNote} from "../../../src/ReopenNote.sol";
import {ReopenPointer} from "../../../src/ReopenPointer.sol";
import {IReopenNote} from "../../../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../../../src/interfaces/IReopenPointer.sol";
import {IMarketClock} from "../../../src/interfaces/IMarketClock.sol";
import {ClosedAuction} from "../../../src/ClosedAuction.sol";
import {MulDiv} from "../../../src/lib/MulDiv.sol";
import {MockClock} from "../../mocks/MockClock.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {MockWrapper4626} from "../../mocks/MockWrapper4626.sol";

/// @notice Bounded random driver for NoteInvariant: moves the clock (regime, cap, blackout, nonce), the 4626
///         rate and time, pokes the pointer, and makes actors mint, move, list on the real ClosedAuction, bid,
///         withdraw, grade, redeem and cancel notes. Actors 0-2 are eligible bidders; actor 3 is not.
///         Every action is try/caught; ghosts record what each SUCCESSFUL call must have satisfied, and
///         what every refusal that must happen did happen.
contract NoteHandler is Test {
    ReopenNote public note;
    ReopenPointer public pointer;
    MockClock public clock;
    ClosedAuction public auction;
    MockERC20 public usdg;
    MockWrapper4626[2] public wrappers;
    address[4] public actors; // [3] is ineligible

    // --- ghosts ---------------------------------------------------------------------------------
    uint256[] public ids;
    mapping(uint256 id => uint256) public delivered;
    mapping(uint256 id => uint256) public cancelled;

    mapping(address wrapper => uint32) public maxEpochSeen;
    bool public epochWentBack;

    struct PrintSeen { uint128 print; uint64 printedAt; }
    mapping(address wrapper => mapping(uint32 epoch => PrintSeen)) public printSeen;
    bool public printRewritten;

    bool public lockedRedeem;       // a redeem succeeded although neither unlock held afterwards
    bool public inexactDelivery;    // a redeem/cancel delivered other than exactly its amount
    bool public strandedRedeem;     // a redeem to the note itself succeeded
    bool public badBid;             // a bid cleared while open, in a later epoch, or outside [floor, start]
    bool public badPayment;         // a clearing moved USDG other than exactly `price` from buyer to seller
    bool public ineligibleCleared;  // the ineligible actor won a lot
    bool public unsolicitedAccepted; // the auction accepted a note it did not pull itself
    bool public badGrade;           // realisedDiscountBps disagreed with the print, or graded an unprintable lot
    bool public badList;            // a lot listed with no future cutoff, or ending after its cutoff
    mapping(uint256 lotId => uint256) public sales;

    uint256 public mints;
    uint256 public redeems;
    uint256 public fallbackRedeems;
    uint256 public cancels;
    uint256 public prints;
    uint256 public reopens;
    uint256 public bids;
    uint256 public ineligibleRefusals;
    uint256 public withdrawals;
    uint256 public grades;
    uint256 public cutoffRefusals;

    constructor(
        ReopenNote note_,
        ReopenPointer pointer_,
        MockClock clock_,
        ClosedAuction auction_,
        MockERC20 usdg_,
        MockWrapper4626[2] memory wrappers_,
        address[4] memory actors_
    ) {
        (note, pointer, clock, auction, usdg) = (note_, pointer_, clock_, auction_, usdg_);
        wrappers = wrappers_;
        actors = actors_;
    }

    modifier tracked() {
        _;
        for (uint256 i; i < 2; ++i) {
            address w = address(wrappers[i]);
            uint32 e = pointer.epochOf(w);
            if (e < maxEpochSeen[w]) epochWentBack = true;
            if (e > maxEpochSeen[w]) {
                reopens += e - maxEpochSeen[w];
                maxEpochSeen[w] = e;
            }
        }
    }

    function idCount() external view returns (uint256) { return ids.length; }

    function _w(uint256 seed) internal view returns (address) { return address(wrappers[seed % 2]); }
    function _actor(uint256 seed) internal view returns (address) { return actors[seed % 4]; }

    function _id(uint256 seed) internal view returns (uint256) {
        return ids.length == 0 ? 0 : ids[seed % ids.length];
    }

    /// The first actor, starting from `seed`, holding units of `id` (address(0) if none does).
    function _holder(uint256 seed, uint256 id) internal view returns (address) {
        for (uint256 i; i < 4; ++i) {
            address a = actors[(seed % 4 + i) % 4];
            if (note.balanceOf(a, id) > 0) return a;
        }
        return address(0);
    }

    // --- the world moves ------------------------------------------------------------------------

    /// The attestor moves the clock; half the time a keeper observes right after (poke.sh).
    function setRegime(uint256 wSeed, uint256 kind, uint128 cap, bool poked) external tracked {
        address w = _w(wSeed);
        kind %= 6;
        if (kind == 0) clock.setRegime(w, IMarketClock.Regime.UNKNOWN);
        else if (kind <= 3) clock.set(w, IMarketClock.Regime.CLOSED, 0); // shut is the common case, as on X Layer
        else clock.set(w, kind == 4 ? IMarketClock.Regime.MARKET : IMarketClock.Regime.OVERNIGHT, uint128(bound(cap, 1, 50_000_000)));
        // The attestor publishes the next scheduled boundary with the regime (0 = unknown, now and then).
        // These opens are unscheduled on purpose: the auction must stay safe even when a reopen comes early.
        if (kind != 0) _schedule(w, cap % 7 == 0 ? 0 : bound(cap, 10 minutes, 18 hours));
        if (poked) pointer.observe(w);
    }

    /// Mostly short steps (so the 300 s print delay and the 30 min window get hit), sometimes long
    /// jumps (so the 10-day fallback gets hit).
    function warp(uint256 dt) external tracked {
        _warp(dt % 4 == 0 ? bound(dt, 1 hours, 11 days) : bound(dt, 0, 900));
    }

    function setBlackout(uint256 wSeed, uint256 on) external tracked {
        clock.setBlackout(_w(wSeed), on % 4 == 0);
    }

    function corporateAction(uint256 wSeed, uint256 rate) external tracked {
        address w = _w(wSeed);
        MockWrapper4626(w).setRate(bound(rate, 0.25e18, 4e18));
        clock.setNonce(w, clock.stateOf(w).multiplierNonce + 1);
    }

    // --- pointer ---------------------------------------------------------------------------------

    function observe(uint256 wSeed, uint256 actorSeed) external tracked {
        vm.prank(_actor(actorSeed));
        pointer.observe(_w(wSeed));
    }

    /// Any epoch, including 0 and head + 1 (which must be refused).
    function recordPrint(uint256 wSeed, uint256 epochSeed) external tracked {
        address w = _w(wSeed);
        _print(w, uint32(bound(epochSeed, 0, uint256(pointer.epochOf(w)) + 1)));
    }

    /// What the operator's poke does: observe, then try to print the head epoch.
    function poke(uint256 wSeed) external tracked {
        address w = _w(wSeed);
        (uint32 head,) = pointer.observe(w);
        _print(w, head);
    }

    /// A whole overnight as the operator runs it: shut witnessed, a gap, the reopen witnessed, then a print
    /// attempt somewhere between too early and too late; half the time the session then ends (shut again).
    /// Mostly wT, so wA notes stay locked long enough to reach the 10-day fallback now and then.
    function keeperReopen(uint256 wSeed, uint256 gap, uint256 printAfter, uint128 cap) external tracked {
        address w = address(wrappers[wSeed % 4 == 0 ? 1 : 0]);
        clock.set(w, IMarketClock.Regime.CLOSED, 0);
        _schedule(w, bound(gap, 0, 12 hours) + 1); // this closure's scheduled reopen
        pointer.observe(w);
        // A scheduled reopen: never before the boundary the clock published.
        uint64 boundary = clock.stateOf(w).nextTransitionAt;
        if (block.timestamp < boundary) _warp(boundary - block.timestamp);
        clock.set(w, IMarketClock.Regime.MARKET, uint128(bound(cap, 1, 50_000_000)));
        _schedule(w, 2 hours); // next boundary: the session's close
        (uint32 head,) = pointer.observe(w);
        _warp(bound(printAfter, 0, 2400));
        _print(w, head);
        if (gap % 2 == 0) {
            clock.set(w, IMarketClock.Regime.CLOSED, 0);
            _schedule(w, bound(printAfter, 10 minutes, 18 hours));
            pointer.observe(w);
        }
    }

    /// Next boundary `dt` seconds from now (dt = 0: no boundary published).
    function _schedule(address w, uint256 dt) internal {
        clock.setNextTransition(w, dt == 0 ? 0 : uint64(block.timestamp + dt));
    }

    function _warp(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1 + dt / 2);
    }

    function _print(address w, uint32 e) internal {
        try pointer.recordPrint(w, e) returns (uint128 p) {
            PrintSeen storage s = printSeen[w][e];
            if (s.printedAt != 0) printRewritten = true; // a second success for the same (w, e)
            s.print = p;
            s.printedAt = uint64(block.timestamp);
            prints++;
            _gradeSold(w);
        } catch {}
    }

    // --- note ------------------------------------------------------------------------------------

    function mint(uint256 actorSeed, uint256 wSeed, uint256 shares, uint256 toSeed) external tracked {
        address issuer = _actor(actorSeed);
        shares = bound(shares, 1, 20e18);
        vm.prank(issuer);
        try note.mint(_w(wSeed), uint128(shares), _actor(toSeed)) returns (uint256 id) {
            ids.push(id);
            mints++;
        } catch {}
    }

    function redeem(uint256 actorSeed, uint256 idSeed, uint256 amount, uint256 toSeed) external tracked {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        address holder = _holder(actorSeed, id);
        if (holder == address(0)) return;
        amount = bound(amount, 1, note.balanceOf(holder, id));
        // Now and then aim the shares at the note itself: that must always be refused.
        address to = toSeed % 16 == 0 ? address(note) : _actor(toSeed);
        IReopenNote.Unit memory u = note.unitOf(id);
        uint256 before = MockWrapper4626(u.wrapper).balanceOf(to);

        vm.prank(holder);
        try note.redeem(id, uint128(amount), to) {
            if (to == address(note)) strandedRedeem = true;
            delivered[id] += amount;
            redeems++;
            bool byEpoch = pointer.epochOf(u.wrapper) > u.epochAtMint;
            bool byTime = block.timestamp >= uint256(u.mintedAt) + note.FALLBACK_AFTER();
            if (!byEpoch && !byTime) lockedRedeem = true;
            if (!byEpoch) fallbackRedeems++;
            if (MockWrapper4626(u.wrapper).balanceOf(to) != before + amount) inexactDelivery = true;
        } catch {}
    }

    function cancel(uint256 actorSeed, uint256 idSeed) external tracked {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        IReopenNote.Unit memory u = note.unitOf(id);
        // Mostly the issuer (the only one who can); sometimes someone else, who must be refused.
        address who = actorSeed % 4 == 0 ? _actor(actorSeed / 4) : u.issuer;
        uint256 out = note.outstanding(id);
        uint256 before = MockWrapper4626(u.wrapper).balanceOf(who);
        vm.prank(who);
        try note.cancel(id) {
            cancelled[id] += out;
            cancels++;
            if (MockWrapper4626(u.wrapper).balanceOf(who) != before + out) inexactDelivery = true;
        } catch {}
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 idSeed, uint256 amount) external tracked {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        address from = _holder(fromSeed, id);
        if (from == address(0)) return;
        uint256 bal = note.balanceOf(from, id);
        vm.prank(from);
        note.safeTransferFrom(from, _actor(toSeed), id, bound(amount, 1, bal), "");
    }

    // --- auction path (the real ClosedAuction) -------------------------------------------------------

    /// The first lot, starting from `seed`, in `want` status; any lot if none is (so refusals are hit too).
    function _lot(uint256 seed, uint256 n, ClosedAuction.Status want) internal view returns (uint256) {
        uint256 first = seed % n;
        for (uint256 i; i < n; ++i) {
            uint256 lotId = 1 + (first + i) % n;
            if (auction.lotOf(lotId).status == want) return lotId;
        }
        return 1 + first;
    }

    function list(uint256 actorSeed, uint256 idSeed, uint256 amount, uint256 start, uint256 floorBps, uint256 decay, uint256 life)
        external
        tracked
    {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        address seller = _holder(actorSeed, id);
        if (seller == address(0)) return;
        // Mostly real-sized lots (>= 0.1 share, so they can be graded); one in eight may be dust, which
        // realisedDiscountBps must refuse (worth < 1 USDG unit at the print).
        uint256 bal = note.balanceOf(seller, id);
        amount = amount % 8 == 0 || bal < 1e17 ? bound(amount, 1, bal) : bound(amount, 1e17, bal);
        start = bound(start, 1e6, 10_000e6);
        uint256 floor_ = start * bound(floorBps, 1, 10_000) / 10_000;
        if (floor_ == 0) floor_ = 1;
        decay = bound(decay, 60, 6 hours);
        uint64 endAt = _endAt(note.unitOf(id).wrapper, life);
        vm.prank(seller);
        try auction.list(id, uint128(amount), uint128(start), uint128(floor_), uint32(decay), endAt) returns (uint256 lotId) {
            ClosedAuction.Lot memory l = auction.lotOf(lotId);
            // The lot is pinned inside the closure segment it was listed in.
            if (l.cutoff <= l.startAt || l.endAt > l.cutoff || l.cutoff != clock.stateOf(l.wrapper).nextTransitionAt) {
                badList = true;
            }
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (sel == ClosedAuction.NoCutoff.selector || sel == ClosedAuction.SpansTransition.selector) cutoffRefusals++;
        }
    }

    /// The lot's end, by mode (life % 16): 0 = as the seller asks, no refresh of the boundary (a stale or
    /// missing one must be refused); 1 = one second past the boundary (must be refused); otherwise the
    /// attestor has a future boundary on record and the lot ends by it, as the operator's cycle does.
    function _endAt(address w, uint256 life) internal returns (uint64) {
        uint256 mode = life % 16;
        life = bound(life, 10 minutes, 4 days);
        uint64 next = clock.stateOf(w).nextTransitionAt;
        if (mode != 0 && next <= block.timestamp) {
            _schedule(w, bound(life, 10 minutes, 18 hours));
            next = clock.stateOf(w).nextTransitionAt;
        }
        if (mode == 1) return next + 1;
        uint256 end = block.timestamp + life;
        return uint64(mode != 0 && end > next ? next : end);
    }

    function bid(uint256 actorSeed, uint256 lotSeed, uint256 slack) external tracked {
        uint256 n = auction.lotCount();
        if (n == 0) return;
        uint256 lotId = _lot(lotSeed, n, ClosedAuction.Status.LIVE);
        address bidder = _actor(actorSeed);
        ClosedAuction.Lot memory l = auction.lotOf(lotId);
        uint256 maxPrice = uint256(l.startPrice) + bound(slack, 0, 1e6);
        uint256 sellerBefore = usdg.balanceOf(l.seller);
        uint256 bidderBefore = usdg.balanceOf(bidder);
        vm.prank(bidder);
        try auction.bid(lotId, maxPrice) returns (uint256 price) {
            bids++;
            sales[lotId]++;
            if (bidder == actors[3]) ineligibleCleared = true;
            bool shut = clock.regime(l.wrapper) == IMarketClock.Regime.CLOSED && clock.primaryCapNow(l.wrapper) == 0
                && !pointer.isOpen(l.wrapper);
            bool sameEpoch = pointer.epochOf(l.wrapper) == l.epochAtMint
                && note.unitOf(l.noteId).epochAtMint == l.epochAtMint;
            bool inBounds = price >= l.floorPrice && price <= l.startPrice && price <= maxPrice;
            if (!shut || !sameEpoch || !inBounds) badBid = true;
            ClosedAuction.Lot memory after_ = auction.lotOf(lotId);
            if (after_.status != ClosedAuction.Status.SOLD || after_.buyer != bidder || after_.clearedPrice != price) {
                badBid = true;
            }
            if (bidder == l.seller) {
                if (usdg.balanceOf(bidder) != bidderBefore) badPayment = true;
            } else if (usdg.balanceOf(l.seller) != sellerBefore + price || usdg.balanceOf(bidder) + price != bidderBefore) {
                badPayment = true;
            }
        } catch (bytes memory err) {
            if (bidder == actors[3]) {
                if (bytes4(err) != ClosedAuction.Ineligible.selector) ineligibleCleared = true; // wrong refusal
                ineligibleRefusals++;
            }
        }
    }

    function withdrawLot(uint256 lotSeed) external tracked {
        uint256 n = auction.lotCount();
        if (n == 0) return;
        uint256 lotId = _lot(lotSeed, n, ClosedAuction.Status.LIVE);
        vm.prank(auction.lotOf(lotId).seller);
        try auction.withdraw(lotId) {
            withdrawals++;
        } catch {}
    }

    /// Grade a lot: a sold lot whose next epoch is printed must grade to (V - cleared)·1e4 / V; anything
    /// else must be refused.
    function grade(uint256 lotSeed) external tracked {
        uint256 n = auction.lotCount();
        if (n == 0) return;
        _grade(_lot(lotSeed, n, ClosedAuction.Status.SOLD));
    }

    /// After a print, the operator reads the grade of every sold lot on that wrapper.
    function _gradeSold(address w) internal {
        uint256 n = auction.lotCount();
        for (uint256 lotId = 1; lotId <= n; ++lotId) {
            ClosedAuction.Lot memory l = auction.lotOf(lotId);
            if (l.wrapper == w && l.status == ClosedAuction.Status.SOLD) _grade(lotId);
        }
    }

    function _grade(uint256 lotId) internal {
        ClosedAuction.Lot memory l = auction.lotOf(lotId);
        uint128 print = pointer.epochInfo(l.wrapper, l.epochAtMint + 1).print;
        uint256 v = MulDiv.mulDiv(l.amount, print, 1e30);
        bool gradable = l.status == ClosedAuction.Status.SOLD && print != 0 && v != 0;
        try auction.realisedDiscountBps(lotId) returns (int256 bps) {
            grades++;
            if (!gradable || bps != (int256(v) - int256(uint256(l.clearedPrice))) * 1e4 / int256(v)) badGrade = true;
        } catch {
            if (gradable) badGrade = true;
        }
    }

    /// Push a note straight at the auction, as an operator-less gift: it must be refused.
    function unsolicited(uint256 actorSeed, uint256 idSeed) external tracked {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        address from = _holder(actorSeed, id);
        if (from == address(0)) return;
        vm.prank(from);
        try note.safeTransferFrom(from, address(auction), id, 1, "") {
            unsolicitedAccepted = true;
        } catch {}
    }
}
