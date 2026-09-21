// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketClock} from "./interfaces/IMarketClock.sol";

interface IERC4626Like {
    function asset() external view returns (address);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface IRebasingXStock {
    /// @dev Backed's xStocks expose (value, pending, nonce). The third word is a monotonic
    ///      counter of applied corporate actions and is the only safe anti-race key:
    ///      the value itself can DECREASE (HONx went 1.0241 -> 0.5120 on a reverse split).
    function getCurrentMultiplier() external view returns (uint256, uint256, uint256);
}

/// @title MarketClock
/// @notice The regime oracle X Layer does not have: when is a tokenized equity's primary
///         market actually open, and what is its creation/redemption capacity right now?
///
/// @dev WHY THIS EXISTS. For a tokenized equity, "closed" is not a data outage and not an
///      oracle flag. It is the interval in which the issuer's own contract caps primary
///      creation and redemption at exactly zero, which switches off the arbitrage that pins
///      the token to its underlying -- while secondary AMM trading continues regardless.
///      On X Layer the 79 Hong Kong names sit in that state for 140.5 of every 168 hours.
///      Every risk engine on this chain currently has to reimplement this, and none has.
///
///      This contract is MIT, unlicensed, and free to read. Curb depends on it, but it is
///      deliberately useful standalone. Attestation is quorum-signed off-chain because the
///      source of truth is the issuer's own API and an exchange session calendar; the
///      attestor publishes `inputRoot` with every write so any third party can re-derive
///      the state and dispute it.
contract MarketClock is IMarketClock {
    error NotAttestor();
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error UnknownAsset(address wrapper);
    error StaleAttestation(address wrapper, uint64 observedAt, uint64 maxAge);
    error AlreadyRegistered(address wrapper);
    error BadQuorum();

    /// @dev An attestation older than this is treated as UNKNOWN rather than trusted.
    ///      Chosen so a single missed round degrades gracefully but a dead attestor
    ///      cannot silently hold an asset "open".
    uint64 public constant MAX_ATTESTATION_AGE = 30 minutes;

    /// @dev Corporate actions activate on a timestamp with NO event emitted. xStocks tells
    ///      integrators to pause +/- 15 minutes around an activation. We hold the blackout
    ///      open from the moment we observe a nonce change until this elapses.
    uint64 public constant BLACKOUT_WINDOW = 15 minutes;

    struct Asset {
        address raw;        // the rebasing xStock
        bytes4 mic;         // exchange, e.g. "XHKG"
        uint8 hoursMode;    // 0 unknown, 1 TwentyFourFive, 2 Regular, 3 MarketHours, 4 Always
        bool registered;
    }

    address public admin;
    /// @dev Two-step handover: a mistyped address cannot silently brick admin rights,
    ///      because the new admin must prove control by calling acceptAdmin().
    address public pendingAdmin;

    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    mapping(address => bool) public isAttestor;
    mapping(address => Asset) public assets;
    mapping(address => State) internal _state;
    mapping(address => uint64) public blackoutUntil;
    address[] public registered;

    modifier onlyAttestor() {
        if (!isAttestor[msg.sender]) revert NotAttestor();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_, address[] memory attestors_) {
        if (attestors_.length == 0) revert BadQuorum();
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        for (uint256 i; i < attestors_.length; ++i) isAttestor[attestors_[i]] = true;
    }

    // --- admin -------------------------------------------------------------

    /// @notice Start handing admin rights to `to`. Takes effect only when `to` accepts.
    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    /// @notice Complete a handover started by the current admin.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    function setAttestor(address a, bool ok) external onlyAdmin {
        isAttestor[a] = ok;
    }

    function registerAsset(address wrapper, address raw, bytes4 mic, uint8 hoursMode) external onlyAdmin {
        if (assets[wrapper].registered) revert AlreadyRegistered(wrapper);
        assets[wrapper] = Asset({raw: raw, mic: mic, hoursMode: hoursMode, registered: true});
        registered.push(wrapper);
        emit AssetRegistered(wrapper, raw, mic, hoursMode);
    }

    function registeredCount() external view returns (uint256) {
        return registered.length;
    }

    // --- attestation -------------------------------------------------------

