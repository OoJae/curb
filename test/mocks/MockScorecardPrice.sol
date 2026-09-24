// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IScorecardPrice} from "../../src/interfaces/IScorecardPrice.sol";

/// @notice Settable IScorecardPrice. Reverts the way the real Scorecard does: `NoPriceSource` when the
///         wrapper has no registered source, `PriceUnreadable` when toggled to fail (or price is 0).
/// @dev `setPrice` auto-registers a default source (dummy pool, wrapper token0, 120 s TWAP, 18/6 dp) if
///      none exists, so a priced wrapper passes ReopenNote's "has a price source" constructor check.
///      Use `clearPriceSource` for the negative case.
contract MockScorecardPrice is IScorecardPrice {
    error NoPriceSource(address wrapper);
    error PriceUnreadable(address pool);

    struct Source {
        address pool;
        bool equityIsToken0;
        uint32 twapWindow;
        uint8 equityDecimals;
        uint8 stableDecimals;
    }

    mapping(address => uint128) public price;
    mapping(address => Source) internal _src;
    mapping(address => bool) public revertFor;
    bool public revertAll;

    // --- test controls ---------------------------------------------------------------------

    function setPrice(address wrapper, uint128 p) external {
        price[wrapper] = p;
        if (_src[wrapper].pool == address(0)) {
            _src[wrapper] = Source({
                pool: address(uint160(uint256(keccak256(abi.encode("mock-pool", wrapper))))),
                equityIsToken0: true,
                twapWindow: 120,
                equityDecimals: 18,
                stableDecimals: 6
            });
        }
    }

    function setPriceSource(
        address wrapper,
        address pool,
        bool equityIsToken0,
        uint32 twapWindow,
        uint8 equityDecimals,
        uint8 stableDecimals
    ) external {
        _src[wrapper] = Source(pool, equityIsToken0, twapWindow, equityDecimals, stableDecimals);
    }

    function clearPriceSource(address wrapper) external { delete _src[wrapper]; }
    function setRevert(address wrapper, bool on) external { revertFor[wrapper] = on; }
    function setRevertAll(bool on) external { revertAll = on; }

    // --- IScorecardPrice -------------------------------------------------------------------

    function priceNow(address wrapper) external view returns (uint128) {
        address pool = _src[wrapper].pool;
        if (pool == address(0)) revert NoPriceSource(wrapper);
        if (revertAll || revertFor[wrapper] || price[wrapper] == 0) revert PriceUnreadable(pool);
        return price[wrapper];
    }

    function priceSources(address wrapper)
        external
        view
        returns (address pool, bool equityIsToken0, uint32 twapWindow, uint8 equityDecimals, uint8 stableDecimals)
    {
        Source memory s = _src[wrapper];
        return (s.pool, s.equityIsToken0, s.twapWindow, s.equityDecimals, s.stableDecimals);
    }
}
