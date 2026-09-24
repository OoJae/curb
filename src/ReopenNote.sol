// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155Min} from "./lib/ERC1155Min.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IMarketClock} from "./interfaces/IMarketClock.sol";
import {IReopenPointer} from "./interfaces/IReopenPointer.sol";
import {IReopenNote} from "./interfaces/IReopenNote.sol";
import {IScorecardPrice} from "./interfaces/IScorecardPrice.sol";

/// @title ReopenNote (CURB-RN)
/// @notice An ERC-1155 claim on wrapper shares escrowed while an asset's primary market is shut,
///         physically settled: every unit redeems for exactly one wei of the same wrapper share once the
///         market has verifiably reopened, or after a 10-day fallback.
///
/// @dev WHY THIS SHAPE. While a tokenized equity's primary market is shut, a holder who needs to sell can
///      only hit a thin AMM. A note lets them sell a claim on the shares instead, and lets a buyer price
///      the reopen rather than the gap. The note never pays cash and never converts through a
///      multiplier: the 4626 wrapper share already absorbs every corporate action, so delivering the
///      same number of wrapper shares is correct whatever happens to the rate or the nonce in between.
///      The underlying share count and the nonce are recorded at mint and reported at redeem only as
///      provenance, and reading them can never block a redemption.
///
///      - Mint only while MarketClock says CLOSED with zero primary capacity, outside a multiplier
///        blackout, after ReopenPointer.observe has itself witnessed the market not open (`epochAtMint`
///        is the epoch it returned), and under the asset's fixed cap FOR THAT CLOSURE: the cap bounds
///        the units of one epoch still outstanding (`mintedInEpoch`), so notes from an earlier closure
///        that unlocked but were never redeemed cannot block minting in a later one.
///      - Redeem calls observe first (so a redemption can witness the reopen itself), then unlocks when
///        the epoch has moved past `epochAtMint` or `mintedAt + FALLBACK_AFTER` has passed. It does not
///        stop in a multiplier blackout.
///      - Cancel lets the issuer unwind a note while it still holds every outstanding unit.
///
///      Supported assets and their caps are fixed in the constructor. No admin, no upgrade, no pause.
///      Ids start at 1; 1 unit = 1 wei of wrapper share.
contract ReopenNote is ERC1155Min, IReopenNote {
    using SafeTransfer for address;

    event NoteMinted(
        uint256 indexed id,
        address indexed issuer,
        address indexed wrapper,
        uint128 wrapperShares,
        uint128 underlyingAtMint,
        uint32 multiplierNonce,
        uint32 epochAtMint,
        address to
    );
    event NoteRedeemed(
        uint256 indexed id,
        address indexed holder,
        address indexed to,
        uint128 wrapperShares,
        uint256 underlyingAtRedeem,
        uint32 nonceAtRedeem,
        uint32 epochNow,
        bool viaFallback
    );
    event NoteCancelled(uint256 indexed id, address indexed issuer, uint128 wrapperShares);

    error UnsupportedAsset();
    error MarketNotClosed();
    error InBlackout();
    /// @dev `oi` is the closure's outstanding units after this mint: mintedInEpoch[w][epoch] + s.
    error CapExceeded(uint256 oi, uint256 cap);
    error ZeroAmount();
    error NotReopened(uint256 id, uint32 epochAtMint, uint32 epochNow);
    error NotWholeIssuer();
    error UnknownNote();
    // Beyond the frozen list: constructor validation, escrow accounting and the lock.
    error BadConfig();
    error NoPriceSource(address wrapper);
    error EscrowMismatch(uint256 received, uint256 expected);
    error ValueOverflow();
    error Reentrancy();
    error InvalidRecipient(address to);

    string public constant name = "Curb Reopen Note";
    string public constant symbol = "CURB-RN";
    uint64 public constant FALLBACK_AFTER = 10 days;

    IMarketClock public immutable clock;
    IReopenPointer public immutable pointer;
    IScorecardPrice public immutable scorecard;

    /// @notice Per-closure cap per wrapper, in wrapper-share wei: bounds `mintedInEpoch`. Written only by
    ///         the constructor.
    mapping(address wrapper => uint256) public capShares;
    /// @notice Wrapper shares escrowed against live units, per wrapper, across all epochs (== Σ outstanding).
    mapping(address wrapper => uint256) public openInterest;
    /// @notice Units minted in closure `epoch` (the `epochAtMint` observe returned) that are still
    ///         outstanding: + on mint, - on redeem and cancel. Mint requires it to stay <= capShares.
    mapping(address wrapper => mapping(uint32 epoch => uint256)) public mintedInEpoch;
    /// @notice Number of notes ever minted; the latest id.
    uint256 public noteCount;

    address[] internal _assets;
    mapping(uint256 id => Unit) internal _units;
    mapping(uint256 id => uint128) internal _outstanding;

    /// @dev Storage-slot lock: 1 = free, 2 = entered.
    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param wrappers  The supported wrappers; each must have a Scorecard price source.
    /// @param caps      Per-closure cap per wrapper, in wrapper-share wei (> 0, no duplicates).
    constructor(
        IMarketClock clock_,
        IReopenPointer pointer_,
        IScorecardPrice scorecard_,
        address[] memory wrappers,
        uint256[] memory caps,
        string memory uri_
    ) ERC1155Min(uri_) {
        if (address(clock_) == address(0) || address(pointer_) == address(0) || address(scorecard_) == address(0)) {
            revert BadConfig();
        }
        if (wrappers.length == 0 || wrappers.length != caps.length) revert BadConfig();
        for (uint256 i; i < wrappers.length; ++i) {
            address w = wrappers[i];
            if (w == address(0) || caps[i] == 0 || capShares[w] != 0) revert BadConfig();
            (address pool,,,,) = scorecard_.priceSources(w);
            if (pool == address(0)) revert NoPriceSource(w);
            capShares[w] = caps[i];
            _assets.push(w);
        }
        clock = clock_;
        pointer = pointer_;
        scorecard = scorecard_;
    }

    // --- writes ---------------------------------------------------------------------------------

    /// @notice Escrow `wrapperShares` of `wrapper` from the caller and mint as many units of a new note to `to`.
    function mint(address wrapper, uint128 wrapperShares, address to) external nonReentrant returns (uint256 id) {
        if (wrapperShares == 0) revert ZeroAmount();
        uint256 cap = capShares[wrapper];
        if (cap == 0) revert UnsupportedAsset();
        if (clock.regime(wrapper) != IMarketClock.Regime.CLOSED || clock.primaryCapNow(wrapper) != 0) {
            revert MarketNotClosed();
        }
        if (clock.isInMultiplierBlackout(wrapper)) revert InBlackout();
        (uint32 epoch, bool open) = pointer.observe(wrapper);
        if (open) revert MarketNotClosed();
        uint256 inEpoch = mintedInEpoch[wrapper][epoch] + wrapperShares;
        if (inEpoch > cap) revert CapExceeded(inEpoch, cap);

        mintedInEpoch[wrapper][epoch] = inEpoch;
        openInterest[wrapper] += wrapperShares;
        id = _record(wrapper, wrapperShares, epoch);
        _pull(wrapper, wrapperShares);

        Unit storage u = _units[id];
        emit NoteMinted(id, msg.sender, wrapper, wrapperShares, u.underlyingAtMint, u.multiplierNonce, epoch, to);
        _mint(to, id, wrapperShares, "");
    }

    /// @notice Burn `amount` of the caller's units of note `id` and send exactly `amount` wrapper shares to `to`.
    /// @dev `to` may not be the note itself: shares sent there would be stranded outside every note's escrow.
    function redeem(uint256 id, uint128 amount, address to) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ERC1155ZeroAddress();
        if (to == address(this)) revert InvalidRecipient(to);
        Unit storage u = _units[id];
        address wrapper = u.wrapper;
        if (wrapper == address(0)) revert UnknownNote();

        (uint32 epochNow,) = pointer.observe(wrapper);
        bool viaFallback = _checkUnlocked(id, u, epochNow);

        _burn(msg.sender, id, amount);
        _outstanding[id] -= amount;
        openInterest[wrapper] -= amount;
        mintedInEpoch[wrapper][u.epochAtMint] -= amount;
        wrapper.safeTransfer(to, amount);

        (uint256 underlyingNow, uint32 nonceNow) = _provenance(wrapper, amount);
        emit NoteRedeemed(id, msg.sender, to, amount, underlyingNow, nonceNow, epochNow, viaFallback);
    }

    /// @notice Unwind note `id`: its issuer, holding every outstanding unit, takes the escrowed shares back.
    function cancel(uint256 id) external nonReentrant {
        Unit storage u = _units[id];
        address wrapper = u.wrapper;
        if (wrapper == address(0)) revert UnknownNote();
        uint128 out = _outstanding[id];
        if (out == 0) revert ZeroAmount();
        if (msg.sender != u.issuer || _balances[id][msg.sender] != out) revert NotWholeIssuer();

        _burn(msg.sender, id, out);
        _outstanding[id] = 0;
        openInterest[wrapper] -= out;
        mintedInEpoch[wrapper][u.epochAtMint] -= out;
        wrapper.safeTransfer(msg.sender, out); // msg.sender is the issuer, never this contract
        emit NoteCancelled(id, msg.sender, out);
    }

    // --- ERC-1155 (locked, and disambiguated against IReopenNote) --------------------------------

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data)
        public
        override(ERC1155Min, IReopenNote)
        nonReentrant
    {
        super.safeTransferFrom(from, to, id, value, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) public override nonReentrant {
        super.safeBatchTransferFrom(from, to, ids, values, data);
    }

    function setApprovalForAll(address operator, bool approved) public override nonReentrant {
        super.setApprovalForAll(operator, approved);
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

    // --- views ----------------------------------------------------------------------------------

    function unitOf(uint256 id) external view returns (Unit memory) {
        return _units[id];
    }

    function outstanding(uint256 id) external view returns (uint128) {
        return _outstanding[id];
    }

    /// @notice Whether note `id` is unlocked on the pointer's stored epoch or by the fallback.
    /// @dev Conservative: true means `redeem` will unlock. False can turn true on the next `observe`
    ///      (which `redeem` itself makes), if the market has reopened but nobody has witnessed it yet.
    function redeemable(uint256 id) external view returns (bool) {
        Unit storage u = _units[id];
        if (u.wrapper == address(0)) return false;
        return pointer.epochOf(u.wrapper) > u.epochAtMint || block.timestamp >= uint256(u.mintedAt) + FALLBACK_AFTER;
    }

    function supportedAssets() external view returns (address[] memory) {
        return _assets;
    }

    // --- internals ------------------------------------------------------------------------------

    function _record(address wrapper, uint128 wrapperShares, uint32 epoch) internal returns (uint256 id) {
        uint256 underlying = clock.rawToShares(wrapper, wrapperShares);
        if (underlying > type(uint128).max) revert ValueOverflow();
        id = ++noteCount;
        _units[id] = Unit({
            wrapper: wrapper,
            issuer: msg.sender,
            wrapperShares: wrapperShares,
            underlyingAtMint: uint128(underlying),
            multiplierNonce: clock.stateOf(wrapper).multiplierNonce,
            epochAtMint: epoch,
            mintedAt: uint64(block.timestamp),
            mintedBlock: uint64(block.number)
        });
        _outstanding[id] = wrapperShares;
    }

    /// @dev Pull exactly `amount` shares into escrow; anything else would break escrow == Σ outstanding.
    function _pull(address wrapper, uint256 amount) internal {
        uint256 before = IERC20(wrapper).balanceOf(address(this));
        wrapper.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(wrapper).balanceOf(address(this)) - before;
        if (received != amount) revert EscrowMismatch(received, amount);
    }

    function _checkUnlocked(uint256 id, Unit storage u, uint32 epochNow) internal view returns (bool viaFallback) {
        uint32 epochAtMint = u.epochAtMint;
        if (epochNow > epochAtMint) return false;
        if (block.timestamp < uint256(u.mintedAt) + FALLBACK_AFTER) revert NotReopened(id, epochAtMint, epochNow);
        return true;
    }

    /// @dev Provenance only: a reverting read reports 0 rather than blocking a delivery.
    function _provenance(address wrapper, uint256 amount) internal view returns (uint256 underlying, uint32 nonce) {
        try clock.rawToShares(wrapper, amount) returns (uint256 x) {
            underlying = x;
        } catch {}
        try clock.stateOf(wrapper) returns (IMarketClock.State memory s) {
            nonce = s.multiplierNonce;
        } catch {}
    }
}
