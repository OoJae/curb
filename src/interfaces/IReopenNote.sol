// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IReopenNote
/// @notice ERC-1155 note escrowing wrapper shares minted while the primary market is shut, redeemable
///         for exactly the escrowed shares after a verified reopen (or the 10-day fallback). Frozen W3 spec, P0.
/// @dev 1 unit = 1 wei of wrapper share. The last three functions are the ERC-1155 subset consumers call;
///      an implementation inheriting `ERC1155Min` must override them with `override(ERC1155Min, IReopenNote)`.
interface IReopenNote {
    struct Unit { address wrapper; address issuer; uint128 wrapperShares; uint128 underlyingAtMint;
                  uint32 multiplierNonce; uint32 epochAtMint; uint64 mintedAt; uint64 mintedBlock; }

    function mint(address wrapper, uint128 wrapperShares, address to) external returns (uint256 id);
    function redeem(uint256 id, uint128 amount, address to) external;   // burns msg.sender's units
    function cancel(uint256 id) external;                               // issuer holding ALL outstanding
    function unitOf(uint256 id) external view returns (Unit memory);
    function outstanding(uint256 id) external view returns (uint128);
    function redeemable(uint256 id) external view returns (bool);
    function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external;
    function balanceOf(address, uint256) external view returns (uint256);
    function isApprovedForAll(address, address) external view returns (bool);
}
