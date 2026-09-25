// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketClock} from "../src/MarketClock.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {MarketClockStatus} from "../src/adapters/MarketClockStatus.sol";
import {MockClock} from "./mocks/MockClock.sol";

/// A raw xStock whose corporate-action nonce can be moved, so the REAL MarketClock opens a real blackout.
contract NonceRaw {
    uint256 public nonce;
    function bump() external { ++nonce; }
    function getCurrentMultiplier() external view returns (uint256, uint256, uint256) {
        return (1e18, 0, nonce);
    }
}

/// MarketClockStatus against MockClock (every regime x cap x blackout x halt combination) and against the real
/// MarketClock (staleness, a nonce-driven blackout, a halt), so fail-closed is shown on the contract that ships.
contract MarketClockStatusTest is Test {
    MockClock mock;
    MarketClockStatus status;
    address w = makeAddr("wTCENTx");
    address w2 = makeAddr("wNVDAx");
    address w3 = makeAddr("wAAPLx");

    uint128 constant CAP = 200_000; // whole USD: wNVDAx's live overnight cap, 25 Sep 2026 00:56Z
    uint64 constant T0 = 1_790_297_648;

    uint32 constant UNKNOWN = 0;
    uint32 constant REGULAR = 2;
    uint32 constant POST = 3;
    uint32 constant OVERNIGHT = 4;
    uint32 constant CLOSED = 5;

    function setUp() public {
        vm.warp(T0);
        mock = new MockClock();
        status = new MarketClockStatus(IMarketClock(address(mock)));
    }

    function _set(address wrapper, IMarketClock.Regime r, uint128 cap, bool blackout, bool halted) internal {
        mock.set(wrapper, r, cap);
        mock.setBlackout(wrapper, blackout);
        mock.setHalted(wrapper, halted);
    }

    /// The table in the contract's NatSpec, written out independently of the implementation.
    function _spec(IMarketClock.Regime r, uint128 cap, bool blackout, bool halted) internal pure returns (uint32) {
        if (r == IMarketClock.Regime.UNKNOWN) return UNKNOWN;
        if (r == IMarketClock.Regime.CLOSED || cap == 0 || blackout || halted) return CLOSED;
        if (r == IMarketClock.Regime.MARKET) return REGULAR;
        if (r == IMarketClock.Regime.EXTENDED) return POST;
        return OVERNIGHT;
    }

    // --- wiring ---------------------------------------------------------------------------------

    function test_constructor_rejects_zero_clock() public {
        vm.expectRevert(MarketClockStatus.ZeroAddress.selector);
        new MarketClockStatus(IMarketClock(address(0)));
    }

    function test_wiring_and_code_table() public view {
        assertEq(address(status.clock()), address(mock));
        assertEq(status.STATUS_UNKNOWN(), 0);
        assertEq(status.STATUS_PRE_MARKET(), 1);
        assertEq(status.STATUS_REGULAR(), 2);
        assertEq(status.STATUS_POST_MARKET(), 3);
        assertEq(status.STATUS_OVERNIGHT(), 4);
        assertEq(status.STATUS_CLOSED(), 5);
    }

    // --- the mapping, case by case --------------------------------------------------------------

    function test_never_attested_is_unknown() public view {
        assertEq(status.marketStatus(w), UNKNOWN);
        assertFalse(status.isArbitraged(w));
    }

    /// UNKNOWN wins over everything else stored: a stale clock is "nobody is looking", not closed or open.
    function test_unknown_beats_stored_cap_blackout_and_halt() public {
        _set(w, IMarketClock.Regime.UNKNOWN, CAP, true, true);
        assertEq(status.marketStatus(w), UNKNOWN);
        assertFalse(status.isArbitraged(w));
    }

    function test_closed_is_5() public {
        _set(w, IMarketClock.Regime.CLOSED, 0, false, false);
        assertEq(status.marketStatus(w), CLOSED);
        assertFalse(status.isArbitraged(w));
    }

    /// A CLOSED label with a cap (never written by the live attestor) is still closed: the label says shut.
    function test_closed_label_with_cap_is_5() public {
        _set(w, IMarketClock.Regime.CLOSED, CAP, false, false);
        assertEq(status.marketStatus(w), CLOSED);
        assertFalse(status.isArbitraged(w));
    }

    function test_open_labels_with_cap() public {
        _set(w, IMarketClock.Regime.MARKET, CAP, false, false);
        _set(w2, IMarketClock.Regime.EXTENDED, CAP, false, false);
        _set(w3, IMarketClock.Regime.OVERNIGHT, CAP, false, false);
        assertEq(status.marketStatus(w), REGULAR);
        assertEq(status.marketStatus(w2), POST, "EXTENDED is 3: MarketClock does not split pre from post");
        assertEq(status.marketStatus(w3), OVERNIGHT);
        assertTrue(status.isArbitraged(w) && status.isArbitraged(w2) && status.isArbitraged(w3));
    }

    /// The issuer's cut: an open label with no capacity is closed economically, for every open label.
    function test_open_labels_with_zero_cap_are_5() public {
        _set(w, IMarketClock.Regime.MARKET, 0, false, false);
        _set(w2, IMarketClock.Regime.EXTENDED, 0, false, false);
        _set(w3, IMarketClock.Regime.OVERNIGHT, 0, false, false);
        assertEq(status.marketStatus(w), CLOSED);
        assertEq(status.marketStatus(w2), CLOSED);
        assertEq(status.marketStatus(w3), CLOSED);
        assertFalse(status.isArbitraged(w) || status.isArbitraged(w2) || status.isArbitraged(w3));
    }

    function test_blackout_closes_every_open_label() public {
        _set(w, IMarketClock.Regime.MARKET, CAP, true, false);
        _set(w2, IMarketClock.Regime.EXTENDED, CAP, true, false);
        _set(w3, IMarketClock.Regime.OVERNIGHT, CAP, true, false);
        assertEq(status.marketStatus(w), CLOSED);
        assertEq(status.marketStatus(w2), CLOSED);
        assertEq(status.marketStatus(w3), CLOSED);
        assertFalse(status.isArbitraged(w) || status.isArbitraged(w2) || status.isArbitraged(w3));
    }

    function test_halt_closes_every_open_label() public {
        _set(w, IMarketClock.Regime.MARKET, CAP, false, true);
        _set(w2, IMarketClock.Regime.EXTENDED, CAP, false, true);
        _set(w3, IMarketClock.Regime.OVERNIGHT, CAP, false, true);
        assertEq(status.marketStatus(w), CLOSED);
        assertEq(status.marketStatus(w2), CLOSED);
        assertEq(status.marketStatus(w3), CLOSED);
        assertFalse(status.isArbitraged(w) || status.isArbitraged(w2) || status.isArbitraged(w3));
    }

    /// Every one of the 5 regimes x 2 cap classes x 2 blackout x 2 halt = 40 combinations against the table.
    function test_every_combination_matches_the_table() public {
        uint128[2] memory caps = [uint128(0), CAP];
        for (uint8 r; r <= uint8(IMarketClock.Regime.MARKET); ++r) {
            for (uint256 c; c < 2; ++c) {
                for (uint256 b; b < 2; ++b) {
                    for (uint256 h; h < 2; ++h) {
                        IMarketClock.Regime reg = IMarketClock.Regime(r);
                        _set(w, reg, caps[c], b == 1, h == 1);
                        uint32 want = _spec(reg, caps[c], b == 1, h == 1);
                        assertEq(status.marketStatus(w), want, "table");
                        assertEq(status.isArbitraged(w), want == REGULAR || want == POST || want == OVERNIGHT, "arb");
                    }
                }
            }
        }
    }

    /// Whatever MarketClock holds: the answer is in {0,2,3,4,5}, never 1, and isArbitraged is exactly {2,3,4}.
    function testFuzz_codes_and_arbitrage(uint8 r, uint128 cap, bool blackout, bool halted) public {
        IMarketClock.Regime reg = IMarketClock.Regime(bound(r, 0, uint8(IMarketClock.Regime.MARKET)));
        _set(w, reg, cap, blackout, halted);
        uint32 s = status.marketStatus(w);
        assertEq(s, _spec(reg, cap, blackout, halted));
        assertTrue(s != 1 && s <= 5, "v11 code, never pre-market");
        assertEq(status.isArbitraged(w), s == REGULAR || s == POST || s == OVERNIGHT);
        // On every state the live attestor writes (CLOSED <=> cap 0, halt written as CLOSED), isArbitraged is
        // exactly primaryCapNow > 0 && !blackout.
        bool writerShape = (reg == IMarketClock.Regime.CLOSED) == (cap == 0) && !(halted && cap > 0);
        if (reg != IMarketClock.Regime.UNKNOWN && writerShape) {
            assertEq(status.isArbitraged(w), mock.primaryCapNow(w) > 0 && !mock.isInMultiplierBlackout(w));
        }
    }

    // --- batch and passthrough ------------------------------------------------------------------

    function test_statusMany_matches_single_reads_in_order() public {
        _set(w, IMarketClock.Regime.CLOSED, 0, false, false);
        _set(w2, IMarketClock.Regime.OVERNIGHT, CAP, false, false);
        _set(w3, IMarketClock.Regime.MARKET, CAP, true, false);
        address[] memory ws = new address[](4);
        (ws[0], ws[1], ws[2], ws[3]) = (w, w2, w3, makeAddr("never attested"));
        uint32[] memory got = status.statusMany(ws);
        assertEq(got.length, 4);
        assertEq(got[0], CLOSED);
        assertEq(got[1], OVERNIGHT);
        assertEq(got[2], CLOSED);
        assertEq(got[3], UNKNOWN);
        for (uint256 i; i < ws.length; ++i) assertEq(got[i], status.marketStatus(ws[i]));
        assertEq(status.statusMany(new address[](0)).length, 0);
    }

    function test_secondsToNextTransition_is_a_passthrough() public {
        assertEq(status.secondsToNextTransition(w), 0, "unset");
        mock.setNextTransition(w, T0 + 352);
        assertEq(status.secondsToNextTransition(w), 352);
        vm.warp(T0 + 352);
        assertEq(status.secondsToNextTransition(w), 0, "passed");
        assertEq(status.secondsToNextTransition(w), mock.secondsToNextTransition(w));
    }
}

