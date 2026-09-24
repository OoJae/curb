// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CurbCredit, IClockAssets} from "../src/CurbCredit.sol";
import {DepthCert} from "../src/DepthCert.sol";
import {IMarketClock} from "../src/interfaces/IMarketClock.sol";
import {IScorecardPrice} from "../src/interfaces/IScorecardPrice.sol";
import {IDepthCert} from "../src/interfaces/IDepthCert.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";

/// W4: a maker allowlist, DepthCert (bonded firm bids, no admin) and CurbCredit (the fixed-rate reserve that lends
/// against them).
///
///   1. EligibilityRegistry(deployer) for MAKERS, with only K (curb-desk) and D (the deployer, fade demo) admitted.
///      A cert naming a beneficiary may only be posted by an eligible maker. This is deliberately NOT the W3
///      borrower registry: MIN_NOTIONAL bounds a cert's size, not its bidPx, so any borrower able to post a 1-USDG
///      cert at a near-zero bid would drag the book's minBid, and with it every position's LTV, to zero.
///   2. DepthCert(USDG, makers).
///   3. CurbCredit(CLOCK, SCORECARD, DepthCert, REGISTRY = the W3 borrower registry, USDG, deployer, five wrappers).
///
///   Dry run (no account, nothing signed):
///     REGISTRY=0x<EligibilityRegistry from W3> forge script script/DeployW4.s.sol \
///       --rpc-url xlayer --sender 0x78a5955b433988198bccA2E8bdC671444798f809
///   Deploy:
///     ... --account curb-deployer --password-file ~/.foundry/curb-secrets/<deployer file> \
///       --broadcast --verify --verifier sourcify
///
/// Both contracts are immutable once deployed: every address below is pinned and every one is read back after
/// deployment, so a wrong wire fails the script rather than going live.
contract DeployW4 is Script {
    address constant DEPLOYER = 0x78a5955b433988198bccA2E8bdC671444798f809;
    address constant CLOCK = 0x160Dc415902971a7a9B5ade7f43005b36FE5B09b;
    address constant SCORECARD = 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f;
    address constant USDG = 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8;

    // The five wrappers Scorecard v2 prices (docs/DEPLOYMENTS.md; script/DeployScorecardV2.s.sol). wSHEINx has no
    // price source, so CurbCredit's constructor would refuse it.
    address constant W_TCENT = 0x41333Df9E7639188BBfca5522dC4844398Af9f9E;
    address constant W_XIAO = 0x076CF393E701839FC7a5832D2c68AaFA235682AE;
    address constant W_MEIT = 0xad1b65C8556957cf23d1B5e9accdc449b415fA97;
    address constant W_NVDA = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5;
    address constant W_AAPL = 0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f;

    // Demo wallets (docs/WALLETS.md): K posts certs naming CurbCredit, A borrows, D is the fade demo's maker.
    address constant DESK_K = 0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E;
    address constant AGENTIC_A = 0x055BA8ACd60A2287b2D01cb3BF237e4424357105;
    bytes32 constant EV_DESK = keccak256("team:curb-desk");
    bytes32 constant EV_DEPLOYER = keccak256("team:deployer");

    function run() external returns (address makers, address depthCert, address credit) {
        address registry = vm.envAddress("REGISTRY");
        require(msg.sender == DEPLOYER, "run with --sender 0x78a5955b433988198bccA2E8bdC671444798f809");
        address[] memory five = _five();
        _preflight(registry, five);

        vm.startBroadcast();
        // Makers of certs naming a beneficiary (CurbCredit's book) come from their OWN allowlist: K and D only.
        EligibilityRegistry makerList = new EligibilityRegistry(DEPLOYER);
        makerList.setEligible(DESK_K, true, EV_DESK);
        makerList.setEligible(DEPLOYER, true, EV_DEPLOYER);
        makers = address(makerList);
        depthCert = address(new DepthCert(IERC20(USDG), IEligibility(makers)));
        credit = address(
            new CurbCredit(
                IMarketClock(CLOCK),
                IScorecardPrice(SCORECARD),
                IDepthCert(depthCert),
                IEligibility(registry),
                IERC20(USDG),
                DEPLOYER,
                five
            )
        );
        vm.stopBroadcast();

        _readBackMakers(EligibilityRegistry(makers), registry);
        _readBackDepthCert(DepthCert(depthCert), credit, makers);
        _readBackCredit(CurbCredit(credit), depthCert, registry, five);

        console2.log("makers (EligibilityRegistry):", makers);
        console2.log("DepthCert                   :", depthCert);
        console2.log("CurbCredit                  :", credit);
        console2.log("borrowers (W3 registry)     :", registry);
        console2.log("admin                       :", DEPLOYER);
    }

    function _five() internal pure returns (address[] memory five) {
        five = new address[](5);
        five[0] = W_TCENT;
        five[1] = W_XIAO;
        five[2] = W_MEIT;
        five[3] = W_NVDA;
        five[4] = W_AAPL;
    }

    /// @dev Everything the constructors will rely on, checked before anything is signed.
    function _preflight(address registry, address[] memory five) internal view {
        require(DEPLOYER.balance > 0.0005 ether, "deployer has too little OKB for two deployments");
        require(registry.code.length > 0, "REGISTRY has no code");
        require(registry != CLOCK && registry != SCORECARD && registry != USDG, "REGISTRY is a known non-registry");
        // The W3 EligibilityRegistry, administered by the deployer; it gates CurbCredit's borrowers AND DepthCert's
        // makers of certs naming a beneficiary.
        require(EligibilityRegistry(registry).admin() == DEPLOYER, "REGISTRY admin is not the deployer");
        // Must answer the one call CurbCredit makes (a reverting registry would refuse every borrower).
        IEligibility(registry).isEligible(DEPLOYER);
        // Not required to deploy, but the demo's borrower must be admitted: say so before anything is signed.
        console2.log("W3 registry: A (borrower) eligible:", IEligibility(registry).isEligible(AGENTIC_A));
        require(CLOCK.code.length > 0 && SCORECARD.code.length > 0 && USDG.code.length > 0, "pinned address has no code");
        require(IERC20(USDG).decimals() == 6, "USDG decimals");
        for (uint256 i; i < five.length; ++i) {
            (address pool,,,,) = IScorecardPrice(SCORECARD).priceSources(five[i]);
            require(pool != address(0), "wrapper has no Scorecard price source");
            require(IERC20(five[i]).decimals() == 18, "wrapper decimals");
            // Registered with the clock (the clock is the regime source for every one of them).
            (,,, bool registered) = IClockAssets(CLOCK).assets(five[i]);
            require(registered, "wrapper not registered with MarketClock");
        }
    }

    function _readBackMakers(EligibilityRegistry m, address borrowers) internal view {
        require(address(m).code.length > 0, "makers: no code");
        require(address(m) != borrowers, "makers must not be the borrower registry");
        require(m.admin() == DEPLOYER && m.pendingAdmin() == address(0), "makers: admin");
        require(m.isEligible(DESK_K), "makers: K");
        require(m.isEligible(DEPLOYER), "makers: D");
        require(!m.isEligible(AGENTIC_A), "makers: the borrower must not be a maker");
    }

    function _readBackDepthCert(DepthCert d, address credit, address makers) internal view {
        require(address(d).code.length > 0, "DepthCert: no code");
        require(address(d.usdg()) == USDG, "DepthCert: usdg");
        require(address(d.makers()) == makers, "DepthCert: makers registry");
        require(d.MIN_BOND_BPS() == 1000, "DepthCert: MIN_BOND_BPS");
        require(d.MIN_LIFE() == 10 minutes, "DepthCert: MIN_LIFE");
        require(d.MAX_LIFE() == 30 days, "DepthCert: MAX_LIFE");
        require(d.MAX_LIVE_PER_BOOK() == 8, "DepthCert: MAX_LIVE_PER_BOOK");
        require(d.TRANSFER_GAS() == 150_000, "DepthCert: TRANSFER_GAS");
        require(d.MIN_NOTIONAL() == 1e6, "DepthCert: MIN_NOTIONAL");
        require(d.MAX_LIVE_PER_MAKER() == 16, "DepthCert: MAX_LIVE_PER_MAKER");
        require(d.totalBonds() == 0 && d.nextId() == 1, "DepthCert: fresh");
        (uint256 s,,,) = d.honouredDepth(W_TCENT, credit, uint64(block.timestamp + 1 hours));
        require(s == 0, "DepthCert: empty book");
    }

    function _readBackCredit(CurbCredit c, address depthCert, address registry, address[] memory five) internal view {
        require(address(c).code.length > 0, "CurbCredit: no code");
        require(address(c.clock()) == CLOCK, "CurbCredit: clock");
        require(address(c.scorecard()) == SCORECARD, "CurbCredit: scorecard");
        require(address(c.depthCert()) == depthCert, "CurbCredit: depthCert");
        require(address(c.eligibility()) == registry, "CurbCredit: eligibility");
        require(address(c.usdg()) == USDG, "CurbCredit: usdg");
        require(c.admin() == DEPLOYER, "CurbCredit: admin");
        require(c.pendingAdmin() == address(0), "CurbCredit: pendingAdmin");
        require(c.reserve() == 0, "CurbCredit: reserve");
        require(c.LTV_OPEN_BPS() == 6000 && c.LTV_SHUT_BPS() == 3000, "CurbCredit: ltv caps");
        require(c.APR_BPS() == 500 && c.STALE_BONUS_BPS() == 500, "CurbCredit: rates");
        require(c.CURE_OPEN_SECONDS() == 1800 && c.MAX_TICK_GAP() == 600, "CurbCredit: cure clock");
        require(c.GAS_FLOOR() == 50_000, "CurbCredit: GAS_FLOOR");
        require(c.MIN_CERT_LIFE() == 1 hours && c.SHUT_CERT_LIFE() == 73 hours, "CurbCredit: cert horizons");
        address[] memory got = c.assets();
        require(got.length == five.length, "CurbCredit: asset count");
        for (uint256 i; i < five.length; ++i) {
            require(got[i] == five[i] && c.isAsset(five[i]), "CurbCredit: asset list");
            require(c.totalCollateral(five[i]) == 0 && c.totalPrincipal(five[i]) == 0, "CurbCredit: fresh");
            require(c.ltvFor(five[i]) == 0 && c.ltvEffective(five[i]) == 0, "CurbCredit: no depth yet, so ltv 0");
            require(c.realisable(five[i]) == 0, "CurbCredit: nothing realisable yet");
            require(c.minCertExpiry(five[i]) >= block.timestamp + 90 minutes, "CurbCredit: cert horizon");
        }
        require(!c.isAsset(0xff637d2d435D6745Df3faf61272B1216e7e8b727), "CurbCredit: wSHEINx must not be listed");
    }
}
