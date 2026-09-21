// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketClock} from "./interfaces/IMarketClock.sol";
import {MulDiv} from "./lib/MulDiv.sol";

interface IUniV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityX128);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title Scorecard
/// @notice A public, append-only record of how wrong Curb's closed-market marks turned out
///         to be, graded against the verified reopen and against three naive baselines.
///
/// @dev WHY IT IS SHAPED LIKE THIS. A three-week-old team asserting a price during the hours
///      an exchange is shut has no standing. So Curb does not ask to be trusted: it commits
///      each mark BEFORE the market reopens, publishes the Merkle root of the exact inputs it
///      used, and then lets anyone settle the row afterwards against the reopen print. The
///      contract computes the error itself, alongside the error of the three things a sceptic
///      would otherwise reach for -- the last print before the closure, the pool VWAP at the
///      bell, and a stale banded oracle value.
///
///      The scoring is therefore about SKILL, not accuracy. "Our median error was 27bp" is
///      unfalsifiable puffery; "we beat the closing print by X% across 18 closures whose
///      commit blocks provably precede their settlement blocks" is a claim a judge can check
///      on an explorer, and one that cannot be backfilled.
///
///      There is NO admin revision path. Not a missing feature -- the absence is the product.
///
///      WHAT CHANGED IN v2, AND WHY. The first version let the caller of `settle` supply the
///      reopen price. Settlement is permissionless by design, so that let any passer-by grade
///      every Curb row against a number they invented, permanently, with no way to correct it.
///      A record anyone can poison is not evidence. Here `settle` takes no price at all: the
///      contract reads it from the asset's own pool, guarded against manipulation by the pool's
///      time-weighted average, and refuses to settle at all until MarketClock says the primary
///      market has actually reopened. Nobody -- including Curb -- supplies the number.
contract Scorecard {
    using MulDiv for uint256;

    error NotKeeper();
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error ClosureExists(bytes32 id);
    error UnknownClosure(bytes32 id);
    error AlreadySettled(bytes32 id);
    error TooEarly(bytes32 id, uint64 readyAt);
    error TooLate(bytes32 id, uint64 deadline);
    /// @dev Raised by `commit` when the primary market is still OPEN: a "closed-market mark"
    ///      published while creation and redemption are live is not evidence of anything.
    error MarketStillOpen(address wrapper);
    /// @dev Raised by `settle` when the primary market has NOT reopened yet.
    error MarketStillShut(address wrapper);
    error BadMark();
    error NoPriceSource(address wrapper);
    error PriceSourceLocked(address wrapper);
    error PoolMismatch(address wrapper, address pool);
    error PriceDeviates(int24 spotTick, int24 twapTick);
    error PriceUnreadable(address pool);
    error OracleTooShallow(address pool, uint16 cardinality);
    error PoolEmpty(address pool);
    error BadTwapWindow(uint32 twapWindow);

    /// @dev Where a wrapper's price comes from, and how it is guarded. Write-once per wrapper:
    ///      an admin who could re-point the oracle after seeing a mark could choose their own grade.
    struct PriceSource {
        address pool;            // Uniswap V3-style pool holding the wrapper against a stable
        bool equityIsToken0;     // three of the five live pools list the stable first
        uint32 twapWindow;       // seconds averaged for the manipulation guard
        uint8 equityDecimals;
        uint8 stableDecimals;
    }

    /// @dev One mark, committed while the primary market was capped at zero.
    struct Commitment {
        address wrapper;
        uint64 committedAt;      // block.timestamp at commit
        uint64 committedBlock;   // block.number at commit -- the anti-backfill evidence
        uint64 settleAfter;      // earliest settlement, i.e. expected reopen
        uint128 mark;            // Curb's mark, 1e18, in wrapper-share terms
        uint32 bandBps;          // the confidence band Curb published with it
        bytes32 inputRoot;       // Merkle root of the exact inputs used
        bytes32 methodDigest;    // hash of the published method, so the model is pinned too
        // The baselines, captured at commit time so they cannot be chosen later.
        uint128 lastPrint;       // last verified print before the closure
        uint128 closingVwap;     // wrapper-pool VWAP at the moment of closure
        uint128 staleOracle;     // stale banded oracle value, 0 if none exists for this asset
    }

    struct Settlement {
        uint64 settledAt;
        uint64 settledBlock;
        uint128 reopenPrint;
        uint32 curbErrorBps;
        uint32 lastPrintErrorBps;
        uint32 closingVwapErrorBps;
        uint32 staleOracleErrorBps;
        uint8 source;            // 1 = issuer reopen + pool print guarded by the pool's own TWAP
        bool settled;
    }

    event ClosureCommitted(
        bytes32 indexed id,
        address indexed wrapper,
        uint128 mark,
        uint32 bandBps,
        uint64 settleAfter,
        uint64 committedBlock,
        bytes32 inputRoot,
        bytes32 methodDigest
    );
    event ClosureSettled(
        bytes32 indexed id,
        address indexed wrapper,
        uint128 reopenPrint,
        uint32 curbErrorBps,
        uint32 lastPrintErrorBps,
        uint32 closingVwapErrorBps,
        uint32 staleOracleErrorBps,
        uint8 source,
        uint64 settledBlock
    );
    event PriceSourceSet(address indexed wrapper, address indexed pool, bool equityIsToken0, uint32 twapWindow);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    /// @notice How long after the expected reopen the price is read, so the print is the market's
    ///         own first minutes rather than the first tick of a thin book.
    uint32 public constant SETTLE_DELAY = 300;
    /// @notice How long settlement stays open after that. Generous on purpose: a row that cannot be
    ///         settled is a row that never gets graded, and the guard below can legitimately refuse.
    uint32 public constant SETTLE_WINDOW = 6 hours;
    /// @notice Spot may differ from the time-weighted average by at most this many ticks (~0.5%).
    ///         Moving the settled price therefore means moving the average, which costs real money.
    int24 public constant MAX_TICK_DEVIATION = 50;
    /// @notice A pool must keep at least this many oracle observations to be registered.
    /// @dev Measured on X Layer mainnet, 21 Sep 2026, and the reason this check exists: a pool whose
    ///      `observationCardinality` is 1 still answers `observe()` successfully, but the value it
    ///      returns is arithmetically IDENTICAL to spot -- the single stored observation is
    ///      extrapolated forward at the current tick, so the "average" carries zero history. Checking
    ///      that `observe` merely succeeds would register such a pool and leave the guard below
    ///      comparing spot against itself: a deviation of exactly zero, always, forever.
    uint16 public constant MIN_OBSERVATION_CARDINALITY = 32;

    IMarketClock public immutable clock;
    address public admin;
    /// @dev Two-step handover: a mistyped address cannot silently brick admin rights,
    ///      because the new admin must prove control by calling acceptAdmin().
    address public pendingAdmin;

    mapping(address => bool) public isKeeper;
    mapping(address => PriceSource) public priceSources;

    mapping(bytes32 => Commitment) public commitments;
    mapping(bytes32 => Settlement) public settlements;
    bytes32[] public closureIds;

    /// @dev Running tallies so the headline is readable without an indexer.
    uint256 public settledCount;
    uint256 public curbBeatLastPrint;
    uint256 public curbBeatClosingVwap;

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(IMarketClock clock_, address admin_) {
        clock = clock_;
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

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

    function setKeeper(address k, bool ok) external onlyAdmin {
        isKeeper[k] = ok;
    }

    /// @notice Register where a wrapper's settlement price is read from. Write-once per wrapper.
    /// @dev Validates at registration rather than trusting the caller: the pool must actually hold
    ///      this wrapper on the side claimed, and must already serve the TWAP the guard depends on.
    function setPriceSource(address wrapper, address pool, bool equityIsToken0, uint32 twapWindow) external onlyAdmin {
        if (wrapper == address(0) || pool == address(0)) revert ZeroAddress();
        if (priceSources[wrapper].pool != address(0)) revert PriceSourceLocked(wrapper);
        // The guard window must close strictly before settlement opens, so that every second it
        // averages is AFTER the market reopened. Otherwise a genuine reopen gap -- the entire point
        // of the record -- would look like manipulation, and the rows that matter most would be the
        // ones that could never be settled.
        if (twapWindow == 0 || twapWindow >= SETTLE_DELAY) revert BadTwapWindow(twapWindow);

        address equity = equityIsToken0 ? IUniV3Pool(pool).token0() : IUniV3Pool(pool).token1();
        address stable = equityIsToken0 ? IUniV3Pool(pool).token1() : IUniV3Pool(pool).token0();
        if (equity != wrapper) revert PoolMismatch(wrapper, pool);
        if (IUniV3Pool(pool).liquidity() == 0) revert PoolEmpty(pool);

        // A shallow oracle makes the guard a no-op; see MIN_OBSERVATION_CARDINALITY.
        (,,, uint16 cardinality,,,) = IUniV3Pool(pool).slot0();
        if (cardinality < MIN_OBSERVATION_CARDINALITY) revert OracleTooShallow(pool, cardinality);

        // The oracle must already have the history the guard will ask for, or the first settlement
        // would be the moment we discover it does not.
        uint32[] memory ago = new uint32[](2);
        ago[0] = 0;
        ago[1] = twapWindow;
        try IUniV3Pool(pool).observe(ago) returns (int56[] memory, uint160[] memory) {
            // ok
        } catch {
            revert PriceUnreadable(pool);
        }

        priceSources[wrapper] = PriceSource({
            pool: pool,
            equityIsToken0: equityIsToken0,
            twapWindow: twapWindow,
            equityDecimals: IERC20Decimals(equity).decimals(),
            stableDecimals: IERC20Decimals(stable).decimals()
        });
        emit PriceSourceSet(wrapper, pool, equityIsToken0, twapWindow);
    }

    function closureCount() external view returns (uint256) {
        return closureIds.length;
    }

    /// @notice Commit a mark for a closure, before the market reopens.
    function commit(Commitment calldata c) external onlyKeeper returns (bytes32 id) {
        if (c.mark == 0) revert BadMark();
        if (clock.primaryCapNow(c.wrapper) != 0) revert MarketStillOpen(c.wrapper);
        // Never commit a mark that cannot later be settled honestly.
        if (priceSources[c.wrapper].pool == address(0)) revert NoPriceSource(c.wrapper);

        id = keccak256(abi.encode(c.wrapper, c.settleAfter, c.inputRoot));
        if (commitments[id].committedAt != 0) revert ClosureExists(id);

        Commitment memory m = c;
        m.committedAt = uint64(block.timestamp);
        m.committedBlock = uint64(block.number);
        commitments[id] = m;
        closureIds.push(id);

        emit ClosureCommitted(
            id, c.wrapper, c.mark, c.bandBps, c.settleAfter,
            uint64(block.number), c.inputRoot, c.methodDigest
        );
    }

    /// @notice Settle a committed closure against the reopen print the contract reads for itself.
    /// @dev Permissionless on purpose, and priceless on purpose. The record must keep accruing even
    ///      if Curb's own keeper dies -- but the settler chooses only the MOMENT, never the NUMBER,
    ///      and even the moment is fenced: not before the market has reopened and the print has had
    ///      SETTLE_DELAY to form, not after SETTLE_WINDOW, and never further than
    ///      MAX_TICK_DEVIATION from the pool's own time-weighted average.
    function settle(bytes32 id) external {
        Commitment memory c = commitments[id];
        if (c.committedAt == 0) revert UnknownClosure(id);
        if (settlements[id].settled) revert AlreadySettled(id);

        uint64 readyAt = c.settleAfter + SETTLE_DELAY;
        if (block.timestamp < readyAt) revert TooEarly(id, readyAt);
        uint64 deadline = readyAt + SETTLE_WINDOW;
        if (block.timestamp > deadline) revert TooLate(id, deadline);

        // The authority for "the closure is over" is the issuer's own primary capacity, per D-1:
        // a reopen is when creation and redemption come back, not when a clock says so.
        if (clock.primaryCapNow(c.wrapper) == 0) revert MarketStillShut(c.wrapper);

        uint128 reopenPrint = _guardedPrice(c.wrapper);

        uint32 e0 = _errBps(c.mark, reopenPrint);
        uint32 e1 = _errBps(c.lastPrint, reopenPrint);
        uint32 e2 = _errBps(c.closingVwap, reopenPrint);
        uint32 e3 = c.staleOracle == 0 ? type(uint32).max : _errBps(c.staleOracle, reopenPrint);

        settlements[id] = Settlement({
            settledAt: uint64(block.timestamp),
            settledBlock: uint64(block.number),
            reopenPrint: reopenPrint,
            curbErrorBps: e0,
            lastPrintErrorBps: e1,
            closingVwapErrorBps: e2,
            staleOracleErrorBps: e3,
            source: 1,
            settled: true
        });

        unchecked {
            ++settledCount;
            if (e0 < e1) ++curbBeatLastPrint;
            if (e0 < e2) ++curbBeatClosingVwap;
        }

        emit ClosureSettled(id, c.wrapper, reopenPrint, e0, e1, e2, e3, 1, uint64(block.number));
    }

    /// @notice The price this contract would settle at right now, so a keeper can see what it will
    ///         get -- and so anyone can check a settled row against the same function.
    function priceNow(address wrapper) external view returns (uint128) {
        return _guardedPrice(wrapper);
    }

    /// @notice The headline, computed onchain so nobody has to take our word for the arithmetic.
    function skill() external view returns (uint256 settled_, uint256 beatLast, uint256 beatVwap) {
        return (settledCount, curbBeatLastPrint, curbBeatClosingVwap);
    }

    /// @dev Spot, refused unless it agrees with the pool's own time-weighted average over a window
    ///      that `setPriceSource` forces to be shorter than SETTLE_DELAY -- so at settlement the
    ///      whole averaged window lies after the reopen, and a large overnight gap is priced rather
    ///      than rejected.
    function _guardedPrice(address wrapper) internal view returns (uint128) {
        PriceSource memory s = priceSources[wrapper];
        if (s.pool == address(0)) revert NoPriceSource(wrapper);

        (uint160 sqrtPriceX96, int24 spotTick,,,,,) = IUniV3Pool(s.pool).slot0();

        uint32[] memory ago = new uint32[](2);
        ago[0] = 0;
        ago[1] = s.twapWindow;
        int56[] memory cumulatives;
        try IUniV3Pool(s.pool).observe(ago) returns (int56[] memory c_, uint160[] memory) {
            cumulatives = c_;
        } catch {
            revert PriceUnreadable(s.pool);
        }

        int24 twapTick = int24((cumulatives[0] - cumulatives[1]) / int56(uint56(s.twapWindow)));
        int24 dev = spotTick > twapTick ? spotTick - twapTick : twapTick - spotTick;
        if (dev > MAX_TICK_DEVIATION) revert PriceDeviates(spotTick, twapTick);

        return _priceFromSqrt(sqrtPriceX96, s);
    }

    /// @dev sqrtPriceX96 -> 1e18 USD per wrapper share, in two full-precision steps so the square
    ///      never overflows. `p = sqrt^2 / 2^192`, expressed as token1 per token0 and inverted when
    ///      the wrapper is token1, with the two tokens' decimals folded in.
    function _priceFromSqrt(uint160 sqrtPriceX96, PriceSource memory s) internal pure returns (uint128) {
        uint256 q96 = 1 << 96;
        uint256 half = MulDiv.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), q96);

        uint256 price;
        if (s.equityIsToken0) {
            // token1 per token0, scaled to 1e18 and corrected for decimals.
            price = MulDiv.mulDiv(half, 1e18 * (10 ** s.equityDecimals), q96) / (10 ** s.stableDecimals);
        } else {
            // token0 per token1: invert. Divide by the squared price only ONCE, and at the end, so a
            // thin raw price cannot truncate to zero on the way through.
            if (half == 0) revert PriceUnreadable(s.pool);
            price = MulDiv.mulDiv(1e18 * (10 ** s.equityDecimals), q96, half) / (10 ** s.stableDecimals);
        }
        if (price == 0 || price > type(uint128).max) revert PriceUnreadable(s.pool);
        return uint128(price);
    }

    /// @dev Absolute error in basis points, saturating rather than reverting so one absurd
    ///      input can never block a row from being graded.
    function _errBps(uint128 estimate, uint128 actual) internal pure returns (uint32) {
        if (actual == 0) return type(uint32).max;
        uint256 diff = estimate > actual ? estimate - actual : actual - estimate;
        uint256 bps = (diff * 10_000) / actual;
        return bps > type(uint32).max ? type(uint32).max : uint32(bps);
    }
}
