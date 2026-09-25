#!/usr/bin/env bash
# The buyer's side after a reopen, hardened (replaces redeem-after-reopen.sh for Fri 25 Sep):
#   1. wait until note NOTE_ID is redeemable, OR MarketClock has shown capacity back for a minute (redeem calls
#      pointer.observe itself, so it records the reopen even if no watcher did);
#   2. redeem from the team's OKX Agentic Wallet (A) with the Builder Code suffix, and count it done only when the
#      chain shows A's note balance at 0 (A's transactions are ERC-4337 bundles: the outer tx succeeds even when
#      the inner call reverts);
#   3. wait for the epoch's reopen print and read realisedDiscountBps(LOT_ID).
#
#   NOTE_ID=2 LOT_ID=2 AMOUNT=100000000000000000 bash script/w3/redeem2.sh
#
# A Confirming response from onchainos is logged loudly and NOT forced: a human decides.
set -uo pipefail

NOTE_ID="${NOTE_ID:?set NOTE_ID}"
LOT_ID="${LOT_ID:?set LOT_ID}"
AMOUNT="${AMOUNT:-100000000000000000}"
A=0x055ba8acd60a2287b2d01cb3bf237e4424357105
NOTE_ADDR=0x7B2AcB0Db3316f7B8cf1B287796a2273871F011B
AUCTION=0xAc74864d69DdB940ADfDB39E69751759a32bb80D
POINTER=0x85AB0FebdFa7201E65eA01bd3e4CC6F9c0Ac4471
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
W=0x41333Df9E7639188BBfca5522dC4844398Af9f9E
READ="${READ_RPC:-https://xlayer.drpc.org}"
ALT="https://rpc.xlayer.tech"
SUFFIX=6464377535306e636b74356537323966100080218021802180218021802180218021
DEADLINE="${DEADLINE:-$(( $(date -u +%s) + 6 * 3600 ))}"

log() { printf '%s redeem2: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
first() { awk '{print $1}'; }
rd() { cast call "$@" --rpc-url "$READ" 2>/dev/null || cast call "$@" --rpc-url "$ALT" 2>/dev/null; }
a_call() { # a_call <to> <calldata> -> "ok <tx>" | "confirming <msg>" | "fail <msg>"
  onchainos wallet contract-call --chain 196 --to "$1" --input-data "$2" --gas-limit 400000 2>/dev/null | python3 -c '
import sys,json
t=sys.stdin.read(); i=t.find("{"); j=t.rfind("}")
try:
  d=json.loads(t[i:j+1]); x=d.get("data") or {}
  tx=x.get("txHash") if isinstance(x,dict) else None
  if d.get("confirming"): print("confirming %s" % (d.get("message") or "")[:400].replace("\n"," "))
  elif d.get("ok") and tx: print("ok %s" % tx)
  else: print("fail %s" % (d.get("message") or d.get("error") or t)[:300].replace("\n"," "))
except Exception: print("fail unparsed: " + t[:300].replace("\n"," "))'
}
bal() { rd "$NOTE_ADDR" "balanceOf(address,uint256)(uint256)" "$A" "$NOTE_ID" | first; }

log "note $NOTE_ID, lot $LOT_ID: A holds $(bal) units; waiting for the reopen"
capseen=0
while :; do
  (( $(date -u +%s) > DEADLINE )) && { log "gave up: no reopen by the deadline"; exit 1; }
  [[ "$(rd "$NOTE_ADDR" 'redeemable(uint256)(bool)' "$NOTE_ID")" == "true" ]] && { log "redeemable (the pointer has witnessed the reopen)"; break; }
  cap=$(rd "$CLOCK" 'primaryCapNow(address)(uint128)' "$W" | first)
  if [[ -n "$cap" && "$cap" != "0" ]]; then
    (( capseen == 0 )) && capseen=$(date -u +%s)
    if (( $(date -u +%s) - capseen >= 60 )); then log "capacity back for 60 s but not yet witnessed: redeeming (redeem observes the reopen itself)"; break; fi
  else
    capseen=0
  fi
  sleep 20
done

data="$(cast calldata 'redeem(uint256,uint128,address)' "$NOTE_ID" "$AMOUNT" "$A")$SUFFIX"
done_ok=0
for attempt in 1 2 3 4 5; do
  b=$(bal)
  [[ "$b" == "0" ]] && { done_ok=1; break; }
  r=$(a_call "$NOTE_ADDR" "$data"); log "redeem attempt $attempt: $r"
  case "$r" in confirming*) log "!!! onchainos asks for confirmation; not forcing. A human must re-run with --force after reading: $r"; exit 2 ;; esac
  sleep 12
  b=$(bal); [[ "$b" == "0" ]] && { done_ok=1; break; }
  log "A still holds $b units of note $NOTE_ID (inner call reverted, or not mined yet); retrying in 20 s"
  sleep 20
done
(( done_ok )) || { log "redeem did not land after 5 attempts"; exit 1; }
log "redeemed: A note balance 0, A wTCENTx $(rd "$W" 'balanceOf(address)(uint256)' "$A" | first), pointer epoch $(rd "$POINTER" 'epochOf(address)(uint32)' "$W" | first)"

log "waiting for the reopen print, then realisedDiscountBps($LOT_ID)"
while :; do
  r=$(cast call "$AUCTION" 'realisedDiscountBps(uint256)(int256)' "$LOT_ID" --rpc-url "$READ" 2>&1)
  if [[ $? -eq 0 && "$r" != *rror* ]]; then log "realisedDiscountBps($LOT_ID) = $r"; break; fi
  (( $(date -u +%s) > DEADLINE )) && { log "gave up waiting for the print: ${r:0:200}"; exit 1; }
  sleep 20
done
