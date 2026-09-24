// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ClosedAuction} from "../src/ClosedAuction.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {IReopenNote} from "../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../src/interfaces/IReopenPointer.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../src/interfaces/IScorecardPrice.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {ERC1155Min} from "../src/lib/ERC1155Min.sol";
import {SafeTransfer} from "../src/lib/SafeTransfer.sol";
import {MockClock} from "./mocks/MockClock.sol";
import {MockScorecardPrice} from "./mocks/MockScorecardPrice.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPointer} from "./mocks/MockPointer.sol";
import {MockNote} from "./mocks/MockNote.sol";
import {MockWrapper4626} from "./mocks/MockWrapper4626.sol";
import {ReopenPointer} from "../src/ReopenPointer.sol";
import {ReopenNote} from "../src/ReopenNote.sol";

/// A bidder contract that tries to re-enter the auction from its ERC-1155 hook.
contract ReentrantBidder {
    ClosedAuction public immutable auction;
    uint256 public target;
    bytes4 public mode; // which entry point to re-enter

    constructor(ClosedAuction a) {
        auction = a;
    }

    function approve(IERC20 t) external {
        t.approve(address(auction), type(uint256).max);
    }

    function bid(uint256 lotId, uint256 max, uint256 target_, bytes4 mode_) external returns (uint256) {
        target = target_;
        mode = mode_;
        return auction.bid(lotId, max);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (mode == ClosedAuction.withdraw.selector) auction.withdraw(target);
        else if (mode == ClosedAuction.bid.selector) auction.bid(target, type(uint256).max);
        return this.onERC1155Received.selector;
    }
}

/// A contract bidder with no ERC-1155 hook: the note refuses to deliver to it, so its bid must revert whole.
contract HooklessBidder {
    function go(ClosedAuction a, IERC20 t, uint256 lotId) external returns (uint256) {
        t.approve(address(a), type(uint256).max);
        return a.bid(lotId, type(uint256).max);
    }
}

