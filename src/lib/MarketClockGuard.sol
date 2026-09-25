// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketClock} from "../interfaces/IMarketClock.sol";

/// @title MarketClockGuard
/// @notice Refuse to act on a wrapped xStock while its primary market is shut. Internal functions only, so
///         nothing is deployed and nothing is trusted beyond MarketClock itself.
///
/// @dev "Arbitraged" means the issuer can create and redeem right now, so arbitrage holds the wrapper to the
///      stock. It is true exactly when MarketClockStatus.marketStatus is 2, 3 or 4, and requires all of:
///        - `regime()` is OVERNIGHT, EXTENDED or MARKET (UNKNOWN, i.e. never attested or stale, and CLOSED fail);
///        - `primaryCapNow()` > 0 (the issuer's cut makes an open label with a zero cap shut);
///        - no corporate-action blackout;
///        - no issuer-declared halt.
///      The live attestor writes a halt as CLOSED with cap 0, so on every state it writes this is exactly
///      `primaryCapNow > 0 && !isInMultiplierBlackout`. The other checks keep the answer independent of the
///      writer. `halted` is read from `stateOf()`, which does not fail closed, only after `regime()` has
///      proved the attestation fresh, and it can only turn an answer to shut.
library MarketClockGuard {
    /// @param regime MarketClock's label when the guard refused. MARKET, EXTENDED or OVERNIGHT here means the
    ///        label was open but the cap was zero, a blackout was running, or the issuer had halted.
    error MarketShut(address wrapper, IMarketClock.Regime regime);
    error MultiplierBlackout(address wrapper);
    error NoMarketClock();

    /// @dev The deployed MarketClock on X Layer (chain 196). On a chain with no code at this address (X Layer
    ///      testnet 1952 had none on 25 Sep 2026), every guard call reverts, which is the closed direction.
    address internal constant XLAYER_MARKET_CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;

    /// @notice True when primary creation and redemption are live for `wrapper`. See the library notes.
    function isArbitraged(IMarketClock clock, address wrapper) internal view returns (bool ok) {
        (ok,) = _check(clock, wrapper);
    }

    /// @notice Revert with MarketShut unless `wrapper` is arbitraged. Put this before anything that values
    ///         the wrapper at a market price: a borrow, a liquidation, a mark.
    function requireArbitraged(IMarketClock clock, address wrapper) internal view {
        (bool ok, IMarketClock.Regime r) = _check(clock, wrapper);
        if (!ok) revert MarketShut(wrapper, r);
    }

    /// @notice Revert with MultiplierBlackout while a corporate action is being applied to `wrapper`. Put this
    ///         before anything that settles in wrapper balances, whether or not the market is open.
    function requireNotBlackout(IMarketClock clock, address wrapper) internal view {
        if (clock.isInMultiplierBlackout(wrapper)) revert MultiplierBlackout(wrapper);
    }

    /// @dev Short-circuits in this order, so a shut asset costs one or two calls and `stateOf` is reached
    ///      only with a fresh, open-labelled, capacity-positive attestation.
    function _check(IMarketClock clock, address wrapper) private view returns (bool ok, IMarketClock.Regime r) {
        r = clock.regime(wrapper);
        ok = r != IMarketClock.Regime.UNKNOWN && r != IMarketClock.Regime.CLOSED
            && clock.primaryCapNow(wrapper) > 0
            && !clock.isInMultiplierBlackout(wrapper)
            && !clock.stateOf(wrapper).halted;
    }
}

/// @title MarketClockGuarded
/// @notice Inherit this to get the guard as two modifiers. The clock is fixed at construction.
///
///   contract Pool is MarketClockGuarded(IMarketClock(MarketClockGuard.XLAYER_MARKET_CLOCK)) {
///       function borrow(address wrapper, uint256 amount) external whenPrimaryOpen(wrapper) { ... }
///   }
abstract contract MarketClockGuarded {
    IMarketClock public immutable marketClock;

    constructor(IMarketClock clock_) {
        if (address(clock_) == address(0)) revert MarketClockGuard.NoMarketClock();
        marketClock = clock_;
    }

    /// @dev Reverts MarketShut unless the issuer can create and redeem `wrapper` right now.
    modifier whenPrimaryOpen(address wrapper) {
        MarketClockGuard.requireArbitraged(marketClock, wrapper);
        _;
    }

    /// @dev Reverts MultiplierBlackout while a corporate action is being applied to `wrapper`.
    modifier notDuringBlackout(address wrapper) {
        MarketClockGuard.requireNotBlackout(marketClock, wrapper);
        _;
    }
}
