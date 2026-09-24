// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title SafeTransfer
/// @notice ERC-20 moves that fail loudly: a revert, a `false` return, malformed return data, or a call
///         to an address with no code all revert with `TransferFailed(token)`.
/// @dev Tokens that return nothing (USDT-style) are accepted, but only when the target has code, since
///      a call to an empty account also "succeeds" with no data. Overloaded for `address` and `IERC20`
///      so both `using SafeTransfer for address` and `using SafeTransfer for IERC20` work.
///      Not for DepthCert's gas-capped maker leg, which needs its own low-level call.
library SafeTransfer {
    error TransferFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        _check(token, ok, ret);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        _check(token, ok, ret);
    }

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        safeTransfer(address(token), to, amount);
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        safeTransferFrom(address(token), from, to, amount);
    }

    function _check(address token, bool ok, bytes memory ret) private view {
        if (!ok) revert TransferFailed(token);
        if (ret.length == 0) {
            if (token.code.length == 0) revert TransferFailed(token);
            return;
        }
        // Exactly the ABI encoding of `true`; decoding as uint256 means junk data reverts with our error.
        if (ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert TransferFailed(token);
    }
}
