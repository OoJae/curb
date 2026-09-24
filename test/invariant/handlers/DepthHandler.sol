// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {DepthCert} from "../../../src/DepthCert.sol";
import {IDepthCert} from "../../../src/interfaces/IDepthCert.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {MockEligibility} from "../../DepthCert.t.sol";

/// Bounded actor for DepthCertInvariant: four makers (0-2 on the maker allowlist, toggled at random; 3 an
/// outsider never on it), three takers, two wrappers, two books per wrapper (open, and gated to takers[0]).
/// Makers' USDG allowance, balance, freeze state and eligibility are moved at random, time moves forward,
/// and every `take` is sent with a random gas budget.
///
/// Ghosts, checked by the invariant contract:
///  - fadeWhileAble: a take faded although, just before the call, the maker had allowance >= cost,
///    balance >= cost and was not frozen (the maker state is recorded before each call);
///  - remainingIncreased / statusRegressed: a cert's `remainingShares` went up, or it left FADED/CLOSED;
///  - bondLeftEarly: a cert went LIVE -> CLOSED (bond back to the maker) before expiry while shares were
///    still owed. The only other way out for a bond is LIVE -> FADED;
///  - ineligibleGatedPosts: a cert naming a beneficiary was posted by a maker not eligible just before;
///  - earlyWithdrawByOther / bondNotToMaker: someone other than the maker withdrew before expiry, or a
///    withdrawal paid the bond to anyone but the maker (withdraw is permissionless from expiry on);
///  - unfillable: a LIVE cert holds a remainder whose cost rounds to zero, or a cert's size is below
///    MIN_NOTIONAL -- i.e. some cert could not be filled to the last share.
contract DepthHandler is CommonBase, StdCheats, StdUtils {
    DepthCert public immutable dc;
    MockERC20 public immutable usdg;
    MockEligibility public immutable elig;
    uint256 public constant MAKERS = 4;
    uint256 internal constant MIN_NOTIONAL = 1e6; // DepthCert.MIN_NOTIONAL, checked equal in the invariant
    MockERC20[2] internal _wrappers;
    address[4] internal _makers;
    address[3] internal _takers;
    address public immutable sink; // every `to`; never frozen

    uint256[] internal _ids;
    mapping(uint256 => uint128) internal _lastRemaining;
    mapping(uint256 => IDepthCert.Status) internal _lastStatus;

    // --- ghosts ---
    uint256 public fadeWhileAble;
    uint256 public remainingIncreased;
    uint256 public statusRegressed;
    uint256 public bondLeftEarly;
    uint256 public ineligibleGatedPosts;
    uint256 public earlyWithdrawByOther;
    uint256 public bondNotToMaker;
    uint256 public unfillable;

    // --- call statistics (reported, not asserted) ---
    uint256 public posts;
    uint256 public gatedPosts;
    uint256 public refusedIneligible;
    uint256 public fills;
    uint256 public fades;
    uint256 public fadesAllowance;
    uint256 public fadesBalance;
    uint256 public fadesTransfer;
    uint256 public starved; // InsufficientGas
    uint256 public takeReverts;
    uint256 public withdraws;
    uint256 public withdrawsByOthers;
    uint256 public dustRefusals;
    uint256 public claims;
    uint256 public prunes;

    constructor(DepthCert dc_, MockERC20 usdg_, MockEligibility elig_, MockERC20 w0, MockERC20 w1) {
        dc = dc_;
        usdg = usdg_;
        elig = elig_;
        _wrappers[0] = w0;
        _wrappers[1] = w1;
        sink = makeAddr("sink");
        for (uint256 i; i < MAKERS; ++i) {
            _makers[i] = makeAddr(string.concat("maker", vm.toString(i)));
            usdg.mint(_makers[i], 5_000e6);
            vm.prank(_makers[i]);
            usdg.approve(address(dc), type(uint256).max);
            if (i < 3) elig.set(_makers[i], true); // maker3 is the outsider
        }
        for (uint256 i; i < 3; ++i) {
            _takers[i] = makeAddr(string.concat("taker", vm.toString(i)));
            for (uint256 j; j < 2; ++j) {
                vm.prank(_takers[i]);
                _wrappers[j].approve(address(dc), type(uint256).max);
            }
        }
    }

    // --- views for the invariant contract ------------------------------------------------------

    function idsLength() external view returns (uint256) { return _ids.length; }
    function idAt(uint256 i) external view returns (uint256) { return _ids[i]; }
    function makerAt(uint256 i) external view returns (address) { return _makers[i]; }
    function takerAt(uint256 i) external view returns (address) { return _takers[i]; }
    function wrapperAt(uint256 i) external view returns (MockERC20) { return _wrappers[i]; }

    // --- actions -------------------------------------------------------------------------------

    function post(uint256 mSeed, uint256 wSeed, bool gated, uint256 size, uint256 px, uint256 life, uint256 extra)
        external
    {
        address m = _makers[mSeed % MAKERS];
        address w = address(_wrappers[wSeed % 2]);
        address ben = gated ? _takers[0] : address(0);
        bool eligible = elig.isEligible(m);
        px = bound(px, 1e5, 500e6);
        size = bound(size, (1e24 + px - 1) / px, 20e18); // notional >= MIN_NOTIONAL
        uint256 n = size * px / 1e18;
        uint256 bond = (n * 1000 + 9999) / 10_000 + bound(extra, 0, n);
        life = bound(life, dc.MIN_LIFE(), 3 days);

        // Fund the bond and top the allowance up by exactly the bond, so posting never changes how
        // much headroom the maker's allowance leaves for its bids.
        usdg.mint(m, bond);
        uint256 a = usdg.allowance(m, address(dc));
        if (a != type(uint256).max) {
            vm.prank(m);
            usdg.approve(address(dc), a + bond);
        }

        vm.prank(m);
        try dc.post(w, ben, uint128(size), uint128(px), uint64(block.timestamp + life), uint128(bond)) returns (
            uint256 id
        ) {
            _ids.push(id);
            _lastRemaining[id] = uint128(size);
            _lastStatus[id] = IDepthCert.Status.LIVE;
            ++posts;
            if (gated) ++gatedPosts;
            if (gated && !eligible) ++ineligibleGatedPosts;
        } catch (bytes memory err) {
            if (err.length == 4 && bytes4(err) == DepthCert.IneligibleMaker.selector) ++refusedIneligible;
        }
        _sweep();
    }

    function take(uint256 idSeed, uint256 sharesSeed, uint256 tSeed, uint256 gasSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _pick(idSeed);
        IDepthCert.Cert memory c = dc.certOf(id);

        address t = _takers[tSeed % 3];
        if (c.beneficiary != address(0) && tSeed % 4 != 0) t = c.beneficiary; // mostly the right taker
        uint128 shares = uint128(bound(sharesSeed, 1, c.remainingShares == 0 ? 1 : c.remainingShares));
        // A take leaving a dust remainder is refused; half the time take the whole rest instead.
        uint128 left = c.remainingShares > shares ? c.remainingShares - shares : 0;
        if (left != 0 && uint256(left) * c.bidPx / 1e18 == 0 && sharesSeed % 2 == 0) shares = c.remainingShares;
        MockERC20(c.wrapper).mint(t, shares); // the taker can always deliver

        // The maker's state just before the call.
        uint256 cost = uint256(shares) * c.bidPx / 1e18;
        bool able = !usdg.frozen(c.maker) && usdg.allowance(c.maker, address(dc)) >= cost
            && usdg.balanceOf(c.maker) >= cost;

        // Random gas: one take in four anywhere from starved to ample, the rest ample-ish.
        uint256 g = gasSeed % 4 == 0 ? bound(gasSeed, 40_000, 450_000) : bound(gasSeed, 250_000, 1_500_000);
        vm.recordLogs();
        vm.prank(t);
        (bool ok, bytes memory ret) = address(dc).call{gas: g}(abi.encodeCall(DepthCert.take, (id, shares, sink)));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool fadedNow = dc.certOf(id).status == IDepthCert.Status.FADED && c.status == IDepthCert.Status.LIVE;
        if (ok) {
            (bool filled,) = abi.decode(ret, (bool, uint256));
            if (filled) {
                ++fills;
            } else {
                ++fades;
                _countReason(logs);
            }
            if (!filled && able) ++fadeWhileAble;
        } else if (ret.length == 4 && bytes4(ret) == DepthCert.InsufficientGas.selector) {
            ++starved;
        } else if (ret.length >= 4 && bytes4(ret) == DepthCert.DustRemainder.selector) {
            ++dustRefusals;
        } else {
            ++takeReverts;
        }
        if (fadedNow && able) ++fadeWhileAble; // belt and braces: judged by state, not only the return
        _sweep();
    }

    /// Withdraw by the maker, or (half the time) by a taker: permissionless from expiry on.
    function withdraw(uint256 idSeed, uint256 callerSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _pickWithdrawable(idSeed);
        IDepthCert.Cert memory c = dc.certOf(id);
        address caller = callerSeed % 2 == 0 ? c.maker : _takers[callerSeed % 3];
        uint256 makerBal0 = usdg.balanceOf(c.maker);
        vm.prank(caller);
        try dc.withdraw(id) {
            ++withdraws;
            if (caller != c.maker) {
                ++withdrawsByOthers;
                if (block.timestamp < c.expiry) ++earlyWithdrawByOther;
            }
            if (usdg.balanceOf(c.maker) != makerBal0 + c.bond) ++bondNotToMaker;
        } catch {}
        _sweep();
    }

    function claim(uint256 mSeed, uint256 wSeed) external {
        address m = _makers[mSeed % MAKERS];
        vm.prank(m);
        try dc.claimShares(address(_wrappers[wSeed % 2]), m) returns (uint256 s) {
            if (s > 0) ++claims;
        } catch {}
        _sweep();
    }

    function prune(uint256 wSeed, bool gated) external {
        dc.prune(address(_wrappers[wSeed % 2]), gated ? _takers[0] : address(0));
        ++prunes;
        _sweep();
    }

    /// Revoke, trim, restore or max out a maker's allowance.
    function setAllowance(uint256 mSeed, uint256 mode, uint256 amt) external {
        address m = _makers[mSeed % MAKERS];
        uint256 need = dc.committed(m);
        uint256 a;
        mode = mode % 5;
        if (mode == 0) a = 0;
        else if (mode == 1) a = need == 0 ? 0 : need - 1;
        else if (mode == 2) a = need;
        else if (mode == 3) a = type(uint256).max;
        else a = bound(amt, 0, 2 * need + 1);
        vm.prank(m);
        usdg.approve(address(dc), a);
        _sweep();
    }

    /// Top a maker's USDG up, or drain some of it.
    function moveBalance(uint256 mSeed, uint256 amt, bool up) external {
        address m = _makers[mSeed % MAKERS];
        if (up) {
            usdg.mint(m, bound(amt, 0, 2_000e6));
        } else {
            uint256 bal = usdg.balanceOf(m);
            usdg.burn(m, bound(amt, 0, bal));
        }
        _sweep();
    }

    /// Freeze a maker (one call in three) or thaw it, so makers spend most of their time unfrozen.
    function setFrozen(uint256 mSeed) external {
        address m = _makers[mSeed % MAKERS];
        if ((mSeed / MAKERS) % 3 == 0) usdg.freeze(m);
        else usdg.unfreeze(m);
        _sweep();
    }

    /// Delist one of the allowlisted makers (one call in four) or relist it. The outsider never gets on.
    function setEligible(uint256 mSeed) external {
        address m = _makers[mSeed % 3];
        elig.set(m, (mSeed / 3) % 4 != 0);
        _sweep();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 3 hours));
        _sweep();
    }

    // --- bookkeeping ---------------------------------------------------------------------------

    /// Mostly a LIVE cert whose bond may come back (expired, or filled in full), one time in four any cert.
    function _pickWithdrawable(uint256 seed) internal view returns (uint256) {
        uint256 n = _ids.length;
        if (seed % 4 == 0) return _ids[seed % n];
        for (uint256 k; k < n; ++k) {
            uint256 id = _ids[(seed % n + k) % n];
            IDepthCert.Cert memory c = dc.certOf(id);
            if (c.status == IDepthCert.Status.LIVE && (block.timestamp >= c.expiry || c.remainingShares == 0)) {
                return id;
            }
        }
        return _ids[seed % n];
    }

    /// Mostly a takeable cert (searching from the seed), one time in five any cert at all.
    function _pick(uint256 seed) internal view returns (uint256) {
        uint256 n = _ids.length;
        if (seed % 5 == 0) return _ids[seed % n];
        for (uint256 k; k < n; ++k) {
            uint256 id = _ids[(seed % n + k) % n];
            IDepthCert.Cert memory c = dc.certOf(id);
            if (c.status == IDepthCert.Status.LIVE && c.remainingShares != 0 && block.timestamp < c.expiry) return id;
        }
        return _ids[seed % n];
    }

    function _countReason(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(dc) || logs[i].topics[0] != DepthCert.Faded.selector) continue;
            (,,, bytes4 why) = abi.decode(logs[i].data, (uint128, uint256, uint128, bytes4));
            if (why == dc.ALLOWANCE()) ++fadesAllowance;
            else if (why == dc.BALANCE()) ++fadesBalance;
            else if (why == dc.TRANSFER_FAILED()) ++fadesTransfer;
        }
    }

    /// Compare every cert with what it was after the previous action.
    function _sweep() internal {
        for (uint256 i; i < _ids.length; ++i) {
            uint256 id = _ids[i];
            IDepthCert.Cert memory c = dc.certOf(id);
            IDepthCert.Status was = _lastStatus[id];
            if (c.remainingShares > _lastRemaining[id]) ++remainingIncreased;
            if (uint256(c.sizeShares) * c.bidPx / 1e18 < MIN_NOTIONAL) ++unfillable;
            if (
                c.status == IDepthCert.Status.LIVE && c.remainingShares != 0
                    && uint256(c.remainingShares) * c.bidPx / 1e18 == 0
            ) ++unfillable;
            if (was != IDepthCert.Status.LIVE && c.status != was) ++statusRegressed;
            if (was == IDepthCert.Status.LIVE && c.status == IDepthCert.Status.CLOSED) {
                // The bond went back to the maker: only after expiry, or once nothing is owed.
                if (block.timestamp < c.expiry && c.remainingShares != 0) ++bondLeftEarly;
            }
            _lastRemaining[id] = c.remainingShares;
            _lastStatus[id] = c.status;
        }
    }
}
