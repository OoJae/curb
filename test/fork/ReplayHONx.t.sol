// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {MarketClock} from "../../src/MarketClock.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";
import {Blackouts} from "./replay/Blackouts.sol";

interface IXStock {
    function getCurrentMultiplier() external view returns (uint256, uint256, uint256);
    function newMultiplier() external view returns (uint256);
    function newMultiplierNonce() external view returns (uint256);
    function newMultiplierActivationTime() external view returns (uint256);
}

interface IWrappedXStock {
    function asset() external view returns (address);
    function convertToAssets(uint256) external view returns (uint256);
}

/// @notice W1-F. Replays the real HONx (Honeywell xStock) corporate actions of 29 Jun 2026 against
///         MarketClock compiled from this repo: a 2:1 reverse split at 15:30:00Z and a spin-off at
///         23:55:00Z, 8h25m apart. Its multiplier went 1.024094713306789 -> 0.5120473566533945 ->
///         0.9990655067370947 and neither activation emitted an event.
///
/// How the replay works. The issuer publishes each action as a transaction that sets
/// newMultiplier / newMultiplierNonce / newMultiplierActivationTime. getCurrentMultiplier() then
/// starts returning the new value and nonce at the activation timestamp, and no transaction or log
/// marks the moment. So the test forks at a block after the publish and before the activation, and
/// uses vm.warp to cross the real activation timestamp. The raw token's own code decides when the
/// nonce flips. The spin-off was published at 23:50:33Z, so the reverse-split fork does not contain
/// it. The test moves to a second pinned fork before replaying the spin-off, and the locally
/// deployed MarketClock goes with it (vm.makePersistent).
///
/// Code-hash method. The deployed MarketClock has constructor arguments (admin, attestors) but NO
/// immutables. `type(MarketClock).runtimeCode` only compiles for a contract without immutables, so
/// this file compiling is the proof. The constructor writes only storage, so the runtime code does
/// not depend on the arguments and no bytes need masking. The test deploys a fresh MarketClock with
/// the deployed contract's exact constructor arguments. It asserts that the fresh code, the
/// compiler's runtimeCode and the deployed code (read on a fork pinned after the deploy) are
/// byte-identical, CBOR metadata trailer included. The metadata hash covers the source and the
/// compiler settings, so a match means this repo's source is what runs at 0x160D…B09b.
///
/// Reproduce: forge test --match-path test/fork/ReplayHONx.t.sol -vv
contract ReplayHONxForkTest is Test {
    // --- addresses --------------------------------------------------------------------------------

    // GET https://api.xstocks.fi/api/v2/public/assets/HONx?network=XLayer, deployments[network=XLayer]:
    address constant HONX = 0x62a48560861B0b451654bFffdb5be6E47aa8ff1B; // `address`, the rebasing xStock
    /// `wrapperAddressV2`. It has no code at the replay blocks: it was deployed at block 65,354,472
    /// (15 Jul 2026, tx 0x583ed32c…). MarketClock's blackout path reads only the registered raw token,
    /// so registering the wrapper address before the wrapper existed replays that path faithfully.
    address constant WHONX = 0xd762788960C607109151eF84EFCCB19c3AD18012;

    // The deployed MarketClock and its constructor arguments (broadcast/Deploy.s.sol/196/run-latest.json).
    address constant DEPLOYED_CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;
    address constant ADMIN = 0x78a5955b433988198bccA2E8bdC671444798f809;
    address constant ATTESTOR = 0x4c3eD38809FA6469871F4e0cbEa7ae7dBdA87fb8;

    // --- pinned blocks and timestamps ---------------------------------------------------------------
    // Found by binary search over archive eth_call on rpc.xlayer.tech. The publish block is the first
    // block where newMultiplierNonce() moved; the activation block is the first where the third word of
    // getCurrentMultiplier() moved. X Layer made exactly one block per second over this range:
    // block = unix time - 1,718,769,036.

    /// ReverseSplit 2:1 (issuer eventId ccb423a2-6045-4d1c-9a94-1f37f0ab8d63, version 2).
    /// Published at block 63,977,635 (1,782,746,671 = 15:24:31Z) by 0x5F7A…a2aD,
    /// tx 0xd453a5c882e9d596483af8f5361dc12e61dc4eb9cc196c84fcd3be2190c674ce.
    uint256 constant RS_PUBLISHED_BLOCK = 63_977_635;
    /// The replay fork: 265 blocks after that publish and 64 s before the activation.
    /// Current nonce 5, newMultiplierNonce 6.
    uint256 constant RS_FORK_BLOCK = 63_977_900; // timestamp 1,782,746,936
    /// 2026-06-29T15:30:00Z. Block 63,977,963 (…999) still reads nonce 5; block 63,977,964 is the first to read 6.
    uint64 constant RS_ACTIVATION = 1_782_747_000;

    /// SpinOff (issuer eventId ca3da1bc-04d2-4c6a-a23e-51f7c58ee06d, version 2).
    /// Published at block 64,007,997 (1,782,777,033 = 23:50:33Z) by 0x5F7A…a2aD,
    /// tx 0xa1d4f8a6df64e4f10753187f6353c9cce20390205c56d1ca1ee24afd70b8df44.
    uint256 constant SO_PUBLISHED_BLOCK = 64_007_997;
    /// The second fork: 203 blocks after that publish and 64 s before the activation.
    /// Current nonce 6, newMultiplierNonce 7.
    uint256 constant SO_FORK_BLOCK = 64_008_200; // timestamp 1,782,777,236
    /// 2026-06-29T23:55:00Z. Block 64,008,264 is the first to read nonce 7.
    uint64 constant SO_ACTIVATION = 1_782_777_300;

    /// A block after MarketClock's deploy (block 70,545,887). Used only to read the deployed code.
    uint256 constant CODE_BLOCK = 70_545_900;

    // --- the issuer's multipliers, 18 decimals, as getCurrentMultiplier() returns them ---------------
    uint256 constant M_BEFORE = 1_024_094_713_306_789_000; // "1.024094713306789", nonce 5
    uint256 constant M_REVERSE = 512_047_356_653_394_500; // "0.5120473566533945", nonce 6
    uint256 constant M_SPINOFF = 999_065_506_737_094_700; // "0.9990655067370947", nonce 7

    bytes4 constant XNAS = bytes4("XNAS");
    uint8 constant TWENTY_FOUR_FIVE = 1;

    MarketClock clock;

    function setUp() public {
        vm.createSelectFork("xlayer", RS_FORK_BLOCK);
        address[] memory attestors = new address[](1);
        attestors[0] = ATTESTOR;
        clock = new MarketClock(ADMIN, attestors); // the deployed contract's exact constructor arguments
        vm.makePersistent(address(clock));
        vm.prank(ADMIN);
        clock.registerAsset(WHONX, HONX, XNAS, TWENTY_FOUR_FIVE);
    }

    // --- 1. this repo's source is what runs at 0x160D…B09b ------------------------------------------

    function test_fresh_build_is_byte_identical_to_the_deployed_MarketClock() public {
        bytes memory fresh = address(clock).code;
        assertEq(fresh, type(MarketClock).runtimeCode, "no immutables: deployed code must equal the compiler's runtime object");

        vm.selectFork(vm.createFork("xlayer", CODE_BLOCK));
        bytes memory deployed = DEPLOYED_CLOCK.code;
        console2.log("runtime bytes, fresh / deployed:", fresh.length, deployed.length);
        console2.logBytes32(DEPLOYED_CLOCK.codehash);
        assertEq(DEPLOYED_CLOCK.codehash, keccak256(fresh), "runtime code hash must equal the deployed contract's");
        assertEq(deployed, fresh, "byte-identical, CBOR metadata included");
        // And it is the deployment we think it is: same admin, same attestor, set by the constructor.
        assertEq(MarketClock(DEPLOYED_CLOCK).admin(), ADMIN);
        assertTrue(MarketClock(DEPLOYED_CLOCK).isAttestor(ATTESTOR));
        // The wrapper we register wraps HONx, and its rate is the issuer multiplier to the wei.
        assertEq(IWrappedXStock(WHONX).asset(), HONX, "wHONx must wrap HONx");
        (uint256 m,, uint256 n) = IXStock(HONX).getCurrentMultiplier();
        assertEq(IWrappedXStock(WHONX).convertToAssets(1e18), m, "wrapper rate must equal the raw multiplier");
        // Nonce 8 is the 14 Aug 2026 cash dividend (eventId 7d20da53…, 0.9990655067370947 -> 1.0011576563945983),
        // the only HONx action between the spin-off and MarketClock's deploy.
        assertEq(n, 8, "one action since the spin-off");
        assertEq(m, 1_001_157_656_394_598_300);
    }

    // --- 2. the replay ------------------------------------------------------------------------------

    function test_replay_reverse_split_then_spin_off_opens_two_blackouts() public {
        // The pinned block: the reverse split is published and not yet active.
        _assertIssuer(M_BEFORE, 5);
        assertEq(IXStock(HONX).newMultiplier(), M_REVERSE);
        assertEq(IXStock(HONX).newMultiplierNonce(), 6);
        assertEq(IXStock(HONX).newMultiplierActivationTime(), RS_ACTIVATION);
        _attest(IMarketClock.Regime.EXTENDED); // the baseline round: the first attestation never opens a blackout

        // Reverse split. The attestor polls once a second, 2 s either side of the activation.
        vm.recordLogs();
        _pollAround(RS_ACTIVATION);
        Blackouts.Opened[] memory rs = Blackouts.collect(vm.getRecordedLogs(), address(clock));
        assertEq(rs.length, 1, "exactly one blackout across the reverse split");
        _assertBlackout(rs[0], 5, 6, RS_ACTIVATION);
        _assertIssuer(M_REVERSE, 6);
        // A reverse split, exactly: new * fromUnits == old * toUnits, with fromUnits 2 and toUnits 1.
        assertEq(M_REVERSE * 2, M_BEFORE * 1, "2:1 reverse split, to the wei");

        // Move to the fork after the issuer's second write. MarketClock's storage moves with it.
        vm.selectFork(vm.createFork("xlayer", SO_FORK_BLOCK));
        assertEq(block.timestamp, SO_ACTIVATION - 64);
        assertEq(IXStock(HONX).newMultiplierNonce(), 7);
        assertEq(IXStock(HONX).newMultiplier(), M_SPINOFF);
        assertEq(IXStock(HONX).newMultiplierActivationTime(), SO_ACTIVATION);
        _assertIssuer(M_REVERSE, 6);
        assertEq(clock.stateOf(WHONX).multiplierNonce, 6, "MarketClock carried nonce 6 across the fork switch");
        assertFalse(clock.isInMultiplierBlackout(WHONX), "the 15:30 blackout expired hours ago");

        // Spin-off.
        vm.recordLogs();
        _attest(IMarketClock.Regime.CLOSED); // 8h later, a new action published, same nonce: no blackout
        _pollAround(SO_ACTIVATION);
        Blackouts.Opened[] memory so = Blackouts.collect(vm.getRecordedLogs(), address(clock));
        assertEq(so.length, 1, "exactly one blackout across the spin-off");
        _assertBlackout(so[0], 6, 7, SO_ACTIVATION);
        _assertIssuer(M_SPINOFF, 7);
        assertEq(clock.stateOf(WHONX).multiplierNonce, 7);
    }

    // --- 3. negative cases --------------------------------------------------------------------------

    /// A published action that has not activated, repeated rounds, and regime changes: none of them is
    /// a nonce change, so none of them opens a blackout.
    function test_no_blackout_without_a_nonce_change() public {
        assertEq(IXStock(HONX).newMultiplierNonce(), 6, "published");
        _assertIssuer(M_BEFORE, 5); // not active

        vm.recordLogs();
        IMarketClock.Regime[4] memory rs =
            [IMarketClock.Regime.EXTENDED, IMarketClock.Regime.CLOSED, IMarketClock.Regime.MARKET, IMarketClock.Regime.CLOSED];
        // Every 8 s from the pinned block up to the last second before the activation.
        uint256 k;
        for (uint64 t = uint64(block.timestamp); t < RS_ACTIVATION; t += 8) {
            vm.warp(t);
            _attest(rs[k++ % 4]);
        }
        vm.warp(RS_ACTIVATION - 1);
        _attest(IMarketClock.Regime.MARKET);

        assertEq(Blackouts.collect(vm.getRecordedLogs(), address(clock)).length, 0, "no nonce change, no blackout");
        assertFalse(clock.isInMultiplierBlackout(WHONX));
        assertEq(clock.blackoutUntil(WHONX), 0);
        assertEq(clock.stateOf(WHONX).multiplierNonce, 5);
        _assertIssuer(M_BEFORE, 5); // one second before the activation the issuer still reports nonce 5
    }

    /// The blackout lasts exactly BLACKOUT_WINDOW (15 minutes). A round inside it with no further
    /// nonce change neither extends nor re-opens it.
    function test_blackout_expires_after_15_minutes() public {
        _attest(IMarketClock.Regime.EXTENDED);
        vm.warp(RS_ACTIVATION);
        _attest(IMarketClock.Regime.EXTENDED);
        uint64 until = clock.blackoutUntil(WHONX);
        assertEq(until, RS_ACTIVATION + 15 minutes);
        assertEq(clock.BLACKOUT_WINDOW(), 15 minutes);
        assertTrue(clock.isInMultiplierBlackout(WHONX));

        vm.warp(RS_ACTIVATION + 10 minutes);
        vm.recordLogs();
        _attest(IMarketClock.Regime.MARKET);
        assertEq(Blackouts.collect(vm.getRecordedLogs(), address(clock)).length, 0);
        assertEq(clock.blackoutUntil(WHONX), until, "not extended by a round without a nonce change");

        vm.warp(RS_ACTIVATION + 15 minutes - 1);
        assertTrue(clock.isInMultiplierBlackout(WHONX), "still in blackout one second before the end");
        vm.warp(RS_ACTIVATION + 15 minutes);
        assertFalse(clock.isInMultiplierBlackout(WHONX), "expired at exactly 15 minutes");
        vm.warp(RS_ACTIVATION + 1 hours);
        assertFalse(clock.isInMultiplierBlackout(WHONX));
    }

    // --- helpers ------------------------------------------------------------------------------------

    function _attest(IMarketClock.Regime r) internal {
        vm.prank(ATTESTOR);
        clock.attest(WHONX, r, r == IMarketClock.Regime.CLOSED ? 0 : 100_000, 0, false, bytes32("replay"));
    }

    /// The attestor as a one-second poller, from 2 s before `t` to 2 s after it.
    function _pollAround(uint64 t) internal {
        for (uint64 s = t - 2; s <= t + 2; ++s) {
            vm.warp(s);
            _attest(IMarketClock.Regime.EXTENDED);
        }
    }

    function _assertIssuer(uint256 multiplier, uint256 nonce) internal view {
        (uint256 m,, uint256 n) = IXStock(HONX).getCurrentMultiplier();
        assertEq(m, multiplier, "issuer multiplier");
        assertEq(n, nonce, "issuer nonce");
    }

    function _assertBlackout(Blackouts.Opened memory b, uint32 fromNonce, uint32 toNonce, uint64 activation) internal view {
        assertEq(b.wrapper, WHONX);
        assertEq(b.fromNonce, fromNonce, "fromNonce");
        assertEq(b.toNonce, toNonce, "toNonce");
        uint64 openedAt = b.until - clock.BLACKOUT_WINDOW();
        assertGe(openedAt, activation, "never before the activation");
        uint64 latency = openedAt - activation;
        assertLe(latency, 2, "opened within 2 s of the activation");
        console2.log("BlackoutOpened fromNonce -> toNonce:", uint256(fromNonce), uint256(toNonce));
        console2.log("  activation, opened at, latency s:", uint256(activation), uint256(openedAt), uint256(latency));
    }
}
