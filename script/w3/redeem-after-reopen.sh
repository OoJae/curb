#!/usr/bin/env bash
# Cycle 1, the buyer's side after the reopen: wait until note NOTE is redeemable (the pointer has witnessed
# the reopen), redeem it from the team's OKX Agentic Wallet (A) with the Builder Code suffix, then wait for
# the epoch's reopen print and read the lot's realised discount.
#
#   NOTE=1 LOT=1 AMOUNT=100000000000000000 bash script/w3/redeem-after-reopen.sh
#
# Reads go to xlayer.drpc.org so they never compete with poke.sh on rpc.xlayer.tech. The redeem goes through
# `onchainos wallet contract-call` (A's key is in OKX's TEE; nothing here holds a key).
set -uo pipefail

NOTE="${NOTE:-1}"
LOT="${LOT:-1}"
AMOUNT="${AMOUNT:-100000000000000000}"
A="${A:-0x055ba8acd60a2287b2d01cb3bf237e4424357105}"
NOTE_ADDR=0x7B2AcB0Db3316f7B8cf1B287796a2273871F011B
AUCTION=0xAc74864d69DdB940ADfDB39E69751759a32bb80D
POINTER=0x85AB0FebdFa7201E65eA01bd3e4CC6F9c0Ac4471
WRAPPER=0x41333Df9E7639188BBfca5522dC4844398Af9f9E
RPC="${RPC:-https://xlayer.drpc.org}"
SUFFIX=6464377535306e636b74356537323966100080218021802180218021802180218021
DEADLINE="${DEADLINE:-$(( $(date -u +%s) + 6 * 3600 ))}"

log() { printf '%s redeem: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
first() { awk '{print $1}'; }

log "waiting for note $NOTE to become redeemable (A holds $(cast call $NOTE_ADDR 'balanceOf(address,uint256)(uint256)' $A $NOTE --rpc-url $RPC | first))"
while [[ "$(cast call $NOTE_ADDR 'redeemable(uint256)(bool)' $NOTE --rpc-url $RPC 2>/dev/null)" != "true" ]]; do
  (( $(date -u +%s) > DEADLINE )) && { log "gave up: not redeemable by the deadline"; exit 1; }
  sleep 20
done
log "redeemable; pointer epoch $(cast call $POINTER 'epochOf(address)(uint32)' $WRAPPER --rpc-url $RPC | first)"

data="$(cast calldata 'redeem(uint256,uint128,address)' "$NOTE" "$AMOUNT" "$A")$SUFFIX"
for attempt in 1 2 3; do
  out="$(onchainos wallet contract-call --chain 196 --to "$NOTE_ADDR" --input-data "$data" --gas-limit 400000 2>&1)"
  line="$(printf '%s' "$out" | python3 -c '
import sys,json
t=sys.stdin.read()
try:
  j=json.loads(t); d=j.get("data",{})
  print("ok=%s tx=%s confirming=%s msg=%s" % (j.get("ok"), d.get("txHash") if isinstance(d,dict) else d, j.get("confirming"), (j.get("message") or "")[:300]))
except Exception: print("RAW " + t[:500].replace("\n"," "))')"
  log "attempt $attempt: $line"
  case "$line" in ok=True*tx=0x*) break ;; esac
  sleep 30
done

sleep 10
log "after: A note balance $(cast call $NOTE_ADDR 'balanceOf(address,uint256)(uint256)' $A $NOTE --rpc-url $RPC | first), A wTCENTx $(cast call $WRAPPER 'balanceOf(address)(uint256)' $A --rpc-url $RPC | first)"

log "waiting for the reopen print, then realisedDiscountBps($LOT)"
while :; do
  r="$(cast call $AUCTION 'realisedDiscountBps(uint256)(int256)' "$LOT" --rpc-url $RPC 2>&1)"
  if [[ $? -eq 0 ]]; then log "realisedDiscountBps($LOT) = $r"; break; fi
  (( $(date -u +%s) > DEADLINE )) && { log "gave up waiting for the print: ${r:0:200}"; exit 1; }
  sleep 20
done