contract ClosedAuctionTest is Test {
    bytes constant SUFFIX = hex"6464377535306e636b74356537323966100080218021802180218021802180218021";

    uint128 constant AMOUNT = 0.1e18;       // 0.1 wTCENTx
    uint128 constant PRICE = 55.78e18;      // Scorecard priceNow, 1e18 USD per share
    uint128 constant REF = 5_578_000;       // valueUsdg(AMOUNT, PRICE)
    uint128 constant START = 5_600_000;
    uint128 constant FLOOR = 5_430_000;
    uint32 constant DECAY = 1200;

    MockClock clock;
    MockScorecardPrice sc;
    MockERC20 usdg;
    MockPointer pointer;
    MockNote note;
    EligibilityRegistry registry;
    ClosedAuction auction;

    address w = makeAddr("wTCENTx");
    address seller = makeAddr("seller");
    address bidder = makeAddr("bidder");
    address stranger = makeAddr("stranger");

    uint64 t0;

    function setUp() public {
        vm.warp(1_790_000_000);
        t0 = uint64(block.timestamp);

        clock = new MockClock();
        sc = new MockScorecardPrice();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        pointer = new MockPointer();
        note = new MockNote(pointer);
        registry = new EligibilityRegistry(address(this));
        auction = _auction(IEligibility(address(registry)));

        clock.set(w, IMarketClock.Regime.CLOSED, 0);
        sc.setPrice(w, PRICE);
        pointer.setEpoch(w, 3); // the market has already reopened three times before this closure

        registry.setEligible(bidder, true, keccak256("test:bidder"));

        vm.prank(seller);
        note.setApprovalForAll(address(auction), true);
        usdg.mint(bidder, 1_000e6);
        vm.prank(bidder);
        usdg.approve(address(auction), type(uint256).max);
    }

    function _auction(IEligibility e) internal returns (ClosedAuction) {
        return new ClosedAuction(
            IReopenNote(address(note)),
            IReopenPointer(address(pointer)),
            IMarketClock(address(clock)),
            IScorecardPrice(address(sc)),
            IERC20(address(usdg)),
            e
        );
    }

    function _mint(uint128 amount) internal returns (uint256 id) {
        vm.prank(seller);
        id = note.mint(w, amount, seller);
    }

    function _list(uint256 id, uint128 amount, uint128 start, uint128 floor_, uint32 decay, uint64 endAt)
        internal
        returns (uint256)
    {
        vm.prank(seller);
        return auction.list(id, amount, start, floor_, decay, endAt);
    }

    /// The demo lot: 0.1 wTCENTx, 5.60 → 5.43 USDG over 20 minutes, 40 minutes of life.
    function _demoLot() internal returns (uint256 id, uint256 lotId) {
        id = _mint(AMOUNT);
        lotId = _list(id, AMOUNT, START, FLOOR, DECAY, t0 + 2400);
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    // --- constructor ------------------------------------------------------------------------------

    function test_constructor_wires_everything_and_rejects_zero_addresses() public {
        assertEq(address(auction.note()), address(note));
        assertEq(address(auction.pointer()), address(pointer));
        assertEq(address(auction.clock()), address(clock));
        assertEq(address(auction.scorecard()), address(sc));
        assertEq(address(auction.usdg()), address(usdg));
        assertEq(address(auction.eligibility()), address(registry));

        vm.expectRevert(ClosedAuction.BadParams.selector);
        new ClosedAuction(IReopenNote(address(0)), IReopenPointer(address(pointer)), IMarketClock(address(clock)),
            IScorecardPrice(address(sc)), IERC20(address(usdg)), IEligibility(address(0)));
        vm.expectRevert(ClosedAuction.BadParams.selector);
        new ClosedAuction(IReopenNote(address(note)), IReopenPointer(address(pointer)), IMarketClock(address(clock)),
            IScorecardPrice(address(sc)), IERC20(address(0)), IEligibility(address(0)));
        // eligibility may be zero (ungated)
        assertEq(address(_auction(IEligibility(address(0))).eligibility()), address(0));
    }

    // --- list -------------------------------------------------------------------------------------

    function test_list_escrows_the_note_and_records_the_lot() public {
        uint256 id = _mint(AMOUNT);
        vm.expectEmit(true, true, true, true, address(auction));
        emit ClosedAuction.Listed(1, id, seller, w, AMOUNT, START, FLOOR, t0 + 2400, REF);
        uint256 lotId = _list(id, AMOUNT, START, FLOOR, DECAY, t0 + 2400);

        assertEq(lotId, 1);
        assertEq(auction.lotCount(), 1);
        assertEq(note.balanceOf(address(auction), id), AMOUNT, "note escrowed");
        assertEq(note.balanceOf(seller, id), 0);

        ClosedAuction.Lot memory l = auction.lotOf(lotId);
        assertEq(l.seller, seller);
        assertEq(l.wrapper, w);
        assertEq(l.noteId, id);
        assertEq(l.amount, AMOUNT);
        assertEq(l.startPrice, START);
        assertEq(l.floorPrice, FLOOR);
        assertEq(l.refPrice, REF);
        assertEq(l.startAt, t0);
        assertEq(l.endAt, t0 + 2400);
        assertEq(l.decaySeconds, DECAY);
        assertEq(l.epochAtMint, 3);
        assertEq(uint8(l.status), uint8(ClosedAuction.Status.LIVE));
        assertEq(l.buyer, address(0));
        assertEq(l.clearedPrice, 0);
        assertEq(l.clearedAt, 0);
    }

    function test_list_partial_amount_leaves_the_rest_with_the_seller() public {
        uint256 id = _mint(AMOUNT);
        _list(id, AMOUNT / 4, START / 4, FLOOR / 4, DECAY, t0 + 2400);
        assertEq(note.balanceOf(address(auction), id), AMOUNT / 4);
        assertEq(note.balanceOf(seller, id), AMOUNT - AMOUNT / 4);
    }

    function test_list_refPrice_is_zero_when_scorecard_reverts() public {
        sc.setRevert(w, true);
        (, uint256 lotId) = _demoLot();
        assertEq(auction.lotOf(lotId).refPrice, 0);
    }

    function test_list_rejects_bad_amounts_and_prices() public {
        uint256 id = _mint(AMOUNT);
        vm.startPrank(seller);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, 0, START, FLOOR, DECAY, t0 + 2400);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, AMOUNT, START, 0, DECAY, t0 + 2400);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, AMOUNT, START, START + 1, DECAY, t0 + 2400);
        // floor == start is a flat price: allowed
        auction.list(id, AMOUNT, START, START, DECAY, t0 + 2400);
        vm.stopPrank();
    }

    function test_list_decay_bounds() public {
        uint256 id = _mint(AMOUNT);
        vm.startPrank(seller);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, AMOUNT, START, FLOOR, 59, t0 + 2400);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, AMOUNT, START, FLOOR, 6 hours + 1, t0 + 2400);
        auction.list(id, 1, START, FLOOR, 60, t0 + 2400);
        auction.list(id, 1, START, FLOOR, 6 hours, t0 + 2400);
        vm.stopPrank();
    }

    function test_list_endAt_bounds() public {
        uint256 id = _mint(AMOUNT);
        vm.startPrank(seller);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, AMOUNT, START, FLOOR, DECAY, t0);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, AMOUNT, START, FLOOR, DECAY, t0 - 1);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(id, AMOUNT, START, FLOOR, DECAY, t0 + 4 days + 1);
        auction.list(id, 1, START, FLOOR, DECAY, t0 + 1);
        auction.list(id, 1, START, FLOOR, DECAY, t0 + 4 days);
        vm.stopPrank();
    }

    function test_list_rejects_an_unknown_note() public {
        vm.prank(seller);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(99, AMOUNT, START, FLOOR, DECAY, t0 + 2400);
    }

    function test_list_requires_closed_with_zero_capacity() public {
        uint256 id = _mint(AMOUNT);
        IMarketClock.Regime[4] memory rs = [
            IMarketClock.Regime.UNKNOWN,
            IMarketClock.Regime.OVERNIGHT,
            IMarketClock.Regime.EXTENDED,
            IMarketClock.Regime.MARKET
        ];
        for (uint256 i; i < rs.length; ++i) {
            clock.set(w, rs[i], 20_000_000);
            vm.prank(seller);
            vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
            auction.list(id, AMOUNT, START, FLOOR, DECAY, t0 + 2400);
        }
        // CLOSED but with capacity still reported: not shut
        clock.set(w, IMarketClock.Regime.CLOSED, 1);
        vm.prank(seller);
        vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
        auction.list(id, AMOUNT, START, FLOOR, DECAY, t0 + 2400);
    }

    function test_list_rejects_a_note_minted_before_a_reopen() public {
        uint256 id = _mint(AMOUNT);
        pointer.reopen(w); // epoch 3 -> 4
        pointer.shut(w);   // and shut again: the market looks closed, but the note's closure is over
        vm.prank(seller);
        vm.expectRevert(ClosedAuction.ReopenedSinceMint.selector);
        auction.list(id, AMOUNT, START, FLOOR, DECAY, t0 + 2400);
    }

    function test_list_needs_operator_approval_and_balance() public {
        uint256 id = _mint(AMOUNT);
        vm.prank(seller);
        note.setApprovalForAll(address(auction), false);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155NotAuthorized.selector, address(auction), seller));
        auction.list(id, AMOUNT, START, FLOOR, DECAY, t0 + 2400);

        vm.prank(seller);
        note.setApprovalForAll(address(auction), true);
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(ERC1155Min.ERC1155InsufficientBalance.selector, seller, id, AMOUNT, AMOUNT + 1)
        );
        auction.list(id, AMOUNT + 1, START, FLOOR, DECAY, t0 + 2400);
        assertEq(auction.lotCount(), 0, "a failed list leaves nothing behind");
    }

    // --- price ------------------------------------------------------------------------------------

    function test_priceAt_is_linear_then_flat_at_the_floor() public {
        (, uint256 lotId) = _demoLot();
        assertEq(auction.priceAt(lotId, t0 - 100), START, "before start: start price");
        assertEq(auction.priceAt(lotId, t0), START);
        assertEq(auction.priceAt(lotId, t0 + 1), START - 141); // 170_000 * 1 / 1200 = 141.67, rounded down
        assertEq(auction.priceAt(lotId, t0 + 300), 5_557_500);
        assertEq(auction.priceAt(lotId, t0 + 600), 5_515_000);
        assertEq(auction.priceAt(lotId, t0 + 1199), FLOOR + 142); // the discount rounds down, so the price rounds up
        assertEq(auction.priceAt(lotId, t0 + 1200), FLOOR);
        assertEq(auction.priceAt(lotId, t0 + 2400), FLOOR, "flat at the floor until endAt");
        assertEq(auction.priceAt(lotId, t0 + 30 days), FLOOR);

        assertEq(auction.currentPrice(lotId), START);
        vm.warp(t0 + 600);
        assertEq(auction.currentPrice(lotId), 5_515_000);
    }

    function test_priceAt_unknown_lot_reverts() public {
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.priceAt(1, t0);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.currentPrice(1);
    }

    function testFuzz_priceAt_is_non_increasing_and_bounded(
        uint128 start,
        uint128 floorSeed,
        uint32 decay,
        uint64 life,
        uint64 a,
        uint64 b
    ) public {
        start = uint128(bound(start, 1, type(uint128).max));
        uint128 floor_ = uint128(bound(floorSeed, 1, start));
        decay = uint32(bound(decay, 60, 6 hours));
        life = uint64(bound(life, 1, 4 days));
        uint256 id = _mint(AMOUNT);
        uint256 lotId = _list(id, AMOUNT, start, floor_, decay, t0 + life);

        uint256 t1 = bound(a, 0, uint256(t0) + 10 days);
        uint256 t2 = bound(b, t1, uint256(t0) + 10 days);
        uint256 p1 = auction.priceAt(lotId, t1);
        uint256 p2 = auction.priceAt(lotId, t2);
        assertGe(p1, p2, "price rose over time");
        assertLe(p1, start);
        assertGe(p2, floor_);
        assertEq(auction.priceAt(lotId, t0), start, "starts at start");
        assertEq(auction.priceAt(lotId, uint256(t0) + decay), floor_, "reaches the floor after decay");
    }

    // --- bid --------------------------------------------------------------------------------------

    function test_bid_clears_pays_the_seller_and_delivers_the_note() public {
        (uint256 id, uint256 lotId) = _demoLot();
        vm.warp(t0 + 600);
        uint256 sellerBefore = usdg.balanceOf(seller);
        uint256 bidderBefore = usdg.balanceOf(bidder);

        // 5.578 ref vs 5.515 paid: 63_000 * 1e4 / 5_578_000 = 112 bps under the reference
        vm.expectEmit(true, true, true, true, address(auction));
        emit ClosedAuction.Cleared(lotId, id, bidder, 5_515_000, 112, t0 + 600);
        vm.prank(bidder);
        uint256 paid = auction.bid(lotId, 5_515_000);

        assertEq(paid, 5_515_000);
        assertEq(usdg.balanceOf(seller) - sellerBefore, paid, "seller delta = price");
        assertEq(bidderBefore - usdg.balanceOf(bidder), paid, "bidder paid price");
        assertEq(usdg.balanceOf(address(auction)), 0, "auction never holds USDG");
        assertEq(note.balanceOf(bidder, id), AMOUNT, "note delivered");
        assertEq(note.balanceOf(address(auction), id), 0);
        assertEq(pointer.observeCalls(w), 1, "bid witnessed the pointer");

        ClosedAuction.Lot memory l = auction.lotOf(lotId);
        assertEq(uint8(l.status), uint8(ClosedAuction.Status.SOLD));
        assertEq(l.buyer, bidder);
        assertEq(l.clearedPrice, paid);
        assertEq(l.clearedAt, t0 + 600);
    }

    function test_bid_above_the_reference_reports_zero_discount() public {
        (uint256 id, uint256 lotId) = _demoLot();
        vm.expectEmit(true, true, true, true, address(auction));
        emit ClosedAuction.Cleared(lotId, id, bidder, START, 0, t0);
        vm.prank(bidder);
        auction.bid(lotId, START);
    }

    function test_a_lot_clears_once() public {
        (, uint256 lotId) = _demoLot();
        vm.prank(bidder);
        auction.bid(lotId, START);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.LotNotLive.selector);
        auction.bid(lotId, START);

        address other = makeAddr("other");
        registry.setEligible(other, true, bytes32(0));
        usdg.mint(other, 100e6);
        vm.prank(other);
        usdg.approve(address(auction), type(uint256).max);
        vm.prank(other);
        vm.expectRevert(ClosedAuction.LotNotLive.selector);
        auction.bid(lotId, START);
    }

    function test_bid_on_an_unknown_lot_reverts() public {
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.LotNotLive.selector);
        auction.bid(7, START);
    }

    function test_bid_after_endAt_reverts() public {
        (, uint256 lotId) = _demoLot();
        vm.warp(t0 + 2401);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.LotExpired.selector);
        auction.bid(lotId, START);
    }

    function test_bid_at_exactly_endAt_clears_at_the_floor() public {
        (, uint256 lotId) = _demoLot();
        vm.warp(t0 + 2400);
        vm.prank(bidder);
        assertEq(auction.bid(lotId, FLOOR), FLOOR);
    }

    function test_bid_when_open_reverts() public {
        (, uint256 lotId) = _demoLot();
        clock.set(w, IMarketClock.Regime.MARKET, 20_000_000);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
        auction.bid(lotId, START);

        clock.set(w, IMarketClock.Regime.CLOSED, 5); // CLOSED label but capacity is back
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
        auction.bid(lotId, START);
    }

    function test_bid_when_clock_unknown_reverts() public {
        (, uint256 lotId) = _demoLot();
        clock.set(w, IMarketClock.Regime.UNKNOWN, 0);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
        auction.bid(lotId, START);
    }

    function test_bid_after_epoch_advanced_reverts() public {
        (, uint256 lotId) = _demoLot();
        // A reopen was witnessed, then the market shut again: the clock says CLOSED, but the closure the
        // note was sold into is over. No hindsight: the lot can no longer be bought.
        pointer.reopen(w);
        pointer.shut(w);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.ReopenedSinceMint.selector);
        auction.bid(lotId, START);
    }

    function test_bid_when_pointer_reports_open_reverts() public {
        (, uint256 lotId) = _demoLot();
        pointer.setOpen(w, true);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
        auction.bid(lotId, START);
    }

    function test_bid_over_max_reverts() public {
        (, uint256 lotId) = _demoLot();
        vm.warp(t0 + 600);
        vm.prank(bidder);
        vm.expectRevert(abi.encodeWithSelector(ClosedAuction.PriceAboveMax.selector, 5_515_000, 5_514_999));
        auction.bid(lotId, 5_514_999);
    }

    function test_bid_ineligible_reverts() public {
        (, uint256 lotId) = _demoLot();
        usdg.mint(stranger, 100e6);
        vm.prank(stranger);
        usdg.approve(address(auction), type(uint256).max);
        vm.prank(stranger);
        vm.expectRevert(ClosedAuction.Ineligible.selector);
        auction.bid(lotId, START);

        // and a removed bidder is refused too
        registry.setEligible(bidder, false, keccak256("test:removed"));
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.Ineligible.selector);
        auction.bid(lotId, START);
    }

    function test_ungated_auction_accepts_anyone() public {
        ClosedAuction open = _auction(IEligibility(address(0)));
        uint256 id = _mint(AMOUNT);
        vm.prank(seller);
        note.setApprovalForAll(address(open), true);
        vm.prank(seller);
        uint256 lotId = open.list(id, AMOUNT, START, FLOOR, DECAY, t0 + 2400);

        usdg.mint(stranger, 100e6);
        vm.prank(stranger);
        usdg.approve(address(open), type(uint256).max);
        vm.prank(stranger);
        open.bid(lotId, START);
        assertEq(note.balanceOf(stranger, id), AMOUNT);
    }

    function test_bid_without_usdg_allowance_reverts_and_leaves_the_lot_live() public {
        (, uint256 lotId) = _demoLot();
        vm.prank(bidder);
        usdg.approve(address(auction), 0);
        vm.prank(bidder);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(usdg)));
        auction.bid(lotId, START);
        assertEq(uint8(auction.lotOf(lotId).status), uint8(ClosedAuction.Status.LIVE));
    }

    function test_bid_from_a_contract_without_a_hook_reverts_whole() public {
        (uint256 id, uint256 lotId) = _demoLot();
        HooklessBidder hb = new HooklessBidder();
        registry.setEligible(address(hb), true, bytes32(0));
        usdg.mint(address(hb), 100e6);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, address(hb)));
        hb.go(auction, IERC20(address(usdg)), lotId);
        assertEq(uint8(auction.lotOf(lotId).status), uint8(ClosedAuction.Status.LIVE));
        assertEq(usdg.balanceOf(address(hb)), 100e6, "nobody paid");
        assertEq(note.balanceOf(address(auction), id), AMOUNT);
    }

    function test_bid_cannot_be_reentered_from_the_note_hook() public {
        (, uint256 lotA) = _demoLot();
        (, uint256 lotB) = _demoLot();
        ReentrantBidder rb = new ReentrantBidder(auction);
        registry.setEligible(address(rb), true, bytes32(0));
        usdg.mint(address(rb), 100e6);
        rb.approve(IERC20(address(usdg)));

        vm.expectRevert(ClosedAuction.Reentrant.selector);
        rb.bid(lotA, START, lotB, ClosedAuction.bid.selector);
        vm.expectRevert(ClosedAuction.Reentrant.selector);
        rb.bid(lotA, START, lotB, ClosedAuction.withdraw.selector);

        // with no re-entry the same contract bids fine
        rb.bid(lotA, START, 0, bytes4(0));
        assertEq(auction.lotOf(lotA).buyer, address(rb));
    }

    // --- unsolicited notes ------------------------------------------------------------------------

    function test_unsolicited_1155_is_rejected() public {
        uint256 id = _mint(AMOUNT);
        vm.prank(seller);
        vm.expectRevert(ClosedAuction.Unsolicited.selector);
        note.safeTransferFrom(seller, address(auction), id, AMOUNT, "");

        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        ids[0] = id;
        vals[0] = AMOUNT;
        vm.prank(seller);
        vm.expectRevert(ClosedAuction.Unsolicited.selector);
        note.safeBatchTransferFrom(seller, address(auction), ids, vals, "");

        // a different ERC-1155 contract, even with operator == auction, is refused
        vm.prank(address(0xBEEF));
        vm.expectRevert(ClosedAuction.Unsolicited.selector);
        auction.onERC1155Received(address(auction), seller, id, AMOUNT, "");
        // the right contract but someone else as operator is refused
        vm.prank(address(note));
        vm.expectRevert(ClosedAuction.Unsolicited.selector);
        auction.onERC1155Received(seller, seller, id, AMOUNT, "");
        // batch is refused even from the note with the auction as operator
        vm.prank(address(note));
        vm.expectRevert(ClosedAuction.Unsolicited.selector);
        auction.onERC1155BatchReceived(address(auction), seller, ids, vals, "");

        assertEq(note.balanceOf(seller, id), AMOUNT);
    }

    function test_supportsInterface() public view {
        assertTrue(auction.supportsInterface(0x01ffc9a7));
        assertTrue(auction.supportsInterface(0x4e2312e0));
        assertFalse(auction.supportsInterface(0xd9b67a26));
        assertFalse(auction.supportsInterface(0xffffffff));
    }

    // --- withdraw ---------------------------------------------------------------------------------

    function test_withdraw_returns_the_note_to_the_seller() public {
        (uint256 id, uint256 lotId) = _demoLot();
        vm.prank(stranger);
        vm.expectRevert(ClosedAuction.NotSeller.selector);
        auction.withdraw(lotId);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.NotSeller.selector);
        auction.withdraw(lotId);

        vm.expectEmit(true, true, true, true, address(auction));
        emit ClosedAuction.Withdrawn(lotId, seller);
        vm.prank(seller);
        auction.withdraw(lotId);
        assertEq(note.balanceOf(seller, id), AMOUNT);
        assertEq(note.balanceOf(address(auction), id), 0);
        assertEq(uint8(auction.lotOf(lotId).status), uint8(ClosedAuction.Status.WITHDRAWN));

        vm.prank(seller);
        vm.expectRevert(ClosedAuction.LotNotLive.selector);
        auction.withdraw(lotId);
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.LotNotLive.selector);
        auction.bid(lotId, START);
    }

    function test_withdraw_works_after_expiry_and_after_a_reopen() public {
        (uint256 id, uint256 lotA) = _demoLot();
        vm.warp(t0 + 3 days);
        vm.prank(seller);
        auction.withdraw(lotA);

        uint64 t1 = _now();
        vm.prank(seller);
        uint256 lotB = auction.list(id, AMOUNT, START, FLOOR, DECAY, t1 + 600);
        clock.set(w, IMarketClock.Regime.MARKET, 20_000_000);
        pointer.reopen(w);
        vm.prank(seller);
        auction.withdraw(lotB);
        assertEq(note.balanceOf(seller, id), AMOUNT, "unsold notes always come home");
    }

    function test_withdraw_after_sale_reverts() public {
        (, uint256 lotId) = _demoLot();
        vm.prank(bidder);
        auction.bid(lotId, START);
        vm.prank(seller);
        vm.expectRevert(ClosedAuction.LotNotLive.selector);
        auction.withdraw(lotId);
    }

    // --- realisedDiscountBps ----------------------------------------------------------------------

    function test_realisedDiscountBps_grades_the_sale_against_the_next_epochs_print() public {
        (, uint256 lotId) = _demoLot();
        vm.expectRevert(ClosedAuction.NotSold.selector);
        auction.realisedDiscountBps(lotId);

        vm.warp(t0 + 600);
        vm.prank(bidder);
        auction.bid(lotId, 5_515_000);

        vm.expectRevert(ClosedAuction.NotPrinted.selector); // no reopen yet
        auction.realisedDiscountBps(lotId);

        clock.set(w, IMarketClock.Regime.MARKET, 20_000_000);
        pointer.reopen(w); // epoch 4
        vm.expectRevert(ClosedAuction.NotPrinted.selector); // reopened, not yet printed
        auction.realisedDiscountBps(lotId);

        pointer.setPrint(w, 4, 57e18); // V = 5_700_000
        // (5_700_000 - 5_515_000) * 1e4 / 5_700_000 = 324.56 -> 324
        assertEq(auction.realisedDiscountBps(lotId), 324);

        // a later epoch's print never replaces the one right after mint
        pointer.shut(w);
        pointer.reopen(w); // epoch 5
        pointer.setPrint(w, 5, 40e18);
        assertEq(auction.realisedDiscountBps(lotId), 324);
    }

    function test_realisedDiscountBps_is_negative_when_the_buyer_overpaid() public {
        (, uint256 lotId) = _demoLot();
        vm.warp(t0 + 600);
        vm.prank(bidder);
        auction.bid(lotId, 5_515_000);
        pointer.reopen(w);
        pointer.setPrint(w, 4, 50e18); // V = 5_000_000
        assertEq(auction.realisedDiscountBps(lotId), -1030); // -515_000 * 1e4 / 5_000_000
    }

    function test_realisedDiscountBps_unsold_lots_revert() public {
        vm.expectRevert(ClosedAuction.NotSold.selector);
        auction.realisedDiscountBps(1);
        (, uint256 lotId) = _demoLot();
        vm.prank(seller);
        auction.withdraw(lotId);
        pointer.reopen(w);
        pointer.setPrint(w, 4, 57e18);
        vm.expectRevert(ClosedAuction.NotSold.selector);
        auction.realisedDiscountBps(lotId);
    }

    // --- ERC-8021 Builder Code suffix: identical results ------------------------------------------

    /// Run `data` from `from` against `target` twice from the same state: plain, then with the suffix.
    /// Success, return/revert bytes, every log (emitter, topics, data) and the resulting state must match.
    /// Leaves the chain in the suffixed call's post-state.
    function _sameWithSuffix(address from, address target, bytes memory data)
        internal
        returns (bool ok, bytes memory ret)
    {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(from);
        (bool ok1, bytes memory r1) = target.call(data);
        Vm.Log[] memory l1 = vm.getRecordedLogs();
        bytes memory s1 = _digest();

        vm.revertToStateAndDelete(snap);
        bytes memory tagged = abi.encodePacked(data, SUFFIX);
        assertEq(tagged.length, data.length + 34);
        vm.recordLogs();
        vm.prank(from);
        (ok, ret) = target.call(tagged);
        Vm.Log[] memory l2 = vm.getRecordedLogs();
        bytes memory s2 = _digest();

        assertEq(ok, ok1, "same success");
        assertEq(ret, r1, "same return/revert data");
        assertEq(l1.length, l2.length, "same number of logs");
        for (uint256 i; i < l1.length; ++i) {
            assertEq(l1[i].emitter, l2[i].emitter, "same emitter");
            assertEq(l1[i].topics, l2[i].topics, "same topics");
            assertEq(l1[i].data, l2[i].data, "same data");
        }
        assertEq(s1, s2, "same resulting state");
    }

    function _digest() internal view returns (bytes memory d) {
        uint256 n = auction.lotCount();
        d = abi.encode(n, usdg.balanceOf(seller), usdg.balanceOf(bidder), usdg.balanceOf(address(auction)));
        for (uint256 i = 1; i <= n; ++i) {
            ClosedAuction.Lot memory l = auction.lotOf(i);
            d = abi.encodePacked(
                d,
                abi.encode(l),
                abi.encode(note.balanceOf(seller, l.noteId), note.balanceOf(bidder, l.noteId),
                    note.balanceOf(address(auction), l.noteId))
            );
        }
    }

    function test_builder_code_suffix_every_entry_point_is_identical() public {
        uint256 id = _mint(AMOUNT);
        uint256 id2 = _mint(AMOUNT);
        bool ok;
        bytes memory ret;

        // list
        (ok, ret) = _sameWithSuffix(seller, address(auction),
            abi.encodeCall(ClosedAuction.list, (id, AMOUNT, START, FLOOR, DECAY, t0 + 2400)));
        assertTrue(ok, "list");
        assertEq(abi.decode(ret, (uint256)), 1);
        (ok,) = _sameWithSuffix(seller, address(auction),
            abi.encodeCall(ClosedAuction.list, (id2, AMOUNT, START, FLOOR, DECAY, t0 + 2400)));
        assertTrue(ok, "list 2");
        // a refused list is refused identically
        (ok, ret) = _sameWithSuffix(seller, address(auction),
            abi.encodeCall(ClosedAuction.list, (id, AMOUNT, START, FLOOR, 59, t0 + 2400)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ClosedAuction.BadParams.selector));

        // views
        vm.warp(t0 + 600);
        (ok, ret) = _sameWithSuffix(stranger, address(auction), abi.encodeCall(ClosedAuction.priceAt, (1, t0 + 300)));
        assertEq(abi.decode(ret, (uint256)), 5_557_500);
        (ok, ret) = _sameWithSuffix(stranger, address(auction), abi.encodeCall(ClosedAuction.currentPrice, (1)));
        assertEq(abi.decode(ret, (uint256)), 5_515_000);
        _sameWithSuffix(stranger, address(auction), abi.encodeCall(ClosedAuction.lotOf, (1)));
        _sameWithSuffix(stranger, address(auction), abi.encodeWithSelector(auction.lotCount.selector));

        // bid: over max refused identically, then a real clear
        (ok, ret) = _sameWithSuffix(bidder, address(auction), abi.encodeCall(ClosedAuction.bid, (1, 5_000_000)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ClosedAuction.PriceAboveMax.selector, 5_515_000, 5_000_000));
        (ok, ret) = _sameWithSuffix(bidder, address(auction), abi.encodeCall(ClosedAuction.bid, (1, START)));
        assertTrue(ok, "bid");
        assertEq(abi.decode(ret, (uint256)), 5_515_000);
        assertEq(note.balanceOf(bidder, id), AMOUNT, "the suffixed bid really cleared");

        // withdraw: a stranger is refused identically, the seller withdraws identically
        (ok, ret) = _sameWithSuffix(stranger, address(auction), abi.encodeCall(ClosedAuction.withdraw, (2)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ClosedAuction.NotSeller.selector));
        (ok,) = _sameWithSuffix(seller, address(auction), abi.encodeCall(ClosedAuction.withdraw, (2)));
        assertTrue(ok, "withdraw");
        assertEq(note.balanceOf(seller, id2), AMOUNT);

        // realisedDiscountBps
        (ok, ret) = _sameWithSuffix(stranger, address(auction), abi.encodeCall(ClosedAuction.realisedDiscountBps, (1)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ClosedAuction.NotPrinted.selector));
        pointer.reopen(w);
        pointer.setPrint(w, 4, 57e18);
        (ok, ret) = _sameWithSuffix(stranger, address(auction), abi.encodeCall(ClosedAuction.realisedDiscountBps, (1)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (int256)), 324);
    }
}

