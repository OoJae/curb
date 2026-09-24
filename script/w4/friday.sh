#!/usr/bin/env bash
# The W4 demo's open-market half, Fri 25 Sep, unattended (the NoDepth refusal was already shown while shut):
#   05:15Z  K posts a bonded bid naming CurbCredit: 0.028 wTCENTx at 52 USDG a share, bond 1 USDG, to Sat 17 Oct
#           -> ltvFor(wTCENTx) goes from 0 to the open cap in one transaction
#           A (Agentic Wallet) borrows 1.4 USDG against its 0.05 wTCENTx      -> Borrowed
#           /depth recorded again (clip S07-cert)
#   07:55Z  the issuer cut: MarketClock goes shut, the cap drops to 30%, and A's loan is over its limit with no
#           transaction at all
#   07:57Z  K calls flagBreach(A, wTCENTx): the cure clock starts, and stays frozen while Hong Kong is shut
#           /depth recorded again (clip S07-breach)
#
#   bash script/w4/friday.sh            (POST_AT / FLAG_AT override the times)
set -uo pipefail
cd "$(dirname "$0")/../.."

POST_AT="${POST_AT:-2026-09-25T05:15:00Z}"
FLAG_AT="${FLAG_AT:-2026-09-25T07:57:00Z}"
export CREDIT=0x23c778c88C3ABf0Ad750f703C5F04cB3129ee339 DEPTH_CERT=0x702b1a988765f85162F4829175EF4232197e9C6D
export ACCOUNT=curb-desk PWFILE="${PWFILE:-$HOME/.foundry/curb-secrets/curb-desk.password}" RPC_URL="${RPC_URL:-https://xlayer.drpc.org}"
W=0x41333Df9E7639188BBfca5522dC4844398Af9f9E
A=0x055ba8acd60a2287b2d01cb3bf237e4424357105
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
SUFFIX=6464377535306e636b74356537323966100080218021802180218021802180218021
R="$RPC_URL"

log() { printf '%s w4: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
first() { awk '{print $1}'; }
until_utc() { local t; t=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s); local n; n=$(date -u +%s); (( n < t )) && { log "waiting $(( t - n )) s for $1"; sleep $(( t - n )); }; return 0; }
credit() { bash script/w4/credit.sh "$@"; }
ltv() { printf 'ltvFor %s  ltvEffective %s  regime %s  cap %s' \
  "$(cast call $CREDIT 'ltvFor(address)(uint256)' $W --rpc-url $R | first)" \
  "$(cast call $CREDIT 'ltvEffective(address)(uint256)' $W --rpc-url $R | first)" \
  "$(cast call $CLOCK 'regime(address)(uint8)' $W --rpc-url $R | first)" \
  "$(cast call $CLOCK 'primaryCapNow(address)(uint128)' $W --rpc-url $R | first)"; }
a_call() {
  onchainos wallet contract-call --chain 196 --to "$1" --input-data "$2" --gas-limit 400000 2>&1 | python3 -c '
import sys,json
t=sys.stdin.read()
try:
  j=json.loads(t); d=j.get("data",{}); tx=d.get("txHash") if isinstance(d,dict) else None
  print(("ok %s" % tx) if j.get("ok") and tx else ("fail %s" % (j.get("message") or t)[:300].replace("\n"," ")))
except Exception: print("fail RAW " + t[:300].replace("\n"," "))'
}
events() { # events <tx>: Borrowed / Refusal lines from CurbCredit in that receipt
  cast receipt "$1" --json --rpc-url $R 2>/dev/null | python3 -c "
import sys,json,subprocess
r=json.load(sys.stdin); k=lambda s: subprocess.check_output(['cast','keccak',s]).decode().strip()
REF=k('Refusal(address,address,bytes4,uint256,uint256)'); BOR=k('Borrowed(address,address,uint256,uint256,uint256)')
print('status', int(r['status'],16), 'block', int(r['blockNumber'],16))
for l in r['logs']:
    if l['address'].lower()!='$CREDIT'.lower(): continue
    if l['topics'][0]==REF: print('Refusal', l['topics'][3][:10], int(l['data'][2:66],16), int(l['data'][66:130],16))
    elif l['topics'][0]==BOR: print('Borrowed', [int(l['data'][2+64*i:66+64*i],16) for i in range((len(l['data'])-2)//64)])
"; }

until_utc "$POST_AT"
log "before the cert: $(ltv)"
# The clock must say the market is open (MARKET, cap > 0) before the post, so the loan is taken at the open cap.
for i in $(seq 1 30); do [[ "$(cast call $CLOCK 'primaryCapNow(address)(uint128)' $W --rpc-url $R | first)" != "0" ]] && break; log "clock still shut; waiting"; sleep 30; done

credit post $W credit 0.028e18 52e6 demo 1e6 || { log "post failed"; exit 1; }
sleep 5
log "after the cert:  $(ltv)"

r=$(a_call $CREDIT "$(cast calldata 'borrow(address,uint256)' $W 1400000)$SUFFIX"); log "A borrow 1.4 USDG: $r"
[[ "$r" == ok* ]] && { sleep 6; events "${r#ok }" | while read -r line; do log "  $line"; done; }
credit status $A $W 2>&1 | sed 's/^/    /'
(cd video && node capture/run.mjs --site https://curb.markets --suffix -cert S07 2>&1 | tail -3)

until_utc "$FLAG_AT"
log "after the cut:   $(ltv)"
credit flagBreach $A $W || log "flagBreach refused (the position may still be within its limit)"
sleep 5
credit status $A $W 2>&1 | sed 's/^/    /'
(cd video && node capture/run.mjs --site https://curb.markets --suffix -breach S07 2>&1 | tail -3)
log "done"
