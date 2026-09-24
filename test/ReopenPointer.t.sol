// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ReopenPointer} from "../src/ReopenPointer.sol";
import {IReopenPointer} from "../src/interfaces/IReopenPointer.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../src/interfaces/IScorecardPrice.sol";
import {MockClock} from "./mocks/MockClock.sol";
import {MockScorecardPrice} from "./mocks/MockScorecardPrice.sol";

/// Shared by the pointer and note suites: run one call plain, rewind, run it again with the ERC-8021
/// Builder Code appended, and require the same success, return data, events and resulting state.
abstract contract SuffixHarness is Test {
    /// Builder Code dd7u50nckt5e729f, ERC-8021 schema 0 (see test/DataSuffix.t.sol).
    bytes constant SUFFIX = hex"6464377535306e636b74356537323966100080218021802180218021802180218021";

    /// Every view the calls under test can write to, as one blob.
    function _digest() internal view virtual returns (bytes memory);

    /// Leaves the chain in the state the SUFFIXED call produced.
    function _suffixEq(address from, address target, bytes memory data) internal returns (bool ok, bytes memory ret) {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(from);
        (ok, ret) = target.call(data);
        Vm.Log[] memory plainLogs = vm.getRecordedLogs();
        bytes memory plainState = _digest();

        vm.revertToState(snap);
        bytes memory tagged = abi.encodePacked(data, SUFFIX);
        assertEq(tagged.length, data.length + 34);
        vm.recordLogs();
        vm.prank(from);
        (bool ok2, bytes memory ret2) = target.call(tagged);
        Vm.Log[] memory taggedLogs = vm.getRecordedLogs();

        assertEq(ok, ok2, "same outcome");
        assertEq(ret, ret2, "same return / revert data");
        assertEq(plainLogs.length, taggedLogs.length, "same number of events");
        for (uint256 i; i < plainLogs.length; ++i) {
            assertEq(plainLogs[i].emitter, taggedLogs[i].emitter, "same emitter");
            assertEq(plainLogs[i].topics, taggedLogs[i].topics, "same event topics");
            assertEq(plainLogs[i].data, taggedLogs[i].data, "same event data");
        }
        assertEq(plainState, _digest(), "same resulting state");
    }
}

