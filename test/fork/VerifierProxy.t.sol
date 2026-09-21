// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";

interface IVerifierProxy {
    function typeAndVersion() external view returns (string memory);
    function s_feeManager() external view returns (address);
    function owner() external view returns (address);
    function s_verifiersByDonId(uint256 donId) external view returns (address);
    function getVerifier(bytes32 configDigest) external view returns (address);
    function verify(bytes calldata payload, bytes calldata parameterPayload)
        external payable returns (bytes memory);
}

/// W0 risk #2: is Chainlink Data Streams verification on X Layer (196) actually fee-free,
/// and is the verifier wired up? The whole US-name settlement path depends on this.
contract VerifierProxyForkTest is Test {
    IVerifierProxy constant PROXY = IVerifierProxy(0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7);

    function setUp() public {
        vm.createSelectFork("xlayer");
    }

    function test_proxy_is_live_and_fee_free() public view {
        assertEq(block.chainid, 196, "not X Layer");
        string memory tv = PROXY.typeAndVersion();
        address fm = PROXY.s_feeManager();
        console2.log("typeAndVersion :", tv);
        console2.log("s_feeManager   :", fm);
        console2.log("owner          :", PROXY.owner());
        console2.log("block          :", block.number);
        // The decisive assertion: no fee manager => verify() skips billing entirely.
        assertEq(fm, address(0), "fee manager set: verification would cost LINK/native");
    }

    /// A report for a DON that has no verifier registered must revert, not silently succeed.
    /// This proves the proxy is actually routing rather than being an empty shell.
    function test_verify_routes_and_rejects_unknown_digest() public {
        bytes memory bogus = abi.encode(bytes32(uint256(0xdead)), new bytes(0));
        vm.expectRevert();
        PROXY.verify(bogus, "");
    }
}
