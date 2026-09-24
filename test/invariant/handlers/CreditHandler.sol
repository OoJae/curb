// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {CurbCredit} from "../../../src/CurbCredit.sol";
import {IMarketClock} from "../../../src/interfaces/IMarketClock.sol";
import {MulDiv} from "../../../src/lib/MulDiv.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {MockClock} from "../../mocks/MockClock.sol";
import {MockScorecardPrice} from "../../mocks/MockScorecardPrice.sol";
import {MockDepthCert} from "../../mocks/MockDepthCert.sol";

interface ISettableEligibility {
    function set(address who, bool ok) external;
    function isEligible(address who) external view returns (bool);
}

/// @notice Bounded random actions against one CurbCredit: positions, regime flips, price and depth moves, breach
///         flags, cure ticks, liquidations, realisation and time. Ghost counters record every violation of a
///         property that can only be seen at the moment of a call (the invariant contract asserts they stay 0).
contract CreditHandler is Test {
    CurbCredit public immutable credit;
    MockClock public immutable clock;
    MockScorecardPrice public immutable sc;
    MockDepthCert public immutable dc;
    MockERC20 public immutable usdg;
    address public immutable admin;
    ISettableEligibility public immutable elig;
    address public immutable maker = address(0xBEEF);

    address[] internal _assets;
    address[] internal _actors;
    mapping(address => uint128) public basePrice;

    // --- ghosts: violations (must stay zero) ------------------------------------------------------------------
    uint256 public borrowOverRealisable; // a successful borrow left totalPrincipal > realisable
    uint256 public seizeOverStaleCap; // seized more than sharesFor(debt * 1.05, P_breach)
    uint256 public liquidatedWhileShut; // a liquidation succeeded while the market was not open
    uint256 public liquidatedEarly; // a liquidation succeeded with < 1800 witnessed open seconds
    uint256 public cureMovedAcrossShut; // a tick with shut/UNKNOWN at either end moved the clock
    uint256 public cureOverCounted; // a tick added more than min(gap, MAX_TICK_GAP)
    uint256 public refusalChangedState; // a refused borrow/withdraw changed the position or totals
    uint256 public crossPositionBreachChange; // a deposit/withdraw moved another position's isBreached
    uint256 public crossPositionPushedIntoBreach; // a borrow/repay/liquidate pushed another position into breach
    uint256 public badDebtWithCollateralLeft; // a liquidation wrote debt off while the borrower kept shares
    uint256 public debtForgiven; // a partial liquidation took more off the debt than the shares it seized cover

    // --- ghosts: coverage -------------------------------------------------------------------------------------
    uint256 public borrowsOk;
    uint256 public refusals;
    uint256 public breaches;
    uint256 public ticks;
    uint256 public shutTicks;
    uint256 public liquidations;
    uint256 public partialLiquidations;
    uint256 public scaledObserved; // borrow attempts made while ltvEffective < ltvFor (a margin call in force)
    uint256 public realisedFills;
    uint256 public realisedFades;
    uint256 public depositsRefusedIneligible;
    /// @notice Refusals by reason selector (borrow and withdraw).
    mapping(bytes4 => uint256) public refusalsBy;

    constructor(
        CurbCredit credit_,
        MockClock clock_,
        MockScorecardPrice sc_,
        MockDepthCert dc_,
        MockERC20 usdg_,
        address admin_,
        ISettableEligibility elig_,
        address[] memory assets_,
        address[] memory actors_
    ) {
        credit = credit_;
        clock = clock_;
        sc = sc_;
        dc = dc_;
        usdg = usdg_;
        admin = admin_;
        elig = elig_;
        _assets = assets_;
        _actors = actors_;
        for (uint256 i; i < assets_.length; ++i) basePrice[assets_[i]] = sc_.price(assets_[i]);
    }

    function assetsList() external view returns (address[] memory) {
        return _assets;
    }

    function actorsList() external view returns (address[] memory) {
        return _actors;
    }

    function _actor(uint256 s) internal view returns (address) {
        return _actors[s % _actors.length];
    }

    function _asset(uint256 s) internal view returns (address) {
        return _assets[s % _assets.length];
    }

    uint8 internal constant HAS_COLLATERAL = 1;
    uint8 internal constant HAS_DEBT = 2;
    uint8 internal constant IN_CURE = 3;

    /// @dev Steer the fuzzer: starting from `seed`, the first (actor, asset) pair in the given state, so actions
    ///      land on live positions instead of empty ones. Falls back to the seed's own pair.
    function _pick(uint256 seed, uint8 want) internal view returns (address who, address a) {
        uint256 n = _actors.length * _assets.length;
        for (uint256 k; k < n; ++k) {
            uint256 idx = (seed % n + k) % n;
            who = _actors[idx / _assets.length];
            a = _assets[idx % _assets.length];
            if (want == HAS_COLLATERAL && credit.positionOf(who, a).collateral > 0) return (who, a);
            if (want == HAS_DEBT && credit.debtOf(who, a) > 0) return (who, a);
            if (want == IN_CURE && credit.cureOf(who, a).active) return (who, a);
        }
        uint256 i0 = seed % n;
        return (_actors[i0 / _assets.length], _assets[i0 % _assets.length]);
    }

    // =========================================================================================================
    // positions
    // =========================================================================================================

    function deposit(uint256 actorSeed, uint256 assetSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        address a = _asset(assetSeed);
        amount = bound(amount, 1e15, 50e18);
        MockERC20(a).mint(who, amount);
        bool ok = elig.isEligible(who);
        uint256[] memory others = _othersBreach(who, a);
        vm.prank(who);
        if (ok) {
            credit.deposit(a, amount);
            _anyChange(others, _othersBreach(who, a));
        } else {
            try credit.deposit(a, amount) {
                revert("ineligible deposit accepted");
            } catch (bytes memory err) {
                require(bytes4(err) == CurbCredit.Ineligible.selector, "wrong deposit revert");
                ++depositsRefusedIneligible;
            }
        }
    }

    function withdraw(uint256 seed, uint256 amount) external {
        (address who, address a) = _pick(seed, HAS_COLLATERAL);
        uint256 coll = credit.positionOf(who, a).collateral;
        if (coll == 0) return;
        amount = bound(amount, 1, coll);
        bytes32 before = _positionDigest(who, a);
        uint256[] memory others = _othersBreach(who, a);
        vm.recordLogs();
        vm.prank(who);
        bool ok = credit.withdraw(a, amount);
        _anyChange(others, _othersBreach(who, a));
        if (!ok) {
            _countRefusal();
            if (_positionDigest(who, a) != before) ++refusalChangedState;
        }
    }

    function borrow(uint256 seed, uint256 amount) external {
        (address who, address a) = _pick(seed, HAS_COLLATERAL);
        uint256 limit = credit.limitOf(who, a);
        uint256 debt = credit.debtOf(who, a);
        uint256 headroom = limit > debt ? limit - debt : 0;
        // Mostly inside the headroom (so borrows land), sometimes just past it (so the bounds are probed).
        amount = MulDiv.mulDiv(headroom, _h(amount) % 11_000 + 1, 1e4);
        if (amount == 0) amount = 1;
        bytes32 before = _positionDigest(who, a);
        uint256[] memory others = _othersBreach(who, a);
        if (credit.ltvEffective(a) < credit.ltvFor(a)) ++scaledObserved;
        vm.recordLogs();
        vm.prank(who);
        bool ok = credit.borrow(a, amount);
        _noneWorse(others, _othersBreach(who, a));
        if (ok) {
            ++borrowsOk;
            if (credit.totalPrincipal(a) > credit.realisable(a)) ++borrowOverRealisable;
        } else {
            _countRefusal();
            if (_positionDigest(who, a) != before) ++refusalChangedState;
        }
    }

    function repay(uint256 seed, uint256 amount) external {
        (address who, address a) = _pick(seed, HAS_DEBT);
        uint256 debt = credit.debtOf(who, a);
        if (debt == 0) return;
        amount = bound(amount, 1, debt + 10e6);
        usdg.mint(address(this), amount);
        usdg.approve(address(credit), amount);
        uint256[] memory others = _othersBreach(who, a);
        credit.repay(who, a, amount);
        _noneWorse(others, _othersBreach(who, a));
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1e6, 5_000e6);
        usdg.mint(address(this), amount);
        usdg.approve(address(credit), amount);
        credit.fund(amount);
    }

    // =========================================================================================================
    // the world moves
    // =========================================================================================================

    /// @dev Shut modes also publish a next transition (sometimes a long holiday) that stretches the cert horizon.
    function setRegime(uint256 assetSeed, uint256 mode) external {
        address a = _asset(assetSeed);
        uint256 h = _h(mode);
        mode = mode % 8;
        if (mode <= 2) clock.set(a, IMarketClock.Regime.MARKET, 20_000_000);
        else if (mode == 3) clock.set(a, IMarketClock.Regime.OVERNIGHT, 2_000_000);
        else if (mode <= 6) clock.set(a, IMarketClock.Regime.CLOSED, 0);
        else clock.set(a, IMarketClock.Regime.UNKNOWN, 0);
        clock.setNextTransition(a, uint64(block.timestamp + (h >> 8) % 120 hours));
    }

    function setPrice(uint256 assetSeed, uint256 bps, uint256 failSeed) external {
        address a = _asset(assetSeed);
        bps = bound(bps, 2_500, 14_000); // deep enough that some liquidations take every share
        sc.setPrice(a, uint128(MulDiv.mulDiv(basePrice[a], bps, 1e4)));
        sc.setRevert(a, _h(failSeed) % 20 == 0);
    }

    function setDepth(uint256 assetSeed, uint256 shares, uint256 bidBps, uint256 life) external {
        address a = _asset(assetSeed);
        shares = bound(shares, 1e18, 300e18);
        bidBps = bound(bidBps, 2_000, 12_000);
        life = bound(life, 30 minutes, 7 days);
        // bidPx in USDG (6 dp) per share, relative to the base price (1e18 USD).
        uint128 bid = uint128(MulDiv.mulDiv(basePrice[a], bidBps, 1e4 * 1e12));
        dc.setDepth(a, address(credit), shares, bid, uint64(block.timestamp + life));
    }

    /// @dev The admin pulls part of the idle reserve out (so ReserveShort is reachable).
    function defund(uint256 bps) external {
        uint256 amount = MulDiv.mulDiv(credit.reserve(), bound(bps, 0, 9_000), 1e4);
        if (amount == 0) return;
        vm.prank(admin);
        credit.defund(amount, address(0xDEAD));
    }

    /// @dev The registry revokes (1 in 4) or restores an actor. Revocation blocks new deposits and borrows only.
    function setEligible(uint256 seed, uint256 coin) external {
        elig.set(_actor(seed), _h(coin) % 4 != 0);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 700));
    }

    function longWarp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 8 hours));
    }

    // =========================================================================================================
    // breach, cure, liquidation
    // =========================================================================================================

    function flagBreach(uint256 seed) external {
        (address who, address a) = _pick(seed, HAS_DEBT);
        try credit.flagBreach(who, a) {
            ++breaches;
        } catch {}
    }

    function tick(uint256 seed, uint256 gap) external {
        vm.warp(block.timestamp + bound(gap, 0, 900));
        (address who, address a) = _pick(seed, IN_CURE);
        _tick(who, a);
    }

    /// @dev The keeper (`script/w4/tick.sh`) runs for 1..12 rounds: five minutes pass, every live cure is ticked.
    function keeperRun(uint256 rounds) external {
        rounds = bound(rounds, 1, 12);
        for (uint256 r; r < rounds; ++r) _tickAll();
    }

    function tickAll() external {
        _tickAll();
    }

    function _tickAll() internal {
        vm.warp(block.timestamp + 300);
        for (uint256 i; i < _actors.length; ++i) {
            for (uint256 j; j < _assets.length; ++j) {
                _tick(_actors[i], _assets[j]);
            }
        }
    }

    function _tick(address who, address a) internal {
        CurbCredit.Cure memory c = credit.cureOf(who, a);
        if (!c.active) return;
        bool openNow = credit.isOpen(a);
        uint256 gap = block.timestamp - c.lastTickAt;
        credit.tick(who, a);
        ++ticks;
        CurbCredit.Cure memory d = credit.cureOf(who, a);
        if (!d.active) return; // cleared: the clock is gone, not moved
        if (d.openSecondsUsed < c.openSecondsUsed) {
            ++cureOverCounted; // the clock ran backwards
            return;
        }
        uint256 added = uint256(d.openSecondsUsed) - uint256(c.openSecondsUsed);
        if (!(c.lastOpen && openNow)) {
            ++shutTicks;
            if (added != 0) ++cureMovedAcrossShut;
        }
        // Only a witnessed gap of at most MAX_TICK_GAP may count, and then exactly once.
        if (added > (gap <= 600 ? gap : 0)) ++cureOverCounted;
    }

    function liquidate(uint256 seed) external {
        (address who, address a) = _pick(seed, IN_CURE);
        CurbCredit.Cure memory c = credit.cureOf(who, a);
        if (!c.active) return;
        bool openNow = credit.isOpen(a);
        uint256 debt = credit.debtOf(who, a);
        uint256 coll = credit.positionOf(who, a).collateral;
        uint256 bad0 = credit.badDebt(a);
        uint256[] memory others = _othersBreach(who, a);
        try credit.liquidate(who, a) {
            ++liquidations;
            if (!openNow) ++liquidatedWhileShut;
            if (c.openSecondsUsed < 1800) ++liquidatedEarly;
            _noneWorse(others, _othersBreach(who, a));
            uint256 left = credit.positionOf(who, a).collateral;
            uint256 seize = coll - left;
            uint256 cap = MulDiv.mulDiv(MulDiv.mulDiv(debt, 10_500, 1e4), 1e30, c.priceAtBreach);
            if (seize > cap) ++seizeOverStaleCap;
            if (left > 0) {
                ++partialLiquidations;
                if (credit.badDebt(a) != bad0) ++badDebtWithCollateralLeft;
                uint256 cleared = MulDiv.mulDiv(seize, sc.priceNow(a), 1e30);
                if (cleared > debt) cleared = debt;
                if (credit.debtOf(who, a) != debt - cleared) ++debtForgiven;
            }
        } catch {}
    }

    /// @dev State of every position except (who, a): 0 unknown, 1 known healthy, 2 known breached, 3 self (skipped).
    function _othersBreach(address who, address a) internal view returns (uint256[] memory st) {
        st = new uint256[](_actors.length * _assets.length);
        for (uint256 i; i < _actors.length; ++i) {
            for (uint256 j; j < _assets.length; ++j) {
                uint256 k = i * _assets.length + j;
                if (_actors[i] == who && _assets[j] == a) {
                    st[k] = 3;
                    continue;
                }
                (bool known, bool breached) = credit.isBreached(_actors[i], _assets[j]);
                st[k] = !known ? 0 : (breached ? 2 : 1);
            }
        }
    }

    /// @dev Depositor actions (deposit, withdraw) must not move any other position at all.
    function _anyChange(uint256[] memory before, uint256[] memory afterwards) internal {
        for (uint256 k; k < before.length; ++k) {
            if (before[k] != afterwards[k]) ++crossPositionBreachChange;
        }
    }

    /// @dev Lending actions on one position (borrow, repay, liquidate) may improve others -- repaying restores cover
    ///      for everyone -- but must never push a known-healthy position into breach.
    function _noneWorse(uint256[] memory before, uint256[] memory afterwards) internal {
        for (uint256 k; k < before.length; ++k) {
            if (before[k] == 1 && afterwards[k] == 2) ++crossPositionPushedIntoBreach;
        }
    }

    /// @dev Sell some seized shares into a fresh cert naming CurbCredit; sometimes the maker fades.
    function realise(uint256 assetSeed, uint256 shares, uint256 bidBps, bool fade) external {
        address a = _asset(assetSeed);
        uint256 have = credit.seized(a);
        if (have == 0) return;
        shares = bound(shares, 1, have);
        bidBps = bound(bidBps, 3_000, 11_000);
        uint128 bid = uint128(MulDiv.mulDiv(basePrice[a], bidBps, 1e4 * 1e12));
        uint256 id = dc.setCert(maker, a, address(credit), uint128(shares), bid, 1e6, uint64(block.timestamp + 1 days));
        usdg.mint(address(dc), MulDiv.mulDiv(shares, bid, 1e18) + 1e6);
        dc.setFade(id, fade);
        vm.prank(admin);
        credit.realise(id, shares);
        if (fade) ++realisedFades;
        else ++realisedFills;
    }

    /// @dev Exactly one event, the Refusal, must have been emitted; tally its reason.
    function _countRefusal() internal {
        ++refusals;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (logs.length != 1 || logs[0].topics[0] != CurbCredit.Refusal.selector) {
            ++refusalChangedState;
            return;
        }
        ++refusalsBy[bytes4(logs[0].topics[3])];
    }

    /// @dev Fuzz inputs are edge-biased (0, 1, max); hash the ones used as probabilities.
    function _h(uint256 x) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(x)));
    }

    function _positionDigest(address who, address a) internal view returns (bytes32) {
        CurbCredit.Position memory p = credit.positionOf(who, a);
        CurbCredit.Cure memory c = credit.cureOf(who, a);
        return keccak256(
            abi.encode(
                p.collateral,
                p.principal,
                p.accrued,
                p.lastAccrual,
                c.openSecondsUsed,
                credit.totalCollateral(a),
                credit.totalPrincipal(a),
                credit.reserve()
            )
        );
    }
}
