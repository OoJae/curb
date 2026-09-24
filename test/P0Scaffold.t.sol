// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC1155} from "forge-std/interfaces/IERC1155.sol";
import {ERC1155Min} from "../src/lib/ERC1155Min.sol";
import {SafeTransfer} from "../src/lib/SafeTransfer.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IScorecardPrice} from "../src/interfaces/IScorecardPrice.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {Scorecard} from "../src/Scorecard.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWrapper4626} from "./mocks/MockWrapper4626.sol";
import {MockClock} from "./mocks/MockClock.sol";
import {MockScorecardPrice} from "./mocks/MockScorecardPrice.sol";

// --- harnesses -------------------------------------------------------------------------------

contract Note1155 is ERC1155Min {
    constructor() ERC1155Min("https://api.curb.markets/v1/notes/{id}.json") {}
    function mint(address to, uint256 id, uint256 v) external { _mint(to, id, v, ""); }
    function burn(address from, uint256 id, uint256 v) external { _burn(from, id, v); }
}

contract GoodReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}

/// Has code, has no hook.
contract NoHook {
    uint256 public x;
}

contract WrongMagic {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract Rejecter {
    error Nope();
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert Nope();
    }
}

contract SafeCaller {
    using SafeTransfer for IERC20;
    using SafeTransfer for address;
    function pay(IERC20 t, address to, uint256 a) external { t.safeTransfer(to, a); }
    function pull(address t, address from, address to, uint256 a) external { t.safeTransferFrom(from, to, a); }
}

/// USDT-style: returns nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external { balanceOf[msg.sender] -= a; balanceOf[to] += a; }
}

/// Minimal Uniswap V3 surface for deploying a real Scorecard (same shape as test/Scorecard.t.sol).
contract P0PoolStub {
    address public token0;
    address public token1;
    uint128 public liquidity = 1e18;
    uint160 internal sqrtP;
    int24 internal tick;
    constructor(address t0, address t1, uint160 s, int24 t) { token0 = t0; token1 = t1; sqrtP = s; tick = t; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtP, tick, 0, 32, 32, 0, true);
    }
    function observe(uint32[] calldata ago) external view returns (int56[] memory c, uint160[] memory spl) {
        c = new int56[](2);
        spl = new uint160[](2);
        c[1] = -int56(tick) * int56(uint56(ago[1]));
    }
}

