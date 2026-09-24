// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";
import {MulDiv} from "../../src/lib/MulDiv.sol";

interface IConvertToAssets {
    function convertToAssets(uint256 shares) external view returns (uint256);
}

/// @notice Fully settable IMarketClock. Defaults mirror the real clock for an unattested asset:
///         UNKNOWN, cap 0, no blackout, nonce 0.
/// @dev Like the real MarketClock, `primaryCapNow` reads 0 whenever the regime is UNKNOWN, whatever cap
///      is stored (a stale attestation never looks open). `stateOf` returns the raw stored State.
///      `rawToShares`: an explicit rate set via `setRawRate` wins; otherwise it calls the wrapper's
///      `convertToAssets` like the real clock; a wrapper with no code converts 1:1.
contract MockClock is IMarketClock {
    mapping(address => State) internal _s;
    mapping(address => bool) public blackout;
    mapping(address => uint256) public rawRate;      // underlying per 1e18 wrapper shares
    mapping(address => bool) public rawRateSet;

    // --- test controls ---------------------------------------------------------------------

    /// @notice Regime and cap in one call, e.g. `set(w, CLOSED, 0)` or `set(w, MARKET, 20_000_000)`.
    function set(address wrapper, Regime r, uint128 cap) external {
        State storage s = _s[wrapper];
        s.regime = r;
        s.primaryCapUsd = cap;
        s.observedAt = uint64(block.timestamp);
    }

    function setRegime(address wrapper, Regime r) external {
        _s[wrapper].regime = r;
        _s[wrapper].observedAt = uint64(block.timestamp);
    }

    function setCap(address wrapper, uint128 cap) external { _s[wrapper].primaryCapUsd = cap; }
    function setBlackout(address wrapper, bool on) external { blackout[wrapper] = on; }
    function setNonce(address wrapper, uint32 nonce) external { _s[wrapper].multiplierNonce = nonce; }
    function setNextTransition(address wrapper, uint64 at) external { _s[wrapper].nextTransitionAt = at; }
    function setHalted(address wrapper, bool halted) external { _s[wrapper].halted = halted; }
    function setState(address wrapper, State calldata s) external { _s[wrapper] = s; }

    function setRawRate(address wrapper, uint256 rate) external {
        rawRate[wrapper] = rate;
        rawRateSet[wrapper] = true;
    }

    function clearRawRate(address wrapper) external {
        rawRate[wrapper] = 0;
        rawRateSet[wrapper] = false;
    }

    // --- IMarketClock ----------------------------------------------------------------------

    function regime(address wrapper) external view returns (Regime) {
        return _s[wrapper].regime;
    }

    function primaryCapNow(address wrapper) external view returns (uint128) {
        State storage s = _s[wrapper];
        return s.regime == Regime.UNKNOWN ? 0 : s.primaryCapUsd;
    }

    function secondsToNextTransition(address wrapper) external view returns (uint256) {
        uint64 t = _s[wrapper].nextTransitionAt;
        if (t == 0 || t <= block.timestamp) return 0;
        return t - block.timestamp;
    }

    function isInMultiplierBlackout(address wrapper) external view returns (bool) {
        return blackout[wrapper];
    }

    function stateOf(address wrapper) external view returns (State memory) {
        return _s[wrapper];
    }

    function rawToShares(address wrapper, uint256 wrapperShares) external view returns (uint256) {
        if (rawRateSet[wrapper]) return MulDiv.mulDiv(wrapperShares, rawRate[wrapper], 1e18);
        if (wrapper.code.length == 0) return wrapperShares;
        return IConvertToAssets(wrapper).convertToAssets(wrapperShares);
    }
}
