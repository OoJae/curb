#!/usr/bin/env bash
# Cycle 2, the Friday lunch recess (HK shut 03:55Z -> 05:00Z), unattended: K (curb-desk) mints a note and lists
# it on a descending clock that ends by MarketClock's next transition; A (the team's OKX Agentic Wallet) bids a
# few minutes later with an exact-amount approval. The reopen side (observe, recordPrint) is poke.sh's job, and
# A's redeem is redeem-after-reopen.sh's, which this script starts once the lot is sold.
#
#   START_AT=2026-09-25T04:00:30Z bash script/w3/cycle2.sh
#
# Roles are as in cycle 1 (K sells, A buys): listing needs setApprovalForAll on the auction, which the Agentic
# Wallet does not grant. Every transaction carries the Builder Code suffix. No key or password is read here:
# K's password file is passed to cast by path; A's key is in OKX's TEE.
set -uo pipefail
cd "$(dirname "$0")/../.."

START_AT="${START_AT:-2026-09-25T04:00:30Z}"
AMOUNT="${AMOUNT:-100000000000000000}"        # 0.1 wTCENTx
BID_AFTER="${BID_AFTER:-240}"                  # seconds after listing
DECAY="${DECAY:-1200}"                         # 20 min from start to floor
export NOTE=0x7B2AcB0Db3316f7B8cf1B287796a2273871F011B AUCTION=0xAc74864d69DdB940ADfDB39E69751759a32bb80D
export ACCOUNT=curb-desk PWFILE="${PWFILE:-$HOME/.foundry/curb-secrets/curb-desk.password}" RPC="${RPC:-https://xlayer.drpc.org}"
W=0x41333Df9E7639188BBfca5522dC4844398Af9f9E
USDG=0x4ae46a509F6b1D9056937BA4500cb143933D2dc8
K=0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E
A=0x055ba8acd60a2287b2d01cb3bf237e4424357105
SCORECARD=0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
SUFFIX=6464377535306e636b74356537323966100080218021802180218021802180218021

log() { printf '%s cycle2: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
first() { awk '{print $1}'; }
cycle() { bash script/w3/cycle.sh "$@"; }
a_call() { # a_call <to> <calldata-with-suffix> -> "ok tx" or "fail <msg>"
  onchainos wallet contract-call --chain 196 --to "$1" --input-data "$2" --gas-limit 400000 2>&1 | python3 -c '
import sys,json
t=sys.stdin.read()
try:
  j=json.loads(t); d=j.get("data",{}); tx=d.get("txHash") if isinstance(d,dict) else None
  print(("ok %s" % tx) if j.get("ok") and tx else ("fail %s" % (j.get("message") or t)[:300].replace("\n"," ")))
except Exception: print("fail RAW " + t[:300].replace("\n"," "))'
}

start_s=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$START_AT" +%s)
now=$(date -u +%s)
if (( now < start_s )); then log "waiting $(( start_s - now )) s for $START_AT"; sleep $(( start_s - now )); fi

# 1. K mints, retrying until the clock and the pointer both say shut (poke.sh witnesses the shut).
log "clock regime $(cast call $CLOCK 'regime(address)(uint8)' $W --rpc-url $RPC | first), cap $(cast call $CLOCK 'primaryCapNow(address)(uint128)' $W --rpc-url $RPC | first)"
if [[ "$(cast call $W 'allowance(address,address)(uint256)' $K $NOTE --rpc-url $RPC | first)" -lt "$AMOUNT" ]]; then
  cycle approve wtcentx note "$AMOUNT"
fi
before=$(cast call $NOTE 'noteCount()(uint256)' --rpc-url $RPC | first)
deadline=$(( $(date -u +%s) + 1200 ))
until cycle mint "$AMOUNT"; do
  (( $(date -u +%s) > deadline )) && { log "mint never went through; giving up"; exit 1; }
  log "mint refused (market not yet witnessed shut?); retrying in 20 s"; sleep 20
done
sleep 4
note_id=$(cast call $NOTE 'noteCount()(uint256)' --rpc-url $RPC | first)
(( note_id > before )) || { log "noteCount did not move ($before -> $note_id)"; exit 1; }
log "note $note_id minted: $(cast call $NOTE 'balanceOf(address,uint256)(uint256)' $K $note_id --rpc-url $RPC | first) units to K"

# 2. K lists at the pool's own price (Scorecard.priceNow), floor 3% under, ending by the clock's next transition.
if [[ "$(cast call $NOTE 'isApprovedForAll(address,address)(bool)' $K $AUCTION --rpc-url $RPC)" != "true" ]]; then
  cycle setApprovalForAll auction true
fi
p=$(cast call $SCORECARD 'priceNow(address)(uint128)' $W --rpc-url $RPC | first)
start=$(python3 -c "p=$p; a=$AMOUNT; v=p*a//10**30; print(v//10000*10000)")
floor=$(python3 -c "print($start*97//100//10000*10000)")
log "priceNow $p -> lot worth $start USDG units; start $start, floor $floor, decay ${DECAY}s"
cycle list "$note_id" "$AMOUNT" "$start" "$floor" "$DECAY" || { log "list failed"; exit 1; }
sleep 4
lot_id=$(cast call $AUCTION 'lotCount()(uint256)' --rpc-url $RPC | first)
log "lot $lot_id listed"
cycle status "$lot_id" | head -3

# 3. A bids after BID_AFTER seconds, approving exactly the start price (the most a bid can pay).
sleep "$BID_AFTER"
log "price now $(cast call $AUCTION 'currentPrice(uint256)(uint256)' $lot_id --rpc-url $RPC | first); A approves $start and bids"
r=$(a_call $USDG "$(cast calldata 'approve(address,uint256)' $AUCTION "$start")$SUFFIX"); log "A approve: $r"
sleep 5
for attempt in 1 2 3; do
  r=$(a_call $AUCTION "$(cast calldata 'bid(uint256,uint256)' "$lot_id" "$start")$SUFFIX"); log "A bid (attempt $attempt): $r"
  [[ "$r" == ok* ]] && break
  sleep 20
done
sleep 6
cycle status "$lot_id"

# 4. After the 05:00Z reopen: A redeems, then the realised discount once poke.sh has printed the reopen.
log "handing over to redeem-after-reopen.sh (note $note_id, lot $lot_id)"
NOTE="$note_id" LOT="$lot_id" AMOUNT="$AMOUNT" bash script/w3/redeem-after-reopen.sh
