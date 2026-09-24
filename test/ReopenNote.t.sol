// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReopenNote} from "../src/ReopenNote.sol";
import {ReopenPointer} from "../src/ReopenPointer.sol";
import {ERC1155Min} from "../src/lib/ERC1155Min.sol";
import {SafeTransfer} from "../src/lib/SafeTransfer.sol";
import {IReopenNote} from "../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../src/interfaces/IReopenPointer.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../src/interfaces/IScorecardPrice.sol";
import {MockClock} from "./mocks/MockClock.sol";
import {MockScorecardPrice} from "./mocks/MockScorecardPrice.sol";
import {MockWrapper4626} from "./mocks/MockWrapper4626.sol";
import {SuffixHarness} from "./ReopenPointer.t.sol";

contract GoodReceiver1155 {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}

/// Has code, has no hook.
contract NoHook1155 {
    uint256 public x;
}

/// Accepts a note, but first replays `payload` against the note: a reentrancy probe.
contract ReentrantReceiver {
    address public target;
    bytes public payload;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (payload.length != 0) {
            (bool ok, bytes memory r) = target.call(payload);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(r, 0x20), mload(r))
                }
            }
        }
        return this.onERC1155Received.selector;
    }
}

contract ReopenNoteTest is SuffixHarness {
    event NoteMinted(
        uint256 indexed id,
        address indexed issuer,
        address indexed wrapper,
        uint128 wrapperShares,
        uint128 underlyingAtMint,
        uint32 multiplierNonce,
        uint32 epochAtMint,
        address to
    );
    event NoteRedeemed(
        uint256 indexed id,
        address indexed holder,
        address indexed to,
        uint128 wrapperShares,
        uint256 underlyingAtRedeem,
        uint32 nonceAtRedeem,
        uint32 epochNow,
        bool viaFallback
    );
    event NoteCancelled(uint256 indexed id, address indexed issuer, uint128 wrapperShares);
    event TransferSingle(
        address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value
    );

    string constant URI = "https://api.curb.markets/v1/notes/{id}.json";
    uint64 constant T0 = 1_790_000_000;
    uint128 constant OPEN_CAP = 2_000_000;

    MockClock clock;
    MockScorecardPrice sc;
    ReopenPointer pointer;
    ReopenNote note;
    MockWrapper4626 wT; // wTCENTx, cap 175e18
    MockWrapper4626 wN; // wNVDAx, cap 220e18
    MockWrapper4626 wA; // wAAPLx, cap 14e18
    MockWrapper4626 wX; // priced but not supported

    address issuer = makeAddr("issuer");
    address holder = makeAddr("holder");
    address stranger = makeAddr("stranger");
    address sink = makeAddr("sink");

    function setUp() public {
        vm.warp(T0);
        vm.roll(1000);
        clock = new MockClock();
        sc = new MockScorecardPrice();
        wT = new MockWrapper4626(makeAddr("TCENTx"), "wTCENTx", "wTCENTx");
        wN = new MockWrapper4626(makeAddr("NVDAx"), "wNVDAx", "wNVDAx");
        wA = new MockWrapper4626(makeAddr("AAPLx"), "wAAPLx", "wAAPLx");
        wX = new MockWrapper4626(makeAddr("XIAOx"), "wXIAOx", "wXIAOx");
        sc.setPrice(address(wT), 55.78e18);
        sc.setPrice(address(wN), 223.35e18);
        sc.setPrice(address(wA), 337.89e18);
        sc.setPrice(address(wX), 7e18);
        pointer = new ReopenPointer(IMarketClock(address(clock)), IScorecardPrice(address(sc)));
        note = _deploy(IReopenPointer(address(pointer)));

        MockWrapper4626[3] memory ws = [wT, wA, wX];
        for (uint256 i; i < 3; ++i) {
            ws[i].mint(issuer, 1000e18);
            vm.prank(issuer);
            ws[i].approve(address(note), type(uint256).max);
            clock.set(address(ws[i]), IMarketClock.Regime.CLOSED, 0);
        }
    }

    // --- helpers ------------------------------------------------------------------------------

    function _deploy(IReopenPointer p) internal returns (ReopenNote) {
        address[] memory ws = new address[](3);
        uint256[] memory caps = new uint256[](3);
        (ws[0], ws[1], ws[2]) = (address(wT), address(wN), address(wA));
        (caps[0], caps[1], caps[2]) = (175e18, 220e18, 14e18);
        return new ReopenNote(IMarketClock(address(clock)), p, IScorecardPrice(address(sc)), ws, caps, URI);
    }

    function _mint(uint128 s, address to) internal returns (uint256 id) {
        vm.prank(issuer);
        id = note.mint(address(wT), s, to);
    }

    function _open(address w) internal { clock.set(w, IMarketClock.Regime.MARKET, OPEN_CAP); }
    function _shut(address w) internal { clock.set(w, IMarketClock.Regime.CLOSED, 0); }

    function _later(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1);
    }

    /// A full witnessed cycle on wT: shut, open, shut again, each observed.
    function _cycle() internal {
        _shut(address(wT));
        pointer.observe(address(wT));
        _later(60);
        _open(address(wT));
        pointer.observe(address(wT));
        _later(60);
        _shut(address(wT));
        pointer.observe(address(wT));
    }

    function _digest() internal view override returns (bytes memory) {
        address[4] memory who = [issuer, holder, stranger, sink];
        bytes memory out = abi.encode(
            note.noteCount(), note.openInterest(address(wT)), note.mintedInEpoch(address(wT), 0),
            note.mintedInEpoch(address(wT), 1), pointer.headOf(address(wT))
        );
        for (uint256 id = 1; id <= 2; ++id) {
            out = abi.encode(out, note.unitOf(id), note.outstanding(id), note.redeemable(id));
            for (uint256 i; i < 4; ++i) out = abi.encode(out, note.balanceOf(who[i], id));
        }
        for (uint256 i; i < 4; ++i) {
            out = abi.encode(out, wT.balanceOf(who[i]), note.isApprovedForAll(who[i], stranger));
        }
        return abi.encode(out, wT.balanceOf(address(note)));
    }

    // --- construction -------------------------------------------------------------------------

    function test_constructor_fixes_caps_and_metadata() public view {
        assertEq(note.capShares(address(wT)), 175e18);
        assertEq(note.capShares(address(wN)), 220e18);
        assertEq(note.capShares(address(wA)), 14e18);
        assertEq(note.capShares(address(wX)), 0);
        address[] memory a = note.supportedAssets();
        assertEq(a.length, 3);
        assertEq(a[0], address(wT));
        assertEq(note.name(), "Curb Reopen Note");
        assertEq(note.symbol(), "CURB-RN");
        assertEq(note.uri(7), URI);
        assertEq(note.FALLBACK_AFTER(), 10 days);
        assertTrue(note.supportsInterface(0xd9b67a26));
        assertTrue(note.supportsInterface(0x01ffc9a7));
        assertTrue(note.supportsInterface(0x0e89341c));
        assertEq(address(note.clock()), address(clock));
        assertEq(address(note.pointer()), address(pointer));
        assertEq(address(note.scorecard()), address(sc));
        assertEq(note.noteCount(), 0);
    }

    function test_constructor_rejects_a_wrapper_without_a_price_source() public {
        sc.clearPriceSource(address(wA));
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.NoPriceSource.selector, address(wA)));
        _deploy(IReopenPointer(address(pointer)));

        address shein = makeAddr("wSHEINx"); // never priced at all
        address[] memory ws = new address[](1);
        uint256[] memory caps = new uint256[](1);
        (ws[0], caps[0]) = (shein, 1e18);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.NoPriceSource.selector, shein));
        new ReopenNote(IMarketClock(address(clock)), pointer, IScorecardPrice(address(sc)), ws, caps, URI);
    }

    function test_constructor_rejects_bad_config() public {
        IMarketClock c = IMarketClock(address(clock));
        IScorecardPrice s = IScorecardPrice(address(sc));
        address[] memory one = new address[](1);
        one[0] = address(wT);
        uint256[] memory cap1 = new uint256[](1);
        cap1[0] = 1e18;
        address[] memory two = new address[](2);
        (two[0], two[1]) = (address(wT), address(wT));
        uint256[] memory cap2 = new uint256[](2);
        (cap2[0], cap2[1]) = (1e18, 1e18);

        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(c, pointer, s, one, cap2, URI); // length mismatch
        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(c, pointer, s, new address[](0), new uint256[](0), URI); // empty
        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(c, pointer, s, one, new uint256[](1), URI); // zero cap
        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(c, pointer, s, new address[](1), cap1, URI); // zero wrapper
        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(c, pointer, s, two, cap2, URI); // duplicate
        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(IMarketClock(address(0)), pointer, s, one, cap1, URI);
        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(c, IReopenPointer(address(0)), s, one, cap1, URI);
        vm.expectRevert(ReopenNote.BadConfig.selector);
        new ReopenNote(c, pointer, IScorecardPrice(address(0)), one, cap1, URI);
    }

    // --- mint -----------------------------------------------------------------------------------

    function test_mint_escrows_and_records_the_unit() public {
        _cycle(); // one verified reopen already happened: this note belongs to epoch 1
        wT.setRate(1.02e18);
        clock.setNonce(address(wT), 3);
        uint256 issuerBefore = wT.balanceOf(issuer);

        vm.expectEmit(true, true, true, true, address(note));
        emit NoteMinted(1, issuer, address(wT), 10e18, 10.2e18, 3, 1, holder);
        vm.expectEmit(true, true, true, true, address(note));
        emit TransferSingle(issuer, address(0), holder, 1, 10e18);
        uint256 id = _mint(10e18, holder);

        assertEq(id, 1);
        assertEq(note.noteCount(), 1);
        IReopenNote.Unit memory u = note.unitOf(id);
        assertEq(u.wrapper, address(wT));
        assertEq(u.issuer, issuer);
        assertEq(u.wrapperShares, 10e18);
        assertEq(u.underlyingAtMint, 10.2e18, "rawToShares at mint");
        assertEq(u.multiplierNonce, 3, "nonce from stateOf");
        assertEq(u.epochAtMint, 1);
        assertEq(u.mintedAt, block.timestamp);
        assertEq(u.mintedBlock, block.number);

        assertEq(wT.balanceOf(address(note)), 10e18, "escrowed 1:1");
        assertEq(wT.balanceOf(issuer), issuerBefore - 10e18);
        assertEq(note.balanceOf(holder, id), 10e18, "1 unit = 1 wei of share");
        assertEq(note.balanceOf(issuer, id), 0);
        assertEq(note.outstanding(id), 10e18);
        assertEq(note.openInterest(address(wT)), 10e18);
        assertEq(note.mintedInEpoch(address(wT), 1), 10e18, "counted in its own closure");
        assertEq(note.mintedInEpoch(address(wT), 0), 0);
        assertFalse(note.redeemable(id));

        uint256 id2 = _mint(1, issuer);
        assertEq(id2, 2);
        assertEq(note.openInterest(address(wT)), 10e18 + 1);
    }

    function test_mint_refusals() public {
        vm.startPrank(issuer);

        vm.expectRevert(ReopenNote.ZeroAmount.selector);
        note.mint(address(wT), 0, holder);

        vm.expectRevert(ReopenNote.UnsupportedAsset.selector);
        note.mint(address(wX), 1e18, holder); // priced, not supported
        vm.expectRevert(ReopenNote.UnsupportedAsset.selector);
        note.mint(address(0), 1e18, holder);

        _open(address(wT));
        vm.expectRevert(ReopenNote.MarketNotClosed.selector);
        note.mint(address(wT), 1e18, holder);

        clock.set(address(wT), IMarketClock.Regime.CLOSED, 5); // CLOSED but capacity left
        vm.expectRevert(ReopenNote.MarketNotClosed.selector);
        note.mint(address(wT), 1e18, holder);

        clock.set(address(wT), IMarketClock.Regime.OVERNIGHT, 0); // zero cap but not CLOSED
        vm.expectRevert(ReopenNote.MarketNotClosed.selector);
        note.mint(address(wT), 1e18, holder);

        clock.set(address(wT), IMarketClock.Regime.UNKNOWN, 0);
        vm.expectRevert(ReopenNote.MarketNotClosed.selector);
        note.mint(address(wT), 1e18, holder);

        _shut(address(wT));
        clock.setBlackout(address(wT), true);
        vm.expectRevert(ReopenNote.InBlackout.selector);
        note.mint(address(wT), 1e18, holder);
        clock.setBlackout(address(wT), false);

        vm.expectRevert(abi.encodeWithSelector(ReopenNote.CapExceeded.selector, 175e18 + 1, 175e18));
        note.mint(address(wT), 175e18 + 1, holder);
        note.mint(address(wT), 175e18, holder); // exactly the cap
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.CapExceeded.selector, 175e18 + 1, 175e18));
        note.mint(address(wT), 1, holder);

        vm.expectRevert(ERC1155Min.ERC1155ZeroAddress.selector);
        note.mint(address(wA), 1e18, address(0));
        vm.stopPrank();

        // No allowance / a frozen wrapper: the pull fails loudly and nothing is minted.
        wA.mint(stranger, 1e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(wA)));
        note.mint(address(wA), 1e18, stranger);
        wA.freeze(issuer);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(wA)));
        note.mint(address(wA), 1e18, issuer);

        assertEq(note.noteCount(), 1);
        assertEq(note.openInterest(address(wA)), 0);
    }

    function test_mint_refused_when_the_pointer_saw_it_open() public {
        // A pointer on a clock that says open (only reachable if the two clocks disagree).
        MockClock other = new MockClock();
        other.set(address(wT), IMarketClock.Regime.MARKET, OPEN_CAP);
        ReopenPointer p2 = new ReopenPointer(IMarketClock(address(other)), IScorecardPrice(address(sc)));
        ReopenNote n2 = _deploy(IReopenPointer(address(p2)));
        vm.startPrank(issuer);
        wT.approve(address(n2), type(uint256).max);
        vm.expectRevert(ReopenNote.MarketNotClosed.selector);
        n2.mint(address(wT), 1e18, holder);
        vm.stopPrank();
    }

    function test_mint_witnesses_the_shut_itself() public {
        assertEq(pointer.headOf(address(wT)).lastShutAt, 0);
        _mint(1e18, holder);
        assertEq(pointer.headOf(address(wT)).lastShutAt, block.timestamp, "the mint armed the pointer");
    }

    // --- redeem ---------------------------------------------------------------------------------

    function test_redeem_before_reopen_reverts() public {
        uint256 id = _mint(10e18, holder);
        _later(1 days);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.NotReopened.selector, id, uint32(0), uint32(0)));
        note.redeem(id, 1e18, holder);

        // Stale clock: still locked (UNKNOWN is not a reopen).
        clock.setRegime(address(wT), IMarketClock.Regime.UNKNOWN);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.NotReopened.selector, id, uint32(0), uint32(0)));
        note.redeem(id, 1e18, holder);
    }

    function test_redeem_partial_then_full_after_reopen() public {
        uint256 id = _mint(10e18, holder);
        _later(2 hours);
        _open(address(wT));
        assertFalse(note.redeemable(id), "nobody has witnessed the reopen yet");

        // The redeem witnesses the reopen itself.
        vm.expectEmit(true, true, false, true, address(pointer));
        emit IReopenPointer.Reopened(address(wT), 1, T0, uint64(block.timestamp), OPEN_CAP);
        vm.expectEmit(true, true, true, true, address(note));
        emit NoteRedeemed(id, holder, sink, 4e18, 4e18, 0, 1, false);
        vm.prank(holder);
        note.redeem(id, 4e18, sink);

        assertTrue(note.redeemable(id));
        assertEq(wT.balanceOf(sink), 4e18);
        assertEq(note.balanceOf(holder, id), 6e18);
        assertEq(note.outstanding(id), 6e18);
        assertEq(note.openInterest(address(wT)), 6e18);
        assertEq(wT.balanceOf(address(note)), 6e18);

        vm.prank(holder);
        note.redeem(id, 6e18, holder);
        assertEq(wT.balanceOf(holder), 6e18);
        assertEq(note.outstanding(id), 0);
        assertEq(note.openInterest(address(wT)), 0);
        assertEq(wT.balanceOf(address(note)), 0);

        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155InsufficientBalance.selector, holder, id, 0, 1));
        note.redeem(id, 1, holder);
    }

    function test_redeem_after_the_market_shuts_again() public {
        uint256 id = _mint(5e18, holder);
        _cycle(); // reopened and shut again before anyone redeemed
        _later(1 days);
        vm.prank(holder);
        note.redeem(id, 5e18, holder);
        assertEq(wT.balanceOf(holder), 5e18);
    }

    function test_redeem_ten_day_fallback() public {
        uint256 id = _mint(3e18, holder);
        uint64 mintedAt = uint64(block.timestamp);
        clock.setRegime(address(wT), IMarketClock.Regime.UNKNOWN); // the clock went dark for good

        vm.warp(mintedAt + 10 days - 1);
        assertFalse(note.redeemable(id));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.NotReopened.selector, id, uint32(0), uint32(0)));
        note.redeem(id, 1e18, holder);

        vm.warp(mintedAt + 10 days);
        assertTrue(note.redeemable(id));
        vm.expectEmit(true, true, true, true, address(note));
        emit NoteRedeemed(id, holder, holder, 3e18, 3e18, 0, 0, true);
        vm.prank(holder);
        note.redeem(id, 3e18, holder);
        assertEq(wT.balanceOf(holder), 3e18);
    }

    function test_redeem_is_not_blocked_by_a_multiplier_blackout() public {
        uint256 id = _mint(2e18, holder);
        _later(1 hours);
        _open(address(wT));
        clock.setBlackout(address(wT), true);
        vm.prank(holder);
        note.redeem(id, 2e18, holder);
        assertEq(wT.balanceOf(holder), 2e18);
    }

    function test_redeem_guards() public {
        uint256 id = _mint(2e18, holder);
        _later(1 hours);
        _open(address(wT));
        vm.startPrank(holder);
        vm.expectRevert(ReopenNote.ZeroAmount.selector);
        note.redeem(id, 0, holder);
        vm.expectRevert(ERC1155Min.ERC1155ZeroAddress.selector);
        note.redeem(id, 1, address(0));
        // Shares sent to the note itself would be stranded outside every escrow.
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.InvalidRecipient.selector, address(note)));
        note.redeem(id, 1, address(note));
        vm.expectRevert(ReopenNote.UnknownNote.selector);
        note.redeem(0, 1, holder);
        vm.expectRevert(ReopenNote.UnknownNote.selector);
        note.redeem(99, 1, holder);
        vm.stopPrank();

        // Only the caller's own units burn: an operator approval does not let a stranger redeem them.
        vm.prank(holder);
        note.setApprovalForAll(stranger, true);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155InsufficientBalance.selector, stranger, id, 0, 1));
        note.redeem(id, 1, stranger);
    }

    /// Whatever happens to the 4626 rate and the corporate-action nonce between mint and redeem, the
    /// holder receives exactly the wrapper shares they burn; the underlying count is provenance only.
    function testFuzz_rate_and_nonce_change_still_deliver_exactly_amount(
        uint256 rate0,
        uint256 rate1,
        uint32 nonce1,
        uint128 minted,
        uint128 part
    ) public {
        rate0 = bound(rate0, 1, 1e24);
        rate1 = bound(rate1, 0, 1e24);
        minted = uint128(bound(minted, 1, 175e18));
        part = uint128(bound(part, 1, minted));

        wT.setRate(rate0);
        uint256 id = _mint(minted, holder);
        assertEq(note.unitOf(id).underlyingAtMint, minted * rate0 / 1e18);

        wT.setRate(rate1);
        clock.setNonce(address(wT), nonce1);
        _later(1 hours);
        _open(address(wT));

        vm.expectEmit(true, true, true, true, address(note));
        emit NoteRedeemed(id, holder, sink, part, uint256(part) * rate1 / 1e18, nonce1, 1, false);
        vm.prank(holder);
        note.redeem(id, part, sink);
        assertEq(wT.balanceOf(sink), part, "exactly amount");
        assertEq(wT.balanceOf(address(note)), minted - part);

        if (minted > part) {
            vm.prank(holder);
            note.redeem(id, minted - part, sink);
        }
        assertEq(wT.balanceOf(sink), minted, "everything escrowed came back out");
        assertEq(note.openInterest(address(wT)), 0);
    }

    function test_a_reverting_provenance_read_never_blocks_delivery() public {
        uint256 id = _mint(5e18, holder);
        wT.setRate(type(uint256).max); // convertToAssets(5e18) now overflows and reverts
        _later(1 hours);
        _open(address(wT));
        vm.expectEmit(true, true, true, true, address(note));
        emit NoteRedeemed(id, holder, holder, 5e18, 0, 0, 1, false);
        vm.prank(holder);
        note.redeem(id, 5e18, holder);
        assertEq(wT.balanceOf(holder), 5e18);
    }

    // --- cancel ---------------------------------------------------------------------------------

    function test_cancel_by_the_issuer_holding_everything() public {
        uint256 id = _mint(8e18, issuer);
        uint256 before = wT.balanceOf(issuer);
        vm.expectEmit(true, true, false, true, address(note));
        emit NoteCancelled(id, issuer, 8e18);
        vm.prank(issuer);
        note.cancel(id);
        assertEq(wT.balanceOf(issuer), before + 8e18);
        assertEq(note.outstanding(id), 0);
        assertEq(note.openInterest(address(wT)), 0);
        assertEq(note.balanceOf(issuer, id), 0);
        assertEq(note.unitOf(id).wrapperShares, 8e18, "the record stays");

        vm.prank(issuer);
        vm.expectRevert(ReopenNote.ZeroAmount.selector);
        note.cancel(id);
    }

    function test_cancel_rules() public {
        uint256 id = _mint(8e18, holder);
        vm.prank(issuer);
        vm.expectRevert(ReopenNote.NotWholeIssuer.selector);
        note.cancel(id); // the units are elsewhere
        vm.prank(holder);
        vm.expectRevert(ReopenNote.NotWholeIssuer.selector);
        note.cancel(id); // holder has them all but is not the issuer
        vm.expectRevert(ReopenNote.UnknownNote.selector);
        note.cancel(42);

        vm.prank(holder);
        note.safeTransferFrom(holder, issuer, id, 5e18, "");
        vm.prank(issuer);
        vm.expectRevert(ReopenNote.NotWholeIssuer.selector);
        note.cancel(id); // 5 of 8

        vm.prank(holder);
        note.safeTransferFrom(holder, issuer, id, 3e18, "");
        vm.prank(issuer);
        note.cancel(id); // all 8 back
        assertEq(note.openInterest(address(wT)), 0);
    }

    function test_cancel_after_a_partial_redeem_takes_the_rest() public {
        uint256 id = _mint(10e18, issuer);
        vm.prank(issuer);
        note.safeTransferFrom(issuer, holder, id, 3e18, "");
        _later(1 hours);
        _open(address(wT));
        vm.prank(holder);
        note.redeem(id, 3e18, holder);

        uint256 before = wT.balanceOf(issuer);
        vm.prank(issuer);
        note.cancel(id); // after the reopen too: holding everything outstanding is the only rule
        assertEq(wT.balanceOf(issuer), before + 7e18);
        assertEq(note.outstanding(id), 0);
        assertEq(wT.balanceOf(address(note)), 0);
    }

    // --- per-closure cap and open interest ----------------------------------------------------------

    function test_cap_is_per_closure_and_frees_on_cancel_and_redeem() public {
        vm.startPrank(issuer);
        uint256 a = note.mint(address(wA), 10e18, issuer);
        uint256 b = note.mint(address(wA), 4e18, holder);
        assertEq(note.mintedInEpoch(address(wA), 0), 14e18);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.CapExceeded.selector, 14e18 + 1, 14e18));
        note.mint(address(wA), 1, issuer);
        assertEq(note.openInterest(address(wA)), 14e18);

        note.cancel(a); // cancel frees the closure's cap
        assertEq(note.mintedInEpoch(address(wA), 0), 4e18);
        assertEq(note.openInterest(address(wA)), 4e18);
        note.mint(address(wA), 10e18, issuer);
        vm.stopPrank();

        _later(1 hours);
        _open(address(wA));
        vm.prank(holder);
        note.redeem(b, 1e18, holder);
        assertEq(note.openInterest(address(wA)), 13e18);
        assertEq(note.mintedInEpoch(address(wA), 0), 13e18, "closure 0 still counts its own outstanding units");
        assertEq(wA.balanceOf(address(note)), 13e18);

        // The next closure has its whole cap, even though 13e18 of closure 0 is still outstanding.
        _later(1 hours);
        _shut(address(wA));
        vm.startPrank(issuer);
        note.mint(address(wA), 14e18, issuer);
        vm.expectRevert(abi.encodeWithSelector(ReopenNote.CapExceeded.selector, 14e18 + 1, 14e18));
        note.mint(address(wA), 1, issuer);
        vm.stopPrank();
        assertEq(note.mintedInEpoch(address(wA), 1), 14e18);
        assertEq(note.openInterest(address(wA)), 27e18, "escrow total spans closures");
        assertEq(wA.balanceOf(address(note)), 27e18);
        assertEq(note.openInterest(address(wT)), 0, "per-wrapper");
    }

    /// Review finding: an unlocked-but-never-redeemed note from closure e must not block closure e+1.
    function test_an_unredeemed_note_from_the_last_closure_does_not_block_the_next() public {
        vm.prank(issuer);
        uint256 id = note.mint(address(wA), 14e18, holder); // closure 0 filled to the cap
        _later(1 hours);
        _open(address(wA));
        pointer.observe(address(wA)); // reopen witnessed: the note is unlocked, and the holder sits on it
        assertTrue(note.redeemable(id));
        _later(20 hours);
        _shut(address(wA));

        vm.prank(issuer);
        uint256 next = note.mint(address(wA), 14e18, issuer); // closure 1: full cap available
        assertEq(note.unitOf(next).epochAtMint, 1);
        assertEq(note.mintedInEpoch(address(wA), 0), 14e18);
        assertEq(note.mintedInEpoch(address(wA), 1), 14e18);
        assertEq(note.openInterest(address(wA)), 28e18);

        // The old note still redeems for exactly its shares, and only its own closure's count moves.
        vm.prank(holder);
        note.redeem(id, 14e18, holder);
        assertEq(wA.balanceOf(holder), 14e18);
        assertEq(note.mintedInEpoch(address(wA), 0), 0);
        assertEq(note.mintedInEpoch(address(wA), 1), 14e18);
    }

    function test_a_fallback_redeem_in_the_same_closure_frees_its_cap() public {
        vm.prank(issuer);
        uint256 id = note.mint(address(wA), 14e18, holder);
        vm.warp(block.timestamp + 10 days); // no reopen witnessed in ten days
        vm.prank(holder);
        note.redeem(id, 4e18, holder);
        assertEq(note.mintedInEpoch(address(wA), 0), 10e18);
        vm.prank(issuer);
        note.mint(address(wA), 4e18, issuer); // still closure 0, and there is room again
        assertEq(note.mintedInEpoch(address(wA), 0), 14e18);
    }

    // --- ERC-1155 -------------------------------------------------------------------------------

    function test_erc1155_receiver_check() public {
        address good = address(new GoodReceiver1155());
        address bad = address(new NoHook1155());
        uint256 id = _mint(1e18, good);
        assertEq(note.balanceOf(good, id), 1e18);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, bad));
        note.mint(address(wT), 1e18, bad);

        uint256 id2 = _mint(1e18, holder);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, bad));
        note.safeTransferFrom(holder, bad, id2, 1, "");

        // EIP-7702 delegated EOAs have code, so they are checked too (the Agentic Wallet case).
        (address smart, uint256 smartKey) = makeAddrAndKey("7702-good");
        vm.signAndAttachDelegation(address(new GoodReceiver1155()), smartKey);
        _mint(1e18, smart);
        assertEq(smart.code.length, 23);
        (address dumb, uint256 dumbKey) = makeAddrAndKey("7702-nohook");
        vm.signAndAttachDelegation(address(new NoHook1155()), dumbKey);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, dumb));
        note.mint(address(wT), 1e18, dumb);
    }

    function test_erc1155_transfers_and_operators() public {
        uint256 id = _mint(5e18, holder);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155NotAuthorized.selector, stranger, holder));
        note.safeTransferFrom(holder, stranger, id, 1, "");

        vm.prank(holder);
        note.setApprovalForAll(stranger, true);
        assertTrue(note.isApprovedForAll(holder, stranger));
        vm.prank(stranger);
        note.safeTransferFrom(holder, sink, id, 2e18, "");
        assertEq(note.balanceOf(sink, id), 2e18);

        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        (ids[0], vals[0]) = (id, 1e18);
        vm.prank(holder);
        note.safeBatchTransferFrom(holder, sink, ids, vals, "");
        assertEq(note.balanceOf(sink, id), 3e18);
        assertEq(note.outstanding(id), 5e18, "transfers never touch outstanding");

        // A new holder redeems their own units after the reopen.
        _later(1 hours);
        _open(address(wT));
        vm.prank(sink);
        note.redeem(id, 3e18, sink);
        assertEq(wT.balanceOf(sink), 3e18);
    }

    function test_reentrancy_is_refused() public {
        ReentrantReceiver r = new ReentrantReceiver();
        wT.mint(address(r), 1e18);
        vm.prank(address(r));
        wT.approve(address(note), type(uint256).max);

        // The receiver tries to mint again from inside its own mint's hook.
        r.arm(address(note), abi.encodeCall(ReopenNote.mint, (address(wT), 1, address(r))));
        vm.prank(issuer);
        vm.expectRevert(ReopenNote.Reentrancy.selector);
        note.mint(address(wT), 1e18, address(r));

        // ... or to move a note from inside a transfer's hook.
        uint256 id = _mint(1e18, holder);
        r.arm(address(note), abi.encodeCall(ReopenNote.redeem, (id, 1, address(r))));
        vm.prank(holder);
        vm.expectRevert(ReopenNote.Reentrancy.selector);
        note.safeTransferFrom(holder, address(r), id, 1, "");
    }

    // --- Builder Code (ERC-8021 suffix) ------------------------------------------------------------

    function test_builder_code_suffix_changes_nothing() public {
        address n = address(note);
        bool ok;
        bytes memory ret;

        // mint (to the issuer, and to a holder)
        (ok, ret) = _suffixEq(issuer, n, abi.encodeCall(ReopenNote.mint, (address(wT), 10e18, issuer)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 1);
        (ok,) = _suffixEq(issuer, n, abi.encodeCall(ReopenNote.mint, (address(wT), 6e18, holder)));
        assertTrue(ok);
        // a refusal is the same refusal
        (ok, ret) = _suffixEq(issuer, n, abi.encodeCall(ReopenNote.mint, (address(wT), 0, holder)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ReopenNote.ZeroAmount.selector));

        // ERC-1155 moves
        (ok,) = _suffixEq(holder, n, abi.encodeWithSelector(note.setApprovalForAll.selector, stranger, true));
        assertTrue(ok);
        (ok,) = _suffixEq(stranger, n, abi.encodeCall(ReopenNote.safeTransferFrom, (holder, sink, 2, 1e18, "")));
        assertTrue(ok);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        (ids[0], vals[0]) = (2, 1e18);
        (ok,) = _suffixEq(holder, n, abi.encodeWithSelector(note.safeBatchTransferFrom.selector, holder, sink, ids, vals, bytes("")));
        assertTrue(ok);

        // redeem: locked (same refusal), then after the reopen (same delivery)
        (ok, ret) = _suffixEq(sink, n, abi.encodeCall(ReopenNote.redeem, (2, 1e18, sink)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ReopenNote.NotReopened.selector, 2, uint32(0), uint32(0)));
        _later(1 hours);
        _open(address(wT));
        (ok,) = _suffixEq(sink, n, abi.encodeCall(ReopenNote.redeem, (2, 1e18, sink)));
        assertTrue(ok);
        assertEq(wT.balanceOf(sink), 1e18, "the tagged redeem delivered");

        // cancel: refused for a non-issuer, done for the issuer holding everything
        (ok, ret) = _suffixEq(holder, n, abi.encodeCall(ReopenNote.cancel, (2)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ReopenNote.NotWholeIssuer.selector));
        (ok,) = _suffixEq(issuer, n, abi.encodeCall(ReopenNote.cancel, (1)));
        assertTrue(ok);
        assertEq(note.outstanding(1), 0);

        // views
        bytes[10] memory views = [
            abi.encodeCall(ReopenNote.unitOf, (2)),
            abi.encodeCall(ReopenNote.outstanding, (2)),
            abi.encodeCall(ReopenNote.redeemable, (2)),
            abi.encodeCall(ReopenNote.balanceOf, (holder, 2)),
            abi.encodeCall(ReopenNote.isApprovedForAll, (holder, stranger)),
            abi.encodeWithSelector(note.capShares.selector, address(wT)),
            abi.encodeWithSelector(note.openInterest.selector, address(wT)),
            abi.encodeCall(ReopenNote.supportedAssets, ()),
            abi.encodeWithSelector(note.uri.selector, uint256(2)),
            abi.encodeWithSelector(note.supportsInterface.selector, bytes4(0xd9b67a26))
        ];
        for (uint256 i; i < views.length; ++i) {
            (ok,) = _suffixEq(stranger, n, views[i]);
            assertTrue(ok);
        }
    }
}
