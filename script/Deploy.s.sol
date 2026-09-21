// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MarketClock} from "../src/MarketClock.sol";
import {Scorecard} from "../src/Scorecard.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";

/// Deploys the two long-lead contracts and registers the demo cohort.
///
/// Run against testnet 1952 first, then mainnet 196. MarketClock and Scorecard go up
/// EARLY and deliberately: their value comes from accruing an unbackfillable public
/// record, so every day they are not live is a day of evidence we cannot recover later.
///
/// Signing uses an encrypted Foundry keystore, so no private key ever sits in an env var,
/// a .env file, shell history, or this repo:
///
///   ATTESTOR=0x... KEEPER=0x... forge script script/Deploy.s.sol \
///     --rpc-url xlayer --account curb-deployer --sender 0x<deployer> --broadcast
contract Deploy is Script {
    // Hong Kong cohort: `Regular` hours, no overnight session, primary shut 83.6% of the week.
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant R_TCENT = 0xfa15e42C18CF57aEEf4b1baC1CEE7754af7CFe42;
    address constant W_SHEIN = 0xff637d2d435D6745Df3faf61272B1216e7e8b727;
    address constant W_XIAO  = 0x076CF393E701839FC7a5832D2c68AaFA235682AE;
    address constant W_MEIT  = 0xad1b65C8556957cf23d1B5e9accdc449b415fA97;

    // US contrast panel: `TwentyFourFive`, so an overnight session exists during the finale.
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant R_NVDA = 0xc845b2894dBddd03858fd2D643B4eF725fE0849d;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;
    address constant R_AAPL = 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a;

    bytes4 constant XHKG = bytes4("XHKG");
    bytes4 constant XNAS = bytes4("XNAS");
    uint8 constant MODE_245 = 1;
    uint8 constant MODE_REGULAR = 2;

    function run() external {
        address attestor = vm.envAddress("ATTESTOR");
        address keeper = vm.envAddress("KEEPER");
        address deployer = msg.sender; // the --sender / --account signer

        console2.log("chainid :", block.chainid);
        console2.log("deployer:", deployer);
        console2.log("balance :", deployer.balance);
        require(deployer.balance > 0.001 ether, "deployer has no OKB for gas");
        require(attestor != deployer && keeper != deployer && attestor != keeper, "use three distinct keys");

        vm.startBroadcast();

        address[] memory attestors = new address[](1);
        attestors[0] = attestor;
        MarketClock clock = new MarketClock(deployer, attestors);
        Scorecard scorecard = new Scorecard(IMarketClock(address(clock)), deployer);
        scorecard.setKeeper(keeper, true);

        // Raw addresses for SHEIN/XIAO/MEIT are resolved from each wrapper's asset() at
        // registration time rather than hardcoded, so a wrong constant cannot silently
        // register a mismatched pair.
        clock.registerAsset(W_TCENT, R_TCENT, XHKG, MODE_REGULAR);
        clock.registerAsset(W_SHEIN, _assetOf(W_SHEIN), XHKG, MODE_REGULAR);
        clock.registerAsset(W_XIAO, _assetOf(W_XIAO), XHKG, MODE_REGULAR);
        clock.registerAsset(W_MEIT, _assetOf(W_MEIT), XHKG, MODE_REGULAR);
        clock.registerAsset(W_NVDA, R_NVDA, XNAS, MODE_245);
        clock.registerAsset(W_AAPL, R_AAPL, XNAS, MODE_245);

        vm.stopBroadcast();

        console2.log("MarketClock:", address(clock));
        console2.log("Scorecard  :", address(scorecard));
        console2.log("registered :", clock.registeredCount());
    }

    function _assetOf(address wrapper) internal view returns (address) {
        (bool ok, bytes memory out) = wrapper.staticcall(abi.encodeWithSignature("asset()"));
        require(ok && out.length == 32, "wrapper has no asset()");
        return abi.decode(out, (address));
    }
}
