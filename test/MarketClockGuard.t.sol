// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketClock} from "../src/MarketClock.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {MarketClockGuard, MarketClockGuarded} from "../src/lib/MarketClockGuard.sol";
import {MarketClockStatus} from "../src/adapters/MarketClockStatus.sol";
import {ExampleLendingGuard} from "../src/examples/ExampleLendingGuard.sol";
import {MockClock} from "./mocks/MockClock.sol";
import {NonceRaw} from "./MarketClockStatus.t.sol";

/// The library's internal functions, made callable so a revert can be asserted.
contract GuardHarness {
    function isArbitraged(IMarketClock clock, address wrapper) external view returns (bool) {
        return MarketClockGuard.isArbitraged(clock, wrapper);
    }

    function requireArbitraged(IMarketClock clock, address wrapper) external view {
        MarketClockGuard.requireArbitraged(clock, wrapper);
    }

    function requireNotBlackout(IMarketClock clock, address wrapper) external view {
        MarketClockGuard.requireNotBlackout(clock, wrapper);
    }
}

/// The abstract contract's modifiers, on a contract that counts the calls they let through.
contract GuardedCounter is MarketClockGuarded {
    uint256 public opened;
    uint256 public settled;

    constructor(IMarketClock clock_) MarketClockGuarded(clock_) {}

    function open(address wrapper) external whenPrimaryOpen(wrapper) { ++opened; }
    function settle(address wrapper) external notDuringBlackout(wrapper) { ++settled; }
}

