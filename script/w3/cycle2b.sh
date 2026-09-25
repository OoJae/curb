#!/usr/bin/env bash
# Cycle 2 (Fri 25 Sep lunch recess, HK shut 03:55Z -> 05:00Z), hardened after the pre-flight audit. Replaces
# cycle2.sh. K (curb-desk) mints a note and lists it; A (the team's OKX Agentic Wallet) bids; A redeems after the
# 05:00Z reopen (redeem2.sh). Every step is checked on chain before the next:
#   - the note and lot ids are FOUND (issuer/seller == K, amount, note id), never read blind from a counter, so an
#     outsider's dust note or lot in the same window can never receive A's bid;
#   - the listing is retried for 15 min: MarketClock's nextTransitionAt stays at 04:00:00Z until host A's next
#     heartbeat after the cut, and a list before that reverts NoCutoff;
#   - A's approve and bid count only when the chain shows them (A's outer 4337 tx succeeds even if the inner call
#     reverts); the bid's maxPrice is the clock's current price + 1%, never more than the start.
#
#   START_AT=2026-09-25T04:01:30Z bash script/w3/cycle2b.sh
#
# K sends through rpc.xlayer.tech (cycle.sh's default, the path every earlier K transaction used); reads go to drpc
# with a fallback. No key or password is read here: K's password file goes to cast by path; A's key is in OKX's TEE.
set -uo pipefail
cd "$(dirname "$0")/../.."

START_AT="${START_AT:-2026-09-25T04:01:30Z}"
AMOUNT="${AMOUNT:-100000000000000000}"   # 0.1 wTCENTx
BID_AFTER="${BID_AFTER:-240}"
DECAY="${DECAY:-1200}"
NOTE=0x7B2AcB0Db3316f7B8cf1B287796a2273871F011B
AUCTION=0xAc74864d69DdB940ADfDB39E69751759a32bb80D
export NOTE AUCTION ACCOUNT=curb-desk PWFILE="${PWFILE:-$HOME/.foundry/curb-secrets/curb-desk.password}"
unset RPC   # cycle.sh sends via its default, rpc.xlayer.tech
W=0x41333Df9E7639188BBfca5522dC4844398Af9f9E
USDG=0x4ae46a509F6b1D9056937BA4500cb143933D2dc8
K=0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E
A=0x055ba8acd60a2287b2d01cb3bf237e4424357105
SCORECARD=0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
READ="${READ_RPC:-https://xlayer.drpc.org}"
ALT="https://rpc.xlayer.tech"
SUFFIX=6464377535306e636b74356537323966100080218021802180218021802180218021
LOT_T='(address,address,uint256,uint128,uint128,uint128,uint128,uint64,uint64,uint32,uint32,uint8,address,uint128,uint64,uint64)'
UNIT_T='(address,address,uint128,uint128,uint32,uint32,uint64,uint64)'

log() { printf '%s cycle2b: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
first() { awk '{print $1}'; }
lc() { tr '[:upper:]' '[:lower:]'; }
rd() { cast call "$@" --rpc-url "$READ" 2>/dev/null || cast call "$@" --rpc-url "$ALT" 2>/dev/null; }
field() { tr -d '()' | awk -F', ' -v i="$1" '{print $(i+1)}' | first; }   # field <0-based index> of a tuple
isnum() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }
cycle() { bash script/w3/cycle.sh "$@"; }
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
confirming_stop() { case "$1" in confirming*) log "!!! onchainos asks for confirmation; not forcing: $1"; exit 2 ;; esac; }

start_s=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$START_AT" +%s)
now=$(date -u +%s)
(( now < start_s )) && { log "waiting $(( start_s - now )) s for $START_AT"; sleep $(( start_s - now )); }
log "clock regime $(rd $CLOCK 'regime(address)(uint8)' $W | first), cap $(rd $CLOCK 'primaryCapNow(address)(uint128)' $W | first), K wTCENTx $(rd $W 'balanceOf(address)(uint256)' $K | first)"

# 1. K approves exactly AMOUNT to the note, checked on chain.
for i in 1 2 3 4 5; do
  al=$(rd $W 'allowance(address,address)(uint256)' $K $NOTE | first)
  isnum "$al" && (( al >= AMOUNT )) && break
  cycle approve wtcentx note "$AMOUNT" || log "approve send failed; rechecking"
  sleep 8
done

# 2. K mints; the note is the first id after `before` with issuer K and wrapperShares AMOUNT.
before=$(rd $NOTE 'noteCount()(uint256)' | first)
isnum "$before" || { log "cannot read noteCount"; exit 1; }
note_id=""
find_note() {
  local n i u
  n=$(rd $NOTE 'noteCount()(uint256)' | first); isnum "$n" || return 1
  for (( i = before + 1; i <= n; i++ )); do
    u=$(rd $NOTE "unitOf(uint256)($UNIT_T)" "$i")
    if [[ "$(printf '%s' "$u" | field 1 | lc)" == "$(printf '%s' "$K" | lc)" && "$(printf '%s' "$u" | field 2)" == "$AMOUNT" ]]; then note_id=$i; return 0; fi
  done
  return 1
}
deadline=$(( $(date -u +%s) + 1200 ))
until [[ -n "$note_id" ]]; do
  (( $(date -u +%s) > deadline )) && { log "no note from K after 20 min"; exit 1; }
  cycle mint "$AMOUNT" || log "mint send failed or reverted (market not yet shut? CapExceeded?); checking the chain"
  for t in $(seq 1 20); do find_note && break; sleep 3; done
  [[ -z "$note_id" ]] && { log "no note from K yet; retrying in 15 s"; sleep 15; }