/// The same adapter over the MarketClock that ships, so fail-closed is proven on its real staleness and
/// blackout logic rather than on a mock's.
contract MarketClockStatusRealClockTest is Test {
    MarketClock clock;
    MarketClockStatus status;
    NonceRaw raw;
    address attestor = makeAddr("attestor");
    address w = makeAddr("wAAPLx");

    uint128 constant CAP = 200_000;
    uint64 constant T0 = 1_790_297_648;

    function setUp() public {
        vm.warp(T0);
        raw = new NonceRaw();
        address[] memory a = new address[](1);
        a[0] = attestor;
        clock = new MarketClock(address(this), a);
        clock.registerAsset(w, address(raw), bytes4("XNAS"), 1); // 1 = TwentyFourFive
        status = new MarketClockStatus(IMarketClock(address(clock)));
    }

    function _attest(IMarketClock.Regime r, uint128 cap, bool halted) internal {
        vm.prank(attestor);
        clock.attest(w, r, cap, uint64(block.timestamp + 1 hours), halted, bytes32(0));
    }

    function test_unregistered_address_is_unknown() public {
        assertEq(status.marketStatus(makeAddr("not listed")), 0);
        assertEq(status.marketStatus(w), 0, "registered, never attested");
    }

    /// A dead attestor: stateOf still holds the last cap, but the adapter reads regime()/primaryCapNow().
    function test_stale_attestation_fails_closed_to_unknown() public {
        _attest(IMarketClock.Regime.MARKET, CAP, false);
        assertEq(status.marketStatus(w), 2);
        vm.warp(T0 + clock.MAX_ATTESTATION_AGE());
        assertEq(status.marketStatus(w), 2, "still fresh at exactly MAX_ATTESTATION_AGE");
        vm.warp(T0 + clock.MAX_ATTESTATION_AGE() + 1);
        assertEq(clock.stateOf(w).primaryCapUsd, CAP, "stateOf still reports the last cap");
        assertEq(status.marketStatus(w), 0, "the adapter does not");
        assertFalse(status.isArbitraged(w));
    }

    function test_every_regime_through_the_real_clock() public {
        _attest(IMarketClock.Regime.CLOSED, 0, false);
        assertEq(status.marketStatus(w), 5);
        _attest(IMarketClock.Regime.OVERNIGHT, CAP, false);
        assertEq(status.marketStatus(w), 4);
        _attest(IMarketClock.Regime.EXTENDED, 0, false); // a derive/1-era write: open label, zero cap
        assertEq(status.marketStatus(w), 5);
        _attest(IMarketClock.Regime.EXTENDED, CAP, false);
        assertEq(status.marketStatus(w), 3);
        _attest(IMarketClock.Regime.MARKET, 0, false);
        assertEq(status.marketStatus(w), 5);
        _attest(IMarketClock.Regime.MARKET, CAP, false);
        assertEq(status.marketStatus(w), 2);
        _attest(IMarketClock.Regime.MARKET, CAP, true); // a writer that halts without zeroing the cap
        assertEq(status.marketStatus(w), 5);
        assertFalse(status.isArbitraged(w));
    }

    /// A corporate action observed between rounds opens BLACKOUT_WINDOW; the adapter says 5 until it passes.
    function test_nonce_blackout_reads_closed_then_expires() public {
        _attest(IMarketClock.Regime.MARKET, CAP, false);
        raw.bump();
        _attest(IMarketClock.Regime.MARKET, CAP, false);
        assertTrue(clock.isInMultiplierBlackout(w));
        assertEq(status.marketStatus(w), 5);
        assertFalse(status.isArbitraged(w));
        vm.warp(T0 + clock.BLACKOUT_WINDOW());
        assertFalse(clock.isInMultiplierBlackout(w));
        assertEq(status.marketStatus(w), 2);
        assertTrue(status.isArbitraged(w));
    }
}
