#!/usr/bin/env bash
# The W4 demo's open-market half, Fri 25 Sep, hardened after the pre-flight audit (replaces friday.sh):
#   05:15Z  K posts a bonded bid naming CurbCredit (0.028 wTCENTx at 52 USDG a share, bond 1 USDG, to Sat 17 Oct);
#           retried until K's committed book shows it. ltvFor(wTCENTx) goes from 0 to the open cap.
#           A (Agentic Wallet) borrows 1.4 USDG; counted only when debtOf(A) > 0 on chain (4337 outer txs succeed
#           even when the inner call reverts); retried up to 3 times.
#           /depth recorded again (clip S07-cert)
#   07:55Z  the issuer cut: MarketClock goes shut and the cap drops to 30%; A's loan is over its limit with no tx
#   07:56Z-08:30Z  K calls flagBreach(A, wTCENTx) every 60 s until cureOf(A).active (priceNow can revert near the
#           close when spot is far from its TWAP); the cure clock then stays frozen while Hong Kong is shut.
#           /depth recorded again (clip S07-breach)
#
#   bash script/w4/friday2.sh            (POST_AT / FLAG_FROM / FLAG_UNTIL override the times)
set -uo pipefail
cd "$(dirname "$0")/../.."

POST_AT="${POST_AT:-2026-09-25T05:15:00Z}"
FLAG_FROM="${FLAG_FROM:-2026-09-25T07:56:00Z}"
FLAG_UNTIL="${FLAG_UNTIL:-2026-09-25T08:30:00Z}"
export CREDIT=0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339 DEPTH_CERT=0x702b1a988765f85162F4829175EF4232197e9C6D
export ACCOUNT=curb-desk PWFILE="${PWFILE:-$HOME/.foundry/curb-secrets/curb-desk.password}"
export RPC_URL="${RPC_URL:-https://rpc.xlayer.tech}"   # credit.sh sends (and simulates) through the path K always used
W=0x41333Df9E7639188BBfca5522dC4844398Af9f9E
A=0x055ba8acd60a2287b2d01cb3bf237e4424357105
K=0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
READ="${READ_RPC:-https://xlayer.drpc.org}"
ALT="https://rpc.xlayer.tech"
SUFFIX=6464377535306e636b74356537323966100080218021802180218021802180218021
CURE_T='(bool,bool,uint64,uint64,uint64,uint128)'

log() { printf '%s w4b: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
first() { awk '{print $1}'; }
isnum() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }
rd() { cast call "$@" --rpc-url "$READ" 2>/dev/null || cast call "$@" --rpc-url "$ALT" 2>/dev/null; }
ts() { date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s; }
until_utc() { local t n; t=$(ts "$1"); n=$(date -u +%s); (( n < t )) && { log "waiting $(( t - n )) s for $1"; sleep $(( t - n )); }; return 0; }
credit() { bash script/w4/credit.sh "$@"; }
ltv() { printf 'ltvFor %s  ltvEffective %s  regime %s  cap %s' \
  "$(rd $CREDIT 'ltvFor(address)(uint256)' $W | first)" "$(rd $CREDIT 'ltvEffective(address)(uint256)' $W | first)" \
  "$(rd $CLOCK 'regime(address)(uint8)' $W | first)" "$(rd $CLOCK 'primaryCapNow(address)(uint128)' $W | first)"; }
a_call() {
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
events() { # CurbCredit Borrowed / Refusal lines in a receipt (inner-call logs appear in the 4337 outer receipt)
  cast receipt "$1" --json --rpc-url "$READ" 2>/dev/null | python3 -c "
import sys,json,subprocess
r=json.load(sys.stdin); r=r.get('data',r); k=lambda s: subprocess.check_output(['cast','keccak',s]).decode().strip()
REF=k('Refusal(address,address,bytes4,uint256,uint256)'); BOR=k('Borrowed(address,address,uint256,uint256,uint256)')
print('outer status', int(r['status'],16), 'block', int(r['blockNumber'],16))
for l in r['logs']:
    if l['address'].lower()!='$CREDIT'.lower(): continue
    if l['topics'][0]==REF: print('Refusal', l['topics'][3][:10], int(l['data'][2:66],16), int(l['data'][66:130],16))
    elif l['topics'][0]==BOR: print('Borrowed', [int(l['data'][2+64*i:66+64*i],16) for i in range((len(l['data'])-2)//64)])
" 2>/dev/null; }
committed_k() { rd $DEPTH_CERT 'committed(address)(uint256)' $K | first; }

until_utc "$POST_AT"
log "before the cert: $(ltv)"
for i in $(seq 1 30); do c=$(rd $CLOCK 'primaryCapNow(address)(uint128)' $W | first); isnum "$c" && [[ "$c" != "0" ]] && break; log "clock not open yet (cap '${c:-?}'); waiting"; sleep 30; done

posted=0
for i in 1 2 3 4 5; do
  c0=$(committed_k); isnum "$c0" && (( c0 > 0 )) && { posted=1; break; }
  credit post $W credit 0.028e18 52e6 demo 1e6 || log "post attempt $i failed or its receipt was lost; checking the book"
  sleep 8
  c0=$(committed_k); isnum "$c0" && (( c0 > 0 )) && { posted=1; break; }
  sleep 30
done
(( posted )) || { log "K's cert never appeared (committed(K) = $(committed_k)); stopping before the borrow"; exit 1; }
log "after the cert (committed(K) $(committed_k)): $(ltv)"

borrowed=0
for i in 1 2 3; do
  d=$(rd $CREDIT 'debtOf(address,address)(uint256)' $A $W | first); isnum "$d" && (( d > 0 )) && { borrowed=1; break; }
  r=$(a_call $CREDIT "$(cast calldata 'borrow(address,uint256)' $W 1400000)$SUFFIX"); log "A borrow 1.4 USDG (attempt $i): $r"
  case "$r" in confirming*) log "!!! onchainos asks for confirmation; not forcing"; break ;; esac
  [[ "$r" == ok* ]] && { sleep 8; events "${r#ok }" | while read -r line; do log "  $line"; done; }
  d=$(rd $CREDIT 'debtOf(address,address)(uint256)' $A $W | first); isnum "$d" && (( d > 0 )) && { borrowed=1; break; }
  log "no debt on chain yet; retrying in 30 s"; sleep 30
done
log "borrowed=$borrowed debtOf(A) $(rd $CREDIT 'debtOf(address,address)(uint256)' $A $W | first)"
credit status $A $W 2>&1 | sed 's/^/    /'
(cd video && node capture/run.mjs --site https://curb.markets --suffix -cert S07 2>&1 | tail -3)

until_utc "$FLAG_FROM"
until_s=$(ts "$FLAG_UNTIL")
flagged=0
while (( $(date -u +%s) < until_s )); do
  cu=$(rd $CREDIT "cureOf(address,address)($CURE_T)" $A $W | tr -d '()' | awk -F', ' '{print $1}')
  [[ "$cu" == "true" ]] && { flagged=1; break; }
  log "after the cut: $(ltv); flagBreach"
  credit flagBreach $A $W || log "flagBreach refused or failed (market still open, price unreadable, or within limit); retrying in 60 s"
  sleep 60
done
log "cure active=$flagged: $(rd $CREDIT "cureOf(address,address)($CURE_T)" $A $W)"
credit status $A $W 2>&1 | sed 's/^/    /'
(cd video && node capture/run.mjs --site https://curb.markets --suffix -breach S07 2>&1 | tail -3)
log "done"
