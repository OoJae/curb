// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Scorecard, IUniV3Pool} from "../src/Scorecard.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";

/// Only the one function Scorecard actually calls on the clock.
contract ClockStub {
    mapping(address => uint128) public cap;
    function setCap(address w, uint128 c) external { cap[w] = c; }
    function primaryCapNow(address w) external view returns (uint128) { return cap[w]; }
}

contract TokenStub {
    uint8 public decimals;
    constructor(uint8 d) { decimals = d; }
}

/// A Uniswap V3-shaped pool whose spot and time-weighted price can be driven independently,
/// which is the only way to test the manipulation guard.
contract PoolStub {
    address public token0;
    address public token1;
    uint160 public sqrtPriceX96;
    int24 public spotTick;
    int24 public twapTick;
    bool public oracleBroken;
    uint16 public cardinality = 32;
    uint128 public liquidity = 1e18;

    constructor(address t0, address t1) { token0 = t0; token1 = t1; }

    function setOracleDepth(uint16 c) external { cardinality = c; }
    function setLiquidity(uint128 l) external { liquidity = l; }

    function set(uint160 sqrtP, int24 spot, int24 twap) external {
        sqrtPriceX96 = sqrtP; spotTick = spot; twapTick = twap;
    }
    function breakOracle(bool b) external { oracleBroken = b; }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, spotTick, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory spl)
    {
        require(!oracleBroken, "OLD");
        tickCumulatives = new int56[](2);
        spl = new uint160[](2);
        // A cumulative whose difference over the window averages exactly twapTick.
        tickCumulatives[0] = int56(0);
        tickCumulatives[1] = -int56(twapTick) * int56(uint56(secondsAgos[1]));
    }
}

