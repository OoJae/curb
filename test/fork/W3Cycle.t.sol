// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ClosedAuction} from "../../src/ClosedAuction.sol";
import {EligibilityRegistry} from "../../src/EligibilityRegistry.sol";
import {ReopenPointer} from "../../src/ReopenPointer.sol";
import {ReopenNote} from "../../src/ReopenNote.sol";
import {MarketClock} from "../../src/MarketClock.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";
import {IReopenNote} from "../../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../../src/interfaces/IReopenPointer.sol";
import {IScorecardPrice} from "../../src/interfaces/IScorecardPrice.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {IERC1155Receiver} from "../../src/lib/ERC1155Min.sol";

interface IERC165 {
    function supportsInterface(bytes4) external view returns (bool);
}

/// The whole W3 cycle on a mainnet fork, against the live MarketClock, Scorecard v2, USDG and wTCENTx pool.
///
/// Regimes are flipped by pranking host A, the live MarketClock writer, calling `attest` -- the same call it
/// makes every round -- and re-attesting after any warp past MarketClock's 30-minute staleness limit. USDG and
/// wTCENTx come out of the live wTCENTx/USDG pool by prank. The seller is the curb-desk keystore wallet and the
/// buyer is the team's Agentic Wallet, a real EIP-7702 account, so the note's ERC-1155 receiver check runs
/// against the code that will actually receive it in the live demo.
///
/// Everything is deployed exactly as script/DeployW3.s.sol deploys it: the real ReopenPointer and ReopenNote
/// (package P1) with the frozen caps and URI, and the auction gated by the registry.
contract W3CycleForkTest is Test {
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;
    address constant SCORECARD = 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f;
    address constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;
    address constant W_SHEIN = 0xff637d2d435D6745Df3faf61272B1216e7e8b727;
    address constant POOL_TCENT = 0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f;
    address constant HOST_A = 0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4;
    address constant DESK = 0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E;
    address constant AGENTIC = 0x055BA8ACd60A2287b2D01cb3BF237e4424357105;
    string constant URI = "https://api.curb.markets/v1/notes/{id}.json";

    // The overnight demo lot: 0.1 wTCENTx, 5.60 -> 5.43 USDG over 20 minutes.
    uint128 constant AMOUNT = 0.1e18;
    uint128 constant START = 5_600_000;
    uint128 constant FLOOR = 5_430_000;
    uint32 constant DECAY = 1200;

    MarketClock clock = MarketClock(CLOCK);
    IScorecardPrice scorecard = IScorecardPrice(SCORECARD);
    IERC20 usdg = IERC20(USDG);
    IERC20 tcent = IERC20(W_TCENT);

    EligibilityRegistry registry;
    ReopenPointer pointer;
    ReopenNote note;
    ClosedAuction auction;

    /// Latest block by default. The public RPC answers in ~1-2 s per request and a fork at "latest" is never
    /// cached, so a full run takes minutes; pin W3_FORK_BLOCK to re-run from Foundry's on-disk RPC cache.
    function setUp() public {
        uint256 pinned = vm.envOr("W3_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork("xlayer");
        else vm.createSelectFork("xlayer", pinned);
    }

    // --- helpers ----------------------------------------------------------------------------------

    function _deployW3() internal {
        registry = new EligibilityRegistry(address(this));
        registry.setEligible(DESK, true, keccak256("team:curb-desk"));
        registry.setEligible(AGENTIC, true, keccak256("team:agentic"));

        pointer = new ReopenPointer(IMarketClock(CLOCK), scorecard);
        (address[] memory ws, uint256[] memory caps) = _cohort();
        note = new ReopenNote(IMarketClock(CLOCK), pointer, scorecard, ws, caps, URI);
        auction = new ClosedAuction(
            note, pointer, IMarketClock(CLOCK), scorecard, usdg, IEligibility(address(registry))
        );
    }

    function _cohort() internal pure returns (address[] memory ws, uint256[] memory caps) {
        ws = new address[](3);
        caps = new uint256[](3);
        (ws[0], caps[0]) = (W_TCENT, 175e18);
        (ws[1], caps[1]) = (W_NVDA, 220e18);
        (ws[2], caps[2]) = (W_AAPL, 14e18);
    }

    /// Host A writes the regime, exactly as its live rounds do.
    function _attest(IMarketClock.Regime r, uint128 cap) internal {
        vm.prank(HOST_A);
        clock.attest(W_TCENT, r, cap, uint64(vm.getBlockTimestamp() + 3600), false, keccak256("w3-fork"));
    }

    function _warp(uint256 by) internal {
        vm.warp(vm.getBlockTimestamp() + by);
        vm.roll(vm.getBlockNumber() + by); // ~1 s blocks on X Layer
    }

    function _fund() internal {
        vm.startPrank(POOL_TCENT);
        tcent.transfer(DESK, 1e18);
        usdg.transfer(AGENTIC, 50e6);
        vm.stopPrank();
    }

    /// Shut, witnessed, and a note minted into it by the desk.
    function _shutAndMint() internal returns (uint256 id) {
        _attest(IMarketClock.Regime.CLOSED, 0);
        pointer.observe(W_TCENT);
        vm.startPrank(DESK);
        tcent.approve(address(note), AMOUNT);
        id = note.mint(W_TCENT, AMOUNT, DESK);
        note.setApprovalForAll(address(auction), true);
        vm.stopPrank();
    }

    function _list(uint256 id) internal returns (uint256 lotId) {
        vm.prank(DESK);
        lotId = auction.list(id, AMOUNT, START, FLOOR, DECAY, uint64(vm.getBlockTimestamp() + 2400));
    }

    // --- chain preconditions (independent of P1) --------------------------------------------------

    /// Everything this suite assumes about the live chain, checked on its own so a failure here points at
    /// the environment rather than at W3.
    function test_fork_preconditions() public {
        assertTrue(clock.isAttestor(HOST_A), "host A is a live attestor");

        _attest(IMarketClock.Regime.CLOSED, 0);
        assertEq(uint8(clock.regime(W_TCENT)), uint8(IMarketClock.Regime.CLOSED));
        assertEq(clock.primaryCapNow(W_TCENT), 0);
        _attest(IMarketClock.Regime.MARKET, 20_000_000);
        assertEq(clock.primaryCapNow(W_TCENT), 20_000_000);
        _warp(31 minutes);
        assertEq(uint8(clock.regime(W_TCENT)), uint8(IMarketClock.Regime.UNKNOWN), "stale after 30 min");
        _attest(IMarketClock.Regime.CLOSED, 0);
        assertEq(uint8(clock.regime(W_TCENT)), uint8(IMarketClock.Regime.CLOSED), "fresh again");

        uint128 p = scorecard.priceNow(W_TCENT);
        console2.log("wTCENTx priceNow after a 31-min warp (1e18):", p);
        assertGt(p, 10e18);
        assertLt(p, 200e18);
        (address pool,,,,) = scorecard.priceSources(W_SHEIN);
        assertEq(pool, address(0), "wSHEINx has no price source");
        vm.expectRevert();
        scorecard.priceNow(W_SHEIN);

        uint256 d0 = tcent.balanceOf(DESK);
        uint256 a0 = usdg.balanceOf(AGENTIC);
        _fund();
        assertEq(tcent.balanceOf(DESK) - d0, 1e18, "wTCENTx from the pool");
        assertEq(usdg.balanceOf(AGENTIC) - a0, 50e6, "USDG from the pool");

        assertGt(AGENTIC.code.length, 0, "Agentic Wallet carries 7702 delegation code");
        assertTrue(IERC165(AGENTIC).supportsInterface(0x4e2312e0), "Agentic Wallet is an ERC-1155 receiver");
        assertEq(
            IERC1155Receiver(AGENTIC).onERC1155Received(address(this), address(this), 1, 1, ""),
            IERC1155Receiver.onERC1155Received.selector
        );
    }

    // --- the cycle --------------------------------------------------------------------------------

    // Cycle state, kept in storage so each phase stays inside legacy codegen's stack limit.
    uint256 noteId;
    uint256 lotId;
    uint32 epochAtMint;
    uint32 reopenEpoch;
    uint256 cleared;
    uint128 print;

    function test_w3_cycle_mint_list_bid_reopen_print_redeem() public {
        _deployW3();
        _fund();
        _phaseMint();
        _phaseList();
        _phaseBid();
        _phaseReopen();
        _phasePrint();
        _phaseRedeem();
        _phaseGrade();
    }

    function _phaseMint() internal {
        noteId = _shutAndMint();
        IReopenNote.Unit memory u = note.unitOf(noteId);
        assertEq(u.wrapper, W_TCENT);
        assertEq(u.issuer, DESK);
        assertEq(u.wrapperShares, AMOUNT);
        assertEq(note.balanceOf(DESK, noteId), AMOUNT);
        assertEq(note.outstanding(noteId), AMOUNT);
        epochAtMint = u.epochAtMint;
        assertEq(pointer.epochOf(W_TCENT), epochAtMint);
        assertFalse(pointer.isOpen(W_TCENT));
        assertFalse(note.redeemable(noteId), "locked until a verified reopen");
    }

    function _phaseList() internal {
        // Host A attested the next boundary with the regime; a lot may not run past it.
        uint64 cutoff = clock.stateOf(W_TCENT).nextTransitionAt;
        vm.prank(DESK);
        vm.expectRevert(abi.encodeWithSelector(ClosedAuction.SpansTransition.selector, cutoff));
        auction.list(noteId, AMOUNT, START, FLOOR, DECAY, cutoff + 1);

        uint256 g = gasleft();
        lotId = _list(noteId); // ends at now + 2400, before the boundary at now + 3600
        console2.log("list gas:", g - gasleft());
        ClosedAuction.Lot memory l = auction.lotOf(lotId);
        console2.log("refPrice (USDG units):", l.refPrice);
        assertEq(l.cutoff, cutoff, "the attested boundary is the lot's cutoff");
        assertLe(l.endAt, cutoff);
        assertEq(l.epochAtMint, epochAtMint);
        assertEq(note.balanceOf(address(auction), noteId), AMOUNT, "escrowed");
    }

    function _phaseBid() internal {
        _warp(600); // 10 minutes into the clock
        uint256 deskBefore = usdg.balanceOf(DESK);
        uint256 agBefore = usdg.balanceOf(AGENTIC);
        vm.prank(AGENTIC);
        usdg.approve(address(auction), START);
        uint256 g = gasleft();
        vm.prank(AGENTIC);
        cleared = auction.bid(lotId, START);
        console2.log("bid gas:", g - gasleft());
        console2.log("cleared (USDG units):", cleared);
        assertEq(cleared, 5_515_000);
        assertEq(usdg.balanceOf(DESK) - deskBefore, cleared, "seller delta = price");
        assertEq(agBefore - usdg.balanceOf(AGENTIC), cleared);
        assertEq(note.balanceOf(AGENTIC, noteId), AMOUNT, "the 7702 wallet took delivery");
        vm.expectRevert(ClosedAuction.NotPrinted.selector);
        auction.realisedDiscountBps(lotId);
    }

    function _phaseReopen() internal {
        _warp(300);
        _attest(IMarketClock.Regime.MARKET, 20_000_000); // host A sees the issuer reopen
        (uint32 e, bool open) = pointer.observe(W_TCENT); // anyone witnesses it
        assertTrue(open, "open");
        assertEq(e, epochAtMint + 1, "a witnessed shut -> open advances the epoch");
        reopenEpoch = e;
        IReopenPointer.Epoch memory ep = pointer.epochInfo(W_TCENT, e);
        assertLt(ep.shutSeenAt, ep.openedAt, "the reopen is bracketed");
        assertEq(ep.openedAt, vm.getBlockTimestamp());
    }

    function _phasePrint() internal {
        _warp(300);
        _attest(IMarketClock.Regime.MARKET, 20_000_000);
        print = pointer.recordPrint(W_TCENT, reopenEpoch); // Scorecard.priceNow on the live pool
        console2.log("reopen print (1e18):", print);
        assertEq(pointer.epochInfo(W_TCENT, reopenEpoch).print, print);
        assertGt(print, 10e18);
        assertLt(print, 200e18);
    }

    function _phaseRedeem() internal {
        uint256 before = tcent.balanceOf(AGENTIC);
        assertTrue(note.redeemable(noteId));
        vm.prank(AGENTIC);
        note.redeem(noteId, AMOUNT, AGENTIC);
        assertEq(tcent.balanceOf(AGENTIC) - before, AMOUNT, "delivered exactly amount");
        assertEq(note.balanceOf(AGENTIC, noteId), 0);
        assertEq(note.outstanding(noteId), 0);
    }

    function _phaseGrade() internal view {
        int256 bps = auction.realisedDiscountBps(lotId);
        uint256 v = uint256(AMOUNT) * print / 1e30;
        assertEq(bps, (int256(v) - int256(cleared)) * 1e4 / int256(v));
        console2.log("realisedDiscountBps:");
        console2.logInt(bps);
    }

    // --- negatives --------------------------------------------------------------------------------

    /// No hindsight, defence in depth: even a reopen BEFORE the attested boundary (a wrong schedule) stops the
    /// lot once witnessed, and a later shut does not revive it.
    function test_bid_after_the_reopen_is_refused() public {
        _deployW3();
        _fund();
        uint256 id = _shutAndMint();
        uint256 lotId = _list(id);
        vm.prank(AGENTIC);
        usdg.approve(address(auction), START);

        _warp(600);
        _attest(IMarketClock.Regime.MARKET, 20_000_000);
        pointer.observe(W_TCENT);
        vm.prank(AGENTIC);
        vm.expectRevert(ClosedAuction.MarketNotClosed.selector);
        auction.bid(lotId, START);

        // the market shuts again, inside the lot's life: still refused, the note's closure is over
        _warp(600);
        _attest(IMarketClock.Regime.CLOSED, 0);
        vm.prank(AGENTIC);
        vm.expectRevert(ClosedAuction.ReopenedSinceMint.selector);
        auction.bid(lotId, START);

        // the seller can always take an unsold note home
        vm.prank(DESK);
        auction.withdraw(lotId);
        assertEq(note.balanceOf(DESK, id), AMOUNT);
    }

    /// No hindsight, the binding rule: a lot ends by host A's attested boundary, so a session that nobody
    /// witnesses (the pointer's epoch never moves) cannot be traded on in the next closure.
    function test_a_lot_cannot_outlive_the_attested_boundary() public {
        _deployW3();
        _fund();
        uint256 id = _shutAndMint();
        uint64 cutoff = clock.stateOf(W_TCENT).nextTransitionAt;
        vm.prank(DESK);
        uint256 lotId = auction.list(id, AMOUNT, START, FLOOR, DECAY, cutoff); // endAt == cutoff is allowed
        vm.prank(AGENTIC);
        usdg.approve(address(auction), START);

        // The market reopens at the boundary and trades a session nobody observes, then shuts again.
        vm.warp(cutoff);
        _attest(IMarketClock.Regime.MARKET, 20_000_000);
        _warp(4 hours);
        _attest(IMarketClock.Regime.CLOSED, 0);
        assertEq(pointer.epochOf(W_TCENT), note.unitOf(id).epochAtMint, "the pointer never saw the session");

        vm.prank(AGENTIC);
        vm.expectRevert(ClosedAuction.LotExpired.selector);
        auction.bid(lotId, START);

        vm.prank(DESK);
        auction.withdraw(lotId);

        // A round whose boundary is already behind it, or missing, refuses new listings outright.
        uint64 nowTs = uint64(vm.getBlockTimestamp());
        vm.prank(HOST_A);
        clock.attest(W_TCENT, IMarketClock.Regime.CLOSED, 0, nowTs - 60, false, keccak256("stale-schedule"));
        vm.prank(DESK);
        vm.expectRevert(ClosedAuction.NoCutoff.selector);
        auction.list(id, AMOUNT, START, FLOOR, DECAY, nowTs + 600);
        vm.prank(HOST_A);
        clock.attest(W_TCENT, IMarketClock.Regime.CLOSED, 0, 0, false, keccak256("no-schedule"));
        vm.prank(DESK);
        vm.expectRevert(ClosedAuction.NoCutoff.selector);
        auction.list(id, AMOUNT, START, FLOOR, DECAY, nowTs + 600);
    }

    /// wSHEINx has no Scorecard price source: no note can be minted on it, and a note contract that tried
    /// to support it could not be deployed at all.
    function test_wshein_note_is_refused() public {
        _deployW3();
        vm.prank(HOST_A);
        clock.attest(W_SHEIN, IMarketClock.Regime.CLOSED, 0, uint64(vm.getBlockTimestamp() + 3600), false, bytes32(0));
        vm.prank(DESK);
        vm.expectRevert(ReopenNote.UnsupportedAsset.selector);
        note.mint(W_SHEIN, 1e18, DESK);
        assertEq(note.capShares(W_SHEIN), 0);

        address[] memory ws = new address[](1);
        uint256[] memory caps = new uint256[](1);
        (ws[0], caps[0]) = (W_SHEIN, 1e18);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.NoPriceSource.selector, W_SHEIN));
        new ReopenNote(IMarketClock(CLOCK), pointer, scorecard, ws, caps, URI);

        // and the auction refuses to list a note id that was never minted
        vm.prank(DESK);
        vm.expectRevert(ClosedAuction.BadParams.selector);
        auction.list(999, AMOUNT, START, FLOOR, DECAY, uint64(vm.getBlockTimestamp() + 2400));
    }
}
