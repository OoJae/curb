#!/usr/bin/env bash
# A second, independent witness for tonight's two reopens, in case poke.sh dies or loses its RPC.
# Sends from the deployer D (a different key from poke.sh's K, so the two can never collide on nonces).
# ReopenPointer.observe and recordPrint are permissionless and idempotent: whoever is first records the reopen
# and the print, and a late duplicate reverts at gas estimation without sending anything.
#
#   bash script/w3/observe-backup.sh          (windows: 01:30:15-01:50Z and 05:00:15-05:20Z, Fri 25 Sep)
#
# Every transaction carries the Builder Code suffix. The keystore password is passed to cast by path only.
set -uo pipefail

WINDOWS="${WINDOWS:-2026-09-25T01:30:15Z/2026-09-25T01:50:00Z 2026-09-25T05:00:15Z/2026-09-25T05:20:00Z}"
POINTER=0x85AB0FebdFa7201E65eA01bd3e4CC6F9c0Ac4471
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
W=0x41333Df9E7639188BBfca5522dC4844398Af9f9E
ACCOUNT="${ACCOUNT:-curb-deployer}"
PWFILE="${PWFILE:-$HOME/.foundry/curb-secrets/curb-deployer.password}"
READ="${READ_RPC:-https://xlayer.drpc.org}"
SEND="${SEND_RPC:-https://rpc.xlayer.tech}"
SUFFIX=6464377535306e636b74356537323966100080218021802180218021802180218021
MARGIN=10   # seconds after openedAt+300 before D tries the print (poke.sh tries at +303)

log() { printf '%s backup: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
first() { awk '{print $1}'; }
ts() { date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s; }
rd() { cast call "$@" --rpc-url "$READ" 2>/dev/null || cast call "$@" --rpc-url "$SEND" 2>/dev/null; }
send() { # send <sig> [args...]
  local data; data="$(cast calldata "$@")$SUFFIX"
  cast send "$POINTER" "$data" --account "$ACCOUNT" --password-file "$PWFILE" --rpc-url "$SEND" 2>&1 \
    | awk '$1 == "transactionHash" || $1 == "status" || /Error|revert/' | tr '\n' ' '
}
epoch_field() { # epoch_field <epoch> <index 0..4>: (shutSeenAt, openedAt, openedBlock, print, printedAt)
  rd "$POINTER" "epochInfo(address,uint32)((uint64,uint64,uint64,uint128,uint64))" "$W" "$1" \
    | tr -d '()' | awk -F', ' -v i="$2" '{print $(i+1)}' | first
}

for win in $WINDOWS; do
  start=$(ts "${win%/*}"); end=$(ts "${win#*/}")
  now=$(date -u +%s)
  (( now > end )) && continue
  (( now < start )) && { log "waiting $(( start - now )) s for ${win%/*}"; sleep $(( start - now )); }
  log "window ${win%/*} .. ${win#*/}"
  while (( $(date -u +%s) < end )); do
    cap=$(rd "$CLOCK" "primaryCapNow(address)(uint128)" "$W" | first)
    open=$(rd "$POINTER" "isOpen(address)(bool)" "$W")
    if [[ -n "$cap" && "$cap" != "0" && "$open" == "false" ]]; then
      log "cap $cap but the pointer has not witnessed the reopen: observe -> $(send 'observe(address)' "$W")"
    fi
    e=$(rd "$POINTER" "epochOf(address)(uint32)" "$W" | first)
    if [[ -n "$e" && "$e" != "0" && "$open" == "true" ]]; then
      at=$(epoch_field "$e" 1); pr=$(epoch_field "$e" 3)
      if [[ -n "$pr" && "$pr" != "0" ]]; then log "epoch $e printed ($pr): done for this window"; break; fi
      now=$(date -u +%s)
      if [[ -n "$at" && "$at" != "0" ]] && (( now >= at + 300 + MARGIN && now <= at + 1800 )); then
        log "epoch $e opened at $at, unprinted at +$(( now - at )) s: recordPrint -> $(send 'recordPrint(address,uint32)' "$W" "$e")"
      fi
    fi
    sleep 20
  done
done
log "done"
