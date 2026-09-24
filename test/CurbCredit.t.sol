// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {CurbCredit} from "../src/CurbCredit.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../src/interfaces/IScorecardPrice.sol";
import {IDepthCert} from "../src/interfaces/IDepthCert.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MulDiv} from "../src/lib/MulDiv.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWrapper4626} from "./mocks/MockWrapper4626.sol";
import {MockClock} from "./mocks/MockClock.sol";
import {MockScorecardPrice} from "./mocks/MockScorecardPrice.sol";
import {MockDepthCert} from "./mocks/MockDepthCert.sol";

/// @notice Minimal settable allowlist standing in for EligibilityRegistry (P2) in CurbCredit tests.
contract AllowList is IEligibility {
    mapping(address => bool) public isEligible;

    function set(address who, bool ok) external {
        isEligible[who] = ok;
    }
}

/// @notice An 18-dp token that tries to re-enter CurbCredit from inside `transferFrom`.
contract ReentrantWrapper {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    CurbCredit public target;
    bool public attempted;
    bool public blocked;

    function arm(CurbCredit t) external {
        target = t;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (address(target) != address(0) && !attempted) {
            attempted = true;
            try target.fund(1) {}
            catch (bytes memory err) {
                blocked = err.length >= 4 && bytes4(err) == CurbCredit.Reentrancy.selector;
            }
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Shared world for the CurbCredit unit, suffix and integration tests.
abstract contract CreditBase is Test {
    uint128 constant P0 = 50e18; // $50.00 per share
    uint128 constant BID = 45e6; // 45 USDG per share: 90% of P0
    uint256 constant DEPTH = 200e18;
    uint256 constant T0 = 1_760_000_000;

    MockERC20 usdg;
    MockWrapper4626 wA;
    MockWrapper4626 wB;
    MockWrapper4626 wX; // not supported by CurbCredit
    MockClock clock;
    MockScorecardPrice sc;
    MockDepthCert dc;
    AllowList elig;
    CurbCredit credit;

    address admin = makeAddr("admin");
    address funder = makeAddr("funder");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address eve = makeAddr("eve"); // never eligible
    address maker = makeAddr("maker");

    function setUp() public virtual {
        vm.warp(T0);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        wA = new MockWrapper4626(address(0xA0), "Wrapped TCENTx", "wTCENTx");
        wB = new MockWrapper4626(address(0xB0), "Wrapped NVDAx", "wNVDAx");
        wX = new MockWrapper4626(address(0xC0), "Wrapped SHEINx", "wSHEINx");
        clock = new MockClock();
        sc = new MockScorecardPrice();
        dc = new MockDepthCert(IERC20(address(usdg)));
        elig = new AllowList();

        sc.setPrice(address(wA), P0);
        sc.setPrice(address(wB), 200e18);

        credit = _deploy();

        elig.set(alice, true);
        elig.set(bob, true);
        elig.set(carol, true);

        clock.set(address(wA), IMarketClock.Regime.MARKET, 20_000_000);
        clock.set(address(wB), IMarketClock.Regime.MARKET, 20_000_000);
        dc.setDepth(address(wA), address(credit), DEPTH, BID, uint64(block.timestamp + 2 days));

        usdg.mint(funder, 1_000_000e6);
        vm.startPrank(funder);
        usdg.approve(address(credit), type(uint256).max);
        credit.fund(100_000e6);
        vm.stopPrank();

        address[4] memory people = [alice, bob, carol, eve];
        for (uint256 i; i < people.length; ++i) {
            wA.mint(people[i], 1_000e18);
            wB.mint(people[i], 1_000e18);
            wX.mint(people[i], 1_000e18);
            usdg.mint(people[i], 10_000e6);
            vm.startPrank(people[i]);
            wA.approve(address(credit), type(uint256).max);
            wB.approve(address(credit), type(uint256).max);
            wX.approve(address(credit), type(uint256).max);
            usdg.approve(address(credit), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _deploy() internal returns (CurbCredit) {
        address[] memory list = new address[](2);
        list[0] = address(wA);
        list[1] = address(wB);
        return new CurbCredit(
            IMarketClock(address(clock)),
            IScorecardPrice(address(sc)),
            IDepthCert(address(dc)),
            IEligibility(address(elig)),
            IERC20(address(usdg)),
            admin,
            list
        );
    }

    // --- helpers ---------------------------------------------------------------------------------------------

    function _open(address a) internal {
        clock.set(a, IMarketClock.Regime.MARKET, 20_000_000);
    }

    function _shut(address a) internal {
        clock.set(a, IMarketClock.Regime.CLOSED, 0);
    }

    function _unknown(address a) internal {
        clock.set(a, IMarketClock.Regime.UNKNOWN, 0);
    }

    function _deposit(address who, address a, uint256 s) internal {
        vm.prank(who);
        credit.deposit(a, s);
    }

    function _borrow(address who, address a, uint256 amt) internal returns (bool ok) {
        vm.prank(who);
        ok = credit.borrow(a, amt);
    }

    function _tick(address b, address a) internal {
        credit.tick(b, a);
    }

    function _valueUsdg(uint256 s, uint256 p) internal pure returns (uint256) {
        return MulDiv.mulDiv(s, p, 1e30);
    }

    function _sharesFor(uint256 u, uint256 p) internal pure returns (uint256) {
        return MulDiv.mulDiv(u, 1e30, p);
    }

    /// @dev Everything a refusal must leave untouched, for one (borrower, asset).
    function _digest(address b, address a) internal view returns (bytes32) {
        CurbCredit.Position memory p = credit.positionOf(b, a);
        CurbCredit.Cure memory c = credit.cureOf(b, a);
        bytes32 h1 = keccak256(
            abi.encode(
                credit.reserve(), credit.totalCollateral(a), credit.totalPrincipal(a), credit.seized(a), credit.badDebt(a)
            )
        );
        bytes32 h2 = keccak256(abi.encode(p.collateral, p.principal, p.accrued, p.lastAccrual));
        bytes32 h3 = keccak256(
            abi.encode(c.active, c.lastOpen, c.openedAt, c.lastTickAt, c.openSecondsUsed, c.priceAtBreach)
        );
        bytes32 h4 = keccak256(
            abi.encode(
                usdg.balanceOf(address(credit)),
                usdg.balanceOf(b),
                IERC20(a).balanceOf(address(credit)),
                IERC20(a).balanceOf(b)
            )
        );
        return keccak256(abi.encode(h1, h2, h3, h4));
    }

    /// @dev The refusal path may write only the reentrancy lock (to 2 and back to 1).
    function _assertOnlyLockWritten() internal view {
        (, bytes32[] memory writes) = vm.accesses(address(credit));
        for (uint256 i = 1; i < writes.length; ++i) {
            assertEq(writes[i], writes[0], "refusal wrote a storage slot other than the lock");
        }
        if (writes.length > 0) assertEq(uint256(vm.load(address(credit), writes[0])), 1, "lock released");
    }

    /// @dev alice deposits 100 wA at $50 (open, deep 45-USDG bid => ltv 6000) and borrows 3000 USDG (her full limit).
    function _aliceAtLimit() internal {
        _deposit(alice, address(wA), 100e18);
        assertEq(credit.ltvFor(address(wA)), 6000);
        assertEq(credit.limitOf(alice, address(wA)), 3000e6);
        assertTrue(_borrow(alice, address(wA), 3000e6));
    }

    /// @dev `_aliceAtLimit`, then the price drops to `pBreach` while open, and the breach is flagged.
    function _aliceBreachedOpen(uint128 pBreach) internal {
        _aliceAtLimit();
        sc.setPrice(address(wA), pBreach);
        (bool known, bool breached) = credit.isBreached(alice, address(wA));
        assertTrue(known && breached, "set-up must breach");
        credit.flagBreach(alice, address(wA));
    }

    /// @dev Six open ticks of five minutes: exactly CURE_OPEN_SECONDS of witnessed open time.
    function _runCureOpen(address b, address a) internal {
        for (uint256 i; i < 6; ++i) {
            vm.warp(block.timestamp + 300);
            credit.tick(b, a);
        }
        assertEq(credit.cureOf(b, a).openSecondsUsed, 1800);
    }
}

contract CurbCreditTest is CreditBase {
    // =========================================================================================================
    // constructor, admin, reserve
    // =========================================================================================================

    function test_constructor_wiring() public view {
        assertEq(address(credit.clock()), address(clock));
        assertEq(address(credit.scorecard()), address(sc));
        assertEq(address(credit.depthCert()), address(dc));
        assertEq(address(credit.eligibility()), address(elig));
        assertEq(address(credit.usdg()), address(usdg));
        assertEq(credit.admin(), admin);
        assertTrue(credit.isAsset(address(wA)));
        assertTrue(credit.isAsset(address(wB)));
        assertFalse(credit.isAsset(address(wX)));
        address[] memory list = credit.assets();
        assertEq(list.length, 2);
        assertEq(list[0], address(wA));
        assertEq(credit.LTV_OPEN_BPS(), 6000);
        assertEq(credit.LTV_SHUT_BPS(), 3000);
        assertEq(credit.APR_BPS(), 500);
        assertEq(credit.STALE_BONUS_BPS(), 500);
        assertEq(credit.CURE_OPEN_SECONDS(), 1800);
        assertEq(credit.MAX_TICK_GAP(), 600);
        assertEq(credit.MIN_CERT_LIFE(), 3600);
        assertEq(credit.reserve(), 100_000e6);
    }

    function test_constructor_rejects_bad_config() public {
        address[] memory list = new address[](1);
        list[0] = address(wX); // no price source
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.NoPriceSource.selector, address(wX)));
        new CurbCredit(clock, sc, dc, elig, IERC20(address(usdg)), admin, list);

        list = new address[](2);
        list[0] = address(wA);
        list[1] = address(wA);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.DuplicateAsset.selector, address(wA)));
        new CurbCredit(clock, sc, dc, elig, IERC20(address(usdg)), admin, list);

        list = new address[](1);
        list[0] = address(wA);
        vm.expectRevert(CurbCredit.ZeroAddress.selector);
        new CurbCredit(clock, sc, dc, elig, IERC20(address(usdg)), address(0), list);
        vm.expectRevert(CurbCredit.ZeroAddress.selector);
        new CurbCredit(clock, sc, IDepthCert(address(0)), elig, IERC20(address(usdg)), admin, list);

        address nothing = makeAddr("no code");
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.NoCode.selector, nothing));
        new CurbCredit(clock, sc, IDepthCert(nothing), elig, IERC20(address(usdg)), admin, list);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.NoCode.selector, nothing));
        new CurbCredit(clock, sc, dc, IEligibility(nothing), IERC20(address(usdg)), admin, list);

        MockERC20 usd18 = new MockERC20("x", "x", 18);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.BadDecimals.selector, address(usd18), uint8(18)));
        new CurbCredit(clock, sc, dc, elig, IERC20(address(usd18)), admin, list);

        MockERC20 w6 = new MockERC20("w6", "w6", 6);
        sc.setPrice(address(w6), 1e18);
        list[0] = address(w6);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.BadDecimals.selector, address(w6), uint8(6)));
        new CurbCredit(clock, sc, dc, elig, IERC20(address(usdg)), admin, list);
    }

    function test_admin_two_step() public {
        address next = makeAddr("next");
        vm.expectRevert(CurbCredit.NotAdmin.selector);
        vm.prank(bob);
        credit.transferAdmin(next);

        vm.prank(admin);
        vm.expectRevert(CurbCredit.ZeroAddress.selector);
        credit.transferAdmin(address(0));

        vm.expectEmit(true, true, false, false, address(credit));
        emit CurbCredit.AdminTransferStarted(admin, next);
        vm.prank(admin);
        credit.transferAdmin(next);
        assertEq(credit.pendingAdmin(), next);
        assertEq(credit.admin(), admin, "not yet");

        vm.expectRevert(CurbCredit.NotPendingAdmin.selector);
        vm.prank(bob);
        credit.acceptAdmin();

        vm.expectEmit(true, true, false, false, address(credit));
        emit CurbCredit.AdminTransferred(admin, next);
        vm.prank(next);
        credit.acceptAdmin();
        assertEq(credit.admin(), next);
        assertEq(credit.pendingAdmin(), address(0));

        vm.expectRevert(CurbCredit.NotAdmin.selector);
        vm.prank(admin);
        credit.defund(1, admin);
        vm.prank(next);
        credit.defund(1, next);
    }

    function test_fund_and_defund() public {
        vm.expectEmit(true, false, false, true, address(credit));
        emit CurbCredit.Funded(alice, 5e6, 100_005e6);
        vm.prank(alice);
        credit.fund(5e6);
        assertEq(credit.reserve(), 100_005e6);
        assertEq(usdg.balanceOf(address(credit)), 100_005e6);

        vm.expectRevert(CurbCredit.ZeroAmount.selector);
        vm.prank(alice);
        credit.fund(0);

        vm.expectRevert(CurbCredit.NotAdmin.selector);
        vm.prank(funder);
        credit.defund(1e6, funder);

        vm.startPrank(admin);
        vm.expectRevert(CurbCredit.ReserveShort.selector);
        credit.defund(100_005e6 + 1, funder);
        vm.expectRevert(CurbCredit.ZeroAddress.selector);
        credit.defund(1e6, address(0));
        vm.expectEmit(true, false, false, true, address(credit));
        emit CurbCredit.Defunded(funder, 5e6, 100_000e6);
        credit.defund(5e6, funder);
        vm.stopPrank();
        assertEq(credit.reserve(), 100_000e6);
    }

    // =========================================================================================================
    // ltvFor, table-driven
    // =========================================================================================================

    struct LtvCase {
        string name;
        IMarketClock.Regime regime;
        uint128 cap;
        bool priceOk;
        uint128 price;
        uint256 depth;
        uint128 minBid;
        uint64 life; // seconds from now until the book's soonest expiry
        uint256 totalColl;
        uint256 expected;
    }

    function _ltvCases() internal pure returns (LtvCase[] memory c) {
        IMarketClock.Regime MKT = IMarketClock.Regime.MARKET;
        IMarketClock.Regime SHUT = IMarketClock.Regime.CLOSED;
        c = new LtvCase[](21);
        c[0] = LtvCase("unknown clock -> 0", IMarketClock.Regime.UNKNOWN, 0, true, 50e18, 200e18, 45e6, 2 days, 100e18, 0);
        c[1] = LtvCase("open, bid 90% of price -> open cap", MKT, 20_000_000, true, 50e18, 200e18, 45e6, 2 days, 100e18, 6000);
        c[2] = LtvCase("closed -> shut cap", SHUT, 0, true, 50e18, 200e18, 45e6, 2 days, 100e18, 3000);
        c[3] = LtvCase("overnight with capacity is open", IMarketClock.Regime.OVERNIGHT, 5_000_000, true, 50e18, 200e18, 45e6, 2 days, 100e18, 6000);
        c[4] = LtvCase("MARKET with zero capacity is shut", MKT, 0, true, 50e18, 200e18, 45e6, 2 days, 100e18, 3000);
        c[5] = LtvCase("no honoured depth -> 0", MKT, 20_000_000, true, 50e18, 0, 45e6, 2 days, 100e18, 0);
        c[6] = LtvCase("price unreadable -> 0", MKT, 20_000_000, false, 50e18, 200e18, 45e6, 2 days, 100e18, 0);
        c[7] = LtvCase("cert expiring in 59 min does not count", MKT, 20_000_000, true, 50e18, 200e18, 45e6, 59 minutes, 100e18, 0);
        c[8] = LtvCase("cert expiring in exactly 1 h counts", MKT, 20_000_000, true, 50e18, 200e18, 45e6, 1 hours, 100e18, 6000);
        c[9] = LtvCase("bid 40% of price, open", MKT, 20_000_000, true, 50e18, 200e18, 20e6, 2 days, 100e18, 4000);
        c[10] = LtvCase("bid 40% of price, shut", SHUT, 0, true, 50e18, 200e18, 20e6, 2 days, 100e18, 3000);
        c[11] = LtvCase("bid 20% of price, shut", SHUT, 0, true, 50e18, 200e18, 10e6, 2 days, 100e18, 2000);
        c[12] = LtvCase("collateral 2x depth, open", MKT, 20_000_000, true, 50e18, 200e18, 45e6, 2 days, 400e18, 4500);
        c[13] = LtvCase("collateral 2x depth, shut", SHUT, 0, true, 50e18, 200e18, 45e6, 2 days, 400e18, 3000);
        c[14] = LtvCase("collateral 4x depth, shut", SHUT, 0, true, 50e18, 200e18, 45e6, 2 days, 800e18, 2250);
        c[15] = LtvCase("no collateral: basis = depth", MKT, 20_000_000, true, 50e18, 200e18, 20e6, 2 days, 0, 4000);
        c[16] = LtvCase("bid above price -> capped", MKT, 20_000_000, true, 50e18, 200e18, 60e6, 2 days, 100e18, 6000);
        c[17] = LtvCase("demo: 0.028 cert vs 0.05 coll @55.78, open", MKT, 20_000_000, true, 55.78e18, 0.028e18, 52e6, 26 hours, 0.05e18, 5220);
        c[18] = LtvCase("demo: 0.028 cert vs 0.05 coll @55.78, shut", SHUT, 0, true, 55.78e18, 0.028e18, 52e6, 26 hours, 0.05e18, 3000);
        c[19] = LtvCase("collateral below depth: fully covered", MKT, 20_000_000, true, 50e18, 200e18, 25e6, 2 days, 10e18, 5000);
        c[20] = LtvCase("dust depth vs large collateral", MKT, 20_000_000, true, 50e18, 1e15, 45e6, 2 days, 1_000e18, 0);
    }

    function test_ltvFor_table() public {
        LtvCase[] memory cases = _ltvCases();
        for (uint256 i; i < cases.length; ++i) {
            LtvCase memory k = cases[i];
            uint256 snap = vm.snapshotState();

            clock.set(address(wA), k.regime, k.cap);
            sc.setPrice(address(wA), k.price);
            sc.setRevert(address(wA), !k.priceOk);
            if (k.depth == 0) dc.clearDepth(address(wA), address(credit));
            else dc.setDepth(address(wA), address(credit), k.depth, k.minBid, uint64(block.timestamp) + k.life);
            if (k.totalColl > 0) {
                wA.mint(carol, k.totalColl);
                _deposit(carol, address(wA), k.totalColl);
            }

            uint256 ltv = credit.ltvFor(address(wA));
            assertEq(ltv, k.expected, k.name);

            // Published invariant: ltvFor * value(totalColl) <= realisable * 1e4 (+ one USDG wei of rounding).
            if (k.priceOk) {
                uint256 lhs = ltv * _valueUsdg(credit.totalCollateral(address(wA)), k.price);
                assertLe(lhs, credit.realisable(address(wA)) * 1e4 + 1e4, string.concat(k.name, ": realisable bound"));
            }
            vm.revertToState(snap);
        }
    }

    function test_ltvFor_unsupported_asset_is_zero() public view {
        assertEq(credit.ltvFor(address(wX)), 0);
        assertEq(credit.realisable(address(wX)), 0);
        assertEq(credit.limitOf(alice, address(wX)), 0);
    }

    function test_realisable_is_notional_of_covered_collateral() public {
        assertEq(credit.realisable(address(wA)), 0, "no collateral, nothing realisable");
        _deposit(carol, address(wA), 100e18);
        assertEq(credit.realisable(address(wA)), 4500e6); // 100 * 45
        _deposit(bob, address(wA), 300e18);
        assertEq(credit.realisable(address(wA)), 9000e6); // min(400, 200) * 45
        dc.setDepth(address(wA), address(credit), DEPTH, BID, uint64(block.timestamp + 59 minutes));
        assertEq(credit.realisable(address(wA)), 0, "short-lived certs do not count");
    }

    /// Fuzz the published bound and the regime caps across prices, bids, depths and collateral.
    function testFuzz_ltv_bound(uint128 price, uint128 minBid, uint256 depth, uint256 coll, bool open) public {
        price = uint128(bound(price, 1e15, 1e24));
        minBid = uint128(bound(minBid, 1, 1e12));
        depth = bound(depth, 1, 1e27);
        coll = bound(coll, 0, 1e27);
        if (open) _open(address(wA));
        else _shut(address(wA));
        sc.setPrice(address(wA), price);
        dc.setDepth(address(wA), address(credit), depth, minBid, uint64(block.timestamp + 2 days));
        if (coll > 0) {
            wA.mint(carol, coll);
            _deposit(carol, address(wA), coll);
        }
        uint256 ltv = credit.ltvFor(address(wA));
        assertLe(ltv, open ? 6000 : 3000);
        assertLe(ltv * _valueUsdg(coll, price), credit.realisable(address(wA)) * 1e4 + 1e4);
        // Monotone in the regime: shutting never raises it.
        _shut(address(wA));
        assertLe(credit.ltvFor(address(wA)), ltv, "shutting never raises ltv");
        assertLe(credit.ltvFor(address(wA)), 3000);
    }

    /// Monotone in the bid, the depth, and inverse in the price.
    function testFuzz_ltv_monotone(uint128 bidLo, uint128 bidHi, uint256 dLo, uint256 dHi, uint128 pLo, uint128 pHi) public {
        bidLo = uint128(bound(bidLo, 1e6, 100e6));
        bidHi = uint128(bound(bidHi, bidLo, 200e6));
        dLo = bound(dLo, 1e18, 500e18);
        dHi = bound(dHi, dLo, 1_000e18);
        pLo = uint128(bound(pLo, 10e18, 100e18));
        pHi = uint128(bound(pHi, pLo, 200e18));
        _deposit(carol, address(wA), 300e18);
        uint64 exp = uint64(block.timestamp + 2 days);

        sc.setPrice(address(wA), pLo);
        dc.setDepth(address(wA), address(credit), dLo, bidLo, exp);
        uint256 base = credit.ltvFor(address(wA));
        dc.setDepth(address(wA), address(credit), dLo, bidHi, exp);
        assertGe(credit.ltvFor(address(wA)), base, "higher bid never lowers ltv");
        dc.setDepth(address(wA), address(credit), dHi, bidLo, exp);
        assertGe(credit.ltvFor(address(wA)), base, "more depth never lowers ltv");
        dc.setDepth(address(wA), address(credit), dLo, bidLo, exp);
        sc.setPrice(address(wA), pHi);
        assertLe(credit.ltvFor(address(wA)), base, "higher price never raises ltv");
    }

    // =========================================================================================================
    // deposit
    // =========================================================================================================

    function test_deposit_moves_shares_and_emits() public {
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.Deposited(alice, address(wA), 10e18, 10e18);
        _deposit(alice, address(wA), 10e18);
        assertEq(credit.positionOf(alice, address(wA)).collateral, 10e18);
        assertEq(credit.totalCollateral(address(wA)), 10e18);
        assertEq(wA.balanceOf(address(credit)), 10e18);
    }

    function test_deposit_reverts_if_ineligible_unsupported_or_zero() public {
        vm.expectRevert(CurbCredit.Ineligible.selector);
        vm.prank(eve);
        credit.deposit(address(wA), 1e18);

        vm.expectRevert(CurbCredit.UnsupportedAsset.selector);
        vm.prank(alice);
        credit.deposit(address(wX), 1e18);

        vm.expectRevert(CurbCredit.ZeroAmount.selector);
        vm.prank(alice);
        credit.deposit(address(wA), 0);

        // Revoking eligibility blocks new deposits.
        _deposit(alice, address(wA), 1e18);
        elig.set(alice, false);
        vm.expectRevert(CurbCredit.Ineligible.selector);
        vm.prank(alice);
        credit.deposit(address(wA), 1e18);
    }

    // =========================================================================================================
    // borrow: success and every refusal
    // =========================================================================================================

    function test_borrow_success() public {
        _deposit(alice, address(wA), 100e18);
        uint256 before = usdg.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.Borrowed(alice, address(wA), 1000e6, 1000e6, 6000);
        assertTrue(_borrow(alice, address(wA), 1000e6));
        assertEq(usdg.balanceOf(alice), before + 1000e6);
        assertEq(credit.debtOf(alice, address(wA)), 1000e6);
        assertEq(credit.totalPrincipal(address(wA)), 1000e6);
        assertEq(credit.reserve(), 99_000e6);
        assertLe(credit.totalPrincipal(address(wA)), credit.realisable(address(wA)));
    }

    function test_borrow_exactly_at_limit_then_one_more_refused() public {
        _aliceAtLimit();
        _refuseBorrow(alice, address(wA), 1, CurbCredit.ExceedsLtv.selector, 0);
    }

    function test_borrow_zero_reverts() public {
        vm.expectRevert(CurbCredit.ZeroAmount.selector);
        vm.prank(alice);
        credit.borrow(address(wA), 0);
    }

    function _refuseBorrow(address who, address a, uint256 amt, bytes4 reason, uint256 allowed) internal {
        bytes32 before = _digest(who, a);
        vm.record();
        vm.expectEmit(true, true, true, true, address(credit));
        emit CurbCredit.Refusal(who, a, reason, amt, allowed);
        vm.prank(who);
        bool ok = credit.borrow(a, amt);
        assertFalse(ok, "refused borrow returns false");
        _assertOnlyLockWritten();
        assertEq(_digest(who, a), before, "refused borrow changed state");
    }

    function _refuseWithdraw(address who, address a, uint256 s, bytes4 reason, uint256 allowed) internal {
        bytes32 before = _digest(who, a);
        vm.record();
        vm.expectEmit(true, true, true, true, address(credit));
        emit CurbCredit.Refusal(who, a, reason, s, allowed);
        vm.prank(who);
        bool ok = credit.withdraw(a, s);
        assertFalse(ok, "refused withdraw returns false");
        _assertOnlyLockWritten();
        assertEq(_digest(who, a), before, "refused withdraw changed state");
    }

    function test_refusal_Ineligible() public {
        _refuseBorrow(eve, address(wA), 1e6, CurbCredit.Ineligible.selector, 0);
        // A revoked borrower with collateral is refused too, without touching the position.
        _deposit(alice, address(wA), 100e18);
        elig.set(alice, false);
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.Ineligible.selector, 0);
    }

    function test_refusal_UnsupportedAsset() public {
        _refuseBorrow(alice, address(wX), 1e6, CurbCredit.UnsupportedAsset.selector, 0);
    }

    function test_refusal_MarketUnknown() public {
        _deposit(alice, address(wA), 100e18);
        _unknown(address(wA));
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.MarketUnknown.selector, 0);
    }

    function test_refusal_PriceUnavailable() public {
        _deposit(alice, address(wA), 100e18);
        sc.setRevert(address(wA), true);
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.PriceUnavailable.selector, 0);
    }

    function test_refusal_NoDepth() public {
        _deposit(alice, address(wA), 100e18);
        dc.clearDepth(address(wA), address(credit));
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.NoDepth.selector, 0);
        // A book that expires inside MIN_CERT_LIFE is no depth either.
        dc.setDepth(address(wA), address(credit), DEPTH, BID, uint64(block.timestamp + 30 minutes));
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.NoDepth.selector, 0);
    }

    function test_refusal_ExceedsLtv() public {
        _deposit(alice, address(wA), 100e18);
        assertTrue(_borrow(alice, address(wA), 1000e6));
        dc.setDepth(address(wA), address(credit), DEPTH, BID, uint64(block.timestamp + 60 days));
        vm.warp(block.timestamp + 30 days);
        uint256 debt = credit.debtOf(alice, address(wA));
        uint256 limit = credit.limitOf(alice, address(wA));
        assertGt(debt, 1000e6, "interest accrued");
        _refuseBorrow(alice, address(wA), 2500e6, CurbCredit.ExceedsLtv.selector, limit - debt);
        // Shut: the same request against a 30% limit.
        _shut(address(wA));
        limit = credit.limitOf(alice, address(wA));
        assertEq(limit, 1500e6);
        _refuseBorrow(alice, address(wA), 600e6, CurbCredit.ExceedsLtv.selector, limit - debt);
    }

    function test_refusal_ExceedsDepth() public {
        _aliceAtLimit(); // 3000 against 100 shares, realisable 4500
        _deposit(bob, address(wA), 100e18); // totalColl 200 = depth
        // Bids fall to 40% of price: ltv 4000, realisable 200 * 20 = 4000, but 3000 is already lent.
        dc.setDepth(address(wA), address(credit), DEPTH, 20e6, uint64(block.timestamp + 2 days));
        assertEq(credit.ltvFor(address(wA)), 4000);
        assertEq(credit.realisable(address(wA)), 4000e6);
        assertEq(credit.limitOf(bob, address(wA)), 2000e6);
        _refuseBorrow(bob, address(wA), 1500e6, CurbCredit.ExceedsDepth.selector, 1000e6);
        assertTrue(_borrow(bob, address(wA), 1000e6), "up to realisable is fine");
        assertEq(credit.totalPrincipal(address(wA)), credit.realisable(address(wA)));
    }

    function test_refusal_ReserveShort() public {
        _deposit(alice, address(wA), 100e18);
        vm.prank(admin);
        credit.defund(99_900e6, admin);
        _refuseBorrow(alice, address(wA), 200e6, CurbCredit.ReserveShort.selector, 100e6);
    }

    function test_refusal_InCure() public {
        _aliceBreachedOpen(40e18);
        // Even a tiny top-up borrow is refused while a cure is running, as is a withdrawal.
        _refuseBorrow(alice, address(wA), 1, CurbCredit.InCure.selector, 0);
        _refuseWithdraw(alice, address(wA), 1, CurbCredit.InCure.selector, 0);
    }

    function test_refusal_withdraw_MarketUnknown_and_PriceUnavailable() public {
        _deposit(alice, address(wA), 100e18);
        assertTrue(_borrow(alice, address(wA), 100e6));
        _unknown(address(wA));
        _refuseWithdraw(alice, address(wA), 1e18, CurbCredit.MarketUnknown.selector, 0);
        _open(address(wA));
        sc.setRevert(address(wA), true);
        _refuseWithdraw(alice, address(wA), 1e18, CurbCredit.PriceUnavailable.selector, 0);
    }

    function test_refusal_WouldBreach_and_allowed_is_withdrawable() public {
        _deposit(alice, address(wA), 100e18);
        assertTrue(_borrow(alice, address(wA), 2000e6)); // needs 66.67 shares at 60% of $50
        bytes32 before = _digest(alice, address(wA));
        vm.recordLogs();
        vm.prank(alice);
        assertFalse(credit.withdraw(address(wA), 50e18));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], CurbCredit.Refusal.selector);
        assertEq(logs[0].topics[3], bytes32(CurbCredit.WouldBreach.selector));
        (uint256 requested, uint256 allowed) = abi.decode(logs[0].data, (uint256, uint256));
        assertEq(requested, 50e18);
        assertEq(_digest(alice, address(wA)), before);
        assertGt(allowed, 33e18);
        assertLt(allowed, 33.34e18);
        // The advertised amount really is withdrawable, and the position is then within its limit.
        vm.prank(alice);
        assertTrue(credit.withdraw(address(wA), allowed));
        (bool known, bool breached) = credit.isBreached(alice, address(wA));
        assertTrue(known && !breached);
    }

    function test_withdraw_debt_free_always_allowed() public {
        _deposit(alice, address(wA), 10e18);
        elig.set(alice, false);
        _unknown(address(wA));
        sc.setRevert(address(wA), true);
        dc.clearDepth(address(wA), address(credit));
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.Withdrawn(alice, address(wA), 4e18, 6e18);
        vm.prank(alice);
        assertTrue(credit.withdraw(address(wA), 4e18));
        assertEq(wA.balanceOf(alice), 994e18);
        assertEq(credit.totalCollateral(address(wA)), 6e18);
    }

    function test_withdraw_reverts_beyond_collateral_or_zero() public {
        _deposit(alice, address(wA), 10e18);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.ExceedsCollateral.selector, 10e18, 11e18));
        vm.prank(alice);
        credit.withdraw(address(wA), 11e18);
        vm.expectRevert(CurbCredit.ZeroAmount.selector);
        vm.prank(alice);
        credit.withdraw(address(wA), 0);
    }

    function test_withdraw_with_debt_within_limit() public {
        _deposit(alice, address(wA), 100e18);
        assertTrue(_borrow(alice, address(wA), 1000e6)); // needs 33.4 shares
        vm.prank(alice);
        assertTrue(credit.withdraw(address(wA), 60e18));
        assertEq(credit.positionOf(alice, address(wA)).collateral, 40e18);
    }

    // =========================================================================================================
    // interest and repay
    // =========================================================================================================

    function test_interest_simple_5pct() public {
        _deposit(alice, address(wA), 100e18);
        assertTrue(_borrow(alice, address(wA), 1000e6));
        vm.warp(block.timestamp + 365 days / 2);
        assertEq(credit.debtOf(alice, address(wA)), 1025e6);
        vm.warp(block.timestamp + 365 days / 2);
        assertEq(credit.debtOf(alice, address(wA)), 1050e6);
        vm.warp(block.timestamp + 365 days);
        assertEq(credit.debtOf(alice, address(wA)), 1100e6, "simple, not compounded");
    }

    function test_interest_checkpoint_does_not_compound() public {
        _deposit(alice, address(wA), 100e18);
        assertTrue(_borrow(alice, address(wA), 1000e6));
        vm.warp(block.timestamp + 365 days);
        // A repay of 1 unit checkpoints accrued interest; it is kept apart from principal.
        vm.prank(bob);
        credit.repay(alice, address(wA), 1);
        CurbCredit.Position memory p = credit.positionOf(alice, address(wA));
        assertEq(p.accrued, 50e6 - 1);
        assertEq(p.principal, 1000e6);
        vm.warp(block.timestamp + 365 days);
        assertEq(credit.debtOf(alice, address(wA)), 1100e6 - 1);
    }

    function test_repay_pays_accrued_first_and_anyone_can_repay() public {
        _deposit(alice, address(wA), 100e18);
        assertTrue(_borrow(alice, address(wA), 1000e6));
        vm.warp(block.timestamp + 365 days); // debt 1050

        uint256 reserveBefore = credit.reserve();
        vm.expectEmit(true, true, true, true, address(credit));
        emit CurbCredit.Repaid(alice, address(wA), bob, 30e6, 1020e6);
        vm.prank(bob);
        credit.repay(alice, address(wA), 30e6);
        CurbCredit.Position memory p = credit.positionOf(alice, address(wA));
        assertEq(p.accrued, 20e6);
        assertEq(p.principal, 1000e6);
        assertEq(credit.totalPrincipal(address(wA)), 1000e6);

        vm.prank(bob);
        credit.repay(alice, address(wA), 30e6);
        p = credit.positionOf(alice, address(wA));
        assertEq(p.accrued, 0);
        assertEq(p.principal, 990e6);
        assertEq(credit.totalPrincipal(address(wA)), 990e6);
        assertEq(credit.reserve(), reserveBefore + 60e6);

        // Overpaying pulls only what is owed.
        uint256 bobBefore = usdg.balanceOf(bob);
        vm.prank(bob);
        credit.repay(alice, address(wA), 5_000e6);
        assertEq(usdg.balanceOf(bob), bobBefore - 990e6);
        assertEq(credit.debtOf(alice, address(wA)), 0);
        assertEq(credit.totalPrincipal(address(wA)), 0);
        assertEq(credit.reserve(), reserveBefore + 1050e6);

        vm.expectRevert(CurbCredit.ZeroAmount.selector);
        vm.prank(bob);
        credit.repay(alice, address(wA), 1);
        vm.expectRevert(CurbCredit.ZeroAmount.selector);
        vm.prank(bob);
        credit.repay(alice, address(wA), 0);
    }

    // =========================================================================================================
    // flagBreach
    // =========================================================================================================

    function test_flagBreach_records_breach() public {
        _aliceAtLimit();
        sc.setPrice(address(wA), 40e18);
        uint256 debt = credit.debtOf(alice, address(wA));
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.BreachOpened(alice, address(wA), debt, 2400e6, 40e18, 6000);
        credit.flagBreach(alice, address(wA));
        CurbCredit.Cure memory c = credit.cureOf(alice, address(wA));
        assertTrue(c.active);
        assertTrue(c.lastOpen);
        assertEq(c.openedAt, block.timestamp);
        assertEq(c.lastTickAt, block.timestamp);
        assertEq(c.openSecondsUsed, 0);
        assertEq(c.priceAtBreach, 40e18);
        vm.expectRevert(CurbCredit.AlreadyInCure.selector);
        credit.flagBreach(alice, address(wA));
    }

    function test_flagBreach_regime_flip_60_to_30() public {
        _aliceAtLimit();
        vm.expectRevert(CurbCredit.NotBreached.selector);
        credit.flagBreach(alice, address(wA));
        _shut(address(wA));
        assertEq(credit.ltvFor(address(wA)), 3000);
        assertEq(credit.limitOf(alice, address(wA)), 1500e6);
        credit.flagBreach(alice, address(wA));
        assertFalse(credit.cureOf(alice, address(wA)).lastOpen, "flagged while shut");
    }

    function test_flagBreach_requires_known_breach() public {
        vm.expectRevert(CurbCredit.NotBreached.selector);
        credit.flagBreach(alice, address(wA)); // no debt

        _aliceAtLimit();
        sc.setPrice(address(wA), 40e18);
        _unknown(address(wA));
        (bool known,) = credit.isBreached(alice, address(wA));
        assertFalse(known);
        vm.expectRevert(CurbCredit.MarketUnknown.selector);
        credit.flagBreach(alice, address(wA));

        _open(address(wA));
        sc.setRevert(address(wA), true);
        vm.expectRevert(CurbCredit.PriceUnavailable.selector);
        credit.flagBreach(alice, address(wA));

        vm.expectRevert(CurbCredit.UnsupportedAsset.selector);
        credit.flagBreach(alice, address(wX));
    }

    function test_depth_expiry_breaches() public {
        _aliceAtLimit();
        // The only cert is about to expire: inside MIN_CERT_LIFE it stops counting, ltv -> 0, limit -> 0.
        dc.setDepth(address(wA), address(credit), DEPTH, BID, uint64(block.timestamp + 2 hours));
        assertEq(credit.ltvFor(address(wA)), 6000);
        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(credit.ltvFor(address(wA)), 0);
        credit.flagBreach(alice, address(wA));
        assertTrue(credit.cureOf(alice, address(wA)).active);
    }

    // =========================================================================================================
    // tick: only witnessed open -> open gaps of at most 600 s
    // =========================================================================================================

    function test_tick_counts_open_to_open_gaps_up_to_600() public {
        _aliceBreachedOpen(40e18);
        vm.warp(block.timestamp + 300);
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.CureTicked(alice, address(wA), true, 300, 1800);
        _tick(alice, address(wA));

        vm.warp(block.timestamp + 600); // exactly the max gap counts
        _tick(alice, address(wA));
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 900);

        vm.warp(block.timestamp + 601); // unwitnessed: does not count
        _tick(alice, address(wA));
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 900);

        vm.warp(block.timestamp + 300); // but the clock resumes from the late tick
        _tick(alice, address(wA));
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 1200);

        _tick(alice, address(wA)); // same block: zero gap
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 1200);
        assertEq(credit.cureOf(alice, address(wA)).lastTickAt, block.timestamp);
    }

    function test_tick_needs_open_at_both_ends() public {
        _aliceBreachedOpen(40e18);
        vm.warp(block.timestamp + 300);
        _shut(address(wA));
        _tick(alice, address(wA)); // open -> shut: nothing
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 0);
        assertFalse(credit.cureOf(alice, address(wA)).lastOpen);

        vm.warp(block.timestamp + 300);
        _open(address(wA));
        _tick(alice, address(wA)); // shut -> open: nothing
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 0);
        assertTrue(credit.cureOf(alice, address(wA)).lastOpen);

        vm.warp(block.timestamp + 300);
        _tick(alice, address(wA)); // open -> open: counts
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 300);
    }

    function test_cure_clock_frozen_while_shut_and_unknown() public {
        _aliceBreachedOpen(40e18);
        _runCureOpen(alice, address(wA)); // 1800 used, then prove it never moves again while shut/UNKNOWN
        uint256 used = credit.cureOf(alice, address(wA)).openSecondsUsed;

        _shut(address(wA));
        for (uint256 i; i < 96; ++i) { // eight hours of five-minute ticks over a closure
            vm.warp(block.timestamp + 300);
            _tick(alice, address(wA));
        }
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, used, "frozen while shut");

        _unknown(address(wA)); // the attestor goes stale
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + 300);
            _tick(alice, address(wA));
        }
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, used, "frozen while UNKNOWN");
        assertTrue(credit.cureOf(alice, address(wA)).active, "a stale clock never cures");

        _open(address(wA));
        vm.warp(block.timestamp + 300);
        _tick(alice, address(wA));
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, used, "first open tick only witnesses");
        vm.warp(block.timestamp + 300);
        _tick(alice, address(wA));
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, used + 300);
    }

    function test_cure_clock_frozen_when_flagged_shut() public {
        _aliceAtLimit();
        _shut(address(wA));
        credit.flagBreach(alice, address(wA));
        for (uint256 i; i < 24; ++i) {
            vm.warp(block.timestamp + 300);
            _tick(alice, address(wA));
        }
        assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, 0);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.CureIncomplete.selector, 0, 1800));
        credit.liquidate(alice, address(wA));
    }

    function test_tick_without_cure_reverts() public {
        vm.expectRevert(CurbCredit.NoCure.selector);
        credit.tick(alice, address(wA));
    }

    /// Model check: over random gaps and regimes, used == sum of the qualifying gaps.
    function testFuzz_tick_model(uint256 seed) public {
        _aliceBreachedOpen(20e18); // deep breach: no regime or price here can cure it
        bool lastOpen = true;
        uint256 model;
        for (uint256 i; i < 40; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 gap = r % 900;
            uint256 mode = (r >> 16) % 4; // 0,1 open; 2 shut; 3 unknown
            vm.warp(block.timestamp + gap);
            if (mode < 2) _open(address(wA));
            else if (mode == 2) _shut(address(wA));
            else _unknown(address(wA));
            bool openNow = mode < 2;
            if (lastOpen && openNow && gap <= 600) model += gap;
            lastOpen = openNow;
            _tick(alice, address(wA));
            assertEq(credit.cureOf(alice, address(wA)).openSecondsUsed, model);
        }
    }

    // =========================================================================================================
    // clearing
    // =========================================================================================================

    function test_cure_clears_on_repay() public {
        _aliceBreachedOpen(40e18); // limit 2400
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.BreachCured(alice, address(wA), 0);
        vm.prank(alice);
        credit.repay(alice, address(wA), 700e6);
        assertFalse(credit.cureOf(alice, address(wA)).active);
    }

    function test_cure_clears_on_deposit() public {
        _aliceBreachedOpen(40e18);
        _deposit(alice, address(wA), 30e18); // 130 * 40 * 60% = 3120 > 3000
        assertFalse(credit.cureOf(alice, address(wA)).active);
    }

    function test_partial_repay_keeps_cure() public {
        _aliceBreachedOpen(40e18);
        vm.prank(alice);
        credit.repay(alice, address(wA), 100e6);
        assertTrue(credit.cureOf(alice, address(wA)).active);
    }

    function test_cure_clears_on_tick_when_healthy() public {
        _aliceBreachedOpen(40e18);
        vm.warp(block.timestamp + 300);
        sc.setPrice(address(wA), 60e18); // 100 * 60 * 60% = 3600
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.BreachCured(alice, address(wA), 300);
        _tick(alice, address(wA));
        assertFalse(credit.cureOf(alice, address(wA)).active);
    }

    function test_stale_clock_never_cures_but_zero_debt_does() public {
        _aliceBreachedOpen(40e18);
        _unknown(address(wA));
        vm.prank(alice);
        credit.repay(alice, address(wA), 700e6); // healthy on paper, but unknowable
        assertTrue(credit.cureOf(alice, address(wA)).active, "stale clock cannot cure");
        _deposit(alice, address(wA), 50e18);
        assertTrue(credit.cureOf(alice, address(wA)).active);
        // Paying the debt off entirely is knowably healthy, whatever the clock says.
        vm.prank(alice);
        credit.repay(alice, address(wA), type(uint256).max);
        assertFalse(credit.cureOf(alice, address(wA)).active);
    }

    function test_cure_reopens_after_clear() public {
        _aliceBreachedOpen(40e18);
        vm.prank(alice);
        credit.repay(alice, address(wA), 700e6);
        assertFalse(credit.cureOf(alice, address(wA)).active);
        sc.setPrice(address(wA), 30e18);
        credit.flagBreach(alice, address(wA));
        CurbCredit.Cure memory c = credit.cureOf(alice, address(wA));
        assertTrue(c.active);
        assertEq(c.openSecondsUsed, 0, "a new breach starts a new clock");
        assertEq(c.priceAtBreach, 30e18);
    }

    // =========================================================================================================
    // liquidation
    // =========================================================================================================

    function test_liquidate_blocked_before_1800_open_seconds() public {
        _aliceBreachedOpen(40e18);
        for (uint256 i; i < 5; ++i) {
            vm.warp(block.timestamp + 300);
            _tick(alice, address(wA));
        }
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.CureIncomplete.selector, 1500, 1800));
        credit.liquidate(alice, address(wA));
        // Wall-clock time alone never ripens a cure.
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.CureIncomplete.selector, 1500, 1800));
        credit.liquidate(alice, address(wA));
    }

    function test_liquidate_blocked_while_shut_or_unknown() public {
        _aliceBreachedOpen(40e18);
        _runCureOpen(alice, address(wA));
        _shut(address(wA));
        vm.expectRevert(CurbCredit.MarketShut.selector);
        credit.liquidate(alice, address(wA));
        _unknown(address(wA));
        vm.expectRevert(CurbCredit.MarketUnknown.selector);
        credit.liquidate(alice, address(wA));
        _open(address(wA));
        sc.setRevert(address(wA), true);
        vm.expectRevert(CurbCredit.PriceUnavailable.selector);
        credit.liquidate(alice, address(wA));
    }

    function test_liquidate_requires_cure_and_breach() public {
        vm.expectRevert(CurbCredit.NoCure.selector);
        credit.liquidate(alice, address(wA));
        _aliceBreachedOpen(40e18);
        _runCureOpen(alice, address(wA));
        sc.setPrice(address(wA), 60e18); // healed, not yet ticked
        vm.expectRevert(CurbCredit.NotBreached.selector);
        credit.liquidate(alice, address(wA));
    }

    struct Expect {
        uint256 debt;
        uint256 coll;
        uint256 stale;
        uint256 seize;
        uint256 cleared;
        uint256 bad;
        uint256 tc;
        uint256 tp;
        uint256 principal;
    }

    function _expected(uint256 pFresh, uint256 pBreach) internal view returns (Expect memory e) {
        e.debt = credit.debtOf(alice, address(wA));
        e.coll = credit.positionOf(alice, address(wA)).collateral;
        uint256 fresh = _sharesFor(e.debt, pFresh);
        e.stale = _sharesFor(MulDiv.mulDiv(e.debt, 10500, 1e4), pBreach);
        e.seize = e.coll < fresh ? e.coll : fresh;
        e.seize = e.seize < e.stale ? e.seize : e.stale;
        e.cleared = _valueUsdg(e.seize, pFresh);
        if (e.cleared > e.debt) e.cleared = e.debt;
        e.bad = e.debt - e.cleared;
        e.tc = credit.totalCollateral(address(wA));
        e.tp = credit.totalPrincipal(address(wA));
        e.principal = credit.positionOf(alice, address(wA)).principal;
    }

    function _liquidateAndCheck(uint256 pFresh, uint256 pBreach)
        internal
        returns (uint256 seize, uint256 cleared, uint256 bad)
    {
        Expect memory e = _expected(pFresh, pBreach);
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.Liquidated(alice, address(wA), e.seize, e.cleared, e.bad, pFresh, pBreach);
        vm.prank(carol); // permissionless
        credit.liquidate(alice, address(wA));

        CurbCredit.Position memory p = credit.positionOf(alice, address(wA));
        assertEq(p.collateral, e.coll - e.seize, "borrower keeps the rest");
        assertEq(p.principal, 0);
        assertEq(p.accrued, 0);
        assertEq(credit.debtOf(alice, address(wA)), 0);
        assertEq(credit.totalCollateral(address(wA)), e.tc - e.seize);
        assertEq(credit.totalPrincipal(address(wA)), e.tp - e.principal);
        assertEq(credit.seized(address(wA)), e.seize);
        assertEq(credit.badDebt(address(wA)), e.bad);
        assertFalse(credit.cureOf(alice, address(wA)).active);
        assertEq(wA.balanceOf(address(credit)), credit.totalCollateral(address(wA)) + credit.seized(address(wA)));
        assertLe(e.seize, e.stale, "never more than a 5%-bonus liquidation at the breach price");
        return (e.seize, e.cleared, e.bad);
    }

    function test_seize_fresh_limit_binds() public {
        _aliceBreachedOpen(40e18);
        _runCureOpen(alice, address(wA));
        uint256 debt = credit.debtOf(alice, address(wA));
        (uint256 seize,, uint256 bad) = _liquidateAndCheck(40e18, 40e18);
        assertEq(seize, _sharesFor(debt, 40e18), "fresh leg binds");
        assertLe(bad, 1, "rounding dust only");
        // She walks away with her 25 shares.
        vm.prank(alice);
        assertTrue(credit.withdraw(address(wA), 100e18 - seize));
    }

    function test_seize_stale_cap_binds() public {
        _aliceBreachedOpen(40e18);
        _runCureOpen(alice, address(wA));
        sc.setPrice(address(wA), 35e18); // fell another 12.5% after the breach
        uint256 debt = credit.debtOf(alice, address(wA));
        (uint256 seize, uint256 cleared, uint256 bad) = _liquidateAndCheck(35e18, 40e18);
        assertEq(seize, _sharesFor(MulDiv.mulDiv(debt, 10500, 1e4), 40e18), "stale cap binds");
        assertLt(seize, _sharesFor(debt, 35e18));
        assertEq(cleared, _valueUsdg(seize, 35e18));
        assertGt(bad, 240e6, "the lender, not the borrower, eats the post-breach fall");
    }

    function test_seize_collateral_binds_and_bad_debt() public {
        _aliceBreachedOpen(30e18);
        _runCureOpen(alice, address(wA));
        sc.setPrice(address(wA), 25e18);
        uint256 debt = credit.debtOf(alice, address(wA));
        (uint256 seize, uint256 cleared, uint256 bad) = _liquidateAndCheck(25e18, 30e18);
        assertEq(seize, 100e18, "all collateral");
        assertEq(cleared, 2500e6);
        assertEq(bad, debt - 2500e6);
        assertEq(credit.positionOf(alice, address(wA)).collateral, 0);
    }

    function test_liquidation_does_not_touch_reserve() public {
        _aliceBreachedOpen(40e18);
        _runCureOpen(alice, address(wA));
        uint256 r = credit.reserve();
        credit.liquidate(alice, address(wA));
        assertEq(credit.reserve(), r, "seized shares are not cash until realised");
    }

    // =========================================================================================================
    // realise and sweep (seized shares only)
    // =========================================================================================================

    function _seizeSome() internal returns (uint256 seize) {
        _aliceBreachedOpen(40e18);
        _runCureOpen(alice, address(wA));
        credit.liquidate(alice, address(wA));
        seize = credit.seized(address(wA));
        assertGt(seize, 70e18);
    }

    function test_realise_fill() public {
        uint256 seize = _seizeSome();
        uint256 id = dc.setCert(maker, address(wA), address(credit), 50e18, 38e6, 200e6, uint64(block.timestamp + 1 days));
        usdg.mint(address(dc), 10_000e6);
        uint256 r = credit.reserve();

        vm.expectEmit(true, false, false, true, address(credit));
        emit CurbCredit.Realised(id, 20e18, true, 760e6);
        vm.prank(admin);
        credit.realise(id, 20e18);

        assertEq(credit.seized(address(wA)), seize - 20e18);
        assertEq(credit.reserve(), r + 760e6);
        assertEq(wA.balanceOf(address(dc)), 20e18);
        assertEq(dc.lastTaker(), address(credit));
        assertEq(dc.lastTo(), address(credit));
        assertEq(wA.allowance(address(credit), address(dc)), 0, "approval reset");
        assertEq(wA.balanceOf(address(credit)), credit.totalCollateral(address(wA)) + credit.seized(address(wA)));
    }

    function test_realise_fade_returns_shares_and_keeps_bond() public {
        uint256 seize = _seizeSome();
        uint256 id = dc.setCert(maker, address(wA), address(credit), 50e18, 38e6, 200e6, uint64(block.timestamp + 1 days));
        usdg.mint(address(dc), 10_000e6);
        dc.setFade(id, true);
        uint256 r = credit.reserve();

        vm.expectEmit(true, false, false, true, address(credit));
        emit CurbCredit.Realised(id, 20e18, false, 200e6);
        vm.prank(admin);
        credit.realise(id, 20e18);

        assertEq(credit.seized(address(wA)), seize, "shares came back");
        assertEq(credit.reserve(), r + 200e6, "slashed bond joins the reserve");
        assertEq(wA.balanceOf(address(credit)), credit.totalCollateral(address(wA)) + credit.seized(address(wA)));
    }

    function test_realise_guards() public {
        uint256 seize = _seizeSome();
        uint256 other = dc.setCert(maker, address(wA), bob, 50e18, 38e6, 200e6, uint64(block.timestamp + 1 days));
        uint256 open_ = dc.setCert(maker, address(wA), address(0), 50e18, 38e6, 200e6, uint64(block.timestamp + 1 days));
        uint256 ours = dc.setCert(maker, address(wA), address(credit), 500e18, 38e6, 200e6, uint64(block.timestamp + 1 days));

        vm.expectRevert(CurbCredit.NotAdmin.selector);
        credit.realise(ours, 1e18);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.NotOurCert.selector, other));
        credit.realise(other, 1e18);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.NotOurCert.selector, open_));
        credit.realise(open_, 1e18);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.ExceedsSeized.selector, seize, seize + 1));
        credit.realise(ours, seize + 1); // borrowers' collateral is never sold
        vm.expectRevert(CurbCredit.ZeroAmount.selector);
        credit.realise(ours, 0);
        vm.stopPrank();
    }

    function test_sweepSeized() public {
        uint256 seize = _seizeSome();
        address desk = makeAddr("desk");
        vm.expectRevert(CurbCredit.NotAdmin.selector);
        credit.sweepSeized(address(wA), 1, desk);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(CurbCredit.ExceedsSeized.selector, seize, seize + 1));
        credit.sweepSeized(address(wA), seize + 1, desk);
        vm.expectRevert(CurbCredit.ZeroAddress.selector);
        credit.sweepSeized(address(wA), 1, address(0));
        vm.expectEmit(true, true, false, true, address(credit));
        emit CurbCredit.SeizedSwept(address(wA), desk, seize);
        credit.sweepSeized(address(wA), seize, desk);
        vm.stopPrank();
        assertEq(wA.balanceOf(desk), seize);
        assertEq(credit.seized(address(wA)), 0);
        assertEq(wA.balanceOf(address(credit)), credit.totalCollateral(address(wA)));
    }

    // =========================================================================================================
    // robustness
    // =========================================================================================================

    function test_reverting_depthcert_reads_as_no_depth() public {
        _deposit(alice, address(wA), 100e18);
        vm.mockCallRevert(address(dc), abi.encodeWithSelector(IDepthCert.honouredDepth.selector), "boom");
        assertEq(credit.ltvFor(address(wA)), 0);
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.NoDepth.selector, 0);
    }

    function test_reverting_clock_reads_as_unknown() public {
        _deposit(alice, address(wA), 100e18);
        vm.mockCallRevert(address(clock), abi.encodeWithSelector(IMarketClock.regime.selector), "boom");
        assertEq(credit.ltvFor(address(wA)), 0);
        assertFalse(credit.isOpen(address(wA)));
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.MarketUnknown.selector, 0);
    }

    function test_reverting_registry_reads_as_ineligible() public {
        vm.mockCallRevert(address(elig), abi.encodeWithSelector(IEligibility.isEligible.selector), "boom");
        _refuseBorrow(alice, address(wA), 1e6, CurbCredit.Ineligible.selector, 0);
    }

    function test_nonReentrant_blocks_reentry() public {
        ReentrantWrapper rw = new ReentrantWrapper();
        sc.setPrice(address(rw), P0);
        address[] memory list = new address[](1);
        list[0] = address(rw);
        CurbCredit c2 = new CurbCredit(clock, sc, dc, elig, IERC20(address(usdg)), admin, list);
        rw.arm(c2);
        rw.mint(alice, 10e18);
        vm.startPrank(alice);
        rw.approve(address(c2), type(uint256).max);
        c2.deposit(address(rw), 1e18);
        vm.stopPrank();
        assertTrue(rw.attempted());
        assertTrue(rw.blocked(), "re-entry must hit the lock");
        assertEq(c2.reserve(), 0);
    }

    function test_second_asset_is_independent() public {
        _aliceAtLimit();
        _shut(address(wA));
        credit.flagBreach(alice, address(wA));
        // wB has no depth at all: its own refusal, unaffected by wA's cure.
        _deposit(alice, address(wB), 10e18);
        _refuseBorrow(alice, address(wB), 1e6, CurbCredit.NoDepth.selector, 0);
        dc.setDepth(address(wB), address(credit), 100e18, 150e6, uint64(block.timestamp + 1 days));
        assertEq(credit.ltvFor(address(wB)), 6000); // 150/200 = 7500 -> capped
        assertTrue(_borrow(alice, address(wB), 1000e6));
    }
}

