// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {DepthCert} from "../src/DepthCert.sol";
import {IDepthCert} from "../src/interfaces/IDepthCert.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {SafeTransfer} from "../src/lib/SafeTransfer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

// --- test tokens -------------------------------------------------------------------------------

/// A USDG whose `transferFrom` burns `burn` gas before moving anything: close to the stipend, so a
/// stipend that arrived short would run out of gas and show up as a (fake) TRANSFER_FAILED fade.
contract HungryUSDG is IERC20 {
    uint8 public constant decimals = 6;
    uint256 public burn;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 burn_) { burn = burn_; }

    function mint(address to, uint256 a) external { balanceOf[to] += a; }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 start = gasleft();
        while (start - gasleft() < burn) {}
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// A standalone wrapper whose `transferFrom` re-enters DepthCert once, capturing the revert data.
contract ReentrantShares {
    DepthCert public dc;
    uint256 public targetId;
    bytes public reentryError;
    bool public reentered;
    mapping(address => uint256) public balanceOf;

    function arm(DepthCert dc_, uint256 id) external { dc = dc_; targetId = id; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (address(dc) != address(0)) {
            try dc.prune(address(this), address(0)) {
                reentered = true;
            } catch (bytes memory err) {
                reentryError = err;
            }
        }
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

// --- tests -------------------------------------------------------------------------------------

/// DepthCert unit tests, W4 spec section "DepthCert (P3)".
contract DepthCertTest is Test {
    event Posted(uint256 indexed id, address indexed maker, address indexed wrapper, address beneficiary,
        uint128 size, uint128 bidPx, uint128 bond, uint64 expiry);
    event Filled(uint256 indexed id, address indexed taker, uint128 shares, uint256 paid, uint128 remaining);
    event Faded(uint256 indexed id, address indexed taker, address indexed maker, uint128 shares, uint256 costOwed,
        uint128 bondSlashed, bytes4 reason);
    event Withdrawn(uint256 indexed id, address indexed maker, uint128 bond);
    event SharesClaimed(address indexed maker, address indexed wrapper, uint256 shares);

    /// Builder Code dd7u50nckt5e729f under ERC-8021 schema 0 (same constant as test/DataSuffix.t.sol).
    bytes constant SUFFIX = hex"6464377535306e636b74356537323966100080218021802180218021802180218021";

    // Defaults: 1 share bid at 50 USDG, so notional 50e6 and the minimum bond 5e6.
    uint128 constant SIZE = 1e18;
    uint128 constant PX = 50e6;
    uint128 constant BOND = 5e6;

    bytes4 constant R_ALLOWANCE = bytes4(keccak256("ALLOWANCE"));
    bytes4 constant R_BALANCE = bytes4(keccak256("BALANCE"));
    bytes4 constant R_TRANSFER_FAILED = bytes4(keccak256("TRANSFER_FAILED"));

    DepthCert dc;
    MockERC20 usdg;
    MockERC20 wrapper;
    MockERC20 wrapper2;

    address maker = makeAddr("maker");
    address maker2 = makeAddr("maker2");
    address taker = makeAddr("taker");
    address credit = makeAddr("credit"); // stands in for CurbCredit as a beneficiary
    address to = makeAddr("to");
    address stranger = makeAddr("stranger");

    uint64 t0;

    function setUp() public {
        vm.warp(1_790_000_000);
        t0 = uint64(block.timestamp);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        wrapper = new MockERC20("Wrapped TCENTx", "wTCENTx", 18);
        wrapper2 = new MockERC20("Wrapped NVDAx", "wNVDAx", 18);
        dc = new DepthCert(IERC20(address(usdg)));

        _fundMaker(maker, 10_000e6);
        _fundMaker(maker2, 10_000e6);
        _fundTaker(taker, 100e18);
        _fundTaker(credit, 100e18);
        _fundTaker(stranger, 100e18);
    }

    // --- helpers ---------------------------------------------------------------------------------

    function _fundMaker(address m, uint256 amt) internal {
        usdg.mint(m, amt);
        vm.prank(m);
        usdg.approve(address(dc), type(uint256).max);
    }

    function _fundTaker(address t, uint256 shares) internal {
        wrapper.mint(t, shares);
        wrapper2.mint(t, shares);
        vm.startPrank(t);
        wrapper.approve(address(dc), type(uint256).max);
        wrapper2.approve(address(dc), type(uint256).max);
        vm.stopPrank();
    }

    function _post(address m, address ben, uint128 size, uint128 px, uint64 life, uint128 bond)
        internal
        returns (uint256 id)
    {
        vm.prank(m);
        id = dc.post(address(wrapper), ben, size, px, uint64(block.timestamp) + life, bond);
    }

    function _postDefault() internal returns (uint256) {
        return _post(maker, address(0), SIZE, PX, 1 days, BOND);
    }

    function _take(address t, uint256 id, uint128 shares, address dst) internal returns (bool filled, uint256 amount) {
        vm.prank(t);
        return dc.take(id, shares, dst);
    }

    function _notional(uint256 s, uint256 px) internal pure returns (uint256) {
        return s * px / 1e18;
    }

    // --- post ------------------------------------------------------------------------------------

    function test_post_records_the_cert_and_pulls_the_bond() public {
        uint64 exp = t0 + 1 days;
        vm.expectEmit(address(dc));
        emit Posted(1, maker, address(wrapper), credit, SIZE, PX, BOND, exp);
        vm.prank(maker);
        uint256 id = dc.post(address(wrapper), credit, SIZE, PX, exp, BOND);

        assertEq(id, 1, "ids start at 1");
        assertEq(dc.nextId(), 2);
        IDepthCert.Cert memory c = dc.certOf(id);
        assertEq(c.maker, maker);
        assertEq(c.wrapper, address(wrapper));
        assertEq(c.beneficiary, credit);
        assertEq(c.sizeShares, SIZE);
        assertEq(c.remainingShares, SIZE);
        assertEq(c.bidPx, PX);
        assertEq(c.bond, BOND);
        assertEq(c.postedAt, t0);
        assertEq(c.expiry, exp);
        assertEq(uint8(c.status), uint8(IDepthCert.Status.LIVE));

        assertEq(usdg.balanceOf(address(dc)), BOND, "bond escrowed");
        assertEq(usdg.balanceOf(maker), 10_000e6 - BOND);
        assertEq(dc.totalBonds(), BOND);
        assertEq(dc.committed(maker), 50e6, "committed = notional(size, px)");
        uint256[] memory book = dc.bookOf(address(wrapper), credit);
        assertEq(book.length, 1);
        assertEq(book[0], id);
        assertEq(dc.bookOf(address(wrapper), address(0)).length, 0, "books are per beneficiary");
    }

    function test_unknown_cert_is_NONE() public view {
        assertEq(uint8(dc.certOf(42).status), uint8(IDepthCert.Status.NONE));
    }

    function test_constructor_rejects_zero_usdg() public {
        vm.expectRevert(DepthCert.ZeroAddress.selector);
        new DepthCert(IERC20(address(0)));
    }

    function test_post_rejects_zero_wrapper() public {
        vm.prank(maker);
        vm.expectRevert(DepthCert.ZeroAddress.selector);
        dc.post(address(0), address(0), SIZE, PX, t0 + 1 days, BOND);
    }

    function test_post_rejects_zero_notional() public {
        vm.startPrank(maker);
        vm.expectRevert(DepthCert.ZeroNotional.selector);
        dc.post(address(wrapper), address(0), 0, PX, t0 + 1 days, BOND);
        vm.expectRevert(DepthCert.ZeroNotional.selector);
        dc.post(address(wrapper), address(0), SIZE, 0, t0 + 1 days, BOND);
        // 0.5 share at 1 unit per share rounds to zero USDG units.
        vm.expectRevert(DepthCert.ZeroNotional.selector);
        dc.post(address(wrapper), address(0), 0.5e18, 1, t0 + 1 days, BOND);
        vm.stopPrank();
    }

    function test_post_min_bond_is_ten_percent_rounded_up() public {
        // notional 11 units -> 10% = 1.1 -> minimum bond 2.
        vm.startPrank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BondTooSmall.selector, 1, 2));
        dc.post(address(wrapper), address(0), 11e18, 1, t0 + 1 days, 1);
        dc.post(address(wrapper), address(0), 11e18, 1, t0 + 1 days, 2);
        // Exactly 10% of the default is enough, one unit less is not.
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BondTooSmall.selector, BOND - 1, BOND));
        dc.post(address(wrapper), address(0), SIZE, PX, t0 + 1 days, BOND - 1);
        dc.post(address(wrapper), address(0), SIZE, PX, t0 + 1 days, BOND);
        vm.stopPrank();
    }

    function testFuzz_post_min_bond(uint128 size, uint128 px) public {
        size = uint128(bound(size, 1, 1_000e18));
        px = uint128(bound(px, 1, 10_000e6));
        uint256 n = _notional(size, px);
        vm.assume(n > 0);
        uint256 minBond = (n * 1000 + 9999) / 10_000;
        assertGe(minBond * 10, n, "never under 10%");
        usdg.mint(maker, minBond);
        vm.startPrank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BondTooSmall.selector, minBond - 1, minBond));
        dc.post(address(wrapper), address(0), size, px, t0 + 1 days, uint128(minBond - 1));
        uint256 id = dc.post(address(wrapper), address(0), size, px, t0 + 1 days, uint128(minBond));
        vm.stopPrank();
        assertEq(dc.committed(maker), n);
        assertEq(dc.certOf(id).bond, minBond);
    }

    function test_post_life_bounds() public {
        uint64 lo = t0 + dc.MIN_LIFE();
        uint64 hi = t0 + dc.MAX_LIFE();
        vm.startPrank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BadExpiry.selector, lo - 1, lo, hi));
        dc.post(address(wrapper), address(0), SIZE, PX, lo - 1, BOND);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BadExpiry.selector, hi + 1, lo, hi));
        dc.post(address(wrapper), address(0), SIZE, PX, hi + 1, BOND);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BadExpiry.selector, t0 - 1, lo, hi));
        dc.post(address(wrapper), address(0), SIZE, PX, t0 - 1, BOND);
        dc.post(address(wrapper), address(0), SIZE, PX, lo, BOND);
        dc.post(address(wrapper), address(0), SIZE, PX, hi, BOND);
        vm.stopPrank();
        assertEq(dc.MIN_LIFE(), 10 minutes);
        assertEq(dc.MAX_LIFE(), 30 days);
    }

    function test_post_needs_the_bond() public {
        vm.prank(maker);
        usdg.approve(address(dc), BOND - 1);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(usdg)));
        dc.post(address(wrapper), address(0), SIZE, PX, t0 + 1 days, BOND);

        address poor = makeAddr("poor");
        _fundMaker(poor, BOND - 1);
        vm.prank(poor);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(usdg)));
        dc.post(address(wrapper), address(0), SIZE, PX, t0 + 1 days, BOND);

        usdg.setReturnFalse(true);
        vm.prank(maker2);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(usdg)));
        dc.post(address(wrapper), address(0), SIZE, PX, t0 + 1 days, BOND);
        assertEq(dc.totalBonds(), 0);
        assertEq(dc.nextId(), 1);
    }

    function test_constants() public view {
        assertEq(dc.MIN_BOND_BPS(), 1000);
        assertEq(dc.MAX_LIVE_PER_BOOK(), 8);
        assertEq(dc.TRANSFER_GAS(), 150_000);
        assertEq(dc.MIN_GAS_FOR_TRANSFER(), uint256(162_380)); // 150_000 + floor(150_000 / 63) + 10_000
        assertEq(dc.ALLOWANCE(), R_ALLOWANCE);
        assertEq(dc.BALANCE(), R_BALANCE);
        assertEq(dc.TRANSFER_FAILED(), R_TRANSFER_FAILED);
        assertEq(address(dc.usdg()), address(usdg));
    }

    // --- fill accounting ---------------------------------------------------------------------------

    function test_partial_fill_accounting() public {
        uint256 id = _postDefault();
        uint256 makerUsdg0 = usdg.balanceOf(maker);
        uint256 takerShares0 = wrapper.balanceOf(taker);

        vm.expectEmit(address(dc));
        emit Filled(id, taker, 0.4e18, 20e6, 0.6e18);
        (bool filled, uint256 amount) = _take(taker, id, 0.4e18, to);

        assertTrue(filled);
        assertEq(amount, 20e6, "amount = cost");
        assertEq(usdg.balanceOf(to), 20e6, "cost goes to `to`");
        assertEq(usdg.balanceOf(maker), makerUsdg0 - 20e6, "paid by the maker's wallet");
        assertEq(usdg.balanceOf(address(dc)), BOND, "only the bond stays");
        assertEq(wrapper.balanceOf(taker), takerShares0 - 0.4e18, "taker delivered");
        assertEq(wrapper.balanceOf(address(dc)), 0.4e18);
        assertEq(dc.claimableShares(maker, address(wrapper)), 0.4e18, "credited, not pushed");
        assertEq(wrapper.balanceOf(maker), 0);

        IDepthCert.Cert memory c = dc.certOf(id);
        assertEq(c.remainingShares, 0.6e18);
        assertEq(c.sizeShares, SIZE);
        assertEq(uint8(c.status), uint8(IDepthCert.Status.LIVE));
        assertEq(dc.committed(maker), 30e6);
        assertEq(dc.totalBonds(), BOND);
    }

    function test_full_fill_then_withdraw_before_expiry() public {
        uint256 id = _postDefault();
        _take(taker, id, 0.25e18, to);
        (bool filled, uint256 amount) = _take(taker, id, 0.75e18, to);
        assertTrue(filled);
        assertEq(amount, 37.5e6);
        assertEq(dc.certOf(id).remainingShares, 0);
        assertEq(dc.committed(maker), 0);
        assertEq(usdg.balanceOf(to), 50e6);

        vm.expectRevert(abi.encodeWithSelector(DepthCert.BadShares.selector, 1, 0));
        _take(taker, id, 1, to);

        // Filled in full, the bond comes back before expiry.
        vm.expectEmit(address(dc));
        emit Withdrawn(id, maker, BOND);
        vm.prank(maker);
        dc.withdraw(id);
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.CLOSED));
        assertEq(usdg.balanceOf(maker), 10_000e6 - 50e6);
        assertEq(dc.totalBonds(), 0);
        assertEq(usdg.balanceOf(address(dc)), 0);
    }

    function test_claimShares() public {
        uint256 id = _postDefault();
        _take(taker, id, 0.4e18, to);
        _take(taker, id, 0.1e18, to);

        address dst = makeAddr("dst");
        vm.expectEmit(address(dc));
        emit SharesClaimed(maker, address(wrapper), 0.5e18);
        vm.prank(maker);
        uint256 got = dc.claimShares(address(wrapper), dst);
        assertEq(got, 0.5e18);
        assertEq(wrapper.balanceOf(dst), 0.5e18);
        assertEq(dc.claimableShares(maker, address(wrapper)), 0);
        assertEq(wrapper.balanceOf(address(dc)), 0);

        // Nothing left: returns 0, moves nothing, emits nothing.
        vm.recordLogs();
        vm.prank(maker);
        assertEq(dc.claimShares(address(wrapper), dst), 0);
        assertEq(vm.getRecordedLogs().length, 0);

        // Only the maker's own claim; a stranger has none.
        vm.prank(stranger);
        assertEq(dc.claimShares(address(wrapper), stranger), 0);

        vm.prank(maker);
        vm.expectRevert(DepthCert.ZeroAddress.selector);
        dc.claimShares(address(wrapper), address(0));
    }

    function test_committed_is_recomputed_not_decremented() public {
        // 10 shares at 3 units per share: notional 30. A 1.5-share fill costs floor(4.5) = 4, and what
        // is left, 8.5 shares, is worth floor(25.5) = 25 -- not 30 - 4 = 26.
        uint256 id = _post(maker, address(0), 10e18, 3, 1 days, 3);
        (, uint256 paid) = _take(taker, id, 1.5e18, to);
        assertEq(paid, 4);
        assertEq(dc.committed(maker), 25);
        assertEq(dc.committed(maker), _notional(dc.certOf(id).remainingShares, 3));
    }

    function testFuzz_committed_tracks_notional_of_remaining(uint128 size, uint128 px, uint128[4] memory fills)
        public
    {
        size = uint128(bound(size, 1e12, 50e18));
        px = uint128(bound(px, 1, 5_000e6));
        uint256 n = _notional(size, px);
        vm.assume(n > 0);
        uint128 bond = uint128((n * 1000 + 9999) / 10_000);
        usdg.mint(maker, n + bond);
        uint256 id = _post(maker, address(0), size, px, 1 days, bond);
        // A second cert of the maker's so the sum is over more than one.
        uint256 id2 = _post(maker, address(0), 3e18, 7e6, 2 days, 2.1e6);

        for (uint256 i; i < fills.length; ++i) {
            uint128 rem = dc.certOf(id).remainingShares;
            if (rem == 0) break;
            uint128 s = uint128(bound(fills[i], 1, rem));
            if (_notional(s, px) == 0) continue;
            _take(taker, id, s, to);
            assertEq(
                dc.committed(maker),
                _notional(dc.certOf(id).remainingShares, px) + _notional(dc.certOf(id2).remainingShares, 7e6)
            );
        }
    }

    function test_take_rejects_zero_cost_and_bad_shares_and_zero_to() public {
        uint256 id = _post(maker, address(0), 10e18, 3, 1 days, 3);
        // 0.3 share at 3 units per share rounds to 0 USDG.
        vm.expectRevert(DepthCert.ZeroCost.selector);
        _take(taker, id, 0.3e18, to);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BadShares.selector, 0, 10e18));
        _take(taker, id, 0, to);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BadShares.selector, 10e18 + 1, 10e18));
        _take(taker, id, 10e18 + 1, to);
        vm.expectRevert(DepthCert.ZeroAddress.selector);
        _take(taker, id, 1e18, address(0));
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotLive.selector, 99));
        _take(taker, 99, 1e18, to);
    }

    // --- fades -----------------------------------------------------------------------------------

    function _assertFaded(uint256 id, uint256 takerShares0, uint256 toUsdg0) internal view {
        IDepthCert.Cert memory c = dc.certOf(id);
        assertEq(uint8(c.status), uint8(IDepthCert.Status.FADED), "status FADED");
        assertEq(usdg.balanceOf(to), toUsdg0 + c.bond, "the whole bond went to `to`");
        assertEq(wrapper.balanceOf(taker), takerShares0, "the taker kept their shares");
        assertEq(wrapper.balanceOf(address(dc)), 0);
        assertEq(dc.claimableShares(c.maker, address(wrapper)), 0);
        assertEq(dc.committed(c.maker), 0, "fade zeroes the cert's commitment");
        assertEq(dc.totalBonds(), 0);
        assertEq(usdg.balanceOf(address(dc)), 0);
    }

    function test_fade_on_revoked_allowance() public {
        uint256 id = _postDefault();
        vm.prank(maker);
        usdg.approve(address(dc), 0);
        uint256 s0 = wrapper.balanceOf(taker);
        uint256 makerUsdg0 = usdg.balanceOf(maker);

        vm.expectEmit(address(dc));
        emit Faded(id, taker, maker, 0.4e18, 20e6, BOND, R_ALLOWANCE);
        (bool filled, uint256 amount) = _take(taker, id, 0.4e18, to);

        assertFalse(filled);
        assertEq(amount, BOND, "amount = bond slashed");
        _assertFaded(id, s0, 0);
        assertEq(usdg.balanceOf(maker), makerUsdg0, "maker's wallet untouched");
        assertEq(dc.certOf(id).remainingShares, SIZE, "remaining is not reduced by a fade");
    }

    function test_fade_on_partial_allowance() public {
        uint256 id = _postDefault();
        vm.prank(maker);
        usdg.approve(address(dc), 20e6 - 1);
        vm.expectEmit(address(dc));
        emit Faded(id, taker, maker, 0.4e18, 20e6, BOND, R_ALLOWANCE);
        _take(taker, id, 0.4e18, to);
    }

    function test_fade_on_short_balance() public {
        uint256 id = _postDefault();
        uint256 bal = usdg.balanceOf(maker);
        vm.prank(maker);
        usdg.transfer(stranger, bal - (20e6 - 1));
        uint256 s0 = wrapper.balanceOf(taker);

        vm.expectEmit(address(dc));
        emit Faded(id, taker, maker, 0.4e18, 20e6, BOND, R_BALANCE);
        (bool filled, uint256 amount) = _take(taker, id, 0.4e18, to);
        assertFalse(filled);
        assertEq(amount, BOND);
        _assertFaded(id, s0, 0);
        assertEq(usdg.balanceOf(maker), 20e6 - 1);
    }

    function test_fade_on_frozen_maker() public {
        uint256 id = _postDefault();
        usdg.freeze(maker);
        uint256 s0 = wrapper.balanceOf(taker);

        vm.expectEmit(address(dc));
        emit Faded(id, taker, maker, 0.4e18, 20e6, BOND, R_TRANSFER_FAILED);
        (bool filled, uint256 amount) = _take(taker, id, 0.4e18, to);
        assertFalse(filled);
        assertEq(amount, BOND);
        _assertFaded(id, s0, 0);
        assertEq(usdg.balanceOf(maker), 10_000e6 - BOND, "a frozen wallet moved nothing");
    }

    function test_fade_on_false_returning_transferFrom() public {
        uint256 id = _postDefault();
        // The maker's pull returns false (and moves nothing); every other USDG move still works.
        vm.mockCall(
            address(usdg), abi.encodeCall(IERC20.transferFrom, (maker, address(dc), 20e6)), abi.encode(false)
        );
        uint256 s0 = wrapper.balanceOf(taker);
        vm.expectEmit(address(dc));
        emit Faded(id, taker, maker, 0.4e18, 20e6, BOND, R_TRANSFER_FAILED);
        (bool filled,) = _take(taker, id, 0.4e18, to);
        assertFalse(filled);
        _assertFaded(id, s0, 0);
    }

    function test_fade_on_malformed_return() public {
        uint256 id = _postDefault();
        // 32 bytes that are not `true`.
        vm.mockCall(
            address(usdg), abi.encodeCall(IERC20.transferFrom, (maker, address(dc), 20e6)), abi.encode(uint256(2))
        );
        (bool filled,) = _take(taker, id, 0.4e18, to);
        assertFalse(filled);
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.FADED));
    }

    /// A USDG that can move nothing at all (the MockERC20 `returnFalse` toggle, i.e. a global pause) cannot
    /// pay a fade's bond either, so the take reverts and nothing changes: no fade without a payout.
    function test_token_that_returns_false_everywhere_cannot_fade() public {
        uint256 id = _postDefault();
        usdg.setReturnFalse(true);
        uint256 s0 = wrapper.balanceOf(taker);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(usdg)));
        _take(taker, id, 0.4e18, to);
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.LIVE));
        assertEq(wrapper.balanceOf(taker), s0);
        assertEq(dc.totalBonds(), BOND);
        assertEq(usdg.balanceOf(address(dc)), BOND);
    }

    function test_frozen_recipient_reverts_the_whole_take() public {
        uint256 id = _postDefault();
        usdg.freeze(to);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(usdg)));
        _take(taker, id, 0.4e18, to);
        // ...and it is not the maker's fade: the same take to a clean address fills.
        (bool filled,) = _take(taker, id, 0.4e18, stranger);
        assertTrue(filled);
    }

    function test_a_faded_cert_is_dead() public {
        uint256 id = _postDefault();
        vm.prank(maker);
        usdg.approve(address(dc), 0);
        _take(taker, id, 0.4e18, to);

        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotLive.selector, id));
        _take(taker, id, 0.1e18, to);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotLive.selector, id));
        dc.withdraw(id);
    }

    function test_a_fade_only_slashes_the_cert_taken() public {
        uint256 a = _postDefault();
        uint256 b = _post(maker, address(0), 2e18, 40e6, 2 days, 8e6);
        assertEq(dc.committed(maker), 50e6 + 80e6);
        vm.prank(maker);
        usdg.approve(address(dc), 0);

        _take(taker, a, 0.4e18, to);
        assertEq(uint8(dc.certOf(b).status), uint8(IDepthCert.Status.LIVE));
        assertEq(dc.committed(maker), 80e6, "only the faded cert's commitment is dropped");
        assertEq(dc.totalBonds(), 8e6);
        assertEq(usdg.balanceOf(address(dc)), 8e6);
        assertEq(usdg.balanceOf(to), BOND);
    }

    // --- the taker delivers first ------------------------------------------------------------------

    function test_taker_without_shares_reverts_rather_than_fading() public {
        uint256 id = _postDefault();
        vm.prank(maker);
        usdg.approve(address(dc), 0); // the maker would fade if the maker leg were reached
        address empty = makeAddr("empty");
        vm.prank(empty);
        wrapper.approve(address(dc), type(uint256).max);

        vm.recordLogs();
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(wrapper)));
        _take(empty, id, 0.4e18, to);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.LIVE));
        assertEq(dc.totalBonds(), BOND);
        assertEq(usdg.balanceOf(to), 0);
    }

    function test_taker_short_of_shares_or_allowance_reverts() public {
        uint256 id = _postDefault();
        vm.prank(maker);
        usdg.approve(address(dc), 0);

        address thin = makeAddr("thin");
        wrapper.mint(thin, 0.4e18 - 1);
        vm.prank(thin);
        wrapper.approve(address(dc), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(wrapper)));
        _take(thin, id, 0.4e18, to);

        vm.prank(taker);
        wrapper.approve(address(dc), 0.4e18 - 1);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(wrapper)));
        _take(taker, id, 0.4e18, to);

        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.LIVE));
    }

    function test_taker_leg_false_return_reverts() public {
        uint256 id = _postDefault();
        vm.prank(maker);
        usdg.approve(address(dc), 0);
        wrapper.setReturnFalse(true);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(wrapper)));
        _take(taker, id, 0.4e18, to);
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.LIVE));
    }

    // --- gas: an able maker never fades --------------------------------------------------------------

    /// Send `take` with exactly `g` gas; whatever happens, an able maker's cert must not fade.
    function _takeWithGas(DepthCert d, uint256 id, uint128 shares, uint256 g)
        internal
        returns (bool ok, bytes memory ret, Vm.Log[] memory logs)
    {
        vm.recordLogs();
        vm.prank(taker);
        (ok, ret) = address(d).call{gas: g}(abi.encodeCall(DepthCert.take, (id, shares, to)));
        logs = vm.getRecordedLogs();
    }

    function _assertNoFade(DepthCert d, uint256 id, bool ok, bytes memory ret, Vm.Log[] memory logs) internal view {
        assertEq(uint8(d.certOf(id).status), uint8(IDepthCert.Status.LIVE), "an able maker faded");
        if (ok) {
            (bool filled,) = abi.decode(ret, (bool, uint256));
            assertTrue(filled, "a successful take of an able maker must fill");
            for (uint256 i; i < logs.length; ++i) {
                assertTrue(logs[i].topics[0] != Faded.selector, "Faded emitted for an able maker");
            }
        }
    }

    function testFuzz_able_maker_never_fades_whatever_gas(uint256 g) public {
        g = bound(g, 21_000, 1_000_000);
        uint256 id = _postDefault();
        uint256 makerUsdg0 = usdg.balanceOf(maker);
        (bool ok, bytes memory ret, Vm.Log[] memory logs) = _takeWithGas(dc, id, 0.4e18, g);
        _assertNoFade(dc, id, ok, ret, logs);
        if (ok) {
            assertEq(usdg.balanceOf(maker), makerUsdg0 - 20e6);
            assertEq(dc.certOf(id).remainingShares, 0.6e18);
        } else {
            assertEq(usdg.balanceOf(maker), makerUsdg0, "a starved take changes nothing");
            assertEq(dc.certOf(id).remainingShares, SIZE);
            assertEq(dc.totalBonds(), BOND);
        }
    }

    /// A HungryUSDG pull costs between 135k and 150k (checked below): the stipend covers it, but a stipend
    /// that ever arrived short would run out of gas and a naive contract would record TRANSFER_FAILED.
    uint256 constant HUNGRY_BURN = 125_000;

    function test_hungry_usdg_needs_most_of_the_stipend() public {
        (DepthCert d, HungryUSDG h,) = _hungryWorld(HUNGRY_BURN);
        vm.prank(maker);
        h.approve(address(this), type(uint256).max);
        bytes memory pull = abi.encodeCall(IERC20.transferFrom, (maker, address(d), 20e6));
        uint256 snap = vm.snapshotState();
        (bool ok,) = address(h).call{gas: 135_000}(pull);
        assertFalse(ok, "needs more than 135k");
        vm.revertToState(snap);
        (ok,) = address(h).call{gas: 150_000}(pull);
        assertTrue(ok, "fits the 150k stipend");
    }

    function testFuzz_able_maker_never_fades_with_a_gas_hungry_usdg(uint256 g) public {
        g = bound(g, 100_000, 600_000);
        (DepthCert d, HungryUSDG h, uint256 id) = _hungryWorld(HUNGRY_BURN);
        (bool ok, bytes memory ret, Vm.Log[] memory logs) = _takeWithGas(d, id, 0.4e18, g);
        _assertNoFade(d, id, ok, ret, logs);
        if (!ok) assertEq(h.balanceOf(maker), 1_000e6 - BOND);
    }

    function _hungryWorld(uint256 burn) internal returns (DepthCert d, HungryUSDG h, uint256 id) {
        h = new HungryUSDG(burn);
        d = new DepthCert(IERC20(address(h)));
        h.mint(maker, 1_000e6);
        vm.prank(maker);
        h.approve(address(d), type(uint256).max);
        vm.prank(taker);
        wrapper.approve(address(d), type(uint256).max);
        vm.prank(maker);
        id = d.post(address(wrapper), address(0), SIZE, PX, uint64(block.timestamp) + 1 days, BOND);
    }

    /// Sweep the gas: some takes revert `InsufficientGas`, some fill, none fade.
    function test_gas_sweep_reverts_or_fills_never_fades() public {
        uint256 insufficient;
        uint256 fills;
        for (uint256 g = 120_000; g < 420_000; g += 1_777) {
            uint256 snap = vm.snapshotState();
            (DepthCert d,, uint256 id) = _hungryWorld(HUNGRY_BURN);
            (bool ok, bytes memory ret, Vm.Log[] memory logs) = _takeWithGas(d, id, 0.4e18, g);
            _assertNoFade(d, id, ok, ret, logs);
            if (ok) ++fills;
            else if (ret.length == 4 && bytes4(ret) == DepthCert.InsufficientGas.selector) ++insufficient;
            vm.revertToState(snap);
        }
        assertGt(insufficient, 0, "the gas check fired");
        assertGt(fills, 0, "and enough gas fills");
    }

    function test_insufficient_gas_is_checked_only_for_an_able_maker() public {
        // With the allowance revoked the reason is decided by views, so no gas check applies and a
        // modest gas budget fades (truthfully).
        uint256 id = _postDefault();
        vm.prank(maker);
        usdg.approve(address(dc), 0);
        vm.prank(taker);
        (bool ok, bytes memory ret) =
            address(dc).call{gas: 150_000}(abi.encodeCall(DepthCert.take, (id, 0.4e18, to)));
        assertTrue(ok);
        (bool filled,) = abi.decode(ret, (bool, uint256));
        assertFalse(filled);
    }

    // --- beneficiary gating ------------------------------------------------------------------------

    function test_only_the_beneficiary_can_take() public {
        uint256 id = _post(maker, credit, SIZE, PX, 1 days, BOND);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotBeneficiary.selector, stranger, credit));
        _take(stranger, id, 0.4e18, to);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotBeneficiary.selector, taker, credit));
        _take(taker, id, 0.4e18, to);

        (bool filled,) = _take(credit, id, 0.4e18, to);
        assertTrue(filled);

        // Gating holds for fades too: a stranger cannot fade a revoked maker's gated cert.
        vm.prank(maker);
        usdg.approve(address(dc), 0);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotBeneficiary.selector, stranger, credit));
        _take(stranger, id, 0.1e18, to);
    }

    function test_open_cert_takeable_by_anyone() public {
        uint256 id = _postDefault();
        (bool a,) = _take(stranger, id, 0.1e18, to);
        (bool b,) = _take(credit, id, 0.1e18, to);
        assertTrue(a && b);
    }

    // --- expiry ------------------------------------------------------------------------------------

    function test_take_before_and_at_expiry() public {
        uint256 id = _postDefault();
        uint64 exp = dc.certOf(id).expiry;
        vm.warp(exp - 1);
        (bool filled,) = _take(taker, id, 0.1e18, to);
        assertTrue(filled);
        vm.warp(exp);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.CertExpired.selector, id, exp));
        _take(taker, id, 0.1e18, to);
        // An expired cert cannot be faded either.
        vm.prank(maker);
        usdg.approve(address(dc), 0);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.CertExpired.selector, id, exp));
        _take(taker, id, 0.1e18, to);
    }

    // --- withdraw ----------------------------------------------------------------------------------

    function test_withdraw_rules() public {
        uint256 id = _postDefault();
        _take(taker, id, 0.4e18, to);
        uint64 exp = dc.certOf(id).expiry;

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotWithdrawable.selector, id));
        dc.withdraw(id);
        vm.warp(exp - 1);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotWithdrawable.selector, id));
        dc.withdraw(id);

        vm.warp(exp);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotMaker.selector, stranger, maker));
        dc.withdraw(id);

        uint256 bal0 = usdg.balanceOf(maker);
        vm.expectEmit(address(dc));
        emit Withdrawn(id, maker, BOND);
        vm.prank(maker);
        dc.withdraw(id);
        assertEq(usdg.balanceOf(maker), bal0 + BOND);
        assertEq(dc.committed(maker), 0, "the unfilled remainder is released");
        assertEq(dc.totalBonds(), 0);
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.CLOSED));
        assertEq(dc.certOf(id).remainingShares, 0.6e18, "remaining kept as history");
        // The filled shares are still the maker's to claim.
        assertEq(dc.claimableShares(maker, address(wrapper)), 0.4e18);

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotLive.selector, id));
        dc.withdraw(id);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotLive.selector, 77));
        dc.withdraw(77);
    }

    // --- honouredDepth / isHonourable -----------------------------------------------------------------

    function test_isHonourable() public {
        assertTrue(dc.isHonourable(stranger), "nothing committed");
        vm.prank(maker);
        usdg.approve(address(dc), 0);
        assertTrue(dc.isHonourable(maker), "committed 0 needs no allowance");

        _fundMaker(maker, 0); // approve max again
        _postDefault();
        assertTrue(dc.isHonourable(maker));
        vm.prank(maker);
        usdg.approve(address(dc), 50e6 - 1);
        assertFalse(dc.isHonourable(maker), "allowance below committed");
        vm.prank(maker);
        usdg.approve(address(dc), 50e6);
        assertTrue(dc.isHonourable(maker));
        uint256 bal = usdg.balanceOf(maker);
        vm.prank(maker);
        usdg.transfer(stranger, bal - (50e6 - 1));
        assertFalse(dc.isHonourable(maker), "balance below committed");
    }

    function test_honouredDepth_filters() public {
        uint64 now_ = t0;
        // counted: maker, 1 share @ 50, expiry +2d
        _post(maker, credit, 1e18, 50e6, 2 days, 5e6);
        // counted: maker2, 2 shares @ 45, partly filled to 1.5, expiry +3d
        uint256 part = _post(maker2, credit, 2e18, 45e6, 3 days, 9e6);
        _take(credit, part, 0.5e18, to);
        // excluded by minExpiry: expiry +1h
        _post(maker, credit, 5e18, 40e6, 1 hours, 20e6);
        // excluded: filled in full
        uint256 full = _post(maker, credit, 1e18, 30e6, 2 days, 3e6);
        _take(credit, full, 1e18, to);
        // excluded: faded (a third maker revokes, gets faded)
        address m3 = makeAddr("m3");
        _fundMaker(m3, 1_000e6);
        uint256 faded = _post(m3, credit, 1e18, 20e6, 2 days, 2e6);
        vm.prank(m3);
        usdg.approve(address(dc), 0);
        _take(credit, faded, 0.5e18, to);
        // excluded: withdrawn after being filled
        uint256 closed = _post(maker2, credit, 1e18, 10e6, 2 days, 1e6);
        _take(credit, closed, 1e18, to);
        vm.prank(maker2);
        dc.withdraw(closed);
        // other books: open book, other wrapper
        _post(maker, address(0), 7e18, 60e6, 2 days, 42e6);
        vm.prank(maker);
        dc.post(address(wrapper2), credit, 9e18, 60e6, now_ + 2 days, 54e6);

        (uint256 shares, uint256 notional, uint128 minPx, uint64 soonest) =
            dc.honouredDepth(address(wrapper), credit, now_ + 1 days);
        assertEq(shares, 1e18 + 1.5e18);
        assertEq(notional, 50e6 + 67.5e6);
        assertEq(minPx, 45e6);
        assertEq(soonest, now_ + 2 days);

        // With minExpiry 0 the 1-hour cert counts too.
        (shares, notional, minPx, soonest) = dc.honouredDepth(address(wrapper), credit, 0);
        assertEq(shares, 1e18 + 1.5e18 + 5e18);
        assertEq(notional, 50e6 + 67.5e6 + 200e6);
        assertEq(minPx, 40e6);
        assertEq(soonest, now_ + 1 hours);

        // Past its expiry a LIVE (unwithdrawn) cert is not depth, whatever minExpiry says.
        vm.warp(now_ + 1 hours);
        (shares,,, soonest) = dc.honouredDepth(address(wrapper), credit, 0);
        assertEq(shares, 2.5e18);
        assertEq(soonest, now_ + 2 days);

        // A dishonourable maker drops out entirely.
        vm.prank(maker2);
        usdg.approve(address(dc), 0);
        (shares, notional, minPx,) = dc.honouredDepth(address(wrapper), credit, 0);
        assertEq(shares, 1e18);
        assertEq(notional, 50e6);
        assertEq(minPx, 50e6);

        // Empty book.
        (shares, notional, minPx, soonest) = dc.honouredDepth(address(wrapper2), address(0), 0);
        assertEq(shares + notional + minPx + soonest, 0);
    }

    function test_revoking_allowance_removes_all_of_a_makers_depth_at_once() public {
        _post(maker, credit, 1e18, 50e6, 2 days, 5e6);
        _post(maker, address(0), 2e18, 50e6, 2 days, 10e6);
        vm.prank(maker);
        dc.post(address(wrapper2), credit, 1e18, 200e6, t0 + 2 days, 20e6);
        _post(maker2, credit, 1e18, 48e6, 2 days, 4.8e6);

        (uint256 s,,,) = dc.honouredDepth(address(wrapper), credit, 0);
        assertEq(s, 2e18);
        // Covering all but one unit of the maker's total commitment (50 + 100 + 200) is not enough.
        vm.prank(maker);
        usdg.approve(address(dc), 350e6 - 1);
        (s,,,) = dc.honouredDepth(address(wrapper), credit, 0);
        assertEq(s, 1e18, "only maker2 is left");
        (s,,,) = dc.honouredDepth(address(wrapper), address(0), 0);
        assertEq(s, 0);
        (s,,,) = dc.honouredDepth(address(wrapper2), credit, 0);
        assertEq(s, 0);

        vm.prank(maker);
        usdg.approve(address(dc), 350e6);
        (s,,,) = dc.honouredDepth(address(wrapper), credit, 0);
        assertEq(s, 2e18, "restored");
    }

    // --- book limit + prune ------------------------------------------------------------------------

    function test_book_limit_and_prune() public {
        uint256[] memory ids = new uint256[](8);
        for (uint256 i; i < 8; ++i) ids[i] = _post(maker, credit, 1e18, 50e6, uint64(1 hours + i * 1 hours), 5e6);
        assertEq(dc.bookOf(address(wrapper), credit).length, 8);

        vm.prank(maker2);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BookFull.selector, address(wrapper), credit));
        dc.post(address(wrapper), credit, 1e18, 50e6, t0 + 1 days, 5e6);

        // Other books are independent.
        _post(maker2, address(0), 1e18, 50e6, 1 days, 5e6);
        vm.prank(maker2);
        dc.post(address(wrapper2), credit, 1e18, 50e6, t0 + 1 days, 5e6);

        // prune keeps every takeable cert, in order.
        dc.prune(address(wrapper), credit);
        assertEq(dc.bookOf(address(wrapper), credit).length, 8);

        // Retire two: one filled in full, one expired.
        _take(credit, ids[2], 1e18, to);
        vm.warp(t0 + 1 hours); // ids[0] expires
        address m3 = makeAddr("m3");
        _fundMaker(m3, 100e6);

        // A stranger prunes (permissionless).
        vm.prank(stranger);
        dc.prune(address(wrapper), credit);
        uint256[] memory book = dc.bookOf(address(wrapper), credit);
        assertEq(book.length, 6);
        assertEq(book[0], ids[1]);
        assertEq(book[1], ids[3]);
        assertEq(book[5], ids[7]);
        // Pruning removed nothing but book entries: the expired cert's bond is still the maker's.
        assertEq(uint8(dc.certOf(ids[0]).status), uint8(IDepthCert.Status.LIVE));
        vm.prank(maker);
        dc.withdraw(ids[0]);

        // Room for two again.
        uint256 x = _post(m3, credit, 1e18, 50e6, 1 days, 5e6);
        _post(m3, credit, 1e18, 50e6, 1 days, 5e6);
        vm.prank(maker2);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.BookFull.selector, address(wrapper), credit));
        dc.post(address(wrapper), credit, 1e18, 50e6, uint64(block.timestamp) + 1 days, 5e6);

        // A fade frees a slot, and post compacts a full book by itself (no prune needed).
        vm.prank(m3);
        usdg.approve(address(dc), 0);
        (bool filled,) = _take(credit, x, 0.5e18, to);
        assertFalse(filled);
        assertEq(dc.bookOf(address(wrapper), credit).length, 8, "the faded entry is still listed");
        _post(maker2, credit, 1e18, 50e6, 1 days, 5e6);
        assertEq(dc.bookOf(address(wrapper), credit).length, 8);
    }

    function test_honouredDepth_loop_is_bounded_by_the_book() public {
        for (uint256 i; i < 8; ++i) _post(maker, credit, 1e18, uint128(50e6 - i), 1 days, 5e6);
        uint256 g = gasleft();
        dc.honouredDepth(address(wrapper), credit, 0);
        assertLt(g - gasleft(), 300_000, "a full book stays cheap to read");
    }

    // --- reentrancy --------------------------------------------------------------------------------

    function test_reentrancy_is_blocked() public {
        ReentrantShares evil = new ReentrantShares();
        vm.prank(maker);
        uint256 id = dc.post(address(evil), address(0), SIZE, PX, t0 + 1 days, BOND);
        evil.mint(taker, 1e18);
        evil.arm(dc, id);

        (bool filled,) = _take(taker, id, 0.4e18, to);
        assertTrue(filled, "the outer take completes");
        assertFalse(evil.reentered(), "the inner call was refused");
        assertEq(evil.reentryError(), abi.encodeWithSelector(DepthCert.Reentrancy.selector));
    }

    // --- Builder Code suffix (ERC-8021) -----------------------------------------------------------------

    /// Every entry point, sent once plain to one DepthCert and once with the Builder Code appended to a
    /// twin, must return the same bytes, emit the same DepthCert events and leave the same state.
    function test_builder_code_suffix_gives_identical_results_on_every_entry_point() public {
        DepthCert plain = dc;
        DepthCert tagged = new DepthCert(IERC20(address(usdg)));
        vm.prank(maker);
        usdg.approve(address(tagged), type(uint256).max);
        vm.prank(maker2);
        usdg.approve(address(tagged), type(uint256).max);
        vm.startPrank(credit);
        wrapper.approve(address(tagged), type(uint256).max);
        vm.stopPrank();
        vm.prank(taker);
        wrapper.approve(address(tagged), type(uint256).max);

        uint64 exp = t0 + 1 days;
        // post (x2: one to fill, one to fade)
        _twin(maker, plain, tagged, abi.encodeCall(DepthCert.post, (address(wrapper), credit, SIZE, PX, exp, BOND)));
        _twin(maker2, plain, tagged, abi.encodeCall(DepthCert.post, (address(wrapper), address(0), SIZE, PX, exp, BOND)));
        // take -> fill (partial, then the rest)
        _twin(credit, plain, tagged, abi.encodeCall(DepthCert.take, (1, 0.4e18, to)));
        _twin(credit, plain, tagged, abi.encodeCall(DepthCert.take, (1, 0.6e18, to)));
        // claimShares
        _twin(maker, plain, tagged, abi.encodeCall(DepthCert.claimShares, (address(wrapper), maker)));
        // withdraw (filled in full)
        _twin(maker, plain, tagged, abi.encodeCall(DepthCert.withdraw, (1)));
        // take -> fade
        vm.startPrank(maker2);
        usdg.approve(address(plain), 0);
        usdg.approve(address(tagged), 0);
        vm.stopPrank();
        _twin(taker, plain, tagged, abi.encodeCall(DepthCert.take, (2, 0.5e18, to)));
        // prune
        _twin(stranger, plain, tagged, abi.encodeCall(DepthCert.prune, (address(wrapper), credit)));
        _twin(stranger, plain, tagged, abi.encodeCall(DepthCert.prune, (address(wrapper), address(0))));

        // State, compared view by view.
        for (uint256 id = 1; id <= 2; ++id) {
            _same(plain, tagged, abi.encodeCall(DepthCert.certOf, (id)));
        }
        assertEq(uint8(tagged.certOf(1).status), uint8(IDepthCert.Status.CLOSED), "a real sequence, not a no-op");
        assertEq(uint8(tagged.certOf(2).status), uint8(IDepthCert.Status.FADED));
        _same(plain, tagged, abi.encodeWithSelector(plain.nextId.selector));
        _same(plain, tagged, abi.encodeWithSelector(plain.totalBonds.selector));
        _same(plain, tagged, abi.encodeWithSelector(plain.committed.selector, maker));
        _same(plain, tagged, abi.encodeWithSelector(plain.committed.selector, maker2));
        _same(plain, tagged, abi.encodeWithSelector(plain.claimableShares.selector, maker, address(wrapper)));
        _same(plain, tagged, abi.encodeCall(DepthCert.bookOf, (address(wrapper), credit)));
        _same(plain, tagged, abi.encodeCall(DepthCert.bookOf, (address(wrapper), address(0))));
        _same(plain, tagged, abi.encodeCall(DepthCert.honouredDepth, (address(wrapper), credit, 0)));
        _same(plain, tagged, abi.encodeCall(DepthCert.isHonourable, (maker2)));
        assertEq(usdg.balanceOf(address(plain)), usdg.balanceOf(address(tagged)));
        assertEq(wrapper.balanceOf(address(plain)), wrapper.balanceOf(address(tagged)));

        // A suffix does not get a stranger past the beneficiary gate or the maker check.
        vm.prank(maker);
        tagged.post(address(wrapper), credit, SIZE, PX, exp, BOND);
        vm.prank(stranger);
        (bool ok, bytes memory err) =
            address(tagged).call(abi.encodePacked(abi.encodeCall(DepthCert.take, (3, 0.1e18, to)), SUFFIX));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(DepthCert.NotBeneficiary.selector, stranger, credit));
        vm.prank(stranger);
        (ok, err) = address(tagged).call(abi.encodePacked(abi.encodeCall(DepthCert.withdraw, (3)), SUFFIX));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(DepthCert.NotMaker.selector, stranger, maker));
    }

    function _twin(address from, DepthCert plain, DepthCert tagged, bytes memory data) internal {
        vm.recordLogs();
        vm.prank(from);
        (bool ok1, bytes memory r1) = address(plain).call(data);
        Vm.Log[] memory l1 = vm.getRecordedLogs();
        assertTrue(ok1, "the plain call reverted");

        bytes memory suffixed = abi.encodePacked(data, SUFFIX);
        assertEq(suffixed.length, data.length + 34);
        vm.recordLogs();
        vm.prank(from);
        (bool ok2, bytes memory r2) = address(tagged).call(suffixed);
        Vm.Log[] memory l2 = vm.getRecordedLogs();
        assertTrue(ok2, "the suffixed call reverted");

        assertEq(r1, r2, "same return data");
        assertEq(l1.length, l2.length, "same number of logs");
        for (uint256 i; i < l1.length; ++i) {
            if (l1[i].emitter == address(plain)) {
                assertEq(l2[i].emitter, address(tagged));
                assertEq(l1[i].topics, l2[i].topics, "same event topics");
                assertEq(l1[i].data, l2[i].data, "same event data");
            } else {
                // Token events differ only where they name the DepthCert itself.
                assertEq(l1[i].emitter, l2[i].emitter);
                assertEq(l1[i].topics[0], l2[i].topics[0]);
                assertEq(l1[i].data, l2[i].data);
            }
        }
    }

    function _same(DepthCert a, DepthCert b, bytes memory call) internal view {
        (bool ok1, bytes memory r1) = address(a).staticcall(call);
        (bool ok2, bytes memory r2) = address(b).staticcall(call);
        assertTrue(ok1 && ok2, "view reverted");
        assertEq(r1, r2, "the two worlds disagree");
    }
}
