// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC20
/// @notice The ERC-20 surface Curb's W3/W4 contracts touch (USDG and the ERC-4626 wrappers).
/// @dev Move tokens through `src/lib/SafeTransfer.sol`, never by trusting a bare `transfer` return.
interface IERC20 {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
