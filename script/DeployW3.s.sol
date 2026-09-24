// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {ClosedAuction} from "../src/ClosedAuction.sol";
import {ReopenPointer} from "../src/ReopenPointer.sol";
import {ReopenNote} from "../src/ReopenNote.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
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
    ReopenPointer public pointer;
    ReopenNote public note;
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

        pointer = new ReopenPointer(IMarketClock(CLOCK), IScorecardPrice(SCORECARD));

        address[] memory ws = new address[](3);
        uint256[] memory caps = new uint256[](3);
        (ws[0], caps[0]) = (W_TCENT, CAP_TCENT);
        (ws[1], caps[1]) = (W_NVDA, CAP_NVDA);
        (ws[2], caps[2]) = (W_AAPL, CAP_AAPL);
        note = new ReopenNote(IMarketClock(CLOCK), pointer, IScorecardPrice(SCORECARD), ws, caps, URI);

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

        // note: wiring, caps, cohort, metadata
        require(address(note.clock()) == CLOCK, "note.clock");
        require(address(note.pointer()) == address(pointer), "note.pointer");
        require(address(note.scorecard()) == SCORECARD, "note.scorecard");
        require(note.capShares(W_TCENT) == CAP_TCENT, "cap wTCENTx");
        require(note.capShares(W_NVDA) == CAP_NVDA, "cap wNVDAx");
        require(note.capShares(W_AAPL) == CAP_AAPL, "cap wAAPLx");
        require(note.capShares(0xff637d2d435D6745Df3faf61272B1216e7e8b727) == 0, "wSHEINx must have no cap");
        address[] memory assets = note.supportedAssets();
        require(assets.length == 3 && assets[0] == W_TCENT && assets[1] == W_NVDA && assets[2] == W_AAPL, "cohort");
        require(note.noteCount() == 0 && note.openInterest(W_TCENT) == 0, "note starts empty");
        require(keccak256(bytes(note.uri(1))) == keccak256(bytes(URI)), "note uri");
        require(keccak256(bytes(note.name())) == keccak256("Curb Reopen Note"), "note name");
        require(keccak256(bytes(note.symbol())) == keccak256("CURB-RN"), "note symbol");
        require(note.supportsInterface(0xd9b67a26), "note is ERC-1155");

        // pointer: wiring and the head after the first observe
        require(address(pointer.clock()) == CLOCK, "pointer.clock");
        require(address(pointer.scorecard()) == SCORECARD, "pointer.scorecard");
        IMarketClock.Regime r = IMarketClock(CLOCK).regime(W_TCENT);
        uint128 cap = IMarketClock(CLOCK).primaryCapNow(W_TCENT);
        ReopenPointer.Head memory h = pointer.headOf(W_TCENT);
        require(h.epoch == 0, "pointer starts at epoch 0");
        if (r != IMarketClock.Regime.UNKNOWN) {
            require(h.open == (cap > 0), "pointer head disagrees with the clock");
            require(h.lastObservedAt == block.timestamp, "pointer observed at deploy");
            if (cap == 0) require(h.lastShutAt == block.timestamp, "pointer witnessed the shut");
        }

        console2.log("wTCENTx regime / cap        :", uint8(r), cap);
        console2.log("pointer epoch / open        :", h.epoch, h.open);
        console2.log("pointer lastShutAt / observed:", h.lastShutAt, h.lastObservedAt);
    }
}
