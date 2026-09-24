// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./MockERC20.sol";
import {MulDiv} from "../../src/lib/MulDiv.sol";

/// @notice An 18-decimal ERC-4626-shaped wrapper share: a MockERC20 (so freeze/returnFalse apply) with
///         `asset()` and a settable `convertToAssets` rate, standing in for wTCENTx/wNVDAx/wAAPLx.
/// @dev `rate` is underlying assets per 1e18 shares (1e18 = 1:1). Changing it models a corporate action
///      the 4626 share absorbs; MockClock.rawToShares passes through to it unless overridden.
contract MockWrapper4626 is MockERC20 {
    address public immutable asset;
    uint256 public rate = 1e18;

    constructor(address asset_, string memory name_, string memory symbol_) MockERC20(name_, symbol_, 18) {
        asset = asset_;
    }

    function setRate(uint256 rate_) external { rate = rate_; }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return MulDiv.mulDiv(shares, rate, 1e18);
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return MulDiv.mulDiv(assets, 1e18, rate);
    }
}
