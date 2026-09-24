// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IReopenPointer
/// @notice Monotonic, permissionless record of verified reopens per wrapper (frozen W3 spec, P0).
/// @dev An epoch advances only on an observed open whose last positive predecessor was an observed shut,
///      so the true reopen lies in (shutSeenAt, openedAt]. `print` is write-once per (wrapper, epoch).
interface IReopenPointer {
    struct Epoch { uint64 shutSeenAt; uint64 openedAt; uint64 openedBlock; uint128 print; uint64 printedAt; }

    event Shut(address indexed wrapper, uint32 indexed epoch, uint64 at);
    event Reopened(address indexed wrapper, uint32 indexed epoch, uint64 shutSeenAt, uint64 openedAt, uint128 primaryCapUsd);
    event Printed(address indexed wrapper, uint32 indexed epoch, uint128 print, uint64 at);

    function observe(address wrapper) external returns (uint32 epoch, bool open);   // permissionless
    function recordPrint(address wrapper, uint32 epoch) external returns (uint128);  // permissionless
    function epochOf(address wrapper) external view returns (uint32);
    function isOpen(address wrapper) external view returns (bool);
    function epochInfo(address wrapper, uint32 epoch) external view returns (Epoch memory);
}
