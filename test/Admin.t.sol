// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketClock} from "../src/MarketClock.sol";
import {Scorecard} from "../src/Scorecard.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";

/// Deployed contracts are immutable, so the admin handover has to be right before mainnet.
contract AdminTransferTest is Test {
    MarketClock clock;
    Scorecard sc;
    address admin;
    address next;
    address stranger;

    function setUp() public {
        admin = makeAddr("admin");
        next = makeAddr("next");
        stranger = makeAddr("stranger");
        address[] memory a = new address[](1);
        a[0] = makeAddr("attestor");
        clock = new MarketClock(admin, a);
        sc = new Scorecard(IMarketClock(address(clock)), admin);
    }

    function test_marketclock_two_step_handover() public {
        vm.prank(admin);
        clock.transferAdmin(next);
        assertEq(clock.admin(), admin, "nothing changes until accepted");

        vm.prank(stranger);
        vm.expectRevert(MarketClock.NotPendingAdmin.selector);
        clock.acceptAdmin();

        vm.prank(next);
        clock.acceptAdmin();
        assertEq(clock.admin(), next);
        assertEq(clock.pendingAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(MarketClock.NotAdmin.selector);
        clock.setAttestor(stranger, true);

        vm.prank(next);
        clock.setAttestor(stranger, true);
        assertTrue(clock.isAttestor(stranger));
    }

    function test_scorecard_two_step_handover() public {
        vm.prank(admin);
        sc.transferAdmin(next);
        vm.prank(next);
        sc.acceptAdmin();
        assertEq(sc.admin(), next);

        vm.prank(admin);
        vm.expectRevert(Scorecard.NotAdmin.selector);
        sc.setKeeper(stranger, true);
    }

    function test_only_admin_can_start_transfer() public {
        vm.prank(stranger);
        vm.expectRevert(MarketClock.NotAdmin.selector);
        clock.transferAdmin(stranger);
    }

    function test_zero_address_rejected() public {
        vm.prank(admin);
        vm.expectRevert(MarketClock.ZeroAddress.selector);
        clock.transferAdmin(address(0));

        address[] memory a = new address[](1);
        a[0] = stranger;
        vm.expectRevert(MarketClock.ZeroAddress.selector);
        new MarketClock(address(0), a);
    }
}