contract P0ScaffoldTest is Test {
    Note1155 note;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        note = new Note1155();
    }

    // --- ERC1155Min: balances, events, transfers ---------------------------------------------

    function test_mint_to_eoa_emits_and_credits() public {
        vm.expectEmit(true, true, true, true, address(note));
        emit ERC1155Min.TransferSingle(address(this), address(0), alice, 7, 100);
        note.mint(alice, 7, 100);
        assertEq(note.balanceOf(alice, 7), 100);
        assertEq(note.balanceOf(alice, 8), 0);
    }

    function test_owner_transfer_and_operator_transfer() public {
        note.mint(alice, 1, 100);
        vm.prank(alice);
        note.safeTransferFrom(alice, bob, 1, 40, "");
        assertEq(note.balanceOf(alice, 1), 60);
        assertEq(note.balanceOf(bob, 1), 40);

        // A stranger may not move alice's units until approved.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155NotAuthorized.selector, bob, alice));
        note.safeTransferFrom(alice, bob, 1, 1, "");

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(note));
        emit ERC1155Min.ApprovalForAll(alice, bob, true);
        note.setApprovalForAll(bob, true);
        assertTrue(note.isApprovedForAll(alice, bob));

        vm.prank(bob);
        vm.expectEmit(true, true, true, true, address(note));
        emit ERC1155Min.TransferSingle(bob, alice, bob, 1, 60);
        note.safeTransferFrom(alice, bob, 1, 60, "");
        assertEq(note.balanceOf(alice, 1), 0);
        assertEq(note.balanceOf(bob, 1), 100);
    }

    function test_transfer_guards() public {
        note.mint(alice, 1, 10);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155InsufficientBalance.selector, alice, 1, 10, 11));
        note.safeTransferFrom(alice, bob, 1, 11, "");
        vm.expectRevert(ERC1155Min.ERC1155ZeroAddress.selector);
        note.safeTransferFrom(alice, address(0), 1, 1, "");
        vm.stopPrank();
        vm.expectRevert(ERC1155Min.ERC1155ZeroAddress.selector);
        note.mint(address(0), 1, 1);
    }

    function test_burn() public {
        note.mint(alice, 3, 50);
        vm.expectEmit(true, true, true, true, address(note));
        emit ERC1155Min.TransferSingle(address(this), alice, address(0), 3, 20);
        note.burn(alice, 3, 20);
        assertEq(note.balanceOf(alice, 3), 30);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155InsufficientBalance.selector, alice, 3, 30, 31));
        note.burn(alice, 3, 31);
    }

    function test_batch_transfer_and_balanceOfBatch() public {
        note.mint(alice, 1, 10);
        note.mint(alice, 2, 20);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory vals = new uint256[](2);
        (ids[0], ids[1], vals[0], vals[1]) = (1, 2, 4, 5);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(note));
        emit ERC1155Min.TransferBatch(alice, alice, bob, ids, vals);
        note.safeBatchTransferFrom(alice, bob, ids, vals, "");

        address[] memory who = new address[](2);
        (who[0], who[1]) = (bob, bob);
        uint256[] memory bals = note.balanceOfBatch(who, ids);
        assertEq(bals[0], 4);
        assertEq(bals[1], 5);

        uint256[] memory short = new uint256[](1);
        vm.prank(alice);
        vm.expectRevert(ERC1155Min.ERC1155LengthMismatch.selector);
        note.safeBatchTransferFrom(alice, bob, ids, short, "");
        vm.expectRevert(ERC1155Min.ERC1155LengthMismatch.selector);
        note.balanceOfBatch(who, short);
    }

    function test_supportsInterface_and_uri() public view {
        assertEq(type(IERC1155).interfaceId, bytes4(0xd9b67a26), "computed ERC-1155 id");
        assertTrue(note.supportsInterface(0xd9b67a26));
        assertTrue(note.supportsInterface(0x01ffc9a7));
        assertTrue(note.supportsInterface(0x0e89341c));
        assertFalse(note.supportsInterface(0xffffffff));
        assertFalse(note.supportsInterface(0x4e2312e0)); // receiver id: the token is not a receiver
        assertEq(note.uri(42), "https://api.curb.markets/v1/notes/{id}.json");
    }

    // --- ERC1155Min: receiver acceptance ------------------------------------------------------

    function test_receiver_with_hook_accepts_single_and_batch() public {
        GoodReceiver r = new GoodReceiver();
        note.mint(address(r), 1, 5);
        assertEq(note.balanceOf(address(r), 1), 5);

        note.mint(alice, 2, 5);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        (ids[0], vals[0]) = (2, 5);
        vm.prank(alice);
        note.safeBatchTransferFrom(alice, address(r), ids, vals, "");
        assertEq(note.balanceOf(address(r), 2), 5);
    }

    function test_contract_without_hook_is_refused() public {
        NoHook r = new NoHook();
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, address(r)));
        note.mint(address(r), 1, 5);

        note.mint(alice, 1, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, address(r)));
        note.safeTransferFrom(alice, address(r), 1, 5, "");

        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        (ids[0], vals[0]) = (1, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, address(r)));
        note.safeBatchTransferFrom(alice, address(r), ids, vals, "");
        assertEq(note.balanceOf(alice, 1), 5, "refused transfer moved nothing");
    }

    function test_wrong_magic_refused_and_reason_bubbles() public {
        WrongMagic w = new WrongMagic();
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, address(w)));
        note.mint(address(w), 1, 1);

        Rejecter j = new Rejecter();
        vm.expectRevert(Rejecter.Nope.selector);
        note.mint(address(j), 1, 1);
    }

    /// EIP-7702: a delegated EOA has code (the 23-byte designator), so the hook check must run.
    function test_7702_delegated_eoa_is_checked() public {
        (address good, uint256 goodKey) = makeAddrAndKey("7702-good");
        vm.signAndAttachDelegation(address(new GoodReceiver()), goodKey);
        note.mint(good, 1, 5);
        assertEq(good.code.length, 23, "delegation designator present");
        assertEq(note.balanceOf(good, 1), 5);

        (address bad, uint256 badKey) = makeAddrAndKey("7702-nohook");
        vm.signAndAttachDelegation(address(new NoHook()), badKey);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Min.ERC1155UnsafeRecipient.selector, bad));
        note.mint(bad, 1, 5);
    }

    // --- SafeTransfer ------------------------------------------------------------------------

    function test_safeTransfer_happy_path() public {
        SafeCaller c = new SafeCaller();
        MockERC20 t = new MockERC20("USDG", "USDG", 6);
        t.mint(address(c), 100e6);
        c.pay(IERC20(address(t)), alice, 40e6);
        assertEq(t.balanceOf(alice), 40e6);

        t.mint(bob, 10e6);
        vm.prank(bob);
        t.approve(address(c), 10e6);
        c.pull(address(t), bob, alice, 10e6);
        assertEq(t.balanceOf(alice), 50e6);
        assertEq(t.allowance(bob, address(c)), 0);
    }

    function test_false_returning_token_reverts() public {
        SafeCaller c = new SafeCaller();
        MockERC20 t = new MockERC20("USDG", "USDG", 6);
        t.mint(address(c), 100e6);
        t.mint(bob, 10e6);
        vm.prank(bob);
        t.approve(address(c), 10e6);
        t.setReturnFalse(true);

        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(t)));
        c.pay(IERC20(address(t)), alice, 1);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(t)));
        c.pull(address(t), bob, alice, 1);
    }

    function test_frozen_or_codeless_token_reverts_and_no_return_token_passes() public {
        SafeCaller c = new SafeCaller();
        MockERC20 t = new MockERC20("USDG", "USDG", 6);
        t.mint(bob, 10e6);
        vm.prank(bob);
        t.approve(address(c), type(uint256).max);
        t.freeze(bob);
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, address(t)));
        c.pull(address(t), bob, alice, 1);
        t.unfreeze(bob);
        c.pull(address(t), bob, alice, 1);
        assertEq(t.allowance(bob, address(c)), type(uint256).max, "infinite allowance not spent");

        address empty = makeAddr("not-a-token");
        vm.expectRevert(abi.encodeWithSelector(SafeTransfer.TransferFailed.selector, empty));
        c.pay(IERC20(empty), alice, 1);

        NoReturnToken n = new NoReturnToken();
        n.mint(address(c), 5);
        c.pay(IERC20(address(n)), alice, 5);
        assertEq(n.balanceOf(alice), 5);
    }

    // --- mocks behave like the real contracts they stand in for --------------------------------

    function test_mockClock_defaults_and_setters() public {
        MockClock k = new MockClock();
        MockWrapper4626 w = new MockWrapper4626(makeAddr("rawTCENT"), "wTCENTx", "wTCENTx");
        address wa = address(w);

        assertEq(uint8(k.regime(wa)), uint8(IMarketClock.Regime.UNKNOWN));
        assertEq(k.primaryCapNow(wa), 0);

        k.set(wa, IMarketClock.Regime.MARKET, 20_000_000);
        assertEq(k.primaryCapNow(wa), 20_000_000);
        k.setRegime(wa, IMarketClock.Regime.UNKNOWN);
        assertEq(k.primaryCapNow(wa), 0, "UNKNOWN never reads open, like the real clock");
        k.set(wa, IMarketClock.Regime.CLOSED, 0);
        assertEq(uint8(k.regime(wa)), uint8(IMarketClock.Regime.CLOSED));

        k.setBlackout(wa, true);
        assertTrue(k.isInMultiplierBlackout(wa));
        k.setNonce(wa, 3);
        assertEq(k.stateOf(wa).multiplierNonce, 3);

        // rawToShares passes through to the wrapper's convertToAssets unless overridden.
        assertEq(k.rawToShares(wa, 2e18), 2e18);
        w.setRate(1.05e18);
        assertEq(k.rawToShares(wa, 2e18), 2.1e18);
        k.setRawRate(wa, 0.5e18);
        assertEq(k.rawToShares(wa, 2e18), 1e18);
        assertEq(w.asset(), makeAddr("rawTCENT"));
        assertEq(w.decimals(), 18);
    }

    function test_mockScorecardPrice_sources_and_revert_toggle() public {
        MockScorecardPrice s = new MockScorecardPrice();
        address w = makeAddr("wNVDAx");
        vm.expectRevert(abi.encodeWithSelector(MockScorecardPrice.NoPriceSource.selector, w));
        s.priceNow(w);

        s.setPrice(w, 223.35e18);
        assertEq(s.priceNow(w), 223.35e18);
        (address pool,, uint32 twap, uint8 eqDec, uint8 stDec) = s.priceSources(w);
        assertTrue(pool != address(0));
        assertEq(twap, 120);
        assertEq(eqDec, 18);
        assertEq(stDec, 6);

        s.setRevert(w, true);
        vm.expectRevert(abi.encodeWithSelector(MockScorecardPrice.PriceUnreadable.selector, pool));
        s.priceNow(w);
        s.setRevert(w, false);
        s.setRevertAll(true);
        vm.expectRevert(abi.encodeWithSelector(MockScorecardPrice.PriceUnreadable.selector, pool));
        s.priceNow(w);

        s.clearPriceSource(w);
        (pool,,,,) = s.priceSources(w);
        assertEq(pool, address(0));
    }

    /// The frozen interface decodes the REAL Scorecard's getters (same ABI as the deployed v2).
    function test_real_scorecard_satisfies_IScorecardPrice() public {
        MockERC20 wrapper = new MockERC20("wTCENTx", "wTCENTx", 18);
        MockERC20 usdg = new MockERC20("USDG", "USDG", 6);
        // The live wTCENTx/USDG pool on 21 Sep 2026 (see test/Scorecard.t.sol): $54.5974.
        P0PoolStub pool = new P0PoolStub(address(wrapper), address(usdg), 585417536637190936853387, -236323);
        Scorecard sc = new Scorecard(IMarketClock(address(0xC10C)), address(this));
        sc.setPriceSource(address(wrapper), address(pool), true, 120);

        IScorecardPrice p = IScorecardPrice(address(sc));
        assertEq(p.priceNow(address(wrapper)), 54597441088191159066);
        (address pl, bool eq0, uint32 tw, uint8 ed, uint8 sd) = p.priceSources(address(wrapper));
        assertEq(pl, address(pool));
        assertTrue(eq0);
        assertEq(tw, 120);
        assertEq(ed, 18);
        assertEq(sd, 6);
        (pl,,,,) = p.priceSources(makeAddr("unregistered"));
        assertEq(pl, address(0), "no source reads as zero pool");
    }
}
