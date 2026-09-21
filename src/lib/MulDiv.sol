// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MulDiv
/// @notice Full-precision `a * b / denominator`, where `a * b` may exceed 256 bits.
/// @dev Needed because a Uniswap V3 price is `sqrtPriceX96^2 / 2^192`, and `sqrtPriceX96` can be
///      up to 2^160, so the square overflows uint256 long before the division brings it back.
///      Rounding is toward zero. Reverts on a zero denominator, and on a result above 2^256-1.
///
///      This is the standard 512-bit algorithm (Remco Bloemen's `mulmod` trick, as used by
///      OpenZeppelin's `Math.mulDiv`, MIT). It is reproduced here rather than imported so the
///      repository keeps a single, auditable dependency surface: only forge-std is vendored, and
///      Uniswap's own libraries are GPL, which would not sit under this file's MIT licence.
library MulDiv {
    error ZeroDenominator();
    error Overflow();

    function mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(x, y, not(0))
                prod0 := mul(x, y)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            if (prod1 == 0) {
                if (d == 0) revert ZeroDenominator();
                return prod0 / d;
            }
            if (d <= prod1) revert Overflow();

            uint256 remainder;
            assembly {
                remainder := mulmod(x, y, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            uint256 twos = d & (~d + 1);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }
}
