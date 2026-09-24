// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDepthCert} from "../../src/interfaces/IDepthCert.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MulDiv} from "../../src/lib/MulDiv.sol";

/// @notice Settable IDepthCert for CurbCredit unit tests.
/// @dev Two independent surfaces:
///      - `honouredDepth` reads a settable book per (wrapper, beneficiary): `setDepth(w, b, shares, minBidPx, expiry)`.
///        Like the real DepthCert it filters by expiry: a book whose `expiry < minExpiry` reads as empty, so the
///        caller's `now + 1h` horizon is exercised. `notional = mulDiv(shares, minBidPx, 1e18)`.
///      - `take` settles a settable cert (`setCert`) against real tokens: it pulls `shares` of the cert's wrapper
///        from the taker first (as the real contract does), then either fills (pays `notional(shares, bidPx)` USDG
///        from this mock's own balance to `to`) or, when `setFade(id, true)`, fades (returns the shares to the
///        taker and pays the bond to `to`). Fund the mock with USDG before a fill or a fade.
///      `take` does not touch the settable depth book; tests move both explicitly.
contract MockDepthCert is IDepthCert {
    error NotLive(uint256 id);
    error Expired(uint256 id);
    error BadShares(uint256 id, uint256 shares, uint256 remaining);
    error WrongTaker(uint256 id, address taker);
    error TakeReverts();

    struct Book { uint256 shares; uint128 minBidPx; uint64 expiry; }

    IERC20 public immutable usdg;
    mapping(address => mapping(address => Book)) public books;
    mapping(uint256 => Cert) internal _certs;
    mapping(uint256 => bool) public fades;
    bool public revertTake;
    /// @dev Extra work done inside `honouredDepth` (keccak rounds), to model a big book's gas cost.
    uint256 public burn;
    uint256 public nextId = 1;

    /// @dev Last `take`, for assertions.
    address public lastTaker;
    uint256 public lastShares;
    address public lastTo;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    // --- test controls ---------------------------------------------------------------------

    function setDepth(address wrapper, address beneficiary, uint256 shares, uint128 minBidPx, uint64 expiry) external {
        books[wrapper][beneficiary] = Book(shares, minBidPx, expiry);
    }

    function clearDepth(address wrapper, address beneficiary) external {
        delete books[wrapper][beneficiary];
    }

    /// @notice Store a LIVE cert and return its id.
    function setCert(address maker, address wrapper, address beneficiary, uint128 size, uint128 bidPx, uint128 bond, uint64 expiry)
        external
        returns (uint256 id)
    {
        id = nextId++;
        _certs[id] = Cert({
            maker: maker,
            wrapper: wrapper,
            beneficiary: beneficiary,
            sizeShares: size,
            remainingShares: size,
            bidPx: bidPx,
            bond: bond,
            postedAt: uint64(block.timestamp),
            expiry: expiry,
            status: Status.LIVE
        });
    }

    function setFade(uint256 id, bool on) external { fades[id] = on; }
    function setRevertTake(bool on) external { revertTake = on; }
    function setBurn(uint256 rounds) external { burn = rounds; }

    // --- IDepthCert ------------------------------------------------------------------------

    function honouredDepth(address wrapper, address beneficiary, uint64 minExpiry)
        external
        view
        returns (uint256 shares, uint256 notional, uint128 minBidPx, uint64 soonestExpiry)
    {
        bytes32 acc;
        for (uint256 i; i < burn; ++i) acc = keccak256(abi.encode(acc, i));
        Book memory bk = books[wrapper][beneficiary];
        if (bk.shares == 0 || bk.expiry < minExpiry || acc == bytes32(uint256(1))) return (0, 0, 0, 0);
        return (bk.shares, MulDiv.mulDiv(bk.shares, bk.minBidPx, 1e18), bk.minBidPx, bk.expiry);
    }

    function certOf(uint256 id) external view returns (Cert memory) {
        return _certs[id];
    }

    function take(uint256 id, uint128 shares, address to) external returns (bool filled, uint256 amount) {
        if (revertTake) revert TakeReverts();
        Cert storage c = _certs[id];
        if (c.status != Status.LIVE) revert NotLive(id);
        if (block.timestamp >= c.expiry) revert Expired(id);
        if (c.beneficiary != address(0) && msg.sender != c.beneficiary) revert WrongTaker(id, msg.sender);
        if (shares == 0 || shares > c.remainingShares) revert BadShares(id, shares, c.remainingShares);

        lastTaker = msg.sender;
        lastShares = shares;
        lastTo = to;

        // Taker delivers first.
        require(IERC20(c.wrapper).transferFrom(msg.sender, address(this), shares), "pull");

        if (fades[id]) {
            c.status = Status.FADED;
            uint256 bond = c.bond;
            c.bond = 0;
            require(IERC20(c.wrapper).transfer(msg.sender, shares), "return");
            require(usdg.transfer(to, bond), "bond");
            return (false, bond);
        }

        amount = MulDiv.mulDiv(shares, c.bidPx, 1e18);
        c.remainingShares -= shares;
        if (c.remainingShares == 0) c.status = Status.CLOSED;
        require(usdg.transfer(to, amount), "pay");
        return (true, amount);
    }

    function post(address, address, uint128, uint128, uint64, uint128) external pure returns (uint256) {
        revert("MockDepthCert: use setCert");
    }

    function withdraw(uint256) external pure {
        revert("MockDepthCert: not modelled");
    }

    function claimShares(address, address) external pure returns (uint256) {
        return 0;
    }

    function prune(address, address) external pure {}

    function isHonourable(address) external pure returns (bool) {
        return true;
    }
}
