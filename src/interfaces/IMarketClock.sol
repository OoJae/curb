// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IMarketClock
/// @notice Regime oracle for tokenized equities on X Layer.
/// @dev Free to read, no licence, no key. Built so every other RWA protocol on chain 196
///      can stop reimplementing market-hours logic. See docs/MARKETCLOCK.md.
interface IMarketClock {
    /// @dev Ordered by how much primary-market capacity exists, not alphabetically.
    ///      UNKNOWN is deliberately the zero value: an unattested asset must never be
    ///      mistaken for an open one.
    enum Regime {
        UNKNOWN,    // never attested, or attestation has gone stale
        CLOSED,     // primary creation/redemption capacity is zero
        OVERNIGHT,  // reduced-cap session (US names only)
        EXTENDED,   // pre/post session
        MARKET      // regular session, full primary capacity
    }

    struct State {
        Regime regime;
        uint128 primaryCapUsd;      // whole USD; 0 means creation/redemption is switched off
        uint64 nextTransitionAt;    // unix seconds, 0 if unknown
        uint64 observedAt;          // when the attestor read the issuer
        uint32 multiplierNonce;     // corporate-action counter read from the raw token
        bool halted;                // issuer-declared trading halt
    }

    event AssetRegistered(address indexed wrapper, address indexed raw, bytes4 mic, uint8 hoursMode);
    event StateAttested(
        address indexed wrapper,
        Regime regime,
        uint128 primaryCapUsd,
        uint64 nextTransitionAt,
        uint32 multiplierNonce,
        bytes32 inputRoot
    );
    event RegimeChanged(address indexed wrapper, Regime from, Regime to, uint64 at);
    event BlackoutOpened(address indexed wrapper, uint32 fromNonce, uint32 toNonce, uint64 until);

    function regime(address wrapper) external view returns (Regime);
    function primaryCapNow(address wrapper) external view returns (uint128);
    function secondsToNextTransition(address wrapper) external view returns (uint256);
    function isInMultiplierBlackout(address wrapper) external view returns (bool);
    function stateOf(address wrapper) external view returns (State memory);

    /// @notice Convert wrapper (ERC-4626) shares into underlying share-equivalents.
    /// @dev Reads the wrapper live. This is the single conversion every integrator gets wrong:
    ///      a wrapper balance is NOT a share count, and the gap is every corporate action ever applied.
    function rawToShares(address wrapper, uint256 wrapperShares) external view returns (uint256);
}
