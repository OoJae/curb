// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IReopenNote} from "./interfaces/IReopenNote.sol";
import {IReopenPointer} from "./interfaces/IReopenPointer.sol";
import {IMarketClock} from "./interfaces/IMarketClock.sol";
import {IScorecardPrice} from "./interfaces/IScorecardPrice.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";
import {IERC1155Receiver} from "./lib/ERC1155Min.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {MulDiv} from "./lib/MulDiv.sol";

/// @title ClosedAuction
/// @notice A descending-clock sale of ReopenNotes, open only while the primary market is shut.
///
/// @dev WHY A CLOCK. A note minted while a market is closed is a claim on wrapper shares that only becomes
///      redeemable after a verified reopen. Anyone who wants that exposure before the reopen has to agree a
///      price with the holder, and there is usually exactly one interested party at 3 a.m. A descending clock
///      clears with a single bidder: the price falls linearly from `startPrice` to `floorPrice` over
///      `decaySeconds`, sits at the floor until `endAt`, and the first acceptable bid takes the whole lot.
///
///      NO HINDSIGHT, TWO LAYERS.
///
///      1. The cutoff (the binding rule). ReopenPointer counts only WITNESSED reopens: its epoch moves when
///         somebody calls `observe` while the market is open. If a whole session passes with nobody observing,
///         the epoch at the next closure still equals the note's `epochAtMint`, and the epoch check below
///         would let a stale lot be bought by someone who already knows how the reopen moved. The pre-open
///         auction leaks the same way: HKEX publishes an indicative price from 09:00 HKT, before primary
///         capacity returns. So `list` pins every lot to the closure segment it was listed in: it reads
///         MarketClock's `nextTransitionAt` (the next scheduled regime boundary, attested with the regime),
///         requires it to be in the future, and requires `endAt <= cutoff`. A reopen can only happen at or
///         after a scheduled boundary, so no lot can still be live when the market reopens, whether or not
///         anyone witnessed it. `stateOf` does not fail closed on a stale attestation, but a stale state has
///         a past `nextTransitionAt`, so a missing or stale boundary refuses the listing (`NoCutoff`).
///         The boundary is the NEXT one, not necessarily the reopen: in the minutes before the 12:00 HKT
///         lunch reopen it is 12:00, and overnight before 09:00 HKT it is 09:00. Lots must fit inside it.
///      2. The witnessed epoch (defence in depth). Bids are accepted only while the market is still CLOSED
///         with zero primary capacity, and only in the same pointer epoch the note was minted in (checked
///         through `pointer.observe`, which records a reopen itself if one is under way).
///
///      `realisedDiscountBps` later grades every sale against the pointer's write-once reopen print: the
///      discount the buyer actually earned, or the premium they paid.
///
///      No admin, no fees, no upgrade path. Money moves straight from buyer to seller; the contract only
///      ever holds notes in escrow for live lots.
contract ClosedAuction is IERC1155Receiver {
    using SafeTransfer for IERC20;

    error BadParams();
    error MarketNotClosed();
    error ReopenedSinceMint();
    error Ineligible();
    error LotNotLive();
    error LotExpired();
    error PriceAboveMax(uint256 price, uint256 max);
    error NotSeller();
    error NotPrinted();
    error NotSold();
    error Unsolicited();
    error Reentrant();
    error NoCutoff();
    error SpansTransition(uint64 cutoff);

    enum Status {
        NONE,
        LIVE,
        SOLD,
        WITHDRAWN
    }

    /// @dev Prices are USDG units (6 dp) for the WHOLE lot, not per share.
    struct Lot {
        address seller;
        address wrapper;
        uint256 noteId;
        uint128 amount;        // note units = wrapper-share wei
        uint128 startPrice;
        uint128 floorPrice;
        uint128 refPrice;      // valueUsdg(amount, priceNow) at listing; 0 if unreadable
        uint64 startAt;
        uint64 endAt;
        uint32 decaySeconds;
        uint32 epochAtMint;
        Status status;
        address buyer;
        uint128 clearedPrice;
        uint64 clearedAt;
        uint64 cutoff;         // MarketClock nextTransitionAt at listing; endAt <= cutoff
    }

    event Listed(
        uint256 indexed lotId,
        uint256 indexed noteId,
        address indexed seller,
        address wrapper,
        uint128 amount,
        uint128 startPrice,
        uint128 floorPrice,
        uint64 endAt,
        uint128 refPrice
    );
    event Cleared(
        uint256 indexed lotId,
        uint256 indexed noteId,
        address indexed buyer,
        uint256 price,
        uint256 discountBpsVsRef,
        uint64 at
    );
    event Withdrawn(uint256 indexed lotId, address indexed seller);

    uint32 public constant MIN_DECAY = 60;
    uint32 public constant MAX_DECAY = 6 hours;
    uint64 public constant MAX_LIFE = 4 days;

    IReopenNote public immutable note;
    IReopenPointer public immutable pointer;
    IMarketClock public immutable clock;
    IScorecardPrice public immutable scorecard;
    IERC20 public immutable usdg;
    /// @dev address(0) = ungated.
    IEligibility public immutable eligibility;

    uint256 public lotCount;
    mapping(uint256 => Lot) internal _lots;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IReopenNote note_,
        IReopenPointer pointer_,
        IMarketClock clock_,
        IScorecardPrice scorecard_,
        IERC20 usdg_,
        IEligibility eligibility_
    ) {
        if (
            address(note_) == address(0) || address(pointer_) == address(0) || address(clock_) == address(0)
                || address(scorecard_) == address(0) || address(usdg_) == address(0)
        ) revert BadParams();
        note = note_;
        pointer = pointer_;
        clock = clock_;
        scorecard = scorecard_;
        usdg = usdg_;
        eligibility = eligibility_;
    }

    // --- selling ----------------------------------------------------------------------------------

    /// @notice Escrow `amount` units of note `noteId` and start the clock now.
    /// @dev The seller must first call `note.setApprovalForAll(address(this), true)`. `endAt` must not pass
    ///      the wrapper's next scheduled regime boundary (`clock.stateOf(w).nextTransitionAt`), so the lot
    ///      cannot outlive the closure segment it was listed in (see the contract NatSpec).
    function list(
        uint256 noteId,
        uint128 amount,
        uint128 startPrice,
        uint128 floorPrice,
        uint32 decaySeconds,
        uint64 endAt
    ) external nonReentrant returns (uint256 lotId) {
        if (amount == 0 || floorPrice == 0 || floorPrice > startPrice) revert BadParams();
        if (decaySeconds < MIN_DECAY || decaySeconds > MAX_DECAY) revert BadParams();
        if (endAt <= block.timestamp || endAt > block.timestamp + MAX_LIFE) revert BadParams();

        IReopenNote.Unit memory u = note.unitOf(noteId);
        address w = u.wrapper;
        if (w == address(0)) revert BadParams();
        if (!_shut(w)) revert MarketNotClosed();
        if (pointer.epochOf(w) != u.epochAtMint) revert ReopenedSinceMint();

        // Fail closed: no boundary, or one already passed (a stale attestation), means no listing.
        uint64 cutoff = clock.stateOf(w).nextTransitionAt;
        if (cutoff == 0 || cutoff <= block.timestamp) revert NoCutoff();
        if (endAt > cutoff) revert SpansTransition(cutoff);

        uint128 ref = _refPrice(w, amount);
        lotId = ++lotCount;
        Lot storage l = _lots[lotId];
        l.seller = msg.sender;
        l.wrapper = w;
        l.noteId = noteId;
        l.amount = amount;
        l.startPrice = startPrice;
        l.floorPrice = floorPrice;
        l.refPrice = ref;
        l.startAt = uint64(block.timestamp);
        l.endAt = endAt;
        l.decaySeconds = decaySeconds;
        l.epochAtMint = u.epochAtMint;
        l.status = Status.LIVE;
        l.cutoff = cutoff;
        emit Listed(lotId, noteId, msg.sender, w, amount, startPrice, floorPrice, endAt, ref);

        note.safeTransferFrom(msg.sender, address(this), noteId, amount, "");
    }

    /// @notice Take the whole lot at the current clock price, if it is at most `maxPrice`.
    /// @dev Pays the seller directly (the bidder must have approved `price` USDG to this contract),
    ///      then delivers the note. Status is SOLD before either transfer.
    function bid(uint256 lotId, uint256 maxPrice) external nonReentrant returns (uint256 price) {
        IEligibility e = eligibility;
        if (address(e) != address(0) && !e.isEligible(msg.sender)) revert Ineligible();

        Lot storage l = _lots[lotId];
        if (l.status != Status.LIVE) revert LotNotLive();
        if (block.timestamp > l.endAt) revert LotExpired();

        address w = l.wrapper;
        if (!_shut(w)) revert MarketNotClosed();
        (uint32 epoch, bool open) = pointer.observe(w);
        if (open) revert MarketNotClosed();
        if (epoch != l.epochAtMint) revert ReopenedSinceMint();

        price = _priceAt(l, block.timestamp);
        if (price > maxPrice) revert PriceAboveMax(price, maxPrice);

        l.status = Status.SOLD;
        l.buyer = msg.sender;
        l.clearedPrice = uint128(price);
        l.clearedAt = uint64(block.timestamp);
        emit Cleared(lotId, l.noteId, msg.sender, price, _discountBps(l.refPrice, price), uint64(block.timestamp));

        usdg.safeTransferFrom(msg.sender, l.seller, price);
        note.safeTransferFrom(address(this), msg.sender, l.noteId, l.amount, "");
    }

    /// @notice Seller takes an unsold lot back. Allowed at any time while it is LIVE.
    function withdraw(uint256 lotId) external nonReentrant {
        Lot storage l = _lots[lotId];
        if (l.status != Status.LIVE) revert LotNotLive();
        if (msg.sender != l.seller) revert NotSeller();
        l.status = Status.WITHDRAWN;
        emit Withdrawn(lotId, msg.sender);
        note.safeTransferFrom(address(this), msg.sender, l.noteId, l.amount, "");
    }

    // --- views ------------------------------------------------------------------------------------

    /// @notice `p(t) = start − (start − floor)·min(t − startAt, decay)/decay`: linear, then flat at the floor.
    function priceAt(uint256 lotId, uint256 t) public view returns (uint256) {
        Lot storage l = _lots[lotId];
        if (l.status == Status.NONE) revert BadParams();
        return _priceAt(l, t);
    }

    function currentPrice(uint256 lotId) external view returns (uint256) {
        return priceAt(lotId, block.timestamp);
    }

    function lotOf(uint256 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    /// @notice What the buyer earned: `(V − cleared)·1e4 / V`, V = the lot valued at the pointer's reopen print
    ///         for the epoch after mint. Negative when the buyer paid more than the reopen was worth.
    function realisedDiscountBps(uint256 lotId) external view returns (int256) {
        Lot storage l = _lots[lotId];
        if (l.status != Status.SOLD) revert NotSold();
        address w = l.wrapper;
        uint32 next = l.epochAtMint + 1;
        if (pointer.epochOf(w) < next) revert NotPrinted();
        uint128 print = pointer.epochInfo(w, next).print;
        if (print == 0) revert NotPrinted();
        uint256 v = MulDiv.mulDiv(l.amount, print, 1e30);
        if (v == 0) revert BadParams(); // dust lot: worth less than one USDG unit at the print
        return (int256(v) - int256(uint256(l.clearedPrice))) * 1e4 / int256(v);
    }

    // --- ERC-1155 receiver ------------------------------------------------------------------------

    /// @dev Only notes this contract pulled itself (in `list`) are accepted; anything else is refused.
    function onERC1155Received(address operator, address, uint256, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(note) || operator != address(this)) revert Unsolicited();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert Unsolicited();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x4e2312e0; // ERC-1155 receiver
    }

    // --- internals --------------------------------------------------------------------------------

    function _shut(address w) internal view returns (bool) {
        return clock.regime(w) == IMarketClock.Regime.CLOSED && clock.primaryCapNow(w) == 0;
    }

    function _priceAt(Lot storage l, uint256 t) internal view returns (uint256) {
        uint256 start = l.startPrice;
        uint256 decay = l.decaySeconds;
        uint256 elapsed = t > l.startAt ? t - l.startAt : 0;
        if (elapsed > decay) elapsed = decay;
        return start - MulDiv.mulDiv(start - l.floorPrice, elapsed, decay);
    }

    /// @dev valueUsdg(amount, priceNow) = amount·P/1e30; 0 when Scorecard cannot price the wrapper.
    function _refPrice(address w, uint128 amount) internal view returns (uint128) {
        try scorecard.priceNow(w) returns (uint128 p) {
            uint256 v = MulDiv.mulDiv(amount, p, 1e30);
            return v > type(uint128).max ? type(uint128).max : uint128(v);
        } catch {
            return 0;
        }
    }

    function _discountBps(uint256 ref, uint256 p) internal pure returns (uint256) {
        return ref > p ? (ref - p) * 1e4 / ref : 0;
    }
}
