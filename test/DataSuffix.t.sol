// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {MarketClock} from "../src/MarketClock.sol";
import {Scorecard} from "../src/Scorecard.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {ClockStub, TokenStub, PoolStub} from "./Scorecard.t.sol";

/// A raw xStock whose corporate-action nonce can be moved, so attest() reads a real nonce and a moved
/// one opens a real blackout. (A raw with no code would revert every attestBatch; see main.ts readCohort.)
contract RawStub {
    uint256 public nonce;
    function bump() external { ++nonce; }
    function getCurrentMultiplier() external view returns (uint256, uint256, uint256) {
        return (1e18, 0, nonce);
    }
}

/// ERC-8021 attribution, 24 Sep 2026: with DATA_SUFFIX set, every transaction Curb sends carries the X Layer
/// Builder Code AFTER its ABI-encoded arguments. Solidity's decoder reads the arguments and ignores what
/// follows, so both contracts must behave exactly as they do without it -- same state, same events, same
/// closure id, same refusals. These tests prove it for the three calls Curb sends (attestBatch, commit,
/// settle) by driving two identically built worlds in lockstep, one plain and one tagged, and comparing
/// the raw bytes of every view that the calls write to. No fork: this is about the ABI, not the chain.
contract DataSuffixTest is Test {
    /// Builder Code dd7u50nckt5e729f, ERC-8021 schema 0: utf8(code) ++ 0x10 (length) ++ 0x00 (schema) ++ marker.
    bytes constant SUFFIX = hex"6464377535306e636b74356537323966100080218021802180218021802180218021";
    bytes16 constant MARKER = hex"80218021802180218021802180218021";

    // The same live wTCENTx/USDG pool state test/Scorecard.t.sol pins its price maths to.
    uint32 constant TWAP_W = 120;
    uint160 constant SQRT_REAL = 585417536637190936853387;
    int24 constant TICK_REAL = -236323;
    uint128 constant PRICE_REAL = 54597441088191159066;

    // MarketClock, built as the unit and fork tests build it: one attestor, assets registered by the admin.
    MarketClock plainClock;
    MarketClock taggedClock;
    RawStub rawHk;
    RawStub rawUs;
    address attestor = makeAddr("attestor");
    address wHk = makeAddr("wTCENTx");
    address wUs = makeAddr("wAAPLx");

    // Scorecard, built exactly as test/Scorecard.t.sol builds it. Both scorecards read one clock stub and
    // one pool (they only ever read them), so a single setCap or pool move reaches both worlds at once.
    Scorecard plainSc;
    Scorecard taggedSc;
    ClockStub stub;
    PoolStub pool;
    address wrapper;
    address stable;
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");

    function setUp() public {
        rawHk = new RawStub();
        rawUs = new RawStub();
        plainClock = _clock();
        taggedClock = _clock();

        wrapper = address(new TokenStub(18));
        stable = address(new TokenStub(6));
        stub = new ClockStub();
        pool = new PoolStub(wrapper, stable);
        pool.set(SQRT_REAL, TICK_REAL, TICK_REAL);
        plainSc = _scorecard();
        taggedSc = _scorecard();
        stub.setCap(wrapper, 0); // shut, so a mark may be committed
    }

    function _clock() internal returns (MarketClock c) {
        address[] memory a = new address[](1);
        a[0] = attestor;
        c = new MarketClock(address(this), a);
        c.registerAsset(wHk, address(rawHk), bytes4("XHKG"), 2); // 2 = Regular
        c.registerAsset(wUs, address(rawUs), bytes4("XNAS"), 1); // 1 = TwentyFourFive
    }

    function _scorecard() internal returns (Scorecard s) {
        s = new Scorecard(IMarketClock(address(stub)), address(this));
        s.setKeeper(keeper, true);
        s.setPriceSource(wrapper, address(pool), true, TWAP_W);
    }

    // --- the machinery: one call, two worlds -------------------------------------------------------

    /// Send `data` from `from` to the plain world as it is, and to the tagged world with the suffix appended.
    /// Both must succeed and emit the same events (topics and data; only the emitter differs).
    function _both(address from, address plainTarget, address taggedTarget, bytes memory data)
        internal
        returns (bytes memory plainRet, bytes memory taggedRet)
    {
        bool ok;
        vm.recordLogs();
        vm.prank(from);
        (ok, plainRet) = plainTarget.call(data);
        assertTrue(ok, "the plain call reverted");
        Vm.Log[] memory plainLogs = vm.getRecordedLogs();

        bytes memory tagged = abi.encodePacked(data, SUFFIX);
        assertEq(tagged.length, data.length + 34);
        vm.recordLogs();
        vm.prank(from);
        (ok, taggedRet) = taggedTarget.call(tagged);
        assertTrue(ok, "the suffixed call reverted");
        Vm.Log[] memory taggedLogs = vm.getRecordedLogs();

        assertGt(plainLogs.length, 0, "the call did something observable");
        assertEq(plainLogs.length, taggedLogs.length, "same number of events");
        for (uint256 i; i < plainLogs.length; ++i) {
            assertEq(plainLogs[i].topics, taggedLogs[i].topics, "same event topics");
            assertEq(plainLogs[i].data, taggedLogs[i].data, "same event data");
            assertEq(plainLogs[i].emitter, plainTarget);
            assertEq(taggedLogs[i].emitter, taggedTarget);
        }
        assertEq(plainRet, taggedRet, "same return data");
    }

    /// The raw return bytes of the same view on both worlds, required to be identical.
    function _same(address a, address b, bytes memory call) internal view returns (bytes memory out) {
        bool ok;
        bytes memory other;
        (ok, out) = a.staticcall(call);
        assertTrue(ok, "view reverted (plain)");
        (ok, other) = b.staticcall(call);
        assertTrue(ok, "view reverted (tagged)");
        assertEq(out, other, "the two worlds disagree");
    }

    function _round(IMarketClock.Regime hk, uint128 capHk, IMarketClock.Regime us, uint128 capUs, bytes32 root)
        internal
        view
        returns (bytes memory)
    {
        address[] memory w = new address[](2);
        IMarketClock.Regime[] memory r = new IMarketClock.Regime[](2);
        uint128[] memory caps = new uint128[](2);
        uint64[] memory nextAt = new uint64[](2);
        bool[] memory halted = new bool[](2);
        (w[0], r[0], caps[0], nextAt[0]) = (wHk, hk, capHk, uint64(block.timestamp + 3600));
        (w[1], r[1], caps[1], nextAt[1]) = (wUs, us, capUs, uint64(block.timestamp + 7200));
        return abi.encodeCall(MarketClock.attestBatch, (w, r, caps, nextAt, halted, root));
    }

    function _sameClocks() internal view {
        _same(address(plainClock), address(taggedClock), abi.encodeCall(MarketClock.stateOf, (wHk)));
        _same(address(plainClock), address(taggedClock), abi.encodeCall(MarketClock.stateOf, (wUs)));
        _same(address(plainClock), address(taggedClock), abi.encodeCall(MarketClock.regime, (wHk)));
        _same(address(plainClock), address(taggedClock), abi.encodeCall(MarketClock.primaryCapNow, (wUs)));
        _same(address(plainClock), address(taggedClock), abi.encodeWithSelector(plainClock.blackoutUntil.selector, wUs));
    }

    function _commitment(uint128 mark, uint64 settleAfter, bytes32 root) internal view returns (Scorecard.Commitment memory) {
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

    // --- the constant ------------------------------------------------------------------------------

    function test_the_suffix_is_the_builder_code_under_erc8021_schema_0() public pure {
        assertEq(SUFFIX.length, 34);
        bytes memory code = new bytes(16);
        bytes memory tail = new bytes(16);
        for (uint256 i; i < 16; ++i) {
            code[i] = SUFFIX[i];
            tail[i] = SUFFIX[18 + i];
        }
        assertEq(string(code), "dd7u50nckt5e729f");
        assertEq(uint8(SUFFIX[16]), 16, "codes length");
        assertEq(uint8(SUFFIX[17]), 0, "schema id");
        assertEq(bytes16(tail), MARKER, "ends with the ERC-8021 marker");
    }

    // --- MarketClock.attestBatch --------------------------------------------------------------------

    function test_attestBatch_with_the_suffix_writes_the_same_state_and_events() public {
        _both(attestor, address(plainClock), address(taggedClock),
            _round(IMarketClock.Regime.CLOSED, 0, IMarketClock.Regime.OVERNIGHT, 20_000_000, bytes32("r1")));
        _sameClocks();
        assertEq(uint8(taggedClock.regime(wHk)), uint8(IMarketClock.Regime.CLOSED), "the tagged round was applied");
        assertEq(taggedClock.primaryCapNow(wUs), 20_000_000);
        assertEq(taggedClock.stateOf(wUs).observedAt, block.timestamp);

        // A corporate action lands between rounds: the blackout it opens must be identical too.
        vm.warp(block.timestamp + 60);
        rawUs.bump();
        _both(attestor, address(plainClock), address(taggedClock),
            _round(IMarketClock.Regime.MARKET, 2_000_000, IMarketClock.Regime.OVERNIGHT, 20_000_000, bytes32("r2")));
        _sameClocks();
        assertTrue(taggedClock.isInMultiplierBlackout(wUs), "the tagged world saw the nonce move");
        assertEq(taggedClock.stateOf(wUs).multiplierNonce, 1);
        assertEq(uint8(taggedClock.regime(wHk)), uint8(IMarketClock.Regime.MARKET));
    }

    function test_the_suffix_does_not_get_a_stranger_past_onlyAttestor() public {
        bytes memory tagged = abi.encodePacked(
            _round(IMarketClock.Regime.MARKET, 1, IMarketClock.Regime.MARKET, 1, bytes32("x")), SUFFIX);
        vm.prank(stranger);
        (bool ok, bytes memory err) = address(taggedClock).call(tagged);
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(MarketClock.NotAttestor.selector));
    }

    // --- Scorecard.commit ---------------------------------------------------------------------------

    function test_commit_with_the_suffix_records_the_same_row_under_the_same_id() public {
        uint64 sa = uint64(block.timestamp + 3600);
        bytes memory data = abi.encodeCall(Scorecard.commit, (_commitment(55e18, sa, bytes32("r1"))));
        (bytes memory plainRet,) = _both(keeper, address(plainSc), address(taggedSc), data);
        bytes32 id = abi.decode(plainRet, (bytes32));

        // The id is keccak256(wrapper, settleAfter, inputRoot) -- arguments, never bytes.
        assertEq(id, keccak256(abi.encode(wrapper, sa, bytes32("r1"))));
        bytes memory row = _same(address(plainSc), address(taggedSc), abi.encodeWithSelector(plainSc.commitments.selector, id));
        (, uint64 committedAt, uint64 committedBlock,, uint128 mark,,,,,,) = abi.decode(
            row, (address, uint64, uint64, uint64, uint128, uint32, bytes32, bytes32, uint128, uint128, uint128));
        assertEq(committedAt, block.timestamp, "a real row, not two empty ones");
        assertEq(committedBlock, block.number);
        assertEq(mark, 55e18);
        _same(address(plainSc), address(taggedSc), abi.encodeCall(Scorecard.closureCount, ()));
        _same(address(plainSc), address(taggedSc), abi.encodeWithSelector(plainSc.closureIds.selector, uint256(0)));
    }

    /// The keeper's retry rule depends on this: a suffixed resend of a commit that already landed plain
    /// (or the reverse, across the deploy that turns attribution on) is refused as the SAME closure.
    function test_a_suffixed_resend_of_a_plain_commit_is_the_same_closure() public {
        uint64 sa = uint64(block.timestamp + 3600);
        bytes memory data = abi.encodeCall(Scorecard.commit, (_commitment(55e18, sa, bytes32("r1"))));
        vm.prank(keeper);
        (bool ok, bytes memory ret) = address(taggedSc).call(data);
        assertTrue(ok);
        bytes32 id = abi.decode(ret, (bytes32));

        vm.prank(keeper);
        (ok, ret) = address(taggedSc).call(abi.encodePacked(data, SUFFIX));
        assertFalse(ok, "a second row for one closure");
        assertEq(ret, abi.encodeWithSelector(Scorecard.ClosureExists.selector, id));
        assertEq(taggedSc.closureCount(), 1);
    }

    function test_the_suffix_does_not_get_a_stranger_past_onlyKeeper() public {
        bytes memory data = abi.encodeCall(Scorecard.commit, (_commitment(55e18, uint64(block.timestamp + 3600), bytes32("r5"))));
        vm.prank(stranger);
        (bool ok, bytes memory err) = address(taggedSc).call(abi.encodePacked(data, SUFFIX));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(Scorecard.NotKeeper.selector));
    }

    // --- Scorecard.settle ---------------------------------------------------------------------------

    function test_settle_with_the_suffix_grades_the_row_identically() public {
        uint64 sa = uint64(block.timestamp + 3600);
        // Committed the same way in both worlds (plain in one, tagged in the other), so the ids match.
        (bytes memory ret,) = _both(keeper, address(plainSc), address(taggedSc),
            abi.encodeCall(Scorecard.commit, (_commitment(54.6e18, sa, bytes32("r3")))));
        bytes32 id = abi.decode(ret, (bytes32));

        stub.setCap(wrapper, 100_000);                        // the issuer reopened
        vm.warp(sa + plainSc.SETTLE_DELAY());
        vm.roll(block.number + 500);
        // settle() is permissionless: a stranger's suffixed settle must grade exactly as a plain one.
        _both(stranger, address(plainSc), address(taggedSc), abi.encodeCall(Scorecard.settle, (id)));

        bytes memory s = _same(address(plainSc), address(taggedSc), abi.encodeWithSelector(plainSc.settlements.selector, id));
        (, uint64 settledBlock, uint128 reopenPrint,,,,,, bool settled) = abi.decode(
            s, (uint64, uint64, uint128, uint32, uint32, uint32, uint32, uint8, bool));
        assertTrue(settled, "a real grade, not two empty ones");
        assertEq(reopenPrint, PRICE_REAL, "the pool's price, suffix or not");
        assertEq(settledBlock, block.number);
        _same(address(plainSc), address(taggedSc), abi.encodeCall(Scorecard.skill, ()));
        (uint256 n,,) = taggedSc.skill();
        assertEq(n, 1);

        // And a second, suffixed settle is refused exactly as a plain one would be.
        vm.prank(stranger);
        (bool ok, bytes memory err) = address(taggedSc).call(abi.encodePacked(abi.encodeCall(Scorecard.settle, (id)), SUFFIX));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(Scorecard.AlreadySettled.selector, id));
    }
}