done
log "note $note_id minted to K: $(rd $NOTE 'balanceOf(address,uint256)(uint256)' $K $note_id | first) units"

# 3. Price from the pool itself, retried (priceNow reverts while the spot is far from its TWAP).
p=""
for i in $(seq 1 20); do p=$(rd $SCORECARD 'priceNow(address)(uint128)' $W | first); isnum "$p" && (( p > 0 )) && break; log "priceNow unreadable; retrying"; sleep 15; done
isnum "$p" || { log "priceNow never readable"; exit 1; }
start=$(python3 -c "p=$p; a=$AMOUNT; v=p*a//10**30; print(v//10000*10000)")
floor=$(python3 -c "print($start*97//100//10000*10000)")
log "priceNow $p -> start $start, floor $floor USDG units, decay ${DECAY}s"

# 4. K lists; the lot is the one with seller K and this note id. Retried through the cutoff refresh.
[[ "$(rd $NOTE 'isApprovedForAll(address,address)(bool)' $K $AUCTION)" == "true" ]] || cycle setApprovalForAll auction true
lots0=$(rd $AUCTION 'lotCount()(uint256)' | first)
isnum "$lots0" || { log "cannot read lotCount"; exit 1; }
lot_id=""
find_lot() {
  local n i l
  n=$(rd $AUCTION 'lotCount()(uint256)' | first); isnum "$n" || return 1
  for (( i = lots0 + 1; i <= n; i++ )); do
    l=$(rd $AUCTION "lotOf(uint256)($LOT_T)" "$i")
    if [[ "$(printf '%s' "$l" | field 0 | lc)" == "$(printf '%s' "$K" | lc)" && "$(printf '%s' "$l" | field 2)" == "$note_id" ]]; then lot_id=$i; return 0; fi
  done
  return 1
}
deadline=$(( $(date -u +%s) + 900 ))
until [[ -n "$lot_id" ]]; do
  (( $(date -u +%s) > deadline )) && { log "no lot after 15 min"; exit 1; }
  cycle list "$note_id" "$AMOUNT" "$start" "$floor" "$DECAY" || log "list refused (cutoff not yet refreshed after the cut?)"
  for t in 1 2 3 4; do find_lot && break; sleep 3; done
  [[ -z "$lot_id" ]] && sleep 11
done
L=$(rd $AUCTION "lotOf(uint256)($LOT_T)" "$lot_id")
log "lot $lot_id listed: seller $(printf '%s' "$L" | field 0), note $(printf '%s' "$L" | field 2), amount $(printf '%s' "$L" | field 3), status $(printf '%s' "$L" | field 11), ends $(printf '%s' "$L" | field 8)"
[[ "$(printf '%s' "$L" | field 11)" == "1" && "$(printf '%s' "$L" | field 3)" == "$AMOUNT" ]] || { log "lot $lot_id is not K's live lot of $AMOUNT; not bidding"; exit 1; }

# 5. A bids after BID_AFTER s.
sleep "$BID_AFTER"
for i in 1 2 3 4; do
  al=$(rd $USDG 'allowance(address,address)(uint256)' $A $AUCTION | first)
  isnum "$al" && (( al >= start )) && break
  r=$(a_call $USDG "$(cast calldata 'approve(address,uint256)' $AUCTION "$start")$SUFFIX"); log "A approve $start: $r"; confirming_stop "$r"
  sleep 12
done
sold=0
for i in 1 2 3 4; do
  cp=$(rd $AUCTION 'currentPrice(uint256)(uint256)' "$lot_id" | first)
  isnum "$cp" || { sleep 10; continue; }
  maxp=$(python3 -c "print(min($start, $cp*101//100))")
  r=$(a_call $AUCTION "$(cast calldata 'bid(uint256,uint256)' "$lot_id" "$maxp")$SUFFIX"); log "A bid (clock $cp, max $maxp) attempt $i: $r"; confirming_stop "$r"
  sleep 12
  L=$(rd $AUCTION "lotOf(uint256)($LOT_T)" "$lot_id")
  if [[ "$(printf '%s' "$L" | field 11)" == "2" && "$(printf '%s' "$L" | field 12 | lc)" == "$(printf '%s' "$A" | lc)" ]]; then sold=1; break; fi
  log "lot $lot_id not sold to A yet (status $(printf '%s' "$L" | field 11)); retrying in 15 s"; sleep 15
done
(( sold )) || { log "A's bid never landed"; exit 1; }
log "lot $lot_id SOLD to A at $(printf '%s' "$L" | field 13) USDG units (at $(printf '%s' "$L" | field 14))"

# 6. After the 05:00Z reopen.
log "handing over to redeem2.sh (note $note_id, lot $lot_id)"
NOTE_ID="$note_id" LOT_ID="$lot_id" AMOUNT="$AMOUNT" bash script/w3/redeem2.sh
