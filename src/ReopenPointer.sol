// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketClock} from "./interfaces/IMarketClock.sol";
import {IScorecardPrice} from "./interfaces/IScorecardPrice.sol";
import {IReopenPointer} from "./interfaces/IReopenPointer.sol";

/// @title ReopenPointer
/// @notice A monotonic, permissionless record of verified reopens per wrapper, and one write-once
///         reopen print per (wrapper, epoch).
///
/// @dev WHY THIS EXISTS. A ReopenNote minted while the primary market is shut becomes redeemable
///      when the market has reopened, and a closed-market auction must stop clearing the moment it
///      has. Both need one answer to "has this asset reopened since X?" that nobody can fake or
///      backdate. The pointer only ever believes what it has itself witnessed through MarketClock:
///
///      - An epoch advances only on an OPEN observation whose last non-UNKNOWN predecessor was a SHUT
///        observation, so the true reopen lies in (shutSeenAt, openedAt].
///      - The very first open this contract ever sees creates no epoch: it never saw the market shut,
///        so it cannot claim a reopen happened.
///      - A stale clock (UNKNOWN) changes nothing. "We stopped looking" is never read as shut or open.
///      - A shut and an open seen in the same second would give an empty bracket (t, t], so the open is
///        not taken until a later second (see `observe`); the bracket is always strict.
///
///      The print is Scorecard's own TWAP-guarded `priceNow`, taken between PRINT_DELAY and
///      PRINT_DELAY + PRINT_WINDOW after the witnessed reopen, once, for every note of that asset and
///      epoch. Nobody can pick a better moment after the first successful call.
///
///      No admin, no upgrade, no pause.
contract ReopenPointer is IReopenPointer {
    error UnknownEpoch();
    error PrintTooEarly(uint64 readyAt);
    error PrintTooLate(uint64 deadline);
    error AlreadyPrinted();
    error MarketShut();
    error Reentrancy();
    error ZeroAddress();

    /// @dev Equal to Scorecard.SETTLE_DELAY: the TWAP guard's window then lies after the reopen.
    uint64 public constant PRINT_DELAY = 300;
    uint64 public constant PRINT_WINDOW = 30 minutes;

    /// @dev `lastShutAt` is the latest second a shut was witnessed (0 = never). `lastObservedAt` is the
    ///      latest non-UNKNOWN observation.
    struct Head {
        uint32 epoch;
        bool open;
        uint64 lastShutAt;
        uint64 lastObservedAt;
    }

    IMarketClock public immutable clock;
    IScorecardPrice public immutable scorecard;

    mapping(address wrapper => Head) internal _heads;
    mapping(address wrapper => mapping(uint32 epoch => Epoch)) internal _epochs;

    /// @dev Storage-slot lock: 1 = free, 2 = entered. Starts at 1 so entering never pays a zero->nonzero write.
    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IMarketClock clock_, IScorecardPrice scorecard_) {
        if (address(clock_) == address(0) || address(scorecard_) == address(0)) revert ZeroAddress();
        clock = clock_;
        scorecard = scorecard_;
    }

    // --- writes ---------------------------------------------------------------------------------

    /// @notice Witness `wrapper`'s primary market now. Anyone may call; every consumer calls it first.
    /// @return epoch Number of verified reopens so far (0 = none witnessed).
    /// @return open  Whether the latest non-UNKNOWN observation found the market open.
    function observe(address wrapper) external nonReentrant returns (uint32 epoch, bool open) {
        Head storage h = _heads[wrapper];
        if (clock.regime(wrapper) == IMarketClock.Regime.UNKNOWN) return (h.epoch, h.open);

        uint128 cap = clock.primaryCapNow(wrapper);
        uint64 now_ = uint64(block.timestamp);
        if (cap == 0) {
            if (h.open) {
                h.open = false;
                emit Shut(wrapper, h.epoch, now_);
            }
            h.lastShutAt = now_;
        } else if (!h.open) {
            uint64 shutSeenAt = h.lastShutAt;
            if (shutSeenAt == 0) {
                // Never witnessed shut: the market is open, but no reopen can be claimed.
                h.open = true;
            } else if (shutSeenAt < now_) {
                uint32 e = h.epoch + 1;
                h.epoch = e;
                h.open = true;
                _epochs[wrapper][e] = Epoch({
                    shutSeenAt: shutSeenAt,
                    openedAt: now_,
                    openedBlock: uint64(block.number),
                    print: 0,
                    printedAt: 0
                });
                emit Reopened(wrapper, e, shutSeenAt, now_, cap);
            } else {
                // Shut and open in the same second: (t, t] is empty, so wait for a later second.
                h.lastObservedAt = now_;
                return (h.epoch, false);
            }
        }
        h.lastObservedAt = now_;
        return (h.epoch, h.open);
    }

    /// @notice Record the reopen print for (`wrapper`, `epoch`): Scorecard's guarded spot, once.
    /// @dev Only inside [openedAt + PRINT_DELAY, openedAt + PRINT_DELAY + PRINT_WINDOW] and only while the
    ///      primary market is open. A reverting price (no source, unreadable, TWAP deviation) reverts the
    ///      call and leaves the epoch unprinted, so it can be retried inside the window.
    function recordPrint(address wrapper, uint32 epoch) external nonReentrant returns (uint128 print) {
        if (epoch == 0 || epoch > _heads[wrapper].epoch) revert UnknownEpoch();
        Epoch storage ep = _epochs[wrapper][epoch];
        if (ep.printedAt != 0) revert AlreadyPrinted();
        uint64 readyAt = ep.openedAt + PRINT_DELAY;
        if (block.timestamp < readyAt) revert PrintTooEarly(readyAt);
        uint64 deadline = readyAt + PRINT_WINDOW;
        if (block.timestamp > deadline) revert PrintTooLate(deadline);
        if (clock.primaryCapNow(wrapper) == 0) revert MarketShut();

        print = scorecard.priceNow(wrapper);
        ep.print = print;
        ep.printedAt = uint64(block.timestamp);
        emit Printed(wrapper, epoch, print, uint64(block.timestamp));
    }

    // --- views ----------------------------------------------------------------------------------

    function epochOf(address wrapper) external view returns (uint32) {
        return _heads[wrapper].epoch;
    }

    function isOpen(address wrapper) external view returns (bool) {
        return _heads[wrapper].open;
    }

    /// @notice The stored bracket and print for an epoch; all zeroes for epoch 0 or one not yet reached.
    function epochInfo(address wrapper, uint32 epoch) external view returns (Epoch memory) {
        return _epochs[wrapper][epoch];
    }

    function headOf(address wrapper) external view returns (Head memory) {
        return _heads[wrapper];
    }
}
