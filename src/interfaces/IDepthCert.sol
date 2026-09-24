// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IDepthCert
/// @notice Bonded, one-sided firm bids for wrapper shares whose fade is self-proving on-chain. No admin.
///         Frozen W4 spec, P0.
/// @dev `bidPx` is USDG units (6 dp) per whole share (1e18 wei); `notional(S, px) = mulDiv(S, px, 1e18)`.
interface IDepthCert {
    enum Status { NONE, LIVE, FADED, CLOSED }

    struct Cert { address maker; address wrapper; address beneficiary; uint128 sizeShares; uint128 remainingShares;
                  uint128 bidPx; uint128 bond; uint64 postedAt; uint64 expiry; Status status; }

    function post(address wrapper, address beneficiary, uint128 sizeShares, uint128 bidPx, uint64 expiry, uint128 bond) external returns (uint256 id);
    function take(uint256 id, uint128 shares, address to) external returns (bool filled, uint256 amount);
    function withdraw(uint256 id) external;                       // maker; after expiry or remaining==0
    function claimShares(address wrapper, address to) external returns (uint256);
    function prune(address wrapper, address beneficiary) external; // permissionless book compaction
    function certOf(uint256 id) external view returns (Cert memory);
    function isHonourable(address maker) external view returns (bool);
    function honouredDepth(address wrapper, address beneficiary, uint64 minExpiry) external view
        returns (uint256 shares, uint256 notional, uint128 minBidPx, uint64 soonestExpiry);
}
