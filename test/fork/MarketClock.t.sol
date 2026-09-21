// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {MarketClock} from "../../src/MarketClock.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";

interface IRaw {
    function multiplier() external view returns (uint256);
    function getCurrentMultiplier() external view returns (uint256, uint256, uint256);
    function symbol() external view returns (string memory);
}

interface IWrapper {
    function asset() external view returns (address);
    function convertToAssets(uint256) external view returns (uint256);
    function symbol() external view returns (string memory);
}

contract MarketClockForkTest is Test {
    // Hong Kong cohort -- `Regular` hours mode, no overnight session at all.
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant R_TCENT = 0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42;
    // US contrast panel -- `TwentyFourFive`.
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;
    address constant R_AAPL = 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a;

    bytes4 constant XHKG = bytes4("XHKG");
    bytes4 constant XNAS = bytes4("XNAS");

    MarketClock clock;
    address attestor = address(0xA11CE);

    function setUp() public {
        vm.createSelectFork("xlayer");
        address[] memory a = new address[](1);
        a[0] = attestor;
        clock = new MarketClock(address(this), a);
        clock.registerAsset(W_TCENT, R_TCENT, XHKG, 2); // 2 = Regular
        clock.registerAsset(W_AAPL, R_AAPL, XNAS, 1);   // 1 = TwentyFourFive
    }

    /// The conversion every integrator on this chain gets wrong.
    function test_rawToShares_matches_issuer_multiplier() public view {
        uint256 viaClock = clock.rawToShares(W_AAPL, 1e18);
        uint256 viaRaw = IRaw(R_AAPL).multiplier();
        (uint256 v,, uint256 nonce) = IRaw(R_AAPL).getCurrentMultiplier();
        console2.log("wAAPLx.convertToAssets(1e18):", viaClock);
        console2.log("AAPLx.multiplier()          :", viaRaw);
        console2.log("AAPLx nonce                 :", nonce);
        assertEq(viaClock, viaRaw, "wrapper rate must equal the raw multiplier");
        assertEq(viaClock, v, "getCurrentMultiplier value must agree too");
        assertGt(viaClock, 1e18, "AAPLx has paid dividends; rate must exceed 1.0");
        assertEq(IWrapper(W_AAPL).asset(), R_AAPL, "wrapper must wrap the raw token we registered");
    }

    /// Tencent has never paid through the multiplier, so its wrapper sits exactly at 1.0.
    /// This is the control that isolates the dividend effect above.
    function test_tencent_wrapper_is_unity() public view {
        assertEq(clock.rawToShares(W_TCENT, 1e18), 1e18);
        assertEq(IWrapper(W_TCENT).asset(), R_TCENT);
    }

    /// An unattested asset must read UNKNOWN and zero capacity, never "open".
    function test_fails_closed_before_any_attestation() public view {
        assertEq(uint8(clock.regime(W_TCENT)), uint8(IMarketClock.Regime.UNKNOWN));
        assertEq(clock.primaryCapNow(W_TCENT), 0);
    }

    /// The core assertion: a closed primary market reports zero capacity, and the 24/5
    /// control reports non-zero at the same instant. This is the whole demo, in one test.
    function test_closed_reports_zero_cap_while_control_is_open() public {
        vm.startPrank(attestor);
        clock.attest(W_TCENT, IMarketClock.Regime.CLOSED, 0, uint64(block.timestamp + 3600), false, bytes32("hk"));
        clock.attest(W_AAPL, IMarketClock.Regime.OVERNIGHT, 20_000_000, uint64(block.timestamp + 7200), false, bytes32("us"));
        vm.stopPrank();

        assertEq(clock.primaryCapNow(W_TCENT), 0, "HK name must show no primary capacity");
        assertEq(clock.primaryCapNow(W_AAPL), 20_000_000, "US overnight cap must survive");
        assertEq(uint8(clock.regime(W_TCENT)), uint8(IMarketClock.Regime.CLOSED));
        assertEq(uint8(clock.regime(W_AAPL)), uint8(IMarketClock.Regime.OVERNIGHT));
    }

    /// A dead attestor must not leave an asset looking open forever.
    function test_stale_attestation_degrades_to_unknown() public {
        vm.prank(attestor);
        clock.attest(W_AAPL, IMarketClock.Regime.MARKET, 100_000_000, 0, false, bytes32(0));
        assertEq(uint8(clock.regime(W_AAPL)), uint8(IMarketClock.Regime.MARKET));
        assertEq(clock.primaryCapNow(W_AAPL), 100_000_000);

        vm.warp(block.timestamp + 31 minutes);
        assertEq(uint8(clock.regime(W_AAPL)), uint8(IMarketClock.Regime.UNKNOWN), "must go stale");
        assertEq(clock.primaryCapNow(W_AAPL), 0, "stale must report zero capacity, not the last value");
    }

    /// Rebases emit no event, so the blackout is driven by an observed nonce change.
    function test_nonce_change_opens_blackout() public {
        vm.prank(attestor);
        clock.attest(W_AAPL, IMarketClock.Regime.MARKET, 1, 0, false, bytes32(0));
        assertFalse(clock.isInMultiplierBlackout(W_AAPL));

        // Simulate a corporate action landing between two attestation rounds.
        (uint256 v, uint256 p, uint256 n) = IRaw(R_AAPL).getCurrentMultiplier();
        vm.mockCall(
            R_AAPL,
            abi.encodeWithSelector(IRaw.getCurrentMultiplier.selector),
            abi.encode(v, p, n + 1)
        );
        vm.prank(attestor);
        clock.attest(W_AAPL, IMarketClock.Regime.MARKET, 1, 0, false, bytes32(0));

        assertTrue(clock.isInMultiplierBlackout(W_AAPL), "nonce move must open a blackout");
        vm.warp(block.timestamp + 16 minutes);
        assertFalse(clock.isInMultiplierBlackout(W_AAPL), "blackout must expire");
    }
}

/// Guards the class of bug that cost several build cycles: a hardcoded address that is
/// syntactically fine but semantically wrong. Every wrapper in the demo cohort must
/// actually wrap the raw token we register against it, verified on live mainnet.
contract WrapperPairingForkTest is Test {
    struct Pair { string name; address wrapper; address raw; }
    Pair[] pairs;

    function setUp() public {
        vm.createSelectFork("xlayer");
        pairs.push(Pair("wTCENTx", 0x41333Df9E7639188BBfca5522dC4844398Af9f9E, 0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42));
        pairs.push(Pair("wNVDAx", 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5, 0xc845b2894dBddd03858fd2D643B4eF725fE0849d));
        pairs.push(Pair("wAAPLx", 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f, 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a));
    }

    function test_every_wrapper_wraps_the_raw_token_we_claim() public view {
        for (uint i; i < pairs.length; ++i) {
            address got = IWrapper(pairs[i].wrapper).asset();
            assertEq(got, pairs[i].raw, pairs[i].name);
            // And the wrapper rate must equal the raw multiplier, to the wei.
            assertEq(
                IWrapper(pairs[i].wrapper).convertToAssets(1e18),
                IRaw(pairs[i].raw).multiplier(),
                "wrapper rate must equal raw multiplier"
            );
        }
    }
}
