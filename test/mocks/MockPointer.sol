// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IReopenPointer} from "../../src/interfaces/IReopenPointer.sol";

/// @notice Settable IReopenPointer for ClosedAuction unit tests. No clock: the test sets the epoch, the
///         open flag and the prints directly, and `observe` just reports them (and counts the calls).
/// @dev `epochInfo` of an epoch above the head reverts `UnknownEpoch`, like the real pointer is free to.
///      `reopen(w)` models a witnessed shut→open (epoch+1, open); `shut(w)` models the next witnessed shut.
contract MockPointer is IReopenPointer {
    error UnknownEpoch();

    mapping(address => uint32) public epochOf;
    mapping(address => bool) public isOpen;
    mapping(address => mapping(uint32 => Epoch)) internal _epochs;
    mapping(address => uint256) public observeCalls;

    // --- test controls ---------------------------------------------------------------------

    function setEpoch(address w, uint32 e) external { epochOf[w] = e; }
    function setOpen(address w, bool open) external { isOpen[w] = open; }

    function reopen(address w) external {
        uint32 e = ++epochOf[w];
        isOpen[w] = true;
        _epochs[w][e].shutSeenAt = uint64(block.timestamp) - 1;
        _epochs[w][e].openedAt = uint64(block.timestamp);
        _epochs[w][e].openedBlock = uint64(block.number);
    }

    function shut(address w) external { isOpen[w] = false; }

    function setPrint(address w, uint32 e, uint128 print) external {
        _epochs[w][e].print = print;
        _epochs[w][e].printedAt = uint64(block.timestamp);
    }

    // --- IReopenPointer --------------------------------------------------------------------

    function observe(address w) external returns (uint32 epoch, bool open) {
        ++observeCalls[w];
        return (epochOf[w], isOpen[w]);
    }

    function recordPrint(address w, uint32 e) external view returns (uint128) {
        if (e == 0 || e > epochOf[w]) revert UnknownEpoch();
        return _epochs[w][e].print;
    }

    function epochInfo(address w, uint32 e) external view returns (Epoch memory) {
        if (e > epochOf[w]) revert UnknownEpoch();
        return _epochs[w][e];
    }
}
