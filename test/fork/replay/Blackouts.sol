// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IMarketClock} from "../../../src/interfaces/IMarketClock.sol";

/// @notice Pulls MarketClock's BlackoutOpened events out of a vm.getRecordedLogs() batch.
/// @dev Filters on the emitter as well as topic0, so an identically named event from any other
///      contract on the fork can never be counted as ours.
library Blackouts {
    struct Opened {
        address wrapper;
        uint32 fromNonce;
        uint32 toNonce;
        uint64 until;
    }

    function collect(Vm.Log[] memory logs, address clock) internal pure returns (Opened[] memory out) {
        bytes32 topic = IMarketClock.BlackoutOpened.selector;
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == clock && logs[i].topics[0] == topic) ++n;
        }
        out = new Opened[](n);
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != clock || logs[i].topics[0] != topic) continue;
            (uint32 fromNonce, uint32 toNonce, uint64 until) = abi.decode(logs[i].data, (uint32, uint32, uint64));
            out[k++] = Opened(address(uint160(uint256(logs[i].topics[1]))), fromNonce, toNonce, until);
        }
    }
}
