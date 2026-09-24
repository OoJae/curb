// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReopenNote} from "../../../src/ReopenNote.sol";
import {ReopenPointer} from "../../../src/ReopenPointer.sol";
import {IReopenNote} from "../../../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../../../src/interfaces/IReopenPointer.sol";
import {IMarketClock} from "../../../src/interfaces/IMarketClock.sol";
import {MulDiv} from "../../../src/lib/MulDiv.sol";
import {SafeTransfer} from "../../../src/lib/SafeTransfer.sol";
import {MockClock} from "../../mocks/MockClock.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {MockWrapper4626} from "../../mocks/MockWrapper4626.sol";

/// @notice The auction surface the handler drives (ClosedAuction's, per the W3 spec).
interface IAuctionPath {
    function list(uint256 noteId, uint128 amount, uint128 startPrice, uint128 floorPrice, uint64 decaySeconds, uint64 endAt)
        external
        returns (uint256 lotId);
    function bid(uint256 lotId, uint128 maxPrice) external returns (uint256 price);
    function withdraw(uint256 lotId) external;
}

/// @notice Stage-1 stand-in for ClosedAuction: the spec's list/bid gates and price curve, no eligibility,
///         no refPrice. It exists so notes flow through a third-party escrow while the pointer and note
///         properties are checked; the real ClosedAuction replaces it once P2 lands.
contract MiniAuction is IAuctionPath {
    using SafeTransfer for address;

    enum Status { NONE, LIVE, SOLD, WITHDRAWN }

    struct Lot {
        address seller;
        address wrapper;
        uint256 noteId;
        uint128 amount;
        uint128 startPrice;
        uint128 floorPrice;
        uint64 startAt;
        uint64 endAt;
        uint64 decaySeconds;
        uint32 epochAtMint;
        Status status;
        address buyer;
        uint128 clearedPrice;
    }

    ReopenNote public immutable note;
    IReopenPointer public immutable pointer;
    IMarketClock public immutable clock;
    address public immutable usdg;
    Lot[] internal _lots;

    constructor(ReopenNote note_, IReopenPointer pointer_, IMarketClock clock_, address usdg_) {
        (note, pointer, clock, usdg) = (note_, pointer_, clock_, usdg_);
    }

    function lotCount() external view returns (uint256) { return _lots.length; }
    function lotOf(uint256 lotId) external view returns (Lot memory) { return _lots[lotId - 1]; }

    function list(uint256 noteId, uint128 amount, uint128 startPrice, uint128 floorPrice, uint64 decaySeconds, uint64 endAt)
        external
        returns (uint256 lotId)
    {
        IReopenNote.Unit memory u = note.unitOf(noteId);
        require(u.wrapper != address(0) && amount > 0, "BadParams");
        require(clock.regime(u.wrapper) == IMarketClock.Regime.CLOSED && clock.primaryCapNow(u.wrapper) == 0, "MarketNotClosed");
        require(pointer.epochOf(u.wrapper) == u.epochAtMint, "ReopenedSinceMint");
        require(floorPrice > 0 && floorPrice <= startPrice, "BadParams");
        require(decaySeconds >= 60 && decaySeconds <= 6 hours, "BadParams");
        require(block.timestamp < endAt && endAt <= block.timestamp + 4 days, "BadParams");
        _lots.push(Lot(msg.sender, u.wrapper, noteId, amount, startPrice, floorPrice, uint64(block.timestamp), endAt,
            decaySeconds, u.epochAtMint, Status.LIVE, address(0), 0));
        lotId = _lots.length;
        note.safeTransferFrom(msg.sender, address(this), noteId, amount, "");
    }

    function priceAt(uint256 lotId, uint256 t) public view returns (uint256) {
        Lot storage l = _lots[lotId - 1];
        uint256 dt = t > l.startAt ? t - l.startAt : 0;
        if (dt > l.decaySeconds) dt = l.decaySeconds;
        return l.startPrice - MulDiv.mulDiv(l.startPrice - l.floorPrice, dt, l.decaySeconds);
    }

    function bid(uint256 lotId, uint128 maxPrice) external returns (uint256 price) {
        Lot storage l = _lots[lotId - 1];
        require(l.status == Status.LIVE, "LotNotLive");
        require(block.timestamp <= l.endAt, "LotExpired");
        require(clock.regime(l.wrapper) == IMarketClock.Regime.CLOSED && clock.primaryCapNow(l.wrapper) == 0, "MarketNotClosed");
        (uint32 e,) = pointer.observe(l.wrapper);
        require(e == l.epochAtMint, "ReopenedSinceMint");
        price = priceAt(lotId, block.timestamp);
        require(price <= maxPrice, "PriceAboveMax");
        l.status = Status.SOLD;
        l.buyer = msg.sender;
        l.clearedPrice = uint128(price);
        usdg.safeTransferFrom(msg.sender, l.seller, price);
        note.safeTransferFrom(address(this), msg.sender, l.noteId, l.amount, "");
    }

    function withdraw(uint256 lotId) external {
        Lot storage l = _lots[lotId - 1];
        require(l.status == Status.LIVE && msg.sender == l.seller, "NotSeller");
        l.status = Status.WITHDRAWN;
        note.safeTransferFrom(address(this), l.seller, l.noteId, l.amount, "");
    }

    function onERC1155Received(address operator, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(note) && operator == address(this), "unsolicited");
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("batch");
    }
}

