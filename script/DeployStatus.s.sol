// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MarketClockStatus} from "../src/adapters/MarketClockStatus.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";

interface IClockRegistry {
    function registered(uint256 i) external view returns (address);
    function registeredCount() external view returns (uint256);
}

/// MarketClockStatus: MarketClock's answer in Chainlink Data Streams v11 `marketStatus` codes. One constructor
/// argument (the deployed MarketClock), no admin, no storage, no funds, so the only thing to get right is the
/// clock address, and the read-back below checks it against every registered wrapper.
///
///   Dry run (no account, nothing signed):
///     forge script script/DeployStatus.s.sol --rpc-url xlayer --sender 0x78a5955b433988198bccA2E8bdC671444798f809
///   Deploy (the lead only):
///     ... --account curb-deployer --password-file ~/.foundry/curb-secrets/<deployer file> \
///       --broadcast --verify --verifier sourcify
///
/// No Builder Code. ERC-8021 reads its suffix from the end of a call's calldata, after the ABI-encoded arguments.
/// A deployment is not a call: its data is initcode, and anything appended to it lands where the constructor
/// arguments go (the constructor's decoder ignores the excess, so it would still deploy, but the tag would be part
/// of the creation bytecode rather than calldata to a contract). forge's `new` sends the initcode unchanged. The
/// adapter has no write functions, so no later transaction to it can carry the suffix either.
contract DeployStatus is Script {
    address constant DEPLOYER = 0x78a5955b433988198bccA2E8bdC671444798f809;
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;

    // MarketClock's registered cohort, in registration order (registered(0..5)).
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant W_SHEIN = 0xff637d2d435D6745Df3faf61272B1216e7e8b727;
    address constant W_XIAO = 0x076CF393E701839FC7a5832D2c68AaFA235682AE;
    address constant W_MEIT = 0xad1b65C8556957cf23d1B5e9accdc449b415fA97;
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;

    function run() external returns (address deployed) {
        require(msg.sender == DEPLOYER, "run with --sender 0x78a5955b433988198bccA2E8bdC671444798f809");
        address[] memory six = _six();
        _preflight(six);

        vm.startBroadcast();
        MarketClockStatus status = new MarketClockStatus(IMarketClock(CLOCK));
        vm.stopBroadcast();

        deployed = address(status);
        _readBack(status, six);
        console2.log("MarketClockStatus:", deployed);
    }

    function _six() internal pure returns (address[] memory six) {
        six = new address[](6);
        (six[0], six[1], six[2]) = (W_TCENT, W_SHEIN, W_XIAO);
        (six[3], six[4], six[5]) = (W_MEIT, W_NVDA, W_AAPL);
    }

    /// @dev The clock must be the one we think it is, with the cohort we think it has, before anything is signed.
    function _preflight(address[] memory six) internal view {
        require(DEPLOYER.balance > 0.0002 ether, "deployer has too little OKB for one deployment");
        require(CLOCK.code.length > 0, "MarketClock has no code");
        require(IClockRegistry(CLOCK).registeredCount() == six.length, "MarketClock cohort size changed");
        for (uint256 i; i < six.length; ++i) {
            require(IClockRegistry(CLOCK).registered(i) == six[i], "MarketClock cohort differs from the pinned six");
        }
    }

    function _readBack(MarketClockStatus status, address[] memory six) internal view {
        require(address(status).code.length > 0, "MarketClockStatus: no code");
        require(address(status.clock()) == CLOCK, "MarketClockStatus: clock");
        require(status.STATUS_UNKNOWN() == 0 && status.STATUS_REGULAR() == 2 && status.STATUS_CLOSED() == 5, "codes");

        IMarketClock clock = IMarketClock(CLOCK);
        uint32[] memory batch = status.statusMany(six);
        require(batch.length == six.length, "statusMany length");
        string[6] memory names = ["wTCENTx", "wSHEINx", "wXIAOx ", "wMEITx ", "wNVDAx ", "wAAPLx "];
        console2.log("block / timestamp:", block.number, block.timestamp);
        console2.log("wrapper  regime  cap(USD)  marketStatus");
        for (uint256 i; i < six.length; ++i) {
            address w = six[i];
            uint32 s = status.marketStatus(w);
            IMarketClock.Regime r = clock.regime(w);
            uint128 cap = clock.primaryCapNow(w);
            console2.log(names[i], uint8(r), uint256(cap), uint256(s));

            require(s == batch[i], "statusMany disagrees with marketStatus");
            require(s == 0 || s == 2 || s == 3 || s == 4 || s == 5, "not a v11 code");
            require((s == 0) == (r == IMarketClock.Regime.UNKNOWN), "0 iff UNKNOWN");
            if (cap == 0) require(s == 0 || s == 5, "no capacity must never read open");
            if (i < 4) require(s == 0 || s == 2 || s == 5, "a Hong Kong name read 3 or 4");
            require(
                status.isArbitraged(w) == (s == 2 || s == 3 || s == 4), "isArbitraged disagrees with marketStatus"
            );
        }
    }
}
