// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";
import {MarketClockStatus} from "../../src/adapters/MarketClockStatus.sol";

/// The parts of the deployed MarketClock that IMarketClock leaves out.
interface IClockRegistry {
    function registered(uint256 i) external view returns (address);
    function registeredCount() external view returns (uint256);
    function isAttestor(address a) external view returns (bool);
    function attest(address, IMarketClock.Regime, uint128, uint64, bool, bytes32) external;
}

/// MarketClockStatus over the MarketClock deployed on X Layer, at whatever the fork block is. Nothing here
/// depends on the time of day: each answer is checked against the live clock's own fail-closed reads.
contract MarketClockStatusForkTest is Test {
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;
    address constant HOST_A = 0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4;

    // registered(0..5), in registration order. The first four are Hong Kong (`Regular`, no overnight session).
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant W_SHEIN = 0xff637d2d435D6745Df3faf61272B1216e7e8b727;
    address constant W_XIAO = 0x076CF393E701839FC7a5832D2c68AaFA235682AE;
    address constant W_MEIT = 0xad1b65C8556957cf23d1B5e9accdc449b415fA97;
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;

    IMarketClock clock = IMarketClock(CLOCK);
    MarketClockStatus status;

    function setUp() public {
        vm.createSelectFork("xlayer");
        status = new MarketClockStatus(clock);
    }

    /// The code the adapter should give, from the live clock's regime()/primaryCapNow() and the two closers.
    function _expected(address w) internal view returns (uint32) {
        IMarketClock.Regime r = clock.regime(w);
        if (r == IMarketClock.Regime.UNKNOWN) return 0;
        if (r == IMarketClock.Regime.CLOSED || clock.primaryCapNow(w) == 0) return 5;
        if (clock.isInMultiplierBlackout(w) || clock.stateOf(w).halted) return 5;
        if (r == IMarketClock.Regime.MARKET) return 2;
        if (r == IMarketClock.Regime.EXTENDED) return 3;
        return 4;
    }

    function _log(string memory name, address w, uint32 s) internal view {
        console2.log(name, uint8(clock.regime(w)), uint256(clock.primaryCapNow(w)), uint256(s));
    }

    function test_wTCENTx_status_matches_the_live_clock() public view {
        IMarketClock.Regime r = clock.regime(W_TCENT);
        uint128 cap = clock.primaryCapNow(W_TCENT);
        bool blackout = clock.isInMultiplierBlackout(W_TCENT);
        uint32 s = status.marketStatus(W_TCENT);
        console2.log("fork block / timestamp:", block.number, block.timestamp);
        console2.log("wTCENTx regime / cap (USD) / marketStatus:", uint8(r), uint256(cap), uint256(s));

        assertEq(s, _expected(W_TCENT), "adapter vs live clock");
        // A Hong Kong name on the live clock: extended sessions carry a zero cap and are attested CLOSED,
        // and there is no overnight session, so only 0, 2 or 5 can appear.
        assertTrue(s == 0 || s == 2 || s == 5, "HK reads 0, 2 or 5");
        if (r == IMarketClock.Regime.UNKNOWN) assertEq(s, 0, "stale or never attested -> 0");
        if (cap == 0) assertTrue(s == 0 || s == 5, "no capacity is never open");
        assertEq(status.isArbitraged(W_TCENT), cap > 0 && !blackout && r != IMarketClock.Regime.CLOSED);
        assertEq(status.secondsToNextTransition(W_TCENT), clock.secondsToNextTransition(W_TCENT));
    }

    function test_every_registered_wrapper_reads_a_v11_code() public view {
        IClockRegistry reg = IClockRegistry(CLOCK);
        uint256 n = reg.registeredCount();
        assertGe(n, 6, "registered cohort");
        address[6] memory pinned = [W_TCENT, W_SHEIN, W_XIAO, W_MEIT, W_NVDA, W_AAPL];
        string[6] memory names = ["wTCENTx", "wSHEINx", "wXIAOx ", "wMEITx ", "wNVDAx ", "wAAPLx "];

        address[] memory ws = new address[](n);
        for (uint256 i; i < n; ++i) {
            ws[i] = reg.registered(i);
            if (i < 6) assertEq(ws[i], pinned[i], "registration order");
        }
        uint32[] memory got = status.statusMany(ws);
        assertEq(got.length, n);

        console2.log("wrapper  regime  cap(USD)  marketStatus");
        for (uint256 i; i < n; ++i) {
            address w = ws[i];
            uint32 s = got[i];
            if (i < 6) _log(names[i], w, s);
            assertTrue(s == 0 || s == 2 || s == 3 || s == 4 || s == 5, "a v11 code, never 1");
            assertEq(s, _expected(w), "adapter vs live clock");
            assertEq(s, status.marketStatus(w), "batch vs single");
            if (i < 4) assertTrue(s == 0 || s == 2 || s == 5, "HK reads 0, 2 or 5");

            // The shape the live attestor writes (derive/2 onwards), which the adapter's notes rely on:
            // CLOSED <=> cap 0, and a halt is written as CLOSED.
            IMarketClock.Regime r = clock.regime(w);
            if (r != IMarketClock.Regime.UNKNOWN) {
                assertEq(r == IMarketClock.Regime.CLOSED, clock.primaryCapNow(w) == 0, "writer: CLOSED <=> cap 0");
                if (clock.stateOf(w).halted) assertEq(uint8(r), uint8(IMarketClock.Regime.CLOSED), "writer: halt");
            }
        }
    }

    /// The deployed clock driven by host A's key (pranked) through the states a week brings: the adapter must
    /// follow every one, and fall to 0 when the attestor goes quiet.
    function test_adapter_follows_the_deployed_clock() public {
        IClockRegistry reg = IClockRegistry(CLOCK);
        assertTrue(reg.isAttestor(HOST_A), "host A attests");
        uint64 next = uint64(block.timestamp + 1 hours);

        vm.startPrank(HOST_A);
        reg.attest(W_TCENT, IMarketClock.Regime.MARKET, 20_000, next, false, bytes32("fork"));
        reg.attest(W_NVDA, IMarketClock.Regime.OVERNIGHT, 200_000, next, false, bytes32("fork"));
        vm.stopPrank();
        // A corporate action between the last live round and this one would open a real blackout; wait it out.
        if (clock.isInMultiplierBlackout(W_TCENT) || clock.isInMultiplierBlackout(W_NVDA)) {
            vm.warp(block.timestamp + 15 minutes);
            vm.startPrank(HOST_A);
            reg.attest(W_TCENT, IMarketClock.Regime.MARKET, 20_000, next, false, bytes32("fork"));
            reg.attest(W_NVDA, IMarketClock.Regime.OVERNIGHT, 200_000, next, false, bytes32("fork"));
            vm.stopPrank();
        }
        assertEq(status.marketStatus(W_TCENT), 2, "HK regular session");
        assertEq(status.marketStatus(W_NVDA), 4, "US overnight session");
        assertTrue(status.isArbitraged(W_TCENT) && status.isArbitraged(W_NVDA));

        vm.startPrank(HOST_A);
        reg.attest(W_TCENT, IMarketClock.Regime.CLOSED, 0, next, false, bytes32("fork")); // the 11:55 cut
        reg.attest(W_NVDA, IMarketClock.Regime.EXTENDED, 200_000, next, false, bytes32("fork"));
        vm.stopPrank();
        assertEq(status.marketStatus(W_TCENT), 5, "HK cut");
        assertEq(status.marketStatus(W_NVDA), 3, "US extended session");
        assertFalse(status.isArbitraged(W_TCENT));

        vm.warp(block.timestamp + 31 minutes);
        uint32[] memory got = status.statusMany(_two(W_TCENT, W_NVDA));
        assertEq(got[0], 0, "stale -> 0");
        assertEq(got[1], 0, "stale -> 0");
    }

    function _two(address a, address b) internal pure returns (address[] memory ws) {
        ws = new address[](2);
        (ws[0], ws[1]) = (a, b);
    }
}
