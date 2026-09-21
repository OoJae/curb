// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Scorecard, IUniV3Pool} from "../src/Scorecard.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";

/// Redeploys Scorecard so the contract reads its own settlement price.
///
/// The first Scorecard (0x0527930187a879B3D8704a92734641679567EddD) let whoever called `settle`
/// supply the reopen price. Settlement is permissionless by design, so that let any passer-by
/// grade every row against an invented number, permanently. It never recorded a row, so replacing
/// it costs nothing but this transaction -- which is exactly why it is being done today rather
/// than after the record starts.
///
///   KEEPER=0x... forge script script/DeployScorecardV2.s.sol \
///     --rpc-url xlayer --account curb-deployer --sender 0x<deployer> --broadcast
contract DeployScorecardV2 is Script {
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;

    // Wrappers, and the pool each one's settlement price is read from. A wrapper with no pool gets
    // no price source, and `commit` then refuses it: better an asset with no rows than rows that
    // could never be settled honestly.
    //
    // Each pool is PINNED, not discovered. A full sweep of 6 wrappers x 3 stables x 4 fee tiers on
    // 21 Sep 2026 found 17 pools, of which 11 hold zero liquidity, one was never initialised, and
    // one -- wMEITx/USDG at the 1% tier -- quotes 6.1% away from the real book on a stale print with
    // no trades in 11 hours. Deriving the pool at runtime would happily pick it.
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant P_TCENT = 0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f; // wTCENTx/USDG  f500, card 32
    address constant W_XIAO  = 0x076CF393E701839FC7a5832D2c68AaFA235682AE;
    address constant P_XIAO  = 0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417; // wXIAOx/USDC   f500, card 32
    address constant W_MEIT  = 0xad1b65C8556957cf23d1B5e9accdc449b415fA97;
    address constant P_MEIT  = 0x54E89e9acaFb073e7fd8471312E753A661b470C7; // wMEITx/USDG   f500, card 32
    address constant W_NVDA  = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant P_NVDA  = 0x2a2B11730C2b6d99a58034A869dd810D7300a7b2; // wNVDAx/USDG   f500, card 256
    address constant W_AAPL  = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;
    address constant P_AAPL  = 0xc44bd9c8589026D28D1632d7b86b2Efb6cDc8fd2; // wAAPLx/USDG   f500, card 256

    // DELIBERATELY ABSENT: wSHEINx 0xff637d2d435D6745Df3faf61272B1216e7e8b727.
    // Its only live pool, 0xf1Ef85CE4691E94a32064B59e766C42183b44497, has observationCardinality 1.
    // Such a pool answers observe() successfully and returns SPOT -- the guard would be comparing
    // spot with itself. `setPriceSource` now refuses it outright. wSHEINx gets a price source once
    // someone raises that pool's cardinality and it has filled; until then it simply has no rows,
    // which is the honest outcome rather than a row nobody could check.

    /// Seconds averaged for the manipulation guard.
    ///
    /// It must be SHORTER than SETTLE_DELAY, and the contract enforces that, so the averaged window
    /// lies wholly after the reopen: at `settleAfter + 300` this covers reopen+180..reopen+300. An
    /// earlier design averaged the 5 minutes ENDING at settlement, which reached back across the
    /// reopen itself -- so a real overnight gap read as manipulation and the biggest, most
    /// interesting closures would have been the only ones that could never be settled.
    uint32 constant TWAP_WINDOW = 120;

    function run() external {
        address keeper = vm.envAddress("KEEPER");
        address deployer = msg.sender;
        require(deployer.balance > 0.001 ether, "deployer has no OKB for gas");

        vm.startBroadcast();

        Scorecard sc = new Scorecard(IMarketClock(CLOCK), deployer);
        sc.setKeeper(keeper, true);

        _register(sc, W_TCENT, P_TCENT, "wTCENTx");
        _register(sc, W_XIAO, P_XIAO, "wXIAOx");
        _register(sc, W_MEIT, P_MEIT, "wMEITx");
        _register(sc, W_NVDA, P_NVDA, "wNVDAx");
        _register(sc, W_AAPL, P_AAPL, "wAAPLx");

        vm.stopBroadcast();

        console2.log("Scorecard v2 :", address(sc));
        console2.log("keeper       :", keeper);
        console2.log("clock        :", CLOCK);
    }

    /// @dev Works out which side of the pool the wrapper sits on rather than trusting a constant:
    ///      three of the five live pools list the stable first, and a flipped flag silently prices
    ///      the wrong leg. `setPriceSource` re-checks this on chain and reverts if it disagrees.
    function _register(Scorecard sc, address wrapper, address pool, string memory label) internal {
        bool equityIsToken0 = IUniV3Pool(pool).token0() == wrapper;
        require(equityIsToken0 || IUniV3Pool(pool).token1() == wrapper, "pool does not hold this wrapper");
        sc.setPriceSource(wrapper, pool, equityIsToken0, TWAP_WINDOW);
        console2.log(label, "priced from", pool);
    }
}
