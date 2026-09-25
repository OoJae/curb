// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketClock} from "../interfaces/IMarketClock.sol";

/// @title MarketClockStatus
/// @notice MarketClock's answer for a wrapped xStock, in the `marketStatus` codes of Chainlink Data Streams'
///         RWA Advanced (v11) report, so code already written against that field can read a Curb wrapper
///         without learning MarketClock's enum.
///
/// @dev WHAT THE CODES MEAN HERE. The numbering is v11's; the facts are MarketClock's. This contract is not a
///      Chainlink product and reads no Chainlink feed. v11 describes the venue's session. For a wrapped xStock
///      the question that matters is narrower: can the issuer create and redeem right now, so that arbitrage
///      holds the wrapper to the stock? So every code except 0 is decided by the issuer's primary cap, and
///      2, 3 and 4 are only ever returned while that cap is non-zero.
///
///        0  UNKNOWN      MarketClock has never attested this wrapper (including any address it does not
///                        list), or its last attestation is older than MAX_ATTESTATION_AGE (30 minutes).
///                        Treat it as shut: it means "nobody is looking", never "open".
///        1  PRE-MARKET   Never returned. MarketClock's EXTENDED does not split pre-market from post-market.
///        2  REGULAR      Regime MARKET, primary cap > 0, no corporate-action blackout, no issuer halt.
///        3  POST-MARKET  Regime EXTENDED with a primary cap > 0 (and no blackout or halt). This is any
///                        extended session, before or after the regular one: see code 1.
///        4  OVERNIGHT    Regime OVERNIGHT with a primary cap > 0 (and no blackout or halt). US names only.
///        5  CLOSED       Creation and redemption are off, so the wrapper is unarbitraged:
///                        - regime CLOSED;
///                        - regime OVERNIGHT, EXTENDED or MARKET but a primary cap of zero. The live attestor
///                          already writes CLOSED in that case (derive/2 onwards); it is mapped here anyway,
///                          so the answer does not depend on the writer;
///                        - an issuer-declared halt;
///                        - a corporate-action blackout (MarketClock.BLACKOUT_WINDOW after an observed change
///                          in the wrapper's multiplier nonce): the share rate has just moved, so nothing
///                          denominated in wrapper balances should settle yet.
///
///      Two consequences worth knowing:
///      - 5 covers the issuer's own cut. As measured (docs/DECISIONS.md, D-4), each issuer period ends 300
///        seconds before its scheduled end. For those five minutes the venue's calendar still says open, while
///        MarketClock (from the attestor's next round, seconds later) says CLOSED and this contract says 5.
///      - Hong Kong names read only 0, 2 or 5 on the live clock: their extended sessions carry a zero cap and
///        are attested CLOSED. That matches v11's standard-hours convention, where 1, 3 and 4 do not appear.
///
///      FAIL-CLOSED READS ONLY. Status is decided by `regime()` and `primaryCapNow()`, which report UNKNOWN and
///      0 on a stale attestation. `stateOf()` does not fail closed (it returns the last stored cap however old),
///      so it is read for one field only, `halted`, and only after `regime()` has confirmed the attestation is
///      fresh. That field can only turn an answer into 5, never out of it.
///
///      No admin, no storage other than the immutable clock, no funds, no writes.
contract MarketClockStatus {
    error ZeroAddress();

    uint32 public constant STATUS_UNKNOWN = 0;
    uint32 public constant STATUS_PRE_MARKET = 1; // never returned; kept so the whole v11 table is named
    uint32 public constant STATUS_REGULAR = 2;
    uint32 public constant STATUS_POST_MARKET = 3;
    uint32 public constant STATUS_OVERNIGHT = 4;
    uint32 public constant STATUS_CLOSED = 5;

    IMarketClock public immutable clock;

    constructor(IMarketClock clock_) {
        if (address(clock_) == address(0)) revert ZeroAddress();
        clock = clock_;
    }

    /// @notice `wrapper`'s status as a v11 `marketStatus` code: 0, 2, 3, 4 or 5 (never 1). See the contract notes.
    function marketStatus(address wrapper) public view returns (uint32) {
        IMarketClock.Regime r = clock.regime(wrapper);
        if (r == IMarketClock.Regime.UNKNOWN) return STATUS_UNKNOWN;
        if (r == IMarketClock.Regime.CLOSED) return STATUS_CLOSED;
        if (clock.isInMultiplierBlackout(wrapper)) return STATUS_CLOSED;
        // The issuer's cut: an open label with no capacity is closed economically.
        if (clock.primaryCapNow(wrapper) == 0) return STATUS_CLOSED;
        // Safe to read from stateOf: regime() above proved this attestation fresh, and a halt only closes.
        if (clock.stateOf(wrapper).halted) return STATUS_CLOSED;
        if (r == IMarketClock.Regime.MARKET) return STATUS_REGULAR;
        if (r == IMarketClock.Regime.EXTENDED) return STATUS_POST_MARKET;
        return STATUS_OVERNIGHT;
    }

    /// @notice True when primary creation and redemption are live for `wrapper`, so arbitrage holds it to
    ///         the stock: exactly when `marketStatus` is 2, 3 or 4.
    /// @dev On every state the live attestor writes this equals `primaryCapNow > 0 && !isInMultiplierBlackout`
    ///      (it writes a halt as CLOSED with cap 0). MarketClockGuard.isArbitraged is the same predicate.
    function isArbitraged(address wrapper) external view returns (bool) {
        uint32 s = marketStatus(wrapper);
        return s != STATUS_UNKNOWN && s != STATUS_CLOSED;
    }

    /// @notice MarketClock's `secondsToNextTransition`, unchanged: seconds to the next boundary in the venue's
    ///         schedule as last attested, or 0 when unknown or already passed.
    /// @dev The next SCHEDULE boundary, not the reopen. A closure routinely spans several boundaries (Hong Kong
    ///      15:55 -> 16:00 -> 16:10 -> 09:00 -> 09:30), and it does not fail closed: a stale attestation still
    ///      reports its stored boundary. Use it for display and timers, not to decide whether a market is open.
    function secondsToNextTransition(address wrapper) external view returns (uint256) {
        return clock.secondsToNextTransition(wrapper);
    }

    /// @notice `marketStatus` for each of `wrappers`, in order.
    function statusMany(address[] calldata wrappers) external view returns (uint32[] memory statuses) {
        statuses = new uint32[](wrappers.length);
        for (uint256 i; i < wrappers.length; ++i) statuses[i] = marketStatus(wrappers[i]);
    }
}
