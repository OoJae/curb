// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev The hooks ERC-1155 calls on a recipient that has code.
interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data)
        external
        returns (bytes4);
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external returns (bytes4);
}

/// @title ERC1155Min
/// @notice The smallest ERC-1155 Curb needs: balances, operators, safe transfers and one base URI.
/// @dev No supply tracking, no per-id URI, no transfer hooks. The receiver check runs whenever `to` has
///      code, which includes EIP-7702 delegated EOAs (their code is the 23-byte `0xef0100 || impl`
///      designator), so a smart account that cannot handle a note never silently receives one.
///      Balances move before the receiver is called (checks-effects-interactions); a receiver's revert
///      reason is bubbled up unchanged, and a receiver that reverts without data, lacks the hook, or
///      returns the wrong magic value reverts with `ERC1155UnsafeRecipient(to)`.
///      Errors carry an `ERC1155` prefix so an inheriting contract can declare its own short names.
abstract contract ERC1155Min {
    event TransferSingle(
        address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value
    );
    event TransferBatch(
        address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values
    );
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);

    error ERC1155NotAuthorized(address operator, address from);
    error ERC1155ZeroAddress();
    error ERC1155InsufficientBalance(address from, uint256 id, uint256 balance, uint256 needed);
    error ERC1155LengthMismatch();
    error ERC1155UnsafeRecipient(address to);

    mapping(uint256 id => mapping(address account => uint256)) internal _balances;
    mapping(address account => mapping(address operator => bool)) internal _operatorApprovals;
    string internal _baseUri;

    constructor(string memory baseUri_) {
        _baseUri = baseUri_;
    }

    /// @notice One URI for every id; clients substitute `{id}` per ERC-1155 metadata rules.
    function uri(uint256) public view virtual returns (string memory) {
        return _baseUri;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == 0xd9b67a26 // ERC-1155
            || interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x0e89341c; // ERC-1155 Metadata URI
    }

    function balanceOf(address account, uint256 id) public view virtual returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        public
        view
        virtual
        returns (uint256[] memory out)
    {
        if (accounts.length != ids.length) revert ERC1155LengthMismatch();
        out = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            out[i] = _balances[ids[i]][accounts[i]];
        }
    }

    function setApprovalForAll(address operator, bool approved) public virtual {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) public view virtual returns (bool) {
        return _operatorApprovals[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data)
        public
        virtual
    {
        _authorise(from);
        _move(from, to, id, value);
        emit TransferSingle(msg.sender, from, to, id, value);
        _checkSingle(from, to, id, value, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) public virtual {
        if (ids.length != values.length) revert ERC1155LengthMismatch();
        _authorise(from);
        for (uint256 i; i < ids.length; ++i) {
            _move(from, to, ids[i], values[i]);
        }
        emit TransferBatch(msg.sender, from, to, ids, values);
        _checkBatch(from, to, ids, values, data);
    }

    function _mint(address to, uint256 id, uint256 value, bytes memory data) internal virtual {
        if (to == address(0)) revert ERC1155ZeroAddress();
        _balances[id][to] += value;
        emit TransferSingle(msg.sender, address(0), to, id, value);
        _checkSingle(address(0), to, id, value, data);
    }

    function _burn(address from, uint256 id, uint256 value) internal virtual {
        if (from == address(0)) revert ERC1155ZeroAddress();
        uint256 bal = _balances[id][from];
        if (bal < value) revert ERC1155InsufficientBalance(from, id, bal, value);
        unchecked {
            _balances[id][from] = bal - value;
        }
        emit TransferSingle(msg.sender, from, address(0), id, value);
    }

    function _authorise(address from) private view {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) {
            revert ERC1155NotAuthorized(msg.sender, from);
        }
    }

    function _move(address from, address to, uint256 id, uint256 value) private {
        if (to == address(0)) revert ERC1155ZeroAddress();
        uint256 bal = _balances[id][from];
        if (bal < value) revert ERC1155InsufficientBalance(from, id, bal, value);
        unchecked {
            _balances[id][from] = bal - value;
        }
        _balances[id][to] += value;
    }

    function _checkSingle(address from, address to, uint256 id, uint256 value, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, value, data) returns (bytes4 r) {
            if (r != IERC1155Receiver.onERC1155Received.selector) revert ERC1155UnsafeRecipient(to);
        } catch (bytes memory reason) {
            _bubble(to, reason);
        }
    }

    function _checkBatch(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155BatchReceived(msg.sender, from, ids, values, data) returns (bytes4 r) {
            if (r != IERC1155Receiver.onERC1155BatchReceived.selector) revert ERC1155UnsafeRecipient(to);
        } catch (bytes memory reason) {
            _bubble(to, reason);
        }
    }

    function _bubble(address to, bytes memory reason) private pure {
        if (reason.length == 0) revert ERC1155UnsafeRecipient(to);
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}
