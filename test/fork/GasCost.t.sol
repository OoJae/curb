// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {MarketClock} from "../../src/MarketClock.sol";
import {Scorecard} from "../../src/Scorecard.sol";
import {IMarketClock} from "../../src/interfaces/IMarketClock.sol";

/// Measures real gas for deployment and for each recurring operation, so funding amounts
/// for the deployer, attestor and keeper wallets are sized from data rather than guessed.
contract GasCostForkTest is Test {
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant POOL_TCENT = 0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f;
    address constant R_TCENT = 0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42;
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant R_NVDA = 0xc845b2894dBddd03858fd2D643B4eF725fE0849d;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;
    address constant R_AAPL = 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a;

    MarketClock clock;
    Scorecard sc;
    address admin;
    address attestor;
    address keeper;
    address[] ws;

    function setUp() public {
        vm.createSelectFork("xlayer");
        admin = makeAddr("admin"); attestor = makeAddr("attestor"); keeper = makeAddr("keeper");
    }

    function _log(string memory what, uint256 g0) internal view {
        console2.log(what, g0 - gasleft());
    }

    function test_gas() public {
        vm.startPrank(admin);
        address[] memory a = new address[](1); a[0] = attestor;
        uint256 g = gasleft(); clock = new MarketClock(admin, a); _log("deploy MarketClock    :", g);
        g = gasleft(); sc = new Scorecard(IMarketClock(address(clock)), admin); _log("deploy Scorecard      :", g);
        g = gasleft(); sc.setKeeper(keeper, true); _log("setKeeper             :", g);
        // Scorecard v2 refuses to commit a mark it could never settle, so the real cost of a row
        // includes registering where its price comes from.
        g = gasleft(); sc.setPriceSource(W_TCENT, POOL_TCENT, true, 120); _log("setPriceSource        :", g);

        ws.push(W_TCENT); ws.push(W_NVDA); ws.push(W_AAPL);
        ws.push(address(0x1001)); ws.push(address(0x1002)); ws.push(address(0x1003));
        address[6] memory rs = [R_TCENT, R_NVDA, R_AAPL, R_TCENT, R_NVDA, R_AAPL];
        g = gasleft();
        for (uint i; i < 6; ++i) clock.registerAsset(ws[i], rs[i], bytes4("XHKG"), 2);
        _log("registerAsset x6      :", g);
        vm.stopPrank();

        _attest(IMarketClock.Regime.CLOSED, "attestBatch x6 cold   :");
        vm.warp(block.timestamp + 60);
        _attest(IMarketClock.Regime.MARKET, "attestBatch x6 warm   :");
        vm.warp(block.timestamp + 60);
        _attest(IMarketClock.Regime.CLOSED, "attestBatch x6 steady :");

        _commitAndSettle();
    }

    function _attest(IMarketClock.Regime reg, string memory label) internal {
        address[] memory w = new address[](6);
        IMarketClock.Regime[] memory r = new IMarketClock.Regime[](6);
        uint128[] memory caps = new uint128[](6);
        uint64[] memory nx = new uint64[](6);
        bool[] memory h = new bool[](6);
        for (uint i; i < 6; ++i) {
            w[i] = ws[i]; r[i] = reg; nx[i] = uint64(block.timestamp + 3600);
            caps[i] = reg == IMarketClock.Regime.MARKET ? 100_000_000 : 0;
        }
        vm.prank(attestor);
        uint256 g = gasleft();
        clock.attestBatch(w, r, caps, nx, h, keccak256(abi.encode(block.timestamp)));
        _log(label, g);
    }

    function _commitAndSettle() internal {
        Scorecard.Commitment memory c = Scorecard.Commitment({
            wrapper: W_TCENT, committedAt: 0, committedBlock: 0, settleAfter: uint64(block.timestamp + 3600),
            mark: 55e18, bandBps: 50, inputRoot: bytes32("in"), methodDigest: bytes32("m"),
            lastPrint: 54e18, closingVwap: 54.5e18, staleOracle: 0
        });
        vm.prank(keeper);
        uint256 g = gasleft(); bytes32 id = sc.commit(c); _log("Scorecard.commit      :", g);
        // Past the reopen AND past SETTLE_DELAY, with a fresh attestation showing capacity back:
        // v2 reads the price itself and refuses to settle while MarketClock still says shut.
        vm.warp(block.timestamp + 3600 + 300 + 1);
        _attest(IMarketClock.Regime.MARKET, "attestBatch x6 reopen :");
        g = gasleft(); sc.settle(id); _log("Scorecard.settle      :", g);
    }
}
