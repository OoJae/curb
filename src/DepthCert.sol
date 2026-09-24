// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDepthCert} from "./interfaces/IDepthCert.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {MulDiv} from "./lib/MulDiv.sol";

/// @title DepthCert
/// @notice A bonded firm bid for wrapper shares whose failure proves itself on-chain. No admin.
///
/// @dev WHY THIS EXISTS. "There is depth for this asset while its primary market is shut" is the claim a
///      closed-market lender has to lean on, and an off-chain quote cannot be held to it. A DepthCert is a
///      one-sided bid, one price per cert, that the maker backs with a USDG bond of at least 10% of its
///      notional. The maker keeps the bid's USDG in their own wallet and approves this contract, so the
///      bid costs nothing to leave standing, but whoever hits it gets one of exactly two outcomes in the
///      same transaction:
///        - Filled: the maker's USDG goes to the taker, the taker's shares are credited to the maker; or
///        - Faded:  the maker's leg could not pay, and the maker's whole bond goes to the taker instead.
///      A fade is a public event with a reason code, so a bid that was never real cannot stay hidden.
///
///      Two properties make that fade trustworthy:
///        1. The taker delivers first. Their shares are pulled before the maker leg runs, and a failure
///           reverts the whole call: a taker who cannot deliver can never cause a fade.
///        2. A gas-starved call cannot fake one. The maker's USDG is pulled with a fixed stipend of
///           TRANSFER_GAS, and the call reverts `InsufficientGas` unless enough gas remains for the
///           stipend to arrive whole (EIP-150 keeps 1/64 back). So an able maker is never faded by a
///           caller who simply sent too little gas; the allowance and balance checks are views that
///           either answer truthfully or revert the call.
///
///      Who may post. Open certs (beneficiary 0) are permissionless. A cert that names a beneficiary is
///      depth reserved for that one taker -- in practice CurbCredit, which prices loans off its book -- so
///      when `makers` is set only an eligible maker may post one. Otherwise anyone could fill that book with
///      dust certs (BookFull for the real maker) or post a dust bid at 1 unit a share that drags
///      `honouredDepth`'s minBidPx, and with it the lender's LTV, to zero. `makers == 0` means ungated.
///      Eligibility is checked when a cert is posted; a maker delisted later keeps its standing certs until
///      they expire (at most MAX_LIFE), since they remain real, bonded bids.
///
///      What a maker owes. `committed(maker)` sums notional(remaining) over the maker's certs that can still
///      be taken: LIVE, unexpired, shares left. An expired cert commits nothing whether or not its bond has
///      been withdrawn, so it can never make the maker look unable to pay for depth that is still live. Once
///      a cert has expired anyone may `withdraw` it (the bond always goes to the maker). Each maker holds at
///      most MAX_LIVE_PER_MAKER takeable certs, which bounds that sum.
///
///      Books and size. Only a book that names a beneficiary is capped (MAX_LIVE_PER_BOOK) and read on-chain;
///      open books (beneficiary 0) are uncapped and meant for off-chain reads, so dust cannot lock them.
///      Every cert has a notional of at least MIN_NOTIONAL, and no take may leave a remainder whose cost
///      rounds to zero, so every cert can always be filled to the last share.
///
///      Units: shares are wrapper wei (18 dp); `bidPx` is USDG units (6 dp) per whole share (1e18 wei);
///      `notional(S, px) = mulDiv(S, px, 1e18)`.
contract DepthCert is IDepthCert {
    using SafeTransfer for IERC20;
    using SafeTransfer for address;

    // --- errors -----------------------------------------------------------------------------

    error ZeroAddress();
    error IneligibleMaker();
    error BadWrapper(address wrapper);
    error BadRecipient(address to);
    error BelowMinNotional();
    error TooManyLiveCerts(address maker);
    error DustRemainder(uint128 left);
    error BondTooSmall(uint256 bond, uint256 minBond);
    error BadExpiry(uint64 expiry, uint64 earliest, uint64 latest);
    error BookFull(address wrapper, address beneficiary);
    error NotLive(uint256 id);
    error CertExpired(uint256 id, uint64 expiry);
    error NotBeneficiary(address caller, address beneficiary);
    error BadShares(uint128 shares, uint128 remaining);
    error ZeroCost();
    error InsufficientGas();
    error NotMaker(address caller, address maker);
    error NotWithdrawable(uint256 id);
    error Reentrancy();

    // --- events -----------------------------------------------------------------------------

    event Posted(
        uint256 indexed id,
        address indexed maker,
        address indexed wrapper,
        address beneficiary,
        uint128 size,
        uint128 bidPx,
        uint128 bond,
        uint64 expiry
    );
    event Filled(uint256 indexed id, address indexed taker, uint128 shares, uint256 paid, uint128 remaining);
    event Faded(
        uint256 indexed id,
        address indexed taker,
        address indexed maker,
        uint128 shares,
        uint256 costOwed,
        uint128 bondSlashed,
        bytes4 reason
    );
    event Withdrawn(uint256 indexed id, address indexed maker, uint128 bond);
    event SharesClaimed(address indexed maker, address indexed wrapper, uint256 shares);

    // --- constants --------------------------------------------------------------------------

    uint256 public constant BPS = 10_000;
    /// @dev The bond is at least 10% of the notional it backs, rounded up.
    uint256 public constant MIN_BOND_BPS = 1000;
    uint64 public constant MIN_LIFE = 10 minutes;
    uint64 public constant MAX_LIFE = 30 days;
    /// @dev Per (wrapper, beneficiary) book with a beneficiary, so `honouredDepth` there stays a bounded loop.
    ///      Open books (beneficiary 0) are not capped: nothing on-chain reads them.
    uint256 public constant MAX_LIVE_PER_BOOK = 8;
    /// @dev Takeable certs per maker, which bounds the loop behind `committed` and `isHonourable`.
    uint256 public constant MAX_LIVE_PER_MAKER = 16;
    /// @dev Smallest notional a cert may have: 1 USDG.
    uint256 public constant MIN_NOTIONAL = 1e6;
    /// @dev The stipend for the maker's USDG `transferFrom`. The fork test measures the real USDG cost and
    ///      requires it to sit below half of this.
    uint256 public constant TRANSFER_GAS = 150_000;
    /// @dev Below this, the stipend could arrive short (EIP-150 withholds 1/64 of what is left), so a take
    ///      reverts rather than risk faking a fade. The 10k covers encoding and the CALL itself.
    uint256 public constant MIN_GAS_FOR_TRANSFER = TRANSFER_GAS + TRANSFER_GAS / 63 + 10_000;

    /// @dev Fade reasons carried by `Faded`.
    bytes4 public constant ALLOWANCE = bytes4(keccak256("ALLOWANCE"));
    bytes4 public constant BALANCE = bytes4(keccak256("BALANCE"));
    bytes4 public constant TRANSFER_FAILED = bytes4(keccak256("TRANSFER_FAILED"));

    // --- state ------------------------------------------------------------------------------

    IERC20 public immutable usdg;
    /// @notice Who may post a cert that names a beneficiary; address(0) = anyone.
    IEligibility public immutable makers;

    /// @notice The id the next `post` will get. Ids start at 1.
    uint256 public nextId = 1;
    /// @notice USDG held as bonds by LIVE certs. This contract's USDG balance equals it between calls.
    uint256 public totalBonds;
    /// @notice Wrapper shares bought for a maker by fills, waiting for `claimShares` (pull pattern).
    mapping(address => mapping(address => uint256)) public claimableShares;

    mapping(uint256 => Cert) internal _certs;
    mapping(address => mapping(address => uint256[])) internal _book;
    /// @dev Each maker's certs; compacted to takeable ones when full.
    mapping(address => uint256[]) internal _makerCerts;

    /// @dev Storage-slot reentrancy lock: 1 = free, 2 = entered.
    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param makers_ Eligibility registry for makers of beneficiary-named certs, or address(0) for ungated.
    constructor(IERC20 usdg_, IEligibility makers_) {
        if (address(usdg_) == address(0)) revert ZeroAddress();
        usdg = usdg_;
        makers = makers_;
    }

    // --- maker ------------------------------------------------------------------------------

    /// @notice Post a firm bid for `sizeShares` of `wrapper` at `bidPx`, bonded by `bond` USDG pulled now.
    /// @param beneficiary The only address allowed to take it, or 0 for anyone. Naming one requires the
    ///        caller to be an eligible maker when `makers` is set.
    function post(address wrapper, address beneficiary, uint128 sizeShares, uint128 bidPx, uint64 expiry, uint128 bond)
        external
        nonReentrant
        returns (uint256 id)
    {
        _checkPost(wrapper, beneficiary, sizeShares, bidPx, expiry, bond);
        _admit(wrapper, beneficiary);

        id = nextId++;
        _certs[id] = Cert({
            maker: msg.sender,
            wrapper: wrapper,
            beneficiary: beneficiary,
            sizeShares: sizeShares,
            remainingShares: sizeShares,
            bidPx: bidPx,
            bond: bond,
            postedAt: uint64(block.timestamp),
            expiry: expiry,
            status: Status.LIVE
        });
        _book[wrapper][beneficiary].push(id);
        _makerCerts[msg.sender].push(id);
        totalBonds += bond;

        emit Posted(id, msg.sender, wrapper, beneficiary, sizeShares, bidPx, bond, expiry);
        usdg.safeTransferFrom(msg.sender, address(this), bond);
    }

    /// @notice Return a cert's bond to its maker and close it. Before expiry only the maker may, and only once the
    ///         cert is filled in full; from expiry on, anyone may (the bond still goes to the maker).
    function withdraw(uint256 id) external nonReentrant {
        Cert storage c = _certs[id];
        if (c.status != Status.LIVE) revert NotLive(id);
        address maker = c.maker;
        if (block.timestamp < c.expiry) {
            if (msg.sender != maker) revert NotMaker(msg.sender, maker);
            if (c.remainingShares != 0) revert NotWithdrawable(id);
        }

        c.status = Status.CLOSED;
        uint128 bond = c.bond;
        totalBonds -= bond;

        emit Withdrawn(id, maker, bond);
        usdg.safeTransfer(maker, bond);
    }

    /// @notice Send the caller's filled shares of `wrapper` to `to`. Returns 0 (and moves nothing) if none.
    function claimShares(address wrapper, address to) external nonReentrant returns (uint256 shares) {
        if (to == address(0) || to == address(this)) revert BadRecipient(to);
        shares = claimableShares[msg.sender][wrapper];
        if (shares == 0) return 0;
        claimableShares[msg.sender][wrapper] = 0;

        emit SharesClaimed(msg.sender, wrapper, shares);
        wrapper.safeTransfer(to, shares);
    }

    // --- taker ------------------------------------------------------------------------------

    /// @notice Sell `shares` into cert `id`. Either the maker pays `cost` to `to` (filled, amount = cost), or
    ///         the maker's leg fails and the whole bond goes to `to` while the caller keeps their shares
    ///         (faded, amount = bond).
    function take(uint256 id, uint128 shares, address to)
        external
        nonReentrant
        returns (bool filled, uint256 amount)
    {
        Cert storage c = _certs[id];
        if (c.status != Status.LIVE) revert NotLive(id);
        if (block.timestamp >= c.expiry) revert CertExpired(id, c.expiry);
        address ben = c.beneficiary;
        if (ben != address(0) && msg.sender != ben) revert NotBeneficiary(msg.sender, ben);
        // Paying this contract would strand the USDG: nothing could ever move it out again.
        if (to == address(0) || to == address(this)) revert BadRecipient(to);
        uint256 cost = _checkSize(c, shares);

        // 1. The taker delivers first; any failure here reverts everything.
        c.wrapper.safeTransferFrom(msg.sender, address(this), shares);

        // 2. The maker's leg.
        bytes4 reason = _makerLeg(c.maker, cost);

        filled = reason == bytes4(0);
        amount = filled ? _fill(id, c, shares, cost, to) : _fade(id, c, shares, cost, to, reason);
    }

    // --- anyone -----------------------------------------------------------------------------

    /// @notice Drop certs that can never be taken again (not LIVE, fully filled, or expired) from a book.
    function prune(address wrapper, address beneficiary) external nonReentrant {
        _compact(_book[wrapper][beneficiary]);
    }

    // --- views ------------------------------------------------------------------------------

    function certOf(uint256 id) external view returns (Cert memory) {
        return _certs[id];
    }

    /// @notice The cert ids a book currently lists, takeable or not (see `prune`).
    function bookOf(address wrapper, address beneficiary) external view returns (uint256[] memory) {
        return _book[wrapper][beneficiary];
    }

    /// @notice Each maker's cert ids, takeable or not (compacted when the list fills up).
    function certsOf(address maker) external view returns (uint256[] memory) {
        return _makerCerts[maker];
    }

    /// @notice The USDG the maker must still be able to pay: Σ notional(remaining, bidPx) over the maker's
    ///         takeable certs (LIVE, unexpired, shares left). Expired certs commit nothing, withdrawn or not.
    function committed(address maker) public view returns (uint256 sum) {
        uint256[] storage mine = _makerCerts[maker];
        uint256 n = mine.length;
        for (uint256 i; i < n; ++i) {
            Cert storage c = _certs[mine[i]];
            if (_takeable(c)) sum += _notional(c.remainingShares, c.bidPx);
        }
    }

    /// @notice True when the maker's USDG balance and allowance both cover everything they have committed.
    function isHonourable(address maker) public view returns (bool) {
        uint256 need = committed(maker);
        if (need == 0) return true;
        return usdg.balanceOf(maker) >= need && usdg.allowance(maker, address(this)) >= need;
    }

    /// @notice Depth a taker could actually hit in one book: LIVE, unexpired certs with `expiry >= minExpiry`
    ///         and shares left, from honourable makers. Revoking an allowance removes a maker's depth at once.
    /// @dev Bounded for a book that names a beneficiary (MAX_LIVE_PER_BOOK). An open book is uncapped: read it
    ///      off-chain, not from a contract.
    /// @return shares Σ remaining shares.
    /// @return notional Σ notional(remaining, bidPx).
    /// @return minBidPx The lowest bid counted (0 if none).
    /// @return soonestExpiry The earliest expiry counted (0 if none).
    function honouredDepth(address wrapper, address beneficiary, uint64 minExpiry)
        external
        view
        returns (uint256 shares, uint256 notional, uint128 minBidPx, uint64 soonestExpiry)
    {
        uint256[] storage book = _book[wrapper][beneficiary];
        uint256 n = book.length;
        for (uint256 i; i < n; ++i) {
            Cert storage c = _certs[book[i]];
            if (!_takeable(c) || c.expiry < minExpiry || !isHonourable(c.maker)) continue;
            uint128 rem = c.remainingShares;
            uint128 px = c.bidPx;
            uint64 exp = c.expiry;
            shares += rem;
            notional += _notional(rem, px);
            if (minBidPx == 0 || px < minBidPx) minBidPx = px;
            if (soonestExpiry == 0 || exp < soonestExpiry) soonestExpiry = exp;
        }
    }

    // --- internals --------------------------------------------------------------------------

    function _checkPost(address wrapper, address beneficiary, uint128 sizeShares, uint128 bidPx, uint64 expiry, uint128 bond)
        internal
        view
    {
        // A USDG-for-USDG bid is meaningless and would mix claimable shares into the bond balance.
        if (wrapper == address(0) || wrapper == address(usdg)) revert BadWrapper(wrapper);
        if (beneficiary != address(0) && address(makers) != address(0) && !makers.isEligible(msg.sender)) {
            revert IneligibleMaker();
        }
        uint256 n = _notional(sizeShares, bidPx);
        // With n >= 1, a take of every remaining share always costs something, so a cert can always be filled.
        if (n < MIN_NOTIONAL) revert BelowMinNotional();
        // n <= 2^256 / 1e18, so n * 1000 cannot overflow.
        uint256 minBond = (n * MIN_BOND_BPS + BPS - 1) / BPS;
        if (bond < minBond) revert BondTooSmall(bond, minBond);
        uint64 earliest = uint64(block.timestamp) + MIN_LIFE;
        uint64 latest = uint64(block.timestamp) + MAX_LIFE;
        if (expiry < earliest || expiry > latest) revert BadExpiry(expiry, earliest, latest);
    }

    /// @dev Room for one more cert in the book (only a book naming a beneficiary is capped) and in the
    ///      maker's list; a full one is compacted first.
    function _admit(address wrapper, address beneficiary) internal {
        uint256[] storage book = _book[wrapper][beneficiary];
        if (beneficiary != address(0) && book.length >= MAX_LIVE_PER_BOOK) {
            _compact(book);
            if (book.length >= MAX_LIVE_PER_BOOK) revert BookFull(wrapper, beneficiary);
        }
        uint256[] storage mine = _makerCerts[msg.sender];
        if (mine.length >= MAX_LIVE_PER_MAKER) {
            _compact(mine);
            if (mine.length >= MAX_LIVE_PER_MAKER) revert TooManyLiveCerts(msg.sender);
        }
    }

    /// @dev Returns 0 when the maker paid `cost` into this contract, else the fade reason. Reverts when too
    ///      little gas is left for the stipend to arrive whole.
    function _makerLeg(address maker, uint256 cost) internal returns (bytes4) {
        if (usdg.allowance(maker, address(this)) < cost) return ALLOWANCE;
        if (usdg.balanceOf(maker) < cost) return BALANCE;
        if (gasleft() < MIN_GAS_FOR_TRANSFER) revert InsufficientGas();

        bytes memory data = abi.encodeCall(IERC20.transferFrom, (maker, address(this), cost));
        address token = address(usdg);
        bool ok;
        uint256 size;
        uint256 word;
        // Only the first return word is copied, so a token cannot grief this call with a huge return.
        assembly ("memory-safe") {
            ok := call(TRANSFER_GAS, token, 0, add(data, 0x20), mload(data), 0x00, 0x20)
            size := returndatasize()
            word := mload(0x00)
        }
        // Empty return data is USDT-style success; `token` has code (`post` already pulled a bond from it).
        if (!ok || (size != 0 && (size < 32 || word != 1))) return TRANSFER_FAILED;
        return bytes4(0);
    }

    /// @dev The cost of `shares`, which must be positive, and what they leave behind must be zero or cost
    ///      something too -- so the rest of the cert can always be taken.
    function _checkSize(Cert storage c, uint128 shares) internal view returns (uint256 cost) {
        uint128 rem = c.remainingShares;
        if (shares == 0 || shares > rem) revert BadShares(shares, rem);
        uint128 px = c.bidPx;
        cost = _notional(shares, px);
        if (cost == 0) revert ZeroCost();
        uint128 left = rem - shares;
        if (left != 0 && _notional(left, px) == 0) revert DustRemainder(left);
    }

    function _fill(uint256 id, Cert storage c, uint128 shares, uint256 cost, address to) internal returns (uint256) {
        uint128 left = c.remainingShares - shares;
        c.remainingShares = left;
        claimableShares[c.maker][c.wrapper] += shares;

        emit Filled(id, msg.sender, shares, cost, left);
        usdg.safeTransfer(to, cost);
        return cost;
    }

    function _fade(uint256 id, Cert storage c, uint128 shares, uint256 cost, address to, bytes4 reason)
        internal
        returns (uint256)
    {
        address maker = c.maker;
        c.status = Status.FADED;
        uint128 bond = c.bond;
        totalBonds -= bond;

        emit Faded(id, msg.sender, maker, shares, cost, bond, reason);
        // If USDG cannot move at all (paused), this reverts and there is no fade.
        usdg.safeTransfer(to, bond);
        c.wrapper.safeTransfer(msg.sender, shares);
        return bond;
    }

    /// @dev In-place compaction keeping order; drops every cert that can never be taken again. Used for books
    ///      and for makers' lists.
    function _compact(uint256[] storage book) internal {
        uint256 n = book.length;
        uint256 w;
        for (uint256 r; r < n; ++r) {
            uint256 id = book[r];
            if (!_takeable(_certs[id])) continue;
            if (w != r) book[w] = id;
            ++w;
        }
        while (book.length > w) book.pop();
    }

    /// @dev LIVE, shares left, not expired. Once false it stays false: expiry passes, remaining never rises,
    ///      and nothing returns to LIVE.
    function _takeable(Cert storage c) internal view returns (bool) {
        return c.status == Status.LIVE && c.remainingShares != 0 && block.timestamp < c.expiry;
    }

    function _notional(uint256 shares, uint256 px) internal pure returns (uint256) {
        return MulDiv.mulDiv(shares, px, 1e18);
    }
}