/// The auction against the REAL ReopenPointer and ReopenNote (package P1), driven by the settable clock and
/// price mocks: the whole cycle without a fork, so it runs in the merge gate.
contract ClosedAuctionWithRealNoteTest is Test {
    uint128 constant AMOUNT = 0.1e18;
    uint128 constant START = 5_600_000;
    uint128 constant FLOOR = 5_430_000;
    uint32 constant DECAY = 1200;

    MockClock clock;
    MockScorecardPrice sc;
    MockERC20 usdg;
    MockWrapper4626 w;
    ReopenPointer pointer;
    ReopenNote note;
    EligibilityRegistry registry;
    ClosedAuction auction;

    address seller = makeAddr("seller");
    address bidder = makeAddr("bidder");
    uint64 t0;

    function setUp() public {
        vm.warp(1_790_000_000);
        t0 = uint64(block.timestamp);
        clock = new MockClock();
        sc = new MockScorecardPrice();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        w = new MockWrapper4626(makeAddr("raw"), "Wrapped TCENTx", "wTCENTx");
        sc.setPrice(address(w), 55.78e18);

        pointer = new ReopenPointer(IMarketClock(address(clock)), IScorecardPrice(address(sc)));
        address[] memory ws = new address[](1);
        uint256[] memory caps = new uint256[](1);
        (ws[0], caps[0]) = (address(w), 175e18);
        note = new ReopenNote(IMarketClock(address(clock)), pointer, IScorecardPrice(address(sc)), ws, caps, "u");
        registry = new EligibilityRegistry(address(this));
        registry.setEligible(bidder, true, keccak256("test:bidder"));
        auction = new ClosedAuction(
            note, pointer, IMarketClock(address(clock)), IScorecardPrice(address(sc)), IERC20(address(usdg)),
            IEligibility(address(registry))
        );

        clock.set(address(w), IMarketClock.Regime.CLOSED, 0);
        pointer.observe(address(w)); // the pointer witnesses the shut

        w.mint(seller, 1e18);
        vm.startPrank(seller);
        w.approve(address(note), type(uint256).max);
        note.setApprovalForAll(address(auction), true);
        vm.stopPrank();
        usdg.mint(bidder, 100e6);
        vm.prank(bidder);
        usdg.approve(address(auction), type(uint256).max);
    }

    function _mintAndList() internal returns (uint256 id, uint256 lotId) {
        vm.startPrank(seller);
        id = note.mint(address(w), AMOUNT, seller);
        lotId = auction.list(id, AMOUNT, START, FLOOR, DECAY, uint64(vm.getBlockTimestamp() + 2400));
        vm.stopPrank();
    }

    function _reopen() internal {
        clock.set(address(w), IMarketClock.Regime.MARKET, 20_000_000);
        pointer.observe(address(w));
    }

    function test_full_cycle_with_the_real_note_and_pointer() public {
        (uint256 id, uint256 lotId) = _mintAndList();
        assertEq(auction.lotOf(lotId).epochAtMint, 0);
        assertEq(auction.lotOf(lotId).refPrice, 5_578_000);

        vm.warp(t0 + 600);
        vm.prank(bidder);
        uint256 price = auction.bid(lotId, START);
        assertEq(price, 5_515_000);
        assertEq(usdg.balanceOf(seller), price, "seller delta = price");
        assertEq(note.balanceOf(bidder, id), AMOUNT);

        vm.prank(bidder);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.NotReopened.selector, id, uint32(0), uint32(0)));
        note.redeem(id, AMOUNT, bidder);

        vm.warp(t0 + 900);
        _reopen();
        assertEq(pointer.epochOf(address(w)), 1);
        vm.expectRevert(ClosedAuction.NotPrinted.selector); // reopened, not printed: epochInfo reads zeroes
        auction.realisedDiscountBps(lotId);

        vm.warp(t0 + 1200);
        sc.setPrice(address(w), 57e18);
        assertEq(pointer.recordPrint(address(w), 1), 57e18);

        vm.prank(bidder);
        note.redeem(id, AMOUNT, bidder);
        assertEq(w.balanceOf(bidder), AMOUNT, "exactly the escrowed shares");
        assertEq(auction.realisedDiscountBps(lotId), 324);
    }

    function test_no_hindsight_with_the_real_pointer() public {
        (uint256 id, uint256 lotId) = _mintAndList();
        vm.warp(t0 + 600);
        _reopen();
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
        auction.bid(lotId, START);

        vm.warp(t0 + 1200);
        clock.set(address(w), IMarketClock.Regime.CLOSED, 0); // shut again, not yet witnessed
        vm.prank(bidder);
        vm.expectRevert(ClosedAuction.ReopenedSinceMint.selector);
        auction.bid(lotId, START);
        vm.prank(seller);
        vm.expectRevert(ClosedAuction.ReopenedSinceMint.selector);
        auction.list(id, 1, START, FLOOR, DECAY, uint64(vm.getBlockTimestamp() + 600));

        vm.prank(seller);
        auction.withdraw(lotId);
        assertEq(note.balanceOf(seller, id), AMOUNT);
    }

    /// The pointer can only refuse what it witnessed: a reopen-and-shut that nobody observed does not move
    /// the epoch, so the lot stays biddable. This is why poke.sh observes at every reopen.
    function test_an_unwitnessed_reopen_does_not_move_the_epoch() public {
        (, uint256 lotId) = _mintAndList();
        vm.warp(t0 + 600);
        clock.set(address(w), IMarketClock.Regime.MARKET, 20_000_000); // nobody observes
        vm.warp(t0 + 700);
        clock.set(address(w), IMarketClock.Regime.CLOSED, 0);
        vm.prank(bidder);
        auction.bid(lotId, START);
        assertEq(pointer.epochOf(address(w)), 0);
    }
}
