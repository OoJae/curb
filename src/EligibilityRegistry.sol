// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEligibility} from "./interfaces/IEligibility.sol";

/// @title EligibilityRegistry
/// @notice Thin allowlist read by ClosedAuction (bidders) and CurbCredit (depositors and borrowers).
/// @dev Every change carries a 32-byte `evidence` hash (e.g. `keccak256("team:curb-desk")`, or the hash of
///      an off-chain attestation), so the on-chain record says why an address was admitted or removed.
///      Two-step admin handover copied from MarketClock: a mistyped address cannot brick the registry.
contract EligibilityRegistry is IEligibility {
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error Reentrant();

    event EligibilitySet(address indexed who, bool ok, bytes32 evidence);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    address public admin;
    address public pendingAdmin;
    mapping(address => bool) public isEligible;

    uint256 private _lock = 1;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    /// @notice Admit or remove `who`, recording the evidence for the decision.
    function setEligible(address who, bool ok, bytes32 evidence) external nonReentrant onlyAdmin {
        if (who == address(0)) revert ZeroAddress();
        isEligible[who] = ok;
        emit EligibilitySet(who, ok, evidence);
    }

    /// @notice Start handing admin rights to `to`. Takes effect only when `to` accepts.
    function transferAdmin(address to) external nonReentrant onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    /// @notice Complete a handover started by the current admin.
    function acceptAdmin() external nonReentrant {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }
}
