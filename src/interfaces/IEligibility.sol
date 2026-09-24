// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IEligibility
/// @notice Allowlist read by ClosedAuction (bidders) and CurbCredit (depositors/borrowers).
interface IEligibility {
    function isEligible(address who) external view returns (bool);
}
