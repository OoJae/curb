// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {CurbCredit} from "../../src/CurbCredit.sol";
import {MarketClock} from "../../src/MarketClock.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../../src/interfaces/IScorecardPrice.sol";
import {IDepthCert} from "../../src/interfaces/IDepthCert.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MulDiv} from "../../src/lib/MulDiv.sol";
import {MockDepthCert} from "../mocks/MockDepthCert.sol";
import {AllowList} from "../CurbCredit.t.sol";

/// @notice W4 on a mainnet fork: the deployed MarketClock (regime flipped by pranking host A's `attest`), the
///         deployed Scorecard v2 (live `priceNow` from the real wTCENTx/USDG pool), real USDG and real wTCENTx
///         (both funded by pranking the pool). Walks the W4 demo: deposit -> Refusal(NoDepth) -> a cert naming
///         CurbCredit -> ltvFor ~52% -> borrow -> the 07:55 cut takes LTV 60% -> 30% -> flagBreach -> the cure
///         clock freezes through the closure (and while the attestation is stale) and runs only when open.
/// @dev Depth comes from MockDepthCert on this fork until P3's DepthCert is merged; the property under test here
///      is CurbCredit against the live clock and price.
contract W4CreditForkTest is Test {
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;
    address constant SCORECARD = 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f;
    address constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;
    address constant POOL_TCENT = 0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f;
    address constant HOST_A = 0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4;
    address constant DEPLOYER = 0x78a5955b433988198bccA2E8bdC671444798f809;

    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant W_XIAO = 0x076CF393E701839FC7a5832D2c68AaFA235682AE;
    address constant W_MEIT = 0xad1b65C8556957cf23d1B5e9accdc449b415fA97;
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;

    CurbCredit credit;
    MockDepthCert dc;
    AllowList elig;
    address desk = makeAddr("curb-desk (K)"); // reserve funder, cert maker
    address agent = makeAddr("agentic (A)"); // borrower

    function setUp() public {
        vm.createSelectFork("xlayer");
        dc = new MockDepthCert(IERC20(USDG));
        elig = new AllowList();
        address[] memory five = new address[](5);
        five[0] = W_TCENT;
        five[1] = W_XIAO;
        five[2] = W_MEIT;
        five[3] = W_NVDA;
        five[4] = W_AAPL;
        credit = new CurbCredit(
            IMarketClock(CLOCK), IScorecardPrice(SCORECARD), IDepthCert(address(dc)), IEligibility(address(elig)),
            IERC20(USDG), DEPLOYER, five
        );
        elig.set(agent, true);

        // Fund from the pool, which holds both sides of wTCENTx/USDG.
        vm.startPrank(POOL_TCENT);
        IERC20(USDG).transfer(desk, 10e6);
        IERC20(W_TCENT).transfer(agent, 0.1e18);
        vm.stopPrank();

        vm.prank(desk);
        IERC20(USDG).approve(address(credit), type(uint256).max);
        vm.prank(desk);
        credit.fund(3e6); // "K fund 3 USDG"
        vm.startPrank(agent);
        IERC20(W_TCENT).approve(address(credit), type(uint256).max);
        IERC20(USDG).approve(address(credit), type(uint256).max);
        vm.stopPrank();
    }

    // --- helpers ---------------------------------------------------------------------------------------------

    function _attest(IMarketClock.Regime r, uint128 cap) internal {
        vm.prank(HOST_A);
        MarketClock(CLOCK).attest(W_TCENT, r, cap, uint64(block.timestamp + 1 hours), false, bytes32("w4-fork"));
    }

    function _openHk() internal {
        _attest(IMarketClock.Regime.MARKET, 20_000_000);
    }

    function _shutHk() internal {
        _attest(IMarketClock.Regime.CLOSED, 0);
    }

    /// @dev "K post(wTCENTx, credit, 0.028e18, 52e6, now+26h, 1e6)".
    function _postDemoCert() internal {
        dc.setDepth(W_TCENT, address(credit), 0.028e18, 52e6, uint64(block.timestamp + 26 hours));
    }

    function _p() internal view returns (uint256) {
        return IScorecardPrice(SCORECARD).priceNow(W_TCENT);
    }

    function _refusalReason(Vm.Log[] memory logs) internal pure returns (bytes4 reason, uint256 allowed) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == CurbCredit.Refusal.selector) {
                (, allowed) = abi.decode(logs[i].data, (uint256, uint256));
                return (bytes4(logs[i].topics[3]), allowed);
            }
        }
    }

    /// @dev deposit 0.05 -> Refusal(NoDepth) -> cert -> ltvFor ~52% -> borrow min(1.4 USDG, limit). Returns debt.
    function _demoBorrow() internal returns (uint256 borrowed) {
        _openHk();
        vm.prank(agent);
        credit.deposit(W_TCENT, 0.05e18);

        vm.recordLogs();
        vm.prank(agent);
        assertFalse(credit.borrow(W_TCENT, 1.4e6), "no cert, no credit");
        (bytes4 reason,) = _refusalReason(vm.getRecordedLogs());
        assertEq(reason, CurbCredit.NoDepth.selector);
        assertEq(credit.ltvFor(W_TCENT), 0);

        _postDemoCert();
        uint256 p = _p();
        uint256 expected = MulDiv.mulDiv(0.028e18 * 1e4, 52e6 * 1e12, 0.05e18 * p);
        if (expected > 6000) expected = 6000;
        uint256 ltv = credit.ltvFor(W_TCENT);
        console2.log("live wTCENTx priceNow (1e18):", p);
        console2.log("ltvFor open (bps):", ltv);
        assertEq(ltv, expected, "ltvFor = min(6000, covered/basis * minBid / P)");
        assertLe(ltv * MulDiv.mulDiv(0.05e18, p, 1e30), credit.realisable(W_TCENT) * 1e4 + 1e4);

        uint256 limit = credit.limitOf(agent, W_TCENT);
        borrowed = limit < 1.4e6 ? limit : 1.4e6;
        uint256 before = IERC20(USDG).balanceOf(agent);
        vm.prank(agent);
        assertTrue(credit.borrow(W_TCENT, borrowed), "borrow against the live price and an attested open market");
        assertEq(IERC20(USDG).balanceOf(agent), before + borrowed);
        assertLe(credit.totalPrincipal(W_TCENT), credit.realisable(W_TCENT));
    }

    // --- tests -----------------------------------------------------------------------------------------------

    function test_constructs_against_the_five_live_price_sources() public view {
        address[] memory list = credit.assets();
        assertEq(list.length, 5);
        for (uint256 i; i < list.length; ++i) {
            (address pool,,,,) = IScorecardPrice(SCORECARD).priceSources(list[i]);
            assertTrue(pool != address(0));
            assertEq(IERC20(list[i]).decimals(), 18);
        }
        assertEq(credit.admin(), DEPLOYER);
        assertEq(credit.reserve(), 3e6);
    }

    function test_borrow_against_live_price_and_attested_regime() public {
        uint256 borrowed = _demoBorrow();
        assertEq(credit.debtOf(agent, W_TCENT), borrowed);
        (bool known, bool breached) = credit.isBreached(agent, W_TCENT);
        assertTrue(known && !breached);
    }

    function test_stale_attestation_reads_unknown_and_refuses() public {
        _demoBorrow();
        vm.warp(block.timestamp + 31 minutes); // host A silent: MarketClock returns UNKNOWN
        assertEq(uint8(MarketClock(CLOCK).regime(W_TCENT)), uint8(IMarketClock.Regime.UNKNOWN));
        assertEq(credit.ltvFor(W_TCENT), 0);
        (bool known,) = credit.isBreached(agent, W_TCENT);
        assertFalse(known, "a stale clock neither creates nor cures a breach");
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(credit.borrow(W_TCENT, 1));
        (bytes4 reason,) = _refusalReason(vm.getRecordedLogs());
        assertEq(reason, CurbCredit.MarketUnknown.selector);
    }

    function test_regime_flip_breaches_60_to_30() public {
        // A bid at or above the live price, deep enough to cover the collateral: the regime cap binds (60%).
        _openHk();
        uint256 p = _p();
        uint128 bid = uint128(p / 1e12 + 1e6);
        dc.setDepth(W_TCENT, address(credit), 1e18, bid, uint64(block.timestamp + 26 hours));
        vm.prank(agent);
        credit.deposit(W_TCENT, 0.05e18);
        assertEq(credit.ltvFor(W_TCENT), 6000, "open: 60%");
        uint256 value = MulDiv.mulDiv(0.05e18, p, 1e30);
        uint256 amount = value * 55 / 100;
        vm.prank(agent);
        assertTrue(credit.borrow(W_TCENT, amount));

        _shutHk(); // the 07:55 cut
        assertEq(credit.ltvFor(W_TCENT), 3000, "shut: 30%");
        assertEq(credit.limitOf(agent, W_TCENT), value * 3000 / 1e4);
        (bool known, bool breached) = credit.isBreached(agent, W_TCENT);
        assertTrue(known && breached, "55% against a 30% cap");

        credit.flagBreach(agent, W_TCENT);
        CurbCredit.Cure memory c = credit.cureOf(agent, W_TCENT);
        assertTrue(c.active);
        assertFalse(c.lastOpen);
        assertEq(c.priceAtBreach, p);
    }

    function test_demo_cut_breaches_then_cure_clock_freezes_shut_and_runs_open() public {
        _demoBorrow();
        uint256 p0 = _p();

        // 07:55 cut: LTV 30%, the ~1.4 USDG loan is over its limit.
        _shutHk();
        assertEq(credit.ltvFor(W_TCENT), 3000);
        credit.flagBreach(agent, W_TCENT);

        // Closure: tick every 5 minutes for 2 hours, re-attesting CLOSED every 25 minutes as host A does.
        for (uint256 i = 1; i <= 24; ++i) {
            vm.warp(block.timestamp + 300);
            if (i % 5 == 0) _shutHk();
            credit.tick(agent, W_TCENT);
        }
        assertEq(credit.cureOf(agent, W_TCENT).openSecondsUsed, 0, "frozen while shut");
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.CureIncomplete.selector, 0, 1800));
        credit.liquidate(agent, W_TCENT); // two hours of wall-clock closure count for nothing

        // The attestation goes stale (> 30 min silence): UNKNOWN freezes it too.
        vm.warp(block.timestamp + 31 minutes);
        credit.tick(agent, W_TCENT);
        vm.warp(block.timestamp + 300);
        credit.tick(agent, W_TCENT);
        assertEq(credit.cureOf(agent, W_TCENT).openSecondsUsed, 0, "frozen while UNKNOWN");
        assertTrue(credit.cureOf(agent, W_TCENT).active, "a stale clock never cures");

        // The cert is re-posted at a lower bid before the reopen, so the loan stays over its limit when open.
        dc.setDepth(W_TCENT, address(credit), 0.028e18, 20e6, uint64(block.timestamp + 26 hours));

        // Reopen: the first open tick only witnesses; then every open 5-minute gap counts.
        _openHk();
        credit.tick(agent, W_TCENT);
        assertEq(credit.cureOf(agent, W_TCENT).openSecondsUsed, 0);
        for (uint256 i = 1; i <= 6; ++i) {
            vm.warp(block.timestamp + 300);
            if (i % 5 == 0) _openHk();
            credit.tick(agent, W_TCENT);
            assertEq(credit.cureOf(agent, W_TCENT).openSecondsUsed, i * 300, "runs when open");
        }
        (bool known, bool breached) = credit.isBreached(agent, W_TCENT);
        assertTrue(known && breached);

        // 30 witnessed open minutes: liquidation at the live price, bounded by the breach-time price.
        uint256 debt = credit.debtOf(agent, W_TCENT);
        uint256 pFresh = _p();
        uint256 stale = MulDiv.mulDiv(MulDiv.mulDiv(debt, 10_500, 1e4), 1e30, p0);
        credit.liquidate(agent, W_TCENT);
        uint256 seized = credit.seized(W_TCENT);
        assertGt(seized, 0);
        assertLe(seized, stale);
        assertLe(seized, MulDiv.mulDiv(debt, 1e30, pFresh));
        assertEq(credit.debtOf(agent, W_TCENT), 0);
        assertEq(
            IERC20(W_TCENT).balanceOf(address(credit)), credit.totalCollateral(W_TCENT) + credit.seized(W_TCENT)
        );
        console2.log("seized (wTCENTx wei):", seized);
        console2.log("debt cleared (USDG units):", debt - credit.badDebt(W_TCENT));
    }
}
