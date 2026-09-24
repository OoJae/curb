// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";

contract EligibilityRegistryTest is Test {
    bytes constant SUFFIX = hex"6464377535306e636b74356537323966100080218021802180218021802180218021";

    EligibilityRegistry reg;
    address admin = makeAddr("admin");
    address next = makeAddr("next");
    address desk = 0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E;
    address stranger = makeAddr("stranger");

    function setUp() public {
        reg = new EligibilityRegistry(admin);
    }

    function test_constructor_sets_admin_and_rejects_zero() public {
        assertEq(reg.admin(), admin);
        assertEq(reg.pendingAdmin(), address(0));
        vm.expectRevert(EligibilityRegistry.ZeroAddress.selector);
        new EligibilityRegistry(address(0));
    }

    function test_setEligible_records_and_emits_evidence() public {
        assertFalse(reg.isEligible(desk));
        bytes32 ev = keccak256("team:curb-desk");
        vm.expectEmit(true, true, true, true, address(reg));
        emit EligibilityRegistry.EligibilitySet(desk, true, ev);
        vm.prank(admin);
        reg.setEligible(desk, true, ev);
        assertTrue(reg.isEligible(desk));
        assertTrue(IEligibility(address(reg)).isEligible(desk), "IEligibility view");

        vm.expectEmit(true, true, true, true, address(reg));
        emit EligibilityRegistry.EligibilitySet(desk, false, bytes32("revoked"));
        vm.prank(admin);
        reg.setEligible(desk, false, bytes32("revoked"));
        assertFalse(reg.isEligible(desk));
    }

    function test_setEligible_only_admin_and_nonzero() public {
        vm.prank(stranger);
        vm.expectRevert(EligibilityRegistry.NotAdmin.selector);
        reg.setEligible(stranger, true, bytes32(0));
        vm.prank(admin);
        vm.expectRevert(EligibilityRegistry.ZeroAddress.selector);
        reg.setEligible(address(0), true, bytes32(0));
    }

    function test_two_step_admin_handover() public {
        vm.prank(stranger);
        vm.expectRevert(EligibilityRegistry.NotAdmin.selector);
        reg.transferAdmin(stranger);
        vm.prank(admin);
        vm.expectRevert(EligibilityRegistry.ZeroAddress.selector);
        reg.transferAdmin(address(0));

        vm.expectEmit(true, true, true, true, address(reg));
        emit EligibilityRegistry.AdminTransferStarted(admin, next);
        vm.prank(admin);
        reg.transferAdmin(next);
        assertEq(reg.pendingAdmin(), next);
        assertEq(reg.admin(), admin, "nothing changes until accepted");

        vm.prank(stranger);
        vm.expectRevert(EligibilityRegistry.NotPendingAdmin.selector);
        reg.acceptAdmin();
        vm.prank(admin);
        vm.expectRevert(EligibilityRegistry.NotPendingAdmin.selector);
        reg.acceptAdmin();

        vm.expectEmit(true, true, true, true, address(reg));
        emit EligibilityRegistry.AdminTransferred(admin, next);
        vm.prank(next);
        reg.acceptAdmin();
        assertEq(reg.admin(), next);
        assertEq(reg.pendingAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(EligibilityRegistry.NotAdmin.selector);
        reg.setEligible(desk, true, bytes32(0));
        vm.prank(next);
        reg.setEligible(desk, true, bytes32(0));
        assertTrue(reg.isEligible(desk));

        // a second accept is refused
        vm.prank(next);
        vm.expectRevert(EligibilityRegistry.NotPendingAdmin.selector);
        reg.acceptAdmin();
    }

    function test_a_mistyped_handover_can_be_overwritten() public {
        vm.startPrank(admin);
        reg.transferAdmin(stranger);
        reg.transferAdmin(next);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(EligibilityRegistry.NotPendingAdmin.selector);
        reg.acceptAdmin();
        vm.prank(next);
        reg.acceptAdmin();
        assertEq(reg.admin(), next);
    }

    // --- ERC-8021 Builder Code suffix ---------------------------------------------------------------

    function _sameWithSuffix(address from, bytes memory data) internal returns (bool ok, bytes memory ret) {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(from);
        (bool ok1, bytes memory r1) = address(reg).call(data);
        Vm.Log[] memory l1 = vm.getRecordedLogs();
        bytes memory s1 = abi.encode(reg.admin(), reg.pendingAdmin(), reg.isEligible(desk), reg.isEligible(stranger));

        vm.revertToStateAndDelete(snap);
        vm.recordLogs();
        vm.prank(from);
        (ok, ret) = address(reg).call(abi.encodePacked(data, SUFFIX));
        Vm.Log[] memory l2 = vm.getRecordedLogs();
        bytes memory s2 = abi.encode(reg.admin(), reg.pendingAdmin(), reg.isEligible(desk), reg.isEligible(stranger));

        assertEq(ok, ok1, "same success");
        assertEq(ret, r1, "same return/revert data");
        assertEq(l1.length, l2.length, "same number of logs");
        for (uint256 i; i < l1.length; ++i) {
            assertEq(l1[i].emitter, l2[i].emitter);
            assertEq(l1[i].topics, l2[i].topics);
            assertEq(l1[i].data, l2[i].data);
        }
        assertEq(s1, s2, "same resulting state");
    }

    function test_builder_code_suffix_every_entry_point_is_identical() public {
        bool ok;
        bytes memory ret;
        (ok,) = _sameWithSuffix(admin, abi.encodeCall(EligibilityRegistry.setEligible, (desk, true, keccak256("team:curb-desk"))));
        assertTrue(ok);
        assertTrue(reg.isEligible(desk));
        (ok, ret) = _sameWithSuffix(stranger, abi.encodeCall(EligibilityRegistry.setEligible, (stranger, true, bytes32(0))));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(EligibilityRegistry.NotAdmin.selector));
        (ok, ret) = _sameWithSuffix(stranger, abi.encodeWithSelector(reg.isEligible.selector, desk));
        assertTrue(abi.decode(ret, (bool)));

        (ok,) = _sameWithSuffix(admin, abi.encodeCall(EligibilityRegistry.transferAdmin, (next)));
        assertTrue(ok);
        assertEq(reg.pendingAdmin(), next);
        (ok, ret) = _sameWithSuffix(stranger, abi.encodeCall(EligibilityRegistry.acceptAdmin, ()));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(EligibilityRegistry.NotPendingAdmin.selector));
        (ok,) = _sameWithSuffix(next, abi.encodeCall(EligibilityRegistry.acceptAdmin, ()));
        assertTrue(ok);
        assertEq(reg.admin(), next);
    }
}
