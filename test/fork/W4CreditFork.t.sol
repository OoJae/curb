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
import {DepthCert} from "../../src/DepthCert.sol";
import {AllowList} from "../CurbCredit.t.sol";

/// @notice W4 on a mainnet fork: the deployed MarketClock (regime flipped by pranking host A's `attest`), the
///         deployed Scorecard v2 (live `priceNow` from the real wTCENTx/USDG pool), real USDG and real wTCENTx
///         (both funded by pranking the pool). Walks the W4 demo: deposit -> Refusal(NoDepth) -> K's cert naming
///         CurbCredit (expiry Fri 2 Oct 06:00Z, so it outlives the weekend horizon) -> ltvFor 60% per position,
///         with the book's 1.456 USDG bounding the total -> borrow 1.4 -> the cut takes LTV 60% -> 30% ->
///         flagBreach -> the cure clock freezes through the closure (and while the attestation is stale) and runs
///         only when open -> liquidation at the live price -> the seized shares realised into K's real cert; the
///         fade is shown with a SEPARATE maker (D) whose cert names A, so A takes it and K's depth is untouched.
/// @dev Wired as DeployW4 wires it: DepthCert's `makers` is its own allowlist (K and D only), CurbCredit's
///      borrower registry is separate (A). K and D post bonded certs with real USDG; their allowance/balance are
///      what make them count.
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

    /// @dev K's demo cert expiry: Fri 2 Oct 2026 06:00Z (spec amendment). It outlives the shut horizon
    ///      (now + 73 h + 30 min) until Mon 28 Sep 04:30Z, past Monday's reopen; on a later fork the test uses
    ///      now + 110 h instead.
    uint64 constant DEMO_EXPIRY = 1790920800;

    CurbCredit credit;
    DepthCert dc;
    AllowList elig; // borrowers (W3 EligibilityRegistry stand-in)
    AllowList makers; // DepthCert makers (DeployW4's second registry: K and D only)
    address desk = makeAddr("curb-desk (K)"); // reserve funder, cert maker
    address agent = makeAddr("agentic (A)"); // borrower
    address fadeMaker = DEPLOYER; // D: the fade demo's maker, never K

    function setUp() public {
        vm.createSelectFork("xlayer");
        elig = new AllowList();
        makers = new AllowList();
        dc = new DepthCert(IERC20(USDG), IEligibility(address(makers)));
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
        elig.set(agent, true); // A borrows
        makers.set(desk, true); // K posts the certs naming CurbCredit
        makers.set(fadeMaker, true); // D posts the fade cert (naming A)

        // Fund from the pool, which holds both sides of wTCENTx/USDG.
        vm.startPrank(POOL_TCENT);
        IERC20(USDG).transfer(desk, 150e6);
        IERC20(USDG).transfer(fadeMaker, 5e6);
        IERC20(W_TCENT).transfer(agent, 0.1e18);
        vm.stopPrank();

        vm.prank(desk);
        IERC20(USDG).approve(address(credit), type(uint256).max);
        vm.prank(desk);
        credit.fund(3e6); // "K fund 3 USDG"
        vm.prank(desk);
        IERC20(USDG).approve(address(dc), type(uint256).max);
        vm.startPrank(agent);
        IERC20(W_TCENT).approve(address(credit), type(uint256).max);
        IERC20(USDG).approve(address(credit), type(uint256).max);
        vm.stopPrank();
    }

    // --- helpers ---------------------------------------------------------------------------------------------

    function _attest(IMarketClock.Regime r, uint128 cap, uint64 nextIn) internal {
        vm.prank(HOST_A);
        MarketClock(CLOCK).attest(W_TCENT, r, cap, uint64(block.timestamp) + nextIn, false, bytes32("w4-fork"));
    }

    /// @dev Open with the next transition 3 h away (a morning session), as host A publishes it.
    function _openHk() internal {
        _attest(IMarketClock.Regime.MARKET, 20_000_000, 3 hours);
    }

    /// @dev Shut overnight: the next transition (pre-open) 17 h away.
    function _shutHk() internal {
        _attest(IMarketClock.Regime.CLOSED, 0, 17 hours);
    }

    function _post(uint128 size, uint128 bid, uint64 life, uint128 bond) internal returns (uint256 id) {
        vm.prank(desk);
        id = dc.post(W_TCENT, address(credit), size, bid, uint64(block.timestamp) + life, bond);
    }

    function _demoExpiry() internal view returns (uint64) {
        uint64 floor_ = uint64(block.timestamp + 110 hours);
        return DEMO_EXPIRY > floor_ ? DEMO_EXPIRY : floor_;
    }

    /// @dev "K post(wTCENTx, credit, 0.028e18, 52e6, Tue 29 Sep 06:00Z, 1e6)".
    function _postDemoCert() internal returns (uint256 id) {
        vm.prank(desk);
        id = dc.post(W_TCENT, address(credit), 0.028e18, 52e6, _demoExpiry(), 1e6);
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

    /// @dev deposit 0.05 -> Refusal(NoDepth) -> cert -> ltvFor 60% -> 1.5 refused (ExceedsDepth: the book pays
    ///      1.456) -> borrow 1.4. Returns the amount borrowed and K's cert id.
    function _demoBorrow() internal returns (uint256 borrowed) {
        (borrowed,) = _demoBorrowWithCert();
    }

    function _demoBorrowWithCert() internal returns (uint256 borrowed, uint256 certId) {
        _openHk();
        vm.prank(agent);
        credit.deposit(W_TCENT, 0.05e18);

        vm.recordLogs();
        vm.prank(agent);
        assertFalse(credit.borrow(W_TCENT, 1.4e6), "no cert, no credit");
        (bytes4 reason,) = _refusalReason(vm.getRecordedLogs());
        assertEq(reason, CurbCredit.NoDepth.selector);
        assertEq(credit.ltvFor(W_TCENT), 0);

        certId = _postDemoCert();
        uint256 p = _p();
        uint256 expected = MulDiv.mulDiv(52e6 * 1e12, 1e4, p);
        if (expected > 6000) expected = 6000;
        uint256 ltv = credit.ltvFor(W_TCENT);
        console2.log("live wTCENTx priceNow (1e18):", p);
        console2.log("ltvFor open (bps):", ltv);
        assertEq(ltv, expected, "ltvFor = min(6000, minBid / P)");
        assertEq(credit.realisable(W_TCENT), MulDiv.mulDiv(0.028e18, 52e6, 1e18), "the book pays 1.456 USDG");
        uint256 limit = credit.limitOf(agent, W_TCENT);
        assertLe(limit, MulDiv.mulDiv(0.05e18, 52e6, 1e18), "limit payable by the bid for her collateral");

        // Her 60% limit (~1.68) exceeds what the 0.028-share book would pay in total: the book binds.
        if (limit > credit.realisable(W_TCENT)) {
            vm.recordLogs();
            vm.prank(agent);
            assertFalse(credit.borrow(W_TCENT, 1.5e6));
            (reason,) = _refusalReason(vm.getRecordedLogs());
            assertEq(reason, CurbCredit.ExceedsDepth.selector);
        }

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
        _post(1e18, bid, 110 hours, uint128(uint256(bid) / 10 + 1));
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

    /// A cert fine for open-market lending (26 h) stops supporting the loan the moment the market shuts: while
    /// shut, only certs that outlive the next reopen plus a full cure count.
    /// Only DeployW4's maker allowlist may post certs naming CurbCredit: a borrower cannot seed a dust bid.
    function test_borrower_cannot_post_a_cert_naming_credit() public {
        vm.startPrank(agent);
        IERC20(USDG).approve(address(dc), type(uint256).max);
        vm.expectRevert(DepthCert.IneligibleMaker.selector);
        dc.post(W_TCENT, address(credit), 1e18, 1e6, uint64(block.timestamp + 5 days), 0.1e6);
        vm.stopPrank();
    }

    /// Open, but the close is 30 min away: a 26 h cert cannot see the reopen plus a cure, K's Friday cert can.
    function test_imminent_close_needs_cert_to_outlive_the_closure() public {
        _attest(IMarketClock.Regime.MARKET, 20_000_000, 30 minutes);
        _post(0.028e18, 52e6, 26 hours, 1e6);
        assertEq(credit.ltvFor(W_TCENT), 0, "open, but about to shut: 26 h is not enough");
        assertEq(credit.minCertExpiry(W_TCENT), block.timestamp + 30 minutes + 73 hours + 30 minutes);
        _postDemoCert();
        assertEq(credit.ltvFor(W_TCENT), 6000);
    }

    function test_short_cert_does_not_count_while_shut() public {
        _openHk();
        vm.prank(agent);
        credit.deposit(W_TCENT, 0.05e18);
        _post(0.028e18, 52e6, 26 hours, 1e6);
        assertEq(credit.ltvFor(W_TCENT), 6000);
        _shutHk();
        assertEq(credit.ltvFor(W_TCENT), 0, "26 h cannot cover a weekend closure and a cure");
        assertEq(credit.minCertExpiry(W_TCENT), block.timestamp + 73 hours + 30 minutes);
        _postDemoCert();
        assertEq(credit.ltvFor(W_TCENT), 3000, "the Tuesday cert does");
    }

    function test_demo_cut_breaches_then_cure_clock_freezes_shut_and_runs_open() public {
        (, uint256 certId) = _demoBorrowWithCert();
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

        // Bids fall before the reopen: the desk adds a cert at 20 USDG a share (1.2 USDG notional), which becomes
        // the book's minimum bid, so the loan stays over its limit even when the market is open.
        _post(0.06e18, 20e6, 110 hours, 0.12e6);

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
        assertLe(seized, MulDiv.mulDiv(debt, 1e30, pFresh) + 1);
        assertEq(credit.debtOf(agent, W_TCENT), 0, "fresh leg bound: the debt cleared exactly");
        assertEq(credit.badDebt(W_TCENT), 0);
        assertGt(credit.positionOf(agent, W_TCENT).collateral, 0, "she keeps the rest");
        assertEq(
            IERC20(W_TCENT).balanceOf(address(credit)), credit.totalCollateral(W_TCENT) + credit.seized(W_TCENT)
        );
        console2.log("seized (wTCENTx wei):", seized);
        console2.log("debt cleared (USDG units):", debt - credit.badDebt(W_TCENT));

        // The admin realises the seized shares into the desk's 52-USDG cert, with real USDG moving.
        uint256 r = credit.reserve();
        uint256 cost = MulDiv.mulDiv(seized, 52e6, 1e18);
        vm.prank(DEPLOYER);
        credit.realise(certId, seized);
        assertEq(credit.seized(W_TCENT), 0);
        assertEq(credit.reserve(), r + cost, "fill proceeds join the reserve");
        assertEq(dc.claimableShares(desk, W_TCENT), seized, "the desk bought the seized shares");
        assertEq(IERC20(USDG).balanceOf(address(credit)), credit.reserve());
        console2.log("realised (USDG units):", cost);
    }

    /// The fade is shown with a separate maker (D), never K, and D's cert names A so A can take it.
    function test_fade_demo_D_cert_named_to_A() public {
        (, uint256 kCert) = _demoBorrowWithCert();

        vm.startPrank(fadeMaker);
        IERC20(USDG).approve(address(dc), type(uint256).max);
        uint256 dCert = dc.post(W_TCENT, agent, 0.03e18, 52e6, uint64(block.timestamp + 26 hours), 0.2e6);
        IERC20(USDG).approve(address(dc), 0); // D walks away from the bid
        vm.stopPrank();
        assertFalse(dc.isHonourable(fadeMaker));
        assertTrue(dc.isHonourable(desk), "K's depth is untouched");

        uint256 before = IERC20(USDG).balanceOf(agent);
        uint256 sharesBefore = IERC20(W_TCENT).balanceOf(agent);
        vm.startPrank(agent);
        IERC20(W_TCENT).approve(address(dc), 0.03e18);
        (bool filled, uint256 amount) = dc.take(dCert, 0.03e18, agent);
        vm.stopPrank();
        assertFalse(filled, "faded");
        assertEq(amount, 0.2e6);
        assertEq(IERC20(USDG).balanceOf(agent), before + 0.2e6, "D's whole bond to A");
        assertEq(IERC20(W_TCENT).balanceOf(agent), sharesBefore, "A keeps her shares");
        assertEq(uint8(dc.certOf(dCert).status), uint8(IDepthCert.Status.FADED));
        assertEq(uint8(dc.certOf(kCert).status), uint8(IDepthCert.Status.LIVE), "K's cert still live");
        assertEq(credit.ltvFor(W_TCENT), 6000, "and CurbCredit still prices off it");
    }

    /// The admin's `realise` fades too when the maker of a cert naming CurbCredit walks away (D, not K).
    function test_realise_fade_on_live_usdg_with_a_separate_maker() public {
        (, uint256 kCert) = _demoBorrowWithCert();
        _shutHk();
        credit.flagBreach(agent, W_TCENT);
        _post(0.06e18, 20e6, 110 hours, 0.12e6);
        _openHk();
        credit.tick(agent, W_TCENT);
        for (uint256 i = 1; i <= 6; ++i) {
            vm.warp(block.timestamp + 300);
            credit.tick(agent, W_TCENT);
        }
        credit.liquidate(agent, W_TCENT);
        uint256 seized = credit.seized(W_TCENT);

        vm.startPrank(fadeMaker);
        IERC20(USDG).approve(address(dc), type(uint256).max);
        uint256 dCert = dc.post(W_TCENT, address(credit), 0.03e18, 52e6, uint64(block.timestamp + 26 hours), 0.2e6);
        IERC20(USDG).approve(address(dc), 0);
        vm.stopPrank();

        uint256 r = credit.reserve();
        vm.prank(DEPLOYER);
        credit.realise(dCert, seized);
        assertEq(credit.seized(W_TCENT), seized, "shares came back");
        assertEq(credit.reserve(), r + 0.2e6, "D's whole bond");
        assertEq(uint8(dc.certOf(dCert).status), uint8(IDepthCert.Status.FADED));
        assertEq(uint8(dc.certOf(kCert).status), uint8(IDepthCert.Status.LIVE), "K's cert still live");
    }
}
