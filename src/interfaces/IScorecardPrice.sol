// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IScorecardPrice
/// @notice The two read-only getters W3/W4 consume from the deployed Scorecard v2
///         (`0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f`, `src/Scorecard.sol`).
/// @dev Matches the deployed contract exactly. `priceNow` is Scorecard's TWAP-guarded spot, 1e18 USD per
///      whole wrapper share; it reverts (NoPriceSource / PriceUnreadable / PriceDeviates) rather than guess.
///      `priceSources` is the auto-generated getter of `mapping(address => PriceSource) public priceSources`,
///      whose struct is {pool, equityIsToken0, twapWindow, equityDecimals, stableDecimals}; an unregistered
///      wrapper reads back as all zeroes (`pool == address(0)`).
interface IScorecardPrice {
    function priceNow(address wrapper) external view returns (uint128);
    function priceSources(address wrapper)
        external
        view
        returns (address pool, bool equityIsToken0, uint32 twapWindow, uint8 equityDecimals, uint8 stableDecimals);
}
