// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {DepthCert} from "../../src/DepthCert.sol";
import {IDepthCert} from "../../src/interfaces/IDepthCert.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {SafeTransfer} from "../../src/lib/SafeTransfer.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {MockEligibility} from "../DepthCert.t.sol";

/// The admin and compliance surface of the live USDG (Paxos Global Dollar, EIP-1967 proxy whose
/// implementation routes pause/freeze to a facet). Read from the bytecode on 24 Sep 2026: the
/// implementation holds ERC-20 + AccessControlDefaultAdminRules + supply control; the facet it
/// dispatches to holds pause()/unpause()/paused() and freeze(address)/unfreeze(address)/isFrozen(address).
interface IPaxosLike {
    function defaultAdmin() external view returns (address);
    function grantRole(bytes32 role, address who) external;
    function hasRole(bytes32 role, address who) external view returns (bool);
    function freeze(address who) external;
    function isFrozen(address who) external view returns (bool);
    function pause() external;
    function paused() external view returns (bool);
}

/// Calls `transferFrom` exactly as DepthCert's maker leg does (low-level, fixed stipend) and reports the gas
/// the call consumed, CALL overhead included, so the figure is an upper bound on what the token itself uses.
contract TransferFromGasProbe {
    function measure(address token, address from, uint256 amount, uint256 stipend)
        external
        returns (bool ok, uint256 used)
    {
        bytes memory data = abi.encodeCall(IERC20.transferFrom, (from, address(this), amount));
        uint256 g0 = gasleft();
        (ok,) = token.call{gas: stipend}(data);
        used = g0 - gasleft();
    }

    /// The same pull preceded, in the same frame, by the two views DepthCert makes first.
    function measureAfterViews(address token, address from, uint256 amount, uint256 stipend)
        external
        returns (bool ok, uint256 used)
    {
        IERC20(token).allowance(from, address(this));
        IERC20(token).balanceOf(from);
        bytes memory data = abi.encodeCall(IERC20.transferFrom, (from, address(this), amount));
        uint256 g0 = gasleft();
        (ok,) = token.call{gas: stipend}(data);
        used = g0 - gasleft();
    }
}