contract ReopenPointerTest is SuffixHarness {
    MockClock clock;
    MockScorecardPrice sc;
    ReopenPointer p;
    address w = makeAddr("wTCENTx");
    address stranger = makeAddr("stranger");

    uint128 constant CAP = 2_000_000;
    uint128 constant PX = 55.78e18;
    uint64 constant T0 = 1_790_000_000;

    function setUp() public {
        vm.warp(T0);
        vm.roll(1000);
        clock = new MockClock();
        sc = new MockScorecardPrice();
        sc.setPrice(w, PX);
        p = new ReopenPointer(IMarketClock(address(clock)), IScorecardPrice(address(sc)));
    }

    // --- helpers ------------------------------------------------------------------------------

    function _shut() internal { clock.set(w, IMarketClock.Regime.CLOSED, 0); }
    function _open() internal { clock.set(w, IMarketClock.Regime.MARKET, CAP); }
    function _unknown() internal { clock.setRegime(w, IMarketClock.Regime.UNKNOWN); }

    function _step(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + (dt == 0 ? 0 : 1));
    }

    function _obs() internal returns (uint32 e, bool open) {
        vm.prank(stranger);
        return p.observe(w);
    }

    /// Shut at t, open at t + gap: epoch `head + 1` opened at t + gap.
    function _cycle(uint256 gap) internal returns (uint64 shutAt, uint64 openedAt) {
        _shut();
        _obs();
        shutAt = uint64(block.timestamp);
        _step(gap);
        _open();
        _obs();
        openedAt = uint64(block.timestamp);
    }

    function _digest() internal view override returns (bytes memory) {
        uint32 e = p.epochOf(w);
        return abi.encode(p.headOf(w), p.isOpen(w), e, p.epochInfo(w, e), p.epochInfo(w, e == 0 ? 0 : e - 1));
    }

    // --- construction -------------------------------------------------------------------------

    function test_constructor_wires_and_rejects_zero() public {
        assertEq(address(p.clock()), address(clock));
        assertEq(address(p.scorecard()), address(sc));
        assertEq(p.PRINT_DELAY(), 300);
        assertEq(p.PRINT_WINDOW(), 1800);
        vm.expectRevert(ReopenPointer.ZeroAddress.selector);
        new ReopenPointer(IMarketClock(address(0)), IScorecardPrice(address(sc)));
        vm.expectRevert(ReopenPointer.ZeroAddress.selector);
        new ReopenPointer(IMarketClock(address(clock)), IScorecardPrice(address(0)));
    }

    // --- observe --------------------------------------------------------------------------------

    function test_first_ever_open_creates_no_epoch() public {
        _open();
        vm.recordLogs();
        (uint32 e, bool open) = _obs();
        assertEq(vm.getRecordedLogs().length, 0, "no Reopened for an unwitnessed shut");
        assertEq(e, 0);
        assertTrue(open);
        assertEq(p.epochOf(w), 0);
        assertTrue(p.isOpen(w));
        ReopenPointer.Head memory h = p.headOf(w);
        assertEq(h.lastShutAt, 0);
        assertEq(h.lastObservedAt, T0);
        assertEq(p.epochInfo(w, 1).openedAt, 0, "no epoch record either");
    }

    function test_first_ever_shut_emits_nothing_but_arms_the_pointer() public {
        _shut();
        vm.recordLogs();
        (uint32 e, bool open) = _obs();
        assertEq(vm.getRecordedLogs().length, 0, "Shut only on open->shut");
        assertEq(e, 0);
        assertFalse(open);
        assertEq(p.headOf(w).lastShutAt, T0);
    }

    function test_shut_then_open_is_epoch_1_with_its_bracket() public {
        _shut();
        _obs();
        _step(40);
        _obs(); // the latest shut sighting is the one that brackets the reopen
        uint64 shutAt = uint64(block.timestamp);
        _step(95);
        _open();
        uint64 openAt = uint64(block.timestamp);

        vm.expectEmit(true, true, false, true, address(p));
        emit IReopenPointer.Reopened(w, 1, shutAt, openAt, CAP);
        (uint32 e, bool open) = _obs();
        assertEq(e, 1);
        assertTrue(open);

        IReopenPointer.Epoch memory ep = p.epochInfo(w, 1);
        assertEq(ep.shutSeenAt, shutAt);
        assertEq(ep.openedAt, openAt);
        assertEq(ep.openedBlock, block.number);
        assertEq(ep.print, 0);
        assertEq(ep.printedAt, 0);
        assertLt(ep.shutSeenAt, ep.openedAt, "true reopen lies in (shutSeenAt, openedAt]");
    }

    function test_repeated_opens_do_not_advance() public {
        _cycle(100);
        vm.recordLogs();
        for (uint256 i; i < 5; ++i) {
            _step(60);
            (uint32 e, bool open) = _obs();
            assertEq(e, 1);
            assertTrue(open);
        }
        assertEq(vm.getRecordedLogs().length, 0);
        // A cap change while open is still just "open".
        clock.set(w, IMarketClock.Regime.EXTENDED, 7);
        _step(60);
        (uint32 e2,) = _obs();
        assertEq(e2, 1);
    }

    function test_unknown_is_a_noop_from_every_state() public {
        // Never observed.
        _unknown();
        vm.recordLogs();
        (uint32 e, bool open) = _obs();
        assertEq(e, 0);
        assertFalse(open);
        assertEq(p.headOf(w).lastObservedAt, 0);

        // Shut, then stale: the stale reading changes nothing, not even lastObservedAt.
        _shut();
        _obs();
        bytes memory before = abi.encode(p.headOf(w));
        _step(600);
        _unknown();
        (e, open) = _obs();
        assertEq(abi.encode(p.headOf(w)), before);
        assertFalse(open);

        // Open, then stale.
        _step(60);
        _open();
        _obs();
        before = abi.encode(p.headOf(w));
        _step(600);
        _unknown();
        (e, open) = _obs();
        assertEq(abi.encode(p.headOf(w)), before);
        assertTrue(open, "UNKNOWN is not read as shut");
        assertEq(e, 1);

        // Open -> UNKNOWN -> open does not advance (no shut was witnessed).
        _step(60);
        _open();
        (e,) = _obs();
        assertEq(e, 1);
        // Only the Reopened of the one real cycle was emitted.
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_unknown_between_shut_and_open_keeps_the_shut_bracket() public {
        _shut();
        _obs();
        uint64 shutAt = uint64(block.timestamp);
        _step(300);
        _unknown();
        _obs();
        _step(300);
        _open();
        (uint32 e,) = _obs();
        assertEq(e, 1);
        assertEq(p.epochInfo(w, 1).shutSeenAt, shutAt);
    }

    function test_open_shut_open_is_epoch_2_and_shut_emits_once() public {
        (, uint64 opened1) = _cycle(100);
        _step(3600);
        _shut();
        vm.expectEmit(true, true, false, true, address(p));
        emit IReopenPointer.Shut(w, 1, uint64(block.timestamp));
        (uint32 e, bool open) = _obs();
        assertEq(e, 1);
        assertFalse(open);

        // A second shut sighting moves lastShutAt but emits nothing.
        _step(120);
        vm.recordLogs();
        _obs();
        assertEq(vm.getRecordedLogs().length, 0);
        uint64 shut2 = uint64(block.timestamp);

        _step(200);
        _open();
        (e, open) = _obs();
        assertEq(e, 2);
        assertTrue(open);
        IReopenPointer.Epoch memory ep2 = p.epochInfo(w, 2);
        assertEq(ep2.shutSeenAt, shut2);
        assertEq(ep2.openedAt, uint64(block.timestamp));
        assertGe(ep2.shutSeenAt, opened1, "openedAt(1) <= shutSeenAt(2)");
        assertEq(p.epochInfo(w, 1).openedAt, opened1, "epoch 1 untouched");
    }

    function test_same_second_shut_then_open_waits_for_a_later_second() public {
        _shut();
        _obs();
        _open(); // same block, same second
        vm.recordLogs();
        (uint32 e, bool open) = _obs();
        assertEq(e, 0, "(t, t] is empty: no epoch yet");
        assertFalse(open);
        assertEq(vm.getRecordedLogs().length, 0);

        _step(1);
        (e, open) = _obs();
        assertEq(e, 1);
        assertTrue(open);
        IReopenPointer.Epoch memory ep = p.epochInfo(w, 1);
        assertLt(ep.shutSeenAt, ep.openedAt);
    }

    function test_open_then_shut_in_the_same_second_is_allowed() public {
        (, uint64 opened1) = _cycle(10);
        _shut();
        (uint32 e, bool open) = _obs();
        assertEq(e, 1);
        assertFalse(open);
        assertEq(p.headOf(w).lastShutAt, opened1, "next shutSeenAt may equal openedAt");
    }

    function test_wrappers_are_independent() public {
        address other = makeAddr("wNVDAx");
        _cycle(10);
        assertEq(p.epochOf(other), 0);
        assertFalse(p.isOpen(other));
    }

    // --- recordPrint ----------------------------------------------------------------------------

    function test_recordPrint_unknown_epoch() public {
        vm.expectRevert(ReopenPointer.UnknownEpoch.selector);
        p.recordPrint(w, 0);
        vm.expectRevert(ReopenPointer.UnknownEpoch.selector);
        p.recordPrint(w, 1);
        _cycle(10);
        vm.expectRevert(ReopenPointer.UnknownEpoch.selector);
        p.recordPrint(w, 0);
        vm.expectRevert(ReopenPointer.UnknownEpoch.selector);
        p.recordPrint(w, 2);
    }

    function test_recordPrint_window_edges() public {
        (, uint64 openedAt) = _cycle(10);
        uint64 readyAt = openedAt + 300;
        uint64 deadline = readyAt + 1800;

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(ReopenPointer.PrintTooEarly.selector, readyAt));
        p.recordPrint(w, 1);

        uint256 snap = vm.snapshotState();
        vm.warp(readyAt);
        vm.expectEmit(true, true, false, true, address(p));
        emit IReopenPointer.Printed(w, 1, PX, readyAt);
        vm.prank(stranger); // permissionless
        assertEq(p.recordPrint(w, 1), PX);
        IReopenPointer.Epoch memory ep = p.epochInfo(w, 1);
        assertEq(ep.print, PX);
        assertEq(ep.printedAt, readyAt);

        vm.revertToState(snap);
        vm.warp(deadline);
        assertEq(p.recordPrint(w, 1), PX, "the deadline second is inside");

        vm.revertToState(snap);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ReopenPointer.PrintTooLate.selector, deadline));
        p.recordPrint(w, 1);
    }

    function test_recordPrint_refuses_while_shut_or_unknown() public {
        (, uint64 openedAt) = _cycle(10);
        vm.warp(openedAt + 400);
        _shut();
        vm.expectRevert(ReopenPointer.MarketShut.selector);
        p.recordPrint(w, 1);
        _unknown(); // a stale clock reads cap 0
        vm.expectRevert(ReopenPointer.MarketShut.selector);
        p.recordPrint(w, 1);
        _open();
        assertEq(p.recordPrint(w, 1), PX);
    }

    function test_recordPrint_is_write_once() public {
        (, uint64 openedAt) = _cycle(10);
        vm.warp(openedAt + 400);
        p.recordPrint(w, 1);
        sc.setPrice(w, 99e18); // a better number later changes nothing
        vm.warp(openedAt + 500);
        vm.expectRevert(ReopenPointer.AlreadyPrinted.selector);
        vm.prank(stranger);
        p.recordPrint(w, 1);
        assertEq(p.epochInfo(w, 1).print, PX);
        assertEq(p.epochInfo(w, 1).printedAt, openedAt + 400);
    }

    function test_recordPrint_price_revert_leaves_it_retryable() public {
        (, uint64 openedAt) = _cycle(10);
        vm.warp(openedAt + 400);
        sc.setRevert(w, true);
        vm.expectRevert(); // PriceUnreadable(pool), bubbled
        p.recordPrint(w, 1);
        assertEq(p.epochInfo(w, 1).printedAt, 0);

        sc.clearPriceSource(w);
        vm.expectRevert(abi.encodeWithSelector(MockScorecardPrice.NoPriceSource.selector, w));
        p.recordPrint(w, 1);

        sc.setRevert(w, false);
        sc.setPrice(w, 56e18);
        vm.warp(openedAt + 900);
        assertEq(p.recordPrint(w, 1), 56e18);
    }

    function test_each_epoch_prints_on_its_own() public {
        (, uint64 opened1) = _cycle(10);
        vm.warp(opened1 + 300);
        p.recordPrint(w, 1);
        _step(4000);
        (, uint64 opened2) = _cycle(10);
        sc.setPrice(w, 57e18);
        vm.warp(opened2 + 301);
        assertEq(p.recordPrint(w, 2), 57e18);
        assertEq(p.epochInfo(w, 1).print, PX);
        vm.expectRevert(ReopenPointer.AlreadyPrinted.selector);
        p.recordPrint(w, 1);
    }

    // --- fuzz: random regimes over non-decreasing time -------------------------------------------

    /// A reference model of the spec runs alongside: epoch, open flag and lastShutAt must match it at
    /// every step, and every stored bracket must be strictly ordered and chain onto the previous one.
    function testFuzz_observe_matches_the_model(uint8[40] calldata ops, uint32[40] calldata gaps) public {
        uint32 mEpoch;
        bool mOpen;
        uint64 mLastShut;
        for (uint256 i; i < 40; ++i) {
            _step(bound(gaps[i], 0, 3 days));
            uint8 op = ops[i] % 4;
            if (op == 0) _unknown();
            else if (op == 1) _shut();
            else clock.set(w, IMarketClock.Regime(op == 2 ? 2 : 4), uint128(1 + (ops[i] >> 2)));

            uint64 now_ = uint64(block.timestamp);
            if (op == 1) {
                mOpen = false;
                mLastShut = now_;
            } else if (op >= 2 && !mOpen) {
                if (mLastShut == 0) mOpen = true;
                else if (mLastShut < now_) { mEpoch++; mOpen = true; }
            }

            uint32 before = p.epochOf(w);
            (uint32 e, bool open) = _obs();
            assertGe(e, before, "epoch never decreases");
            assertLe(e, before + 1, "at most one reopen per observation");
            assertEq(e, mEpoch, "epoch");
            assertEq(open, mOpen, "open");
            assertEq(p.headOf(w).lastShutAt, mLastShut, "lastShutAt");

            if (e > before) {
                IReopenPointer.Epoch memory ep = p.epochInfo(w, e);
                assertLt(ep.shutSeenAt, ep.openedAt, "shutSeenAt < openedAt");
                assertEq(ep.openedAt, now_);
                if (e > 1) assertLe(p.epochInfo(w, e - 1).openedAt, ep.shutSeenAt, "openedAt <= next shutSeenAt");
            }
        }
    }

    // --- Builder Code (ERC-8021 suffix) ------------------------------------------------------------

    function test_builder_code_suffix_changes_nothing() public {
        address pp = address(p);
        bool ok;
        bytes memory ret;

        // observe: first shut, the reopen (Reopened), a repeat open, a re-shut (Shut), a stale no-op.
        _shut();
        (ok, ret) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.observe, (w)));
        assertTrue(ok);
        _step(100);
        _open();
        (ok, ret) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.observe, (w)));
        assertTrue(ok);
        (uint32 e, bool open) = abi.decode(ret, (uint32, bool));
        assertEq(e, 1);
        assertTrue(open);
        uint64 openedAt = uint64(block.timestamp);

        // recordPrint: too early (same refusal), in window (same print), twice (same refusal).
        (ok, ret) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.recordPrint, (w, 1)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ReopenPointer.PrintTooEarly.selector, openedAt + 300));
        vm.warp(openedAt + 300);
        (ok, ret) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.recordPrint, (w, 1)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint128)), PX);
        (ok, ret) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.recordPrint, (w, 1)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ReopenPointer.AlreadyPrinted.selector));

        _step(60);
        (ok,) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.observe, (w)));
        assertTrue(ok);
        _shut();
        (ok,) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.observe, (w)));
        assertTrue(ok);
        _step(60);
        _unknown();
        (ok,) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.observe, (w)));
        assertTrue(ok);

        // Views answer the same with the suffix.
        (ok,) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.epochOf, (w)));
        assertTrue(ok);
        (ok,) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.isOpen, (w)));
        assertTrue(ok);
        (ok, ret) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.epochInfo, (w, 1)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (IReopenPointer.Epoch)).print, PX);
        (ok,) = _suffixEq(stranger, pp, abi.encodeCall(ReopenPointer.headOf, (w)));
        assertTrue(ok);
    }
}
