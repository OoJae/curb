// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CurbCredit} from "../../src/CurbCredit.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../../src/interfaces/IScorecardPrice.sol";
import {IDepthCert} from "../../src/interfaces/IDepthCert.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MulDiv} from "../../src/lib/MulDiv.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWrapper4626} from "../mocks/MockWrapper4626.sol";
import {MockClock} from "../mocks/MockClock.sol";
import {MockScorecardPrice} from "../mocks/MockScorecardPrice.sol";
import {MockDepthCert} from "../mocks/MockDepthCert.sol";
import {AllowList, ModeClock} from "../CurbCredit.t.sol";
import {CreditHandler, ISettableEligibility} from "./handlers/CreditHandler.sol";

/// @notice CreditInvariant (P4, W3W4 spec): under random positions, regime flips, price and depth moves, breach
///         flags, cure ticks, liquidations and realisation --
///           1. ltvFor <= regimeCap (6000 open, 3000 otherwise), and every position's limit is payable by the
///              honoured bid for its own collateral: limitOf <= notional(collateral, minBid) (+1 wei);
///           2. at every successful borrow, totalPrincipal <= realisable;
///           3. a seizure never exceeds the stale cap sharesFor(debt * 1.05, P_breach), and none happens while shut
///              (or before 1800 witnessed open seconds); bad debt is only ever booked when every share was seized,
///              and a partial liquidation takes exactly `cleared` off the debt;
///           7. no depositor action (deposit, withdraw) changes any other position's isBreached -- idle
///              collateral cannot push anyone into breach -- and no borrow/repay/liquidate on one position pushes
///              another known-healthy position into breach;
///           8. positions are judged by ltvEffective = ltvFor * min(1, notional(dS, minBid) / totalPrincipal):
///              never above ltvFor, and equal to it whenever the book covers everything lent;
///           4. the cure clock does not move across a tick with a shut/UNKNOWN end, and never over-counts;
///           5. conservation: wrapper balance = totalCollateral + seized; USDG balance = reserve;
///              sum of positions = totals;
///           6. a refused borrow/withdraw changes nothing.
/// forge-config: default.invariant.depth = 128
contract CreditInvariantTest is StdInvariant, Test {
    MockERC20 usdg;
    MockWrapper4626 wA;
    MockWrapper4626 wB;
    MockClock clock;
    MockScorecardPrice sc;
    MockDepthCert dc;
    AllowList elig;
    CurbCredit credit;
    CreditHandler public handler;
    address admin = makeAddr("admin");
    address[] actors;
    address[] assetList;

    function setUp() public {
        vm.warp(1_760_000_000);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        wA = new MockWrapper4626(address(0xA0), "Wrapped TCENTx", "wTCENTx");
        wB = new MockWrapper4626(address(0xB0), "Wrapped NVDAx", "wNVDAx");
        ModeClock modes = new ModeClock();
        clock = modes;
        sc = new MockScorecardPrice();
        dc = new MockDepthCert(IERC20(address(usdg)));
        elig = new AllowList();
        sc.setPrice(address(wA), 55e18);
        sc.setPrice(address(wB), 220e18);
        assetList.push(address(wA));
        assetList.push(address(wB));
        modes.setHoursMode(address(wA), 2); // wTCENTx-like: Regular (HKEX)
        modes.setHoursMode(address(wB), 1); // wNVDAx-like: TwentyFourFive

        credit = new CurbCredit(
            IMarketClock(address(clock)),
            IScorecardPrice(address(sc)),
            IDepthCert(address(dc)),
            IEligibility(address(elig)),
            IERC20(address(usdg)),
            admin,
            assetList
        );

        clock.set(address(wA), IMarketClock.Regime.MARKET, 20_000_000);
        clock.set(address(wB), IMarketClock.Regime.MARKET, 20_000_000);
        dc.setDepth(address(wA), address(credit), 150e18, 50e6, uint64(block.timestamp + 10 days));
        dc.setDepth(address(wB), address(credit), 40e18, 200e6, uint64(block.timestamp + 10 days));

        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        for (uint256 i; i < actors.length; ++i) {
            elig.set(actors[i], true);
            vm.startPrank(actors[i]);
            wA.approve(address(credit), type(uint256).max);
            wB.approve(address(credit), type(uint256).max);
            vm.stopPrank();
        }

        usdg.mint(address(this), 20_000e6);
        usdg.approve(address(credit), type(uint256).max);
        credit.fund(20_000e6);

        handler = new CreditHandler(
            credit, clock, sc, dc, usdg, admin, ISettableEligibility(address(elig)), assetList, actors
        );

        bytes4[] memory sel = new bytes4[](18);
        sel[0] = CreditHandler.deposit.selector;
        sel[1] = CreditHandler.withdraw.selector;
        sel[2] = CreditHandler.borrow.selector;
        sel[3] = CreditHandler.repay.selector;
        sel[4] = CreditHandler.fund.selector;
        sel[5] = CreditHandler.setRegime.selector;
        sel[6] = CreditHandler.setPrice.selector;
        sel[7] = CreditHandler.setDepth.selector;
        sel[8] = CreditHandler.warp.selector;
        sel[9] = CreditHandler.longWarp.selector;
        sel[10] = CreditHandler.flagBreach.selector;
        sel[11] = CreditHandler.tick.selector;
        sel[12] = CreditHandler.tickAll.selector;
        sel[13] = CreditHandler.liquidate.selector;
        sel[14] = CreditHandler.realise.selector;
        sel[15] = CreditHandler.keeperRun.selector;
        sel[16] = CreditHandler.defund.selector;
        sel[17] = CreditHandler.setEligible.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    // 1. the published per-position ratio: within the regime cap, and payable by the bid for each position
    function invariant_ltv_within_cap_and_bid() public view {
        for (uint256 i; i < assetList.length; ++i) {
            address a = assetList[i];
            uint256 ltv = credit.ltvFor(a);
            assertLe(ltv, credit.LTV_OPEN_BPS());
            if (!credit.isOpen(a)) assertLe(ltv, credit.LTV_SHUT_BPS(), "shut/UNKNOWN: at most 30%");
            (,, uint128 minBid,) = dc.honouredDepth(a, address(credit), credit.minCertExpiry(a));
            for (uint256 k; k < actors.length; ++k) {
                uint256 coll = credit.positionOf(actors[k], a).collateral;
                assertLe(credit.limitOf(actors[k], a), MulDiv.mulDiv(coll, minBid, 1e18) + 1, "limit > bid notional");
            }
        }
    }

    // 2. borrows never outrun the honoured bids
    function invariant_borrow_within_realisable() public view {
        assertEq(handler.borrowOverRealisable(), 0, "a borrow left totalPrincipal > realisable");
    }

    // 3. seizure bounded by the stale cap; never while shut or early
    function invariant_seizure_bounded_and_never_shut() public view {
        assertEq(handler.seizeOverStaleCap(), 0, "seized beyond sharesFor(debt*1.05, P_breach)");
        assertEq(handler.liquidatedWhileShut(), 0, "liquidated while shut/UNKNOWN");
        assertEq(handler.liquidatedEarly(), 0, "liquidated before 1800 witnessed open seconds");
        assertEq(handler.badDebtWithCollateralLeft(), 0, "bad debt booked while the borrower kept shares");
        assertEq(handler.debtForgiven(), 0, "a partial liquidation forgave debt");
    }

    // 7. positions are independent of other depositors; lending actions never push others into breach
    function invariant_no_cross_position_breach() public view {
        assertEq(handler.crossPositionBreachChange(), 0, "a deposit/withdraw moved another position's isBreached");
        assertEq(handler.crossPositionPushedIntoBreach(), 0, "a borrow/repay/liquidate pushed another into breach");
    }

    // 8. the effective ratio: a pro-rata margin call only when the book no longer covers what is lent
    function invariant_effective_ltv() public view {
        for (uint256 i; i < assetList.length; ++i) {
            address a = assetList[i];
            uint256 ltv = credit.ltvFor(a);
            uint256 eff = credit.ltvEffective(a);
            assertLe(eff, ltv, "ltvEffective > ltvFor");
            (uint256 dS,, uint128 minBid,) = dc.honouredDepth(a, address(credit), credit.minCertExpiry(a));
            uint256 cover = MulDiv.mulDiv(dS, minBid, 1e18);
            uint256 tp = credit.totalPrincipal(a);
            if (tp == 0 || cover >= tp) assertEq(eff, ltv, "scaled although the book covers everything lent");
            else assertEq(eff, MulDiv.mulDiv(ltv, cover, tp), "scaling is pro rata");
        }
    }

    // 4. the cure clock only counts witnessed open time
    function invariant_cure_clock_frozen_across_shut_ticks() public view {
        assertEq(handler.cureMovedAcrossShut(), 0, "cure clock moved across a shut tick");
        assertEq(handler.cureOverCounted(), 0, "cure clock over-counted a gap");
        address[] memory as_ = handler.assetsList();
        address[] memory ps = handler.actorsList();
        for (uint256 i; i < ps.length; ++i) {
            for (uint256 j; j < as_.length; ++j) {
                CurbCredit.Cure memory c = credit.cureOf(ps[i], as_[j]);
                if (!c.active) continue;
                assertLe(c.openSecondsUsed, block.timestamp - c.openedAt, "used <= wall time since the flag");
            }
        }
    }

    // 5. conservation
    function invariant_conservation() public view {
        assertEq(usdg.balanceOf(address(credit)), credit.reserve(), "USDG held = reserve");
        for (uint256 j; j < assetList.length; ++j) {
            address a = assetList[j];
            assertEq(
                IERC20(a).balanceOf(address(credit)),
                credit.totalCollateral(a) + credit.seized(a),
                "wrapper balance = totalCollateral + seized"
            );
            uint256 sumColl;
            uint256 sumPrincipal;
        // (USDG sent to the defund sink is outside the contract and outside `reserve`.)
            for (uint256 i; i < actors.length; ++i) {
                CurbCredit.Position memory p = credit.positionOf(actors[i], a);
                sumColl += p.collateral;
                sumPrincipal += p.principal;
            }
            assertEq(sumColl, credit.totalCollateral(a), "sum of collateral = totalCollateral");
            assertEq(sumPrincipal, credit.totalPrincipal(a), "sum of principal = totalPrincipal");
        }
    }

    // 6. refusals are side-effect free
    function invariant_refusal_changes_nothing() public view {
        assertEq(handler.refusalChangedState(), 0, "a refusal changed state");
    }

    /// @dev Per-run coverage. Set CREDIT_INV_LOG=<path under ./artifacts> to append one CSV line per run
    ///      (see `coverageHeader`); unset, nothing is written, so the merge gate has no side effects.
    function afterInvariant() public {
        string memory path = vm.envOr("CREDIT_INV_LOG", string(""));
        string memory line = coverageLine();
        if (bytes(path).length > 0) vm.writeLine(path, line);
        console2.log(coverageHeader());
        console2.log(line);
    }

    function coverageHeader() public pure returns (string memory) {
        return "borrowsOk,refusals,breaches,ticks,shutTicks,liquidations,partialLiquidations,scaledObserved,fills,fades,"
            "Ineligible,UnsupportedAsset,MarketUnknown,PriceUnavailable,NoDepth,ExceedsLtv,ExceedsDepth,"
            "ReserveShort,InCure,WouldBreach";
    }

    function coverageLine() public view returns (string memory) {
        string memory a = string.concat(
            vm.toString(handler.borrowsOk()), ",", vm.toString(handler.refusals()), ",",
            vm.toString(handler.breaches()), ",", vm.toString(handler.ticks()), ",",
            vm.toString(handler.shutTicks()), ",", vm.toString(handler.liquidations()), ",",
            vm.toString(handler.partialLiquidations()), ",", vm.toString(handler.scaledObserved()), ",",
            vm.toString(handler.realisedFills()), ",",
            vm.toString(handler.realisedFades())
        );
        bytes4[10] memory r = [
            CurbCredit.Ineligible.selector,
            CurbCredit.UnsupportedAsset.selector,
            CurbCredit.MarketUnknown.selector,
            CurbCredit.PriceUnavailable.selector,
            CurbCredit.NoDepth.selector,
            CurbCredit.ExceedsLtv.selector,
            CurbCredit.ExceedsDepth.selector,
            CurbCredit.ReserveShort.selector,
            CurbCredit.InCure.selector,
            CurbCredit.WouldBreach.selector
        ];
        for (uint256 i; i < r.length; ++i) a = string.concat(a, ",", vm.toString(handler.refusalsBy(r[i])));
        return a;
    }
}

/// @notice The handler reaches the states the invariants are about: a scripted walk through it (deterministic,
///         no fuzzer) must produce borrows, refusals, breaches, shut ticks, a liquidation and a realisation --
///         otherwise a green invariant run would prove nothing.
contract CreditHandlerCoverageTest is Test {
    CreditInvariantTest inv;

    /// @dev A borrow seed whose hashed share of the headroom lands in [lo, hi] bps (see CreditHandler.borrow).
    function _seedFor(uint256 lo, uint256 hi) internal pure returns (uint256 x) {
        for (;; ++x) {
            uint256 bps = uint256(keccak256(abi.encode(x))) % 11_000 + 1;
            if (bps >= lo && bps <= hi) return x;
        }
    }

    function test_handler_reaches_every_state() public {
        inv = new CreditInvariantTest();
        inv.setUp();
        CreditHandler h = inv.handler();
        h.deposit(0, 0, 50e18); // alice posts 50 wA at $55: limit 50 * 55 * 60% = 1650
        h.borrow(0, _seedFor(5_500, 6_060)); // 55-60.6% of the 1650 headroom (907..999.9): fine
        h.borrow(0, _seedFor(10_600, 11_000)); // > 105% of the remaining headroom: refused (ExceedsLtv)
        h.setRegime(0, 5); // CLOSED: limit 825 < 1000 -> breach
        h.flagBreach(0);
        h.tickAll();
        h.tickAll(); // shut ticks: frozen
        h.setPrice(0, 5_000, 1); // $27.50: 50 * 27.5 * 60% = 825 < 1000 even when open
        h.setRegime(0, 0); // open
        h.keeperRun(8); // first open tick only witnesses; then 7 x 300 s
        h.liquidate(0);
        h.realise(0, 5e18, 9_000, false);
        h.realise(0, 5e18, 9_000, true);
        assertGt(h.borrowsOk(), 0, "borrowed");
        assertGt(h.refusals(), 0, "refused");
        assertGt(h.breaches(), 0, "breached");
        assertGt(h.shutTicks(), 0, "ticked while shut");
        assertEq(h.liquidations(), 1, "liquidated");
        assertEq(h.realisedFills(), 1, "realised a fill");
        assertEq(h.realisedFades(), 1, "realised a fade");
        assertEq(h.cureMovedAcrossShut(), 0);
        assertEq(h.seizeOverStaleCap(), 0);
        assertEq(h.liquidatedWhileShut(), 0);
        assertEq(h.partialLiquidations(), 1, "the stale cap bound with shares left over");
        assertEq(h.badDebtWithCollateralLeft(), 0);
        assertEq(h.debtForgiven(), 0);
        inv.invariant_conservation();
        inv.invariant_ltv_within_cap_and_bid();
        inv.invariant_no_cross_position_breach();
        inv.invariant_effective_ltv();
    }
}