/// DepthCert against the real X Layer USDG and wTCENTx.
///
/// The fade is only self-proving if an able maker's USDG pull always fits the stipend. So the first thing
/// measured is the real USDG `transferFrom` from a fully cold start (every account and slot cold, a fresh
/// recipient whose balance goes 0 -> nonzero, a finite allowance being decremented): the worst case the
/// maker leg can meet. It must use less than half of TRANSFER_GAS. Then a real fill, a real fade, and --
/// because USDG does have freeze and pause -- a real frozen-maker fade and a paused-token no-fade.
contract DepthCertForkTest is Test {
    address constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant POOL_TCENT = 0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f; // holds USDG and wTCENTx
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 constant ASSET_PROTECTION_ROLE = keccak256("ASSET_PROTECTION_ROLE");
    bytes32 constant PAUSE_ROLE = keccak256("PAUSE_ROLE");

    DepthCert dc;
    MockEligibility elig; // stands in for EligibilityRegistry (P2), which DeployW4 passes in
    address maker = makeAddr("fork-maker");
    address taker = makeAddr("fork-taker");
    address to = makeAddr("fork-to");

    // 0.02 wTCENTx bid at 52 USDG a share (live price ~55): notional 1.04 USDG, bond >= 0.104 USDG.
    uint128 constant SIZE = 0.02e18;
    uint128 constant PX = 52e6;
    uint128 constant BOND = 0.2e6;

    function setUp() public {
        vm.createSelectFork("xlayer");
        elig = new MockEligibility();
        elig.set(maker, true);
        dc = new DepthCert(IERC20(USDG), IEligibility(address(elig)));

        vm.startPrank(POOL_TCENT);
        IERC20(USDG).transfer(maker, 100e6);
        IERC20(W_TCENT).transfer(taker, 1e18);
        vm.stopPrank();

        vm.prank(maker);
        IERC20(USDG).approve(address(dc), type(uint256).max);
        vm.prank(taker);
        IERC20(W_TCENT).approve(address(dc), type(uint256).max);
    }

    function _post() internal returns (uint256 id) {
        vm.prank(maker);
        id = dc.post(W_TCENT, address(0), SIZE, PX, uint64(block.timestamp + 1 days), BOND);
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(USDG, IMPL_SLOT))));
    }

    function _grant(bytes32 role, address who) internal {
        address admin = IPaxosLike(USDG).defaultAdmin();
        vm.prank(admin);
        IPaxosLike(USDG).grantRole(role, who);
        assertTrue(IPaxosLike(USDG).hasRole(role, who));
    }

    // --- the stipend -------------------------------------------------------------------------------------

    function test_real_usdg_transferFrom_uses_under_half_the_stipend() public {
        assertEq(IERC20(USDG).decimals(), 6);
        console2.log("USDG implementation:", _impl());

        TransferFromGasProbe probe = new TransferFromGasProbe();
        vm.prank(maker);
        IERC20(USDG).approve(address(probe), 50e6); // finite, so the allowance is decremented too

        // Worst case: USDG, its implementation and every slot cold; the recipient's balance goes 0 -> nonzero.
        // (In this Forge each top-level call from the test starts with every account and slot cold -- checked
        // on this fork: a repeated top-level balanceOf costs the same 10.5k, a repeat inside one frame 1.5k.)
        (bool ok, uint256 cold) = probe.measure(USDG, maker, 1.04e6, dc.TRANSFER_GAS());
        assertTrue(ok, "real USDG transferFrom failed under the stipend");
        assertEq(IERC20(USDG).balanceOf(address(probe)), 1.04e6);

        // As DepthCert meets it: the allowance/balance views have just warmed the token and the maker's
        // slots in the same frame, and the recipient already holds USDG (DepthCert holds the bonds).
        (bool ok2, uint256 warm) = probe.measureAfterViews(USDG, maker, 1.04e6, dc.TRANSFER_GAS());
        assertTrue(ok2);

        console2.log("USDG transferFrom gas, fully cold (upper bound):", cold);
        console2.log("USDG transferFrom gas, as in take (views first):", warm);
        console2.log("TRANSFER_GAS / 2:                                ", dc.TRANSFER_GAS() / 2);
        assertLt(cold, dc.TRANSFER_GAS() / 2, "real USDG transferFrom must use < TRANSFER_GAS/2");
        assertLt(warm, cold);
    }

    // --- a real fill -------------------------------------------------------------------------------------

    function test_real_fill_on_live_usdg_and_wtcentx() public {
        uint256 id = _post();
        assertEq(IERC20(USDG).balanceOf(address(dc)), BOND);
        assertEq(dc.committed(maker), 1.04e6);
        (uint256 depth, uint256 notional, uint128 minPx,) = dc.honouredDepth(W_TCENT, address(0), 0);
        assertEq(depth, SIZE);
        assertEq(notional, 1.04e6);
        assertEq(minPx, PX);

        uint256 makerUsdg0 = IERC20(USDG).balanceOf(maker);
        uint256 takerW0 = IERC20(W_TCENT).balanceOf(taker);

        vm.prank(taker);
        uint256 g = gasleft();
        (bool filled, uint256 amount) = dc.take(id, SIZE, to);
        console2.log("take (fill, cold) gas:", g - gasleft());

        assertTrue(filled);
        assertEq(amount, 1.04e6);
        assertEq(IERC20(USDG).balanceOf(to), 1.04e6, "taker's `to` was paid in real USDG");
        assertEq(IERC20(USDG).balanceOf(maker), makerUsdg0 - 1.04e6);
        assertEq(IERC20(W_TCENT).balanceOf(taker), takerW0 - SIZE);
        assertEq(IERC20(W_TCENT).balanceOf(address(dc)), SIZE);
        assertEq(dc.claimableShares(maker, W_TCENT), SIZE);
        assertEq(dc.committed(maker), 0);

        vm.prank(maker);
        assertEq(dc.claimShares(W_TCENT, maker), SIZE);
        assertEq(IERC20(W_TCENT).balanceOf(maker), SIZE, "real wTCENTx delivered to the maker");

        vm.prank(maker);
        dc.withdraw(id);
        assertEq(IERC20(USDG).balanceOf(maker), makerUsdg0 - 1.04e6 + BOND);
        assertEq(IERC20(USDG).balanceOf(address(dc)), 0);
        assertEq(IERC20(W_TCENT).balanceOf(address(dc)), 0);
    }

    // --- maker eligibility --------------------------------------------------------------------------------

    /// A cert reserved for one taker (as K's cert for CurbCredit will be) needs an eligible maker; the
    /// eligible one fills for its beneficiary with real tokens.
    function test_real_gated_cert_needs_an_eligible_maker() public {
        address credit = makeAddr("fork-credit");
        address outsider = makeAddr("fork-outsider");
        vm.prank(POOL_TCENT);
        IERC20(USDG).transfer(outsider, 10e6);
        vm.prank(outsider);
        IERC20(USDG).approve(address(dc), type(uint256).max);
        vm.prank(outsider);
        vm.expectRevert(DepthCert.IneligibleMaker.selector);
        dc.post(W_TCENT, credit, SIZE, 1, uint64(block.timestamp + 30 days), 1);

        vm.prank(maker);
        uint256 id = dc.post(W_TCENT, credit, SIZE, PX, uint64(block.timestamp + 26 hours), BOND);
        (uint256 depth,, uint128 minPx,) = dc.honouredDepth(W_TCENT, credit, uint64(block.timestamp + 1 hours));
        assertEq(depth, SIZE);
        assertEq(minPx, PX);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(DepthCert.NotBeneficiary.selector, taker, credit));
        dc.take(id, SIZE, to);

        vm.prank(POOL_TCENT);
        IERC20(W_TCENT).transfer(credit, SIZE);
        vm.prank(credit);
        IERC20(W_TCENT).approve(address(dc), SIZE);
        vm.prank(credit);
        (bool filled, uint256 amount) = dc.take(id, SIZE, credit);
        assertTrue(filled);
        assertEq(amount, 1.04e6);
        assertEq(IERC20(USDG).balanceOf(credit), 1.04e6);
    }

    // --- real fades --------------------------------------------------------------------------------------

    function _assertFaded(uint256 id, bytes4 reason, Vm.Log[] memory logs, uint256 takerW0) internal view {
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.FADED));
        assertEq(IERC20(USDG).balanceOf(to), BOND, "the whole bond went to the taker's `to`");
        assertEq(IERC20(W_TCENT).balanceOf(taker), takerW0, "the taker kept their wTCENTx");
        assertEq(IERC20(USDG).balanceOf(address(dc)), 0);
        assertEq(IERC20(W_TCENT).balanceOf(address(dc)), 0);
        assertEq(dc.totalBonds(), 0);
        assertEq(dc.committed(maker), 0);
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(dc) || logs[i].topics[0] != DepthCert.Faded.selector) continue;
            // data = (shares, costOwed, bondSlashed, reason)
            (uint128 shares, uint256 costOwed, uint128 slashed, bytes4 why) =
                abi.decode(logs[i].data, (uint128, uint256, uint128, bytes4));
            assertEq(shares, SIZE);
            assertEq(costOwed, 1.04e6);
            assertEq(slashed, BOND);
            assertEq(why, reason, "fade reason");
            seen = true;
        }
        assertTrue(seen, "Faded emitted");
    }

    function test_real_fade_revoked_allowance() public {
        uint256 id = _post();
        vm.prank(maker);
        IERC20(USDG).approve(address(dc), 0);
        assertFalse(dc.isHonourable(maker));
        (uint256 depth,,,) = dc.honouredDepth(W_TCENT, address(0), 0);
        assertEq(depth, 0, "a revoked maker shows no depth");

        uint256 takerW0 = IERC20(W_TCENT).balanceOf(taker);
        vm.recordLogs();
        vm.prank(taker);
        (bool filled, uint256 amount) = dc.take(id, SIZE, to);
        assertFalse(filled);
        assertEq(amount, BOND);
        _assertFaded(id, dc.ALLOWANCE(), vm.getRecordedLogs(), takerW0);
    }

    function test_real_fade_frozen_maker() public {
        uint256 id = _post();
        // Freeze the maker the way Paxos would: the default admin grants the asset-protection role, which freezes.
        address freezer = makeAddr("freezer");
        _grant(ASSET_PROTECTION_ROLE, freezer);
        vm.prank(freezer);
        IPaxosLike(USDG).freeze(maker);
        assertTrue(IPaxosLike(USDG).isFrozen(maker), "maker frozen on the real token");
        // Allowance and balance still read as enough, so only the pull itself can fail.
        assertGe(IERC20(USDG).allowance(maker, address(dc)), 1.04e6);
        assertGe(IERC20(USDG).balanceOf(maker), 1.04e6);

        uint256 takerW0 = IERC20(W_TCENT).balanceOf(taker);
        vm.recordLogs();
        vm.prank(taker);
        (bool filled, uint256 amount) = dc.take(id, SIZE, to);
        assertFalse(filled);
        assertEq(amount, BOND);
        _assertFaded(id, dc.TRANSFER_FAILED(), vm.getRecordedLogs(), takerW0);
    }

    function test_real_fade_short_balance() public {
        uint256 id = _post();
        uint256 bal = IERC20(USDG).balanceOf(maker);
        vm.prank(maker);
        IERC20(USDG).transfer(address(0xdead), bal - 1e6); // leaves 1.00 USDG < 1.04 cost
        uint256 takerW0 = IERC20(W_TCENT).balanceOf(taker);
        vm.recordLogs();
        vm.prank(taker);
        (bool filled,) = dc.take(id, SIZE, to);
        assertFalse(filled);
        _assertFaded(id, dc.BALANCE(), vm.getRecordedLogs(), takerW0);
    }

    /// Paused USDG moves nothing, so the bond cannot be paid either: the take reverts and nobody is faded.
    function test_real_paused_usdg_means_no_fade() public {
        uint256 id = _post();
        address pauser = makeAddr("pauser");
        _grant(PAUSE_ROLE, pauser);
        vm.prank(pauser);
        IPaxosLike(USDG).pause();
        assertTrue(IPaxosLike(USDG).paused());

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, USDG));
        dc.take(id, SIZE, to);
        assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.LIVE));
    }

    // --- gas: an able maker never fades, on the real token ---------------------------------------------------

    function test_real_gas_sweep_never_fades_an_able_maker() public {
        uint256 id = _post();
        uint256 fills;
        uint256 starved;
        for (uint256 g = 60_000; g < 460_000; g += 8_000) {
            uint256 snap = vm.snapshotState();
            vm.recordLogs();
            vm.prank(taker);
            (bool ok, bytes memory ret) = address(dc).call{gas: g}(abi.encodeCall(DepthCert.take, (id, SIZE, to)));
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(uint8(dc.certOf(id).status), uint8(IDepthCert.Status.LIVE), "an able maker faded");
            if (ok) {
                (bool filled,) = abi.decode(ret, (bool, uint256));
                assertTrue(filled);
                for (uint256 i; i < logs.length; ++i) {
                    assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != DepthCert.Faded.selector);
                }
                ++fills;
            } else if (ret.length == 4 && bytes4(ret) == DepthCert.InsufficientGas.selector) {
                ++starved;
            }
            vm.revertToState(snap);
        }
        console2.log("gas sweep: fills", fills, "InsufficientGas reverts", starved);
        assertGt(fills, 0);
        assertGt(starved, 0);
    }
}
