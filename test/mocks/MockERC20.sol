// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @notice Test ERC-20 with configurable decimals, free mint/burn, and the two failure modes W3/W4
///         must survive: a frozen account (USDG-style: any transfer touching it reverts) and a token
///         that returns `false` instead of reverting.
/// @dev `returnFalse` makes `transfer`/`transferFrom` return false and move nothing. An allowance of
///      `type(uint256).max` is never decremented.
contract MockERC20 is IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error Frozen(address who);
    error InsufficientBalance(address from, uint256 balance, uint256 needed);
    error InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 needed);

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    mapping(address => bool) public frozen;
    bool public returnFalse;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    // --- test controls ---------------------------------------------------------------------

    function setDecimals(uint8 d) external { decimals = d; }
    function freeze(address who) external { frozen[who] = true; }
    function unfreeze(address who) external { frozen[who] = false; }
    function setReturnFalse(bool on) external { returnFalse = on; }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance(from, bal, amount);
        balanceOf[from] = bal - amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    // --- ERC-20 ----------------------------------------------------------------------------

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        _notFrozen(msg.sender, to, msg.sender);
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        _notFrozen(from, to, msg.sender);
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance(from, msg.sender, a, amount);
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _notFrozen(address from, address to, address spender) internal view {
        if (frozen[from]) revert Frozen(from);
        if (frozen[to]) revert Frozen(to);
        if (frozen[spender]) revert Frozen(spender);
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance(from, bal, amount);
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