contract ScorecardTest is Test {
    /// Shorter than SETTLE_DELAY, so the guard's averaged window lies entirely after the reopen.
    uint32 constant TWAP_W = 120;

    // The live wTCENTx/USDG pool's real state, so the price maths is pinned to something observed:
    // sqrtPriceX96 read from chain 196 on 21 Sep 2026, tick -236,323, 18-decimal wrapper vs 6-decimal USDG.
    uint160 constant SQRT_REAL = 585417536637190936853387;
    int24 constant TICK_REAL = -236323;
    uint128 constant PRICE_REAL = 54597441088191159066; // $54.5974, computed independently
    // The same $54.5974, expressed by a pool that lists the stable as token0.
    uint160 constant SQRT_INVERTED = 10722439463315307592378999951434176;

    Scorecard sc;
    ClockStub clock;
    PoolStub pool;
    address wrapper;
    address stable;
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");
    address admin = address(this);

    function setUp() public {
        wrapper = address(new TokenStub(18));
        stable = address(new TokenStub(6));
        clock = new ClockStub();
        sc = new Scorecard(IMarketClock(address(clock)), admin);
        sc.setKeeper(keeper, true);
        pool = new PoolStub(wrapper, stable);
        pool.set(SQRT_REAL, TICK_REAL, TICK_REAL);
        sc.setPriceSource(wrapper, address(pool), true, TWAP_W);
        clock.setCap(wrapper, 0); // shut, so a mark may be committed
    }

    function _c(uint128 mark, uint64 settleAfter, bytes32 root) internal view returns (Scorecard.Commitment memory) {
        return Scorecard.Commitment({
            wrapper: wrapper,
            committedAt: 0,      // set by the contract
            committedBlock: 0,   // set by the contract
            settleAfter: settleAfter,
            mark: mark,
            bandBps: 50,
            inputRoot: root,
            methodDigest: keccak256("curb.scorecard.mark/1"),
            lastPrint: 54e18,
            closingVwap: 54.5e18,
            staleOracle: 0
        });
    }

    function _commit(uint128 mark) internal returns (bytes32 id, uint64 settleAfter) {
        settleAfter = uint64(block.timestamp + 3600);
        vm.prank(keeper);
        id = sc.commit(_c(mark, settleAfter, bytes32("r1")));
    }

    function _reopenAndWarp(uint64 settleAfter) internal {
        clock.setCap(wrapper, 100_000);                       // the issuer reopened
        vm.warp(settleAfter + sc.SETTLE_DELAY());
        vm.roll(block.number + 500);
    }

    // --- the anti-backfill property -------------------------------------------------------

    function test_commit_block_precedes_settle_block() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        _reopenAndWarp(sa);
        sc.settle(id);
        (,, uint64 committedBlock,,,,,,,,) = sc.commitments(id);
        (, uint64 settledBlock,,,,,,,) = sc.settlements(id);
        assertGt(settledBlock, committedBlock);
    }

    // --- the v2 property: the settler chooses the moment, never the number -----------------

    function test_settle_takes_no_price_and_reads_the_pool_itself() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        _reopenAndWarp(sa);
        vm.prank(stranger);                                    // permissionless, still
        sc.settle(id);
        (,, uint128 reopenPrint,,,,, uint8 source, bool settled) = sc.settlements(id);
        assertTrue(settled);
        assertEq(reopenPrint, PRICE_REAL, "the price is the pool's, not the caller's");
        assertEq(source, 1);
    }

    function test_a_manipulated_spot_cannot_settle_a_row() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        _reopenAndWarp(sa);
        // Spot shoved 200 ticks (~2%) away from the 5-minute average: refused outright.
        pool.set(SQRT_REAL, TICK_REAL + 200, TICK_REAL);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.PriceDeviates.selector, TICK_REAL + 200, TICK_REAL));
        sc.settle(id);
        // Back inside the tolerance, it settles.
        pool.set(SQRT_REAL, TICK_REAL + 40, TICK_REAL);
        sc.settle(id);
        (,,,,,,,, bool settled) = sc.settlements(id);
        assertTrue(settled);
    }

    function test_cannot_settle_until_the_primary_market_has_reopened() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        vm.warp(sa + sc.SETTLE_DELAY());
        vm.expectRevert(abi.encodeWithSelector(Scorecard.MarketStillShut.selector, wrapper));
        sc.settle(id);                                         // cap is still 0
    }

    function test_settlement_window_opens_late_and_closes() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        clock.setCap(wrapper, 100_000);
        vm.warp(sa + 1);                                       // reopened, but the print has not formed
        vm.expectRevert(abi.encodeWithSelector(Scorecard.TooEarly.selector, id, sa + sc.SETTLE_DELAY()));
        sc.settle(id);
        vm.warp(uint256(sa) + sc.SETTLE_DELAY() + sc.SETTLE_WINDOW() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(Scorecard.TooLate.selector, id, sa + sc.SETTLE_DELAY() + sc.SETTLE_WINDOW())
        );
        sc.settle(id);
    }

    function test_a_broken_oracle_refuses_rather_than_guessing() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        _reopenAndWarp(sa);
        pool.breakOracle(true);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.PriceUnreadable.selector, address(pool)));
        sc.settle(id);
    }

    // --- price sources ---------------------------------------------------------------------

    function test_price_source_is_write_once() public {
        PoolStub other = new PoolStub(wrapper, stable);
        other.set(SQRT_REAL, TICK_REAL, TICK_REAL);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.PriceSourceLocked.selector, wrapper));
        sc.setPriceSource(wrapper, address(other), true, TWAP_W);
    }

    function test_price_source_must_actually_hold_the_wrapper() public {
        address otherWrapper = address(new TokenStub(18));
        vm.expectRevert(abi.encodeWithSelector(Scorecard.PoolMismatch.selector, otherWrapper, address(pool)));
        sc.setPriceSource(otherWrapper, address(pool), true, TWAP_W);
    }

    function test_price_source_must_already_serve_the_twap() public {
        address w2 = address(new TokenStub(18));
        PoolStub p2 = new PoolStub(w2, stable);
        p2.breakOracle(true);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.PriceUnreadable.selector, address(p2)));
        sc.setPriceSource(w2, address(p2), true, TWAP_W);
    }

    function test_cannot_commit_a_mark_that_could_never_be_settled() public {
        address w2 = address(new TokenStub(18));
        clock.setCap(w2, 0);
        Scorecard.Commitment memory c = _c(55e18, uint64(block.timestamp + 3600), bytes32("r2"));
        c.wrapper = w2;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.NoPriceSource.selector, w2));
        sc.commit(c);
    }

    function test_the_price_matches_an_independent_calculation() public view {
        // $54.5974 per wTCENTx, from the live pool's own sqrtPriceX96 on 21 Sep 2026.
        assertEq(sc.priceNow(wrapper), PRICE_REAL);
    }

    function test_price_handles_the_stable_being_token0() public {
        // Three of the five live pools list the stable first, and getting the side backwards
        // silently prices the wrong leg. The SAME economic price -- $54.5974 -- expressed with the
        // stable as token0 has a different sqrtPriceX96, and must come back out the same.
        address w2 = address(new TokenStub(18));
        PoolStub p2 = new PoolStub(stable, w2);
        p2.set(SQRT_INVERTED, TICK_REAL, TICK_REAL);
        sc.setPriceSource(w2, address(p2), false, TWAP_W);
        assertApproxEqRel(uint256(sc.priceNow(w2)), uint256(PRICE_REAL), 0.0001e18);
    }

    // --- grading ---------------------------------------------------------------------------

    function test_errors_against_all_three_baselines() public {
        uint64 sa = uint64(block.timestamp + 3600);
        vm.prank(keeper);
        Scorecard.Commitment memory c = _c(54.6e18, sa, bytes32("r3"));
        c.staleOracle = 52e18;
        bytes32 id = sc.commit(c);
        _reopenAndWarp(sa);
        sc.settle(id);

        (,,, uint32 curbE, uint32 lastE, uint32 vwapE, uint32 staleE,,) = sc.settlements(id);
        // reopen print is 54.5974e18: mark 54.6 is ~0.5bp out, last print 54.0 is ~109bp,
        // closing vwap 54.5 is ~18bp, stale oracle 52.0 is ~475bp.
        assertLt(curbE, lastE);
        assertLt(curbE, vwapE);
        assertLt(curbE, staleE);
        (uint256 settled, uint256 beatLast, uint256 beatVwap) = sc.skill();
        assertEq(settled, 1);
        assertEq(beatLast, 1);
        assertEq(beatVwap, 1);
    }

    function test_a_bad_mark_is_recorded_as_a_loss() public {
        (bytes32 id, uint64 sa) = _commit(40e18);              // badly wrong
        _reopenAndWarp(sa);
        sc.settle(id);
        (,,, uint32 curbE, uint32 lastE,,,,) = sc.settlements(id);
        assertGt(curbE, lastE);
        (, uint256 beatLast,) = sc.skill();
        assertEq(beatLast, 0, "a scorecard that only counts wins is marketing, not evidence");
    }

    function test_no_double_settle_and_no_revision_path() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        _reopenAndWarp(sa);
        sc.settle(id);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.AlreadySettled.selector, id));
        sc.settle(id);
    }

    // --- access and bookkeeping --------------------------------------------------------------

    function test_cannot_commit_while_primary_market_has_capacity() public {
        clock.setCap(wrapper, 20_000_000);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.MarketStillOpen.selector, wrapper));
        sc.commit(_c(55e18, uint64(block.timestamp + 3600), bytes32("r4")));
    }

    function test_duplicate_commit_rejected() public {
        (bytes32 id, uint64 sa) = _commit(55e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.ClosureExists.selector, id));
        sc.commit(_c(56e18, sa, bytes32("r1")));
    }

    function test_only_keeper_commits() public {
        vm.prank(stranger);
        vm.expectRevert(Scorecard.NotKeeper.selector);
        sc.commit(_c(55e18, uint64(block.timestamp + 3600), bytes32("r5")));
    }

    function test_unknown_closure_cannot_be_settled() public {
        vm.expectRevert(abi.encodeWithSelector(Scorecard.UnknownClosure.selector, bytes32("nope")));
        sc.settle(bytes32("nope"));
    }

    function testFuzz_grades_any_pool_price(uint160 sqrtP) public {
        // Any price the pool can express still produces a graded row rather than a stuck one.
        sqrtP = uint160(bound(uint256(sqrtP), 1e15, 1e30));
        (bytes32 id, uint64 sa) = _commit(55e18);
        _reopenAndWarp(sa);
        pool.set(sqrtP, TICK_REAL, TICK_REAL);
        try sc.settle(id) {
            (,,,,,,,, bool settled) = sc.settlements(id);
            assertTrue(settled);
        } catch (bytes memory err) {
            // The only acceptable refusal is an unreadable price, never a silent wrong grade.
            assertEq(bytes4(err), Scorecard.PriceUnreadable.selector);
        }
    }

    // --- registration refuses a source the guard could not actually police -------------------

    function test_setPriceSource_rejects_a_shallow_oracle() public {
        PoolStub p = new PoolStub(address(new TokenStub(18)), address(new TokenStub(6)));
        address w = PoolStub(p).token0();
        // A cardinality-1 pool answers observe() happily -- with spot. Measured on X Layer mainnet:
        // wSHEINx's only live pool is exactly this, and registering it would make the guard compare
        // spot against itself forever.
        p.setOracleDepth(1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.OracleTooShallow.selector, address(p), uint16(1)));
        sc.setPriceSource(w, address(p), true, TWAP_W);
    }

    function test_setPriceSource_rejects_an_empty_pool() public {
        PoolStub p = new PoolStub(address(new TokenStub(18)), address(new TokenStub(6)));
        address w = PoolStub(p).token0();
        p.setLiquidity(0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.PoolEmpty.selector, address(p)));
        sc.setPriceSource(w, address(p), true, TWAP_W);
    }

    function test_setPriceSource_rejects_a_window_that_would_span_the_reopen() public {
        PoolStub p = new PoolStub(address(new TokenStub(18)), address(new TokenStub(6)));
        address w = PoolStub(p).token0();
        // At SETTLE_DELAY the averaged window reaches back to the reopen instant itself; any longer
        // and a real gap reads as manipulation, so the rows with the biggest gaps -- the ones the
        // whole record exists to show -- would be the ones that could never settle.
        // Read the constant BEFORE the cheatcodes: a staticcall between prank/expectRevert and the
        // call under test consumes them.
        uint32 delay = sc.SETTLE_DELAY();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.BadTwapWindow.selector, delay));
        sc.setPriceSource(w, address(p), true, delay);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Scorecard.BadTwapWindow.selector, uint32(0)));
        sc.setPriceSource(w, address(p), true, 0);
    }

    function test_a_large_reopen_gap_still_settles() public {
        // The reason the window is fenced: at settlement the pool has gapped 4% from the closure
        // price, but spot and the post-reopen average agree, so the row grades instead of reverting.
        // Mark the asset ~4% below where it reopens.
        (bytes32 id, uint64 sa) = _commit(52e18);
        _reopenAndWarp(sa);
        // Spot and the post-reopen average agree with each other; only the CLOSURE price is far away.
        sc.settle(id);
        (,, uint128 reopenPrint,,,,,, bool settled) = sc.settlements(id);
        assertTrue(settled, "a gapped reopen must still be gradeable");
        assertEq(reopenPrint, PRICE_REAL);
    }
}
