// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Scorecard, IUniV3Pool} from "../../src/Scorecard.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";

/// Does Scorecard v2 read the REAL pool correctly?
///
/// The settlement price is now computed by the contract rather than supplied by whoever calls
/// `settle`, which only helps if the arithmetic survives contact with a live pool: a 6-decimal
/// stable against an 18-decimal wrapper, a tick near -236,000, and an oracle that must already
/// hold the window the guard asks for.
contract ScorecardPriceForkTest is Test {
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant POOL_TCENT = 0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f;
    address constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;

    Scorecard sc;

    function setUp() public {
        vm.createSelectFork("xlayer");
        sc = new Scorecard(IMarketClock(CLOCK), address(this));
    }

    function test_reads_the_live_tencent_pool() public {
        sc.setPriceSource(W_TCENT, POOL_TCENT, true, 120);

        (address t0, address t1) = (IUniV3Pool(POOL_TCENT).token0(), IUniV3Pool(POOL_TCENT).token1());
        assertEq(t0, W_TCENT, "wrapper is token0 in this pool");
        assertEq(t1, USDG);

        uint256 price = sc.priceNow(W_TCENT);
        console2.log("wTCENTx settlement price (1e18):", price);
        console2.log("  i.e. USD cents:", price / 1e16);

        // Tencent trades in the tens of dollars; this is the sanity band a wrong decimal or a
        // flipped orientation would blow through by orders of magnitude, not by basis points.
        assertGt(price, 10e18, "price implausibly low -- decimals or orientation wrong");
        assertLt(price, 200e18, "price implausibly high -- decimals or orientation wrong");
    }

    /// The guard is the whole reason the contract can be trusted to price itself.
    function test_the_twap_guard_is_live_on_the_real_pool() public {
        sc.setPriceSource(W_TCENT, POOL_TCENT, true, 120);

        (, int24 spotTick,,,,,) = IUniV3Pool(POOL_TCENT).slot0();
        uint32[] memory ago = new uint32[](2);
        ago[0] = 0;
        ago[1] = 300;
        (int56[] memory cum,) = IUniV3Pool(POOL_TCENT).observe(ago);
        int24 twapTick = int24((cum[0] - cum[1]) / int56(uint56(300)));

        console2.log("spot tick:");
        console2.logInt(spotTick);
        console2.log("5-minute average tick:");
        console2.logInt(twapTick);

        int24 dev = spotTick > twapTick ? spotTick - twapTick : twapTick - spotTick;
        assertLe(dev, sc.MAX_TICK_DEVIATION(), "live pool is inside the settlement tolerance");
    }

    /// A pool that does not hold the wrapper must be refused at registration, not at settlement.
    function test_registration_refuses_a_pool_for_the_wrong_asset() public {
        address someoneElse = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5; // wNVDAx
        vm.expectRevert(abi.encodeWithSelector(Scorecard.PoolMismatch.selector, someoneElse, POOL_TCENT));
        sc.setPriceSource(someoneElse, POOL_TCENT, true, 120);
    }
}
