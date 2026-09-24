// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {ClosedAuction} from "../src/ClosedAuction.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {IReopenNote} from "../src/interfaces/IReopenNote.sol";
import {IReopenPointer} from "../src/interfaces/IReopenPointer.sol";
import {IScorecardPrice} from "../src/interfaces/IScorecardPrice.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";

/// W3: EligibilityRegistry, ReopenPointer, ReopenNote, ClosedAuction -- then a first `observe` so the pointer
/// has witnessed the current closure, and a full read-back of every wire, cap and flag from chain.
///
/// Dry run (no key touched):
///   DESK=0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E AGENTIC=0x055ba8acd60a2287b2d01cb3bf237e4424357105 \
///   forge script script/DeployW3.s.sol --fork-url https://rpc.xlayer.tech \
///     --sender 0x78a5955b433988198bccA2E8bdC671444798f809
/// Live (the lead only):
///   ... --rpc-url xlayer --account curb-deployer --sender 0x78a5955b433988198bccA2E8bdC671444798f809 \
///       --password-file ~/.foundry/curb-secrets/<deployer file> --broadcast --verify --verifier sourcify
///
/// ReopenNote and ReopenPointer have NO admin; the deployer is admin of the registry only.
contract DeployW3 is Script {
    address constant DEPLOYER = 0x78a5955b433988198bccA2E8bdC671444798f809;
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;
    address constant SCORECARD = 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f;
    address constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;

    // The note cohort and its open-interest caps (D-3 measured depth). wXIAOx/wMEITx: no measured depth.
    // wSHEINx 0xff637d2d435D6745Df3faf61272B1216e7e8b727: no Scorecard price source, so no notes.
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;
    uint256 constant CAP_TCENT = 175e18;
    uint256 constant CAP_NVDA = 220e18;
    uint256 constant CAP_AAPL = 14e18;

    string constant URI = "https://api.curb.markets/v1/notes/{id}.json";
    bytes32 constant EV_DESK = keccak256("team:curb-desk");
    bytes32 constant EV_AGENTIC = keccak256("team:agentic");

    EligibilityRegistry public registry;
    IReopenPointer public pointer;
    IReopenNote public note;
    ClosedAuction public auction;

    function run() external {
        address desk = vm.envAddress("DESK");
        address agentic = vm.envAddress("AGENTIC");
        address deployer = msg.sender;
        require(deployer == DEPLOYER, "run with --sender 0x78a5955b433988198bccA2E8bdC671444798f809");
        require(desk != address(0) && agentic != address(0) && desk != agentic, "DESK/AGENTIC");
        require(deployer.balance > 0.0005 ether, "deployer has too little OKB for gas");
        _preflight();

        vm.startBroadcast();

        registry = new EligibilityRegistry(deployer);
        registry.setEligible(desk, true, EV_DESK);
        registry.setEligible(agentic, true, EV_AGENTIC);

        pointer = IReopenPointer(_create("ReopenPointer.sol:ReopenPointer", abi.encode(CLOCK, SCORECARD)));

        address[] memory ws = new address[](3);
        uint256[] memory caps = new uint256[](3);
        (ws[0], caps[0]) = (W_TCENT, CAP_TCENT);
        (ws[1], caps[1]) = (W_NVDA, CAP_NVDA);
        (ws[2], caps[2]) = (W_AAPL, CAP_AAPL);
        note = IReopenNote(
            _create("ReopenNote.sol:ReopenNote", abi.encode(CLOCK, address(pointer), SCORECARD, ws, caps, URI))
        );

        auction = new ClosedAuction(
            note,
            pointer,
            IMarketClock(CLOCK),
            IScorecardPrice(SCORECARD),
            IERC20(USDG),
            IEligibility(address(registry))
        );

        pointer.observe(W_TCENT);

        vm.stopBroadcast();

        _readBack(deployer, desk, agentic);

        console2.log("EligibilityRegistry :", address(registry));
        console2.log("ReopenPointer       :", address(pointer));
        console2.log("ReopenNote          :", address(note));
        console2.log("ClosedAuction       :", address(auction));
    }

    /// The live contracts this deploy wires into must be what we think they are.
    function _preflight() internal view {
        require(CLOCK.code.length > 0 && SCORECARD.code.length > 0 && USDG.code.length > 0, "missing live contract");
        require(IERC20(USDG).decimals() == 6, "USDG decimals");
        address[3] memory ws = [W_TCENT, W_NVDA, W_AAPL];
        for (uint256 i; i < 3; ++i) {
            require(IERC20(ws[i]).decimals() == 18, "wrapper decimals");
            (address pool,,,,) = IScorecardPrice(SCORECARD).priceSources(ws[i]);
            require(pool != address(0), "wrapper has no Scorecard price source");
        }
    }

    /// Deploy a contract from its build artifact (ReopenPointer/ReopenNote are package P1).
    function _create(string memory artifact, bytes memory args) internal returns (address a) {
        bytes memory init = abi.encodePacked(vm.getCode(artifact), args);
        assembly ("memory-safe") {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0), artifact);
    }

    function _readBack(address deployer, address desk, address agentic) internal view {
        // code
        require(address(registry).code.length > 0, "registry: no code");
        require(address(pointer).code.length > 0, "pointer: no code");
        require(address(note).code.length > 0, "note: no code");
        require(address(auction).code.length > 0, "auction: no code");

        // registry
        require(registry.admin() == deployer, "registry admin");
        require(registry.pendingAdmin() == address(0), "registry pendingAdmin");
        require(registry.isEligible(desk), "desk eligible");
        require(registry.isEligible(agentic), "agentic eligible");
        require(!registry.isEligible(deployer), "deployer must not be eligible");

        // auction wiring
        require(address(auction.note()) == address(note), "auction.note");
        require(address(auction.pointer()) == address(pointer), "auction.pointer");
        require(address(auction.clock()) == CLOCK, "auction.clock");
        require(address(auction.scorecard()) == SCORECARD, "auction.scorecard");
        require(address(auction.usdg()) == USDG, "auction.usdg");
        require(address(auction.eligibility()) == address(registry), "auction.eligibility");
        require(auction.lotCount() == 0, "auction.lotCount");

        // note: caps, uri, and it refuses anything outside the cohort
        require(_capOf(W_TCENT) == CAP_TCENT, "cap wTCENTx");
        require(_capOf(W_NVDA) == CAP_NVDA, "cap wNVDAx");
        require(_capOf(W_AAPL) == CAP_AAPL, "cap wAAPLx");
        require(_capOf(0xff637d2d435D6745Df3faf61272B1216e7e8b727) == 0, "wSHEINx must have no cap");
        require(keccak256(bytes(_uri())) == keccak256(bytes(URI)), "note uri");

        // pointer head after the first observe
        IMarketClock.Regime r = IMarketClock(CLOCK).regime(W_TCENT);
        uint128 cap = IMarketClock(CLOCK).primaryCapNow(W_TCENT);
        bool open = pointer.isOpen(W_TCENT);
        require(pointer.epochOf(W_TCENT) == 0, "pointer starts at epoch 0");
        if (r != IMarketClock.Regime.UNKNOWN) require(open == (cap > 0), "pointer head disagrees with the clock");

        console2.log("wTCENTx regime / cap :", uint8(r), cap);
        console2.log("pointer epoch / open :", pointer.epochOf(W_TCENT), open);
    }

    function _capOf(address w) internal view returns (uint256) {
        (bool ok, bytes memory ret) = address(note).staticcall(abi.encodeWithSignature("capShares(address)", w));
        require(ok && ret.length == 32, "note.capShares(address) unreadable");
        return abi.decode(ret, (uint256));
    }

    function _uri() internal view returns (string memory) {
        (bool ok, bytes memory ret) = address(note).staticcall(abi.encodeWithSignature("uri(uint256)", uint256(1)));
        require(ok, "note.uri unreadable");
        return abi.decode(ret, (string));
    }
}
