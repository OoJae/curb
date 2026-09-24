// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {DepthCert} from "../../../src/DepthCert.sol";
import {IDepthCert} from "../../../src/interfaces/IDepthCert.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";

/// Bounded actor for DepthCertInvariant: three makers, three takers, two wrappers, two books per wrapper
/// (open, and gated to takers[0]). Makers' USDG allowance, balance and freeze state are moved at random,
/// time moves forward, and every `take` is sent with a random gas budget.
///
/// Ghosts, checked by the invariant contract:
///  - fadeWhileAble: a take faded although, just before the call, the maker had allowance >= cost,
///    balance >= cost and was not frozen (the maker state is recorded before each call);
///  - remainingIncreased / statusRegressed: a cert's `remainingShares` went up, or it left FADED/CLOSED;
///  - bondLeftEarly: a cert went LIVE -> CLOSED (bond back to the maker) before expiry while shares were
///    still owed. The only other way out for a bond is LIVE -> FADED.
contract DepthHandler is CommonBase, StdCheats, StdUtils {
    DepthCert public immutable dc;
    MockERC20 public immutable usdg;
    MockERC20[2] internal _wrappers;
    address[3] internal _makers;
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

    // --- call statistics (reported, not asserted) ---
    uint256 public posts;
    uint256 public fills;
    uint256 public fades;
    uint256 public fadesAllowance;
    uint256 public fadesBalance;
    uint256 public fadesTransfer;
    uint256 public starved; // InsufficientGas
    uint256 public takeReverts;
    uint256 public withdraws;
    uint256 public claims;
    uint256 public prunes;

    constructor(DepthCert dc_, MockERC20 usdg_, MockERC20 w0, MockERC20 w1) {
        dc = dc_;
        usdg = usdg_;
        _wrappers[0] = w0;
        _wrappers[1] = w1;
        sink = makeAddr("sink");
        for (uint256 i; i < 3; ++i) {
            _makers[i] = makeAddr(string.concat("maker", vm.toString(i)));
            _takers[i] = makeAddr(string.concat("taker", vm.toString(i)));
            usdg.mint(_makers[i], 5_000e6);
            vm.prank(_makers[i]);
            usdg.approve(address(dc), type(uint256).max);
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
        address m = _makers[mSeed % 3];
        address w = address(_wrappers[wSeed % 2]);
        address ben = gated ? _takers[0] : address(0);
        size = bound(size, 1e15, 20e18);
        px = bound(px, 1e5, 500e6);
        uint256 n = size * px / 1e18;
        if (n == 0) return;
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
        } catch {}
        _sweep();
    }

    function take(uint256 idSeed, uint256 sharesSeed, uint256 tSeed, uint256 gasSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _pick(idSeed);
        IDepthCert.Cert memory c = dc.certOf(id);

        address t = _takers[tSeed % 3];
        if (c.beneficiary != address(0) && tSeed % 4 != 0) t = c.beneficiary; // mostly the right taker
        uint128 shares = uint128(bound(sharesSeed, 1, c.remainingShares == 0 ? 1 : c.remainingShares));
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
        } else {
            ++takeReverts;
        }
        if (fadedNow && able) ++fadeWhileAble; // belt and braces: judged by state, not only the return
        _sweep();
    }

    function withdraw(uint256 idSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[idSeed % _ids.length];
        address m = dc.certOf(id).maker;
        vm.prank(m);
        try dc.withdraw(id) {
            ++withdraws;
        } catch {}
        _sweep();
    }

    function claim(uint256 mSeed, uint256 wSeed) external {
        address m = _makers[mSeed % 3];
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
        address m = _makers[mSeed % 3];
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
        address m = _makers[mSeed % 3];
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
        address m = _makers[mSeed % 3];
        if ((mSeed / 3) % 3 == 0) usdg.freeze(m);
        else usdg.unfreeze(m);
        _sweep();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 3 hours));
        _sweep();
    }

    // --- bookkeeping ---------------------------------------------------------------------------

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
