// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IReopenNote} from "../../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../../src/interfaces/IReopenPointer.sol";
import {ERC1155Min} from "../../src/lib/ERC1155Min.sol";

/// @notice IReopenNote stand-in for ClosedAuction unit tests: real ERC-1155 balances and receiver checks
///         (via ERC1155Min), but no escrow, no clock and no caps.
/// @dev `mint` stamps `epochAtMint = pointer.epochOf(wrapper)` so the auction's epoch checks line up with
///      MockPointer; `setUnitEpoch` forces a mismatch. `redeem`/`cancel` only burn units.
contract MockNote is ERC1155Min, IReopenNote {
    error UnknownNote();
    error NotWholeIssuer();

    IReopenPointer public immutable pointer;
    uint256 public noteCount;
    mapping(uint256 => Unit) internal _units;
    mapping(uint256 => uint128) public outstanding;

    constructor(IReopenPointer pointer_) ERC1155Min("https://api.curb.markets/v1/notes/{id}.json") {
        pointer = pointer_;
    }

    // --- test controls ---------------------------------------------------------------------

    function setUnitEpoch(uint256 id, uint32 e) external { _units[id].epochAtMint = e; }

    // --- IReopenNote -----------------------------------------------------------------------

    function mint(address wrapper, uint128 wrapperShares, address to) external returns (uint256 id) {
        id = ++noteCount;
        _units[id] = Unit({
            wrapper: wrapper,
            issuer: msg.sender,
            wrapperShares: wrapperShares,
            underlyingAtMint: wrapperShares,
            multiplierNonce: 0,
            epochAtMint: address(pointer) == address(0) ? 0 : pointer.epochOf(wrapper),
            mintedAt: uint64(block.timestamp),
            mintedBlock: uint64(block.number)
        });
        outstanding[id] = wrapperShares;
        _mint(to, id, wrapperShares, "");
    }

    function redeem(uint256 id, uint128 amount, address) external {
        if (_units[id].wrapper == address(0)) revert UnknownNote();
        _burn(msg.sender, id, amount);
        outstanding[id] -= amount;
    }

    function cancel(uint256 id) external {
        Unit memory u = _units[id];
        if (u.wrapper == address(0)) revert UnknownNote();
        uint128 o = outstanding[id];
        if (msg.sender != u.issuer || _balances[id][msg.sender] != o) revert NotWholeIssuer();
        _burn(msg.sender, id, o);
        outstanding[id] = 0;
    }

    function unitOf(uint256 id) external view returns (Unit memory) {
        return _units[id];
    }

    function redeemable(uint256 id) external view returns (bool) {
        Unit memory u = _units[id];
        return u.wrapper != address(0) && pointer.epochOf(u.wrapper) > u.epochAtMint;
    }

    // --- ERC-1155 subset shared with IReopenNote -------------------------------------------

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data)
        public
        override(ERC1155Min, IReopenNote)
    {
        super.safeTransferFrom(from, to, id, value, data);
    }

    function balanceOf(address account, uint256 id) public view override(ERC1155Min, IReopenNote) returns (uint256) {
        return super.balanceOf(account, id);
    }

    function isApprovedForAll(address account, address operator)
        public
        view
        override(ERC1155Min, IReopenNote)
        returns (bool)
    {
        return super.isApprovedForAll(account, operator);
    }
}
