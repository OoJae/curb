// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IUniV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function swap(address, bool, int256, uint160, bytes calldata)
        external returns (int256 amount0, int256 amount1);
}

/// W0 risk #3 -- the real slippage-versus-size curve for X Layer's wrapped-equity pools.
///
/// No Uniswap quoter is deployed on chain 196, so we do not estimate: we execute real
/// swaps against live mainnet pool state on a fork, which walks every tick exactly as
/// production would. Each size is run against a fresh snapshot of the same block.
///
/// Output sets (a) the ReopenNote notional cap per asset and (b) the DepthCert
/// 1%/3%/5% impact bands. The FILL RATIO is the headline: past a certain size the
/// order simply stops filling, which is the number that matters during a closure.
contract DepthProbeTest is Test {
    uint160 constant MIN_SQRT = 4295128740;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    struct Pool { string name; address addr; bool equityIsToken0; }

    address constant USDG  = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;
    address constant USDC  = 0xB6CEceAB302E2E4948951eE7843FC24E92933061;
    address constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;

    function _isStable(address t) internal pure returns (bool) {
        return t == USDG || t == USDC || t == USDT0;
    }
    Pool[] pools;

    function setUp() public {
        vm.createSelectFork("xlayer");
        pools.push(Pool("wTCENTx/USDG", 0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f, true));
        pools.push(Pool("wNVDAx/USDG", 0x2a2B11730C2b6d99a58034A869dd810D7300a7b2, true));
        pools.push(Pool("wAAPLx/USDG", 0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2, true));
        pools.push(Pool("wQQQx/USDC", 0x2Bd90724ffc80ba22Ec7Af8CFd2B4b51Ff395b04, true));
        pools.push(Pool("USDC/wTSLAx", 0x6A58944EEd3d2074E137Eb4e94b302FE4AF247a6, false));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        (address t0, address t1) = abi.decode(data, (address, address));
        if (a0 > 0) IERC20(t0).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(t1).transfer(msg.sender, uint256(a1));
    }

    struct Ctx { address t0; address t1; address eq; address num; uint8 dEq; uint8 dNum; uint256 eqPx; bool z4o; }

    function _ctx(uint p) internal view returns (Ctx memory c) {
        IUniV3Pool pool = IUniV3Pool(pools[p].addr);
        c.t0 = pool.token0();
        c.t1 = pool.token1();
        // The equity leg is whichever token is not the stable numeraire. Detecting this
        // at runtime rather than hardcoding it: three of these five pools list the stable
        // as token0, and getting it backwards silently measures the wrong side of the book.
        bool t0Stable = _isStable(c.t0);
        bool t1Stable = _isStable(c.t1);
        require(t0Stable != t1Stable, "pool: expected exactly one stable leg");
        c.z4o = !t0Stable; // sell the equity => zeroForOne iff equity is token0
        c.eq = c.z4o ? c.t0 : c.t1;
        c.num = c.z4o ? c.t1 : c.t0;
        c.dEq = IERC20(c.eq).decimals();
        c.dNum = IERC20(c.num).decimals();
        (uint160 sp,,,,,,) = pool.slot0();
        uint256 p1e18 = mulDiv(uint256(sp) * uint256(sp), 1e18 * 10 ** IERC20(c.t0).decimals(), 1 << 96)
            / (1 << 96) / 10 ** IERC20(c.t1).decimals();
        c.eqPx = c.z4o ? p1e18 : (1e36 / p1e18);
    }

    function _probe(uint p, Ctx memory c, uint256 usd) internal {
        IUniV3Pool pool = IUniV3Pool(pools[p].addr);
        uint256 want = mulDiv(usd * 1e18, 10 ** c.dEq, c.eqPx);
        uint256 snapId = vm.snapshotState();
        deal(c.eq, address(this), want);
        try pool.swap(
            address(this), c.z4o, int256(want),
            c.z4o ? MIN_SQRT + 1 : MAX_SQRT - 1, abi.encode(c.t0, c.t1)
        ) returns (int256 a0, int256 a1) {
            uint256 sold = c.z4o ? uint256(a0) : uint256(a1);
            uint256 got = c.z4o ? uint256(-a1) : uint256(-a0);
            console2.log("  size USD    :", usd);
            console2.log("    filled bps:", want == 0 ? 0 : sold * 10_000 / want);
            console2.log("    proceeds  :", got / 10 ** c.dNum);
            uint256 effPx = sold == 0 ? 0 : mulDiv(got, 1e18 * 10 ** c.dEq, sold * 10 ** c.dNum);
            console2.log("    impact bps:", c.eqPx > effPx ? (c.eqPx - effPx) * 10_000 / c.eqPx : 0);
        } catch {
            console2.log("  size USD    :", usd);
            console2.log("    REVERTED");
        }
        vm.revertToState(snapId);
    }

    function test_depth_curve() public {
        uint256[6] memory sizes = [uint256(1_000), 5_000, 10_000, 25_000, 50_000, 100_000];
        for (uint p = 0; p < pools.length; p++) {
            Ctx memory c = _ctx(p);
            console2.log("=====================================");
            console2.log("pool      :", pools[p].name);
            console2.log("equity px :", c.eqPx);
            console2.log("liquidity :", IUniV3Pool(pools[p].addr).liquidity());
            for (uint i = 0; i < sizes.length; i++) _probe(p, c, sizes[i]);
        }
    }

    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        unchecked { return (a / d) * b + ((a % d) * b) / d; }
    }
}
