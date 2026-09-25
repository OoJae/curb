// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// One import: MarketClockGuard.sol re-exports IMarketClock (docs/MARKETCLOCK.md, "Three lines to integrate").
import {IMarketClock, MarketClockGuard, MarketClockGuarded} from "../lib/MarketClockGuard.sol";

/// @notice Documentation, not a product: never deployed, holds nothing, lends nothing. It shows where the two
///         MarketClockGuard modifiers go in a lending market that takes wrapped xStocks as collateral.
contract ExampleLendingGuard is MarketClockGuarded(IMarketClock(MarketClockGuard.XLAYER_MARKET_CLOCK)) {
    event Deposited(address indexed owner, address indexed wrapper, uint256 shareEquivalents);
    event Borrowed(address indexed borrower, address indexed wrapper, uint256 amount);

    /// @notice Adding collateral is fine while the market is shut, but it is credited in share-equivalents,
    ///         and that rate is moving while a corporate action is applied. Refused with MultiplierBlackout then.
    function deposit(address wrapper, uint256 shares) external notDuringBlackout(wrapper) {
        // ... pull `shares` of `wrapper` from the caller ...
        emit Deposited(msg.sender, wrapper, marketClock.rawToShares(wrapper, shares));
    }

    /// @notice Opening debt values the collateral at a market price, and while the primary market is shut
    ///         nothing holds that price to the stock. Refused with MarketShut until the issuer's cap returns.
    function borrow(address wrapper, uint256 amount) external whenPrimaryOpen(wrapper) {
        // ... value the collateral, check the loan-to-value, pay out `amount` ...
        emit Borrowed(msg.sender, wrapper, amount);
    }
}