contract MarketClockGuardTest is Test {
    MockClock mock;
    GuardHarness g;
    GuardedCounter counter;
    MarketClockStatus status;
    address w = makeAddr("wTCENTx");

    uint128 constant CAP = 200_000;
    uint64 constant T0 = 1_790_297_648;

    function setUp() public {
        vm.warp(T0);
        mock = new MockClock();
        g = new GuardHarness();
        counter = new GuardedCounter(IMarketClock(address(mock)));
        status = new MarketClockStatus(IMarketClock(address(mock)));
    }

    function _set(IMarketClock.Regime r, uint128 cap, bool blackout, bool halted) internal {
        mock.set(w, r, cap);
        mock.setBlackout(w, blackout);
        mock.setHalted(w, halted);
    }

    function _shut(IMarketClock.Regime r) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MarketClockGuard.MarketShut.selector, w, r);
    }

    // --- requireArbitraged ----------------------------------------------------------------------

    function test_never_attested_is_shut_with_unknown() public {
        assertFalse(g.isArbitraged(IMarketClock(address(mock)), w));
        vm.expectRevert(_shut(IMarketClock.Regime.UNKNOWN));
        g.requireArbitraged(IMarketClock(address(mock)), w);
    }

    function test_closed_is_shut() public {
        _set(IMarketClock.Regime.CLOSED, 0, false, false);
        vm.expectRevert(_shut(IMarketClock.Regime.CLOSED));
        g.requireArbitraged(IMarketClock(address(mock)), w);
    }

    /// The issuer's cut: MARKET with a zero cap refuses, and the error says the label was MARKET.
    function test_open_label_zero_cap_is_shut_and_names_the_label() public {
        _set(IMarketClock.Regime.MARKET, 0, false, false);
        vm.expectRevert(_shut(IMarketClock.Regime.MARKET));
        g.requireArbitraged(IMarketClock(address(mock)), w);
        _set(IMarketClock.Regime.EXTENDED, 0, false, false);
        vm.expectRevert(_shut(IMarketClock.Regime.EXTENDED));
        g.requireArbitraged(IMarketClock(address(mock)), w);
    }

    function test_blackout_and_halt_are_shut() public {
        _set(IMarketClock.Regime.OVERNIGHT, CAP, true, false);
        vm.expectRevert(_shut(IMarketClock.Regime.OVERNIGHT));
        g.requireArbitraged(IMarketClock(address(mock)), w);
        _set(IMarketClock.Regime.MARKET, CAP, false, true);
        vm.expectRevert(_shut(IMarketClock.Regime.MARKET));
        g.requireArbitraged(IMarketClock(address(mock)), w);
    }

    function test_open_labels_with_cap_pass() public {
        IMarketClock.Regime[3] memory open =
            [IMarketClock.Regime.OVERNIGHT, IMarketClock.Regime.EXTENDED, IMarketClock.Regime.MARKET];
        for (uint256 i; i < 3; ++i) {
            _set(open[i], CAP, false, false);
            assertTrue(g.isArbitraged(IMarketClock(address(mock)), w));
            g.requireArbitraged(IMarketClock(address(mock)), w);
        }
    }

    /// The guard and the adapter are two implementations of one predicate. They must never disagree, and the
    /// guard must revert exactly when it says shut.
    function testFuzz_guard_agrees_with_adapter(uint8 r, uint128 cap, bool blackout, bool halted) public {
        IMarketClock.Regime reg = IMarketClock.Regime(bound(r, 0, uint8(IMarketClock.Regime.MARKET)));
        _set(reg, cap, blackout, halted);
        bool ok = g.isArbitraged(IMarketClock(address(mock)), w);
        uint32 s = status.marketStatus(w);
        assertEq(ok, s == 2 || s == 3 || s == 4, "guard vs marketStatus");
        assertEq(ok, status.isArbitraged(w), "guard vs adapter.isArbitraged");
        if (!ok) vm.expectRevert(_shut(reg));
        g.requireArbitraged(IMarketClock(address(mock)), w);
    }

    // --- requireNotBlackout ---------------------------------------------------------------------

    /// The blackout guard is independent of the regime: a shut market with no corporate action passes it.
    function test_requireNotBlackout_only_refuses_a_blackout() public {
        _set(IMarketClock.Regime.CLOSED, 0, false, false);
        g.requireNotBlackout(IMarketClock(address(mock)), w);
        _set(IMarketClock.Regime.MARKET, CAP, true, false);
        vm.expectRevert(abi.encodeWithSelector(MarketClockGuard.MultiplierBlackout.selector, w));
        g.requireNotBlackout(IMarketClock(address(mock)), w);
    }

    // --- the modifiers --------------------------------------------------------------------------

    function test_guarded_constructor_rejects_zero_clock() public {
        vm.expectRevert(MarketClockGuard.NoMarketClock.selector);
        new GuardedCounter(IMarketClock(address(0)));
    }

    function test_modifiers() public {
        assertEq(address(counter.marketClock()), address(mock));

        _set(IMarketClock.Regime.CLOSED, 0, false, false);
        vm.expectRevert(_shut(IMarketClock.Regime.CLOSED));
        counter.open(w);
        counter.settle(w); // shut, but no corporate action in flight
        assertEq(counter.settled(), 1);

        _set(IMarketClock.Regime.MARKET, CAP, false, false);
        counter.open(w);
        assertEq(counter.opened(), 1);

        _set(IMarketClock.Regime.MARKET, CAP, true, false);
        vm.expectRevert(_shut(IMarketClock.Regime.MARKET));
        counter.open(w);
        vm.expectRevert(abi.encodeWithSelector(MarketClockGuard.MultiplierBlackout.selector, w));
        counter.settle(w);
        assertEq(counter.opened(), 1);
        assertEq(counter.settled(), 1);
    }

    // --- the documentation example, at the address it names --------------------------------------

    function test_example_lending_guard() public {
        address at = MarketClockGuard.XLAYER_MARKET_CLOCK;
        assertEq(at, 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b);
        vm.etch(at, address(mock).code);
        MockClock live = MockClock(at);
        ExampleLendingGuard ex = new ExampleLendingGuard();
        assertEq(address(ex.marketClock()), at);

        live.set(w, IMarketClock.Regime.CLOSED, 0);
        vm.expectRevert(_shut(IMarketClock.Regime.CLOSED));
        ex.borrow(w, 1e6);
        vm.expectEmit(address(ex));
        emit ExampleLendingGuard.Deposited(address(this), w, 5e17);
        ex.deposit(w, 5e17); // collateral may be added while shut

        live.set(w, IMarketClock.Regime.MARKET, CAP);
        vm.expectEmit(address(ex));
        emit ExampleLendingGuard.Borrowed(address(this), w, 1e6);
        ex.borrow(w, 1e6);

        live.setBlackout(w, true);
        vm.expectRevert(abi.encodeWithSelector(MarketClockGuard.MultiplierBlackout.selector, w));
        ex.deposit(w, 5e17);
        vm.expectRevert(_shut(IMarketClock.Regime.MARKET));
        ex.borrow(w, 1e6);
    }

    // --- against the MarketClock that ships -------------------------------------------------------

    /// A dead attestor: the guard refuses with UNKNOWN once the last round is older than MAX_ATTESTATION_AGE.
    function test_real_clock_stale_attestation_refuses() public {
        NonceRaw raw = new NonceRaw();
        address[] memory a = new address[](1);
        a[0] = makeAddr("attestor");
        MarketClock clock = new MarketClock(address(this), a);
        clock.registerAsset(w, address(raw), bytes4("XHKG"), 2); // 2 = Regular
        GuardedCounter c = new GuardedCounter(IMarketClock(address(clock)));

        vm.prank(a[0]);
        clock.attest(w, IMarketClock.Regime.MARKET, CAP, 0, false, bytes32(0));
        c.open(w);
        assertEq(c.opened(), 1);

        vm.warp(T0 + clock.MAX_ATTESTATION_AGE() + 1);
        vm.expectRevert(_shut(IMarketClock.Regime.UNKNOWN));
        c.open(w);
    }
}
