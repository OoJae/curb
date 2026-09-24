// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ReopenNote} from "../../src/ReopenNote.sol";
import {ReopenPointer} from "../../src/ReopenPointer.sol";
import {IReopenNote} from "../../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../../src/interfaces/IReopenPointer.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../../src/interfaces/IScorecardPrice.sol";
import {MockClock} from "../mocks/MockClock.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockScorecardPrice} from "../mocks/MockScorecardPrice.sol";
import {MockWrapper4626} from "../mocks/MockWrapper4626.sol";
import {NoteHandler, MiniAuction} from "./handlers/NoteHandler.sol";

/// NoteInvariant (P1, W3 spec "Invariants"): under random regimes, caps, blackouts, 4626 rate and nonce
/// changes, time jumps, pointer pokes, prints, mints, transfers, auction lists/bids/withdrawals, redeems
/// and cancels:
///   - per note: delivered + cancelled + outstanding == wrapperShares, and units held == outstanding;
///   - per wrapper: the note's wrapper balance == Σ outstanding == openInterest <= cap;
///   - the epoch never decreases; every bracket is shutSeenAt < openedAt <= next shutSeenAt;
///   - prints are write-once;
///   - every successful redeem was unlocked (epoch moved past epochAtMint, or the 10-day fallback)
///     and delivered exactly its amount;
///   - every successful bid cleared while shut, in the note's unchanged epoch, within [floor, start];
///     each lot sells at most once.
/// Stage 1 drives the auction path through MiniAuction (the spec's gates); stage 2 swaps in ClosedAuction.
contract NoteInvariant is StdInvariant, Test {
    MockClock clock;
    MockScorecardPrice sc;
    ReopenPointer pointer;
    ReopenNote note;
    MiniAuction auction;
    MockERC20 usdg;
    MockWrapper4626 wT;
    MockWrapper4626 wA;
    NoteHandler handler;
    address[3] actors;

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(1000);
        clock = new MockClock();
        sc = new MockScorecardPrice();
        wT = new MockWrapper4626(makeAddr("TCENTx"), "wTCENTx", "wTCENTx");
        wA = new MockWrapper4626(makeAddr("AAPLx"), "wAAPLx", "wAAPLx");
        sc.setPrice(address(wT), 55.78e18);
        sc.setPrice(address(wA), 337.89e18);
        pointer = new ReopenPointer(IMarketClock(address(clock)), IScorecardPrice(address(sc)));

        address[] memory ws = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (ws[0], ws[1], caps[0], caps[1]) = (address(wT), address(wA), 175e18, 14e18);
        note = new ReopenNote(
            IMarketClock(address(clock)), IReopenPointer(address(pointer)), IScorecardPrice(address(sc)), ws, caps,
            "https://api.curb.markets/v1/notes/{id}.json"
        );
        usdg = new MockERC20("USDG", "USDG", 6);
        auction = new MiniAuction(note, IReopenPointer(address(pointer)), IMarketClock(address(clock)), address(usdg));

        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
        for (uint256 i; i < 3; ++i) {
            address a = actors[i];
            wT.mint(a, 10_000e18);
            wA.mint(a, 10_000e18);
            usdg.mint(a, 1e15);
            vm.startPrank(a);
            wT.approve(address(note), type(uint256).max);
            wA.approve(address(note), type(uint256).max);
            usdg.approve(address(auction), type(uint256).max);
            note.setApprovalForAll(address(auction), true);
            vm.stopPrank();
        }
        clock.set(address(wT), IMarketClock.Regime.CLOSED, 0);
        clock.set(address(wA), IMarketClock.Regime.CLOSED, 0);

        handler = new NoteHandler(note, pointer, clock, auction, usdg, [wT, wA], actors);
        targetContract(address(handler));
    }

    // --- per note ----------------------------------------------------------------------------------

    function invariant_delivered_plus_cancelled_plus_outstanding_is_wrapperShares() public view {
        uint256 n = handler.idCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ids(i);
            IReopenNote.Unit memory u = note.unitOf(id);
            assertEq(handler.delivered(id) + handler.cancelled(id) + note.outstanding(id), u.wrapperShares, "conservation");
        }
    }

    function invariant_units_held_equal_outstanding() public view {
        uint256 n = handler.idCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ids(i);
            uint256 held = note.balanceOf(address(auction), id);
            for (uint256 j; j < 3; ++j) held += note.balanceOf(actors[j], id);
            assertEq(held, note.outstanding(id), "units == outstanding");
        }
    }

    // --- per wrapper ---------------------------------------------------------------------------------

    function invariant_escrow_equals_sum_outstanding_equals_open_interest() public view {
        MockWrapper4626[2] memory ws = [wT, wA];
        for (uint256 k; k < 2; ++k) {
            address w = address(ws[k]);
            uint256 sum;
            uint256 n = handler.idCount();
            for (uint256 i; i < n; ++i) {
                uint256 id = handler.ids(i);
                if (note.unitOf(id).wrapper == w) sum += note.outstanding(id);
            }
            assertEq(ws[k].balanceOf(address(note)), sum, "escrow == sum outstanding");
            assertEq(note.openInterest(w), sum, "openInterest == sum outstanding");
            assertLe(sum, note.capShares(w), "within cap");
        }
    }

    // --- pointer -------------------------------------------------------------------------------------

    function invariant_epoch_never_decreases() public view {
        assertFalse(handler.epochWentBack());
        assertGe(pointer.epochOf(address(wT)), handler.maxEpochSeen(address(wT)));
        assertGe(pointer.epochOf(address(wA)), handler.maxEpochSeen(address(wA)));
    }

    function invariant_brackets_are_strict_and_chained() public view {
        address[2] memory ws = [address(wT), address(wA)];
        for (uint256 k; k < 2; ++k) {
            uint32 head = pointer.epochOf(ws[k]);
            uint64 prevOpenedAt;
            for (uint32 e = 1; e <= head; ++e) {
                IReopenPointer.Epoch memory ep = pointer.epochInfo(ws[k], e);
                assertLt(ep.shutSeenAt, ep.openedAt, "shutSeenAt < openedAt");
                assertLe(prevOpenedAt, ep.shutSeenAt, "openedAt <= next shutSeenAt");
                prevOpenedAt = ep.openedAt;
            }
            ReopenPointer.Head memory h = pointer.headOf(ws[k]);
            if (head > 0 && !h.open) assertLe(prevOpenedAt, h.lastShutAt, "latest shut after latest open");
        }
    }

    function invariant_prints_are_write_once() public view {
        assertFalse(handler.printRewritten());
        address[2] memory ws = [address(wT), address(wA)];
        for (uint256 k; k < 2; ++k) {
            uint32 head = pointer.epochOf(ws[k]);
            for (uint32 e = 1; e <= head; ++e) {
                IReopenPointer.Epoch memory ep = pointer.epochInfo(ws[k], e);
                (uint128 p, uint64 at) = handler.printSeen(ws[k], e);
                assertEq(ep.print, p, "stored print == the first recorded");
                assertEq(ep.printedAt, at, "printedAt unchanged");
                if (at != 0) {
                    assertGe(at, ep.openedAt + 300);
                    assertLe(at, ep.openedAt + 300 + 1800);
                }
            }
        }
    }

    // --- redeem ----------------------------------------------------------------------------------------

    function invariant_every_redeem_was_unlocked_and_exact() public view {
        assertFalse(handler.lockedRedeem(), "a locked note redeemed");
        assertFalse(handler.inexactDelivery(), "delivery != amount");
    }

    // --- auction path ------------------------------------------------------------------------------------

    function invariant_bids_clear_shut_same_epoch_within_bounds() public view {
        assertFalse(handler.badBid());
    }

    function invariant_each_lot_sells_at_most_once() public view {
        uint256 n = auction.lotCount();
        for (uint256 lotId = 1; lotId <= n; ++lotId) {
            assertLe(handler.sales(lotId), 1);
            MiniAuction.Lot memory l = auction.lotOf(lotId);
            if (l.status == MiniAuction.Status.SOLD) {
                assertGe(l.clearedPrice, l.floorPrice);
                assertLe(l.clearedPrice, l.startPrice);
            }
        }
    }

    /// With NOTE_INV_STATS set, append this run's ghost counters (successful mints, redeems, fallback
    /// redeems, cancels, prints, reopens, bids, lots, notes) to the file it names, so the campaign's
    /// coverage can be summarised next to its result. Off by default: the gate run writes nothing.
    function afterInvariant() public {
        string memory path = vm.envOr("NOTE_INV_STATS", string(""));
        if (bytes(path).length == 0) return;
        vm.writeLine(path, string.concat(
            vm.toString(handler.mints()), " ", vm.toString(handler.redeems()), " ", vm.toString(handler.fallbackRedeems()), " ",
            vm.toString(handler.cancels()), " ", vm.toString(handler.prints()), " ", vm.toString(handler.reopens()), " ",
            vm.toString(handler.bids()), " ", vm.toString(auction.lotCount()), " ", vm.toString(handler.idCount())));
    }

    /// Not an invariant, a proof the campaign is not vacuous: a scripted pass through every handler path.
    function test_handler_paths_all_succeed() public {
        handler.mint(0, 0, 10e18, 1);            // alice mints 10 wT to bob, pointer arms (shut seen)
        handler.mint(2, 1, 5e18, 2);             // carol mints 5 wA to herself
        handler.list(1, 0, 4e18, 5_600_000, 9_700, 1200, 2 hours); // bob lists 4 units
        handler.warp(601);                       // (dt % 4 != 0: a short step)
        handler.bid(2, 0, 0);                    // carol buys the lot while shut
        assertEq(handler.bids(), 1);
        handler.transfer(1, 0, 0, 1e18);         // bob -> alice 1 unit
        handler.setRegime(0, 4, 2_000_000, false); // wT opens (MARKET), nobody pokes
        handler.warp(1);
        handler.observe(0, 0);                   // reopen witnessed: epoch 1
        assertEq(pointer.epochOf(address(wT)), 1);
        handler.warp(301);
        handler.recordPrint(0, 1);
        assertEq(handler.prints(), 1);
        handler.corporateAction(0, 2e18);        // rate and nonce move before anyone redeems
        handler.redeem(1, 0, 5e18, 1);           // bob redeems 5
        handler.redeem(2, 0, 4e18, 2);           // carol redeems the lot's 4
        handler.redeem(0, 0, 1e18, 0);           // alice redeems 1
        assertEq(handler.redeems(), 3);
        assertEq(note.outstanding(1), 0);
        handler.cancel(1, 1);                    // issuer carol cancels the wA note she holds whole
        assertEq(handler.cancels(), 1);
        handler.mint(0, 1, 1e18, 0);             // wA still shut: alice mints
        handler.warp(4 days);
        handler.warp(4 days);
        handler.warp(2 days);
        handler.redeem(0, 2, 1e18, 0);           // the 10-day fallback
        assertEq(handler.fallbackRedeems(), 1);

        invariant_delivered_plus_cancelled_plus_outstanding_is_wrapperShares();
        invariant_units_held_equal_outstanding();
        invariant_escrow_equals_sum_outstanding_equals_open_interest();
        invariant_epoch_never_decreases();
        invariant_brackets_are_strict_and_chained();
        invariant_prints_are_write_once();
        invariant_every_redeem_was_unlocked_and_exact();
        invariant_bids_clear_shut_same_epoch_within_bounds();
        invariant_each_lot_sells_at_most_once();
    }
}