/// @notice ERC-8021 Builder Code: every CurbCredit entry point behaves identically with the 34-byte suffix
///         appended to its calldata. One world, run twice from the same snapshot, compared on return data,
///         events and a digest of all touched state.
contract CurbCreditSuffixTest is CreditBase {
    bytes constant SUFFIX = hex"6464377535306e636b74356537323966100080218021802180218021802180218021";

    bytes32 retHash;
    bool tagged;

    function _call(address from, bytes memory data) internal {
        bytes memory payload = tagged ? abi.encodePacked(data, SUFFIX) : data;
        vm.prank(from);
        (bool ok, bytes memory ret) = address(credit).call(payload);
        assertTrue(ok, tagged ? "tagged call reverted" : "plain call reverted");
        retHash = keccak256(abi.encode(retHash, ret));
    }

    function _run() internal returns (bytes32 logsHash, bytes32 rets, bytes32 state) {
        retHash = 0;
        uint256 id = dc.setCert(maker, address(wA), address(credit), 500e18, 38e6, 200e6, uint64(T0 + 10 days));
        usdg.mint(address(dc), 50_000e6);
        vm.recordLogs();

        _call(funder, abi.encodeCall(CurbCredit.fund, (1_000e6)));
        _call(alice, abi.encodeCall(CurbCredit.deposit, (address(wA), 100e18)));
        _call(alice, abi.encodeCall(CurbCredit.borrow, (address(wA), 99_000e6))); // refusal: ExceedsLtv
        _call(alice, abi.encodeCall(CurbCredit.borrow, (address(wA), 3000e6)));
        _call(alice, abi.encodeCall(CurbCredit.withdraw, (address(wA), 1e18))); // refusal: WouldBreach
        vm.warp(T0 + 1 days);
        _call(bob, abi.encodeCall(CurbCredit.repay, (alice, address(wA), 1e6)));
        sc.setPrice(address(wA), 40e18);
        _call(carol, abi.encodeCall(CurbCredit.flagBreach, (alice, address(wA))));
        for (uint256 i = 1; i <= 6; ++i) {
            vm.warp(T0 + 1 days + i * 300);
            _call(carol, abi.encodeCall(CurbCredit.tick, (alice, address(wA))));
        }
        _call(carol, abi.encodeCall(CurbCredit.liquidate, (alice, address(wA))));
        _call(admin, abi.encodeCall(CurbCredit.realise, (id, 10e18)));
        _call(admin, abi.encodeCall(CurbCredit.sweepSeized, (address(wA), 1e18, admin)));
        _call(alice, abi.encodeCall(CurbCredit.withdraw, (address(wA), 1e18)));
        _call(admin, abi.encodeCall(CurbCredit.defund, (1e6, admin)));
        _call(admin, abi.encodeCall(CurbCredit.transferAdmin, (bob)));
        _call(bob, abi.encodeCall(CurbCredit.acceptAdmin, ()));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            logsHash = keccak256(abi.encode(logsHash, logs[i].emitter, logs[i].topics, logs[i].data));
        }
        rets = retHash;
        state = keccak256(
            abi.encode(
                _digest(alice, address(wA)),
                credit.admin(),
                credit.pendingAdmin(),
                usdg.balanceOf(admin),
                wA.balanceOf(admin),
                logs.length
            )
        );
    }

    function test_builder_code_suffix_is_inert() public {
        uint256 snap = vm.snapshotState();
        tagged = false;
        (bytes32 l1, bytes32 r1, bytes32 s1) = _run();
        vm.revertToState(snap);
        vm.warp(T0);
        tagged = true;
        (bytes32 l2, bytes32 r2, bytes32 s2) = _run();
        assertEq(l1, l2, "same events");
        assertEq(r1, r2, "same return data");
        assertEq(s1, s2, "same state");
        assertTrue(l1 != bytes32(0));
    }
}
