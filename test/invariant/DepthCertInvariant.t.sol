// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DepthCert} from "../../src/DepthCert.sol";
import {IDepthCert} from "../../src/interfaces/IDepthCert.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockEligibility} from "../DepthCert.t.sol";
import {DepthHandler} from "./handlers/DepthHandler.sol";

/// DepthCert invariants (W4 spec, "DepthCertInvariant (P3)"), under random posts, takes with random gas,
/// withdrawals, claims, prunes, allowance/balance/freeze changes to makers, and time.
///
///  1. USDG held = totalBonds = Σ bond over LIVE certs (a fill passes the maker's USDG straight through).
///  2. Each wrapper held = Σ claimableShares over makers (a fade hands the taker's shares straight back).
///  3. committed(maker) = Σ notional(remaining, bidPx) over the maker's takeable certs (LIVE, unexpired,
///     shares left), computed here from every cert -- so an expired cert never counts against a maker.
///  4. No fade while the maker was able (ghost: maker state recorded before every take, gas random).
///  5. remainingShares never increases, and a cert never leaves FADED or CLOSED.
///  6. No bond leaves before expiry except by a fade (or once the cert is filled in full, which the spec's
///     withdraw rule allows: the bond then backs nothing); before expiry only the maker withdraws, and a
///     withdrawal always pays the maker.
///  7. Beneficiary-named books stay within MAX_LIVE_PER_BOOK (open books are uncapped), makers' lists within
///     MAX_LIVE_PER_MAKER, and every takeable cert is listed in its book.
///  8. Only a maker eligible at the time can post a cert that names a beneficiary.
///  9. Every cert can be filled to the last share: size >= MIN_NOTIONAL, and no LIVE remainder costs 0.
contract DepthCertInvariant is StdInvariant, Test {
    DepthCert dc;
    MockERC20 usdg;
    MockEligibility elig;
    MockERC20 w0;
    MockERC20 w1;
    DepthHandler h;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        w0 = new MockERC20("Wrapped TCENTx", "wTCENTx", 18);
        w1 = new MockERC20("Wrapped NVDAx", "wNVDAx", 18);
        elig = new MockEligibility();
        dc = new DepthCert(IERC20(address(usdg)), IEligibility(address(elig)));
        h = new DepthHandler(dc, usdg, elig, w0, w1);

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = DepthHandler.post.selector;
        sel[1] = DepthHandler.take.selector;
        sel[2] = DepthHandler.withdraw.selector;
        sel[3] = DepthHandler.claim.selector;
        sel[4] = DepthHandler.prune.selector;
        sel[5] = DepthHandler.setAllowance.selector;
        sel[6] = DepthHandler.moveBalance.selector;
        sel[7] = DepthHandler.setFrozen.selector;
        sel[8] = DepthHandler.warp.selector;
        sel[9] = DepthHandler.setEligible.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function _notional(uint256 s, uint256 px) internal pure returns (uint256) {
        return s * px / 1e18;
    }

    // 1
    function invariant_usdg_balance_equals_totalBonds() public view {
        assertEq(usdg.balanceOf(address(dc)), dc.totalBonds(), "USDG held != totalBonds");
        uint256 live;
        for (uint256 i; i < h.idsLength(); ++i) {
            IDepthCert.Cert memory c = dc.certOf(h.idAt(i));
            if (c.status == IDepthCert.Status.LIVE) live += c.bond;
        }
        assertEq(dc.totalBonds(), live, "totalBonds != sum of LIVE bonds");
    }

    // 2
    function invariant_wrapper_balance_equals_sum_claimable() public view {
        for (uint256 j; j < 2; ++j) {
            MockERC20 w = h.wrapperAt(j);
            uint256 sum;
            for (uint256 i; i < h.MAKERS(); ++i) sum += dc.claimableShares(h.makerAt(i), address(w));
            assertEq(w.balanceOf(address(dc)), sum, "wrapper held != sum of claimable");
        }
    }

    // 3
    function invariant_committed_equals_sum_notional_remaining() public view {
        for (uint256 k; k < h.MAKERS(); ++k) {
            address m = h.makerAt(k);
            uint256 sum;
            for (uint256 i; i < h.idsLength(); ++i) {
                IDepthCert.Cert memory c = dc.certOf(h.idAt(i));
                if (c.maker == m && c.status == IDepthCert.Status.LIVE && block.timestamp < c.expiry) {
                    sum += _notional(c.remainingShares, c.bidPx);
                }
            }
            assertEq(dc.committed(m), sum, "committed != sum of notional(remaining) over unexpired LIVE certs");
            uint256 need = sum;
            bool able = usdg.balanceOf(m) >= need && usdg.allowance(m, address(dc)) >= need;
            assertEq(dc.isHonourable(m), able, "isHonourable disagrees with the unexpired commitment");
        }
    }

    // 4
    function invariant_no_fade_while_maker_able() public view {
        assertEq(h.fadeWhileAble(), 0, "an able maker was faded");
    }

    // 5
    function invariant_remaining_never_increases() public view {
        assertEq(h.remainingIncreased(), 0, "remainingShares increased");
        assertEq(h.statusRegressed(), 0, "a cert left FADED/CLOSED");
    }

    // 6
    function invariant_no_bond_leaves_before_expiry_except_by_fade() public view {
        assertEq(h.bondLeftEarly(), 0, "a bond left before expiry with shares still owed");
        assertEq(h.earlyWithdrawByOther(), 0, "someone other than the maker withdrew before expiry");
        assertEq(h.bondNotToMaker(), 0, "a withdrawal paid the bond to someone other than the maker");
    }

    // 7
    function invariant_books_bounded_and_complete() public view {
        for (uint256 j; j < 2; ++j) {
            assertLe(dc.bookOf(address(h.wrapperAt(j)), h.takerAt(0)).length, dc.MAX_LIVE_PER_BOOK());
        }
        for (uint256 k; k < h.MAKERS(); ++k) {
            assertLe(dc.certsOf(h.makerAt(k)).length, dc.MAX_LIVE_PER_MAKER());
        }
        for (uint256 i; i < h.idsLength(); ++i) {
            uint256 id = h.idAt(i);
            IDepthCert.Cert memory c = dc.certOf(id);
            if (c.status != IDepthCert.Status.LIVE || c.remainingShares == 0 || block.timestamp >= c.expiry) continue;
            uint256[] memory book = dc.bookOf(c.wrapper, c.beneficiary);
            bool listed;
            for (uint256 k; k < book.length; ++k) if (book[k] == id) listed = true;
            assertTrue(listed, "a takeable cert is missing from its book");
        }
    }

    // 8
    function invariant_only_eligible_makers_name_a_beneficiary() public view {
        assertEq(h.ineligibleGatedPosts(), 0, "an ineligible maker posted a beneficiary-named cert");
        for (uint256 i; i < h.idsLength(); ++i) {
            IDepthCert.Cert memory c = dc.certOf(h.idAt(i));
            if (c.beneficiary != address(0)) assertTrue(c.maker != h.makerAt(3), "the outsider holds a gated cert");
        }
    }

    // 9
    function invariant_every_cert_can_be_filled() public view {
        assertEq(dc.MIN_NOTIONAL(), 1e6);
        assertEq(h.unfillable(), 0, "a cert below MIN_NOTIONAL or with a zero-cost remainder");
    }

    /// Not vacuous: the same handler, driven through a long seeded sequence, must reach every path the
    /// invariants are about -- fills, all three fade reasons, starved takes, withdrawals and claims --
    /// with every invariant checked along the way.
    function test_handler_reaches_every_path() public {
        for (uint256 i; i < 600; ++i) {
            uint256 r = uint256(keccak256(abi.encode("depthcert", i)));
            uint256 a = uint256(keccak256(abi.encode(r, 1)));
            uint256 b = uint256(keccak256(abi.encode(r, 2)));
            uint256 c = uint256(keccak256(abi.encode(r, 3)));
            uint256 d = uint256(keccak256(abi.encode(r, 4)));
            uint256 op = r % 20;
            if (op < 5) h.post(a, b, c % 2 == 0, c, d, a ^ b, b ^ c);
            else if (op < 12) h.take(a, b, c, d);
            else if (op < 13) h.withdraw(a, b);
            else if (op < 14) h.claim(a, b);
            else if (op < 15) h.prune(a, b % 2 == 0);
            else if (op < 16) h.setAllowance(a, b, c);
            else if (op < 17) h.moveBalance(a, b, c % 2 == 0);
            else if (op < 18) h.setFrozen(a);
            else if (op < 19) h.setEligible(a);
            else h.warp(a);
            if (i % 100 == 99) _checkAll();
        }
        _checkAll();
        console2.log("posts", h.posts(), "fills", h.fills());
        console2.log("fades", h.fades(), "InsufficientGas reverts", h.starved());
        console2.log("fade reasons: allowance", h.fadesAllowance(), "balance", h.fadesBalance());
        console2.log("fade reasons: transfer_failed", h.fadesTransfer(), "other take reverts", h.takeReverts());
        console2.log("withdraws", h.withdraws(), "claims", h.claims());
        console2.log("gated posts", h.gatedPosts(), "IneligibleMaker refusals", h.refusedIneligible());
        console2.log("withdraws by others", h.withdrawsByOthers(), "DustRemainder refusals", h.dustRefusals());
        assertGt(h.fills(), 0, "fills");
        assertGt(h.gatedPosts(), 0, "gated posts");
        assertGt(h.refusedIneligible(), 0, "IneligibleMaker refusals");
        assertGt(h.fadesAllowance(), 0, "ALLOWANCE fades");
        assertGt(h.fadesBalance(), 0, "BALANCE fades");
        assertGt(h.fadesTransfer(), 0, "TRANSFER_FAILED fades");
        assertGt(h.starved(), 0, "InsufficientGas reverts");
        assertGt(h.withdraws(), 0, "withdrawals");
        assertGt(h.withdrawsByOthers(), 0, "permissionless withdrawals after expiry");
        assertGt(h.claims(), 0, "claims");
    }

    function _checkAll() internal view {
        invariant_usdg_balance_equals_totalBonds();
        invariant_wrapper_balance_equals_sum_claimable();
        invariant_committed_equals_sum_notional_remaining();
        invariant_no_fade_while_maker_able();
        invariant_remaining_never_increases();
        invariant_no_bond_leaves_before_expiry_except_by_fade();
        invariant_books_bounded_and_complete();
        invariant_only_eligible_makers_name_a_beneficiary();
        invariant_every_cert_can_be_filled();
    }
}
