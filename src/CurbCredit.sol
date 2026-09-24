// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketClock} from "./interfaces/IMarketClock.sol";
import {IScorecardPrice} from "./interfaces/IScorecardPrice.sol";
import {IDepthCert} from "./interfaces/IDepthCert.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {MulDiv} from "./lib/MulDiv.sol";

/// @dev MarketClock's auto-generated `assets(address)` getter (not part of IMarketClock). hoursMode: 0 unknown,
///      1 TwentyFourFive, 2 Regular, 3 MarketHours, 4 Always.
interface IClockAssets {
    function assets(address wrapper) external view returns (address raw, bytes4 mic, uint8 hoursMode, bool registered);
}

/// @title CurbCredit
/// @notice A fixed-rate USDG reserve lending against tokenized-equity wrapper shares, whose loan-to-value is
///         published, depends on whether the primary market is open, and is capped by what a bonded bid would
///         actually pay for the collateral.
///
/// @dev WHY. A lender against a Hong Kong xStock is, for 140 hours a week, lending against a token whose
///      creation/redemption arbitrage is switched off. The only honest collateral value in that state is what
///      someone has committed, with money at risk, to pay for the shares. So the LTV is:
///
///          regimeCap = UNKNOWN -> 0 ; primaryCapNow > 0 -> 6000 ; shut (cap 0) -> 3000
///          (dS,,minBid,) = depthCert.honouredDepth(a, this, minCertExpiry(a))
///          ltvFor  = 0 if UNKNOWN or dS == 0 or priceNow unreadable
///                  = min(regimeCap, minBid * 1e12 * 1e4 / P)
///
///      ltvFor is a PER-POSITION ratio. What a position may carry is the effective ratio
///
///          cover        = notional(dS, minBid)                  (what the honoured book pays for all its shares)
///          ltvEffective = ltvFor * min(1, cover / totalPrincipal[a])      (unscaled while totalPrincipal == 0)
///          limitOf(b,a) = valueUsdg(collateral, P) * ltvEffective / 1e4
///
///      Idle collateral enters neither term, so collateral posted by someone else can never push a borrower into
///      breach. Depth LEAVING (a cert expiring, filling, being realised or revoked) lowers every borrower's limit
///      pro rata: that is the margin call. Depth coverage is also enforced in aggregate at borrow time:
///
///          realisable(a) = notional(min(totalCollateral[a], dS - seized[a]), minBid)
///          borrow(x) requires totalPrincipal[a] + x <= realisable(a)       (else Refusal ExceedsDepth)
///
///      (seized shares still held here will be sold into the same book first, so new lending only counts the rest)
///      so right after any successful borrow cover >= totalPrincipal and nobody is scaled. `cover` itself is the
///      whole book: a liquidation or repayment only lowers totalPrincipal, so it can never push anyone else into
///      breach.
///
///      WHICH CERTS COUNT. A cert only supports lending if the lender could still hit it after the slowest
///      possible liquidation: the next reopen, then a full cure. So honoured depth counts only certs with
///
///          expiry >= minCertExpiry(a) = now + life + CURE_OPEN_SECONDS, where with toNext =
///          clock.secondsToNextTransition(a):
///            open, toNext < MIN_CERT_LIFE + CURE_OPEN_SECONDS (including 0: the scheduled transition has
///                  passed but the attestor has not yet written it, or none is published), and the asset's
///                  transitions can close it                             -> life = toNext + SHUT_CERT_LIFE
///                                                     (a close is imminent: the cert must see the next reopen)
///            open, otherwise                                         -> life = MIN_CERT_LIFE
///            open, clock read reverts                                -> life = SHUT_CERT_LIFE (fail closed)
///            shut / UNKNOWN                                          -> life = max(SHUT_CERT_LIFE, toNext + 1 h)
///
///      "Can close it" reads the clock's `assets(a).hoursMode`: 2 Regular (e.g. HKEX, with a lunch recess) and
///      3 MarketHours close at session ends, so an imminent transition there is treated as a close. 1 TwentyFourFive
///      and 4 Always change PERIOD (MARKET -> EXTENDED -> OVERNIGHT, all with capacity) every few hours; for those
///      the plain open rule applies, and the shut rule takes over once a real close is attested. An unknown mode
///      (0) or a failed read is treated as closing (fail closed).
///
///      While shut, only certs that outlive the next reopen plus a full cure count. SHUT_CERT_LIFE (73 h) covers a
///      weekend plus margin without trusting any calendar; a longer closure (a holiday the attestor's published
///      next transition says is further away) only ever LENGTHENS the requirement. The horizon is measured from
///      now, so during a long closure a cert must keep outliving it: a maker covering a weekend posts with
///      expiry >= (last moment it must count) + 73 h + 30 min.
///
///      Refusals are first-class. `borrow` and `withdraw` never revert on a policy refusal: they emit
///      `Refusal(who, asset, reason, requested, allowed)` with `reason` = the matching error selector, return
///      false, and change nothing -- so a refusal leaves an on-chain trace inside a succeeding transaction.
///
///      A breach does not liquidate. `flagBreach` starts a cure clock that only counts WITNESSED open-market
///      time: `tick` adds the gap since the last tick only if the market was open at that tick, is open now,
///      and the gap is at most 10 minutes. Shut or UNKNOWN freezes it. Liquidation needs 30 such minutes, an
///      open market and a fresh price, and never seizes more than a 5%-bonus liquidation at the breach-time
///      price would have. Seized shares stay here until the admin realises them into a DepthCert naming this
///      contract (or sweeps them).
///
///      GAS. Every external read is wrapped in try/catch so a misbehaving dependency fails closed; a catch taken
///      with less than GAS_FLOOR left reverts InsufficientGas instead, because an out-of-gas callee must not be
///      mistaken for "no depth" / "no price" / "not open" (that would let a starved `tick` keep a healthy
///      position's cure open, or stop a breached one's clock).
///
///      Units: shares S are 18-dp wrapper wei; USDG 6 dp; P = Scorecard.priceNow, 1e18 USD per whole share;
///      bidPx = USDG units per whole share. valueUsdg(S,P) = S*P/1e30, notional(S,px) = S*px/1e18,
///      sharesFor(u,P) = u*1e30/P. All maths via MulDiv, rounding toward zero.
contract CurbCredit {
    using SafeTransfer for IERC20;

    // --- refusal reasons (selectors carried by `Refusal`; some double as reverts) ------------------------------
    error Ineligible();
    error UnsupportedAsset();
    error MarketUnknown();
    error PriceUnavailable();
    error NoDepth();
    error ExceedsLtv();
    error ExceedsDepth();
    error ReserveShort();
    error InCure();
    error WouldBreach();

    // --- hard errors ------------------------------------------------------------------------------------------
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error Reentrancy();
    error DuplicateAsset(address asset);
    error NoPriceSource(address asset);
    error BadDecimals(address token, uint8 decimals);
    error ExceedsCollateral(uint256 collateral, uint256 requested);
    error AlreadyInCure();
    error NoCure();
    error NotBreached();
    error CureIncomplete(uint256 used, uint256 required);
    error MarketShut();
    error ExceedsSeized(uint256 seized, uint256 requested);
    error NotOurCert(uint256 certId);
    error ApproveFailed();
    error NoCode(address target);
    error InsufficientGas();

    // --- constants --------------------------------------------------------------------------------------------
    uint256 public constant LTV_OPEN_BPS = 6000;
    uint256 public constant LTV_SHUT_BPS = 3000;
    uint256 public constant APR_BPS = 500; // simple interest
    uint256 public constant STALE_BONUS_BPS = 500;
    uint256 public constant CURE_OPEN_SECONDS = 30 minutes;
    uint256 public constant MAX_TICK_GAP = 10 minutes;
    /// @notice While open: a cert must outlive now + MIN_CERT_LIFE + CURE_OPEN_SECONDS to count.
    uint256 public constant MIN_CERT_LIFE = 1 hours;
    /// @notice While shut (or UNKNOWN): at least now + SHUT_CERT_LIFE + CURE_OPEN_SECONDS (a weekend plus margin).
    uint256 public constant SHUT_CERT_LIFE = 73 hours;
    /// @dev A published next transition further out than this is treated as this (ltvFor is 0 long before).
    uint256 internal constant MAX_TRANSITION_HORIZON = 365 days;
    /// @notice A try/catch fallback taken with less gas than this left reverts InsufficientGas. EIP-150 leaves the
    ///         caller 1/64 of what it forwarded, so passing this check means an out-of-gas callee was given at
    ///         least 63 * GAS_FLOOR (3.15M) -- far above the worst honouredDepth (8-cert book, 16 certs a maker).
    uint256 public constant GAS_FLOOR = 50_000;
    /// @dev MarketClock hours modes whose transitions are period changes, not closes (see WHICH CERTS COUNT).
    uint256 internal constant HOURS_TWENTY_FOUR_FIVE = 1;
    uint256 internal constant HOURS_ALWAYS = 4;
    uint256 internal constant BPS = 1e4;
    uint256 internal constant YEAR = 365 days;

    // --- wiring -----------------------------------------------------------------------------------------------
    IMarketClock public immutable clock;
    IScorecardPrice public immutable scorecard;
    IDepthCert public immutable depthCert;
    IEligibility public immutable eligibility;
    IERC20 public immutable usdg;

    struct Position {
        uint256 collateral; // wrapper shares
        uint256 principal; // USDG
        uint256 accrued; // USDG interest accrued, unpaid
        uint64 lastAccrual;
    }

    struct Cure {
        bool active;
        bool lastOpen; // market open at the last witnessed tick (or at the flag)
        uint64 openedAt;
        uint64 lastTickAt;
        uint64 openSecondsUsed;
        uint128 priceAtBreach;
    }

    /// @dev One read of everything an asset's policy depends on. `open` implies `known`.
    struct Market {
        bool known;
        bool open;
        bool priced;
        uint256 price;
        uint256 depthShares;
        uint256 minBid;
    }

    address public admin;
    address public pendingAdmin;

    /// @notice Idle USDG available to lend (funded + repaid + realised - lent - defunded).
    uint256 public reserve;

    mapping(address => bool) public isAsset;
    address[] internal _assets;

    mapping(address => mapping(address => Position)) internal _positions;
    mapping(address => mapping(address => Cure)) internal _cures;

    mapping(address => uint256) public totalCollateral;
    mapping(address => uint256) public totalPrincipal;
    /// @notice Wrapper shares taken in liquidation and still held here.
    mapping(address => uint256) public seized;
    /// @notice Cumulative debt written off per asset, USDG.
    mapping(address => uint256) public badDebt;

    uint256 private _lock = 1;

    // --- events -----------------------------------------------------------------------------------------------
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event Funded(address indexed from, uint256 amount, uint256 reserveAfter);
    event Defunded(address indexed to, uint256 amount, uint256 reserveAfter);
    event Deposited(address indexed borrower, address indexed asset, uint256 shares, uint256 collateralAfter);
    event Withdrawn(address indexed borrower, address indexed asset, uint256 shares, uint256 collateralAfter);
    event Borrowed(address indexed borrower, address indexed asset, uint256 amount, uint256 debtAfter, uint256 ltvBps);
    event Repaid(address indexed borrower, address indexed asset, address indexed payer, uint256 amount, uint256 debtAfter);
    event Refusal(address indexed who, address indexed asset, bytes4 indexed reason, uint256 requested, uint256 allowed);
    event BreachOpened(
        address indexed borrower, address indexed asset, uint256 debt, uint256 limit, uint256 priceAtBreach, uint256 ltvBps
    );
    event CureTicked(address indexed borrower, address indexed asset, bool open, uint256 used, uint256 required);
    event BreachCured(address indexed borrower, address indexed asset, uint256 used);
    event Liquidated(
        address indexed borrower,
        address indexed asset,
        uint256 seized,
        uint256 cleared,
        uint256 badDebt,
        uint256 pFresh,
        uint256 pBreach
    );
    event Realised(uint256 indexed certId, uint256 shares, bool filled, uint256 usdgIn);
    event SeizedSwept(address indexed asset, address indexed to, uint256 shares);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev Plain storage-slot lock (no transient storage).
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IMarketClock clock_,
        IScorecardPrice scorecard_,
        IDepthCert depthCert_,
        IEligibility eligibility_,
        IERC20 usdg_,
        address admin_,
        address[] memory assets_
    ) {
        if (
            address(clock_) == address(0) || address(scorecard_) == address(0) || address(depthCert_) == address(0)
                || address(eligibility_) == address(0) || address(usdg_) == address(0) || admin_ == address(0)
        ) revert ZeroAddress();
        // A wrong address with no code would make every try/catch read below revert on decoding instead of
        // failing closed, so refuse it here.
        _requireCode(address(clock_));
        _requireCode(address(scorecard_));
        _requireCode(address(depthCert_));
        _requireCode(address(eligibility_));
        _requireCode(address(usdg_));
        uint8 d = usdg_.decimals();
        if (d != 6) revert BadDecimals(address(usdg_), d);

        clock = clock_;
        scorecard = scorecard_;
        depthCert = depthCert_;
        eligibility = eligibility_;
        usdg = usdg_;
        admin = admin_;

        for (uint256 i; i < assets_.length; ++i) {
            address a = assets_[i];
            if (a == address(0)) revert ZeroAddress();
            if (isAsset[a]) revert DuplicateAsset(a);
            (address pool,,,,) = scorecard_.priceSources(a);
            if (pool == address(0)) revert NoPriceSource(a);
            d = IERC20(a).decimals();
            if (d != 18) revert BadDecimals(a, d);
            isAsset[a] = true;
            _assets.push(a);
        }
    }

    // =========================================================================================================
    // admin
    // =========================================================================================================

    /// @notice Start handing admin rights to `to`. Takes effect only when `to` accepts.
    function transferAdmin(address to) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    /// @notice Complete a handover started by the current admin.
    function acceptAdmin() external nonReentrant {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // =========================================================================================================
    // reserve
    // =========================================================================================================

    /// @notice Add USDG to the lendable reserve. Anyone may fund; only the admin can take it back out.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        reserve += amount;
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount, reserve);
    }

    function defund(uint256 amount, address to) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > reserve) revert ReserveShort();
        reserve -= amount;
        usdg.safeTransfer(to, amount);
        emit Defunded(to, amount, reserve);
    }

    // =========================================================================================================
    // positions
    // =========================================================================================================

    /// @notice Post `shares` of `asset` as collateral. Reverts (rather than refuses) if the caller is not eligible.
    function deposit(address asset, uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (!isAsset[asset]) revert UnsupportedAsset();
        if (!_eligible(msg.sender)) revert Ineligible();

        Position storage p = _positions[msg.sender][asset];
        p.collateral += shares;
        totalCollateral[asset] += shares;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), shares);
        emit Deposited(msg.sender, asset, shares, p.collateral);

        _clearIfCured(msg.sender, asset);
    }

    /// @notice Take collateral back. Returns false and emits `Refusal` (changing nothing) if the position is in
    ///         cure, or has debt and the withdrawal would leave it over its limit, or its limit cannot be judged.
    /// @dev A debt-free position can always withdraw, whatever the market or the registry says.
    function withdraw(address asset, uint256 shares) external nonReentrant returns (bool) {
        if (shares == 0) revert ZeroAmount();
        address b = msg.sender;
        Position storage p = _positions[b][asset];
        uint256 coll = p.collateral;
        if (shares > coll) revert ExceedsCollateral(coll, shares);

        if (_cures[b][asset].active) return _refuse(b, asset, InCure.selector, shares, 0);

        uint256 debt = _debt(p);
        if (debt > 0) {
            Market memory m = _market(asset);
            if (!m.known) return _refuse(b, asset, MarketUnknown.selector, shares, 0);
            if (!m.priced) return _refuse(b, asset, PriceUnavailable.selector, shares, 0);
            uint256 ltv = _ltvEff(m, asset);
            if (debt > _limit(coll - shares, m, ltv)) {
                return _refuse(b, asset, WouldBreach.selector, shares, _maxWithdraw(coll, debt, m, ltv));
            }
        }

        p.collateral = coll - shares;
        totalCollateral[asset] -= shares;
        IERC20(asset).safeTransfer(b, shares);
        emit Withdrawn(b, asset, shares, coll - shares);
        return true;
    }

    /// @notice Borrow `amount` USDG against the caller's `asset` collateral. Returns false and emits `Refusal`
    ///         (changing nothing, not even accrued interest) on any policy refusal.
    function borrow(address asset, uint256 amount) external nonReentrant returns (bool) {
        if (amount == 0) revert ZeroAmount();
        address b = msg.sender;
        if (!_eligible(b)) return _refuse(b, asset, Ineligible.selector, amount, 0);
        if (!isAsset[asset]) return _refuse(b, asset, UnsupportedAsset.selector, amount, 0);
        if (_cures[b][asset].active) return _refuse(b, asset, InCure.selector, amount, 0);

        Market memory m = _market(asset);
        if (!m.known) return _refuse(b, asset, MarketUnknown.selector, amount, 0);
        if (!m.priced) return _refuse(b, asset, PriceUnavailable.selector, amount, 0);
        if (m.depthShares == 0) return _refuse(b, asset, NoDepth.selector, amount, 0);

        Position storage p = _positions[b][asset];
        uint256 debt = _debt(p);
        uint256 ltv = _ltvEff(m, asset);
        {
            uint256 limit = _limit(p.collateral, m, ltv);
            if (debt + amount > limit) {
                return _refuse(b, asset, ExceedsLtv.selector, amount, limit > debt ? limit - debt : 0);
            }
        }
        {
            // Aggregate depth coverage: everything lent against this asset must be payable by the honoured bids.
            uint256 real = _realisable(asset, m);
            uint256 tp = totalPrincipal[asset];
            if (tp + amount > real) {
                return _refuse(b, asset, ExceedsDepth.selector, amount, real > tp ? real - tp : 0);
            }
        }
        if (amount > reserve) return _refuse(b, asset, ReserveShort.selector, amount, reserve);

        _accrue(p);
        p.principal += amount;
        totalPrincipal[asset] += amount;
        reserve -= amount;
        usdg.safeTransfer(b, amount);
        emit Borrowed(b, asset, amount, debt + amount, ltv);
        return true;
    }

    /// @notice Repay up to `amount` of `borrower`'s debt on `asset`. Anyone may repay. Accrued interest is paid
    ///         first. Pulls only what is owed.
    function repay(address borrower, address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage p = _positions[borrower][asset];
        _accrue(p);
        uint256 debt = p.principal + p.accrued;
        uint256 pay = _min(amount, debt);
        if (pay == 0) revert ZeroAmount();

        uint256 fromAccrued = _min(pay, p.accrued);
        uint256 fromPrincipal = pay - fromAccrued;
        p.accrued -= fromAccrued;
        p.principal -= fromPrincipal;
        totalPrincipal[asset] -= fromPrincipal;
        reserve += pay;
        usdg.safeTransferFrom(msg.sender, address(this), pay);
        emit Repaid(borrower, asset, msg.sender, pay, debt - pay);

        _clearIfCured(borrower, asset);
    }

    // =========================================================================================================
    // breach, cure, liquidation (all permissionless)
    // =========================================================================================================

    /// @notice Open a cure on a position that is KNOWN to be over its limit. A stale clock or an unreadable
    ///         price cannot create a breach.
    function flagBreach(address borrower, address asset) external nonReentrant {
        Cure storage c = _cures[borrower][asset];
        if (c.active) revert AlreadyInCure();
        if (!isAsset[asset]) revert UnsupportedAsset();

        Position storage p = _positions[borrower][asset];
        uint256 debt = _debt(p);
        if (debt == 0) revert NotBreached();
        Market memory m = _market(asset);
        if (!m.known) revert MarketUnknown();
        if (!m.priced) revert PriceUnavailable();
        uint256 ltv = _ltvEff(m, asset);
        uint256 limit = _limit(p.collateral, m, ltv);
        if (debt <= limit) revert NotBreached();

        c.active = true;
        c.lastOpen = m.open;
        c.openedAt = uint64(block.timestamp);
        c.lastTickAt = uint64(block.timestamp);
        c.openSecondsUsed = 0;
        c.priceAtBreach = uint128(m.price);
        emit BreachOpened(borrower, asset, debt, limit, m.price, ltv);
    }

    /// @notice Advance the cure clock. Counts the gap since the last tick only if the market was open then, is
    ///         open now, and the gap is at most MAX_TICK_GAP. Clears the cure if the position is known healthy.
    function tick(address borrower, address asset) external nonReentrant {
        Cure storage c = _cures[borrower][asset];
        if (!c.active) revert NoCure();

        bool open = _isOpen(asset);
        uint256 gap = block.timestamp - c.lastTickAt;
        if (c.lastOpen && open && gap <= MAX_TICK_GAP) c.openSecondsUsed += uint64(gap);
        c.lastOpen = open;
        c.lastTickAt = uint64(block.timestamp);
        emit CureTicked(borrower, asset, open, c.openSecondsUsed, CURE_OPEN_SECONDS);

        _clearIfCured(borrower, asset);
    }

    /// @notice Seize collateral from a position whose cure has run out of witnessed open-market time.
    /// @dev seize   = min(coll, sharesForUp(debt, P_fresh), sharesFor(debt * 1.05, P_breach))
    ///      cleared = min(debt, valueUsdg(seize, P_fresh))
    ///      - seize == coll: every share is gone, so whatever `cleared` does not cover is written off as bad debt
    ///        and the debt closes.
    ///      - seize <  coll: NOTHING is written off. The debt falls by `cleared` (accrued interest first) and the
    ///        remainder stays owed against the collateral the borrower keeps; the cure ends, so a position still
    ///        over its limit can be re-flagged at the current price. (A write-off here would hand the borrower a
    ///        free put through every close-to-open gap: the breach-price cap binds, the lender eats the
    ///        difference, and the borrower withdraws the rest.)
    ///      The fresh leg rounds up (by at most one share-wei) so that when it binds the debt clears exactly.
    ///      Never more than a 5%-bonus liquidation at the breach-time price, and never while shut.
    function liquidate(address borrower, address asset) external nonReentrant {
        Cure memory c = _cures[borrower][asset];
        if (!c.active) revert NoCure();
        if (c.openSecondsUsed < CURE_OPEN_SECONDS) revert CureIncomplete(c.openSecondsUsed, CURE_OPEN_SECONDS);

        Market memory m = _market(asset);
        if (!m.known) revert MarketUnknown();
        if (!m.open) revert MarketShut();
        if (!m.priced) revert PriceUnavailable();

        Position storage p = _positions[borrower][asset];
        _accrue(p);
        uint256 debt = p.principal + p.accrued;
        uint256 coll = p.collateral;
        if (debt <= _limit(coll, m, _ltvEff(m, asset))) revert NotBreached();

        uint256 seize = _seizeFor(coll, debt, m.price, c.priceAtBreach);
        uint256 cleared = _min(debt, MulDiv.mulDiv(seize, m.price, 1e30));
        uint256 bad = _writeDown(p, asset, cleared, seize == coll);

        p.collateral = coll - seize;
        totalCollateral[asset] -= seize;
        seized[asset] += seize;
        badDebt[asset] += bad;
        delete _cures[borrower][asset];

        emit Liquidated(borrower, asset, seize, cleared, bad, m.price, c.priceAtBreach);
    }

    // =========================================================================================================
    // seized shares (admin)
    // =========================================================================================================

    /// @notice Sell `shares` of seized collateral into DepthCert `certId`, which must name this contract as its
    ///         beneficiary. A fill adds the USDG to the reserve; a fade returns the shares to `seized` and adds the
    ///         slashed bond to the reserve.
    function realise(uint256 certId, uint256 shares) external onlyAdmin nonReentrant {
        if (shares == 0) revert ZeroAmount();
        IDepthCert.Cert memory cert = depthCert.certOf(certId);
        if (cert.beneficiary != address(this)) revert NotOurCert(certId);
        address asset = cert.wrapper;
        uint256 have = seized[asset];
        if (shares > have || shares > type(uint128).max) revert ExceedsSeized(have, shares);

        seized[asset] = have - shares;
        IERC20 w = IERC20(asset);
        uint256 sharesBefore = w.balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));

        _approve(w, address(depthCert), shares);
        (bool filled,) = depthCert.take(certId, uint128(shares), address(this));
        _approve(w, address(depthCert), 0);

        // Measure rather than trust: whatever did not leave (a fade returns it all) goes back to `seized`.
        uint256 sharesAfter = w.balanceOf(address(this));
        uint256 sharesOut = sharesBefore > sharesAfter ? sharesBefore - sharesAfter : 0;
        if (sharesOut < shares) seized[asset] += shares - sharesOut;
        uint256 usdgAfter = usdg.balanceOf(address(this));
        uint256 usdgIn = usdgAfter > usdgBefore ? usdgAfter - usdgBefore : 0;
        reserve += usdgIn;

        emit Realised(certId, shares, filled, usdgIn);
    }

    /// @notice Move seized shares out (e.g. to sell elsewhere). Never touches borrowers' collateral.
    function sweepSeized(address asset, uint256 shares, address to) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        uint256 have = seized[asset];
        if (shares > have) revert ExceedsSeized(have, shares);
        seized[asset] = have - shares;
        IERC20(asset).safeTransfer(to, shares);
        emit SeizedSwept(asset, to, shares);
    }

    // =========================================================================================================
    // views
    // =========================================================================================================

    /// @notice The published per-position loan-to-value for `asset`, in bps: min(regimeCap, minBid / P). 0 when
    ///         the clock is UNKNOWN, there is no honoured depth (see `minCertExpiry`), or the price is unreadable.
    function ltvFor(address asset) external view returns (uint256) {
        if (!isAsset[asset]) return 0;
        return _ltv(_market(asset));
    }

    /// @notice The ratio positions are judged by: ltvFor * min(1, notional(dS, minBid) / totalPrincipal).
    function ltvEffective(address asset) external view returns (uint256) {
        if (!isAsset[asset]) return 0;
        return _ltvEff(_market(asset), asset);
    }

    /// @notice USDG the honoured bids would pay for the pool's collateral, after the seized shares they must absorb
    ///         first: notional(min(totalCollateral, dS - seized), minBid). Every successful borrow leaves
    ///         totalPrincipal <= realisable.
    function realisable(address asset) external view returns (uint256) {
        if (!isAsset[asset]) return 0;
        return _realisable(asset, _market(asset));
    }

    /// @notice The earliest cert expiry that counts as honoured depth right now (see the contract NatSpec).
    function minCertExpiry(address asset) external view returns (uint64) {
        return _minExpiry(asset, _isOpen(asset));
    }

    function debtOf(address borrower, address asset) external view returns (uint256) {
        return _debt(_positions[borrower][asset]);
    }

    /// @notice valueUsdg(collateral, P) * ltvFor / 1e4; 0 if the price is unreadable.
    function limitOf(address borrower, address asset) external view returns (uint256) {
        if (!isAsset[asset]) return 0;
        Market memory m = _market(asset);
        if (!m.priced) return 0;
        return _limit(_positions[borrower][asset].collateral, m, _ltvEff(m, asset));
    }

    /// @notice (known, breached). Debt-free is always (true, false); otherwise unknown while the clock is
    ///         UNKNOWN or the price unreadable, and breached iff debt > limit.
    function isBreached(address borrower, address asset) public view returns (bool known, bool breached) {
        Position storage p = _positions[borrower][asset];
        uint256 debt = _debt(p);
        if (debt == 0) return (true, false);
        if (!isAsset[asset]) return (false, false);
        Market memory m = _market(asset);
        if (!m.known || !m.priced) return (false, false);
        return (true, debt > _limit(p.collateral, m, _ltvEff(m, asset)));
    }

    function cureOf(address borrower, address asset) external view returns (Cure memory) {
        return _cures[borrower][asset];
    }

    function positionOf(address borrower, address asset) external view returns (Position memory) {
        return _positions[borrower][asset];
    }

    /// @notice True iff the clock is attested fresh and primary capacity is non-zero.
    function isOpen(address asset) external view returns (bool) {
        return _isOpen(asset);
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    // =========================================================================================================
    // internals
    // =========================================================================================================

    function _refuse(address who, address asset, bytes4 reason, uint256 requested, uint256 allowed)
        internal
        returns (bool)
    {
        emit Refusal(who, asset, reason, requested, allowed);
        return false;
    }

    function _clearIfCured(address borrower, address asset) internal {
        Cure storage c = _cures[borrower][asset];
        if (!c.active) return;
        (bool known, bool breached) = isBreached(borrower, asset);
        if (known && !breached) {
            uint256 used = c.openSecondsUsed;
            delete _cures[borrower][asset];
            emit BreachCured(borrower, asset, used);
        }
    }

    function _accrue(Position storage p) internal {
        uint256 principal = p.principal;
        if (principal > 0 && block.timestamp > p.lastAccrual) {
            p.accrued += MulDiv.mulDiv(principal, APR_BPS * (block.timestamp - p.lastAccrual), YEAR * BPS);
        }
        p.lastAccrual = uint64(block.timestamp);
    }

    function _debt(Position storage p) internal view returns (uint256) {
        uint256 principal = p.principal;
        uint256 d = principal + p.accrued;
        if (principal > 0 && block.timestamp > p.lastAccrual) {
            d += MulDiv.mulDiv(principal, APR_BPS * (block.timestamp - p.lastAccrual), YEAR * BPS);
        }
        return d;
    }

    function _market(address asset) internal view returns (Market memory m) {
        IMarketClock.Regime r;
        try clock.regime(asset) returns (IMarketClock.Regime r_) {
            r = r_;
        } catch {
            _notStarved();
        }
        m.known = r != IMarketClock.Regime.UNKNOWN;
        if (m.known) m.open = _cap(asset) > 0;
        try scorecard.priceNow(asset) returns (uint128 px) {
            if (px > 0) {
                m.priced = true;
                m.price = px;
            }
        } catch {
            _notStarved();
        }
        (m.depthShares, m.minBid) = _depth(asset, _minExpiry(asset, m.open));
    }

    /// @dev See the contract NatSpec, WHICH CERTS COUNT.
    function _minExpiry(address asset, bool open) internal view returns (uint64) {
        (bool ok, uint256 toNext) = _toNext(asset);
        uint256 life;
        if (open) {
            if (!ok) {
                life = SHUT_CERT_LIFE; // cannot tell whether a close is imminent: assume it is
            } else if (toNext < MIN_CERT_LIFE + CURE_OPEN_SECONDS && _closesAtTransitions(asset)) {
                life = toNext + SHUT_CERT_LIFE; // toNext == 0: a transition is due or unpublished -- a close, maybe
            } else {
                life = MIN_CERT_LIFE;
            }
        } else {
            life = SHUT_CERT_LIFE;
            if (ok && toNext + MIN_CERT_LIFE > life) life = toNext + MIN_CERT_LIFE;
        }
        return uint64(block.timestamp + life + CURE_OPEN_SECONDS);
    }

    function _toNext(address asset) internal view returns (bool ok, uint256 secs) {
        try clock.secondsToNextTransition(asset) returns (uint256 s) {
            return (true, s < MAX_TRANSITION_HORIZON ? s : MAX_TRANSITION_HORIZON);
        } catch {
            _notStarved();
            return (false, 0);
        }
    }

    /// @dev False only for hours modes whose transitions are period changes with capacity on both sides
    ///      (1 TwentyFourFive, 4 Always). Reads MarketClock's `assets(a)` getter defensively: a revert, short or
    ///      malformed return data, or mode 0 (unknown) all count as closing.
    function _closesAtTransitions(address asset) internal view returns (bool) {
        (bool ok, bytes memory ret) = address(clock).staticcall(abi.encodeWithSelector(IClockAssets.assets.selector, asset));
        if (!ok) {
            _notStarved();
            return true;
        }
        if (ret.length < 128) return true;
        (,, uint256 hoursMode,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        return !(hoursMode == HOURS_TWENTY_FOUR_FIVE || hoursMode == HOURS_ALWAYS);
    }

    function _isOpen(address asset) internal view returns (bool) {
        try clock.regime(asset) returns (IMarketClock.Regime r) {
            if (r == IMarketClock.Regime.UNKNOWN) return false;
        } catch {
            _notStarved();
            return false;
        }
        return _cap(asset) > 0;
    }

    function _cap(address asset) internal view returns (uint128) {
        try clock.primaryCapNow(asset) returns (uint128 c) {
            return c;
        } catch {
            _notStarved();
            return 0;
        }
    }

    /// @dev Honoured depth naming this contract, counting only certs with expiry >= `minExpiry`. A DepthCert that
    ///      genuinely reverts reads as no depth; one starved of gas reverts the whole call (see `_notStarved`).
    function _depth(address asset, uint64 minExpiry) internal view returns (uint256 shares, uint256 minBid) {
        try depthCert.honouredDepth(asset, address(this), minExpiry) returns (uint256 s, uint256, uint128 px, uint64) {
            if (s > 0 && px > 0) return (s, px);
        } catch {
            _notStarved();
        }
        return (0, 0);
    }

    /// @dev A catch taken with under GAS_FLOOR left may be an out-of-gas callee, not a real answer: fail closed.
    function _notStarved() internal view {
        if (gasleft() < GAS_FLOOR) revert InsufficientGas();
    }

    /// @dev Per-position ratio: min(regimeCap, minBid * 1e12 * 1e4 / P). Independent of every position.
    function _ltv(Market memory m) internal pure returns (uint256) {
        if (!m.known || !m.priced || m.depthShares == 0 || m.minBid == 0) return 0;
        uint256 cap = m.open ? LTV_OPEN_BPS : LTV_SHUT_BPS;
        return _min(cap, MulDiv.mulDiv(m.minBid * 1e12, BPS, m.price));
    }

    /// @dev ltv * min(1, notional(dS, minBid) / totalPrincipal): once depth leaves and the book no longer pays for
    ///      everything lent, every limit shrinks pro rata. Idle collateral enters neither term.
    function _ltvEff(Market memory m, address asset) internal view returns (uint256 ltv) {
        ltv = _ltv(m);
        uint256 tp = totalPrincipal[asset];
        if (ltv == 0 || tp == 0) return ltv;
        uint256 cover = MulDiv.mulDiv(m.depthShares, m.minBid, 1e18);
        if (cover < tp) ltv = MulDiv.mulDiv(ltv, cover, tp);
    }

    /// @dev Borrow-time aggregate: the book net of the seized shares that will be sold into it first.
    function _realisable(address asset, Market memory m) internal view returns (uint256) {
        uint256 held = seized[asset];
        uint256 avail = m.depthShares > held ? m.depthShares - held : 0;
        return MulDiv.mulDiv(_min(totalCollateral[asset], avail), m.minBid, 1e18);
    }

    /// @dev min(coll, sharesForUp(debt, pFresh), sharesFor(debt * 1.05, pBreach)).
    function _seizeFor(uint256 coll, uint256 debt, uint256 pFresh, uint256 pBreach) internal pure returns (uint256) {
        uint256 fresh = MulDiv.mulDiv(debt, 1e30, pFresh);
        if (mulmod(debt, 1e30, pFresh) != 0) ++fresh;
        uint256 stale = MulDiv.mulDiv(MulDiv.mulDiv(debt, BPS + STALE_BONUS_BPS, BPS), 1e30, pBreach);
        return _min(coll, _min(fresh, stale));
    }

    /// @dev Takes `cleared` off the debt (accrued first). If `all` collateral went, the rest is written off and
    ///      returned as bad debt; otherwise the rest stays owed and nothing is written off.
    function _writeDown(Position storage p, address asset, uint256 cleared, bool all) internal returns (uint256 bad) {
        uint256 principal = p.principal;
        uint256 accrued = p.accrued;
        if (all) {
            bad = principal + accrued - cleared;
            totalPrincipal[asset] -= principal;
            p.principal = 0;
            p.accrued = 0;
        } else {
            uint256 fromAccrued = _min(cleared, accrued);
            uint256 fromPrincipal = cleared - fromAccrued;
            p.accrued = accrued - fromAccrued;
            p.principal = principal - fromPrincipal;
            totalPrincipal[asset] -= fromPrincipal;
        }
    }

    function _limit(uint256 coll, Market memory m, uint256 ltv) internal pure returns (uint256) {
        if (!m.priced || ltv == 0) return 0;
        return MulDiv.mulDiv(MulDiv.mulDiv(coll, m.price, 1e30), ltv, BPS);
    }

    /// @dev Informational `allowed` for a WouldBreach refusal: the collateral that could leave while keeping debt
    ///      within the limit (rounded in the lender's favour).
    function _maxWithdraw(uint256 coll, uint256 debt, Market memory m, uint256 ltv) internal pure returns (uint256) {
        if (ltv == 0) return 0;
        uint256 needValue = MulDiv.mulDiv(debt, BPS, ltv) + 1;
        uint256 needColl = MulDiv.mulDiv(needValue, 1e30, m.price) + 1;
        return coll > needColl ? coll - needColl : 0;
    }

    function _eligible(address who) internal view returns (bool) {
        try eligibility.isEligible(who) returns (bool ok) {
            return ok;
        } catch {
            _notStarved();
            return false;
        }
    }

    function _approve(IERC20 token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) != 1))) revert ApproveFailed();
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert NoCode(target);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