    /// @notice Publish the regime for one asset.
    /// @param inputRoot Merkle root of the exact inputs this attestation was derived from,
    ///        so the write is falsifiable rather than merely trusted.
    function attest(
        address wrapper,
        Regime regime_,
        uint128 primaryCapUsd,
        uint64 nextTransitionAt,
        bool halted,
        bytes32 inputRoot
    ) public onlyAttestor {
        Asset memory a = assets[wrapper];
        if (!a.registered) revert UnknownAsset(wrapper);

        // Read the corporate-action counter live. A change means a rebase has just been
        // applied, so we open a blackout: balances have moved and no obligation denominated
        // in them may settle until the window passes.
        uint32 nonce = _readNonce(a.raw);
        State storage s = _state[wrapper];
        if (s.observedAt != 0 && nonce != s.multiplierNonce) {
            uint64 until_ = uint64(block.timestamp) + BLACKOUT_WINDOW;
            blackoutUntil[wrapper] = until_;
            emit BlackoutOpened(wrapper, s.multiplierNonce, nonce, until_);
        }

        Regime prev = s.regime;
        s.regime = regime_;
        s.primaryCapUsd = primaryCapUsd;
        s.nextTransitionAt = nextTransitionAt;
        s.observedAt = uint64(block.timestamp);
        s.multiplierNonce = nonce;
        s.halted = halted;

        emit StateAttested(wrapper, regime_, primaryCapUsd, nextTransitionAt, nonce, inputRoot);
        if (prev != regime_) emit RegimeChanged(wrapper, prev, regime_, uint64(block.timestamp));
    }

    /// @notice Batch form. The attestor covers 700+ assets, so per-asset transactions are
    ///         not viable on a 1-second-block chain with a real gas budget.
    function attestBatch(
        address[] calldata wrappers,
        Regime[] calldata regimes,
        uint128[] calldata caps,
        uint64[] calldata nextAt,
        bool[] calldata halted,
        bytes32 inputRoot
    ) external onlyAttestor {
        uint256 n = wrappers.length;
        require(
            regimes.length == n && caps.length == n && nextAt.length == n && halted.length == n,
            "length mismatch"
        );
        for (uint256 i; i < n; ++i) {
            attest(wrappers[i], regimes[i], caps[i], nextAt[i], halted[i], inputRoot);
        }
    }

    // --- views -------------------------------------------------------------

    function stateOf(address wrapper) public view returns (State memory) {
        return _state[wrapper];
    }

    /// @dev Returns UNKNOWN on a stale attestation. Failing closed is the point: a consumer
    ///      that cannot tell "open" from "we stopped looking" will happily liquidate into a
    ///      market that is shut.
    function regime(address wrapper) public view returns (Regime) {
        State memory s = _state[wrapper];
        if (s.observedAt == 0) return Regime.UNKNOWN;
        if (block.timestamp > s.observedAt + MAX_ATTESTATION_AGE) return Regime.UNKNOWN;
        return s.regime;
    }

    /// @notice Primary creation/redemption capacity in whole USD, or 0 when switched off.
    /// @dev A stale attestation reports 0, which is the conservative direction: it makes
    ///      the asset look closed rather than tradeable.
    function primaryCapNow(address wrapper) public view returns (uint128) {
        if (regime(wrapper) == Regime.UNKNOWN) return 0;
        return _state[wrapper].primaryCapUsd;
    }

    function secondsToNextTransition(address wrapper) external view returns (uint256) {
        uint64 t = _state[wrapper].nextTransitionAt;
        if (t == 0 || t <= block.timestamp) return 0;
        return t - block.timestamp;
    }

    function isInMultiplierBlackout(address wrapper) public view returns (bool) {
        return block.timestamp < blackoutUntil[wrapper];
    }

    /// @notice Wrapper shares -> underlying share-equivalents.
    /// @dev The conversion every integrator on this chain currently gets wrong. A wrapped
    ///      xStock's price already embeds every dividend ever paid, so comparing it to
    ///      underlying spot is wrong by the accrued multiplier and the error never resets.
    function rawToShares(address wrapper, uint256 wrapperShares) external view returns (uint256) {
        return IERC4626Like(wrapper).convertToAssets(wrapperShares);
    }

    function _readNonce(address raw) internal view returns (uint32) {
        try IRebasingXStock(raw).getCurrentMultiplier() returns (uint256, uint256, uint256 n) {
            return uint32(n);
        } catch {
            return 0;
        }
    }
}