/// @notice Bounded random driver for NoteInvariant: moves the clock (regime, cap, blackout, nonce), the 4626
///         rate and time, pokes the pointer, and makes actors mint, move, list, bid on, redeem and cancel notes.
///         Every action is try/caught; ghosts record what each SUCCESSFUL call must have satisfied.
contract NoteHandler is Test {
    ReopenNote public note;
    ReopenPointer public pointer;
    MockClock public clock;
    MiniAuction public auction;
    MockERC20 public usdg;
    MockWrapper4626[2] public wrappers;
    address[3] public actors;

    // --- ghosts ---------------------------------------------------------------------------------
    uint256[] public ids;
    mapping(uint256 id => uint256) public delivered;
    mapping(uint256 id => uint256) public cancelled;

    mapping(address wrapper => uint32) public maxEpochSeen;
    bool public epochWentBack;

    struct PrintSeen { uint128 print; uint64 printedAt; }
    mapping(address wrapper => mapping(uint32 epoch => PrintSeen)) public printSeen;
    bool public printRewritten;

    bool public lockedRedeem;       // a redeem succeeded although neither unlock held afterwards
    bool public inexactDelivery;    // a redeem/cancel delivered other than exactly its amount
    bool public badBid;             // a bid cleared while open, in a later epoch, or outside [floor, start]
    mapping(uint256 lotId => uint256) public sales;

    uint256 public mints;
    uint256 public redeems;
    uint256 public fallbackRedeems;
    uint256 public cancels;
    uint256 public prints;
    uint256 public reopens;
    uint256 public bids;

    constructor(
        ReopenNote note_,
        ReopenPointer pointer_,
        MockClock clock_,
        MiniAuction auction_,
        MockERC20 usdg_,
        MockWrapper4626[2] memory wrappers_,
        address[3] memory actors_
    ) {
        (note, pointer, clock, auction, usdg) = (note_, pointer_, clock_, auction_, usdg_);
        wrappers = wrappers_;
        actors = actors_;
    }

    modifier tracked() {
        _;
        for (uint256 i; i < 2; ++i) {
            address w = address(wrappers[i]);
            uint32 e = pointer.epochOf(w);
            if (e < maxEpochSeen[w]) epochWentBack = true;
            if (e > maxEpochSeen[w]) {
                reopens += e - maxEpochSeen[w];
                maxEpochSeen[w] = e;
            }
        }
    }

    function idCount() external view returns (uint256) { return ids.length; }

    function _w(uint256 seed) internal view returns (address) { return address(wrappers[seed % 2]); }
    function _actor(uint256 seed) internal view returns (address) { return actors[seed % 3]; }

    function _id(uint256 seed) internal view returns (uint256) {
        return ids.length == 0 ? 0 : ids[seed % ids.length];
    }

    /// The first actor, starting from `seed`, holding units of `id` (address(0) if none does).
    function _holder(uint256 seed, uint256 id) internal view returns (address) {
        for (uint256 i; i < 3; ++i) {
            address a = actors[(seed % 3 + i) % 3];
            if (note.balanceOf(a, id) > 0) return a;
        }
        return address(0);
    }

    // --- the world moves ------------------------------------------------------------------------

    /// The attestor moves the clock; half the time a keeper observes right after (poke.sh).
    function setRegime(uint256 wSeed, uint256 kind, uint128 cap, bool poked) external tracked {
        address w = _w(wSeed);
        kind %= 6;
        if (kind == 0) clock.setRegime(w, IMarketClock.Regime.UNKNOWN);
        else if (kind <= 3) clock.set(w, IMarketClock.Regime.CLOSED, 0); // shut is the common case, as on X Layer
        else clock.set(w, kind == 4 ? IMarketClock.Regime.MARKET : IMarketClock.Regime.OVERNIGHT, uint128(bound(cap, 1, 50_000_000)));
        if (poked) pointer.observe(w);
    }

    /// Mostly short steps (so the 300 s print delay and the 30 min window get hit), sometimes long
    /// jumps (so the 10-day fallback gets hit).
    function warp(uint256 dt) external tracked {
        _warp(dt % 4 == 0 ? bound(dt, 1 hours, 11 days) : bound(dt, 0, 900));
    }

    function setBlackout(uint256 wSeed, uint256 on) external tracked {
        clock.setBlackout(_w(wSeed), on % 4 == 0);
    }

    function corporateAction(uint256 wSeed, uint256 rate) external tracked {
        address w = _w(wSeed);
        MockWrapper4626(w).setRate(bound(rate, 0.25e18, 4e18));
        clock.setNonce(w, clock.stateOf(w).multiplierNonce + 1);
    }

    // --- pointer ---------------------------------------------------------------------------------

    function observe(uint256 wSeed, uint256 actorSeed) external tracked {
        vm.prank(_actor(actorSeed));
        pointer.observe(_w(wSeed));
    }

    /// Any epoch, including 0 and head + 1 (which must be refused).
    function recordPrint(uint256 wSeed, uint256 epochSeed) external tracked {
        address w = _w(wSeed);
        _print(w, uint32(bound(epochSeed, 0, uint256(pointer.epochOf(w)) + 1)));
    }

    /// What the operator's poke does: observe, then try to print the head epoch.
    function poke(uint256 wSeed) external tracked {
        address w = _w(wSeed);
        (uint32 head,) = pointer.observe(w);
        _print(w, head);
    }

    /// A whole overnight as the operator runs it: shut witnessed, a gap, the reopen witnessed, then a print
    /// attempt somewhere between too early and too late; half the time the session then ends (shut again).
    /// Mostly wT, so wA notes stay locked long enough to reach the 10-day fallback now and then.
    function keeperReopen(uint256 wSeed, uint256 gap, uint256 printAfter, uint128 cap) external tracked {
        address w = address(wrappers[wSeed % 4 == 0 ? 1 : 0]);
        clock.set(w, IMarketClock.Regime.CLOSED, 0);
        pointer.observe(w);
        _warp(bound(gap, 0, 12 hours));
        clock.set(w, IMarketClock.Regime.MARKET, uint128(bound(cap, 1, 50_000_000)));
        (uint32 head,) = pointer.observe(w);
        _warp(bound(printAfter, 0, 2400));
        _print(w, head);
        if (gap % 2 == 0) {
            clock.set(w, IMarketClock.Regime.CLOSED, 0);
            pointer.observe(w);
        }
    }

    function _warp(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1 + dt / 2);
    }

    function _print(address w, uint32 e) internal {
        try pointer.recordPrint(w, e) returns (uint128 p) {
            PrintSeen storage s = printSeen[w][e];
            if (s.printedAt != 0) printRewritten = true; // a second success for the same (w, e)
            s.print = p;
            s.printedAt = uint64(block.timestamp);
            prints++;
        } catch {}
    }

    // --- note ------------------------------------------------------------------------------------

    function mint(uint256 actorSeed, uint256 wSeed, uint256 shares, uint256 toSeed) external tracked {
        address issuer = _actor(actorSeed);
        shares = bound(shares, 1, 20e18);
        vm.prank(issuer);
        try note.mint(_w(wSeed), uint128(shares), _actor(toSeed)) returns (uint256 id) {
            ids.push(id);
            mints++;
        } catch {}
    }

    function redeem(uint256 actorSeed, uint256 idSeed, uint256 amount, uint256 toSeed) external tracked {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        address holder = _holder(actorSeed, id);
        if (holder == address(0)) return;
        amount = bound(amount, 1, note.balanceOf(holder, id));
        address to = _actor(toSeed);
        IReopenNote.Unit memory u = note.unitOf(id);
        uint256 before = MockWrapper4626(u.wrapper).balanceOf(to);

        vm.prank(holder);
        try note.redeem(id, uint128(amount), to) {
            delivered[id] += amount;
            redeems++;
            bool byEpoch = pointer.epochOf(u.wrapper) > u.epochAtMint;
            bool byTime = block.timestamp >= uint256(u.mintedAt) + note.FALLBACK_AFTER();
            if (!byEpoch && !byTime) lockedRedeem = true;
            if (!byEpoch) fallbackRedeems++;
            if (MockWrapper4626(u.wrapper).balanceOf(to) != before + amount) inexactDelivery = true;
        } catch {}
    }

    function cancel(uint256 actorSeed, uint256 idSeed) external tracked {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        IReopenNote.Unit memory u = note.unitOf(id);
        // Mostly the issuer (the only one who can); sometimes someone else, who must be refused.
        address who = actorSeed % 4 == 0 ? _actor(actorSeed / 4) : u.issuer;
        uint256 out = note.outstanding(id);
        uint256 before = MockWrapper4626(u.wrapper).balanceOf(who);
        vm.prank(who);
        try note.cancel(id) {
            cancelled[id] += out;
            cancels++;
            if (MockWrapper4626(u.wrapper).balanceOf(who) != before + out) inexactDelivery = true;
        } catch {}
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 idSeed, uint256 amount) external tracked {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        address from = _holder(fromSeed, id);
        if (from == address(0)) return;
        uint256 bal = note.balanceOf(from, id);
        vm.prank(from);
        note.safeTransferFrom(from, _actor(toSeed), id, bound(amount, 1, bal), "");
    }

    // --- auction path ------------------------------------------------------------------------------

    function list(uint256 actorSeed, uint256 idSeed, uint256 amount, uint256 start, uint256 floorBps, uint256 decay, uint256 life)
        external
        tracked
    {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        address seller = _holder(actorSeed, id);
        if (seller == address(0)) return;
        amount = bound(amount, 1, note.balanceOf(seller, id));
        start = bound(start, 1e6, 10_000e6);
        uint256 floor_ = start * bound(floorBps, 1, 10_000) / 10_000;
        if (floor_ == 0) floor_ = 1;
        decay = bound(decay, 60, 6 hours);
        vm.prank(seller);
        life = bound(life, 10 minutes, 4 days);
        try auction.list(id, uint128(amount), uint128(start), uint128(floor_), uint64(decay), uint64(block.timestamp + life)) {}
        catch {}
    }

    function bid(uint256 actorSeed, uint256 lotSeed, uint256 slack) external tracked {
        uint256 n = auction.lotCount();
        if (n == 0) return;
        uint256 lotId = 1 + lotSeed % n;
        address bidder = _actor(actorSeed);
        MiniAuction.Lot memory l = auction.lotOf(lotId);
        uint256 maxPrice = uint256(l.startPrice) + bound(slack, 0, 1e6);
        vm.prank(bidder);
        try auction.bid(lotId, uint128(maxPrice)) returns (uint256 price) {
            bids++;
            sales[lotId]++;
            bool shut = clock.regime(l.wrapper) == IMarketClock.Regime.CLOSED && clock.primaryCapNow(l.wrapper) == 0
                && !pointer.isOpen(l.wrapper);
            bool sameEpoch = pointer.epochOf(l.wrapper) == l.epochAtMint
                && note.unitOf(l.noteId).epochAtMint == l.epochAtMint;
            bool inBounds = price >= l.floorPrice && price <= l.startPrice;
            if (!shut || !sameEpoch || !inBounds) badBid = true;
        } catch {}
    }

    function withdrawLot(uint256 lotSeed) external tracked {
        uint256 n = auction.lotCount();
        if (n == 0) return;
        uint256 lotId = 1 + lotSeed % n;
        vm.prank(auction.lotOf(lotId).seller);
        try auction.withdraw(lotId) {} catch {}
    }
}
